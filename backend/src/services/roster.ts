import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { buckets, deleteObject } from '../lib/s3.js';
import { deviceTopic, publish } from './mqtt.js';

/** Record a roster membership change for a location (drives device delta sync). */
export async function rosterChange(db: Db, orgId: string, locationId: string, employeeId: string, change: 'upsert' | 'remove') {
  await db.query(`INSERT INTO roster_changes (organization_id, location_id, employee_id, change) VALUES ($1,$2,$3,$4)`, [
    orgId,
    locationId,
    employeeId,
    change
  ]);
}

export async function templateChange(
  db: Db,
  orgId: string,
  locationId: string | null,
  employeeId: string,
  fingerIndex: number,
  templateId: string | null,
  change: 'upsert' | 'remove'
) {
  await db.query(
    `INSERT INTO template_changes (organization_id, location_id, employee_id, finger_index, template_id, change) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orgId, locationId, employeeId, fingerIndex, templateId, change]
  );
}

export async function rosterVersion(locationId: string, db: Db = pool): Promise<number> {
  const r = await db.query('SELECT coalesce(max(id),0) AS v FROM roster_changes WHERE location_id=$1', [locationId]);
  return Number(r.rows[0].v);
}

export async function templateVersion(locationId: string, db: Db = pool): Promise<number> {
  const r = await db.query('SELECT coalesce(max(id),0) AS v FROM template_changes WHERE location_id=$1', [locationId]);
  return Number(r.rows[0].v);
}

/** Send the "roster changed" nudge over MQTT to every active device at the given locations. */
export async function nudgeLocations(orgId: string, locationIds: Iterable<string>) {
  const ids = [...new Set(locationIds)].filter(Boolean);
  if (!ids.length) return;
  const devices = await pool.query(
    `SELECT device_uid, location_id FROM devices WHERE organization_id=$1 AND location_id = ANY($2::uuid[]) AND lifecycle_state IN ('connected','active')`,
    [orgId, ids]
  );
  for (const d of devices.rows) {
    const [rv, tv] = await Promise.all([rosterVersion(d.location_id), templateVersion(d.location_id)]);
    await publish(deviceTopic(orgId, d.device_uid, 'roster-changed'), { rosterVersion: rv, templateVersion: tv, at: new Date().toISOString() }).catch(
      (err) => logger.warn({ err: err.message, device: d.device_uid }, 'roster nudge failed')
    );
  }
}

/**
 * Remove all biometric templates of an employee from the central platform and schedule removal from
 * devices (NFR-3.2). Returns object keys to delete from storage after the transaction commits.
 */
export async function purgeTemplates(db: Db, orgId: string, employeeId: string, locationId: string | null): Promise<string[]> {
  const r = await db.query('DELETE FROM biometric_templates WHERE employee_id=$1 RETURNING finger_index, object_key, enrolled_location_id', [employeeId]);
  const locs = new Set<string>();
  if (locationId) locs.add(locationId);
  for (const t of r.rows) if (t.enrolled_location_id) locs.add(t.enrolled_location_id);
  for (const t of r.rows) for (const l of locs) await templateChange(db, orgId, l, employeeId, t.finger_index, null, 'remove');
  return r.rows.map((t) => t.object_key);
}

export async function deleteTemplateObjects(keys: string[]) {
  for (const k of keys) await deleteObject(buckets.templates, k).catch((err) => logger.error({ err: err.message, k }, 'template blob delete failed'));
}
