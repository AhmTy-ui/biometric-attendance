import { randomUUID } from 'node:crypto';
import { verify as argonVerify } from '@node-rs/argon2';
import { ApiError, type DeviceHttp } from './http.js';
import type { TemplateLibrary } from './library.js';
import { log } from './logs.js';
import type { MqttLink } from './mqttLink.js';
import { FINGER_NAMES, type Operator } from './operator.js';
import { CancelledError, NoFingerError, PoorImageError, type LockedSensor } from './sensors/index.js';
import { getPolicies, type CloudConfig, type Policies, type Runtime } from './state.js';
import type { Employee, Store, Supervisor } from './store.js';
import { refreshCloudConfig } from './sync.js';
import { errMsg, sha256Hex } from './util.js';

/**
 * On-device enrolment (FR-2.1 … FR-2.4):
 *  supervisor authorisation (PIN or supervisor fingerprint) → employee from the local roster only (the device never
 *  creates employees) → capture ≥ fingersPerEmployee fingers with quality ≥ minEnrolQuality → template generated
 *  locally by the sensor → uploaded over HTTPS → stored locally and in the sensor library.
 */

type SessionStatus = 'started' | 'finger_captured' | 'completed' | 'failed_quality' | 'employee_unavailable' | 'unauthorised' | 'aborted';

interface SessionReport {
  sessionId: string;
  status: SessionStatus;
  employeeId?: string | null;
  supervisorUserId?: string | null;
  authorisationMethod?: 'fingerprint' | 'pin' | null;
  fingersCaptured?: number;
  detail?: string;
}

interface Authorisation {
  supervisor: Supervisor;
  method: 'fingerprint' | 'pin';
}

/** Ends the session; `status` is the final status to report (null when already recorded by the platform). */
class EndSession extends Error {
  constructor(
    readonly status: SessionStatus | null,
    readonly detail: string
  ) {
    super(detail);
  }
}

interface UploadResponse {
  templateId: string;
  fingersEnrolled: number;
  required: number;
}

const DEFAULT_FINGER_ORDER = [2, 7, 3, 8, 1, 6, 4, 9, 5, 10];

export class EnrolmentService {
  constructor(
    private store: Store,
    private http: DeviceHttp,
    private sensor: LockedSensor,
    private library: TemplateLibrary,
    private mqtt: () => MqttLink | null,
    private runtime: Runtime
  ) {}

  private async report(r: SessionReport) {
    const payload = { ...r, detail: r.detail?.slice(0, 500) };
    const link = this.mqtt();
    if (link?.connected) {
      try {
        await link.publish('enrolment', payload, { qos: 1 });
        return;
      } catch (err) {
        log.debug({ err: errMsg(err) }, 'enrolment progress over MQTT failed; using HTTPS');
      }
    }
    await this.http.request('POST', '/device/v1/enrolment-sessions', { body: payload, retries: 2 }).catch((err) =>
      log.warn({ err: errMsg(err), sessionId: r.sessionId, status: r.status }, 'could not report enrolment session progress')
    );
  }

  private async ask(op: Operator, q: string, opts?: { mask?: boolean }) {
    const a = (await op.ask(q, opts)).trim();
    if (/^x$/i.test(a)) throw new CancelledError();
    return a;
  }

  async run(op: Operator): Promise<void> {
    if (this.runtime.busy) {
      op.warn('Another operation is in progress. Try again shortly.');
      return;
    }
    this.runtime.busy = true;
    try {
      await this.session(op);
    } finally {
      this.runtime.busy = false;
    }
  }

  private async session(op: Operator) {
    op.say('── Fingerprint enrolment ── (type X at any prompt to cancel)');
    let cfg: CloudConfig;
    try {
      cfg = await refreshCloudConfig(this.store, this.http, this.runtime);
    } catch (err) {
      op.error('Enrolment needs a connection to the platform (templates are uploaded over HTTPS). Try again when the device is online.');
      log.warn({ err: errMsg(err) }, 'enrolment unavailable: platform unreachable');
      return;
    }
    if (!cfg.enrolmentAllowed) {
      op.error(
        `Enrolment is not permitted on this device (state: ${cfg.device.lifecycleState}${cfg.location ? '' : ', no location assigned'}). An administrator must activate the device first.`
      );
      return;
    }
    if (!this.runtime.sensorReady) {
      op.error('The fingerprint sensor is not available.');
      return;
    }
    const policies = getPolicies(this.store);
    const sessionId = randomUUID();
    let auth: Authorisation | null = null;
    let employee: Employee | null = null;
    let fingers = 0;
    try {
      auth = await this.authorise(op, sessionId, policies);
      await this.report({ sessionId, status: 'started', supervisorUserId: auth.supervisor.userId, authorisationMethod: auth.method });
      log.info({ sessionId, supervisorUserId: auth.supervisor.userId, method: auth.method }, 'enrolment session started');
      op.success(`Authorised by ${auth.supervisor.fullName} (${auth.method === 'pin' ? 'PIN' : 'fingerprint'})`);

      employee = await this.selectEmployee(op, sessionId, auth);
      const existing = this.store.templatesForEmployee(employee.id).map((t) => t.fingerIndex);
      if (existing.length) op.say(`Already enrolled on this device: ${existing.map((f) => FINGER_NAMES[f]).join(', ')}. Re-enrolling a finger replaces it.`);

      const used = new Set<number>();
      for (let n = 1; n <= policies.fingersPerEmployee; n++) {
        const finger = await this.chooseFinger(op, n, policies.fingersPerEmployee, used);
        used.add(finger);
        const res = await this.captureAndUpload(op, { sessionId, auth, employee, finger, policies });
        fingers = Math.max(fingers, res.fingersEnrolled);
      }
      await this.report({
        sessionId,
        status: 'completed',
        employeeId: employee.id,
        supervisorUserId: auth.supervisor.userId,
        authorisationMethod: auth.method,
        fingersCaptured: Math.min(10, Math.max(fingers, policies.fingersPerEmployee))
      });
      log.info({ sessionId, employeeId: employee.id, fingers }, 'enrolment completed');
      op.success(`Fingerprint enrolled successfully — ${employee.fullName} (${employee.staffNumber})`);
    } catch (err) {
      const base = { sessionId, employeeId: employee?.id ?? null, supervisorUserId: auth?.supervisor.userId ?? null, authorisationMethod: auth?.method ?? null, fingersCaptured: fingers };
      if (err instanceof CancelledError) {
        await this.report({ ...base, status: 'aborted', detail: 'Cancelled at the terminal' });
        op.warn('Enrolment cancelled.');
      } else if (err instanceof EndSession) {
        if (err.status) await this.report({ ...base, status: err.status, detail: err.detail });
        log.warn({ sessionId, status: err.status, detail: err.detail }, 'enrolment ended');
      } else {
        await this.report({ ...base, status: 'aborted', detail: `Terminal error: ${errMsg(err)}` });
        log.error({ sessionId, err: errMsg(err) }, 'enrolment failed');
        op.error(`Enrolment failed: ${errMsg(err)}`);
      }
    }
  }

  private async authorise(op: Operator, sessionId: string, policies: Policies): Promise<Authorisation> {
    const supervisors = this.store.listSupervisors();
    if (!supervisors.length) {
      op.error('No supervisors with a PIN or fingerprint are configured for this branch. Configure one in the dashboard (Users → supervisor authorisation).');
      throw new EndSession('unauthorised', 'No supervisors configured for this branch');
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const how = (await this.ask(op, 'Supervisor authorisation — [P]IN or [F]ingerprint? ')).toLowerCase();
      if (how === 'p' || how === 'pin') {
        const pin = await this.ask(op, 'Supervisor PIN: ', { mask: true });
        if (!/^\d{4,12}$/.test(pin)) {
          op.warn('A PIN is 6–8 digits.');
          continue;
        }
        for (const s of supervisors) {
          if (!s.pinHash) continue;
          const ok = await argonVerify(s.pinHash, pin).catch(() => false);
          if (ok) return { supervisor: s, method: 'pin' };
        }
        op.error('PIN not recognised.');
      } else if (how === 'f' || how === 'fingerprint') {
        op.say('Supervisor: place your finger on the sensor.');
        try {
          const m = await this.sensor.identify({ timeoutMs: 15_000, prompt: (msg) => op.say(msg) });
          const tpl = m ? this.store.templateBySlot(m.slot) : null;
          const sup = tpl ? supervisors.find((s) => s.employeeId === tpl.employeeId) : undefined;
          if (m && sup && m.score >= policies.minMatchScore) return { supervisor: sup, method: 'fingerprint' };
          op.error('Fingerprint not recognised as a supervisor authorised for this branch.');
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          if (err instanceof NoFingerError) op.warn('No finger detected.');
          else if (err instanceof PoorImageError) op.warn(`Image unclear — ${err.message}`);
          else op.error(`Sensor error: ${errMsg(err)}`);
        }
      } else {
        op.warn('Type P for PIN or F for fingerprint.');
        attempt--;
        continue;
      }
    }
    op.error('Not authorised. Enrolment requires a supervisor of this branch.');
    throw new EndSession('unauthorised', `Supervisor authorisation failed 3 times (session ${sessionId})`);
  }

  private async selectEmployee(op: Operator, sessionId: string, auth: Authorisation): Promise<Employee> {
    for (;;) {
      const term = await this.ask(op, 'Employee staff number or name: ');
      if (!term) continue;
      const matches = this.store.searchEmployees(term);
      if (!matches.length) {
        op.error(`Employee unavailable — "${term}" is not on this device's roster. Employees are created in the web software and reach the device automatically.`);
        const again = (await this.ask(op, 'Search again? [Y/n] ')).toLowerCase();
        if (again === 'n' || again === 'no') throw new EndSession('employee_unavailable', `No roster match for "${term.slice(0, 100)}"`);
        continue;
      }
      let chosen: Employee | undefined;
      if (matches.length === 1) {
        const e = matches[0];
        const ok = (await this.ask(op, `Enrol ${e.fullName} (${e.staffNumber}${e.department ? `, ${e.department}` : ''})? [Y/n] `)).toLowerCase();
        if (ok === '' || ok === 'y' || ok === 'yes') chosen = e;
      } else {
        matches.forEach((e, i) => op.say(`  ${i + 1}. ${e.fullName} (${e.staffNumber}${e.department ? `, ${e.department}` : ''})`));
        const pick = Number(await this.ask(op, `Choose 1-${matches.length} (Enter to search again): `));
        if (Number.isInteger(pick) && pick >= 1 && pick <= matches.length) chosen = matches[pick - 1];
      }
      if (chosen) {
        log.info({ sessionId, employeeId: chosen.id, supervisorUserId: auth.supervisor.userId }, 'enrolment employee selected');
        return chosen;
      }
    }
  }

  private async chooseFinger(op: Operator, n: number, total: number, used: Set<number>): Promise<number> {
    const def = DEFAULT_FINGER_ORDER.find((f) => !used.has(f)) ?? 1;
    for (;;) {
      const a = await this.ask(op, `Finger ${n} of ${total}: finger number 1-10 [${def} = ${FINGER_NAMES[def]}]: `);
      const f = a === '' ? def : Number(a);
      if (!Number.isInteger(f) || f < 1 || f > 10) {
        op.warn('1-5 = right thumb…little finger, 6-10 = left thumb…little finger.');
        continue;
      }
      if (used.has(f)) {
        op.warn('That finger was already captured in this session; choose a different finger.');
        continue;
      }
      return f;
    }
  }

  private async captureAndUpload(
    op: Operator,
    ctx: { sessionId: string; auth: Authorisation; employee: Employee; finger: number; policies: Policies }
  ): Promise<UploadResponse> {
    const { sessionId, auth, employee, finger, policies } = ctx;
    const label = `${FINGER_NAMES[finger]} of ${employee.fullName}`;
    let lastProblem = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      op.say(`Capture ${label} (attempt ${attempt} of 3)`);
      let captured: { template: Buffer; quality: number };
      try {
        captured = await this.sensor.capture({
          timeoutMs: 20_000,
          prompt: (m) => op.say(`  ${m}`),
          hint: { employeeId: employee.id, fingerIndex: finger, label }
        });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        if (err instanceof NoFingerError) lastProblem = 'no finger detected';
        else if (err instanceof PoorImageError) lastProblem = err.message;
        else lastProblem = `sensor error: ${errMsg(err)}`;
        op.warn(`Fingerprint quality too low — ${lastProblem}. Please try again.`);
        continue;
      }
      if (captured.quality < policies.minEnrolQuality) {
        lastProblem = `quality ${captured.quality} below the required ${policies.minEnrolQuality}`;
        op.warn(`Fingerprint quality too low (${captured.quality} < ${policies.minEnrolQuality}). Clean the sensor and finger, press flat, and try again.`);
        continue;
      }
      const res = await this.upload(op, { sessionId, auth, employee, finger, captured });
      if (!res) {
        lastProblem = 'rejected by the platform as low quality';
        continue;
      }
      const outcome = await this.library.put({
        employeeId: employee.id,
        fingerIndex: finger,
        templateId: res.templateId,
        format: this.sensor.templateFormat,
        quality: captured.quality,
        sha256: sha256Hex(captured.template),
        blob: captured.template
      });
      if (outcome === 'library_full') op.warn('The sensor library is full; this fingerprint is stored on the platform but cannot be identified on this terminal.');
      await this.report({
        sessionId,
        status: 'finger_captured',
        employeeId: employee.id,
        supervisorUserId: auth.supervisor.userId,
        authorisationMethod: auth.method,
        fingersCaptured: Math.min(10, res.fingersEnrolled)
      });
      op.success(`${FINGER_NAMES[finger]} captured (quality ${captured.quality}) — ${res.fingersEnrolled}/${res.required} fingers on record`);
      return res;
    }
    op.error('Fingerprint quality too low — enrolment stopped after 3 attempts.');
    throw new EndSession('failed_quality', `${FINGER_NAMES[finger]}: ${lastProblem}`);
  }

  /** POST /device/v1/templates; null when the platform rejects the quality (caller retries the capture). */
  private async upload(
    op: Operator,
    ctx: { sessionId: string; auth: Authorisation; employee: Employee; finger: number; captured: { template: Buffer; quality: number } }
  ): Promise<UploadResponse | null> {
    const { sessionId, auth, employee, finger, captured } = ctx;
    const body = {
      sessionId,
      employeeId: employee.id,
      fingerIndex: finger,
      quality: captured.quality,
      format: this.sensor.templateFormat,
      template: captured.template.toString('base64'),
      sha256: sha256Hex(captured.template),
      supervisorUserId: auth.supervisor.userId,
      authorisationMethod: auth.method
    };
    for (;;) {
      try {
        op.say('  Uploading template…');
        return await this.http.request<UploadResponse>('POST', '/device/v1/templates', { body, retries: 2, timeoutMs: 30_000 });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          if (/roster/i.test(err.message)) {
            op.error('Employee unavailable — the employee is no longer on this device\'s roster.');
            throw new EndSession(null, err.message); // the platform recorded employee_unavailable
          }
          if (/supervisor/i.test(err.message)) {
            op.error('Not authorised — the supervisor is not authorised for this branch.');
            throw new EndSession(null, err.message); // the platform recorded unauthorised
          }
          op.error(`Enrolment refused by the platform: ${err.message}`);
          throw new EndSession('aborted', err.message);
        }
        if (err instanceof ApiError && err.status === 400 && /quality/i.test(err.message)) {
          op.warn(`Fingerprint quality too low (platform): ${err.message}`);
          return null;
        }
        op.error(`Upload failed: ${errMsg(err)}`);
        const again = (await this.ask(op, 'Retry the upload? [Y/n] ')).toLowerCase();
        if (again === 'n' || again === 'no') throw new EndSession('aborted', `Template upload failed: ${errMsg(err)}`);
      }
    }
  }
}
