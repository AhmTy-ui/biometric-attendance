import { CaptureService } from './capture.js';
import { CommandHandler } from './commands.js';
import { RUNNING_VERSION, config, readCaFile } from './config.js';
import { EnrolmentService } from './enrolment.js';
import { FirmwareManager } from './firmware.js';
import { Heartbeat } from './heartbeat.js';
import { DeviceHttp } from './http.js';
import { TemplateLibrary } from './library.js';
import { LogUploader, attachLogBuffer, detachLogBuffer, log } from './logs.js';
import { MqttLink } from './mqttLink.js';
import { createSensor } from './sensors/index.js';
import { Runtime, deviceTimeZone, getCloudConfig, getDeviceConfig, storageCapacity } from './state.js';
import type { Store } from './store.js';
import { SyncService } from './sync.js';
import { Terminal, type StatusInfo } from './terminal.js';
import { getClockOffset, setClockOffset } from './time.js';
import { Uploader } from './uploader.js';
import { errMsg, every, sleep } from './util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wires every terminal service together and runs until shutdown. Resolves with the process exit code. */
export async function runAgent(store: Store): Promise<number> {
  const identity = store.getIdentity();
  if (!identity) {
    console.error('This terminal is not activated. Run:  bamp-device activate --uid <DEVICE_UID> --code <ACTIVATION_CODE>');
    return 2;
  }
  attachLogBuffer(store);
  setClockOffset(store.get<number>('clockOffsetMs') ?? 0);
  const runtime = new Runtime();
  const http = new DeviceHttp({
    baseUrl: () => config.apiUrl ?? identity.apiBaseUrl,
    credentials: () => ({ deviceUid: identity.deviceUid, secret: identity.secret }),
    caPems: () => {
      const pems = [identity.caCertificate];
      try {
        const extra = readCaFile();
        if (extra) pems.push(extra);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'BAMP_CA_FILE unreadable; using the CA delivered at activation');
      }
      return pems;
    },
    runtime
  });

  let terminal: Terminal | null = null;
  let mqttLink: MqttLink | null = null;
  const sensor = createSensor({
    dataDir: config.dataDir,
    operator: () => (terminal?.interactive ? terminal : null),
    resolvePerson: (input) => {
      const e = store.getEmployeeByStaffNumber(input);
      if (e) return { employeeId: e.id, label: `${e.fullName} (${e.staffNumber})` };
      if (UUID_RE.test(input) && store.templatesForEmployee(input).length) {
        const sup = store.listSupervisors().find((s) => s.employeeId === input);
        return { employeeId: input, label: sup ? `${sup.fullName} (supervisor)` : input };
      }
      return null;
    }
  });
  if (!sensor.production) {
    log.warn(`SENSOR_DRIVER=console — ${sensor.name}. Bench/commissioning mode: NOT FOR PRODUCTION ATTENDANCE.`);
  }
  const library = new TemplateLibrary(store, sensor, runtime);
  const capture = new CaptureService(store, sensor, library, () => mqttLink, runtime, identity.deviceUid);
  const sync = new SyncService(store, http, library, runtime);
  const uploader = new Uploader(store, http, runtime);
  const heartbeat = new Heartbeat(store, http, () => mqttLink, runtime);
  const logUploader = new LogUploader(store, http);
  const firmware = new FirmwareManager(store, http, () => mqttLink, runtime, config.dataDir);
  const enrolment = new EnrolmentService(store, http, sensor, library, () => mqttLink, runtime);

  // ───────────── shutdown ─────────────
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const loops: { stop(): void }[] = [];
  const shutdown = async (code: number, reason: string) => {
    if (runtime.shuttingDown) return;
    runtime.shuttingDown = true;
    log.info({ code, reason }, 'device agent stopping');
    const force = setTimeout(() => resolveExit(code), 10_000);
    force.unref();
    for (const l of loops) l.stop();
    sync.stop();
    uploader.stop();
    heartbeat.stop();
    logUploader.stop();
    terminal?.stop();
    store.set('clockOffsetMs', getClockOffset());
    await logUploader.upload().catch(() => undefined);
    await mqttLink?.stop().catch(() => undefined);
    await http.close();
    await sensor.close().catch(() => undefined);
    clearTimeout(force);
    resolveExit(code);
  };
  const commands = new CommandHandler(store, http, () => mqttLink, runtime, sync, heartbeat, firmware, shutdown);

  terminal = new Terminal(
    runtime,
    () => capture,
    () => enrolment,
    (): StatusInfo => {
      const cloud = getCloudConfig(store);
      const counts = store.eventCounts();
      const capacity = storageCapacity(store);
      return {
        deviceName: cloud?.device.name ?? identity.deviceUid,
        location: cloud?.location ? `${cloud.location.name}${deviceTimeZone(store) ? ` (${deviceTimeZone(store)})` : ''}` : 'no location',
        lifecycle: cloud?.device.lifecycleState ?? 'unknown',
        mqtt: runtime.mqtt,
        https: runtime.https,
        pending: counts.pending + counts.sent,
        rejected: counts.rejected,
        storagePct: store.storageUsedPct(capacity),
        storageLevel: runtime.storageLevel,
        mode: capture.mode,
        sensor: sensor.name,
        sensorReady: runtime.sensorReady,
        employees: store.employeeCount(),
        templates: store.templateCount(),
        rosterVersion: store.get<number>('rosterVersion') ?? 0,
        templateVersion: store.get<number>('templateVersion') ?? 0,
        firmware: RUNNING_VERSION,
        lastSync: store.get<string>('lastSyncAt') ?? null,
        reconciling: runtime.reconciling
      };
    },
    () => sensor.autoScan && runtime.sensorReady,
    () => void shutdown(0, 'operator quit')
  );

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(0, sig));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.stack ?? err.message }, 'uncaught exception');
    void shutdown(1, 'uncaught exception');
  });
  process.on('unhandledRejection', (err) => log.error({ err: errMsg(err) }, 'unhandled promise rejection'));

  log.info(
    { deviceUid: identity.deviceUid, version: RUNNING_VERSION, dataDir: config.dataDir, sensor: sensor.name, api: config.apiUrl ?? identity.apiBaseUrl },
    'device agent starting'
  );
  firmware.onStartup();

  // ───────────── sensor ─────────────
  let sensorOpening = false;
  const openSensor = async () => {
    if (sensorOpening || runtime.shuttingDown) return;
    sensorOpening = true;
    try {
      for (let attempt = 0; !runtime.shuttingDown; attempt++) {
        try {
          await sensor.open();
          runtime.sensorReady = true;
          log.info({ sensor: sensor.name, capacity: sensor.capacity }, 'fingerprint sensor ready');
          runtime.emit('status');
          await library.reconcile().catch((err) => log.warn({ err: errMsg(err) }, 'sensor library reconcile failed'));
          return;
        } catch (err) {
          if (attempt === 0 || attempt % 10 === 0) log.error({ err: errMsg(err) }, 'fingerprint sensor unavailable; retrying every 30 s');
          await sleep(30_000);
        }
      }
    } finally {
      sensorOpening = false;
    }
  };
  void openSensor();

  // ───────────── MQTT ─────────────
  mqttLink = new MqttLink(
    {
      url: identity.mqtt.url,
      username: identity.mqtt.username,
      password: identity.mqtt.password,
      ca: identity.caCertificate,
      topicPrefix: identity.mqtt.topicPrefix,
      clientId: `bamp-dev-${identity.deviceUid}`.slice(0, 64)
    },
    runtime
  );
  mqttLink.on('connect', () => {
    firmware.confirmHealthy();
    void firmware.flush();
    void heartbeat.send().catch(() => undefined);
    uploader.kick();
  });
  mqttLink.on('command', (p) => commands.enqueue(p));
  mqttLink.on('roster-changed', (p) => sync.onRosterChanged(p));
  mqttLink.on('attendance-ack', (p) => capture.onAck(p));
  mqttLink.start();

  // HTTPS reachability regained → upload immediately.
  let lastHttps = runtime.https;
  runtime.on('status', () => {
    if (runtime.https === 'up' && lastHttps !== 'up') uploader.kick();
    lastHttps = runtime.https;
  });

  terminal.start();
  void sync.trigger('startup').then(() => {
    if (!sync.lastError) firmware.confirmHealthy();
  });
  sync.start();
  uploader.start();
  heartbeat.start();
  logUploader.start();

  // Housekeeping: persist clock offset, recycle old delivered history.
  loops.push(
    every(
      () => 60 * 60_000,
      async () => {
        store.set('clockOffsetMs', getClockOffset());
        const days = getDeviceConfig(store).deliveredRetentionDays ?? 30;
        const n = store.purgeDelivered(Date.now() - days * 86_400_000);
        if (n) log.info({ purged: n, retentionDays: days }, 'recycled delivered attendance history');
      },
      { immediate: true }
    )
  );

  // ───────────── continuous scanning (real sensor) ─────────────
  if (sensor.autoScan) {
    void (async () => {
      let consecutiveErrors = 0;
      while (!runtime.shuttingDown) {
        if (!runtime.sensorReady || runtime.busy) {
          await sleep(500);
          continue;
        }
        const r = await capture.scan(1500);
        if (r.kind === 'no_finger') {
          consecutiveErrors = 0;
          continue;
        }
        terminal?.showResult(r, false);
        if (r.kind === 'error') {
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            log.error('fingerprint sensor stopped responding; reopening');
            runtime.sensorReady = false;
            runtime.emit('status');
            await sensor.close().catch(() => undefined);
            consecutiveErrors = 0;
            void openSensor();
          }
          await sleep(2000);
        } else {
          consecutiveErrors = 0;
          await sleep(1200); // give the person time to lift the finger
        }
      }
    })();
  }

  const code = await exited;
  detachLogBuffer();
  return code;
}
