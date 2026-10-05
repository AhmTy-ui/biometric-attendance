import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { rename, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { BASE_ROOT, BASE_VERSION, PACKAGE_ROOT, RUNNING_VERSION } from './config.js';
import type { DeviceHttp } from './http.js';
import { log } from './logs.js';
import type { MqttLink } from './mqttLink.js';
import type { Runtime } from './state.js';
import type { FirmwareReport, FirmwareState, PendingFirmware, Store } from './store.js';
import { extractTarGz } from './tar.js';
import { errMsg } from './util.js';

/**
 * Over-the-air updates (firmware = a packaged build of this agent, e.g. the output of `npm pack`).
 *
 *   downloading → (sha256 verified) → installing (staged under DATA_DIR/firmware/<version>/, previous kept)
 *   → restarting (exit 75, the service manager restarts; the launcher starts the staged version)
 *   → verified (reported by the new version once healthy)
 *
 * A checksum mismatch or install failure reports `failed` and the device keeps running the current version.
 * A staged version that fails to start 3 times is rolled back automatically by the launcher.
 */

const payloadSchema = z.object({
  targetId: z.string().uuid(),
  version: z.string().min(1).max(40),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  sizeBytes: z.coerce.number().int().nonnegative().optional()
});
export type FirmwarePayload = z.infer<typeof payloadSchema>;

export interface FirmwareOutcome {
  ok: boolean;
  restart: boolean;
  result: Record<string, unknown>;
}

const MAX_BOOT_ATTEMPTS = 3;
const safeDirName = (v: string) => v.replace(/[^0-9A-Za-z.+-]/g, '_');

export function firmwareDir(dataDir: string) {
  return join(dataDir, 'firmware');
}

/**
 * Launcher (runs in the base installation started by the service manager): decides which firmware to execute.
 * Returns the entry point of a staged version to spawn, or null to run the current package in-process.
 */
export function resolveLaunchTarget(store: Store): { entry: string; version: string } | null {
  if (process.env.BAMP_FIRMWARE_CHILD === '1') return null;
  let st = store.getFirmwareState();
  if (st.pending?.kind === 'update' && st.activeVersion === st.pending.version) {
    const attempts = st.pending.bootAttempts + 1;
    if (attempts > MAX_BOOT_ATTEMPTS) {
      const failed = st.activeVersion;
      const prevLabel = st.previousVersion ?? BASE_VERSION;
      log.error({ failed, rollbackTo: prevLabel }, 'staged firmware failed to start repeatedly; rolling back');
      st = {
        ...st,
        activeVersion: st.previousPath ? st.previousVersion : null,
        activePath: st.previousPath,
        previousVersion: failed,
        previousPath: st.activePath,
        pending: { ...st.pending, kind: 'auto_rollback', error: `Firmware ${failed} failed to start ${MAX_BOOT_ATTEMPTS} times; rolled back to ${prevLabel}` }
      };
    } else {
      st = { ...st, pending: { ...st.pending, bootAttempts: attempts } };
    }
    store.setFirmwareState(st);
  }
  if (!st.activePath || !st.activeVersion) return null;
  if (resolve(st.activePath) === PACKAGE_ROOT) return null;
  const entry = join(st.activePath, 'dist', 'cli.js');
  if (!existsSync(entry)) {
    log.error({ activePath: st.activePath }, 'staged firmware missing; running the base installation');
    store.setFirmwareState({ activeVersion: null, activePath: null });
    return null;
  }
  return { entry, version: st.activeVersion };
}

export class FirmwareManager {
  private pendingVerification: PendingFirmware | null = null;

  constructor(
    private store: Store,
    private http: DeviceHttp,
    private mqtt: () => MqttLink | null,
    private runtime: Runtime,
    private dataDir: string
  ) {}

  // ───────────── state reports (MQTT `firmware` topic; persisted outbox survives restarts) ─────────────
  async report(r: FirmwareReport) {
    const st = this.store.getFirmwareState();
    this.store.setFirmwareState({ outbox: [...st.outbox, { ...r, error: r.error?.slice(0, 1000) }] });
    log.info({ ...r }, `firmware ${r.state}`);
    await this.flush();
  }

  async flush() {
    const link = this.mqtt();
    if (!link?.connected) return;
    for (;;) {
      const outbox = this.store.getFirmwareState().outbox;
      if (!outbox.length) return;
      try {
        await link.publish('firmware', outbox[0], { qos: 1 });
      } catch (err) {
        log.debug({ err: errMsg(err) }, 'firmware report deferred');
        return;
      }
      this.store.setFirmwareState({ outbox: this.store.getFirmwareState().outbox.slice(1) });
    }
  }

  /** After (re)start: resolve what the previous run left pending. */
  onStartup() {
    const st = this.store.getFirmwareState();
    const p = st.pending;
    if (!p) return;
    if (p.kind === 'update') {
      if (RUNNING_VERSION === p.version) {
        this.pendingVerification = p; // confirmed once the agent is healthy (see confirmHealthy)
        return;
      }
      const patch: Partial<FirmwareState> = { pending: null };
      if (st.activeVersion === p.version) Object.assign(patch, { activeVersion: st.previousPath ? st.previousVersion : null, activePath: st.previousPath });
      this.store.setFirmwareState(patch);
      void this.report({ targetId: p.targetId, state: 'failed', version: RUNNING_VERSION, error: `Device restarted on ${RUNNING_VERSION} instead of ${p.version}` });
      return;
    }
    this.store.setFirmwareState({ pending: null });
    void this.report({ targetId: p.targetId, state: 'rolled_back', version: RUNNING_VERSION, error: p.kind === 'auto_rollback' ? p.error : undefined });
  }

  /** Called once the agent has proven healthy (store open, platform reachable). */
  confirmHealthy() {
    const p = this.pendingVerification;
    if (!p) return;
    this.pendingVerification = null;
    this.store.setFirmwareState({ pending: null });
    void this.report({ targetId: p.targetId, state: 'verified', version: RUNNING_VERSION });
  }

  parsePayload(payload: unknown): FirmwarePayload {
    return payloadSchema.parse(payload);
  }

  async update(payload: FirmwarePayload, commandId: string | null): Promise<FirmwareOutcome> {
    if (payload.version === RUNNING_VERSION) {
      await this.report({ targetId: payload.targetId, state: 'verified', version: RUNNING_VERSION });
      return { ok: true, restart: false, result: { message: `Version ${RUNNING_VERSION} is already running` } };
    }
    return this.install(payload, commandId, 'update');
  }

  async rollback(payload: FirmwarePayload, commandId: string | null): Promise<FirmwareOutcome> {
    const st = this.store.getFirmwareState();
    if (payload.version === RUNNING_VERSION) {
      await this.report({ targetId: payload.targetId, state: 'rolled_back', version: RUNNING_VERSION });
      return { ok: true, restart: false, result: { message: `Already running ${RUNNING_VERSION}` } };
    }
    const toBase = payload.version === BASE_VERSION && !!st.activePath;
    const toPrevious = st.previousVersion === payload.version && (st.previousPath === null || existsSync(join(st.previousPath, 'dist', 'cli.js')));
    if (toPrevious || toBase) {
      await this.report({ targetId: payload.targetId, state: 'installing', version: payload.version });
      const targetPath = toPrevious ? st.previousPath : null;
      this.store.setFirmwareState({
        activeVersion: targetPath ? payload.version : null,
        activePath: targetPath,
        previousVersion: RUNNING_VERSION,
        previousPath: st.activePath,
        pending: { kind: 'rollback', targetId: payload.targetId, commandId, version: payload.version, fromVersion: RUNNING_VERSION, bootAttempts: 0 }
      });
      await this.report({ targetId: payload.targetId, state: 'restarting', version: payload.version });
      return { ok: true, restart: true, result: { rollbackTo: payload.version, source: 'retained-local-copy' } };
    }
    // No retained copy: download the artefact for this target and install it as a rollback.
    return this.install(payload, commandId, 'rollback');
  }

  private async install(p: FirmwarePayload, commandId: string | null, kind: 'update' | 'rollback'): Promise<FirmwareOutcome> {
    if (this.runtime.busy) return { ok: false, restart: false, result: { error: 'Device busy (enrolment in progress); retry later' } };
    this.runtime.busy = true;
    const dir = firmwareDir(this.dataDir);
    const dlDir = join(dir, '.download');
    const file = join(dlDir, `${p.targetId}.pkg`);
    const staging = join(dir, `.staging-${safeDirName(p.version)}-${Date.now()}`);
    const fail = async (error: string): Promise<FirmwareOutcome> => {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await rm(file, { force: true }).catch(() => undefined);
      await this.report({ targetId: p.targetId, state: 'failed', version: RUNNING_VERSION, error });
      log.error({ targetId: p.targetId, version: p.version, error }, `firmware ${kind} failed; continuing on ${RUNNING_VERSION}`);
      return { ok: false, restart: false, result: { error, runningVersion: RUNNING_VERSION } };
    };
    try {
      mkdirSync(dlDir, { recursive: true });
      await this.report({ targetId: p.targetId, state: 'downloading', version: p.version });
      const fs = await statfs(dir).catch(() => null);
      if (fs && p.sizeBytes && Number(fs.bavail) * Number(fs.bsize) < p.sizeBytes * 4 + 50 * 1024 * 1024) {
        return await fail(`Insufficient disk space for ${p.sizeBytes} byte package`);
      }
      let dl: Awaited<ReturnType<DeviceHttp['download']>>;
      try {
        dl = await this.http.download(`/device/v1/firmware/${p.targetId}/blob`, file);
      } catch (err) {
        return await fail(`Download failed: ${errMsg(err)}`);
      }
      const expected = p.sha256.toLowerCase();
      if (dl.sha256 !== expected) {
        return await fail(`Checksum mismatch: expected ${expected}, downloaded ${dl.sha256} (${dl.size} bytes)${dl.headerSha256 ? `, server artefact ${dl.headerSha256}` : ''}`);
      }
      await this.report({ targetId: p.targetId, state: 'installing', version: p.version });
      try {
        await extractTarGz(file, staging);
      } catch (err) {
        return await fail(`Package could not be unpacked (expected a .tgz produced by npm pack): ${errMsg(err)}`);
      }
      const root = findPackageRoot(staging);
      if (!root) return await fail('Package does not contain package.json and dist/cli.js');
      if (!existsSync(join(root, 'node_modules'))) {
        const baseModules = join(BASE_ROOT, 'node_modules');
        if (!existsSync(baseModules)) return await fail('Package has no node_modules and the base installation has none to share');
        symlinkSync(baseModules, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      // Smoke test: the new build must load all its modules (incl. native ones) and pass its self test.
      const smoke = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'self-test'], {
        timeout: 30_000,
        encoding: 'utf8',
        env: { ...process.env, BAMP_FIRMWARE_CHILD: '1', BAMP_BASE_ROOT: BASE_ROOT, BAMP_FIRMWARE_VERSION: p.version }
      });
      if (smoke.status !== 0) return await fail(`New firmware failed its start-up self test: ${(smoke.stderr || smoke.error?.message || `exit ${smoke.status}`).slice(0, 500)}`);

      const finalDir = join(dir, safeDirName(p.version));
      if (resolve(finalDir) === PACKAGE_ROOT) return await fail(`Version ${p.version} is the running installation`);
      await rm(finalDir, { recursive: true, force: true });
      await rename(root, finalDir);
      await rm(staging, { recursive: true, force: true });
      await rm(file, { force: true });

      this.store.setFirmwareState({
        activeVersion: p.version,
        activePath: finalDir,
        previousVersion: RUNNING_VERSION,
        // null = the base installation
        previousPath: PACKAGE_ROOT === BASE_ROOT ? null : PACKAGE_ROOT,
        pending: { kind: kind === 'update' ? 'update' : 'rollback', targetId: p.targetId, commandId, version: p.version, fromVersion: RUNNING_VERSION, bootAttempts: 0 }
      });
      this.prune();
      await this.report({ targetId: p.targetId, state: 'restarting', version: p.version });
      return { ok: true, restart: true, result: { installed: p.version, previous: RUNNING_VERSION, sha256: expected } };
    } catch (err) {
      return await fail(`Installation error: ${errMsg(err)}`);
    } finally {
      this.runtime.busy = false;
    }
  }

  /** Keep only the active and previous versions (plus the working directories). */
  private prune() {
    const dir = firmwareDir(this.dataDir);
    const st = this.store.getFirmwareState();
    const keep = new Set([st.activePath, st.previousPath, PACKAGE_ROOT].filter((x): x is string => !!x).map((x) => resolve(x)));
    for (const name of readdirSync(dir)) {
      if (name === '.download' || name.startsWith('.staging-')) continue;
      const full = resolve(join(dir, name));
      if (!keep.has(full)) void rm(full, { recursive: true, force: true }).then(() => log.info({ removed: name }, 'pruned old firmware version'));
    }
  }
}

function findPackageRoot(staging: string): string | null {
  const ok = (d: string) => existsSync(join(d, 'package.json')) && existsSync(join(d, 'dist', 'cli.js'));
  if (ok(staging)) return staging;
  const entries = readdirSync(staging).filter((n) => statSync(join(staging, n)).isDirectory());
  for (const e of entries) if (ok(join(staging, e))) return join(staging, e);
  return null;
}
