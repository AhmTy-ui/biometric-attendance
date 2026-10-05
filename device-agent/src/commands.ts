import { z } from 'zod';
import type { FirmwareManager } from './firmware.js';
import type { Heartbeat } from './heartbeat.js';
import type { DeviceHttp } from './http.js';
import { log } from './logs.js';
import type { MqttLink } from './mqttLink.js';
import { applyDeviceConfig, applyPolicies, getDeviceConfig, getPolicies, type Runtime } from './state.js';
import type { Store } from './store.js';
import { refreshCloudConfig, type SyncService } from './sync.js';
import { errMsg, sleep } from './util.js';

/**
 * Remote commands (`commands` topic, QoS 1). Every command is acknowledged on `commands/ack`:
 * acknowledged → completed | failed. Results are remembered so a broker redelivery is re-acknowledged, not re-run.
 */

export const RESTART_EXIT_CODE = 75;

const commandSchema = z.object({
  commandId: z.string().min(1),
  command: z.string().min(1),
  payload: z.record(z.unknown()).nullable().optional()
});

type AckStatus = 'acknowledged' | 'completed' | 'failed';

interface Remembered {
  id: string;
  status: AckStatus;
  result: unknown;
}

export class CommandHandler {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private store: Store,
    private http: DeviceHttp,
    private mqtt: () => MqttLink | null,
    private runtime: Runtime,
    private sync: SyncService,
    private heartbeat: Heartbeat,
    private firmware: FirmwareManager,
    private requestExit: (code: number, reason: string) => Promise<void>
  ) {}

  /** Commands run one at a time, in arrival order. */
  enqueue(raw: unknown) {
    this.chain = this.chain.then(() => this.handle(raw)).catch((err) => log.error({ err: errMsg(err) }, 'command handling failed'));
  }

  private async ack(commandId: string, status: AckStatus, result?: unknown) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const link = this.mqtt();
      if (link?.connected) {
        try {
          await link.publish('commands/ack', { commandId, status, result: result ?? null }, { qos: 1 });
          return;
        } catch (err) {
          log.debug({ err: errMsg(err), commandId }, 'command ack publish failed');
        }
      }
      await sleep(2000);
    }
    log.warn({ commandId, status }, 'could not acknowledge command (MQTT unavailable)');
  }

  private remembered(id: string): Remembered | undefined {
    return (this.store.get<Remembered[]>('commandResults') ?? []).find((r) => r.id === id);
  }

  private remember(r: Remembered) {
    const list = (this.store.get<Remembered[]>('commandResults') ?? []).filter((x) => x.id !== r.id);
    list.push(r);
    this.store.set('commandResults', list.slice(-100));
  }

  private async handle(raw: unknown) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'ignoring malformed command');
      return;
    }
    const { commandId, command } = parsed.data;
    const payload = parsed.data.payload ?? {};
    const seen = this.remembered(commandId);
    if (seen) {
      log.info({ commandId, command, status: seen.status }, 'duplicate command delivery; re-acknowledging');
      if (seen.status !== 'acknowledged') await this.ack(commandId, seen.status, seen.result);
      return;
    }
    log.info({ commandId, command, payload }, 'command received');
    this.remember({ id: commandId, status: 'acknowledged', result: null });
    await this.ack(commandId, 'acknowledged');

    let status: AckStatus = 'completed';
    let result: unknown = null;
    let exitAfter = false;
    try {
      switch (command) {
        case 'sync_roster': {
          await this.sync.trigger('command', payload.full === true);
          if (this.sync.lastError) {
            status = 'failed';
            result = { error: this.sync.lastError };
          } else {
            result = {
              rosterVersion: this.store.get<number>('rosterVersion') ?? 0,
              templateVersion: this.store.get<number>('templateVersion') ?? 0,
              employees: this.store.employeeCount(),
              templates: this.store.templateCount()
            };
          }
          break;
        }
        case 'refresh_status': {
          await this.heartbeat.send();
          result = this.heartbeat.payload();
          break;
        }
        case 'send_config': {
          let refreshed = false;
          if (payload.policies !== undefined) applyPolicies(this.store, payload.policies);
          if (payload.config !== undefined) applyDeviceConfig(this.store, payload.config);
          // Activation notice ({reason:'activated'}) or a partial payload: pull the authoritative configuration.
          try {
            await refreshCloudConfig(this.store, this.http, this.runtime);
            refreshed = true;
          } catch (err) {
            if (payload.policies === undefined && payload.config === undefined) throw err;
            log.warn({ err: errMsg(err) }, 'config refresh after send_config failed; applied the pushed values');
          }
          this.runtime.emit('config');
          await this.heartbeat.send().catch(() => undefined);
          result = { applied: true, refreshedFromPlatform: refreshed, policies: getPolicies(this.store), config: getDeviceConfig(this.store) };
          break;
        }
        case 'restart': {
          result = { restarting: true };
          exitAfter = true;
          break;
        }
        case 'update_firmware':
        case 'rollback_firmware': {
          const fw = this.firmware.parsePayload(payload);
          const outcome = command === 'update_firmware' ? await this.firmware.update(fw, commandId) : await this.firmware.rollback(fw, commandId);
          status = outcome.ok ? 'completed' : 'failed';
          result = outcome.result;
          exitAfter = outcome.restart;
          break;
        }
        default:
          status = 'failed';
          result = { error: `Unsupported command: ${command}` };
      }
    } catch (err) {
      status = 'failed';
      result = { error: errMsg(err) };
      log.error({ commandId, command, err: errMsg(err) }, 'command failed');
    }
    this.remember({ id: commandId, status, result });
    await this.ack(commandId, status, result);
    log.info({ commandId, command, status }, 'command finished');
    if (exitAfter) await this.requestExit(RESTART_EXIT_CODE, `${command} (${commandId})`);
  }
}
