import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { buckets, getObject } from '../lib/s3.js';
import { pageParams, parse } from '../lib/validate.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { runEmployeeSync, runLocationSync } from '../integration/sync.js';
import { runScheduledExport } from '../integration/scheduledExport.js';
import { probe } from '../integration/webAdapter.js';

async function kindHealth(orgId: string, kind: string) {
  const runs = await many(
    `SELECT status, started_at, finished_at, error_message FROM sync_runs WHERE organization_id=$1 AND kind=$2 AND status <> 'running' ORDER BY started_at DESC LIMIT 10`,
    [orgId, kind]
  );
  let consecutiveFailures = 0;
  for (const r of runs) {
    if (r.status === 'failed') consecutiveFailures++;
    else break;
  }
  const lastSuccess = runs.find((r) => r.status === 'success' || r.status === 'partial');
  const running = await one(`SELECT started_at FROM sync_runs WHERE organization_id=$1 AND kind=$2 AND status='running' ORDER BY started_at DESC LIMIT 1`, [orgId, kind]);
  const health = runs.length === 0 ? 'never_run' : consecutiveFailures >= 2 ? 'failing' : consecutiveFailures === 1 ? 'degraded' : runs[0].status === 'partial' ? 'degraded' : 'healthy';
  return { kind, health, lastRun: runs[0] ?? null, lastSuccessAt: lastSuccess?.finished_at ?? null, consecutiveFailures, running: Boolean(running) };
}

export async function integrationRoutes(app: FastifyInstance) {
  app.get('/api/integration/status', { preHandler: requirePerm('integration.view') }, async (req) => {
    const org = req.principal!.organizationId;
    const s = await getSettings(org, 'integration');
    const [employees, locations, exportH, delivery, unmapped, lastDelivered, latency] = await Promise.all([
      kindHealth(org, 'employees'),
      kindHealth(org, 'locations'),
      kindHealth(org, 'attendance_export'),
      many(`SELECT status, count(*)::int AS n FROM attendance_deliveries WHERE organization_id=$1 GROUP BY status`, [org]),
      one(`SELECT count(*)::int AS n FROM location_mappings WHERE organization_id=$1 AND status='unmapped'`, [org]),
      one(`SELECT max(delivered_at) AS t FROM attendance_deliveries WHERE organization_id=$1 AND status='delivered'`, [org]),
      one(
        `SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY capture_to_delivery_ms) AS p95_delivery_ms, count(*)::int AS samples
           FROM ingest_latency WHERE organization_id=$1 AND capture_to_delivery_ms IS NOT NULL AND measured_at > now() - interval '24 hours'`,
        [org]
      )
    ]);
    const byStatus: Record<string, number> = {};
    for (const d of delivery) byStatus[d.status] = d.n;
    const pushHealth =
      s.deliveryMode === 'disabled'
        ? 'disabled'
        : (byStatus.dead_letter ?? 0) > 0
          ? 'failing'
          : (byStatus.retrying ?? 0) > 0
            ? 'degraded'
            : 'healthy';
    return {
      config: {
        baseUrl: s.baseUrl,
        configured: Boolean(s.baseUrl),
        deliveryMode: s.deliveryMode,
        incrementalSyncMinutes: s.incrementalSyncMinutes,
        fullSyncHourUtc: s.fullSyncHourUtc,
        exportEveryMinutes: s.exportCron.everyMinutes
      },
      employees,
      locations,
      attendancePush: { kind: 'attendance_push', health: s.deliveryMode === 'scheduled_export' ? exportH.health : pushHealth, byStatus, lastDeliveredAt: lastDelivered?.t ?? null, latency },
      attendanceExport: exportH,
      unmappedLocations: unmapped?.n ?? 0
    };
  });

  app.post('/api/integration/test-connection', { preHandler: requirePerm('integration.manage') }, async (req) => probe(req.principal!.organizationId));

  app.get('/api/integration/runs', { preHandler: requirePerm('integration.view') }, async (req) => {
    const org = req.principal!.organizationId;
    const f = parse(z.object({ kind: z.string().max(40).optional(), status: z.string().max(20).optional() }), req.query);
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [org];
    let where = 'WHERE r.organization_id=$1';
    if (f.kind) {
      params.push(f.kind);
      where += ` AND r.kind=$${params.length}`;
    }
    if (f.status) {
      params.push(f.status);
      where += ` AND r.status=$${params.length}`;
    }
    const total = Number((await one(`SELECT count(*) FROM sync_runs r ${where}`, params))!.count);
    params.push(limit, offset);
    const rows = await many(
      `SELECT r.*, u.full_name AS triggered_by_name, EXTRACT(epoch FROM (r.finished_at - r.started_at))*1000 AS duration_ms
         FROM sync_runs r LEFT JOIN users u ON u.id=r.triggered_by ${where} ORDER BY r.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { total, limit, offset, rows };
  });

  app.get('/api/integration/runs/:id', { preHandler: requirePerm('integration.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await one(
      `SELECT r.*, u.full_name AS triggered_by_name, EXTRACT(epoch FROM (r.finished_at - r.started_at))*1000 AS duration_ms
         FROM sync_runs r LEFT JOIN users u ON u.id=r.triggered_by WHERE r.id=$1 AND r.organization_id=$2`,
      [id, req.principal!.organizationId]
    );
    if (!run) throw notFound('Sync run');
    const errors = await many(`SELECT * FROM sync_errors WHERE sync_run_id=$1 ORDER BY id LIMIT 1000`, [id]);
    return { run, errors };
  });

  app.post('/api/integration/sync', { preHandler: requirePerm('integration.manage'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const p = req.principal!;
    const b = parse(
      z.object({ kind: z.enum(['employees', 'locations', 'attendance_export']), mode: z.enum(['manual', 'incremental', 'full', 'retry']).default('manual') }),
      req.body
    );
    const actor = actorFromRequest(req);
    await tx((db) => audit(db, actor, { action: 'integration.sync_triggered', objectType: 'sync_run', after: b }));
    const run =
      b.kind === 'employees'
        ? await runEmployeeSync(p.organizationId, b.mode, actor)
        : b.kind === 'locations'
          ? await runLocationSync(p.organizationId, b.mode, actor)
          : await runScheduledExport(p.organizationId, p.userId);
    if (!run) return { running: true, message: 'A synchronisation of this kind is already in progress, or the delivery mode does not use exports.' };
    return { run };
  });

  app.get('/api/integration/exports', { preHandler: requirePerm('integration.view') }, async (req) => {
    return many(`SELECT * FROM export_batches WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.principal!.organizationId]);
  });

  app.get('/api/integration/exports/:id/download', { preHandler: requirePerm('integration.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = await one(`SELECT * FROM export_batches WHERE id=$1 AND organization_id=$2`, [id, req.principal!.organizationId]);
    if (!b) throw notFound('Export');
    const body = await getObject(buckets.exports, b.object_key);
    const name = b.object_key.split('/').pop();
    reply
      .header('content-type', b.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`);
    return body;
  });
}
