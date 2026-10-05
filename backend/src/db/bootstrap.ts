/**
 * First-run bootstrap: creates the organisation and its first administrator (status "invited"), and prints the
 * one-time account-verification link used for the First-Time Setup flow.
 *
 *   npm run bootstrap -- --org "Apex Holdings" --slug apex --email admin@apex.com --name "Ada Obi" [--tz Africa/Lagos]
 *                        [--web-url https://hr.example.com --web-key <apiKey>]
 */
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { hashToken, randomToken, sealSecret } from '../lib/crypto.js';
import { audit, systemActor } from '../services/audit.js';
import { defaultSettings, saveSettings } from '../services/settings.js';
import { migrate } from './migrate.js';
import { pool, tx } from './pool.js';
import { redis } from '../lib/redis.js';

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    slug: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    tz: { type: 'string', default: 'Africa/Lagos' },
    'web-url': { type: 'string' },
    'web-key': { type: 'string' }
  }
});

async function main() {
  if (!values.org || !values.slug || !values.email || !values.name) {
    console.error('Usage: npm run bootstrap -- --org "<name>" --slug <slug> --email <admin email> --name "<admin name>" [--tz <IANA tz>] [--web-url <url> --web-key <key>]');
    process.exit(2);
  }
  await migrate();
  const out = await tx(async (db) => {
    const existing = await db.query('SELECT id FROM organizations WHERE slug=$1', [values.slug]);
    let orgId: string;
    if (existing.rowCount) {
      orgId = existing.rows[0].id;
    } else {
      orgId = (await db.query('INSERT INTO organizations (name, slug, timezone) VALUES ($1,$2,$3) RETURNING id', [values.org, values.slug, values.tz])).rows[0].id;
      await audit(db, systemActor(orgId, 'Bootstrap'), { action: 'organization.created', objectType: 'organization', objectId: orgId, after: { name: values.org, slug: values.slug } });
      for (const [section, value] of Object.entries(defaultSettings)) {
        const v: any = section === 'organization' ? { ...value, displayName: values.org, timezone: values.tz } : value;
        await saveSettings(orgId, section as any, v, null, db);
      }
    }
    if (values['web-url']) {
      const cur = (await db.query(`SELECT value FROM settings WHERE organization_id=$1 AND section='integration'`, [orgId])).rows[0]?.value ?? defaultSettings.integration;
      await saveSettings(
        orgId,
        'integration',
        { ...defaultSettings.integration, ...cur, baseUrl: values['web-url'], apiKey: values['web-key'] ? `sealed:${sealSecret(values['web-key'])}` : cur.apiKey },
        null,
        db
      );
      await audit(db, systemActor(orgId, 'Bootstrap'), { action: 'settings.integration.updated', objectType: 'settings', objectId: 'integration', after: { baseUrl: values['web-url'] } });
    }
    let user = (await db.query('SELECT * FROM users WHERE email=$1', [values.email])).rows[0];
    if (!user) {
      user = (
        await db.query(`INSERT INTO users (organization_id, email, full_name, role, status, mfa_required) VALUES ($1,$2,$3,'administrator','invited',true) RETURNING *`, [
          orgId,
          values.email,
          values.name
        ])
      ).rows[0];
      await audit(db, systemActor(orgId, 'Bootstrap'), { action: 'user.created', objectType: 'user', objectId: user.id, objectLabel: user.email, after: { role: 'administrator' } });
    }
    let link: string | null = null;
    if (user.status === 'invited') {
      const token = randomToken(32);
      await db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'invite',$2, now() + interval '7 days')`, [user.id, hashToken(token)]);
      link = `${config.PUBLIC_URL}/setup/account?token=${token}`;
    }
    return { orgId, link, status: user.status };
  });
  console.log(`\nOrganisation: ${values.org} (${out.orgId})`);
  if (out.link) console.log(`\nFirst-time setup link for ${values.email} (valid 7 days):\n\n  ${out.link}\n`);
  else console.log(`\nAdministrator ${values.email} is already ${out.status}.\n`);
  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
