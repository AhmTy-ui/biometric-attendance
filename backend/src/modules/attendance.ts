import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { renderExport, type Column } from '../lib/tabular.js';
import { pageParams, parse } from '../lib/validate.js';
import { assertLocation, scopeSql, type Principal } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { EVENT_SELECT, broadcastEvent } from '../services/ingestion.js';
import { kickDelivery } from '../integration/delivery.js';
import { runScheduledExport } from '../integration/scheduledExport.js';

const filterSchema = z.object({
  locationId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  direction: z.enum(['in', 'out']).optional(),
  status: z.enum(['pending', 'delivering', 'delivered', 'retrying', 'dead_letter', 'exported', 'not_queued']).optional(),
  channel: z.enum(['mqtt', 'https_batch']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().max(100).optional(),
  minScore: z.coerce.number().int().optional(),
  maxScore: z.coerce.number().int().optional(),
  sort: z.enum(['captured_desc', 'captured_asc']).optional()
});

export function buildEventWhere(p: Principal, f: z.infer<typeof filterSchema>, params: unknown[]) {
  params.push(p.organizationId);
  let where = ` WHERE e.organization_id = $${params.length}`;
  where += scopeSql(p, 'e.location_id', params);
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where += sql.replace('?', `$${params.length}`);
  };
  if (f.locationId) add(' AND e.location_id = ?', f.locationId);
  if (f.deviceId) add(' AND e.device_id = ?', f.deviceId);
  if (f.employeeId) add(' AND e.employee_id = ?', f.employeeId);
  if (f.direction) add(' AND e.direction = ?', f.direction);
  if (f.channel) add(' AND e.channel = ?', f.channel);
  if (f.status === 'not_queued') where += ' AND d.event_id IS NULL';
  else if (f.status) add(' AND d.status = ?', f.status);
  if (f.from) add(' AND e.captured_at >= ?', f.from);
  if (f.to) add(' AND e.captured_at < ?', f.to);
  if (f.date) {
    params.push(f.date);
    const i = params.length;
    where += ` AND e.captured_at >= ($${i}::date::timestamp AT TIME ZONE l.timezone) AND e.captured_at < (($${i}::date + 1)::timestamp AT TIME ZONE l.timezone)`;
  }
  if (f.minScore !== undefined) add(' AND e.match_score >= ?', f.minScore);
  if (f.maxScore !== undefined) add(' AND e.match_score <= ?', f.maxScore);
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`);
    const i = params.length;
    where += ` AND (lower(emp.full_name) LIKE $${i} OR lower(emp.staff_number) LIKE $${i} OR lower(e.event_uid) LIKE $${i} OR lower(dv.name) LIKE $${i})`;
  }
  return where;
}

export const EVENT_EXPORT_COLUMNS: Column[] = [
  { key: 'captured_at', header: 'Captured at (UTC)', width: 22 },
  { key: 'tz_offset_minutes', header: 'TZ offset (min)', width: 8 },
  { key: 'employee_name', header: 'Employee', width: 22 },
  { key: 'staff_number', header: 'Staff number', width: 12 },
  { key: 'location_name', header: 'Location', width: 16 },
  { key: 'device_name', header: 'Device', width: 16 },
  { key: 'direction', header: 'Direction', width: 7 },
  { key: 'match_score', header: 'Match score', width: 7 },
  { key: 'channel', header: 'Channel', width: 10 },
  { key: 'delivery_status', header: 'Web delivery', width: 11 },
  { key: 'event_uid', header: 'Event ID', width: 30 }
];

async function scopedEvent(req: FastifyRequest, id: string) {
  const p = req.principal!;
  const row = await one(`${EVENT_SELECT} WHERE e.id=$1 AND e.organization_id=$2`, [id, p.organizationId]);
  if (!row) throw notFound('Attendance event');
  assertLocation(p, row.location_id);
  return row;
}

export async function attendanceRoutes(app: FastifyInstance) {
  app.get('/api/attendance/events', { preHandler: requirePerm('attendance.view') }, async (req) => {
    const p = req.principal!;
    const f = parse(filterSchema, req.query);
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [];
    const where = buildEventWhere(p, f, params);
    const order = f.sort === 'captured_asc' ? 'e.captured_at ASC' : 'e.captured_at DESC';
    const total = Number((await one(`SELECT count(*) FROM attendance_events e JOIN employees emp ON emp.id=e.employee_id JOIN locations l ON l.id=e.location_id JOIN devices dv ON dv.id=e.device_id LEFT JOIN attendance_deliveries d ON d.event_id=e.id ${where}`, params))!.count);
    params.push(limit, offset);
    const rows = await many(`${EVENT_SELECT} ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total, limit, offset, rows };
  });

  app.get('/api/attendance/events/export', { preHandler: requirePerm('attendance.export') }, async (req, reply) => {
    const p = req.principal!;
    const f = parse(filterSchema, req.query);
    const format = parse(z.enum(['csv', 'xlsx', 'pdf']), (req.query as any).format ?? 'csv');
    const params: unknown[] = [];
    const where = buildEventWhere(p, f, params);
    const rows = await many(`${EVENT_SELECT} ${where} ORDER BY e.captured_at ASC LIMIT 200000`, params);
    const out = await renderExport(format, 'Attendance events', `Filters: ${JSON.stringify(f)}`, EVENT_EXPORT_COLUMNS, rows);
    await tx((db) => audit(db, actorFromRequest(req), { action: 'attendance.exported', objectType: 'attendance', after: { format, rows: rows.length, filters: f } }));
    reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="attendance-${Date.now()}.${out.ext}"`);
    return out.body;
  });

  app.get('/api/attendance/events/:id', { preHandler: requirePerm('attendance.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const ev = await scopedEvent(req, id);
    const attempts = await many('SELECT attempt_no, attempted_at, http_status, outcome, error, duration_ms FROM delivery_attempts WHERE event_id=$1 ORDER BY attempt_no', [id]);
    const daily = await one(
      `SELECT * FROM attendance_daily WHERE employee_id=$1 AND location_id=$2 AND work_date = (($3::timestamptz) AT TIME ZONE $4)::date`,
      [ev.employee_id, ev.location_id, ev.captured_at, ev.location_timezone]
    );
    return { event: ev, attempts, daily };
  });

  // ── Reconciliation & dead-letter queue ──
  app.get('/api/attendance/delivery/summary', { preHandler: requirePerm('attendance.view') }, async (req) => {
    const p = req.principal!;
    const q = parse(z.object({ locationId: z.string().uuid().optional() }), req.query);
    if (q.locationId) assertLocation(p, q.locationId);
    const params: unknown[] = [p.organizationId];
    let scope = scopeSql(p, 'e.location_id', params);
    if (q.locationId) {
      params.push(q.locationId);
      scope += ` AND e.location_id = $${params.length}`;
    }
    const counts = await many(
      `SELECT d.status, count(*)::int AS n FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
        WHERE d.organization_id=$1 ${scope} GROUP BY d.status`,
      params
    );
    const oldestPending = await one(
      `SELECT min(e.captured_at) AS t FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
        WHERE d.organization_id=$1 AND d.status IN ('pending','retrying','delivering') ${scope}`,
      params
    );
    const nextRetry = await one(
      `SELECT min(d.next_attempt_at) AS t FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
        WHERE d.organization_id=$1 AND d.status='retrying' ${scope}`,
      params
    );
    const topErrors = await many(
      `SELECT d.last_http_status, d.last_error, count(*)::int AS n FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
        WHERE d.organization_id=$1 AND d.status IN ('dead_letter','retrying') ${scope}
        GROUP BY d.last_http_status, d.last_error ORDER BY n DESC LIMIT 10`,
      params
    );
    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = c.n;
    return { byStatus, oldestPendingCapturedAt: oldestPending?.t ?? null, nextRetryAt: nextRetry?.t ?? null, topErrors };
  });

  app.post('/api/attendance/delivery/replay', { preHandler: requirePerm('attendance.redeliver') }, async (req) => {
    const p = req.principal!;
    const body = parse(z.object({ eventIds: z.array(z.string().uuid()).max(5000).optional(), allDeadLetter: z.boolean().optional() }), req.body);
    const params: unknown[] = [p.organizationId];
    let sql = `UPDATE attendance_deliveries d SET status='retrying', replayed_at=now(), attempts_at_replay=d.attempts, next_attempt_at=now(), updated_at=now()
                 FROM attendance_events e WHERE e.id=d.event_id AND d.organization_id=$1 AND d.status IN ('dead_letter','retrying')`;
    sql += scopeSql(p, 'e.location_id', params);
    if (body.eventIds?.length) {
      params.push(body.eventIds);
      sql += ` AND d.event_id = ANY($${params.length}::uuid[])`;
    } else if (!body.allDeadLetter) {
      return { replayed: 0 };
    }
    const n = await tx(async (db) => {
      const r = await db.query(`${sql} RETURNING d.event_id`, params);
      await audit(db, actorFromRequest(req), {
        action: 'attendance.delivery_replayed',
        objectType: 'attendance_delivery',
        after: { count: r.rowCount, eventIds: r.rows.slice(0, 100).map((x) => x.event_id) }
      });
      return r.rowCount ?? 0;
    });
    kickDelivery();
    return { replayed: n };
  });

  app.post('/api/attendance/events/:id/retry', { preHandler: requirePerm('attendance.redeliver') }, async (req) => {
    const { id } = req.params as { id: string };
    const ev = await scopedEvent(req, id);
    await tx(async (db) => {
      const r = await db.query(
        `INSERT INTO attendance_deliveries (event_id, organization_id, status) VALUES ($1,$2,'retrying')
         ON CONFLICT (event_id) DO UPDATE SET status='retrying', replayed_at=now(), attempts_at_replay=attendance_deliveries.attempts,
                next_attempt_at=now(), updated_at=now()
         WHERE attendance_deliveries.status NOT IN ('delivered','exported') RETURNING event_id`,
        [id, ev.organization_id]
      );
      await audit(db, actorFromRequest(req), {
        action: 'attendance.delivery_retry',
        objectType: 'attendance_event',
        objectId: id,
        objectLabel: ev.event_uid,
        before: { status: ev.delivery_status },
        after: { status: r.rowCount ? 'retrying' : ev.delivery_status }
      });
    });
    kickDelivery();
    void broadcastEvent(id, 'delivery/updated');
    return { ok: true };
  });

  app.post('/api/attendance/export-now', { preHandler: requirePerm('attendance.redeliver') }, async (req) => {
    const p = req.principal!;
    const r = await runScheduledExport(p.organizationId, p.userId);
    await tx((db) => audit(db, actorFromRequest(req), { action: 'integration.export_triggered', objectType: 'export_batch', after: r ?? { skipped: 'delivery mode is not scheduled_export' } }));
    return r ?? { skipped: true, reason: 'Delivery mode is not "scheduled_export".' };
  });

  // ── Today's summary for the dashboard / location pages ──
  app.get('/api/attendance/today', { preHandler: requirePerm('attendance.view') }, async (req) => {
    const p = req.principal!;
    const q = parse(z.object({ locationId: z.string().uuid().optional() }), req.query);
    if (q.locationId) assertLocation(p, q.locationId);
    return todaySummary(p, q.locationId);
  });
}

export async function todaySummary(p: Principal, locationId?: string) {
  const params: unknown[] = [p.organizationId];
  let locFilter = scopeSql(p, 'l.id', params);
  if (locationId) {
    params.push(locationId);
    locFilter += ` AND l.id = $${params.length}`;
  }
  const row = await one(
    `WITH locs AS (
        SELECT l.id, l.timezone, (now() AT TIME ZONE l.timezone)::date AS today,
               EXTRACT(isodow FROM (now() AT TIME ZONE l.timezone))::int = ANY(l.workdays) AS workday
          FROM locations l WHERE l.organization_id=$1 AND l.is_active ${locFilter}),
      emp AS (
        SELECT e.id, e.location_id FROM employees e JOIN locs ON locs.id=e.location_id WHERE e.employment_status='active'),
      daily AS (
        SELECT ad.* FROM attendance_daily ad JOIN locs ON locs.id=ad.location_id AND ad.work_date=locs.today),
      last_dir AS (
        SELECT DISTINCT ON (ev.employee_id) ev.employee_id, ev.direction FROM attendance_events ev JOIN locs ON locs.id=ev.location_id
         WHERE ev.captured_at >= (locs.today::timestamp AT TIME ZONE locs.timezone) ORDER BY ev.employee_id, ev.captured_at DESC),
      evs AS (
        SELECT count(*)::int AS n FROM attendance_events ev JOIN locs ON locs.id=ev.location_id
         WHERE ev.captured_at >= (locs.today::timestamp AT TIME ZONE locs.timezone))
     SELECT (SELECT count(*)::int FROM emp) AS active_employees,
            (SELECT count(DISTINCT employee_id)::int FROM daily WHERE first_in IS NOT NULL OR event_count>0) AS present,
            (SELECT count(*)::int FROM daily WHERE is_late) AS late,
            (SELECT count(*)::int FROM last_dir WHERE direction='in') AS clocked_in,
            (SELECT count(*)::int FROM last_dir WHERE direction='out') AS clocked_out,
            (SELECT n FROM evs) AS total_events,
            (SELECT count(*)::int FROM emp JOIN locs ON locs.id=emp.location_id
               WHERE locs.workday AND NOT EXISTS (SELECT 1 FROM daily WHERE daily.employee_id=emp.id)) AS absent`,
    params
  );
  return row;
}
