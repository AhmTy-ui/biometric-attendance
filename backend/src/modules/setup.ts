import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, tx } from '../db/pool.js';
import { parse } from '../lib/validate.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { getSettings, invalidateSettings, saveSettings } from '../services/settings.js';

/**
 * Progressive first-time setup (user flow §3):
 * Account → Security (MFA) → Organization → Infrastructure (locations) → Devices → Employees (sync) → Ready.
 * Account and MFA steps are handled by /api/auth/invite/* and /api/auth/mfa/*; this module drives the rest.
 */
export async function setupRoutes(app: FastifyInstance) {
  app.get('/api/setup/checklist', { preHandler: requirePerm('dashboard.view') }, async (req) => {
    const p = req.principal!;
    const org = await one('SELECT * FROM organizations WHERE id=$1', [p.organizationId]);
    const me = await one('SELECT mfa_enabled, password_hash IS NOT NULL AS has_password FROM users WHERE id=$1', [p.userId]);
    const integ = await getSettings(p.organizationId, 'integration');
    const counts = await one(
      `SELECT (SELECT count(*)::int FROM locations WHERE organization_id=$1) AS locations,
              (SELECT count(*)::int FROM location_mappings WHERE organization_id=$1 AND status='unmapped') AS unmapped,
              (SELECT count(*)::int FROM devices WHERE organization_id=$1 AND lifecycle_state <> 'decommissioned') AS devices,
              (SELECT count(*)::int FROM devices WHERE organization_id=$1 AND lifecycle_state='active') AS active_devices,
              (SELECT count(*)::int FROM employees WHERE organization_id=$1) AS employees,
              (SELECT count(*)::int FROM sync_runs WHERE organization_id=$1 AND kind='employees' AND status IN ('success','partial')) AS good_syncs`,
      [p.organizationId]
    );
    const steps = [
      { key: 'account', label: 'Account', done: me.has_password },
      { key: 'security', label: 'Security (MFA)', done: me.mfa_enabled },
      { key: 'organization', label: 'Organization', done: Boolean(org.name && org.timezone && org.setup_completed) || Boolean((await getSettings(p.organizationId, 'organization')).displayName) },
      { key: 'integration', label: 'Web software connection', done: Boolean(integ.baseUrl) },
      { key: 'infrastructure', label: 'Locations', done: counts.locations > 0 && counts.unmapped === 0 },
      { key: 'devices', label: 'Devices', done: counts.active_devices > 0 },
      { key: 'employees', label: 'Employee synchronisation', done: counts.good_syncs > 0 && counts.employees > 0 }
    ];
    return { organization: org, steps, counts, completed: org.setup_completed };
  });

  app.post('/api/setup/organization', { preHandler: requirePerm('settings.manage') }, async (req) => {
    const p = req.principal!;
    const b = parse(z.object({ displayName: z.string().min(2).max(120), timezone: z.string().min(1), supportEmail: z.string().email().or(z.literal('')) }), req.body);
    const current = await getSettings(p.organizationId, 'organization');
    await tx(async (db) => {
      const before = (await db.query('SELECT name, timezone FROM organizations WHERE id=$1', [p.organizationId])).rows[0];
      await saveSettings(p.organizationId, 'organization', { ...current, ...b }, p.userId, db);
      await db.query('UPDATE organizations SET name=$2, timezone=$3, updated_at=now() WHERE id=$1', [p.organizationId, b.displayName, b.timezone]);
      await audit(db, actorFromRequest(req), { action: 'organization.confirmed', objectType: 'organization', objectId: p.organizationId, before, after: b });
    });
    await invalidateSettings(p.organizationId, 'organization');
    return { ok: true };
  });

  app.post('/api/setup/complete', { preHandler: requirePerm('settings.manage') }, async (req) => {
    const p = req.principal!;
    await tx(async (db) => {
      await db.query('UPDATE organizations SET setup_completed=true, updated_at=now() WHERE id=$1', [p.organizationId]);
      await audit(db, actorFromRequest(req), { action: 'organization.setup_completed', objectType: 'organization', objectId: p.organizationId, after: { setupCompleted: true } });
    });
    return { ok: true };
  });
}
