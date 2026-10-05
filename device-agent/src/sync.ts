import { z } from 'zod';
import type { DeviceHttp } from './http.js';
import type { TemplateLibrary } from './library.js';
import { log } from './logs.js';
import { applyDeviceConfig, applyPolicies, type CloudConfig, type Runtime } from './state.js';
import type { Employee, Store, Supervisor } from './store.js';
import { observeServerTime } from './time.js';
import { errMsg, every, sha256Hex } from './util.js';

/**
 * Roster + supervisors + templates synchronisation (FR-4.1): the terminal keeps a complete local copy so it can
 * authenticate and record with no network dependency at capture time.
 *
 * Delta by version (`?since=`); `full:true` responses replace the local copy. Triggered on start, on the
 * `roster-changed` nudge, on the `sync_roster` command and every 10 minutes.
 */

const configSchema = z.object({
  device: z.object({
    id: z.string(),
    uid: z.string(),
    name: z.string(),
    lifecycleState: z.string(),
    config: z.record(z.unknown()).nullable().optional()
  }),
  location: z
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      work_start: z.string().nullable().optional(),
      work_end: z.string().nullable().optional()
    })
    .nullable(),
  policies: z.record(z.unknown()).nullable().optional(),
  enrolmentAllowed: z.boolean(),
  serverTime: z.string()
});

const rosterSchema = z.object({
  version: z.coerce.number(),
  full: z.boolean(),
  employees: z.array(z.object({ id: z.string(), staffNumber: z.string(), fullName: z.string(), department: z.string().nullable().optional() })),
  removed: z.array(z.string()),
  supervisors: z.array(
    z.object({ userId: z.string(), fullName: z.string(), role: z.string(), pinHash: z.string().nullable().optional(), employeeId: z.string().nullable().optional() })
  )
});

const templatesSchema = z.object({
  version: z.coerce.number(),
  full: z.boolean(),
  upserts: z.array(
    z.object({
      templateId: z.string(),
      employeeId: z.string(),
      fingerIndex: z.number().int().min(1).max(10),
      format: z.string(),
      quality: z.number().nullable().optional(),
      sha256: z.string(),
      data: z.string()
    })
  ),
  removals: z.array(z.object({ employeeId: z.string(), fingerIndex: z.number().int() }))
});

/** GET /device/v1/config → persist location, lifecycle, policies and device-specific config. */
export async function refreshCloudConfig(store: Store, http: DeviceHttp, runtime: Runtime): Promise<CloudConfig> {
  const raw = await http.request('GET', '/device/v1/config', { retries: 1 });
  const cfg = configSchema.parse(raw);
  observeServerTime(Date.parse(cfg.serverTime), 3000);
  const prev = store.get<CloudConfig>('cloudConfig');
  const value: CloudConfig = {
    device: { ...cfg.device, config: cfg.device.config ?? null },
    location: cfg.location ? { ...cfg.location, code: cfg.location.code ?? null, timezone: cfg.location.timezone ?? null } : null,
    policies: (cfg.policies ?? {}) as CloudConfig['policies'],
    enrolmentAllowed: cfg.enrolmentAllowed,
    serverTime: cfg.serverTime,
    fetchedAt: new Date().toISOString()
  };
  store.set('cloudConfig', value);
  applyPolicies(store, cfg.policies ?? {});
  applyDeviceConfig(store, cfg.device.config ?? {});
  if (prev?.device.lifecycleState !== value.device.lifecycleState) {
    log.info({ from: prev?.device.lifecycleState ?? null, to: value.device.lifecycleState }, 'device lifecycle state');
  }
  runtime.emit('config', value);
  return value;
}

export class SyncService {
  private inflight: Promise<void> | null = null;
  private rerun = false;
  private rerunFull = false;
  private loop: ReturnType<typeof every> | null = null;
  /** Error of the most recent sync run (null when it succeeded). */
  lastError: string | null = null;

  constructor(
    private store: Store,
    private http: DeviceHttp,
    private library: TemplateLibrary,
    private runtime: Runtime
  ) {}

  start() {
    this.loop = every(
      () => 10 * 60_000,
      () => this.trigger('periodic'),
      { onError: () => undefined }
    );
  }

  stop() {
    this.loop?.stop();
  }

  get running() {
    return this.inflight !== null;
  }

  /** Coalescing trigger: concurrent requests fold into one follow-up run. */
  trigger(reason: string, full = false): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      this.rerunFull ||= full;
      return this.inflight;
    }
    this.inflight = (async () => {
      let f = full;
      let why = reason;
      try {
        do {
          this.rerun = false;
          try {
            await this.runOnce(why, f);
            this.lastError = null;
          } catch (err) {
            this.lastError = errMsg(err);
            log.warn({ reason: why, err: this.lastError }, 'roster/template sync failed; will retry');
          }
          f = this.rerunFull;
          this.rerunFull = false;
          why = 'coalesced';
        } while (this.rerun);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Nudge from the platform: only sync when it announces newer versions than we hold. */
  onRosterChanged(payload: unknown) {
    const p = (payload ?? {}) as { rosterVersion?: number; templateVersion?: number };
    const rv = this.store.get<number>('rosterVersion') ?? 0;
    const tv = this.store.get<number>('templateVersion') ?? 0;
    if (typeof p.rosterVersion === 'number' && typeof p.templateVersion === 'number' && p.rosterVersion <= rv && p.templateVersion <= tv) return;
    void this.trigger('roster-changed');
  }

  private async runOnce(reason: string, forceFull: boolean) {
    const started = Date.now();
    const cfg = await refreshCloudConfig(this.store, this.http, this.runtime);
    const locationId = cfg.location?.id ?? null;
    const prevLocation = this.store.get<string | null>('syncLocationId');
    let full = forceFull;
    if (prevLocation !== undefined && prevLocation !== locationId) {
      log.warn({ from: prevLocation, to: locationId }, 'device location changed; full roster and template resync');
      full = true;
    }
    if (full) this.store.set('templatesNeedFull', true);

    // ── Roster + supervisors ──
    const rvLocal = full ? 0 : (this.store.get<number>('rosterVersion') ?? 0);
    const roster = rosterSchema.parse(await this.http.request('GET', `/device/v1/roster?since=${rvLocal}`));
    const incoming: Employee[] = roster.employees.map((e) => ({ id: e.id, staffNumber: e.staffNumber, fullName: e.fullName, department: e.department ?? null }));
    let removedIds: string[];
    if (roster.full) {
      const keep = new Set(incoming.map((e) => e.id));
      removedIds = (this.store.db.prepare('SELECT id FROM employees').all() as { id: string }[]).map((r) => r.id).filter((id) => !keep.has(id));
      this.store.replaceEmployees(incoming);
      if (rvLocal > 0) this.store.set('templatesNeedFull', true); // server could not serve a delta
    } else {
      this.store.upsertEmployees(incoming);
      this.store.removeEmployees(roster.removed);
      removedIds = roster.removed;
    }
    const supervisors: Supervisor[] = roster.supervisors
      .map((s) => ({ userId: s.userId, fullName: s.fullName, role: s.role, pinHash: s.pinHash ?? null, employeeId: s.employeeId ?? null }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
    const supHash = sha256Hex(JSON.stringify(supervisors));
    if (supHash !== this.store.get<string>('supervisorsHash')) {
      this.store.replaceSupervisors(supervisors);
      this.store.set('supervisorsHash', supHash);
      this.store.set('templatesNeedFull', true); // supervisor fingerprints only arrive in a full template sync
      log.info({ supervisors: supervisors.length }, 'supervisor list updated');
    }
    const supervisorEmployees = this.store.supervisorEmployeeIds();
    let templatesRemoved = 0;
    for (const id of removedIds) if (!supervisorEmployees.has(id)) templatesRemoved += await this.library.removeEmployee(id);
    this.store.set('rosterVersion', roster.version);
    this.store.set('syncLocationId', locationId);

    // ── Templates ──
    const templatesFull = this.store.get<boolean>('templatesNeedFull') === true || (this.store.get<number>('templateVersion') ?? 0) === 0;
    const tvLocal = templatesFull ? 0 : (this.store.get<number>('templateVersion') ?? 0);
    const tpl = templatesSchema.parse(await this.http.request('GET', `/device/v1/templates?since=${tvLocal}`, { timeoutMs: 60_000 }));
    let stored = 0;
    let unchanged = 0;
    let skipped = 0;
    if (tpl.full) {
      const keep = new Set(tpl.upserts.map((u) => `${u.employeeId}:${u.fingerIndex}`));
      for (const k of this.store.templateKeys()) {
        if (!keep.has(`${k.employeeId}:${k.fingerIndex}`) && (await this.library.remove(k.employeeId, k.fingerIndex))) templatesRemoved++;
      }
    }
    for (const r of tpl.removals) if (await this.library.remove(r.employeeId, r.fingerIndex)) templatesRemoved++;
    for (const u of tpl.upserts) {
      const blob = Buffer.from(u.data, 'base64');
      if (sha256Hex(blob) !== u.sha256.toLowerCase()) {
        log.error({ templateId: u.templateId, employeeId: u.employeeId }, 'template checksum mismatch; skipped');
        skipped++;
        continue;
      }
      try {
        const outcome = await this.library.put({
          employeeId: u.employeeId,
          fingerIndex: u.fingerIndex,
          templateId: u.templateId,
          format: u.format,
          quality: Math.round(u.quality ?? 0),
          sha256: u.sha256.toLowerCase(),
          blob
        });
        if (outcome === 'unchanged') unchanged++;
        else if (outcome === 'stored' || outcome === 'deferred') stored++;
        else skipped++;
      } catch (err) {
        skipped++;
        log.error({ err: errMsg(err), employeeId: u.employeeId, finger: u.fingerIndex }, 'failed to store template');
      }
    }
    this.store.set('templateVersion', tpl.version);
    this.store.set('templatesNeedFull', false);
    this.store.set('lastSyncAt', new Date().toISOString());
    await this.library.reconcile().catch((err) => log.warn({ err: errMsg(err) }, 'sensor library reconcile failed'));
    log.info(
      {
        reason,
        rosterVersion: roster.version,
        rosterFull: roster.full,
        employees: this.store.employeeCount(),
        templateVersion: tpl.version,
        templatesFull: tpl.full,
        stored,
        unchanged,
        removed: templatesRemoved,
        skipped,
        ms: Date.now() - started
      },
      'roster/template sync complete'
    );
    this.runtime.emit('synced');
  }
}
