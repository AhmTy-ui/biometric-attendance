import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { pageParams, parse } from '../lib/validate.js';
import { assertLocation, type Principal } from '../auth/rbac.js';
import { actorFromRequest, requireAuth, requirePerm } from '../auth/session.js';
import { setAlertStatus } from '../services/alerts.js';

function alertScope(p: Principal, params: unknown[]) {
  if (p.locationIds === null) return '';
  params.push(p.locationIds);
  // Scoped users see alerts for their locations, plus device alerts for devices at their locations.
  return ` AND (a.location_id = ANY($${params.length}::uuid[]) OR a.device_id IN (SELECT id FROM devices WHERE location_id = ANY($${params.length}::uuid[])))`;
}

export async function alertRoutes(app: FastifyInstance) {
  app.get('/api/alerts', { preHandler: requirePerm('alerts.view') }, async (req) => {
    const p = req.principal!;
    const f = parse(
      z.object({
        status: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
        severity: z.enum(['critical', 'warning', 'info']).optional(),
        category: z.enum(['device', 'sync', 'integration']).optional(),
        type: z.string().max(40).optional(),
        locationId: z.string().uuid().optional(),
        deviceId: z.string().uuid().optional(),
        q: z.string().max(100).optional()
      }),
      req.query
    );
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [p.organizationId];
    let where = 'WHERE a.organization_id=$1' + alertScope(p, params);
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where += sql.replaceAll('?', `$${params.length}`);
    };
    if (f.status === 'active') where += ` AND a.status <> 'resolved'`;
    else if (f.status) add(' AND a.status = ?', f.status);
    if (f.severity) add(' AND a.severity = ?', f.severity);
    if (f.category) add(' AND a.category = ?', f.category);
    if (f.type) add(' AND a.type = ?', f.type);
    if (f.locationId) add(' AND a.location_id = ?', f.locationId);
    if (f.deviceId) add(' AND a.device_id = ?', f.deviceId);
    if (f.q) add(' AND (lower(a.title) LIKE ? OR lower(a.description) LIKE ?)', `%${f.q.toLowerCase()}%`);
    const total = Number((await one(`SELECT count(*) FROM alerts a ${where}`, params))!.count);
    const cp: unknown[] = [p.organizationId];
    const cWhere = 'WHERE a.organization_id=$1' + alertScope(p, cp);
    const counts = await one(
      `SELECT count(*) FILTER (WHERE status<>'resolved' AND severity='critical')::int AS critical,
              count(*) FILTER (WHERE status<>'resolved' AND severity='warning')::int AS warning,
              count(*) FILTER (WHERE status<>'resolved' AND severity='info')::int AS info,
              count(*) FILTER (WHERE status<>'resolved' AND category='device')::int AS device,
              count(*) FILTER (WHERE status<>'resolved' AND category='sync')::int AS sync,
              count(*) FILTER (WHERE status<>'resolved' AND category='integration')::int AS integration,
              count(*) FILTER (WHERE status='open')::int AS open,
              count(*) FILTER (WHERE status='acknowledged')::int AS acknowledged,
              count(*) FILTER (WHERE status='resolved' AND resolved_at > now() - interval '24 hours')::int AS resolved_24h
         FROM alerts a ${cWhere}`,
      cp
    );
    params.push(limit, offset);
    const rows = await many(
      `SELECT a.*, d.name AS device_name, d.device_uid, l.name AS location_name, ua.full_name AS acknowledged_by_name, ur.full_name AS resolved_by_name
         FROM alerts a LEFT JOIN devices d ON d.id=a.device_id LEFT JOIN locations l ON l.id=a.location_id
         LEFT JOIN users ua ON ua.id=a.acknowledged_by LEFT JOIN users ur ON ur.id=a.resolved_by
         ${where} ORDER BY (a.status='resolved'), CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.last_occurred_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { total, limit, offset, rows, counts };
  });

  app.get('/api/alerts/:id', { preHandler: requirePerm('alerts.view') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const a = await one(
      `SELECT a.*, d.name AS device_name, d.device_uid, d.connectivity AS device_connectivity, d.last_heartbeat_at AS device_last_heartbeat,
              d.pending_events AS device_pending_events, l.name AS location_name,
              ua.full_name AS acknowledged_by_name, ur.full_name AS resolved_by_name
         FROM alerts a LEFT JOIN devices d ON d.id=a.device_id LEFT JOIN locations l ON l.id=a.location_id
         LEFT JOIN users ua ON ua.id=a.acknowledged_by LEFT JOIN users ur ON ur.id=a.resolved_by
        WHERE a.id=$1 AND a.organization_id=$2`,
      [id, p.organizationId]
    );
    if (!a) throw notFound('Alert');
    if (p.locationIds !== null) assertLocation(p, a.location_id ?? (a.device_id ? (await one('SELECT location_id FROM devices WHERE id=$1', [a.device_id]))?.location_id : null));
    const history = await many(
      `SELECT seq, occurred_at, actor_name, action, after_state FROM audit_log WHERE object_type='alert' AND object_id=$1 ORDER BY seq`,
      [id]
    );
    // Related sync run for sync alerts.
    const kinds =
      a.type === 'sync_failed' || a.type === 'unmapped_location'
        ? a.dedupe_key === 'sync:locations'
          ? ['locations']
          : a.dedupe_key === 'sync:attendance_export'
            ? ['attendance_export']
            : ['employees', 'locations']
        : a.type === 'integration_failure'
          ? ['employees', 'attendance_export']
          : [];
    const relatedSync = kinds.length
      ? await many(`SELECT * FROM sync_runs WHERE organization_id=$1 AND kind = ANY($2::text[]) ORDER BY started_at DESC LIMIT 5`, [p.organizationId, kinds])
      : [];
    return { alert: a, history, relatedSync };
  });

  app.post('/api/alerts/:id/acknowledge', { preHandler: requirePerm('alerts.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const r = await tx((db) => setAlertStatus(db, actorFromRequest(req), p.organizationId, id, 'acknowledged'));
    if (!r) throw notFound('Alert');
    return r;
  });

  app.post('/api/alerts/:id/resolve', { preHandler: requirePerm('alerts.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const b = parse(z.object({ note: z.string().max(1000).optional() }), req.body ?? {});
    const r = await tx((db) => setAlertStatus(db, actorFromRequest(req), p.organizationId, id, 'resolved', b.note));
    if (!r) throw notFound('Alert');
    return r;
  });

  // ───── In-app notifications ─────
  app.get('/api/notifications', { preHandler: requireAuth }, async (req) => {
    const p = req.principal!;
    const rows = await many(
      `SELECT n.id, n.title, n.body, n.read_at, n.created_at, n.alert_id, a.severity, a.status AS alert_status
         FROM notifications n LEFT JOIN alerts a ON a.id=n.alert_id
        WHERE n.user_id=$1 AND n.channel='in_app' ORDER BY n.created_at DESC LIMIT 50`,
      [p.userId]
    );
    const unread = Number((await one(`SELECT count(*) FROM notifications WHERE user_id=$1 AND channel='in_app' AND read_at IS NULL`, [p.userId]))!.count);
    return { rows, unread };
  });

  app.post('/api/notifications/read', { preHandler: requireAuth }, async (req) => {
    const p = req.principal!;
    const b = parse(z.object({ ids: z.array(z.string().uuid()).optional() }), req.body ?? {});
    if (b.ids?.length) await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::uuid[])`, [p.userId, b.ids]);
    else await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [p.userId]);
    return { ok: true };
  });
}
