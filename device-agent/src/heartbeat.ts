import { networkInterfaces } from 'node:os';
import { RUNNING_VERSION } from './config.js';
import type { DeviceHttp } from './http.js';
import { log } from './logs.js';
import type { MqttLink } from './mqttLink.js';
import { getPolicies, storageCapacity, storagePolicy, type Runtime } from './state.js';
import type { Store } from './store.js';
import { errMsg, every } from './util.js';

/** Heartbeat (device health) every `heartbeatIntervalSeconds`: MQTT, falling back to HTTPS when MQTT is down. */

export interface HeartbeatPayload {
  firmwareVersion: string;
  rosterVersion: number;
  templateVersion: number;
  pendingEvents: number;
  storageUsedPct: number;
  storageCapacityEvents: number;
  uptimeSeconds: number;
  ip?: string;
  reconciling: boolean;
  enrolledTemplates: number;
  storagePolicy: string;
}

export function primaryIp(): string | undefined {
  for (const ifs of Object.values(networkInterfaces())) for (const i of ifs ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  for (const ifs of Object.values(networkInterfaces())) for (const i of ifs ?? []) if (i.family === 'IPv6' && !i.internal && !i.address.startsWith('fe80')) return i.address;
  return undefined;
}

export class Heartbeat {
  private loop: ReturnType<typeof every> | null = null;
  private lastAlarmAt = 0;

  constructor(
    private store: Store,
    private http: DeviceHttp,
    private mqtt: () => MqttLink | null,
    private runtime: Runtime
  ) {}

  start() {
    this.loop = every(() => getPolicies(this.store).heartbeatIntervalSeconds * 1000, () => this.send(), {
      immediate: true,
      onError: (err) => log.debug({ err: errMsg(err) }, 'heartbeat failed')
    });
    this.runtime.on('config', () => this.loop?.reschedule());
  }

  stop() {
    this.loop?.stop();
  }

  payload(): HeartbeatPayload {
    const capacity = storageCapacity(this.store);
    return {
      firmwareVersion: RUNNING_VERSION,
      rosterVersion: this.store.get<number>('rosterVersion') ?? 0,
      templateVersion: this.store.get<number>('templateVersion') ?? 0,
      pendingEvents: this.store.undeliveredCount(),
      storageUsedPct: this.store.storageUsedPct(capacity),
      storageCapacityEvents: capacity,
      uptimeSeconds: Math.round(process.uptime()),
      ip: primaryIp(),
      reconciling: this.runtime.reconciling,
      enrolledTemplates: this.store.templateCount(),
      storagePolicy: storagePolicy(this.store)
    };
  }

  /** Evaluate the storage alarm (FR-4.3) and notify the terminal UI loudly. */
  checkStorage(p: HeartbeatPayload = this.payload()) {
    const pol = getPolicies(this.store);
    const level = p.storageUsedPct >= pol.storageCriticalPct ? 'critical' : p.storageUsedPct >= pol.storageWarningPct ? 'warning' : 'ok';
    const changed = level !== this.runtime.storageLevel;
    this.runtime.storageLevel = level;
    if (level !== 'ok' && (changed || Date.now() - this.lastAlarmAt > 5 * 60_000)) {
      this.lastAlarmAt = Date.now();
      const msg = `STORAGE ${level.toUpperCase()}: ${p.storageUsedPct}% of ${p.storageCapacityEvents} events used, ${p.pendingEvents} awaiting upload (policy ${p.storagePolicy})`;
      if (level === 'critical') log.error({ ...p }, msg);
      else log.warn({ ...p }, msg);
      this.runtime.emit('storage-alarm', { level, message: msg });
    } else if (changed) {
      log.info({ storageUsedPct: p.storageUsedPct }, 'storage back below warning threshold');
      this.runtime.emit('status');
    }
  }

  async send() {
    const p = this.payload();
    this.checkStorage(p);
    const link = this.mqtt();
    if (link?.connected) {
      try {
        await link.publish('heartbeat', p, { qos: 1 });
        return;
      } catch (err) {
        log.debug({ err: errMsg(err) }, 'MQTT heartbeat failed; trying HTTPS');
      }
    }
    await this.http.request('POST', '/device/v1/heartbeat', { body: p, retries: 0, timeoutMs: 10_000 });
  }
}
