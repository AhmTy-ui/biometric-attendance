#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { runAgent } from './agent.js';
import { BASE_ROOT, BASE_VERSION, RUNNING_VERSION, config, readCaFile } from './config.js';
import { firmwareDir, resolveLaunchTarget } from './firmware.js';
import { DeviceHttp } from './http.js';
import { acquireLock, lockHolder } from './lock.js';
import { initLogger, log } from './logs.js';
import { Runtime, getCloudConfig, getPolicies, storageCapacity } from './state.js';
import { Store, deleteStoreFiles, type Identity } from './store.js';
import { refreshCloudConfig } from './sync.js';
import { errMsg } from './util.js';

const USAGE = `bamp-device ${RUNNING_VERSION} — BAMP biometric attendance terminal agent

Usage:
  bamp-device activate --uid <DEVICE_UID> --code <ACTIVATION_CODE> [--api <https://host:port>] [--model <m>] [--serial <sn>] [--force]
  bamp-device run            start the terminal services (kiosk UI when attached to a console)
  bamp-device status         show identity, sync state, buffered events and storage
  bamp-device reset [--yes]  factory-reset the local store (asks for confirmation)
  bamp-device self-test      verify the installation (used by OTA before switching versions)
  bamp-device --version

Data directory: ${config.dataDir}`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Restrict the data directory (secret, MQTT password, templates) to SYSTEM, Administrators and the current user. */
/**
 * Restricts the data directory to SYSTEM, Administrators and the service account. Inheritance flags ((OI)(CI)) are only
 * valid on folders, so the folder is locked down first and its contents are then reset to inherit that ACL.
 */
function restrictWindowsAcl(dir: string) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  const args = [dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F'];
  if (user) args.push('/grant:r', `${user}:(OI)(CI)F`);
  args.push('/Q');
  const r = spawnSync('icacls', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.warn(`warning: could not restrict permissions on ${dir}: ${(r.stderr || r.stdout || '').trim()}`);
    return;
  }
  if (readdirSync(dir).length) {
    const c = spawnSync('icacls', [join(dir, '*'), '/reset', '/T', '/C', '/Q'], { encoding: 'utf8' });
    if (c.status !== 0) console.warn(`warning: could not reset permissions under ${dir}: ${(c.stderr || c.stdout || '').trim()}`);
  }
}

const activationSchema = z.object({
  deviceId: z.string(),
  organizationId: z.string(),
  secret: z.string().min(16),
  mqtt: z.object({ url: z.string(), username: z.string(), password: z.string(), caCertificate: z.string().min(20), topicPrefix: z.string() }),
  apiBaseUrl: z.string().optional()
});

async function cmdActivate(flags: Record<string, string | true>) {
  const uid = str(flags.uid) ?? config.deviceUid;
  const code = str(flags.code);
  const api = (str(flags.api) ?? config.apiUrl)?.replace(/\/+$/, '');
  if (!uid || !code || !api) {
    console.error('activate requires --uid (or BAMP_DEVICE_UID), --code and --api (or BAMP_API_URL)');
    return 64;
  }
  if (lockHolder(config.dataDir)) {
    console.error('Stop the running agent before activating.');
    return 1;
  }
  const store = new Store(config.dataDir);
  try {
    const existing = store.getIdentity();
    if (existing && !flags.force) {
      console.error(`This terminal is already activated as ${existing.deviceUid}. Use --force to re-activate (new credentials) or 'bamp-device reset' first.`);
      return 1;
    }
    if (existing && existing.deviceUid !== uid) {
      console.error(`This store belongs to ${existing.deviceUid}; run 'bamp-device reset' before activating as ${uid}.`);
      return 1;
    }
    const http = new DeviceHttp({ baseUrl: () => api, credentials: () => null, caPems: () => [readCaFile()].filter((x): x is string => !!x) });
    console.log(`Activating ${uid} against ${api} …`);
    const raw = await http.request('POST', '/device/v1/activate', {
      signed: false,
      retries: 2,
      body: {
        deviceUid: uid,
        activationCode: code.trim().toUpperCase(),
        model: (str(flags.model) ?? `BAMP-Agent ${process.platform}-${process.arch}`).slice(0, 64),
        serialNumber: (str(flags.serial) ?? hostname()).slice(0, 64),
        firmwareVersion: RUNNING_VERSION
      }
    });
    await http.close();
    const res = activationSchema.parse(raw);
    if (!/^mqtts:\/\//i.test(res.mqtt.url)) throw new Error(`Refusing non-TLS MQTT endpoint ${res.mqtt.url} (MQTT over TLS is mandatory)`);
    const identity: Identity = {
      deviceUid: uid,
      deviceId: res.deviceId,
      organizationId: res.organizationId,
      secret: res.secret,
      apiBaseUrl: api,
      serverPublicUrl: res.apiBaseUrl,
      mqtt: { url: res.mqtt.url, username: res.mqtt.username, password: res.mqtt.password, topicPrefix: res.mqtt.topicPrefix },
      caCertificate: res.mqtt.caCertificate,
      activatedAt: new Date().toISOString()
    };
    store.setIdentity(identity);
    writeFileSync(join(config.dataDir, 'mqtt-ca.pem'), res.mqtt.caCertificate, { mode: 0o600 });
    restrictWindowsAcl(config.dataDir);

    // Verify the signed channel works with the new credential.
    const signed = new DeviceHttp({
      baseUrl: () => api,
      credentials: () => ({ deviceUid: uid, secret: res.secret }),
      caPems: () => [res.mqtt.caCertificate, readCaFile()].filter((x): x is string => !!x)
    });
    try {
      const cfg = await refreshCloudConfig(store, signed, new Runtime());
      console.log(`✔ Activated: ${cfg.device.name} (${uid}) · location ${cfg.location?.name ?? 'none'} · state ${cfg.device.lifecycleState}`);
      if (cfg.device.lifecycleState !== 'active') console.log('  An administrator must now verify and activate the device in the dashboard (it needs one heartbeat: start the agent).');
    } catch (err) {
      console.log(`✔ Credentials stored, but the signed configuration check failed: ${errMsg(err)}`);
    } finally {
      await signed.close();
    }
    console.log(`  MQTT: ${res.mqtt.url}  topic prefix ${res.mqtt.topicPrefix}`);
    console.log('  Next: bamp-device run   (or start the service)');
    return 0;
  } catch (err) {
    console.error(`✖ Activation failed: ${errMsg(err)}`);
    return 1;
  } finally {
    store.close();
  }
}

function cmdStatus() {
  const store = new Store(config.dataDir);
  try {
    const id = store.getIdentity();
    const cloud = getCloudConfig(store);
    const counts = store.eventCounts();
    const capacity = storageCapacity(store);
    const fw = store.getFirmwareState();
    const running = lockHolder(config.dataDir);
    const lines: [string, string][] = [
      ['Agent', `${RUNNING_VERSION} (base ${BASE_VERSION} at ${BASE_ROOT})${running ? ` — running, pid ${running}` : ' — not running'}`],
      ['Data directory', config.dataDir],
      ['Device', id ? `${id.deviceUid} (${id.deviceId}) org ${id.organizationId}, activated ${id.activatedAt}` : 'NOT ACTIVATED'],
      ['API', config.apiUrl ?? id?.apiBaseUrl ?? '—'],
      ['MQTT', id ? `${id.mqtt.url} as ${id.mqtt.username}` : '—'],
      ['Name / location', cloud ? `${cloud.device.name} · ${cloud.location?.name ?? 'no location'} (${cloud.location?.timezone ?? 'system tz'})` : '—'],
      ['Lifecycle', cloud ? `${cloud.device.lifecycleState}${cloud.enrolmentAllowed ? ' (enrolment allowed)' : ''} as of ${cloud.fetchedAt ?? cloud.serverTime}` : '—'],
      ['Sensor driver', `${config.sensor.driver}${config.sensor.driver === 'serial' ? ` ${config.sensor.port} @ ${config.sensor.baud}` : ' (bench — not for production)'}`],
      ['Roster', `v${store.get<number>('rosterVersion') ?? 0}, ${store.employeeCount()} employees, ${store.listSupervisors().length} supervisors`],
      ['Templates', `v${store.get<number>('templateVersion') ?? 0}, ${store.templateCount()} stored, ${store.slottedTemplateCount()} loaded in sensor`],
      ['Last sync', store.get<string>('lastSyncAt') ?? 'never'],
      ['Events', `${counts.pending} pending, ${counts.sent} awaiting ack, ${counts.rejected} rejected, ${counts.delivered} delivered`],
      ['Storage', `${store.storageUsedPct(capacity)}% of ${capacity} events (policy ${getPolicies(store).storageFullPolicy})`],
      ['Firmware', `active ${fw.activeVersion ?? `base ${BASE_VERSION}`}, previous ${fw.previousVersion ?? '—'}${fw.pending ? `, pending ${fw.pending.kind} → ${fw.pending.version}` : ''}${fw.outbox.length ? `, ${fw.outbox.length} report(s) queued` : ''}`]
    ];
    const w = Math.max(...lines.map(([k]) => k.length));
    for (const [k, v] of lines) console.log(`${k.padEnd(w)}  ${v}`);
    const rejected = store.db.prepare(`SELECT event_uid, last_error FROM attendance_buffer WHERE status='rejected' ORDER BY captured_at DESC LIMIT 5`).all() as {
      event_uid: string;
      last_error: string | null;
    }[];
    for (const r of rejected) console.log(`  rejected ${r.event_uid}: ${r.last_error ?? ''}`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdReset(flags: Record<string, string | true>) {
  const running = lockHolder(config.dataDir);
  if (running) {
    console.error(`The agent is running (pid ${running}). Stop the service first.`);
    return 1;
  }
  if (!existsSync(join(config.dataDir, 'device.db'))) {
    console.log('Nothing to reset.');
    return 0;
  }
  const store = new Store(config.dataDir);
  const id = store.getIdentity();
  const undelivered = store.undeliveredCount() + store.eventCounts().rejected;
  store.close();
  const token = id?.deviceUid ?? 'RESET';
  if (!flags.yes) {
    console.log(`Factory reset erases the credentials, roster, templates and attendance buffer in ${config.dataDir}.`);
    const a = await prompt(`Type ${token} to confirm: `);
    if (a !== token) {
      console.log('Cancelled.');
      return 1;
    }
  }
  if (undelivered > 0) {
    console.log(`\x07WARNING: ${undelivered} attendance event(s) have NOT been delivered to the platform and will be LOST.`);
    const a = flags['discard-undelivered'] ? 'DISCARD' : await prompt('Type DISCARD to erase them anyway, anything else to cancel: ');
    if (a !== 'DISCARD') {
      console.log('Cancelled. Connect the terminal so buffered events upload, then retry.');
      return 1;
    }
  }
  deleteStoreFiles(config.dataDir);
  for (const f of ['mqtt-ca.pem', 'bench-sensor.key', 'agent.lock']) rmSync(join(config.dataDir, f), { force: true });
  rmSync(firmwareDir(config.dataDir), { recursive: true, force: true });
  console.log('✔ Local store reset. Activate again with: bamp-device activate --uid <UID> --code <CODE>');
  return 0;
}

async function cmdSelfTest() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const one = (db.prepare('SELECT 1 AS x').get() as { x: number }).x;
  db.close();
  const h = await argonHash('self-test', { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  const ok = one === 1 && (await argonVerify(h, 'self-test'));
  if (config.sensor.driver === 'serial') await import('serialport');
  console.log(`bamp-device ${RUNNING_VERSION} self-test ${ok ? 'OK' : 'FAILED'}`);
  return ok ? 0 : 1;
}

async function cmdRun() {
  // Re-assert the data directory ACL on every start (also repairs installations activated by older agent versions).
  if (existsSync(config.dataDir) && process.env.BAMP_FIRMWARE_CHILD !== '1') restrictWindowsAcl(config.dataDir);
  initLogger(config.dataDir, config.logLevel, config.headless);
  const isChild = process.env.BAMP_FIRMWARE_CHILD === '1';
  let release: () => void = () => undefined;
  if (!isChild) {
    try {
      release = acquireLock(config.dataDir);
    } catch (err) {
      console.error(errMsg(err));
      return 1;
    }
  }
  const store = new Store(config.dataDir);
  const target = resolveLaunchTarget(store);
  if (target) {
    // OTA launcher: run the staged firmware version as a child; propagate its exit code to the service manager.
    store.close();
    log.info({ version: target.version, entry: target.entry }, 'launching staged firmware');
    const child = spawn(process.execPath, [target.entry, 'run'], {
      stdio: 'inherit',
      env: { ...process.env, BAMP_FIRMWARE_CHILD: '1', BAMP_FIRMWARE_VERSION: target.version, BAMP_BASE_ROOT: BASE_ROOT }
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
    const code = await new Promise<number>((resolve) => child.on('exit', (c, s) => resolve(c ?? (s ? 1 : 0))));
    release();
    return code;
  }
  const code = await runAgent(store);
  store.close();
  release();
  return code;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  switch (cmd) {
    case 'activate':
      return cmdActivate(flags);
    case 'run':
      return cmdRun();
    case 'status':
      return cmdStatus();
    case 'reset':
      return cmdReset(flags);
    case 'self-test':
      return cmdSelfTest();
    case '--version':
    case '-v':
    case 'version':
      console.log(RUNNING_VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 64;
  }
}

main().then(
  (code) => {
    // Give asynchronous log destinations a moment to flush before exiting.
    setTimeout(() => process.exit(code), 200);
  },
  (err) => {
    console.error(errMsg(err));
    setTimeout(() => process.exit(1), 200);
  }
);
