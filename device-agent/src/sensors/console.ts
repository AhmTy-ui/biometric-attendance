import { createHmac, randomInt } from 'node:crypto';
import { clamp } from '../util.js';
import {
  CancelledError,
  NoFingerError,
  SensorError,
  type CaptureOptions,
  type CaptureResult,
  type FingerprintSensor,
  type IdentifyOptions,
  type IdentifyResult
} from './types.js';

/**
 * Bench / commissioning driver — NOT FOR PRODUCTION ATTENDANCE.
 *
 * Runs the complete pipeline (enrol → upload → download → identify → record → upload) without a sensor attached.
 * The operator types who is "at the terminal"; templates are derived deterministically as
 * HMAC-SHA256(device-local secret, employeeId:finger), so a template enrolled on this terminal, uploaded to the
 * platform and synced back is identified again by this terminal.
 */

export interface BenchOperator {
  ask(question: string): Promise<string>;
  say(message: string): void;
}

export interface BenchPerson {
  employeeId: string;
  label: string;
}

const MAGIC = Buffer.from('BAMPBNCH', 'ascii');

export class ConsoleBenchSensor implements FingerprintSensor {
  readonly name = 'console bench sensor (NOT FOR PRODUCTION)';
  readonly production = false;
  readonly templateFormat = 'BAMP-BENCH-HMAC';
  readonly autoScan = false;
  capacity = 3000;
  private library = new Map<number, Buffer>();

  constructor(
    private secret: Buffer,
    private resolvePerson: (input: string) => BenchPerson | null,
    private operator: () => BenchOperator | null
  ) {}

  private op(): BenchOperator {
    const o = this.operator();
    if (!o) throw new SensorError('The console bench sensor needs an interactive terminal (stdin is not a TTY)', 'no_console');
    return o;
  }

  template(employeeId: string, fingerIndex: number): Buffer {
    const mac = createHmac('sha256', this.secret).update(`${employeeId}:${fingerIndex}`).digest();
    return Buffer.concat([MAGIC, mac]);
  }

  async open() {
    this.library.clear();
  }

  async close() {
    this.library.clear();
  }

  async identify(_opts: IdentifyOptions): Promise<IdentifyResult | null> {
    const raw = (await this.op().ask('[bench sensor] Staff number of the person at the terminal (add #finger to pick a finger, blank = no finger): ')).trim();
    if (!raw) throw new NoFingerError();
    const [who, fingerPart] = raw.split('#');
    const person = this.resolvePerson(who.trim());
    if (!person) return null;
    const fingers = fingerPart ? [Number(fingerPart)] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (const f of fingers) {
      if (!Number.isInteger(f) || f < 1 || f > 10) continue;
      const t = this.template(person.employeeId, f);
      for (const [slot, stored] of this.library) if (stored.equals(t)) return { slot, score: randomInt(80, 100) };
    }
    return null;
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    if (!opts.hint) throw new SensorError('Bench capture requires the employee/finger being enrolled', 'no_hint');
    const op = this.op();
    const answer = (await op.ask(`[bench sensor] Simulating capture of ${opts.hint.label}. Quality 0-100 [85], or X to cancel: `)).trim();
    if (/^x$/i.test(answer)) throw new CancelledError();
    const q = answer === '' ? 85 : Number(answer);
    if (!Number.isFinite(q)) throw new SensorError('Enter a number between 0 and 100', 'bad_input');
    return { template: this.template(opts.hint.employeeId, opts.hint.fingerIndex), quality: clamp(Math.round(q), 0, 100) };
  }

  async store(slot: number, template: Buffer) {
    if (slot < 0 || slot >= this.capacity) throw new SensorError(`Slot ${slot} outside library`, 'slot');
    this.library.set(slot, Buffer.from(template));
  }

  async remove(slot: number) {
    this.library.delete(slot);
  }

  async clear() {
    this.library.clear();
  }

  async count() {
    return this.library.size;
  }
}
