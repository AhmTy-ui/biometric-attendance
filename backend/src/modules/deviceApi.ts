import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { deviceSignature, envelopeDecrypt, envelopeEncrypt, hashToken, openSecret, randomToken, safeEqual, sealSecret, sha256Hex } from '../lib/crypto.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { buckets, getObject, presignGet, putObject } from '../lib/s3.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { deviceActor, handleHeartbeat, publishDeviceStatus, recordEnrolmentSession } from '../services/devices.js';
import { attendanceEventSchema, ingestEvent, type DeviceRow } from '../services/ingestion.js';
import { publishDashboard, upsertDeviceMqttIdentity } from '../services/mqtt.js';
import { rosterVersion, templateChange, templateVersion } from '../services/roster.js';
import { getSettings } from '../services/settings.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    device?: any;
  }
}

/**
 * Durable channel (HTTPS): roster sync, template upload/download, batched attendance upload, activation, log upload.
 *
 * Every request after activation is signed (NFR-1.3/1.4):
 *   X-Device-Id:  device UID
 *   X-Timestamp:  unix seconds (must be within ±DEVICE_REQUEST_WINDOW_SECONDS)
 *   X-Nonce:      random, single use within the window
 *   X-Signature:  hex HMAC-SHA256(secret, METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body))
 */
async function authenticateDevice(req: FastifyRequest) {
  const uid = String(req.headers['x-device-id'] ?? '');
  const ts = String(req.headers['x-timestamp'] ?? '');
  const nonce = String(req.headers['x-nonce'] ?? '');
  const sig = String(req.headers['x-signature'] ?? '');
  if (!uid || !ts || !nonce || !sig) throw unauthorized('Missing device authentication headers');
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > config.DEVICE_REQUEST_WINDOW_SECONDS) throw new HttpError(401, 'stale_request', 'Request timestamp outside the allowed window');
  if (nonce.length < 16 || nonce.length > 128) throw unauthorized('Invalid nonce');
  const d = await one(
    `SELECT d.*, l.name AS location_name, l.timezone AS location_timezone FROM devices d LEFT JOIN locations l ON l.id=d.location_id WHERE d.device_uid=$1`,
    [uid]
  );
  if (!d || !d.secret_enc || !['connected', 'active'].includes(d.lifecycle_state)) throw unauthorized('Device not activated');
  const expected = deviceSignature(openSecret(d.secret_enc), req.method, req.url, ts, nonce, req.rawBody ?? Buffer.alloc(0));
  if (!safeEqual(expected, sig)) throw unauthorized('Bad signature');
  const fresh = await redis.set(`nonce:${d.id}:${nonce}`, '1', 'EX', config.DEVICE_REQUEST_WINDOW_SECONDS * 2, 'NX');
  if (!fresh) throw new HttpError(401, 'replay', 'Nonce already used');
  req.device = d;
}

export async function deviceApiRoutes(app: FastifyInstance) {
  const perDevice = {
    config: {
      rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => String(req.headers['x-device-id'] ?? req.ip) }
    }
  };

  // ── Activation (first contact). Authenticated by the one-time activation code issued at provisioning. ──
  app.post('/device/v1/activate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(
      z.object({
        deviceUid: z.string().min(3).max(64),
        activationCode: z.string().min(8).max(32),
        model: z.string().max(64).optional(),
        serialNumber: z.string().max(64).optional(),
        firmwareVersion: z.string().max(32).optional()
      }),
      req.body
    );
    const d = await one(`SELECT d.*, l.name AS location_name FROM devices d LEFT JOIN locations l ON l.id=d.location_id WHERE d.device_uid=$1`, [
      body.deviceUid
    ]);
    if (
      !d ||
      d.lifecycle_state !== 'provisioned' ||
      !d.activation_code_hash ||
      !safeEqual(d.activation_code_hash, hashToken(body.activationCode.trim().toUpperCase())) ||
      (d.activation_expires_at && new Date(d.activation_expires_at).getTime() < Date.now())
    ) {
      throw unauthorized('Activation code invalid, expired, or device not provisioned');
    }
    const secret = randomToken(32);
    const mqttPassword = randomToken(24);
    await upsertDeviceMqttIdentity(d.organization_id, d.device_uid, mqttPassword);
    await tx(async (db) => {
      await db.query(
        `UPDATE devices SET secret_enc=$2, credential_issued_at=now(), activation_code_hash=NULL, activation_expires_at=NULL,
                mqtt_username=$3, lifecycle_state='connected', model=COALESCE($4, model), serial_number=COALESCE($5, serial_number),
                firmware_version=COALESCE($6, firmware_version), last_seen_ip=$7, updated_at=now() WHERE id=$1`,
        [d.id, sealSecret(secret), d.device_uid, body.model ?? null, body.serialNumber ?? null, body.firmwareVersion ?? null, req.ip]
      );
      await audit(db, deviceActor(d, req.ip), {
        action: 'device.activated_credentials',
        objectType: 'device',
        objectId: d.id,
        objectLabel: d.name,
        before: { lifecycleState: 'provisioned' },
        after: { lifecycleState: 'connected', model: body.model, serialNumber: body.serialNumber, firmwareVersion: body.firmwareVersion }
      });
    });
    await publishDeviceStatus(d.id);
    return {
      deviceId: d.id,
      organizationId: d.organization_id,
      secret,
      mqtt: {
        url: `mqtts://${config.MQTT_PUBLIC_HOST}:${config.MQTT_PUBLIC_PORT}`,
        username: d.device_uid,
        password: mqttPassword,
        caCertificate: readFileSync(config.MQTT_CA_FILE, 'utf8'),
        topicPrefix: `bamp/${d.organization_id}/devices/${d.device_uid}`
      },
      apiBaseUrl: config.PUBLIC_URL
    };
  });

  app.register(async (signed) => {
    signed.addHook('preHandler', authenticateDevice);

    signed.get('/device/v1/config', perDevice, async (req) => {
      const d = req.device;
      const pol = await getSettings(d.organization_id, 'device_policies');
      const loc = d.location_id ? await one('SELECT id, name, code, timezone, work_start, work_end FROM locations WHERE id=$1', [d.location_id]) : null;
      return {
        device: { id: d.id, uid: d.device_uid, name: d.name, lifecycleState: d.lifecycle_state, config: d.config },
        location: loc,
        policies: pol,
        enrolmentAllowed: d.lifecycle_state === 'active' && Boolean(d.location_id),
        serverTime: new Date().toISOString()
      };
    });

    signed.post('/device/v1/heartbeat', perDevice, async (req) => {
      const d = await one(
        `SELECT d.*, l.name AS location_name, (SELECT count(*)::int FROM employees e WHERE e.location_id=d.location_id AND e.employment_status='active') AS roster_size
           FROM devices d LEFT JOIN locations l ON l.id=d.location_id WHERE d.id=$1`,
        [req.device.id]
      );
      await handleHeartbeat(d, req.body);
      return { ok: true, serverTime: new Date().toISOString() };
    });

    // ── Roster: complete local copy for offline operation (FR-4.1), delta by version ──
    signed.get('/device/v1/roster', perDevice, async (req) => {
      const d = req.device;
      if (!d.location_id) return { version: 0, full: true, employees: [], removed: [], supervisors: [] };
      const since = Number((req.query as any).since ?? 0) || 0;
      const version = await rosterVersion(d.location_id);
      const supervisors = (
        await pool.query(
          `SELECT u.id AS "userId", u.full_name AS "fullName", u.role, u.supervisor_pin_hash AS "pinHash", u.supervisor_employee_id AS "employeeId"
             FROM users u JOIN user_locations ul ON ul.user_id=u.id
            WHERE ul.location_id=$1 AND u.status='active' AND u.role IN ('branch_supervisor','manager')
              AND (u.supervisor_pin_hash IS NOT NULL OR u.supervisor_employee_id IS NOT NULL)
           UNION
           SELECT u.id, u.full_name, u.role, u.supervisor_pin_hash, u.supervisor_employee_id FROM users u
            WHERE u.organization_id=$2 AND u.status='active' AND u.role='administrator'
              AND (u.supervisor_pin_hash IS NOT NULL OR u.supervisor_employee_id IS NOT NULL)`,
          [d.location_id, d.organization_id]
        )
      ).rows;
      const minRetained = Number((await pool.query('SELECT coalesce(min(id),0) AS m FROM roster_changes WHERE location_id=$1', [d.location_id])).rows[0].m);
      if (since > 0 && since >= minRetained - 1 && since <= version) {
        const changes = (
          await pool.query(
            `SELECT DISTINCT ON (rc.employee_id) rc.employee_id, rc.change, e.staff_number, e.full_name, e.department, e.employment_status, e.location_id
               FROM roster_changes rc JOIN employees e ON e.id=rc.employee_id
              WHERE rc.location_id=$1 AND rc.id > $2 ORDER BY rc.employee_id, rc.id DESC`,
            [d.location_id, since]
          )
        ).rows;
        return {
          version,
          full: false,
          employees: changes
            .filter((c) => c.change === 'upsert' && c.employment_status === 'active' && c.location_id === d.location_id)
            .map((c) => ({ id: c.employee_id, staffNumber: c.staff_number, fullName: c.full_name, department: c.department })),
          removed: changes.filter((c) => c.change === 'remove' || c.employment_status !== 'active' || c.location_id !== d.location_id).map((c) => c.employee_id),
          supervisors
        };
      }
      const employees = (
        await pool.query(
          `SELECT id, staff_number AS "staffNumber", full_name AS "fullName", department FROM employees
            WHERE location_id=$1 AND employment_status='active' ORDER BY full_name`,
          [d.location_id]
        )
      ).rows;
      return { version, full: true, employees, removed: [], supervisors };
    });

    // ── Templates: escrow → device distribution ──
    signed.get('/device/v1/templates', perDevice, async (req) => {
      const d = req.device;
      if (!d.location_id) return { version: 0, full: true, upserts: [], removals: [] };
      const since = Number((req.query as any).since ?? 0) || 0;
      const version = await templateVersion(d.location_id);
      let rows: any[];
      let removals: { employeeId: string; fingerIndex: number }[] = [];
      let full = true;
      if (since > 0 && since <= version) {
        full = false;
        const changes = (
          await pool.query(
            `SELECT DISTINCT ON (employee_id, finger_index) employee_id, finger_index, change FROM template_changes
              WHERE location_id=$1 AND id > $2 ORDER BY employee_id, finger_index, id DESC`,
            [d.location_id, since]
          )
        ).rows;
        removals = changes.filter((c) => c.change === 'remove').map((c) => ({ employeeId: c.employee_id, fingerIndex: c.finger_index }));
        const ups = changes.filter((c) => c.change === 'upsert');
        rows = ups.length
          ? (
              await pool.query(
                `SELECT t.* FROM biometric_templates t JOIN employees e ON e.id=t.employee_id
                  WHERE e.location_id=$1 AND e.employment_status='active' AND (t.employee_id, t.finger_index) IN
                        (SELECT * FROM unnest($2::uuid[], $3::smallint[]))`,
                [d.location_id, ups.map((u) => u.employee_id), ups.map((u) => u.finger_index)]
              )
            ).rows
          : [];
      } else {
        rows = (
          await pool.query(
            `SELECT t.* FROM biometric_templates t JOIN employees e ON e.id=t.employee_id
              WHERE e.location_id=$1 AND e.employment_status='active'`,
            [d.location_id]
          )
        ).rows;
        // Supervisors' own fingerprints (linked employee records) must also be on the device for authorisation.
        const sup = (
          await pool.query(
            `SELECT t.* FROM biometric_templates t WHERE t.employee_id IN (
               SELECT u.supervisor_employee_id FROM users u JOIN user_locations ul ON ul.user_id=u.id
                WHERE ul.location_id=$1 AND u.supervisor_employee_id IS NOT NULL AND u.status='active')`,
            [d.location_id]
          )
        ).rows;
        const seen = new Set(rows.map((r) => r.id));
        for (const s of sup) if (!seen.has(s.id)) rows.push(s);
      }
      const upserts = [];
      for (const t of rows) {
        const blob = await getObject(buckets.templates, t.object_key);
        const plain = envelopeDecrypt(blob, t.iv, t.auth_tag, t.wrapped_dek);
        upserts.push({
          templateId: t.id,
          employeeId: t.employee_id,
          fingerIndex: t.finger_index,
          format: t.template_format,
          quality: t.quality_score,
          sha256: t.sha256,
          data: plain.toString('base64')
        });
        plain.fill(0);
      }
      await pool.query('UPDATE devices SET last_sync_at=now() WHERE id=$1', [d.id]);
      return { version, full, upserts, removals };
    });

    // ── Enrolment upload (FR-2.1 … FR-2.4, O-4) ──
    signed.post('/device/v1/templates', { ...perDevice, bodyLimit: 256 * 1024 }, async (req) => {
      const d = req.device;
      const body = parse(
        z.object({
          sessionId: z.string().uuid(),
          employeeId: z.string().uuid(),
          fingerIndex: z.number().int().min(1).max(10),
          quality: z.number().int().min(0).max(100),
          format: z.string().max(32).default('ISO19794-2'),
          template: z.string().min(16).max(200_000),
          sha256: z.string().length(64),
          supervisorUserId: z.string().uuid(),
          authorisationMethod: z.enum(['fingerprint', 'pin'])
        }),
        req.body
      );
      // O-4: enrolment only at authorised (active, location-assigned) branch devices.
      if (d.lifecycle_state !== 'active' || !d.location_id) throw forbidden('Enrolment is only permitted on active, location-assigned devices.');
      const emp = await one('SELECT * FROM employees WHERE id=$1 AND organization_id=$2', [body.employeeId, d.organization_id]);
      // FR-2.2: devices never create employees; enrolment only for an employee on this device's roster.
      if (!emp || emp.location_id !== d.location_id || emp.employment_status !== 'active') {
        await recordEnrolmentSession(d, { sessionId: body.sessionId, status: 'employee_unavailable', employeeId: body.employeeId, detail: 'Employee not on this device roster' });
        throw forbidden('Employee is not on this device roster.');
      }
      // FR-2.1: supervisor authorisation must come from a user authorised for this location.
      const sup = await one(
        `SELECT u.* FROM users u WHERE u.id=$1 AND u.organization_id=$2 AND u.status='active'
            AND (u.role='administrator' OR EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=$3))`,
        [body.supervisorUserId, d.organization_id, d.location_id]
      );
      if (!sup) {
        await recordEnrolmentSession(d, { sessionId: body.sessionId, status: 'unauthorised', employeeId: body.employeeId, detail: 'Supervisor not authorised for this branch' });
        throw forbidden('Supervisor is not authorised for this branch.');
      }
      const pol = await getSettings(d.organization_id, 'device_policies');
      if (body.quality < pol.minEnrolQuality) {
        await recordEnrolmentSession(d, { sessionId: body.sessionId, status: 'failed_quality', employeeId: body.employeeId, detail: `Quality ${body.quality} < ${pol.minEnrolQuality}` });
        throw badRequest(`Fingerprint quality too low (${body.quality} < ${pol.minEnrolQuality}).`);
      }
      const plain = Buffer.from(body.template, 'base64');
      if (sha256Hex(plain) !== body.sha256) throw badRequest('Template checksum mismatch');
      const enc = envelopeEncrypt(plain);
      const key = `${d.organization_id}/${emp.id}/${body.fingerIndex}-${Date.now()}.bin`;
      await putObject(buckets.templates, key, enc.ciphertext);
      plain.fill(0);
      const prev = await one('SELECT object_key FROM biometric_templates WHERE employee_id=$1 AND finger_index=$2', [emp.id, body.fingerIndex]);
      const t = await tx(async (db) => {
        const row = (
          await db.query(
            `INSERT INTO biometric_templates (organization_id, employee_id, finger_index, quality_score, template_format, object_key, wrapped_dek,
                                              kek_id, iv, auth_tag, sha256, enrolled_device_id, enrolled_location_id, authorised_by_user_id, authorisation_method)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (employee_id, finger_index) DO UPDATE SET quality_score=EXCLUDED.quality_score, template_format=EXCLUDED.template_format,
               object_key=EXCLUDED.object_key, wrapped_dek=EXCLUDED.wrapped_dek, kek_id=EXCLUDED.kek_id, iv=EXCLUDED.iv, auth_tag=EXCLUDED.auth_tag,
               sha256=EXCLUDED.sha256, enrolled_device_id=EXCLUDED.enrolled_device_id, enrolled_location_id=EXCLUDED.enrolled_location_id,
               authorised_by_user_id=EXCLUDED.authorised_by_user_id, authorisation_method=EXCLUDED.authorisation_method, enrolled_at=now()
             RETURNING id, finger_index, quality_score, enrolled_at`,
            [d.organization_id, emp.id, body.fingerIndex, body.quality, body.format, key, enc.wrappedDek, enc.kekId, enc.iv, enc.authTag, body.sha256,
              d.id, d.location_id, sup.id, body.authorisationMethod]
          )
        ).rows[0];
        await templateChange(db, d.organization_id, d.location_id, emp.id, body.fingerIndex, row.id, 'upsert');
        await audit(db, { ...deviceActor(d, req.ip), name: `${d.name} (authorised by ${sup.full_name})` }, {
          action: 'biometric.template_enrolled',
          objectType: 'employee',
          objectId: emp.id,
          objectLabel: `${emp.full_name} (${emp.staff_number})`,
          after: { fingerIndex: body.fingerIndex, quality: body.quality, deviceId: d.id, supervisorUserId: sup.id, method: body.authorisationMethod }
        });
        return row;
      });
      if (prev?.object_key && prev.object_key !== key) {
        const { deleteObject } = await import('../lib/s3.js');
        await deleteObject(buckets.templates, prev.object_key).catch(() => undefined);
      }
      const count = Number((await pool.query('SELECT count(*) FROM biometric_templates WHERE employee_id=$1', [emp.id])).rows[0].count);
      await recordEnrolmentSession(d, {
        sessionId: body.sessionId,
        status: count >= pol.fingersPerEmployee ? 'completed' : 'finger_captured',
        employeeId: emp.id,
        supervisorUserId: sup.id,
        authorisationMethod: body.authorisationMethod,
        fingersCaptured: count
      });
      // Other devices at the location pull the new template.
      const { nudgeLocations } = await import('../services/roster.js');
      await nudgeLocations(d.organization_id, [d.location_id]);
      void publishDashboard(d.organization_id, 'employee/biometric', { employeeId: emp.id, fingers: count, locationId: d.location_id });
      return { templateId: t.id, fingersEnrolled: count, required: pol.fingersPerEmployee };
    });

    signed.post('/device/v1/enrolment-sessions', perDevice, async (req) => {
      return recordEnrolmentSession(req.device, req.body);
    });

    // ── Buffered attendance upload, oldest first (FR-4.2); idempotent (FR-3.2) ──
    signed.post('/device/v1/attendance/batch', { ...perDevice, bodyLimit: 5 * 1024 * 1024 }, async (req) => {
      const d = req.device as DeviceRow & { lifecycle_state: string };
      const body = parse(z.object({ events: z.array(attendanceEventSchema).min(1).max(5000), remaining: z.number().int().min(0).optional() }), req.body);
      const sorted = [...body.events].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
      const results = [];
      for (const ev of sorted) {
        try {
          results.push(await ingestEvent(d, { ...ev, buffered: ev.buffered ?? true }, 'https_batch'));
        } catch (err: any) {
          logger.error({ err: err.message, eventUid: ev.eventUid }, 'batch event failed');
          results.push({ eventUid: ev.eventUid, status: 'error', error: 'Temporary server error; retry' });
        }
      }
      const accepted = results.filter((r) => r.status === 'accepted').length;
      const duplicate = results.filter((r) => r.status === 'duplicate').length;
      await pool.query('UPDATE devices SET pending_events=$2, last_sync_at=now() WHERE id=$1', [d.id, body.remaining ?? 0]);
      void publishDashboard(d.organization_id, 'device/reconcile', {
        deviceId: d.id,
        deviceName: d.name,
        locationId: d.location_id,
        uploaded: accepted + duplicate,
        remaining: body.remaining ?? 0,
        complete: (body.remaining ?? 0) === 0
      });
      if ((body.remaining ?? 0) === 0 && accepted > 0) {
        await tx((db) =>
          audit(db, deviceActor(d as any, req.ip), {
            action: 'device.reconciliation_complete',
            objectType: 'device',
            objectId: d.id,
            objectLabel: d.name,
            after: { accepted, duplicate }
          })
        );
      }
      await publishDeviceStatus(d.id);
      return { accepted, duplicate, results };
    });

    signed.post('/device/v1/logs', { ...perDevice, bodyLimit: 2 * 1024 * 1024 }, async (req) => {
      const body = parse(
        z.object({
          entries: z
            .array(z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(4000), context: z.any().optional(), loggedAt: z.string().datetime({ offset: true }) }))
            .max(2000)
        }),
        req.body
      );
      for (const e of body.entries) {
        await pool.query('INSERT INTO device_logs (device_id, level, message, context, logged_at) VALUES ($1,$2,$3,$4,$5)', [
          req.device.id,
          e.level,
          e.message,
          e.context === undefined ? null : JSON.stringify(e.context),
          e.loggedAt
        ]);
      }
      return { stored: body.entries.length };
    });

    signed.get('/device/v1/firmware/:targetId', perDevice, async (req) => {
      const { targetId } = req.params as { targetId: string };
      const t = await one(
        `SELECT t.id, fv.version, fv.sha256, fv.size_bytes, fv.object_key FROM firmware_deployment_targets t
           JOIN firmware_deployments fd ON fd.id=t.deployment_id JOIN firmware_versions fv ON fv.id=fd.firmware_id
          WHERE t.id=$1 AND t.device_id=$2`,
        [targetId, req.device.id]
      );
      if (!t) throw new HttpError(404, 'not_found', 'Firmware target not found');
      return { version: t.version, sha256: t.sha256, sizeBytes: t.size_bytes, downloadUrl: await presignGet(buckets.firmware, t.object_key, 1800) };
    });

    signed.get('/device/v1/firmware/:targetId/blob', perDevice, async (req, reply) => {
      const { targetId } = req.params as { targetId: string };
      const t = await one(
        `SELECT fv.object_key, fv.sha256 FROM firmware_deployment_targets t JOIN firmware_deployments fd ON fd.id=t.deployment_id
           JOIN firmware_versions fv ON fv.id=fd.firmware_id WHERE t.id=$1 AND t.device_id=$2`,
        [targetId, req.device.id]
      );
      if (!t) throw new HttpError(404, 'not_found', 'Firmware target not found');
      reply.header('content-type', 'application/octet-stream').header('x-sha256', t.sha256);
      return getObject(buckets.firmware, t.object_key);
    });
  });
}
