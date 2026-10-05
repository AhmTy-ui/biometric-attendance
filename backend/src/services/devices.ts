import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { raiseAlert, resolveAlertByKey } from './alerts.js';
import { audit } from './audit.js';
import { attendanceEventSchema, ingestEvent, type DeviceRow } from './ingestion.js';
import { deviceTopic, onDeviceMessage, publish, publishDashboard } from './mqtt.js';
import { rosterVersion, templateVersion } from './roster.js';
import { getSettings } from './settings.js';

export const DEVICE_SELECT = `
  SELECT d.*, l.name AS location_name, l.code AS location_code, l.timezone AS location_timezone,
         (SELECT count(*)::int FROM employees e WHERE e.location_id=d.location_id AND e.employment_status='active') AS roster_size
    FROM devices d LEFT JOIN locations l ON l.id=d.location_id`;

export function deviceActor(d: { id: string; organization_id: string; device_uid: string; name: string }, ip?: string) {
  return {
    type: 'device' as const,
    id: d.id,
    name: `${d.name} (${d.device_uid})`,
    role: 'device',
    organizationId: d.organization_id,
    ip: ip ?? null,
    deviceInfo: d.device_uid
  };
}

async function deviceByUid(orgId: string, uid: string) {
  const r = await pool.query(`${DEVICE_SELECT} WHERE d.organization_id=$1 AND d.device_uid=$2`, [orgId, uid]);
  return r.rows[0] ?? null;
}

function computeHealth(d: any, pol: Awaited<ReturnType<typeof getSettings<'device_policies'>>>) {
  if (d.connectivity === 'offline') return 'critical';
  if (d.storage_used_pct !== null && Number(d.storage_used_pct) >= pol.storageCriticalPct) return 'critical';
  if (d.storage_used_pct !== null && Number(d.storage_used_pct) >= pol.storageWarningPct) return 'warning';
  // A backlog that is not draining (device online but events still queued for >10 minutes) needs attention.
  if (d.pending_events > 0 && d.last_sync_at && Date.now() - new Date(d.last_sync_at).getTime() > 10 * 60_000) return 'warning';
  return 'healthy';
}

export async function publishDeviceStatus(deviceId: string) {
  const r = await pool.query(`${DEVICE_SELECT} WHERE d.id=$1`, [deviceId]);
  const d = r.rows[0];
  if (!d) return;
  const { secret_enc, activation_code_hash, ...safe } = d;
  void publishDashboard(d.organization_id, 'device/status', { ...safe, locationId: d.location_id });
}

// ───────────────────────── Offline / online transitions ─────────────────────────
export async function markOffline(device: any, reason: string) {
  const upd = await pool.query(
    `UPDATE devices SET connectivity='offline', health='critical', updated_at=now() WHERE id=$1 AND connectivity='online' RETURNING *`,
    [device.id]
  );
  if (!upd.rowCount) return;
  await tx((db) =>
    audit(db, deviceActor(device), {
      action: 'device.went_offline',
      objectType: 'device',
      objectId: device.id,
      objectLabel: device.name,
      before: { connectivity: 'online' },
      after: { connectivity: 'offline', reason, lastHeartbeatAt: device.last_heartbeat_at }
    })
  );
  const lastSeen = device.last_heartbeat_at ? new Date(device.last_heartbeat_at) : null;
  await raiseAlert({
    organizationId: device.organization_id,
    type: 'device_offline',
    severity: 'critical',
    title: `Device offline — ${device.location_name ?? 'Unassigned'} · ${device.name}`,
    description: `${device.name} (${device.device_uid}) stopped reporting (${reason}). Last seen ${lastSeen ? lastSeen.toISOString() : 'never'}. The device keeps recording attendance offline.`,
    impact: `Buffered events: ${device.pending_events ?? 0}. Employees affected: ${device.roster_size ?? 0}. Attendance will be delayed until connectivity returns.`,
    recommendedAction: 'Check power and network at the branch. Events upload automatically when the connection is restored.',
    deviceId: device.id,
    locationId: device.location_id,
    dedupeKey: `device_offline:${device.id}`,
    context: {
      lastSeen: lastSeen?.toISOString() ?? null,
      bufferedEvents: device.pending_events ?? 0,
      employeesAffected: device.roster_size ?? 0,
      deviceName: device.name,
      locationName: device.location_name
    }
  });
  await publishDeviceStatus(device.id);
}

async function markOnline(device: any) {
  const upd = await pool.query(
    `UPDATE devices SET connectivity='online', lifecycle_state = CASE WHEN lifecycle_state='provisioned' THEN 'connected' ELSE lifecycle_state END,
            updated_at=now() WHERE id=$1 AND connectivity='offline' RETURNING *`,
    [device.id]
  );
  if (!upd.rowCount) return false;
  await tx((db) =>
    audit(db, deviceActor(device), {
      action: 'device.connection_restored',
      objectType: 'device',
      objectId: device.id,
      objectLabel: device.name,
      before: { connectivity: 'offline' },
      after: { connectivity: 'online', bufferedEvents: device.pending_events }
    })
  );
  await resolveAlertByKey(device.organization_id, `device_offline:${device.id}`, 'Connection restored');
  return true;
}

/** Periodic rules-engine check: devices that missed N heartbeats are offline. */
export async function checkHeartbeatTimeouts() {
  const devices = await pool.query(`${DEVICE_SELECT} WHERE d.connectivity='online' AND d.lifecycle_state IN ('connected','active')`);
  for (const d of devices.rows) {
    const pol = await getSettings(d.organization_id, 'device_policies');
    const limitMs = Math.max(config.HEARTBEAT_TIMEOUT_SECONDS * 1000, pol.heartbeatIntervalSeconds * pol.offlineAfterMissedHeartbeats * 1000);
    const last = d.last_heartbeat_at ? new Date(d.last_heartbeat_at).getTime() : 0;
    if (Date.now() - last > limitMs) await markOffline(d, `no heartbeat for ${Math.round((Date.now() - last) / 1000)}s`);
  }
}

// ───────────────────────── Heartbeat ─────────────────────────
const heartbeatSchema = z.object({
  firmwareVersion: z.string().optional(),
  rosterVersion: z.number().optional(),
  templateVersion: z.number().optional(),
  pendingEvents: z.number().int().min(0).optional(),
  storageUsedPct: z.number().min(0).max(100).optional(),
  storageCapacityEvents: z.number().int().optional(),
  uptimeSeconds: z.number().optional(),
  ip: z.string().optional(),
  reconciling: z.boolean().optional(),
  enrolledTemplates: z.number().int().optional(),
  storagePolicy: z.string().optional(),
  tamper: z.boolean().optional()
});

export async function handleHeartbeat(device: any, raw: unknown) {
  const hb = heartbeatSchema.parse(raw ?? {});
  const pol = await getSettings(device.organization_id, 'device_policies');
  const cameOnline = await markOnline(device);
  const upd = await pool.query(
    `UPDATE devices SET last_heartbeat_at=now(), firmware_version=COALESCE($2, firmware_version),
            roster_version=COALESCE($3, roster_version), template_version=COALESCE($4, template_version),
            pending_events=COALESCE($5, pending_events), storage_used_pct=COALESCE($6, storage_used_pct),
            storage_capacity_events=COALESCE($7, storage_capacity_events), last_seen_ip=COALESCE($8::inet, last_seen_ip), updated_at=now()
      WHERE id=$1 RETURNING *`,
    [
      device.id,
      hb.firmwareVersion ?? null,
      hb.rosterVersion ?? null,
      hb.templateVersion ?? null,
      hb.pendingEvents ?? null,
      hb.storageUsedPct ?? null,
      hb.storageCapacityEvents ?? null,
      hb.ip && /^[0-9a-fA-F.:]+$/.test(hb.ip) ? hb.ip : null
    ]
  );
  const d = { ...device, ...upd.rows[0], connectivity: 'online' };
  const health = computeHealth(d, pol);
  await pool.query('UPDATE devices SET health=$2 WHERE id=$1', [device.id, health]);
  await pool.query('INSERT INTO device_heartbeats (device_id, payload) VALUES ($1,$2)', [device.id, JSON.stringify(hb)]);

  // Storage approaching capacity (FR-4.3, user flow §15): alert loudly, device keeps capturing.
  if (hb.storageUsedPct !== undefined) {
    if (hb.storageUsedPct >= pol.storageWarningPct) {
      const critical = hb.storageUsedPct >= pol.storageCriticalPct;
      await raiseAlert({
        organizationId: device.organization_id,
        type: 'storage_capacity',
        severity: critical ? 'critical' : 'warning',
        title: `Storage approaching capacity — ${device.location_name ?? ''} · ${device.name}`,
        description: `Local event storage on ${device.name} is ${hb.storageUsedPct.toFixed(1)}% full with ${hb.pendingEvents ?? d.pending_events} event(s) awaiting upload.`,
        impact:
          pol.storageFullPolicy === 'continue_capturing_alert'
            ? 'The device continues capturing (default policy). If storage fills, the oldest delivered records are recycled first.'
            : 'Operator-confirmed policy preserves oldest events: new captures will be refused when storage is full.',
        recommendedAction: 'Restore connectivity so buffered events upload, or review the storage policy in Settings → Device policies.',
        deviceId: device.id,
        locationId: device.location_id,
        dedupeKey: `storage:${device.id}`,
        context: { storageUsedPct: hb.storageUsedPct, pendingEvents: hb.pendingEvents, policy: pol.storageFullPolicy }
      });
    } else {
      await resolveAlertByKey(device.organization_id, `storage:${device.id}`, 'Storage back below warning threshold');
    }
  }
  if (hb.tamper) {
    await raiseAlert({
      organizationId: device.organization_id,
      type: 'device_tamper',
      severity: 'critical',
      title: `Tamper switch triggered — ${device.name}`,
      description: `${device.name} (${device.device_uid}) reported its enclosure tamper switch as open.`,
      impact: 'The device may have been physically opened.',
      recommendedAction: 'Dispatch a supervisor to inspect the terminal.',
      deviceId: device.id,
      locationId: device.location_id,
      dedupeKey: `tamper:${device.id}`
    });
  }
  // Device behind on roster/templates → nudge it.
  if (device.location_id) {
    const [rv, tv] = await Promise.all([rosterVersion(device.location_id), templateVersion(device.location_id)]);
    if ((hb.rosterVersion ?? 0) < rv || (hb.templateVersion ?? 0) < tv || cameOnline) {
      await publish(deviceTopic(device.organization_id, device.device_uid, 'roster-changed'), { rosterVersion: rv, templateVersion: tv }).catch(
        () => undefined
      );
    }
  }
  // Mark sent commands that were queued while offline.
  if (cameOnline) await flushQueuedCommands(device);
  await publishDeviceStatus(device.id);
}

async function flushQueuedCommands(device: any) {
  const q = await pool.query(`SELECT * FROM device_commands WHERE device_id=$1 AND status='queued' ORDER BY issued_at`, [device.id]);
  for (const c of q.rows) {
    await publish(deviceTopic(device.organization_id, device.device_uid, 'commands'), { commandId: c.id, command: c.command, payload: c.payload });
    await pool.query(`UPDATE device_commands SET status='sent', sent_at=now() WHERE id=$1`, [c.id]);
  }
}

// ───────────────────────── MQTT registrations ─────────────────────────
export function registerDeviceMqttHandlers() {
  onDeviceMessage('presence', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d || d.lifecycle_state === 'decommissioned') return;
    const state = typeof payload === 'string' ? payload : payload?.state;
    if (state === 'offline') await markOffline(d, 'connection lost (MQTT last will)');
    else if (state === 'online') {
      await markOnline(d);
      await pool.query('UPDATE devices SET last_heartbeat_at=now() WHERE id=$1', [d.id]);
      await flushQueuedCommands(d);
      await publishDeviceStatus(d.id);
    }
  });

  onDeviceMessage('heartbeat', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d || d.lifecycle_state === 'decommissioned' || d.lifecycle_state === 'pending') return;
    await handleHeartbeat(d, payload);
  });

  // Single attendance event on capture (real-time channel).
  onDeviceMessage('attendance', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d || !['connected', 'active'].includes(d.lifecycle_state)) return;
    const parsed = attendanceEventSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ uid, issues: parsed.error.issues }, 'invalid attendance payload over MQTT');
      return;
    }
    const res = await ingestEvent(d as DeviceRow, parsed.data, 'mqtt');
    // Acknowledge so the device can mark the event as delivered in its local buffer.
    await publish(deviceTopic(orgId, uid, 'attendance/ack'), { eventUid: parsed.data.eventUid, status: res.status }).catch(() => undefined);
  });

  onDeviceMessage('enrolment', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d) return;
    await recordEnrolmentSession(d, payload);
  });

  onDeviceMessage('firmware', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d) return;
    await handleFirmwareReport(d, payload);
  });

  onDeviceMessage('commands/ack', async (orgId, uid, payload) => {
    const d = await deviceByUid(orgId, uid);
    if (!d || !payload?.commandId) return;
    const status = ['acknowledged', 'completed', 'failed'].includes(payload.status) ? payload.status : 'acknowledged';
    const r = await pool.query(
      `UPDATE device_commands SET status=$3, result=$4,
              acknowledged_at = COALESCE(acknowledged_at, now()),
              completed_at = CASE WHEN $3 IN ('completed','failed') THEN now() ELSE completed_at END
        WHERE id=$1 AND device_id=$2 RETURNING *`,
      [payload.commandId, d.id, status, JSON.stringify(payload.result ?? null)]
    );
    if (r.rows[0]) void publishDashboard(orgId, 'command/updated', { ...r.rows[0], locationId: d.location_id });
  });
}

// ───────────────────────── Enrolment session tracking ─────────────────────────
const enrolmentSchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum(['started', 'finger_captured', 'completed', 'failed_quality', 'employee_unavailable', 'unauthorised', 'aborted']),
  employeeId: z.string().uuid().nullable().optional(),
  supervisorUserId: z.string().uuid().nullable().optional(),
  authorisationMethod: z.enum(['fingerprint', 'pin']).nullable().optional(),
  fingersCaptured: z.number().int().min(0).max(10).optional(),
  detail: z.string().max(500).optional()
});

export async function recordEnrolmentSession(device: any, raw: unknown) {
  const p = enrolmentSchema.parse(raw);
  const final = ['completed', 'failed_quality', 'employee_unavailable', 'unauthorised', 'aborted'].includes(p.status);
  const r = await pool.query(
    `INSERT INTO enrolment_sessions (id, organization_id, device_id, employee_id, supervisor_user_id, authorisation_method, status, fingers_captured, detail, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10 THEN now() END)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, employee_id=COALESCE(EXCLUDED.employee_id, enrolment_sessions.employee_id),
        supervisor_user_id=COALESCE(EXCLUDED.supervisor_user_id, enrolment_sessions.supervisor_user_id),
        authorisation_method=COALESCE(EXCLUDED.authorisation_method, enrolment_sessions.authorisation_method),
        fingers_captured=GREATEST(EXCLUDED.fingers_captured, enrolment_sessions.fingers_captured),
        detail=COALESCE(EXCLUDED.detail, enrolment_sessions.detail), finished_at=COALESCE(EXCLUDED.finished_at, enrolment_sessions.finished_at)
     RETURNING *`,
    [
      p.sessionId,
      device.organization_id,
      device.id,
      p.employeeId ?? null,
      p.supervisorUserId ?? null,
      p.authorisationMethod ?? null,
      p.status,
      p.fingersCaptured ?? 0,
      p.detail ?? null,
      final
    ]
  );
  if (final) {
    await tx((db) =>
      audit(db, deviceActor(device), {
        action: `enrolment.${p.status}`,
        objectType: 'enrolment_session',
        objectId: p.sessionId,
        after: { employeeId: p.employeeId, supervisorUserId: p.supervisorUserId, fingers: p.fingersCaptured, detail: p.detail }
      })
    );
  }
  void publishDashboard(device.organization_id, 'enrolment/session', { ...r.rows[0], deviceName: device.name, locationId: device.location_id });
  return r.rows[0];
}

// ───────────────────────── Firmware OTA reports ─────────────────────────
const fwSchema = z.object({
  targetId: z.string().uuid(),
  state: z.enum(['downloading', 'installing', 'restarting', 'verified', 'failed', 'rolled_back']),
  version: z.string().optional(),
  error: z.string().max(1000).optional()
});

export async function handleFirmwareReport(device: any, raw: unknown) {
  const p = fwSchema.parse(raw);
  const t = (
    await pool.query(
      `UPDATE firmware_deployment_targets SET state=$3, error=$4, updated_at=now() WHERE id=$1 AND device_id=$2 RETURNING *`,
      [p.targetId, device.id, p.state, p.error ?? null]
    )
  ).rows[0];
  if (!t) return;
  const fw = (
    await pool.query(
      `SELECT fv.version, fd.id AS deployment_id, fd.name FROM firmware_deployments fd JOIN firmware_versions fv ON fv.id=fd.firmware_id WHERE fd.id=$1`,
      [t.deployment_id]
    )
  ).rows[0];
  if (p.state === 'verified') {
    await tx(async (db) => {
      await db.query(
        `UPDATE devices SET previous_firmware_version=firmware_version, firmware_version=$2, updated_at=now() WHERE id=$1 AND firmware_version IS DISTINCT FROM $2`,
        [device.id, p.version ?? fw.version]
      );
      await audit(db, deviceActor(device), {
        action: 'firmware.installed',
        objectType: 'device',
        objectId: device.id,
        objectLabel: device.name,
        before: { firmwareVersion: device.firmware_version },
        after: { firmwareVersion: p.version ?? fw.version, deploymentId: t.deployment_id }
      });
    });
    await resolveAlertByKey(device.organization_id, `firmware:${device.id}`, 'Firmware verified');
  }
  if (p.state === 'rolled_back') {
    await pool.query(`UPDATE devices SET firmware_version=COALESCE($2, previous_firmware_version), updated_at=now() WHERE id=$1`, [
      device.id,
      p.version ?? null
    ]);
  }
  if (p.state === 'failed') {
    await raiseAlert({
      organizationId: device.organization_id,
      type: 'firmware_failure',
      severity: 'warning',
      title: `Firmware installation failed — ${device.name}`,
      description: `Installing ${fw.version} on ${device.name} failed: ${p.error ?? 'unknown error'}. The device kept its previous firmware and continues operating.`,
      impact: 'Device remains protected on the previous firmware version.',
      recommendedAction: 'Open Firmware → deployment details and Retry or Rollback.',
      deviceId: device.id,
      locationId: device.location_id,
      dedupeKey: `firmware:${device.id}`,
      context: { deploymentId: t.deployment_id, version: fw.version, error: p.error }
    });
  }
  // Deployment completion.
  const agg = (
    await pool.query(
      `SELECT count(*) FILTER (WHERE state IN ('verified','failed','rolled_back'))::int AS done,
              count(*) FILTER (WHERE state IN ('failed','rolled_back'))::int AS failed, count(*)::int AS total
         FROM firmware_deployment_targets WHERE deployment_id=$1`,
      [t.deployment_id]
    )
  ).rows[0];
  if (agg.done === agg.total) {
    await pool.query(`UPDATE firmware_deployments SET status=$2, finished_at=now() WHERE id=$1 AND status='in_progress'`, [
      t.deployment_id,
      agg.failed ? 'completed_with_failures' : 'completed'
    ]);
  }
  void publishDashboard(device.organization_id, 'firmware/target', { ...t, deviceName: device.name, locationId: device.location_id, deployment: agg });
  await publishDeviceStatus(device.id);
}
