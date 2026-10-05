import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { log } from './logs.js';
import type { Runtime } from './state.js';
import { errMsg } from './util.js';

/**
 * Real-time channel: MQTT over TLS (8883) with server certificate validation against the CA delivered at
 * activation (NFR-1.2), authenticated with the device's own credentials (NFR-1.3).
 *
 *   {prefix}/presence        → retained; LWT {"state":"offline"}, {"state":"online"} on connect
 *   {prefix}/heartbeat       → device health
 *   {prefix}/attendance      → single event on capture (QoS 1)
 *   {prefix}/enrolment       → enrolment session progress
 *   {prefix}/firmware        → OTA state reports
 *   {prefix}/commands/ack    → command acknowledgements
 *   {prefix}/commands        ← remote commands (QoS 1)
 *   {prefix}/roster-changed  ← nudge to pull roster/templates over HTTPS
 *   {prefix}/attendance/ack  ← platform acknowledgement of a single event
 */

export type OutboundKind = 'presence' | 'heartbeat' | 'attendance' | 'enrolment' | 'firmware' | 'commands/ack';

export interface MqttSettings {
  url: string;
  username: string;
  password: string;
  ca: string;
  topicPrefix: string;
  clientId: string;
}

export interface MqttLinkEvents {
  connect: [];
  disconnect: [];
  command: [unknown];
  'roster-changed': [unknown];
  'attendance-ack': [unknown];
}

export class MqttLink extends EventEmitter<MqttLinkEvents> {
  private client: MqttClient | null = null;
  private _connected = false;
  private lastError = '';

  constructor(
    private settings: MqttSettings,
    private runtime: Runtime
  ) {
    super();
  }

  get connected() {
    return this._connected;
  }

  topic(kind: string) {
    return `${this.settings.topicPrefix}/${kind}`;
  }

  start() {
    const s = this.settings;
    const opts: IClientOptions = {
      clientId: s.clientId,
      username: s.username,
      password: s.password,
      ca: s.ca,
      rejectUnauthorized: true,
      protocolVersion: 4,
      clean: false, // persistent session: QoS 1 commands/acks queued by the broker survive short drop-outs
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 15_000,
      queueQoSZero: false,
      will: { topic: this.topic('presence'), payload: Buffer.from(JSON.stringify({ state: 'offline' })), qos: 1, retain: true }
    };
    log.info({ url: s.url, clientId: s.clientId }, 'connecting to MQTT broker');
    const client = mqtt.connect(s.url, opts);
    this.client = client;

    client.on('connect', () => {
      this._connected = true;
      this.lastError = '';
      this.runtime.setMqtt('up');
      log.info('MQTT connected');
      client.publish(this.topic('presence'), JSON.stringify({ state: 'online' }), { qos: 1, retain: true });
      client.subscribe(
        [this.topic('commands'), this.topic('roster-changed'), this.topic('attendance/ack')],
        { qos: 1 },
        (err) => {
          if (err) log.error({ err: err.message }, 'MQTT subscribe failed');
        }
      );
      this.emit('connect');
    });
    client.on('close', () => {
      if (this._connected) log.warn('MQTT connection lost; continuing offline (events are buffered locally)');
      this._connected = false;
      this.runtime.setMqtt('down');
      this.emit('disconnect');
    });
    client.on('offline', () => this.runtime.setMqtt('down'));
    client.on('error', (err) => {
      if (err.message !== this.lastError) log.warn({ err: err.message }, 'MQTT error');
      this.lastError = err.message;
    });
    client.on('message', (topic, buf) => {
      let payload: unknown;
      try {
        payload = buf.length ? JSON.parse(buf.toString('utf8')) : null;
      } catch {
        log.warn({ topic }, 'ignoring non-JSON MQTT message');
        return;
      }
      if (topic === this.topic('commands')) this.emit('command', payload);
      else if (topic === this.topic('roster-changed')) this.emit('roster-changed', payload);
      else if (topic === this.topic('attendance/ack')) this.emit('attendance-ack', payload);
    });
  }

  /** Publish JSON; rejects when not connected or when the broker does not acknowledge within the timeout. */
  publish(kind: OutboundKind, payload: unknown, opts: { qos?: 0 | 1; retain?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const client = this.client;
    if (!client || !this._connected) return Promise.reject(new Error('MQTT not connected'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MQTT publish to ${kind} timed out`)), opts.timeoutMs ?? 10_000);
      client.publish(this.topic(kind), JSON.stringify(payload), { qos: opts.qos ?? 1, retain: opts.retain ?? false }, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Graceful stop: announce offline (retained) so the platform does not wait for the keep-alive to expire. */
  async stop() {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      if (this._connected) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2000);
          client.publish(this.topic('presence'), JSON.stringify({ state: 'offline' }), { qos: 1, retain: true }, () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    } catch (err) {
      log.debug({ err: errMsg(err) }, 'offline presence publish failed');
    }
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    this._connected = false;
    this.runtime.setMqtt('down');
  }
}
