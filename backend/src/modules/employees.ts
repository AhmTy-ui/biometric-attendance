import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { pageParams, parse } from '../lib/validate.js';
import { assertLocation, scopeSql } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { EVENT_SELECT } from '../services/ingestion.js';
import { runEmployeeSync } from '../integration/sync.js';
import { getSettings } from '../services/settings.js';

/**
 * Employees are NOT created in this platform: the web software is the source of truth (FR-2.2, user flow §8–9).
 * These endpoints are read-only plus "Sync from Web Software".
 */
const listSchema = z.object({
  q: z.string().max(100).optional(),
  locationId: z.string().uuid().optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'inactive', 'suspended', 'terminated']).optional(),
  biometric: z.enum(['enrolled', 'partial', 'none']).optional(),
  department: z.string().max(100).optional(),
  today: z.enum(['in', 'out', 'absent']).optional()
});

const EMP_SELECT = `
  SELECT e.id, e.web_reference_id, e.staff_number, e.full_name, e.department, e.employment_status, e.location_id,
         e.external_location_ref, e.last_synced_at, e.source_modified_at, e.created_at,
         l.name AS location_name, l.code AS location_code, l.timezone AS location_timezone,
         coalesce(bt.fingers,0)::int AS fingers_enrolled, bt.last_enrolled_at,
         td.first_in AS today_first_in, td.last_out AS today_last_out, td.is_late AS today_late,
         ld.direction AS today_last_direction, ld.captured_at AS today_last_at
    FROM employees e
    LEFT JOIN locations l ON l.id = e.location_id
    LEFT JOIN LATERAL (SELECT count(*) AS fingers, max(enrolled_at) AS last_enrolled_at FROM biometric_templates t WHERE t.employee_id=e.id) bt ON true
    LEFT JOIN LATERAL (SELECT * FROM attendance_daily ad WHERE ad.employee_id=e.id AND ad.location_id=e.location_id
                        AND ad.work_date = (now() AT TIME ZONE coalesce(l.timezone,'UTC'))::date) td ON true
    LEFT JOIN LATERAL (SELECT ev.direction, ev.captured_at FROM attendance_events ev WHERE ev.employee_id=e.id
                        AND ev.captured_at >= ((now() AT TIME ZONE coalesce(l.timezone,'UTC'))::date::timestamp AT TIME ZONE coalesce(l.timezone,'UTC'))
                        ORDER BY ev.captured_at DESC LIMIT 1) ld ON true`;

async function scopedEmployee(req: FastifyRequest, id: string) {
  const p = req.principal!;
  const e = await one(`${EMP_SELECT} WHERE e.id=$1 AND e.organization_id=$2`, [id, p.organizationId]);
  if (!e) throw notFound('Employee');
  if (p.locationIds !== null) assertLocation(p, e.location_id);
  return e;
}

export async function employeeRoutes(app: FastifyInstance) {
  app.get('/api/employees', { preHandler: requirePerm('employees.view') }, async (req) => {
    const p = req.principal!;
    const f = parse(listSchema, req.query);
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [p.organizationId];
    let where = ' WHERE e.organization_id=$1';
    where += scopeSql(p, 'e.location_id', params);
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where += sql.replaceAll('?', `$${params.length}`);
    };
    if (f.locationId) add(' AND e.location_id = ?', f.locationId);
    if (f.unassigned === 'true') where += ' AND e.location_id IS NULL';
    if (f.status) add(' AND e.employment_status = ?', f.status);
    if (f.department) add(' AND e.department = ?', f.department);
    if (f.q) add(' AND (lower(e.full_name) LIKE ? OR lower(e.staff_number) LIKE ? OR lower(e.web_reference_id) LIKE ?)', `%${f.q.toLowerCase()}%`);
    const fingersRequired = (await getSettings(p.organizationId, 'device_policies')).fingersPerEmployee;
    if (f.biometric === 'none') where += ' AND coalesce(bt.fingers,0) = 0';
    if (f.biometric === 'partial') add(' AND coalesce(bt.fingers,0) > 0 AND coalesce(bt.fingers,0) < ?', fingersRequired);
    if (f.biometric === 'enrolled') add(' AND coalesce(bt.fingers,0) >= ?', fingersRequired);
    if (f.today === 'in') where += ` AND ld.direction = 'in'`;
    if (f.today === 'out') where += ` AND ld.direction = 'out'`;
    if (f.today === 'absent') where += ` AND td.employee_id IS NULL AND e.employment_status = 'active' AND e.location_id IS NOT NULL`;
    const total = Number((await one(`SELECT count(*) FROM (${EMP_SELECT} ${where}) x`, params))!.count);
    params.push(limit, offset);
    const rows = await many(`${EMP_SELECT} ${where} ORDER BY e.full_name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const sp: unknown[] = [p.organizationId];
    const sScope = scopeSql(p, 'location_id', sp);
    const stats = await one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE employment_status='active')::int AS active,
              count(*) FILTER (WHERE location_id IS NULL AND employment_status='active')::int AS unassigned,
              count(*) FILTER (WHERE employment_status='active' AND NOT EXISTS (SELECT 1 FROM biometric_templates t WHERE t.employee_id=employees.id))::int AS not_enrolled,
              max(last_synced_at) AS last_synced_at
         FROM employees WHERE organization_id=$1 ${sScope}`,
      sp
    );
    return { total, limit, offset, rows, stats, fingersRequired };
  });

  app.get('/api/employees/departments', { preHandler: requirePerm('employees.view') }, async (req) => {
    const rows = await many(
      `SELECT DISTINCT department FROM employees WHERE organization_id=$1 AND department IS NOT NULL ORDER BY department`,
      [req.principal!.organizationId]
    );
    return rows.map((r) => r.department);
  });

  app.get('/api/employees/:id', { preHandler: requirePerm('employees.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const e = await scopedEmployee(req, id);
    const templates = await many(
      `SELECT t.id, t.finger_index, t.quality_score, t.template_format, t.enrolled_at, t.authorisation_method,
              d.name AS device_name, d.device_uid, l.name AS location_name, u.full_name AS authorised_by
         FROM biometric_templates t LEFT JOIN devices d ON d.id=t.enrolled_device_id LEFT JOIN locations l ON l.id=t.enrolled_location_id
         LEFT JOIN users u ON u.id=t.authorised_by_user_id WHERE t.employee_id=$1 ORDER BY t.finger_index`,
      [id]
    );
    // Per-device roster / template propagation status.
    const devices = e.location_id
      ? await many(
          `SELECT d.id, d.name, d.device_uid, d.connectivity, d.health, d.roster_version, d.template_version, d.last_sync_at, d.last_heartbeat_at,
                  (SELECT max(rc.id) FROM roster_changes rc WHERE rc.employee_id=$1 AND rc.location_id=d.location_id) AS needed_roster_version,
                  (SELECT max(tc.id) FROM template_changes tc WHERE tc.employee_id=$1 AND tc.location_id=d.location_id) AS needed_template_version
             FROM devices d WHERE d.location_id=$2 AND d.lifecycle_state IN ('connected','active') ORDER BY d.name`,
          [id, e.location_id]
        )
      : [];
    const recent = await many(`${EVENT_SELECT} WHERE e.employee_id=$1 ORDER BY e.captured_at DESC LIMIT 25`, [id]);
    const enrolments = await many(
      `SELECT s.*, d.name AS device_name, u.full_name AS supervisor_name FROM enrolment_sessions s
         JOIN devices d ON d.id=s.device_id LEFT JOIN users u ON u.id=s.supervisor_user_id
        WHERE s.employee_id=$1 ORDER BY s.started_at DESC LIMIT 20`,
      [id]
    );
    const tz: string =
      e.location_timezone ?? (await one('SELECT timezone FROM organizations WHERE id=$1', [req.principal!.organizationId]))?.timezone ?? 'UTC';
    const stats30 = await one(
      `SELECT (SELECT count(*)::int FROM attendance_daily ad WHERE ad.employee_id=$1 AND ad.work_date >= (now() AT TIME ZONE $2)::date - 30) AS days_present,
              (SELECT count(*)::int FROM attendance_daily ad WHERE ad.employee_id=$1 AND ad.work_date >= (now() AT TIME ZONE $2)::date - 30 AND ad.is_late) AS late_days,
              (SELECT round(avg(worked_minutes)/60.0,1) FROM attendance_daily ad WHERE ad.employee_id=$1 AND ad.work_date >= (now() AT TIME ZONE $2)::date - 30) AS avg_hours,
              (SELECT round(avg(match_score),1) FROM attendance_events x WHERE x.employee_id=$1 AND x.captured_at >= now() - interval '30 days') AS avg_match`,
      [id, tz]
    );
    const audits = await many(
      `SELECT seq, occurred_at, actor_name, action FROM audit_log WHERE object_type='employee' AND object_id=$1 ORDER BY seq DESC LIMIT 20`,
      [id]
    );
    const fingersRequired = (await getSettings(req.principal!.organizationId, 'device_policies')).fingersPerEmployee;
    return { employee: e, templates, devices, recent, enrolments, stats30, audits, fingersRequired };
  });

  app.get('/api/employees/:id/attendance', { preHandler: requirePerm('attendance.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const emp = await scopedEmployee(req, id);
    const q = parse(
      z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      req.query
    );
    const tz: string =
      emp.location_timezone ?? (await one('SELECT timezone FROM organizations WHERE id=$1', [req.principal!.organizationId]))?.timezone ?? 'UTC';
    // Date range is interpreted in the employee's location timezone.
    const today = (await one(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz]))!.d as string;
    const to = q.to ?? today;
    const from = q.from ?? (await one(`SELECT ($1::date - 30)::text AS d`, [to]))!.d;
    const daily = await many(
      `SELECT ad.*, l.name AS location_name, l.timezone AS location_timezone FROM attendance_daily ad JOIN locations l ON l.id=ad.location_id
        WHERE ad.employee_id=$1 AND ad.work_date BETWEEN $2 AND $3 ORDER BY ad.work_date DESC`,
      [id, from, to]
    );
    const events = await many(
      `${EVENT_SELECT} WHERE e.employee_id=$1 AND e.captured_at >= ($2::date::timestamp AT TIME ZONE $4)
         AND e.captured_at < (($3::date + 1)::timestamp AT TIME ZONE $4) ORDER BY e.captured_at DESC LIMIT 2000`,
      [id, from, to, tz]
    );
    return { from, to, timezone: tz, daily, events };
  });

  app.post(
    '/api/employees/sync',
    { preHandler: requirePerm('employees.sync'), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req) => {
      const p = req.principal!;
      const run = await runEmployeeSync(p.organizationId, 'manual', actorFromRequest(req));
      if (!run) return { running: true, message: 'A synchronisation is already in progress.' };
      return { run };
    }
  );
}
