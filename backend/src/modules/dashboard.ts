import type { FastifyInstance } from 'fastify';
import { many, one } from '../db/pool.js';
import { scopeSql } from '../auth/rbac.js';
import { requirePerm } from '../auth/session.js';
import { EVENT_SELECT } from '../services/ingestion.js';
import { mqttConnected } from '../services/mqtt.js';
import { wsClientCount } from '../services/wsGateway.js';
import { todaySummary } from './attendance.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', { preHandler: requirePerm('dashboard.view') }, async (req) => {
    const p = req.principal!;
    const org = p.organizationId;

    const dp: unknown[] = [org];
    const dScope = scopeSql(p, 'd.location_id', dp);
    const lp: unknown[] = [org];
    const lScope = scopeSql(p, 'l.id', lp);
    const ep: unknown[] = [org];
    const eScope = scopeSql(p, 'e.location_id', ep);
    const ap: unknown[] = [org];
    const aScope =
      p.locationIds === null
        ? ''
        : (ap.push(p.locationIds), ` AND (a.location_id = ANY($2::uuid[]) OR a.device_id IN (SELECT id FROM devices WHERE location_id = ANY($2::uuid[])))`);

    const [today, devices, offlineDevices, alerts, alertCounts, locations, recent, hourly, delivery, latency, availability, sync, unmapped, lastEmployeeSync] =
      await Promise.all([
        todaySummary(p),
        one(
          `SELECT count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='online' AND health='healthy')::int AS online,
                  count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='offline')::int AS offline,
                  count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='online' AND health IN ('warning','critical'))::int AS warning,
                  count(*) FILTER (WHERE lifecycle_state IN ('pending','provisioned','connected'))::int AS pending,
                  count(*) FILTER (WHERE lifecycle_state <> 'decommissioned')::int AS total,
                  coalesce(sum(pending_events),0)::int AS buffered_events,
                  count(*) FILTER (WHERE storage_used_pct >= 80)::int AS storage_warning
             FROM devices d WHERE d.organization_id=$1 AND d.lifecycle_state <> 'decommissioned' ${dScope}`,
          dp
        ),
        many(
          `SELECT d.id, d.name, d.device_uid, d.connectivity, d.health, d.last_heartbeat_at, d.last_sync_at, d.pending_events, d.storage_used_pct, d.location_id, l.name AS location_name,
                  (SELECT count(*)::int FROM employees e WHERE e.location_id=d.location_id AND e.employment_status='active') AS employees_affected
             FROM devices d LEFT JOIN locations l ON l.id=d.location_id
            WHERE d.organization_id=$1 AND d.lifecycle_state IN ('connected','active') AND (d.connectivity='offline' OR d.pending_events > 0) ${dScope}
            ORDER BY d.connectivity, d.pending_events DESC LIMIT 12`,
          dp
        ),
        many(
          `SELECT a.id, a.type, a.category, a.severity, a.status, a.title, a.description, a.impact, a.recommended_action, a.created_at, a.last_occurred_at,
                  a.device_id, a.location_id, l.name AS location_name, d.name AS device_name
             FROM alerts a LEFT JOIN locations l ON l.id=a.location_id LEFT JOIN devices d ON d.id=a.device_id
            WHERE a.organization_id=$1 AND a.status <> 'resolved' ${aScope}
            ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.last_occurred_at DESC LIMIT 10`,
          ap
        ),
        one(
          `SELECT count(*) FILTER (WHERE severity='critical')::int AS critical, count(*) FILTER (WHERE severity='warning')::int AS warning,
                  count(*) FILTER (WHERE severity='info')::int AS info
             FROM alerts a WHERE a.organization_id=$1 AND a.status <> 'resolved' ${aScope}`,
          ap
        ),
        many(
          `SELECT l.id, l.name, l.code, l.timezone,
                  (SELECT count(*)::int FROM employees e WHERE e.location_id=l.id AND e.employment_status='active') AS employees,
                  (SELECT count(DISTINCT ad.employee_id)::int FROM attendance_daily ad WHERE ad.location_id=l.id AND ad.work_date=(now() AT TIME ZONE l.timezone)::date) AS present,
                  (SELECT count(*)::int FROM attendance_daily ad WHERE ad.location_id=l.id AND ad.work_date=(now() AT TIME ZONE l.timezone)::date AND ad.is_late) AS late,
                  (SELECT count(*)::int FROM devices d WHERE d.location_id=l.id AND d.lifecycle_state IN ('connected','active') AND d.connectivity='online') AS devices_online,
                  (SELECT count(*)::int FROM devices d WHERE d.location_id=l.id AND d.lifecycle_state IN ('connected','active') AND d.connectivity='offline') AS devices_offline,
                  (SELECT count(*)::int FROM alerts a WHERE a.location_id=l.id AND a.status <> 'resolved') AS open_alerts
             FROM locations l WHERE l.organization_id=$1 AND l.is_active ${lScope} ORDER BY l.name`,
          lp
        ),
        many(`${EVENT_SELECT} WHERE e.organization_id=$1 ${eScope} ORDER BY e.captured_at DESC LIMIT 15`, ep),
        many(
          `SELECT date_trunc('hour', e.captured_at) AS hour, count(*) FILTER (WHERE e.direction='in')::int AS ins, count(*) FILTER (WHERE e.direction='out')::int AS outs
             FROM attendance_events e WHERE e.organization_id=$1 AND e.captured_at > now() - interval '24 hours' ${eScope}
            GROUP BY 1 ORDER BY 1`,
          ep
        ),
        many(
          `SELECT d.status, count(*)::int AS n FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
            WHERE d.organization_id=$1 ${eScope} GROUP BY d.status`,
          ep
        ),
        one(
          `SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY capture_to_ingest_ms) AS p95_ingest_ms,
                  percentile_disc(0.95) WITHIN GROUP (ORDER BY capture_to_delivery_ms) FILTER (WHERE capture_to_delivery_ms IS NOT NULL) AS p95_delivery_ms,
                  count(*)::int AS samples
             FROM ingest_latency WHERE organization_id=$1 AND measured_at > now() - interval '1 hour'`,
          [org]
        ),
        one(
          `SELECT round(100.0 * count(*) FILTER (WHERE api_ok AND db_ok) / NULLIF(count(*),0), 3) AS availability_pct, count(*)::int AS samples
             FROM uptime_samples WHERE sampled_at > date_trunc('month', now())`
        ),
        many(
          `SELECT DISTINCT ON (kind) kind, status, started_at, finished_at, records_processed, error_message
             FROM sync_runs WHERE organization_id=$1 ORDER BY kind, started_at DESC`,
          [org]
        ),
        one(`SELECT count(*)::int AS n FROM location_mappings WHERE organization_id=$1 AND status='unmapped'`, [org]),
        one(`SELECT max(last_synced_at) AS t, count(*)::int AS n FROM employees WHERE organization_id=$1 AND employment_status='active'`, [org])
      ]);

    const deliveryByStatus: Record<string, number> = {};
    for (const d of delivery) deliveryByStatus[d.status] = d.n;
    return {
      today,
      devices,
      offlineDevices,
      alerts,
      alertCounts,
      locations,
      recent,
      hourly,
      delivery: deliveryByStatus,
      latency,
      availability,
      sync,
      unmappedLocations: unmapped?.n ?? 0,
      employeeSync: lastEmployeeSync,
      realtime: { mqttConnected: mqttConnected(), wsClients: wsClientCount() },
      serverTime: new Date().toISOString()
    };
  });
}
