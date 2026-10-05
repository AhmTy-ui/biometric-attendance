import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Real-time channel (MQTT over TLS on 8883, NFR-1.2).
 *
 * Topic design
 *   bamp/{orgId}/devices/{deviceUid}/presence        device → cloud  (retained, LWT "offline")
 *   bamp/{orgId}/devices/{deviceUid}/heartbeat       device → cloud
 *   bamp/{orgId}/devices/{deviceUid}/attendance      device → cloud  (single event on capture, QoS 1)
 *   bamp/{orgId}/devices/{deviceUid}/enrolment       device → cloud  (enrolment session progress)
 *   bamp/{orgId}/devices/{deviceUid}/firmware        device → cloud  (OTA state reports)
 *   bamp/{orgId}/devices/{deviceUid}/commands/ack    device → cloud
 *   bamp/{orgId}/devices/{deviceUid}/commands        cloud  → device (remote commands, QoS 1)
 *   bamp/{orgId}/devices/{deviceUid}/roster-changed  cloud  → device (nudge to pull roster over HTTPS)
 *   bamp/{orgId}/dashboard/{kind}                    cloud  → WebSocket gateway (alert + live fan-out)
 */

export type DeviceTopicKind = 'presence' | 'heartbeat' | 'attendance' | 'enrolment' | 'firmware' | 'commands/ack';
type DeviceHandler = (orgId: string, deviceUid: string, payload: any) => Promise<void>;
type DashboardHandler = (orgId: string, kind: string, payload: any) => void;

const deviceHandlers = new Map<DeviceTopicKind, DeviceHandler>();
const dashboardHandlers: DashboardHandler[] = [];
let client: MqttClient | null = null;
let connected = false;

export const mqttConnected = () => connected;

export function onDeviceMessage(kind: DeviceTopicKind, handler: DeviceHandler) {
  deviceHandlers.set(kind, handler);
}

export function onDashboardMessage(handler: DashboardHandler) {
  dashboardHandlers.push(handler);
}

export function deviceTopic(orgId: string, deviceUid: string, kind: string) {
  return `bamp/${orgId}/devices/${deviceUid}/${kind}`;
}

export function startMqtt(): Promise<void> {
  return new Promise((resolve) => {
    client = mqtt.connect(config.MQTT_URL, {
      clientId: `bamp-cloud-${process.pid}-${randomUUID().slice(0, 8)}`,
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
      ca: readFileSync(config.MQTT_CA_FILE),
      rejectUnauthorized: true,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 2000,
      keepalive: 30
    });
    let resolved = false;
    client.on('connect', () => {
      connected = true;
      logger.info({ url: config.MQTT_URL }, 'mqtt connected');
      client!.subscribe(
        [
          'bamp/+/devices/+/presence',
          'bamp/+/devices/+/heartbeat',
          'bamp/+/devices/+/attendance',
          'bamp/+/devices/+/enrolment',
          'bamp/+/devices/+/firmware',
          'bamp/+/devices/+/commands/ack',
          'bamp/+/dashboard/#',
          '$CONTROL/dynamic-security/v1/response'
        ],
        { qos: 1 }
      );
      // The cloud identity is the dynsec admin; make sure its role may publish commands/nudges/fan-out on bamp/#.
      void ensureCloudAcl();
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
    client.on('close', () => {
      if (connected) logger.warn('mqtt disconnected');
      connected = false;
    });
    client.on('error', (err) => logger.error({ err: err.message }, 'mqtt error'));
    client.on('message', (topic, buf) => {
      void dispatch(topic, buf);
    });
    // Do not block boot forever if the broker is down; the client keeps reconnecting.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn('mqtt not connected yet; continuing startup and retrying in background');
        resolve();
      }
    }, 5000);
  });
}

async function dispatch(topic: string, buf: Buffer) {
  let payload: any;
  try {
    payload = buf.length ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    payload = buf.toString('utf8');
  }
  if (topic === '$CONTROL/dynamic-security/v1/response') {
    handleDynsecResponse(payload);
    return;
  }
  const parts = topic.split('/');
  if (parts[0] !== 'bamp') return;
  const orgId = parts[1];
  if (parts[2] === 'dashboard') {
    for (const h of dashboardHandlers) h(orgId, parts.slice(3).join('/'), payload);
    return;
  }
  if (parts[2] === 'devices') {
    const deviceUid = parts[3];
    const kind = parts.slice(4).join('/') as DeviceTopicKind;
    const handler = deviceHandlers.get(kind);
    if (!handler) return;
    try {
      await handler(orgId, deviceUid, payload);
    } catch (err: any) {
      logger.error({ err: err?.message, topic }, 'mqtt handler failed');
    }
  }
}

export function publish(topic: string, payload: unknown, opts: { qos?: 0 | 1 | 2; retain?: boolean } = {}) {
  return new Promise<void>((resolve, reject) => {
    if (!client) return reject(new Error('MQTT client not started'));
    client.publish(topic, JSON.stringify(payload), { qos: opts.qos ?? 1, retain: opts.retain ?? false }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

/** Fan-out to dashboards goes through the broker; the WebSocket gateway is bridged from it. */
export function publishDashboard(orgId: string, kind: string, data: unknown) {
  return publish(`bamp/${orgId}/dashboard/${kind}`, { kind, at: new Date().toISOString(), data }, { qos: 0 }).catch((err) =>
    logger.warn({ err: err.message, kind }, 'dashboard publish failed')
  );
}

// ───────── Mosquitto dynamic-security control API (per-device credentials + ACL, NFR-1.3) ─────────
const pendingDynsec = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function handleDynsecResponse(payload: any) {
  for (const r of payload?.responses ?? []) {
    const p = r.correlationData ? pendingDynsec.get(r.correlationData) : undefined;
    if (!p) continue;
    clearTimeout(p.timer);
    pendingDynsec.delete(r.correlationData);
    if (r.error && !/already exists|not found/i.test(r.error)) p.reject(new Error(`dynsec ${r.command}: ${r.error}`));
    else p.resolve(r);
  }
}

export function dynsec(command: Record<string, unknown>): Promise<any> {
  const correlationData = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDynsec.delete(correlationData);
      reject(new Error(`dynsec ${command.command} timed out`));
    }, 8000);
    pendingDynsec.set(correlationData, { resolve, reject, timer });
    publish('$CONTROL/dynamic-security/v1', { commands: [{ ...command, correlationData }] }).catch(reject);
  });
}

async function ensureCloudAcl() {
  const role = await dynsec({ command: 'getClient', username: config.MQTT_USERNAME }).catch(() => null);
  const roles: string[] = (role?.data?.client?.roles ?? []).map((r: any) => r.rolename);
  const rolename = 'bamp-cloud';
  await dynsec({
    command: 'createRole',
    rolename,
    acls: [
      { acltype: 'publishClientSend', topic: 'bamp/#', priority: 10, allow: true },
      { acltype: 'publishClientReceive', topic: 'bamp/#', priority: 10, allow: true },
      { acltype: 'subscribePattern', topic: 'bamp/#', priority: 10, allow: true },
      { acltype: 'unsubscribePattern', topic: 'bamp/#', priority: 10, allow: true }
    ]
  }).catch(() => undefined);
  if (!roles.includes(rolename)) {
    try {
      await dynsec({ command: 'addClientRole', username: config.MQTT_USERNAME, rolename, priority: 10 });
    } catch (err: any) {
      // Mosquitto reports "Internal error" when the role is already assigned (e.g. granted by a concurrent reconnect).
      const again = await dynsec({ command: 'getClient', username: config.MQTT_USERNAME }).catch(() => null);
      const has = (again?.data?.client?.roles ?? []).some((r: any) => r.rolename === rolename);
      if (!has) logger.error({ err: err.message }, 'could not grant cloud MQTT role');
    }
  }
}

/** Create (or rotate) the MQTT identity of a device, restricted to its own topic subtree. */
export async function upsertDeviceMqttIdentity(orgId: string, deviceUid: string, password: string) {
  const rolename = `device-${deviceUid}`;
  const base = `bamp/${orgId}/devices/${deviceUid}`;
  await dynsec({ command: 'deleteClient', username: deviceUid }).catch(() => undefined);
  await dynsec({ command: 'deleteRole', rolename }).catch(() => undefined);
  await dynsec({
    command: 'createRole',
    rolename,
    acls: [
      { acltype: 'publishClientSend', topic: `${base}/#`, priority: 0, allow: true },
      { acltype: 'publishClientReceive', topic: `${base}/#`, priority: 0, allow: true },
      { acltype: 'subscribePattern', topic: `${base}/#`, priority: 0, allow: true },
      { acltype: 'unsubscribePattern', topic: `${base}/#`, priority: 0, allow: true }
    ]
  });
  await dynsec({ command: 'createClient', username: deviceUid, password, roles: [{ rolename }] });
}

export async function disableDeviceMqttIdentity(deviceUid: string) {
  await dynsec({ command: 'disableClient', username: deviceUid }).catch(() => undefined);
}

export async function stopMqtt() {
  await new Promise<void>((r) => (client ? client.end(false, {}, () => r()) : r()));
}
