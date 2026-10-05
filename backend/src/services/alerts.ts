import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { type Actor, audit, systemActor } from './audit.js';
import { sendMail } from './mailer.js';
import { publishDashboard } from './mqtt.js';
import { getSettings } from './settings.js';

export type AlertType =
  | 'device_offline'
  | 'unmapped_location'
  | 'sync_failed'
  | 'storage_capacity'
  | 'delivery_failure'
  | 'firmware_failure'
  | 'integration_failure'
  | 'device_tamper';

const CATEGORY: Record<AlertType, 'device' | 'sync' | 'integration'> = {
  device_offline: 'device',
  storage_capacity: 'device',
  firmware_failure: 'device',
  device_tamper: 'device',
  unmapped_location: 'sync',
  sync_failed: 'sync',
  delivery_failure: 'integration',
  integration_failure: 'integration'
};

export interface RaiseAlert {
  organizationId: string;
  type: AlertType;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  impact?: string;
  recommendedAction?: string;
  deviceId?: string | null;
  locationId?: string | null;
  dedupeKey?: string;
  context?: Record<string, unknown>;
}

/**
 * Raise an alert (rules engine output). Open alerts with the same dedupe key are coalesced:
 * the occurrence counter and context are updated instead of creating duplicates.
 */
export async function raiseAlert(a: RaiseAlert, db: Db = pool) {
  const r = await db.query(
    `INSERT INTO alerts (organization_id, type, category, severity, title, description, impact, recommended_action,
                         device_id, location_id, dedupe_key, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (organization_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL
     DO UPDATE SET occurrences = alerts.occurrences + 1, last_occurred_at = now(), context = EXCLUDED.context,
                   description = EXCLUDED.description, impact = EXCLUDED.impact, severity = EXCLUDED.severity
     RETURNING *, (xmax = 0) AS inserted`,
    [
      a.organizationId,
      a.type,
      CATEGORY[a.type],
      a.severity,
      a.title,
      a.description,
      a.impact ?? null,
      a.recommendedAction ?? null,
      a.deviceId ?? null,
      a.locationId ?? null,
      a.dedupeKey ?? null,
      JSON.stringify(a.context ?? {})
    ]
  );
  const alert = r.rows[0];
  if (alert.inserted) {
    await audit(db, systemActor(a.organizationId, 'Rules Engine'), {
      action: 'alert.raised',
      objectType: 'alert',
      objectId: alert.id,
      objectLabel: alert.title,
      after: { type: alert.type, severity: alert.severity, description: alert.description }
    });
    void notify(alert).catch((err) => logger.error({ err: err.message }, 'alert notification failed'));
  }
  void publishDashboard(a.organizationId, 'alert/raised', { ...stripInternal(alert), locationId: alert.location_id });
  return alert;
}

function stripInternal(a: any) {
  const { inserted, ...rest } = a;
  return rest;
}

/** Auto-resolve an open alert when the underlying condition clears (e.g. device reconnects). */
export async function resolveAlertByKey(orgId: string, dedupeKey: string, note: string, db: Db = pool) {
  const r = await db.query(
    `UPDATE alerts SET status='resolved', resolved_at=now(), resolution_note=$3
      WHERE organization_id=$1 AND dedupe_key=$2 AND status <> 'resolved' RETURNING *`,
    [orgId, dedupeKey, note]
  );
  for (const alert of r.rows) {
    await audit(db, systemActor(orgId, 'Rules Engine'), {
      action: 'alert.auto_resolved',
      objectType: 'alert',
      objectId: alert.id,
      objectLabel: alert.title,
      before: { status: 'open' },
      after: { status: 'resolved', note }
    });
    void publishDashboard(orgId, 'alert/updated', { ...alert, locationId: alert.location_id });
  }
  return r.rowCount ?? 0;
}

export async function setAlertStatus(
  db: Db,
  actor: Actor,
  orgId: string,
  alertId: string,
  status: 'acknowledged' | 'resolved',
  note?: string
) {
  const before = (await db.query('SELECT * FROM alerts WHERE id=$1 AND organization_id=$2', [alertId, orgId])).rows[0];
  if (!before) return null;
  const r = await db.query(
    status === 'acknowledged'
      ? `UPDATE alerts SET status='acknowledged', acknowledged_at=now(), acknowledged_by=$3 WHERE id=$1 AND organization_id=$2 RETURNING *`
      : `UPDATE alerts SET status='resolved', resolved_at=now(), resolved_by=$3, resolution_note=$4 WHERE id=$1 AND organization_id=$2 RETURNING *`,
    status === 'acknowledged' ? [alertId, orgId, actor.id] : [alertId, orgId, actor.id, note ?? null]
  );
  const after = r.rows[0];
  await audit(db, actor, {
    action: `alert.${status}`,
    objectType: 'alert',
    objectId: alertId,
    objectLabel: before.title,
    before: { status: before.status },
    after: { status: after.status, note: note ?? null }
  });
  void publishDashboard(orgId, 'alert/updated', { ...after, locationId: after.location_id });
  return after;
}

async function notify(alert: any) {
  const ns = await getSettings(alert.organization_id, 'notifications');
  if (!ns.notifyOnSeverities.includes(alert.severity)) return;
  const params: unknown[] = [alert.organization_id, ns.notifyRoles];
  let sql = `SELECT u.id, u.email FROM users u WHERE u.organization_id=$1 AND u.status='active' AND u.role = ANY($2::text[])`;
  if (alert.location_id) {
    params.push(alert.location_id);
    sql += ` AND (u.role='administrator' OR EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=$3))`;
  }
  const users = (await pool.query(sql, params)).rows;
  const title = `[${alert.severity.toUpperCase()}] ${alert.title}`;
  const body = [
    alert.description,
    alert.impact ? `Impact: ${alert.impact}` : '',
    alert.recommended_action ? `Recommended action: ${alert.recommended_action}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  for (const u of users) {
    await pool.query(
      `INSERT INTO notifications (organization_id, user_id, alert_id, channel, title, body, sent_at) VALUES ($1,$2,$3,'in_app',$4,$5,now())`,
      [alert.organization_id, u.id, alert.id, title, body]
    );
  }
  if (ns.emailEnabled) {
    const recipients = [...new Set([...users.map((u) => u.email as string), ...ns.alertEmailRecipients])];
    if (recipients.length) {
      const res = await sendMail(recipients, title, body);
      for (const u of users) {
        await pool.query(
          `INSERT INTO notifications (organization_id, user_id, alert_id, channel, title, body, sent_at, error)
           VALUES ($1,$2,$3,'email',$4,$5,$6,$7)`,
          [alert.organization_id, u.id, alert.id, title, body, res.sent ? new Date() : null, res.error ?? null]
        );
      }
    }
  }
}
