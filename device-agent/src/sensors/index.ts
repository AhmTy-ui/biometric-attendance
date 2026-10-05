import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { Mutex } from '../util.js';
import { ConsoleBenchSensor, type BenchOperator, type BenchPerson } from './console.js';
import { SerialZfmSensor } from './serialZfm.js';
import type { CaptureOptions, FingerprintSensor, IdentifyOptions } from './types.js';

export * from './types.js';

/**
 * Serialises every sensor operation: the module is a single half-duplex UART device shared by automatic
 * scanning, enrolment and template-library maintenance (sync).
 */
export class LockedSensor implements FingerprintSensor {
  private mutex = new Mutex();

  constructor(readonly inner: FingerprintSensor) {}

  get name() {
    return this.inner.name;
  }
  get production() {
    return this.inner.production;
  }
  get templateFormat() {
    return this.inner.templateFormat;
  }
  get autoScan() {
    return this.inner.autoScan;
  }
  get capacity() {
    return this.inner.capacity;
  }
  set capacity(v: number) {
    this.inner.capacity = v;
  }

  open() {
    return this.mutex.run(() => this.inner.open());
  }
  close() {
    return this.mutex.run(() => this.inner.close());
  }
  capture(opts: CaptureOptions) {
    return this.mutex.run(() => this.inner.capture(opts));
  }
  identify(opts: IdentifyOptions) {
    return this.mutex.run(() => this.inner.identify(opts));
  }
  store(slot: number, template: Buffer) {
    return this.mutex.run(() => this.inner.store(slot, template));
  }
  remove(slot: number) {
    return this.mutex.run(() => this.inner.remove(slot));
  }
  clear() {
    return this.mutex.run(() => this.inner.clear());
  }
  count() {
    return this.mutex.run(() => this.inner.count());
  }
}

function benchSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'bench-sensor.key');
  if (existsSync(file)) {
    const b = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (b.length >= 32) return b;
  }
  const secret = randomBytes(32);
  writeFileSync(file, secret.toString('base64'), { mode: 0o600 });
  return secret;
}

export function createSensor(deps: { dataDir: string; resolvePerson: (input: string) => BenchPerson | null; operator: () => BenchOperator | null }): LockedSensor {
  if (config.sensor.driver === 'console') {
    return new LockedSensor(new ConsoleBenchSensor(benchSecret(deps.dataDir), deps.resolvePerson, deps.operator));
  }
  return new LockedSensor(
    new SerialZfmSensor({
      path: config.sensor.port,
      baudRate: config.sensor.baud,
      address: config.sensor.address,
      password: config.sensor.password,
      scoreScale: config.sensor.scoreScale
    })
  );
}
