import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, tx } from '../db/pool.js';
import { sealSecret } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { mailConfigured } from '../services/mailer.js';
import { getSettings, invalidateSettings, saveSettings, settingSchemas, type SettingSection } from '../services/settings.js';

const MASK = '••••••••';
const SECTIONS = Object.keys(settingSchemas) as SettingSection[];

function mask(section: SettingSection, value: any) {
  if (section !== 'integration') return value;
  return {
    ...value,
    apiKey: value.apiKey ? MASK : '',
    exportEndpointAuthHeader: value.exportEndpointAuthHeader ? MASK : ''
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: requirePerm('settings.view') }, async (req) => {
    const org = req.principal!.organizationId;
    const out: Record<string, unknown> = {};
    for (const s of SECTIONS) out[s] = mask(s, await getSettings(org, s));
    const o = await one('SELECT name, slug, timezone, created_at FROM organizations WHERE id=$1', [org]);
    return { settings: out, organization: o, environment: { smtpConfigured: mailConfigured() } };
  });

  app.put('/api/settings/:section', { preHandler: requirePerm('settings.manage') }, async (req) => {
    const p = req.principal!;
    const { section } = req.params as { section: string };
    if (!SECTIONS.includes(section as SettingSection)) throw badRequest('Unknown settings section');
    const s = section as SettingSection;
    const before: any = await getSettings(p.organizationId, s);
    let value: any = { ...before, ...(req.body as object) };
    if (s === 'integration') {
      const b = req.body as any;
      value.apiKey = b.apiKey === MASK || b.apiKey === undefined ? before.apiKey : b.apiKey ? `sealed:${sealSecret(b.apiKey)}` : '';
      value.exportEndpointAuthHeader =
        b.exportEndpointAuthHeader === MASK || b.exportEndpointAuthHeader === undefined
          ? (before as any).exportEndpointAuthHeader
          : b.exportEndpointAuthHeader
            ? `sealed:${sealSecret(b.exportEndpointAuthHeader)}`
            : '';
    }
    if (s === 'device_policies' && value.storageCriticalPct < value.storageWarningPct) throw badRequest('Critical threshold must be ≥ warning threshold');
    const r = settingSchemas[s].safeParse(value);
    if (!r.success) throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const saved = await tx(async (db) => {
      const out = await saveSettings(p.organizationId, s, r.data as any, p.userId, db);
      if (s === 'organization') {
        const org = out as z.infer<typeof settingSchemas.organization>;
        await db.query('UPDATE organizations SET name=$2, timezone=$3, updated_at=now() WHERE id=$1', [p.organizationId, org.displayName, org.timezone]);
      }
      await audit(db, actorFromRequest(req), {
        action: `settings.${s}.updated`,
        objectType: 'settings',
        objectId: s,
        objectLabel: s,
        before: mask(s, before),
        after: mask(s, out)
      });
      return out;
    });
    await invalidateSettings(p.organizationId, s);
    if (s === 'integration') {
      const { rescheduleOrg } = await import('../workers/scheduler.js');
      await rescheduleOrg(p.organizationId);
    }
    return mask(s, saved);
  });
}
