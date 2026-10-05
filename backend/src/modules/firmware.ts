import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { buckets, putObject } from '../lib/s3.js';
import { parse } from '../lib/validate.js';
import { scopeSql } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { deviceTopic, mqttConnected, publish, publishDashboard } from '../services/mqtt.js';

/**
 * Firmware management (user flow §24). Deployment states per device:
 * queued → downloading → installing → restarting → verified  |  failed → retry / rollback
 */
async function dispatchTarget(target: any, device: any, fw: any, command: 'update_firmware' | 'rollback_firmware' = 'update_firmware') {
  const c = (
    await pool.query(
      `INSERT INTO device_commands (organization_id, device_id, command, payload, issued_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        device.organization_id,
        device.id,
        command,
        JSON.stringify({ targetId: target.id, version: fw.version, sha256: fw.sha256, sizeBytes: fw.size_bytes }),
        fw.created_by ?? null
      ]
    )
  ).rows[0];
  if (device.connectivity === 'online' && mqttConnected()) {
    await publish(deviceTopic(device.organization_id, device.device_uid, 'commands'), {
      commandId: c.id,
      command,
      payload: { targetId: target.id, version: fw.version, sha256: fw.sha256, sizeBytes: fw.size_bytes }
    });
    await pool.query(`UPDATE device_commands SET status='sent', sent_at=now() WHERE id=$1`, [c.id]);
  }
}

export async function firmwareRoutes(app: FastifyInstance) {
  app.get('/api/firmware/versions', { preHandler: requirePerm('firmware.view') }, async (req) => {
    const p = req.principal!;
    return many(
      `SELECT fv.*, u.full_name AS uploaded_by_name,
              (SELECT count(*)::int FROM devices d WHERE d.organization_id=fv.organization_id AND d.firmware_version=fv.version AND d.lifecycle_state <> 'decommissioned') AS installed_on
         FROM firmware_versions fv LEFT JOIN users u ON u.id=fv.uploaded_by WHERE fv.organization_id=$1 ORDER BY fv.created_at DESC`,
      [p.organizationId]
    );
  });

  app.post('/api/firmware/versions', { preHandler: requirePerm('firmware.manage'), bodyLimit: 256 * 1024 * 1024 }, async (req) => {
    const p = req.principal!;
    const parts = req.parts();
    const fields: Record<string, string> = {};
    let file: { name: string; buf: Buffer } | null = null;
    for await (const part of parts) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        file = { name: part.filename, buf };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const meta = parse(
      z.object({
        version: z.string().min(1).max(40).regex(/^[0-9A-Za-z.+-]+$/),
        channel: z.enum(['stable', 'beta']).default('stable'),
        releaseNotes: z.string().max(5000).optional()
      }),
      fields
    );
    if (!file || !file.buf.length) throw badRequest('Firmware file is required');
    const exists = await one('SELECT 1 FROM firmware_versions WHERE organization_id=$1 AND version=$2', [p.organizationId, meta.version]);
    if (exists) throw conflict(`Version ${meta.version} already exists`);
    const sha = sha256Hex(file.buf);
    const key = `${p.organizationId}/${meta.version}/${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    await putObject(buckets.firmware, key, file.buf);
    return tx(async (db) => {
      const row = (
        await db.query(
          `INSERT INTO firmware_versions (organization_id, version, channel, release_notes, object_key, file_name, size_bytes, sha256, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [p.organizationId, meta.version, meta.channel, meta.releaseNotes ?? null, key, file!.name, file!.buf.length, sha, p.userId]
        )
      ).rows[0];
      await audit(db, actorFromRequest(req), {
        action: 'firmware.uploaded',
        objectType: 'firmware_version',
        objectId: row.id,
        objectLabel: row.version,
        after: { version: row.version, channel: row.channel, sha256: sha, sizeBytes: row.size_bytes }
      });
      return row;
    });
  });

  app.get('/api/firmware/deployments', { preHandler: requirePerm('firmware.view') }, async (req) => {
    const p = req.principal!;
    return many(
      `SELECT fd.*, fv.version, u.full_name AS created_by_name,
              (SELECT json_object_agg(state, n) FROM (SELECT state, count(*)::int AS n FROM firmware_deployment_targets t WHERE t.deployment_id=fd.id GROUP BY state) s) AS states,
              (SELECT count(*)::int FROM firmware_deployment_targets t WHERE t.deployment_id=fd.id) AS target_count
         FROM firmware_deployments fd JOIN firmware_versions fv ON fv.id=fd.firmware_id LEFT JOIN users u ON u.id=fd.created_by
        WHERE fd.organization_id=$1 ORDER BY fd.created_at DESC LIMIT 200`,
      [p.organizationId]
    );
  });

  app.get('/api/firmware/deployments/:id', { preHandler: requirePerm('firmware.view') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const dep = await one(
      `SELECT fd.*, fv.version, fv.sha256, fv.size_bytes, fv.release_notes, u.full_name AS created_by_name
         FROM firmware_deployments fd JOIN firmware_versions fv ON fv.id=fd.firmware_id LEFT JOIN users u ON u.id=fd.created_by
        WHERE fd.id=$1 AND fd.organization_id=$2`,
      [id, p.organizationId]
    );
    if (!dep) throw notFound('Deployment');
    const params: unknown[] = [id];
    const scope = scopeSql(p, 'd.location_id', params);
    const targets = await many(
      `SELECT t.*, d.name AS device_name, d.device_uid, d.connectivity, d.firmware_version AS current_version, l.name AS location_name
         FROM firmware_deployment_targets t JOIN devices d ON d.id=t.device_id LEFT JOIN locations l ON l.id=d.location_id
        WHERE t.deployment_id=$1 ${scope} ORDER BY l.name, d.name`,
      params
    );
    return { deployment: dep, targets };
  });

  /** Review is done client-side; this endpoint also serves as a dry-run when ?dryRun=true. */
  app.post('/api/firmware/deployments', { preHandler: requirePerm('firmware.manage') }, async (req) => {
    const p = req.principal!;
    const b = parse(
      z
        .object({ firmwareId: z.string().uuid(), deviceIds: z.array(z.string().uuid()).min(1).max(5000), name: z.string().max(120).optional(), dryRun: z.boolean().optional() })
        .refine((x) => x.dryRun || (x.name && x.name.trim().length >= 2), 'Deployment name is required'),
      req.body
    );
    const depName = b.name?.trim() ?? '';
    const fw = await one('SELECT * FROM firmware_versions WHERE id=$1 AND organization_id=$2', [b.firmwareId, p.organizationId]);
    if (!fw) throw notFound('Firmware version');
    const devices = await many(
      `SELECT d.*, l.name AS location_name FROM devices d LEFT JOIN locations l ON l.id=d.location_id
        WHERE d.id = ANY($1::uuid[]) AND d.organization_id=$2 AND d.lifecycle_state IN ('connected','active')`,
      [b.deviceIds, p.organizationId]
    );
    const review = {
      firmware: { id: fw.id, version: fw.version, sha256: fw.sha256, sizeBytes: fw.size_bytes },
      eligible: devices.filter((d) => d.firmware_version !== fw.version).map((d) => ({ id: d.id, name: d.name, location: d.location_name, from: d.firmware_version, online: d.connectivity === 'online' })),
      alreadyOnVersion: devices.filter((d) => d.firmware_version === fw.version).map((d) => d.name),
      notEligible: b.deviceIds.length - devices.length
    };
    if (b.dryRun) return { review };
    if (!review.eligible.length) throw badRequest('No eligible devices (all selected devices already run this version or are not connected).');
    const dep = await tx(async (db) => {
      const d = (
        await db.query(`INSERT INTO firmware_deployments (organization_id, firmware_id, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [
          p.organizationId,
          fw.id,
          depName,
          p.userId
        ])
      ).rows[0];
      for (const dev of review.eligible) {
        await db.query(`INSERT INTO firmware_deployment_targets (deployment_id, device_id, from_version) VALUES ($1,$2,$3)`, [d.id, dev.id, dev.from]);
      }
      await audit(db, actorFromRequest(req), {
        action: 'firmware.deployment_created',
        objectType: 'firmware_deployment',
        objectId: d.id,
        objectLabel: `${depName} (${fw.version})`,
        after: { version: fw.version, devices: review.eligible.map((x) => x.name) }
      });
      return d;
    });
    const targets = await many(`SELECT * FROM firmware_deployment_targets WHERE deployment_id=$1`, [dep.id]);
    for (const t of targets) {
      const dev = devices.find((d) => d.id === t.device_id);
      await dispatchTarget(t, dev, { ...fw, created_by: p.userId });
    }
    void publishDashboard(p.organizationId, 'firmware/deployment', { deploymentId: dep.id });
    return { deployment: dep, review };
  });

  app.post('/api/firmware/targets/:id/:action', { preHandler: requirePerm('firmware.manage') }, async (req) => {
    const p = req.principal!;
    const { id, action } = req.params as { id: string; action: string };
    if (!['retry', 'rollback'].includes(action)) throw notFound('Action');
    const t = await one(
      `SELECT t.*, fd.organization_id, fd.firmware_id FROM firmware_deployment_targets t JOIN firmware_deployments fd ON fd.id=t.deployment_id
        WHERE t.id=$1 AND fd.organization_id=$2`,
      [id, p.organizationId]
    );
    if (!t) throw notFound('Deployment target');
    const depStatus = (await one('SELECT status FROM firmware_deployments WHERE id=$1', [t.deployment_id]))?.status;
    if (depStatus === 'cancelled') throw badRequest('This deployment was cancelled. Create a new deployment instead.');
    const dev = await one('SELECT * FROM devices WHERE id=$1', [t.device_id]);
    let fw = await one('SELECT * FROM firmware_versions WHERE id=$1', [t.firmware_id]);
    if (action === 'rollback') {
      const prevVersion = t.from_version ?? dev.previous_firmware_version;
      const prev = prevVersion ? await one('SELECT * FROM firmware_versions WHERE organization_id=$1 AND version=$2', [p.organizationId, prevVersion]) : null;
      if (!prev) throw badRequest(`No stored firmware artefact for the previous version (${prevVersion ?? 'unknown'}) to roll back to.`);
      fw = prev;
    }
    await tx(async (db) => {
      await db.query(`UPDATE firmware_deployment_targets SET state='queued', attempts=attempts+1, error=NULL, updated_at=now() WHERE id=$1`, [id]);
      await db.query(`UPDATE firmware_deployments SET status='in_progress', finished_at=NULL WHERE id=$1`, [t.deployment_id]);
      await audit(db, actorFromRequest(req), {
        action: `firmware.target_${action}`,
        objectType: 'device',
        objectId: dev.id,
        objectLabel: dev.name,
        before: { state: t.state },
        after: { state: 'queued', version: fw.version }
      });
    });
    await dispatchTarget(t, dev, { ...fw, created_by: p.userId }, action === 'rollback' ? 'rollback_firmware' : 'update_firmware');
    void publishDashboard(p.organizationId, 'firmware/target', { ...t, state: 'queued', locationId: dev.location_id });
    return { ok: true };
  });

  app.post('/api/firmware/deployments/:id/cancel', { preHandler: requirePerm('firmware.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    await tx(async (db) => {
      const r = await db.query(`UPDATE firmware_deployments SET status='cancelled', finished_at=now() WHERE id=$1 AND organization_id=$2 AND status='in_progress' RETURNING id`, [
        id,
        p.organizationId
      ]);
      if (!r.rowCount) throw badRequest('Deployment is not in progress');
      const cancelled = await db.query(
        `UPDATE firmware_deployment_targets SET state='failed', error='Cancelled by operator', updated_at=now() WHERE deployment_id=$1 AND state='queued' RETURNING id`,
        [id]
      );
      // Commands still waiting for offline devices must not be delivered after cancellation.
      await db.query(
        `UPDATE device_commands SET status='expired', completed_at=now()
          WHERE command IN ('update_firmware','rollback_firmware') AND status='queued' AND payload->>'targetId' = ANY($1::text[])`,
        [cancelled.rows.map((r) => r.id)]
      );
      await audit(db, actorFromRequest(req), { action: 'firmware.deployment_cancelled', objectType: 'firmware_deployment', objectId: id, after: { cancelledTargets: cancelled.rowCount } });
    });
    void publishDashboard(p.organizationId, 'firmware/deployment', { deploymentId: id, status: 'cancelled' });
    return { ok: true };
  });
}
