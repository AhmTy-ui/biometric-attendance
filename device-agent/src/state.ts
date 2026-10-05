import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { config } from './config.js';
import type { Store, StorageFullPolicy } from './store.js';
import { isValidTimeZone } from './time.js';

/** Mirror of the platform's `device_policies` settings section (backend/src/services/settings.ts). */
export const policiesSchema = z.object({
  heartbeatIntervalSeconds: z.number().int().min(10).max(600),
  offlineAfterMissedHeartbeats: z.number().int().min(2).max(20),
  storageWarningPct: z.number().min(50).max(99),
  storageCriticalPct: z.number().min(50).max(100),
  storageFullPolicy: z.enum(['continue_capturing_alert', 'preserve_oldest']),
  minMatchScore: z.number().int().min(1).max(100),
  minEnrolQuality: z.number().int().min(1).max(100),
  fingersPerEmployee: z.number().int().min(1).max(10),
  uploadBatchSize: z.number().int().min(10).max(5000),
  duplicatePunchWindowSeconds: z.number().int().min(0).max(3600)
});
export type Policies = z.infer<typeof policiesSchema>;

export const defaultPolicies: Policies = {
  heartbeatIntervalSeconds: 30,
  offlineAfterMissedHeartbeats: 3,
  storageWarningPct: 80,
  storageCriticalPct: 95,
  storageFullPolicy: 'continue_capturing_alert',
  minMatchScore: 60,
  minEnrolQuality: 50,
  fingersPerEmployee: 2,
  uploadBatchSize: 200,
  duplicatePunchWindowSeconds: 60
};

/** Device-specific settings carried in `devices.config` (dashboard → device → config, delivered by send_config). */
export const deviceConfigSchema = z
  .object({
    storageCapacityEvents: z.number().int().min(1000).max(50_000_000).optional(),
    defaultDirectionMode: z.enum(['in', 'out', 'auto']).optional(),
    identifyTimeoutSeconds: z.number().int().min(2).max(60).optional(),
    timezone: z.string().optional(),
    deliveredRetentionDays: z.number().int().min(1).max(365).optional()
  })
  .passthrough();
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

export interface CloudConfig {
  device: { id: string; uid: string; name: string; lifecycleState: string; config: Record<string, unknown> | null };
  location: { id: string; name: string; code: string | null; timezone: string | null; work_start?: string | null; work_end?: string | null } | null;
  policies: Partial<Policies>;
  enrolmentAllowed: boolean;
  serverTime: string;
  fetchedAt?: string;
}

export const DEFAULT_CAPACITY = 200_000;

/** Merge a (partial, possibly foreign) policies object into the stored policies; invalid fields are ignored. */
export function applyPolicies(store: Store, incoming: unknown): Policies {
  const current = getPolicies(store);
  const next: Record<string, unknown> = { ...current };
  if (incoming && typeof incoming === 'object') {
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      const field = (policiesSchema.shape as Record<string, z.ZodTypeAny>)[k];
      if (field && field.safeParse(v).success) next[k] = v;
    }
  }
  const parsed = policiesSchema.parse(next);
  store.set('policies', parsed);
  return parsed;
}

export function getPolicies(store: Store): Policies {
  const stored = store.get<Partial<Policies>>('policies') ?? {};
  const merged = { ...defaultPolicies, ...stored };
  const r = policiesSchema.safeParse(merged);
  return r.success ? r.data : defaultPolicies;
}

export function applyDeviceConfig(store: Store, incoming: unknown): DeviceConfig {
  const r = deviceConfigSchema.safeParse(incoming ?? {});
  const cfg = r.success ? r.data : {};
  store.set('deviceConfig', cfg);
  return cfg;
}

export function getDeviceConfig(store: Store): DeviceConfig {
  return store.get<DeviceConfig>('deviceConfig') ?? {};
}

export function getCloudConfig(store: Store): CloudConfig | null {
  return store.get<CloudConfig>('cloudConfig') ?? null;
}

export function storageCapacity(store: Store): number {
  return config.storageCapacityOverride ?? getDeviceConfig(store).storageCapacityEvents ?? store.get<number>('storageCapacityEvents') ?? DEFAULT_CAPACITY;
}

export function storagePolicy(store: Store): StorageFullPolicy {
  return getPolicies(store).storageFullPolicy;
}

/** Local time zone for timestamps and "today": env override → device config → location → system. */
export function deviceTimeZone(store: Store): string | undefined {
  const candidates = [config.timezone, getDeviceConfig(store).timezone, getCloudConfig(store)?.location?.timezone];
  for (const c of candidates) if (isValidTimeZone(c)) return c;
  return undefined;
}

export type LinkState = 'up' | 'down' | 'unknown';

/** Shared runtime status for the kiosk UI, heartbeat and services. */
export class Runtime extends EventEmitter {
  mqtt: LinkState = 'unknown';
  https: LinkState = 'unknown';
  reconciling = false;
  busy = false; // enrolment / firmware installation in progress — pauses automatic scanning
  sensorReady = false;
  storageLevel: 'ok' | 'warning' | 'critical' = 'ok';
  readonly startedAt = Date.now();
  shuttingDown = false;

  setMqtt(s: LinkState) {
    if (this.mqtt !== s) {
      this.mqtt = s;
      this.emit('status');
    }
  }

  setHttps(s: LinkState) {
    if (this.https !== s) {
      this.https = s;
      this.emit('status');
    }
  }

  get online() {
    return this.mqtt === 'up' || this.https === 'up';
  }
}
