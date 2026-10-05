import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, tx } from '../db/pool.js';
import { activationCode, hashToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { pageParams, parse } from '../lib/validate.js';
import { assertLocation, can, scopeSql } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { DEVICE_SELECT, publishDeviceStatus } from '../services/devices.js';
import { deviceTopic, disableDeviceMqttIdentity, mqttConnected, publish, publishDashboard } from '../services/mqtt.js';
import { nudgeLocations, rosterVersion, templateVersion } from '../services/roster.js';
import { getSettings } from '../services/settings.js';

const BASIC_COMMANDS = ['sync_roster', 'refresh_status'] as const;
const ALL_COMMANDS = ['sync_roster', 'restart', 'refresh_status', 'send_config', 'update_firmware', 'rollback_firmware'] as const;

function sanitize(d: any) {
  if (!d) return d;
  const { secret_enc, activation_code_hash, ...rest } = d;
  return rest;
}

async function scopedDevice(req: FastifyRequest, id: string) {
  const p = req.principal!;
  const d = await one(`${DEVICE_SELECT} WHERE d.id=$1 AND d.organization_id=$2`, [id, p.organizationId]);
  if (!d) throw notFound('Device');
  if (p.locationIds !== null) assertLocation(p, d.location_id);
  return d;
}

/** Issue a remote command over MQTT (queued if the device is offline). */
export async function issueCommand(req: FastifyRequest, device: any, command: (typeof ALL_COMMANDS)[number], payload: Record<string, unknown> = {}) {
  const p = req.principal!;
  const row = await tx(async (db) => {
    const c = (
      await db.query(
        `INSERT INTO device_commands (organization_id, device_id, command, payload, issued_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [p.organizationId, device.id, command, JSON.stringify(payload), p.userId]
      )
    ).rows[0];
    await audit(db, actorFromRequest(req), {
      action: `device.command.${command}`,
      objectType: 'device',
      objectId: device.id,
      objectLabel: device.name,
      after: { commandId: c.id, payload }
    });
    return c;
  });
  if (device.connectivity === 'online' && mqttConnected()) {
    await publish(deviceTopic(device.organization_id, device.device_uid, 'commands'), { commandId: row.id, command, payload });
    await one(`UPDATE device_commands SET status='sent', sent_at=now() WHERE id=$1 RETURNING id`, [row.id]);
    row.status = 'sent';
  }
  void publishDashboard(device.organization_id, 'command/updated', { ...row, locationId: device.location_id });
  return row;
}

export async function deviceRoutes(app: FastifyInstance) {
  app.get('/api/devices', { preHandler: requirePerm('devices.view') }, async (req) => {
    const p = req.principal!;
    const f = parse(
      z.object({
        status: z.enum(['online', 'offline', 'warning', 'pending']).optional(),
        locationId: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
        firmware: z.string().max(40).optional()
      }),
      req.query
    );
    const { limit, offset } = pageParams(req.query, 1000);
    const params: unknown[] = [p.organizationId];
    let where = ` WHERE d.organization_id=$1 AND d.lifecycle_state <> 'decommissioned'`;
    where += scopeSql(p, 'd.location_id', params);
    if (f.locationId) {
      params.push(f.locationId);
      where += ` AND d.location_id=$${params.length}`;
    }
    if (f.status === 'online') where += ` AND d.lifecycle_state='active' AND d.connectivity='online' AND d.health='healthy'`;
    if (f.status === 'offline') where += ` AND d.lifecycle_state='active' AND d.connectivity='offline'`;
    if (f.status === 'warning') where += ` AND d.lifecycle_state='active' AND d.connectivity='online' AND d.health IN ('warning','critical')`;
    if (f.status === 'pending') where += ` AND d.lifecycle_state IN ('pending','provisioned','connected')`;
    if (f.firmware) {
      params.push(f.firmware);
      where += ` AND d.firmware_version=$${params.length}`;
    }
    if (f.q) {
      params.push(`%${f.q.toLowerCase()}%`);
      where += ` AND (lower(d.name) LIKE $${params.length} OR lower(d.device_uid) LIKE $${params.length} OR lower(coalesce(d.serial_number,'')) LIKE $${params.length})`;
    }
    const total = Number((await one(`SELECT count(*) FROM devices d ${where}`, params))!.count);
    params.push(limit, offset);
    const rows = await many(
      `SELECT x.*, (SELECT coalesce(max(id),0) FROM roster_changes rc WHERE rc.location_id=x.location_id) AS latest_roster_version
         FROM (${DEVICE_SELECT} ${where} ORDER BY l.name NULLS LAST, d.name LIMIT $${params.length - 1} OFFSET $${params.length}) x`,
      params
    );
    const sp: unknown[] = [p.organizationId];
    const sScope = scopeSql(p, 'location_id', sp);
    const summary = await one(
      `SELECT count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='online' AND health='healthy')::int AS online,
              count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='offline')::int AS offline,
              count(*) FILTER (WHERE lifecycle_state='active' AND connectivity='online' AND health IN ('warning','critical'))::int AS warning,
              count(*) FILTER (WHERE lifecycle_state IN ('pending','provisioned','connected'))::int AS pending,
              count(*) FILTER (WHERE lifecycle_state <> 'decommissioned')::int AS total,
              coalesce(sum(pending_events),0)::int AS buffered_events
         FROM devices WHERE organization_id=$1 AND lifecycle_state <> 'decommissioned' ${sScope}`,
      sp
    );
    return { total, limit, offset, rows: rows.map(sanitize), summary };
  });

  app.get('/api/devices/:id', { preHandler: requirePerm('devices.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    const [commands, heartbeats, alerts, firmware, todayEvents] = await Promise.all([
      many(
        `SELECT c.*, u.full_name AS issued_by_name FROM device_commands c LEFT JOIN users u ON u.id=c.issued_by WHERE c.device_id=$1 ORDER BY c.issued_at DESC LIMIT 30`,
        [id]
      ),
      many(`SELECT received_at, payload FROM device_heartbeats WHERE device_id=$1 ORDER BY received_at DESC LIMIT 120`, [id]),
      many(`SELECT * FROM alerts WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
      many(
        `SELECT t.*, fv.version, fd.name AS deployment_name FROM firmware_deployment_targets t JOIN firmware_deployments fd ON fd.id=t.deployment_id
           JOIN firmware_versions fv ON fv.id=fd.firmware_id WHERE t.device_id=$1 ORDER BY t.updated_at DESC LIMIT 10`,
        [id]
      ),
      one(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE was_buffered)::int AS buffered, round(avg(match_score),1) AS avg_score
           FROM attendance_events e WHERE e.device_id=$1 AND e.captured_at >= now() - interval '24 hours'`,
        [id]
      )
    ]);
    const latestRoster = d.location_id ? await rosterVersion(d.location_id) : 0;
    const latestTemplates = d.location_id ? await templateVersion(d.location_id) : 0;
    const pol = await getSettings(d.organization_id, 'device_policies');
    return {
      device: sanitize(d),
      sync: { latestRosterVersion: latestRoster, latestTemplateVersion: latestTemplates, rosterUpToDate: d.roster_version >= latestRoster, templatesUpToDate: d.template_version >= latestTemplates },
      commands,
      heartbeats,
      alerts,
      firmware,
      last24h: todayEvents,
      policies: pol
    };
  });

  app.get('/api/devices/:id/roster', { preHandler: requirePerm('devices.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    if (!d.location_id) return { rows: [], deviceRosterVersion: d.roster_version, latestRosterVersion: 0 };
    const rows = await many(
      `SELECT e.id, e.full_name, e.staff_number, e.department, e.last_synced_at,
              (SELECT count(*)::int FROM biometric_templates t WHERE t.employee_id=e.id) AS fingers,
              (SELECT max(rc.id) FROM roster_changes rc WHERE rc.employee_id=e.id AND rc.location_id=e.location_id) AS required_version
         FROM employees e WHERE e.location_id=$1 AND e.employment_status='active' ORDER BY e.full_name`,
      [d.location_id]
    );
    return {
      rows: rows.map((r) => ({ ...r, on_device: (r.required_version ?? 0) <= d.roster_version })),
      deviceRosterVersion: d.roster_version,
      latestRosterVersion: await rosterVersion(d.location_id)
    };
  });

  app.get('/api/devices/:id/biometrics', { preHandler: requirePerm('enrolment.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    const templates = await many(
      `SELECT t.id, t.finger_index, t.quality_score, t.enrolled_at, t.authorisation_method, e.full_name, e.staff_number, u.full_name AS authorised_by
         FROM biometric_templates t JOIN employees e ON e.id=t.employee_id LEFT JOIN users u ON u.id=t.authorised_by_user_id
        WHERE t.enrolled_device_id=$1 ORDER BY t.enrolled_at DESC LIMIT 500`,
      [id]
    );
    const sessions = await many(
      `SELECT s.*, e.full_name AS employee_name, e.staff_number, u.full_name AS supervisor_name
         FROM enrolment_sessions s LEFT JOIN employees e ON e.id=s.employee_id LEFT JOIN users u ON u.id=s.supervisor_user_id
        WHERE s.device_id=$1 ORDER BY s.started_at DESC LIMIT 100`,
      [id]
    );
    const coverage = d.location_id
      ? await one(
          `SELECT count(*)::int AS roster, count(*) FILTER (WHERE f>=2)::int AS fully_enrolled, count(*) FILTER (WHERE f=1)::int AS partial, count(*) FILTER (WHERE f=0)::int AS none
             FROM (SELECT (SELECT count(*) FROM biometric_templates t WHERE t.employee_id=e.id) AS f FROM employees e WHERE e.location_id=$1 AND e.employment_status='active') x`,
          [d.location_id]
        )
      : null;
    return { templates, sessions, coverage };
  });

  app.get('/api/devices/:id/logs', { preHandler: requirePerm('devices.view') }, async (req) => {
    const { id } = req.params as { id: string };
    await scopedDevice(req, id);
    const q = req.query as any;
    const { limit, offset } = pageParams(q, 1000);
    const params: unknown[] = [id];
    let where = 'WHERE device_id=$1';
    if (q.level) {
      params.push(q.level);
      where += ` AND level=$${params.length}`;
    }
    if (q.q) {
      params.push(`%${String(q.q).toLowerCase()}%`);
      where += ` AND lower(message) LIKE $${params.length}`;
    }
    params.push(limit, offset);
    return many(`SELECT * FROM device_logs ${where} ORDER BY logged_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  });

  // ───── Provisioning lifecycle: Pending → Provisioned → Connected → Active ─────
  app.post('/api/devices', { preHandler: requirePerm('devices.provision') }, async (req) => {
    const p = req.principal!;
    const b = parse(
      z.object({
        deviceUid: z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, dash, underscore'),
        name: z.string().min(2).max(100),
        locationId: z.string().uuid(),
        model: z.string().max(64).optional(),
        serialNumber: z.string().max(64).optional()
      }),
      req.body
    );
    assertLocation(p, b.locationId);
    return tx(async (db) => {
      const loc = await db.query('SELECT id FROM locations WHERE id=$1 AND organization_id=$2', [b.locationId, p.organizationId]);
      if (!loc.rowCount) throw notFound('Location');
      const dup = await db.query('SELECT 1 FROM devices WHERE device_uid=$1', [b.deviceUid]);
      if (dup.rowCount) throw conflict(`Device ID ${b.deviceUid} is already registered`);
      const row = (
        await db.query(
          `INSERT INTO devices (organization_id, device_uid, name, location_id, model, serial_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [p.organizationId, b.deviceUid, b.name, b.locationId, b.model ?? null, b.serialNumber ?? null]
        )
      ).rows[0];
      await audit(db, actorFromRequest(req), { action: 'device.registered', objectType: 'device', objectId: row.id, objectLabel: row.name, after: sanitize(row) });
      return sanitize(row);
    });
  });

  app.post('/api/devices/:id/credentials', { preHandler: requirePerm('devices.provision') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    if (d.lifecycle_state === 'decommissioned') throw badRequest('Device is decommissioned');
    const code = activationCode();
    const expires = new Date(Date.now() + 72 * 3600_000);
    await tx(async (db) => {
      await db.query(
        `UPDATE devices SET activation_code_hash=$2, activation_expires_at=$3, lifecycle_state='provisioned', secret_enc=NULL, connectivity='offline', updated_at=now() WHERE id=$1`,
        [id, hashToken(code), expires]
      );
      await audit(db, actorFromRequest(req), {
        action: 'device.credentials_issued',
        objectType: 'device',
        objectId: id,
        objectLabel: d.name,
        before: { lifecycleState: d.lifecycle_state },
        after: { lifecycleState: 'provisioned', activationExpiresAt: expires.toISOString() }
      });
    });
    if (d.mqtt_username) await disableDeviceMqttIdentity(d.device_uid);
    await publishDeviceStatus(id);
    return {
      deviceUid: d.device_uid,
      activationCode: code,
      expiresAt: expires.toISOString(),
      apiBaseUrl: config.PUBLIC_URL,
      mqttHost: config.MQTT_PUBLIC_HOST,
      mqttPort: config.MQTT_PUBLIC_PORT
    };
  });

  app.post('/api/devices/:id/activate', { preHandler: requirePerm('devices.provision') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    if (d.lifecycle_state !== 'connected') throw badRequest('The device must connect with its activation code before it can be activated.');
    if (!d.last_heartbeat_at) throw badRequest('Waiting for the first heartbeat from the device (verification step).');
    await tx(async (db) => {
      await db.query(`UPDATE devices SET lifecycle_state='active', activated_at=now(), updated_at=now() WHERE id=$1`, [id]);
      await audit(db, actorFromRequest(req), {
        action: 'device.activated',
        objectType: 'device',
        objectId: id,
        objectLabel: d.name,
        before: { lifecycleState: 'connected' },
        after: { lifecycleState: 'active' }
      });
    });
    await issueCommand(req, { ...d, lifecycle_state: 'active' }, 'send_config', { reason: 'activated' });
    await nudgeLocations(d.organization_id, [d.location_id]);
    await publishDeviceStatus(id);
    return { ok: true };
  });

  app.patch('/api/devices/:id', { preHandler: requirePerm('devices.provision') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    const b = parse(
      z.object({ name: z.string().min(2).max(100).optional(), locationId: z.string().uuid().optional(), config: z.record(z.any()).optional() }),
      req.body
    );
    if (b.locationId) assertLocation(req.principal!, b.locationId);
    const row = await tx(async (db) => {
      const r = (
        await db.query(
          `UPDATE devices SET name=COALESCE($2,name), location_id=COALESCE($3,location_id), config=COALESCE($4,config),
                  roster_version = CASE WHEN $3::uuid IS NOT NULL AND $3::uuid IS DISTINCT FROM location_id THEN 0 ELSE roster_version END,
                  template_version = CASE WHEN $3::uuid IS NOT NULL AND $3::uuid IS DISTINCT FROM location_id THEN 0 ELSE template_version END,
                  updated_at=now() WHERE id=$1 RETURNING *`,
          [id, b.name ?? null, b.locationId ?? null, b.config ? JSON.stringify(b.config) : null]
        )
      ).rows[0];
      await audit(db, actorFromRequest(req), {
        action: 'device.updated',
        objectType: 'device',
        objectId: id,
        objectLabel: r.name,
        before: { name: d.name, locationId: d.location_id, config: d.config },
        after: { name: r.name, locationId: r.location_id, config: r.config }
      });
      return r;
    });
    if (b.locationId && b.locationId !== d.location_id && ['connected', 'active'].includes(d.lifecycle_state)) {
      await issueCommand(req, { ...d, location_id: b.locationId }, 'sync_roster', { full: true, reason: 'location_changed' });
    } else if (b.config && ['connected', 'active'].includes(d.lifecycle_state)) {
      await issueCommand(req, d, 'send_config', { config: b.config });
    }
    await publishDeviceStatus(id);
    return sanitize(row);
  });

  app.post('/api/devices/:id/decommission', { preHandler: requirePerm('devices.provision') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    const b = parse(z.object({ confirmUid: z.string() }), req.body);
    if (b.confirmUid !== d.device_uid) throw badRequest('Type the device ID to confirm decommissioning.');
    await disableDeviceMqttIdentity(d.device_uid);
    await tx(async (db) => {
      await db.query(
        `UPDATE devices SET lifecycle_state='decommissioned', connectivity='offline', secret_enc=NULL, activation_code_hash=NULL, updated_at=now() WHERE id=$1`,
        [id]
      );
      await audit(db, actorFromRequest(req), {
        action: 'device.decommissioned',
        objectType: 'device',
        objectId: id,
        objectLabel: d.name,
        before: { lifecycleState: d.lifecycle_state },
        after: { lifecycleState: 'decommissioned' }
      });
    });
    await publishDeviceStatus(id);
    return { ok: true };
  });

  app.post('/api/devices/:id/commands', { preHandler: requirePerm('devices.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await scopedDevice(req, id);
    const b = parse(z.object({ command: z.enum(ALL_COMMANDS), payload: z.record(z.any()).default({}) }), req.body);
    const p = req.principal!;
    const basic = (BASIC_COMMANDS as readonly string[]).includes(b.command);
    if (basic ? !can(p, 'devices.command.basic') : !can(p, 'devices.command.advanced')) throw forbidden();
    if (!['connected', 'active'].includes(d.lifecycle_state)) throw badRequest('Commands can only be sent to connected or active devices.');
    let payload = b.payload;
    if (b.command === 'send_config') payload = { config: d.config, policies: await getSettings(d.organization_id, 'device_policies'), ...b.payload };
    if (b.command === 'update_firmware') throw badRequest('Use Firmware → Deploy to update firmware so progress is tracked.');
    if (b.command === 'rollback_firmware') throw badRequest('Use the firmware deployment page to roll back so progress is tracked.');
    return issueCommand(req, d, b.command, payload);
  });

  app.get('/api/enrolment-sessions', { preHandler: requirePerm('enrolment.view') }, async (req) => {
    const p = req.principal!;
    const q = parse(
      z.object({ locationId: z.string().uuid().optional(), deviceId: z.string().uuid().optional(), status: z.string().max(40).optional() }),
      req.query
    );
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [p.organizationId];
    let where = 'WHERE s.organization_id=$1' + scopeSql(p, 'd.location_id', params);
    if (q.locationId) {
      params.push(q.locationId);
      where += ` AND d.location_id=$${params.length}`;
    }
    if (q.deviceId) {
      params.push(q.deviceId);
      where += ` AND s.device_id=$${params.length}`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND s.status=$${params.length}`;
    }
    const stats = await one(
      `SELECT count(*) FILTER (WHERE s.status='completed')::int AS completed, count(*) FILTER (WHERE s.status='failed_quality')::int AS failed_quality,
              count(*) FILTER (WHERE s.status='employee_unavailable')::int AS employee_unavailable, count(*) FILTER (WHERE s.status='unauthorised')::int AS unauthorised,
              count(*) FILTER (WHERE s.status IN ('started','finger_captured') AND s.started_at > now() - interval '15 minutes')::int AS in_progress
         FROM enrolment_sessions s JOIN devices d ON d.id=s.device_id ${where} AND s.started_at > now() - interval '30 days'`,
      params
    );
    params.push(limit, offset);
    const rows = await many(
      `SELECT s.*, d.name AS device_name, d.device_uid, l.name AS location_name, e.full_name AS employee_name, e.staff_number, u.full_name AS supervisor_name
         FROM enrolment_sessions s JOIN devices d ON d.id=s.device_id LEFT JOIN locations l ON l.id=d.location_id
         LEFT JOIN employees e ON e.id=s.employee_id LEFT JOIN users u ON u.id=s.supervisor_user_id
         ${where} ORDER BY s.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const cp: unknown[] = [p.organizationId];
    const cScope = scopeSql(p, 'e.location_id', cp);
    const coverage = await one(
      `SELECT count(*)::int AS active, count(*) FILTER (WHERE f>=2)::int AS fully_enrolled, count(*) FILTER (WHERE f=1)::int AS partial, count(*) FILTER (WHERE f=0)::int AS none
         FROM (SELECT (SELECT count(*) FROM biometric_templates t WHERE t.employee_id=e.id) AS f FROM employees e
                WHERE e.organization_id=$1 AND e.employment_status='active' ${cScope}) x`,
      cp
    );
    return { rows, stats, coverage };
  });
}
