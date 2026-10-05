import type { TemplateLibrary } from './library.js';
import { log } from './logs.js';
import type { MqttLink } from './mqttLink.js';
import { NoFingerError, PoorImageError, type IdentifyResult, type LockedSensor } from './sensors/index.js';
import { deviceTimeZone, getDeviceConfig, getPolicies, storageCapacity, storagePolicy, type Runtime } from './state.js';
import { StorageFullError, type AttendancePayload, type Direction, type Employee, type Store } from './store.js';
import { isoWithOffset, localDate, localTime, now, tzOffsetMinutes, ulid } from './time.js';
import { errMsg } from './util.js';

/**
 * Attendance decision (FR-3.1, FR-4.1, NFR-2.1): identify → roster check → direction → duplicate suppression →
 * durable write → real-time publish. Nothing on the decision path waits for the network.
 */

export type DirectionMode = 'in' | 'out' | 'auto';

export type PunchResult =
  | {
      kind: 'recorded';
      employee: Employee;
      direction: Direction;
      capturedAtMs: number;
      localTime: string;
      score: number;
      eventUid: string;
      realtime: boolean;
      decisionMs: number;
    }
  | { kind: 'no_finger' }
  | { kind: 'poor_image'; message: string }
  | { kind: 'not_recognised'; score?: number }
  | { kind: 'not_on_roster'; employeeId: string }
  | { kind: 'duplicate'; employee: Employee; direction: Direction; previousLocalTime: string }
  | { kind: 'storage_full'; message: string }
  | { kind: 'sensor_unavailable' }
  | { kind: 'error'; message: string };

export class CaptureService {
  private _mode: DirectionMode;

  constructor(
    private store: Store,
    private sensor: LockedSensor,
    private library: TemplateLibrary,
    private mqtt: () => MqttLink | null,
    private runtime: Runtime,
    private deviceUid: string
  ) {
    this._mode = store.get<DirectionMode>('directionMode') ?? getDeviceConfig(store).defaultDirectionMode ?? 'auto';
  }

  get mode(): DirectionMode {
    return this._mode;
  }

  setMode(mode: DirectionMode) {
    this._mode = mode;
    this.store.set('directionMode', mode);
    log.info({ mode }, 'direction mode changed');
  }

  identifyTimeoutMs() {
    return (getDeviceConfig(this.store).identifyTimeoutSeconds ?? 10) * 1000;
  }

  /** One scan: waits up to `timeoutMs` for a finger, then decides and records. */
  async scan(timeoutMs = this.identifyTimeoutMs(), prompt?: (m: string) => void): Promise<PunchResult> {
    if (!this.runtime.sensorReady) return { kind: 'sensor_unavailable' };
    let match: IdentifyResult | null;
    try {
      match = await this.sensor.identify({ timeoutMs, prompt });
    } catch (err) {
      if (err instanceof NoFingerError) return { kind: 'no_finger' };
      if (err instanceof PoorImageError) return { kind: 'poor_image', message: err.message };
      log.error({ err: errMsg(err) }, 'sensor identify failed');
      return { kind: 'error', message: errMsg(err) };
    }
    const decisionStart = Date.now();
    if (!match) return { kind: 'not_recognised' };
    const result = this.decide(match.slot, match.score, decisionStart);
    if (result.kind === 'recorded') {
      log.info(
        { eventUid: result.eventUid, employeeId: result.employee.id, direction: result.direction, score: result.score, realtime: result.realtime, decisionMs: result.decisionMs },
        'attendance recorded'
      );
    } else if (result.kind !== 'not_recognised') {
      log.info({ result: result.kind }, 'scan outcome');
    }
    return result;
  }

  private decide(slot: number, score: number, decisionStart: number): PunchResult {
    const policies = getPolicies(this.store);
    const tpl = this.store.templateBySlot(slot);
    if (!tpl) {
      // Stale page on the module (template removed while the sensor was offline) → resynchronise the library.
      void this.library.reconcile(true).catch(() => undefined);
      return { kind: 'not_recognised', score };
    }
    if (score < policies.minMatchScore) return { kind: 'not_recognised', score };
    const employee = this.store.getEmployee(tpl.employeeId);
    if (!employee) return { kind: 'not_on_roster', employeeId: tpl.employeeId };

    const tz = deviceTimeZone(this.store);
    const ts = now();
    const today = localDate(ts, tz);
    const last = this.store.lastEventForEmployee(employee.id);
    let direction: Direction;
    if (this._mode === 'auto') {
      const lastToday = last && last.localDate === today ? last : null;
      direction = lastToday ? (lastToday.direction === 'in' ? 'out' : 'in') : 'in';
    } else {
      direction = this._mode;
    }

    // Duplicate-punch window: an accidental second touch must not flip AUTO direction or double-record.
    const windowMs = policies.duplicatePunchWindowSeconds * 1000;
    if (last && windowMs > 0 && ts - last.capturedAtMs >= 0 && ts - last.capturedAtMs < windowMs && (this._mode === 'auto' || last.direction === direction)) {
      return { kind: 'duplicate', employee, direction: last.direction, previousLocalTime: localTime(last.capturedAtMs, tz) };
    }

    const payload: AttendancePayload = {
      eventUid: `${this.deviceUid}-${ulid(ts)}`,
      employeeId: employee.id,
      direction,
      capturedAt: isoWithOffset(ts, tz),
      tzOffsetMinutes: tzOffsetMinutes(ts, tz),
      matchScore: Math.max(0, Math.min(100, Math.round(score))),
      fingerIndex: tpl.fingerIndex
    };

    // O-3: durable (fsync'ed) write BEFORE any network send.
    try {
      this.store.insertEvent({ payload, localDate: today, capturedAtMs: ts }, storageCapacity(this.store), storagePolicy(this.store));
    } catch (err) {
      if (err instanceof StorageFullError) {
        log.error({ undelivered: err.undelivered, capacity: err.capacity }, 'capture refused: storage full (preserve_oldest policy)');
        return { kind: 'storage_full', message: err.message };
      }
      log.error({ err: errMsg(err) }, 'failed to persist attendance event');
      return { kind: 'error', message: `Could not store the event: ${errMsg(err)}` };
    }

    const link = this.mqtt();
    const realtime = Boolean(link?.connected);
    if (link && realtime) {
      link
        .publish('attendance', { ...payload, buffered: false }, { qos: 1 })
        .then(() => this.store.markSent(payload.eventUid))
        .catch((err) => log.debug({ err: errMsg(err), eventUid: payload.eventUid }, 'real-time publish failed; batch uploader will deliver'));
    }
    this.runtime.emit('event-recorded');
    return {
      kind: 'recorded',
      employee,
      direction,
      capturedAtMs: ts,
      localTime: localTime(ts, tz),
      score: payload.matchScore,
      eventUid: payload.eventUid,
      realtime,
      decisionMs: Date.now() - decisionStart
    };
  }

  /** Platform acknowledgement on `attendance/ack` → mark delivered (or rejected). */
  onAck(payload: unknown) {
    const p = (payload ?? {}) as { eventUid?: string; status?: string; error?: string };
    if (!p.eventUid) return;
    if (p.status === 'accepted' || p.status === 'duplicate') this.store.markDelivered([p.eventUid]);
    else if (p.status === 'rejected') {
      this.store.markRejected(p.eventUid, p.error ?? 'Rejected by the platform');
      log.error({ eventUid: p.eventUid, error: p.error ?? null }, 'attendance event rejected by the platform');
    }
    this.runtime.emit('event-acked');
  }
}
