import readline from 'node:readline';
import type { CaptureService, DirectionMode, PunchResult } from './capture.js';
import { config } from './config.js';
import type { EnrolmentService } from './enrolment.js';
import { log } from './logs.js';
import type { Operator } from './operator.js';
import type { Runtime } from './state.js';
import { errMsg } from './util.js';

/**
 * Kiosk text UI on stdin/stdout.
 *   Enter = scan finger · I / O / A = direction In / Out / Auto · E = enrolment · S = status · Q = quit
 */

export interface StatusInfo {
  deviceName: string;
  location: string;
  lifecycle: string;
  mqtt: string;
  https: string;
  pending: number;
  rejected: number;
  storagePct: number;
  storageLevel: 'ok' | 'warning' | 'critical';
  mode: DirectionMode;
  sensor: string;
  sensorReady: boolean;
  employees: number;
  templates: number;
  rosterVersion: number;
  templateVersion: number;
  firmware: string;
  lastSync: string | null;
  reconciling: boolean;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  alarm: '\x1b[1;37;41m'
};

export class Terminal implements Operator {
  private rl: readline.Interface | null = null;
  private muted = false;
  private busy = false;
  private lastConnectivity = '';
  readonly interactive = !config.headless;

  constructor(
    private runtime: Runtime,
    private capture: () => CaptureService | null,
    private enrolment: () => EnrolmentService | null,
    private statusInfo: () => StatusInfo,
    private autoScan: () => boolean,
    private onQuit: () => void
  ) {}

  start() {
    this.runtime.on('storage-alarm', (a: { level: string; message: string }) => {
      const bell = this.interactive ? '\x07' : '';
      this.print(`${bell}${C.alarm} ⚠ ${a.message} ${C.reset}`);
      if (a.level === 'critical') this.print(`${C.alarm} ⚠ Restore connectivity so buffered events upload. Contact your administrator. ${C.reset}`);
    });
    this.runtime.on('status', () => {
      const s = this.statusInfo();
      const conn = `${s.mqtt}/${s.https}/${s.reconciling}`;
      if (conn !== this.lastConnectivity) {
        this.lastConnectivity = conn;
        this.print(this.statusLine(s));
      }
    });
    if (!this.interactive) {
      log.info('no interactive console: kiosk UI disabled (headless)');
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
    this.rl = rl;
    const internals = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = internals._writeToOutput.bind(rl);
    internals._writeToOutput = (s: string) => {
      if (!this.muted) return original(s);
      if (s.includes('\n') || s.includes('\r')) return original('\r\n');
      original('*'.repeat([...s].length));
    };
    rl.setPrompt(`${C.cyan}> ${C.reset}`);
    rl.on('line', (line) => void this.onLine(line));
    rl.on('SIGINT', () => this.onQuit());
    rl.on('close', () => {
      if (!this.runtime.shuttingDown) this.onQuit();
    });
    this.print(`${C.bold}BAMP attendance terminal${C.reset}  ${C.dim}Enter=scan  I/O/A=direction  E=enrol  S=status  Q=quit${C.reset}`);
    this.print(this.statusLine(this.statusInfo()));
    rl.prompt();
  }

  stop() {
    this.rl?.close();
    this.rl = null;
  }

  // ───────────── Operator ─────────────
  print(line: string) {
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`${line}\n`);
      this.rl.prompt(true);
    } else {
      process.stdout.write(`${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
    }
  }

  say(message: string) {
    this.print(message);
  }
  success(message: string) {
    this.print(`${C.green}✔ ${message}${C.reset}`);
  }
  warn(message: string) {
    this.print(`${C.yellow}! ${message}${C.reset}`);
  }
  error(message: string) {
    this.print(`${C.red}✖ ${message}${C.reset}`);
  }

  ask(question: string, opts: { mask?: boolean } = {}): Promise<string> {
    const rl = this.rl;
    if (!rl) return Promise.reject(new Error('No interactive console available'));
    return new Promise<string>((resolve) => {
      rl.question(`${C.bold}${question}${C.reset}`, (answer) => {
        this.muted = false;
        resolve(answer);
      });
      if (opts.mask) this.muted = true;
    });
  }

  // ───────────── kiosk ─────────────
  statusLine(s: StatusInfo): string {
    const online = s.mqtt === 'up' || s.https === 'up';
    const net = online ? `${C.green}ONLINE${C.reset}` : `${C.red}OFFLINE${C.reset}`;
    const storage =
      s.storageLevel === 'critical' ? `${C.alarm}storage ${s.storagePct}%${C.reset}` : s.storageLevel === 'warning' ? `${C.yellow}storage ${s.storagePct}%${C.reset}` : `storage ${s.storagePct}%`;
    const sensor = s.sensorReady ? 'sensor ok' : `${C.red}sensor unavailable${C.reset}`;
    return [
      `${C.bold}${s.deviceName}${C.reset} · ${s.location}`,
      net,
      `MQTT ${s.mqtt} · HTTPS ${s.https}`,
      `pending ${s.pending}${s.reconciling ? ' (uploading)' : ''}`,
      storage,
      `mode ${s.mode.toUpperCase()}`,
      sensor
    ].join('  |  ');
  }

  private statusDetails() {
    const s = this.statusInfo();
    this.print(this.statusLine(s));
    this.print(
      `${C.dim}lifecycle ${s.lifecycle} · firmware ${s.firmware} · roster v${s.rosterVersion} (${s.employees} employees) · templates v${s.templateVersion} (${s.templates}) · rejected ${s.rejected} · last sync ${s.lastSync ?? 'never'} · ${s.sensor}${C.reset}`
    );
  }

  showResult(r: PunchResult, manual: boolean) {
    switch (r.kind) {
      case 'recorded': {
        const dir = r.direction === 'in' ? `${C.green}IN ${C.reset}` : `${C.cyan}OUT${C.reset}`;
        this.print(`${C.bold}${C.green}✔${C.reset} ${C.bold}${r.employee.fullName}${C.reset} (${r.employee.staffNumber})  ${dir}  ${r.localTime}  (score ${r.score})`);
        if (!r.realtime) this.print(`${C.yellow}  Stored offline — will upload automatically${C.reset}`);
        break;
      }
      case 'not_recognised':
        this.print(`${C.red}✖ Not recognised — please try again${C.reset}`);
        break;
      case 'not_on_roster':
        this.print(`${C.red}✖ Not on this terminal's roster — see your supervisor${C.reset}`);
        break;
      case 'duplicate':
        this.print(`${C.yellow}ℹ ${r.employee.fullName}: already recorded ${r.direction.toUpperCase()} at ${r.previousLocalTime}${C.reset}`);
        break;
      case 'storage_full':
        this.print(`\x07${C.alarm} ✖ STORAGE FULL — capture refused (preserve-oldest policy). Restore connectivity immediately. ${C.reset}`);
        break;
      case 'poor_image':
        this.print(`${C.yellow}! Image unclear — place the finger flat on the sensor and try again${C.reset}`);
        break;
      case 'no_finger':
        if (manual) this.print(`${C.dim}No finger detected${C.reset}`);
        break;
      case 'sensor_unavailable':
        this.print(`${C.red}✖ Fingerprint sensor unavailable${C.reset}`);
        break;
      case 'error':
        this.print(`${C.red}✖ ${r.message}${C.reset}`);
        break;
    }
  }

  private async onLine(line: string) {
    const key = line.trim().toLowerCase();
    if (this.busy || this.runtime.busy) {
      this.warn('Busy — please wait');
      return;
    }
    this.busy = true;
    try {
      switch (key) {
        case '': {
          const cap = this.capture();
          if (!cap) break;
          if (this.autoScan()) {
            this.say('Place your finger on the sensor (the terminal scans continuously).');
            break;
          }
          this.showResult(await cap.scan(), true);
          break;
        }
        case 'i':
        case 'o':
        case 'a': {
          const mode: DirectionMode = key === 'i' ? 'in' : key === 'o' ? 'out' : 'auto';
          this.capture()?.setMode(mode);
          this.success(`Direction mode: ${mode.toUpperCase()}`);
          break;
        }
        case 'e': {
          const enr = this.enrolment();
          if (enr) await enr.run(this);
          break;
        }
        case 's':
          this.statusDetails();
          break;
        case 'q':
          this.onQuit();
          return;
        default:
          this.say('Enter = scan finger · I/O/A = direction In/Out/Auto · E = enrolment · S = status · Q = quit');
      }
    } catch (err) {
      this.error(errMsg(err));
    } finally {
      this.busy = false;
      this.rl?.prompt();
    }
  }
}
