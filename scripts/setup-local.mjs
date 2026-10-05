/**
 * One-time local environment setup for BAMP (idempotent — safe to re-run).
 *
 *   node scripts/setup-local.mjs [--trust-ca]
 *
 * Creates, under the runtime directory (%LOCALAPPDATA%\bamp-runtime on Windows):
 *   - secrets.json            generated credentials (PostgreSQL, Redis, S3 / SeaweedFS, MQTT, web-software API key)
 *   - keys/template-kek.b64   key-encryption key for biometric templates (kept OUTSIDE the database, NFR-3.1)
 *   - pki/                    private CA + server certificate (TLS for HTTPS 4000/4100, MQTT 8883)
 *   - data/postgres           PostgreSQL 16 cluster with databases `bamp` and `websoft`
 *   - config/redis.conf, config/mosquitto.conf, data/mosquitto/dynamic-security.json
 * and writes .env files for backend, frontend, reference-web-software and device-agent.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { IS_WIN, ROOT, RUNTIME, exe, findDynsecPlugin, findMosquittoDir, paths, pgBin } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const log = (m) => console.log(`\x1b[36m[setup]\x1b[0m ${m}`);
const fwd = (p) => p.replace(/\\/g, '/');
const secret = (n = 24) => randomBytes(n).toString('base64url');

for (const d of [RUNTIME, join(RUNTIME, 'keys'), paths.pki, join(RUNTIME, 'data'), paths.redisData, paths.s3Data, paths.mosquittoData, join(RUNTIME, 'config'), paths.logs])
  mkdirSync(d, { recursive: true });

// ───────────── secrets ─────────────
let secrets = existsSync(paths.secrets) ? JSON.parse(readFileSync(paths.secrets, 'utf8')) : {};
const need = {
  pgSuperPassword: () => secret(),
  pgAppPassword: () => secret(),
  pgWebsoftPassword: () => secret(),
  redisPassword: () => secret(),
  s3AccessKey: () => `BAMP${randomBytes(8).toString('hex').toUpperCase()}`,
  s3SecretKey: () => secret(30),
  mqttCloudPassword: () => secret(),
  webSoftwareApiKey: () => `wsk_${secret(32)}`,
  webSoftwareAdminPassword: () => secret(12)
};
for (const [k, f] of Object.entries(need)) if (!secrets[k]) secrets[k] = f();
writeFileSync(paths.secrets, JSON.stringify(secrets, null, 2), { mode: 0o600 });
log(`secrets → ${paths.secrets}`);

if (!existsSync(paths.kek)) {
  writeFileSync(paths.kek, randomBytes(32).toString('base64'), { mode: 0o600 });
  log(`template KEK generated → ${paths.kek}`);
}

// ───────────── PKI ─────────────
const caCrt = join(paths.pki, 'ca.crt');
const caKey = join(paths.pki, 'ca.key');
const srvCrt = join(paths.pki, 'server.crt');
const srvKey = join(paths.pki, 'server.key');
if (!existsSync(caCrt)) {
  const keys = forge.pki.rsa.generateKeyPair(3072);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'BAMP Local Root CA' }, { name: 'organizationName', value: 'BAMP' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  writeFileSync(caCrt, forge.pki.certificateToPem(cert));
  writeFileSync(caKey, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  log('private CA created');
}
if (!existsSync(srvCrt)) {
  const ca = forge.pki.certificateFromPem(readFileSync(caCrt, 'utf8'));
  const caPriv = forge.pki.privateKeyFromPem(readFileSync(caKey, 'utf8'));
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400000);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }, { name: 'organizationName', value: 'BAMP' }]);
  cert.setIssuer(ca.subject.attributes);
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: hostname() },
    { type: 7, ip: '127.0.0.1' }
  ];
  for (const ifs of Object.values(networkInterfaces()))
    for (const i of ifs ?? []) if (i.family === 'IPv4' && !i.internal) altNames.push({ type: 7, ip: i.address });
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames }
  ]);
  cert.sign(caPriv, forge.md.sha256.create());
  writeFileSync(srvCrt, forge.pki.certificateToPem(cert));
  writeFileSync(srvKey, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  log(`server certificate issued for ${altNames.map((a) => a.value ?? a.ip).join(', ')}`);
}

// ───────────── PostgreSQL 16 ─────────────
function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}
const pgEnv = { ...process.env, PGPASSWORD: secrets.pgSuperPassword };
if (!existsSync(join(paths.pgData, 'PG_VERSION'))) {
  const pwfile = join(RUNTIME, 'pw.tmp');
  writeFileSync(pwfile, secrets.pgSuperPassword);
  try {
    log('initialising PostgreSQL cluster…');
    run(pgBin('initdb'), ['-D', paths.pgData, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile', pwfile, '-E', 'UTF8', '--locale=C']);
  } finally {
    rmSync(pwfile, { force: true });
  }
}
async function withPostgres(fn) {
  let started = false;
  try {
    run(pgBin('pg_isready'), ['-h', '127.0.0.1', '-p', '5432']);
  } catch {
    log('starting PostgreSQL temporarily…');
    // stdio must not be piped: on Windows the postmaster inherits the handles and execFileSync would never return.
    run(pgBin('pg_ctl'), ['-D', paths.pgData, '-w', '-t', '60', '-l', join(paths.logs, 'postgres-setup.log'), '-o', '-p 5432 -c listen_addresses=127.0.0.1', 'start'], {
      stdio: 'ignore'
    });
    started = true;
  }
  try {
    await fn();
  } finally {
    if (started) run(pgBin('pg_ctl'), ['-D', paths.pgData, '-w', 'stop', '-m', 'fast'], { stdio: 'ignore' });
  }
}
const psql = (sql, db = 'postgres') => run(pgBin('psql'), ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { env: pgEnv });
await withPostgres(async () => {
  for (const [role, pw, db] of [
    ['bamp', secrets.pgAppPassword, 'bamp'],
    ['websoft', secrets.pgWebsoftPassword, 'websoft']
  ]) {
    if (!psql(`SELECT 1 FROM pg_roles WHERE rolname='${role}'`).trim()) psql(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    else psql(`ALTER ROLE ${role} PASSWORD '${pw}'`);
    if (!psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`).trim()) psql(`CREATE DATABASE ${db} OWNER ${role} ENCODING 'UTF8'`);
    psql(`CREATE EXTENSION IF NOT EXISTS pgcrypto`, db);
    psql(`CREATE EXTENSION IF NOT EXISTS citext`, db);
  }
  log('PostgreSQL databases bamp + websoft ready');
});

// ───────────── Redis ─────────────
writeFileSync(
  paths.redisConf,
  [
    'bind 127.0.0.1',
    'port 6379',
    'protected-mode yes',
    `requirepass ${secrets.redisPassword}`,
    `dir ${fwd(paths.redisData)}`,
    'appendonly yes',
    'appendfsync everysec',
    'maxmemory-policy noeviction',
    ''
  ].join('\n')
);

// ───────────── SeaweedFS S3 identities ─────────────
writeFileSync(
  paths.s3Config,
  JSON.stringify(
    {
      identities: [
        {
          name: 'bamp-backend',
          credentials: [{ accessKey: secrets.s3AccessKey, secretKey: secrets.s3SecretKey }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging']
        }
      ]
    },
    null,
    2
  ),
  { mode: 0o600 }
);

// ───────────── Mosquitto (TLS 8883 + dynamic security) ─────────────
const mosqDir = findMosquittoDir();
const plugin = findDynsecPlugin(mosqDir);
// A power loss can leave the broker's store truncated or zero-filled; keep the damaged copy and re-initialise.
if (existsSync(paths.dynsec)) {
  let valid = false;
  try {
    valid = Array.isArray(JSON.parse(readFileSync(paths.dynsec, 'utf8')).clients);
  } catch {
    valid = false;
  }
  if (!valid) {
    const aside = `${paths.dynsec}.damaged-${Date.now()}`;
    renameSync(paths.dynsec, aside);
    log(`Mosquitto dynamic-security store was damaged → moved to ${aside}; re-initialising (devices must be re-activated: Device → Re-issue credentials)`);
  }
}
if (!existsSync(paths.dynsec)) {
  log('initialising Mosquitto dynamic-security store…');
  run(join(mosqDir, exe('mosquitto_ctrl')), ['dynsec', 'init', paths.dynsec, 'bamp-cloud', secrets.mqttCloudPassword]);
}
writeFileSync(
  paths.mosquittoConf,
  [
    '# Generated by scripts/setup-local.mjs',
    'allow_anonymous false',
    'persistence true',
    `persistence_location ${fwd(paths.mosquittoData)}/`,
    `plugin ${fwd(plugin)}`,
    `plugin_opt_config_file ${fwd(paths.dynsec)}`,
    '',
    '# MQTT over TLS only (NFR-1.2)',
    'listener 8883',
    `cafile ${fwd(caCrt)}`,
    `certfile ${fwd(srvCrt)}`,
    `keyfile ${fwd(srvKey)}`,
    'tls_version tlsv1.2',
    'max_keepalive 120',
    ''
  ].join('\n')
);
log('Mosquitto configured (TLS 8883, dynamic security)');

// ───────────── .env files ─────────────
const dbUrl = `postgres://bamp:${encodeURIComponent(secrets.pgAppPassword)}@127.0.0.1:5432/bamp`;
writeFileSync(
  join(ROOT, 'backend', '.env'),
  [
    'NODE_ENV=development',
    'LOG_LEVEL=info',
    'HTTP_HOST=0.0.0.0',
    'HTTP_PORT=4000',
    'PUBLIC_URL=https://localhost:4000',
    'TLS_ENABLED=true',
    `TLS_CERT_FILE=${srvCrt}`,
    `TLS_KEY_FILE=${srvKey}`,
    'COOKIE_SECURE=true',
    `FRONTEND_DIST=${join(ROOT, 'frontend', 'dist')}`,
    'CORS_ORIGINS=https://localhost:5173',
    `DATABASE_URL=${dbUrl}`,
    `REDIS_URL=redis://:${encodeURIComponent(secrets.redisPassword)}@127.0.0.1:6379`,
    'MQTT_URL=mqtts://localhost:8883',
    `MQTT_CA_FILE=${caCrt}`,
    'MQTT_USERNAME=bamp-cloud',
    `MQTT_PASSWORD=${secrets.mqttCloudPassword}`,
    'MQTT_PUBLIC_HOST=localhost',
    'MQTT_PUBLIC_PORT=8883',
    'S3_ENDPOINT=http://127.0.0.1:9000',
    'S3_REGION=us-east-1',
    `S3_ACCESS_KEY=${secrets.s3AccessKey}`,
    `S3_SECRET_KEY=${secrets.s3SecretKey}`,
    'S3_FORCE_PATH_STYLE=true',
    `KEK_FILE=${paths.kek}`,
    'KEK_ID=kek-1',
    `PG_DUMP_PATH=${pgBin('pg_dump')}`,
    'BACKUP_RETENTION_DAYS=30',
    '# Optional: SMTP for email notifications / invitations',
    'SMTP_HOST=',
    'SMTP_PORT=587',
    'SMTP_USER=',
    'SMTP_PASSWORD=',
    'SMTP_FROM=BAMP <no-reply@bamp.local>',
    ''
  ].join('\n')
);
writeFileSync(
  join(ROOT, 'reference-web-software', '.env'),
  [
    'PORT=4100',
    'PUBLIC_URL=https://localhost:4100',
    `TLS_CERT_FILE=${srvCrt}`,
    `TLS_KEY_FILE=${srvKey}`,
    `DATABASE_URL=postgres://websoft:${encodeURIComponent(secrets.pgWebsoftPassword)}@127.0.0.1:5432/websoft`,
    `API_KEY=${secrets.webSoftwareApiKey}`,
    'ADMIN_EMAIL=hr-admin@websoft.local',
    `ADMIN_PASSWORD=${secrets.webSoftwareAdminPassword}`,
    ''
  ].join('\n')
);
writeFileSync(
  join(ROOT, 'frontend', '.env.local'),
  ['VITE_API_TARGET=https://localhost:4000', `VITE_DEV_TLS_CERT=${srvCrt}`, `VITE_DEV_TLS_KEY=${srvKey}`, ''].join('\n')
);
writeFileSync(
  join(ROOT, 'device-agent', '.env'),
  [
    'BAMP_API_URL=https://localhost:4000',
    `BAMP_CA_FILE=${caCrt}`,
    `BAMP_DATA_DIR=${join(RUNTIME, 'device-agent')}`,
    '# Fingerprint sensor driver: "serial" (R30x/ZFM/AS608 family on a COM port) or "console" (keyboard-operated bench terminal)',
    'SENSOR_DRIVER=console',
    'SENSOR_PORT=COM3',
    'SENSOR_BAUD=57600',
    ''
  ].join('\n')
);
log('.env files written (backend, frontend, reference-web-software, device-agent)');

if (args.has('--trust-ca') && IS_WIN) {
  log('adding BAMP Local Root CA to the current user trust store (Windows will ask for confirmation)…');
  spawn('certutil', ['-user', '-addstore', 'Root', caCrt], { stdio: 'inherit' });
}

console.log(`
Setup complete.
  Runtime dir:   ${RUNTIME}
  CA certificate: ${caCrt}   (trust it in your browser/OS, or run: npm run setup -- --trust-ca)
  Web software admin:  hr-admin@websoft.local / ${secrets.webSoftwareAdminPassword}
Next:  npm run infra   (in one terminal)   then   npm run start
`);
