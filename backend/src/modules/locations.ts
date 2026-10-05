import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { assertLocation, scopeSql } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { resolveAlertByKey } from '../services/alerts.js';
import { audit } from '../services/audit.js';
import { nudgeLocations, rosterChange } from '../services/roster.js';
import { runEmployeeSync } from '../integration/sync.js';
import { todaySummary } from './attendance.js';

const tzSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');

const locationSchema = z.object({
  name: z.string().min(2).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash, underscore'),
  address: z.string().max(300).nullable().optional(),
  timezone: tzSchema,
  workStart: z.string().regex(/^\d{2}:\d{2}$/),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/),
  graceMinutes: z.number().int().min(0).max(240),
  workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  isActive: z.boolean().optional()
});

const LOC_SELECT = `
  SELECT l.*,
    (SELECT count(*)::int FROM employees e WHERE e.location_id=l.id AND e.employment_status='active') AS active_employees,
    (SELECT count(*)::int FROM devices d WHERE d.location_id=l.id AND d.lifecycle_state <> 'decommissioned') AS devices,
    (SELECT count(*)::int FROM devices d WHERE d.location_id=l.id AND d.lifecycle_state IN ('connected','active') AND d.connectivity='online') AS online_devices,
    (SELECT count(*)::int FROM devices d WHERE d.location_id=l.id AND d.lifecycle_state IN ('connected','active') AND d.connectivity='offline') AS offline_devices,
    (SELECT count(DISTINCT ad.employee_id)::int FROM attendance_daily ad WHERE ad.location_id=l.id AND ad.work_date=(now() AT TIME ZONE l.timezone)::date) AS present_today,
    (SELECT count(*)::int FROM attendance_daily ad WHERE ad.location_id=l.id AND ad.work_date=(now() AT TIME ZONE l.timezone)::date AND ad.is_late) AS late_today,
    (SELECT count(*)::int FROM alerts a WHERE a.location_id=l.id AND a.status <> 'resolved') AS open_alerts,
    (SELECT coalesce(sum(d.pending_events),0)::int FROM devices d WHERE d.location_id=l.id) AS buffered_events,
    (SELECT array_agg(m.external_ref) FROM location_mappings m WHERE m.location_id=l.id AND m.status='mapped') AS external_refs
  FROM locations l`;

export async function locationRoutes(app: FastifyInstance) {
  app.get('/api/locations', { preHandler: requirePerm('locations.view') }, async (req) => {
    const p = req.principal!;
    const params: unknown[] = [p.organizationId];
    const scope = scopeSql(p, 'l.id', params);
    const q = (req.query as any).q as string | undefined;
    let where = ` WHERE l.organization_id=$1 ${scope}`;
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (lower(l.name) LIKE $${params.length} OR lower(l.code) LIKE $${params.length})`;
    }
    return many(`${LOC_SELECT} ${where} ORDER BY l.is_active DESC, l.name`, params);
  });

  app.get('/api/locations/:id', { preHandler: requirePerm('locations.view') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    assertLocation(p, id);
    const loc = await one(`${LOC_SELECT} WHERE l.id=$1 AND l.organization_id=$2`, [id, p.organizationId]);
    if (!loc) throw notFound('Location');
    const [devices, alerts, today, mappings, hourly] = await Promise.all([
      many(
        `SELECT id, name, device_uid, lifecycle_state, connectivity, health, last_heartbeat_at, firmware_version, pending_events, storage_used_pct
           FROM devices WHERE location_id=$1 AND lifecycle_state <> 'decommissioned' ORDER BY name`,
        [id]
      ),
      many(`SELECT * FROM alerts WHERE location_id=$1 ORDER BY created_at DESC LIMIT 15`, [id]),
      todaySummary(p, id),
      many(`SELECT * FROM location_mappings WHERE location_id=$1 ORDER BY external_ref`, [id]),
      many(
        `SELECT extract(hour FROM (e.captured_at AT TIME ZONE l.timezone))::int AS hour, count(*) FILTER (WHERE direction='in')::int AS ins,
                count(*) FILTER (WHERE direction='out')::int AS outs
           FROM attendance_events e JOIN locations l ON l.id=e.location_id
          WHERE e.location_id=$1 AND e.captured_at >= ((now() AT TIME ZONE l.timezone)::date::timestamp AT TIME ZONE l.timezone)
          GROUP BY 1 ORDER BY 1`,
        [id]
      )
    ]);
    return { location: loc, devices, alerts, today, mappings, hourly };
  });

  app.post('/api/locations', { preHandler: requirePerm('locations.manage') }, async (req) => {
    const p = req.principal!;
    const b = parse(locationSchema, req.body);
    return tx(async (db) => {
      const exists = await db.query('SELECT 1 FROM locations WHERE organization_id=$1 AND code=$2', [p.organizationId, b.code]);
      if (exists.rowCount) throw conflict(`A location with code ${b.code} already exists`);
      const row = (
        await db.query(
          `INSERT INTO locations (organization_id, name, code, address, timezone, work_start, work_end, grace_minutes, workdays, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [p.organizationId, b.name, b.code, b.address ?? null, b.timezone, b.workStart, b.workEnd, b.graceMinutes, b.workdays, b.isActive ?? true]
        )
      ).rows[0];
      await audit(db, actorFromRequest(req), { action: 'location.created', objectType: 'location', objectId: row.id, objectLabel: row.name, after: row });
      return row;
    });
  });

  app.patch('/api/locations/:id', { preHandler: requirePerm('locations.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const b = parse(locationSchema.partial(), req.body);
    return tx(async (db) => {
      const before = (await db.query('SELECT * FROM locations WHERE id=$1 AND organization_id=$2', [id, p.organizationId])).rows[0];
      if (!before) throw notFound('Location');
      const row = (
        await db.query(
          `UPDATE locations SET name=COALESCE($3,name), code=COALESCE($4,code),
                  address=CASE WHEN $12::boolean THEN $5 ELSE address END, timezone=COALESCE($6,timezone),
                  work_start=COALESCE($7,work_start), work_end=COALESCE($8,work_end), grace_minutes=COALESCE($9,grace_minutes),
                  workdays=COALESCE($10,workdays), is_active=COALESCE($11,is_active), updated_at=now()
            WHERE id=$1 AND organization_id=$2 RETURNING *`,
          [id, p.organizationId, b.name, b.code, b.address ?? null, b.timezone, b.workStart, b.workEnd, b.graceMinutes, b.workdays, b.isActive, b.address !== undefined]
        )
      ).rows[0];
      await audit(db, actorFromRequest(req), { action: 'location.updated', objectType: 'location', objectId: id, objectLabel: row.name, before, after: row });
      return row;
    });
  });

  // ───── Web-software location mappings (FR-1.2, user flow §22) ─────
  app.get('/api/location-mappings', { preHandler: requirePerm('integration.view') }, async (req) => {
    const p = req.principal!;
    const status = (req.query as any).status as string | undefined;
    const params: unknown[] = [p.organizationId];
    let where = 'WHERE m.organization_id=$1';
    if (status) {
      params.push(status);
      where += ` AND m.status=$${params.length}`;
    }
    return many(
      `SELECT m.*, l.name AS location_name, u.full_name AS resolved_by_name,
              (SELECT count(*)::int FROM employees e WHERE e.organization_id=m.organization_id AND e.external_location_ref=m.external_ref AND e.employment_status='active') AS employees_affected,
              (SELECT json_agg(x) FROM (SELECT e.id, e.full_name, e.staff_number FROM employees e
                 WHERE e.organization_id=m.organization_id AND e.external_location_ref=m.external_ref AND e.employment_status='active' ORDER BY e.full_name LIMIT 10) x) AS sample_employees
         FROM location_mappings m LEFT JOIN locations l ON l.id=m.location_id LEFT JOIN users u ON u.id=m.resolved_by
         ${where} ORDER BY (m.status='unmapped') DESC, m.first_seen_at DESC`,
      params
    );
  });

  app.post('/api/location-mappings/:id/resolve', { preHandler: requirePerm('integration.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({
        locationId: z.string().uuid().optional(),
        createLocation: locationSchema.optional(),
        rerunSync: z.boolean().default(true)
      }).refine((x) => x.locationId || x.createLocation, 'Choose an existing location or create a new one'),
      req.body
    );
    const result = await tx(async (db) => {
      const m = (await db.query('SELECT * FROM location_mappings WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, p.organizationId])).rows[0];
      if (!m) throw notFound('Mapping');
      let locationId = b.locationId;
      if (b.createLocation) {
        const c = b.createLocation;
        const exists = await db.query('SELECT 1 FROM locations WHERE organization_id=$1 AND code=$2', [p.organizationId, c.code]);
        if (exists.rowCount) throw conflict(`A location with code ${c.code} already exists`);
        const loc = (
          await db.query(
            `INSERT INTO locations (organization_id, name, code, address, timezone, work_start, work_end, grace_minutes, workdays)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [p.organizationId, c.name, c.code, c.address ?? null, c.timezone, c.workStart, c.workEnd, c.graceMinutes, c.workdays]
          )
        ).rows[0];
        await audit(db, actorFromRequest(req), { action: 'location.created', objectType: 'location', objectId: loc.id, objectLabel: loc.name, after: loc });
        locationId = loc.id;
      } else {
        const loc = await db.query('SELECT id FROM locations WHERE id=$1 AND organization_id=$2', [locationId, p.organizationId]);
        if (!loc.rowCount) throw notFound('Location');
      }
      await db.query(`UPDATE location_mappings SET location_id=$2, status='mapped', resolved_at=now(), resolved_by=$3 WHERE id=$1`, [
        id,
        locationId,
        p.userId
      ]);
      // Assign the employees that were held back, and put them on the device roster.
      const emps = await db.query(
        `UPDATE employees SET location_id=$3, updated_at=now() WHERE organization_id=$1 AND external_location_ref=$2 RETURNING id, employment_status`,
        [p.organizationId, m.external_ref, locationId]
      );
      for (const e of emps.rows) if (e.employment_status === 'active') await rosterChange(db, p.organizationId, locationId!, e.id, 'upsert');
      await audit(db, actorFromRequest(req), {
        action: 'location_mapping.resolved',
        objectType: 'location_mapping',
        objectId: id,
        objectLabel: m.external_name ?? m.external_ref,
        before: { status: m.status, locationId: m.location_id },
        after: { status: 'mapped', locationId, employeesAssigned: emps.rowCount }
      });
      return { locationId: locationId!, externalRef: m.external_ref, employeesAssigned: emps.rowCount ?? 0 };
    });
    await resolveAlertByKey(p.organizationId, `unmapped:${result.externalRef}`, `Mapped by ${p.fullName}`);
    await nudgeLocations(p.organizationId, [result.locationId]);
    // Re-run synchronisation so the web software's current assignment is applied (user flow §22).
    const run = b.rerunSync ? await runEmployeeSync(p.organizationId, 'manual', actorFromRequest(req)) : null;
    return { ...result, run, syncAlreadyRunning: b.rerunSync && !run };
  });

  app.post('/api/location-mappings/:id/ignore', { preHandler: requirePerm('integration.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const r = await tx(async (db) => {
      const m = (await db.query('SELECT * FROM location_mappings WHERE id=$1 AND organization_id=$2', [id, p.organizationId])).rows[0];
      if (!m) throw notFound('Mapping');
      await db.query(`UPDATE location_mappings SET status='ignored', resolved_at=now(), resolved_by=$2 WHERE id=$1`, [id, p.userId]);
      await audit(db, actorFromRequest(req), {
        action: 'location_mapping.ignored',
        objectType: 'location_mapping',
        objectId: id,
        objectLabel: m.external_name ?? m.external_ref,
        before: { status: m.status },
        after: { status: 'ignored' }
      });
      return m;
    });
    await resolveAlertByKey(p.organizationId, `unmapped:${r.external_ref}`, `Ignored by ${p.fullName}`);
    return { ok: true };
  });

  /** Setup helper: create a platform location for every unmapped web-software location reference. */
  app.post('/api/location-mappings/import-all', { preHandler: requirePerm('integration.manage') }, async (req) => {
    const p = req.principal!;
    const b = parse(z.object({ timezone: tzSchema.default('Africa/Lagos') }), req.body ?? {});
    const created = await tx(async (db) => {
      const unm = (await db.query(`SELECT * FROM location_mappings WHERE organization_id=$1 AND status='unmapped'`, [p.organizationId])).rows;
      const out: string[] = [];
      for (const m of unm) {
        // Location codes are restricted to [A-Za-z0-9._-]; derive a valid, unique code from the external reference.
        const base = String(m.external_ref).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'LOC';
        let loc = (await db.query('SELECT * FROM locations WHERE organization_id=$1 AND code=$2', [p.organizationId, base])).rows[0];
        if (!loc) {
          loc = (
            await db.query(`INSERT INTO locations (organization_id, name, code, timezone) VALUES ($1,$2,$3,$4) RETURNING *`, [
              p.organizationId,
              m.external_name ?? m.external_ref,
              base,
              b.timezone
            ])
          ).rows[0];
          await audit(db, actorFromRequest(req), { action: 'location.created', objectType: 'location', objectId: loc.id, objectLabel: loc.name, after: loc });
        }
        await db.query(`UPDATE location_mappings SET location_id=$2, status='mapped', resolved_at=now(), resolved_by=$3 WHERE id=$1`, [m.id, loc.id, p.userId]);
        const emps = await db.query(
          `UPDATE employees SET location_id=$3, updated_at=now() WHERE organization_id=$1 AND external_location_ref=$2 RETURNING id, employment_status`,
          [p.organizationId, m.external_ref, loc.id]
        );
        for (const e of emps.rows) if (e.employment_status === 'active') await rosterChange(db, p.organizationId, loc.id, e.id, 'upsert');
        out.push(m.external_ref);
      }
      await audit(db, actorFromRequest(req), { action: 'location_mapping.import_all', objectType: 'location_mapping', after: { refs: out } });
      return out;
    });
    for (const ref of created) await resolveAlertByKey(p.organizationId, `unmapped:${ref}`, `Imported by ${p.fullName}`);
    return { imported: created.length };
  });
}
