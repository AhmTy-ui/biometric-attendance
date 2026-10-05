import { SerialPort } from 'serialport';
import { clamp, sleep } from '../util.js';
import {
  NoFingerError,
  PoorImageError,
  SensorError,
  type CaptureOptions,
  type CaptureResult,
  type FingerprintSensor,
  type IdentifyOptions,
  type IdentifyResult
} from './types.js';

/**
 * Driver for the ZFM-20 / R30x (R305, R307, R503 …) / AS608 optical fingerprint module family over UART.
 *
 * Packet: 0xEF01 | address(4, default 0xFFFFFFFF) | PID(1) | length(2) = payload + 2 | payload | checksum(2)
 *   checksum = (PID + length bytes + payload bytes) & 0xFFFF
 *   PID 0x01 command, 0x02 data, 0x08 end-of-data, 0x07 acknowledge (first payload byte = confirmation code)
 */

const PID_COMMAND = 0x01;
const PID_DATA = 0x02;
const PID_ACK = 0x07;
const PID_END = 0x08;

const CMD = {
  GenImg: 0x01,
  Img2Tz: 0x02,
  Match: 0x03,
  Search: 0x04,
  RegModel: 0x05,
  Store: 0x06,
  LoadChar: 0x07,
  UpChar: 0x08,
  DownChar: 0x09,
  DeletChar: 0x0c,
  Empty: 0x0d,
  ReadSysPara: 0x0f,
  VfyPwd: 0x13,
  TemplateNum: 0x1d
} as const;

const CONFIRMATION: Record<number, string> = {
  0x00: 'OK',
  0x01: 'Error when receiving the packet',
  0x02: 'No finger on the sensor',
  0x03: 'Failed to capture the finger image',
  0x06: 'Fingerprint image too disordered (finger too wet, dry or moved)',
  0x07: 'Fingerprint image has too few feature points (place more of the finger on the sensor)',
  0x08: 'The fingerprints do not match',
  0x09: 'No matching fingerprint found in the library',
  0x0a: 'Failed to combine the two fingerprint captures',
  0x0b: 'Page ID is beyond the fingerprint library',
  0x0c: 'Error reading the template from the library, or the template is invalid',
  0x0d: 'Error uploading the template',
  0x0e: 'Module cannot receive the following data packets',
  0x0f: 'Error uploading the image',
  0x10: 'Failed to delete the template',
  0x11: 'Failed to clear the fingerprint library',
  0x13: 'Wrong sensor password',
  0x15: 'No valid primary image in the buffer',
  0x18: 'Error writing to flash',
  0x19: 'Undefined error',
  0x1a: 'Invalid register number',
  0x1b: 'Incorrect register configuration',
  0x1c: 'Wrong notepad page number',
  0x1d: 'Failed to operate the communication port',
  0x1f: 'Fingerprint library is full',
  0x20: 'Module address is incorrect',
  0x21: 'Password must be verified first'
};

export const confirmationText = (code: number) => CONFIRMATION[code] ?? `Unknown confirmation code 0x${code.toString(16).padStart(2, '0')}`;

interface Packet {
  pid: number;
  data: Buffer;
}

export interface SerialZfmOptions {
  path: string;
  baudRate: number;
  address: number;
  password: number;
  /** Raw module score that maps to 100 on the platform's 0–100 scale. */
  scoreScale: number;
}

export class SerialZfmSensor implements FingerprintSensor {
  readonly name: string;
  readonly production = true;
  readonly templateFormat = 'ZFM-CHAR';
  readonly autoScan = true;
  capacity = 0;
  private port: SerialPort | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private queue: Packet[] = [];
  private waiter: ((p: Packet) => void) | null = null;
  private packetSize = 128;

  constructor(private opts: SerialZfmOptions) {
    this.name = `ZFM/R30x on ${opts.path} @ ${opts.baudRate}`;
  }

  // ───────────── transport ─────────────
  async open() {
    const port = new SerialPort({ path: this.opts.path, baudRate: this.opts.baudRate, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(new SensorError(`Cannot open ${this.opts.path}: ${err.message}`, 'port')) : resolve())));
    this.port = port;
    port.on('data', (chunk: Buffer) => this.onData(chunk));
    port.on('error', () => undefined);
    // Modules need ~200–500 ms after power-up before they answer.
    await sleep(300);
    try {
      const pwd = Buffer.alloc(4);
      pwd.writeUInt32BE(this.opts.password >>> 0);
      const r = await this.command(CMD.VfyPwd, pwd, 1500);
      if (r.code !== 0) throw new SensorError(`Sensor password rejected: ${confirmationText(r.code)}`, r.code);
    } catch (err) {
      await this.close();
      if (err instanceof SensorError && err.code !== 'timeout') throw err;
      throw new SensorError(
        `No response from the fingerprint module on ${this.opts.path} at ${this.opts.baudRate} baud. Check wiring (module TX → adapter RX, module RX → adapter TX), power and SENSOR_BAUD.`,
        'no_response'
      );
    }
    const sys = await this.command(CMD.ReadSysPara);
    if (sys.code !== 0) throw new SensorError(`ReadSysPara failed: ${confirmationText(sys.code)}`, sys.code);
    // status(2) systemId(2) librarySize(2) securityLevel(2) address(4) packetSizeCode(2) baudMultiplier(2)
    this.capacity = sys.data.readUInt16BE(4);
    this.packetSize = [32, 64, 128, 256][sys.data.readUInt16BE(12)] ?? 128;
  }

  async close() {
    const port = this.port;
    this.port = null;
    if (port?.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  private onData(chunk: Buffer) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.rx.length; i++) {
        if (this.rx[i] === 0xef && this.rx[i + 1] === 0x01) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        this.rx = this.rx.subarray(Math.max(0, this.rx.length - 1));
        return;
      }
      if (start > 0) this.rx = this.rx.subarray(start);
      if (this.rx.length < 9) return;
      const len = this.rx.readUInt16BE(7);
      const total = 9 + len;
      if (len < 2 || len > 1024) {
        this.rx = this.rx.subarray(2); // corrupt length; resynchronise on the next header
        continue;
      }
      if (this.rx.length < total) return;
      const pkt = this.rx.subarray(0, total);
      let sum = 0;
      for (let i = 6; i < total - 2; i++) sum += pkt[i];
      if ((sum & 0xffff) !== pkt.readUInt16BE(total - 2)) {
        this.rx = this.rx.subarray(2);
        continue;
      }
      const packet: Packet = { pid: pkt[6], data: Buffer.from(pkt.subarray(9, total - 2)) };
      this.rx = this.rx.subarray(total);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(packet);
      } else {
        this.queue.push(packet);
      }
    }
  }

  private readPacket(timeoutMs: number): Promise<Packet> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Packet>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new SensorError('Fingerprint module did not respond in time', 'timeout'));
      }, timeoutMs);
      this.waiter = (p) => {
        clearTimeout(timer);
        resolve(p);
      };
    });
  }

  private frame(pid: number, payload: Buffer): Buffer {
    const len = payload.length + 2;
    const buf = Buffer.alloc(9 + payload.length + 2);
    buf.writeUInt16BE(0xef01, 0);
    buf.writeUInt32BE(this.opts.address >>> 0, 2);
    buf[6] = pid;
    buf.writeUInt16BE(len, 7);
    payload.copy(buf, 9);
    let sum = pid + (len >> 8) + (len & 0xff);
    for (const b of payload) sum += b;
    buf.writeUInt16BE(sum & 0xffff, 9 + payload.length);
    return buf;
  }

  private async write(buf: Buffer) {
    const port = this.port;
    if (!port?.isOpen) throw new SensorError('Fingerprint module is not connected', 'port');
    await new Promise<void>((resolve, reject) => port.write(buf, (err) => (err ? reject(new SensorError(err.message, 'port')) : resolve())));
    await new Promise<void>((resolve, reject) => port.drain((err) => (err ? reject(new SensorError(err.message, 'port')) : resolve())));
  }

  private async command(cmd: number, params: Buffer = Buffer.alloc(0), timeoutMs = 2000): Promise<{ code: number; data: Buffer }> {
    this.queue = []; // drop stale packets from an earlier timed-out exchange
    await this.write(this.frame(PID_COMMAND, Buffer.concat([Buffer.from([cmd]), params])));
    for (;;) {
      const p = await this.readPacket(timeoutMs);
      if (p.pid !== PID_ACK) continue;
      return { code: p.data[0], data: p.data.subarray(1) };
    }
  }

  // ───────────── primitives ─────────────
  /** GenImg: true when a finger image was captured, false when no finger is present. */
  private async genImg(): Promise<boolean> {
    const r = await this.command(CMD.GenImg);
    if (r.code === 0x00) return true;
    if (r.code === 0x02 || r.code === 0x03) return false;
    throw new SensorError(`GenImg: ${confirmationText(r.code)}`, r.code);
  }

  private async img2Tz(bufferId: 1 | 2) {
    const r = await this.command(CMD.Img2Tz, Buffer.from([bufferId]));
    if (r.code === 0x00) return;
    if (r.code === 0x06 || r.code === 0x07 || r.code === 0x15) throw new PoorImageError(confirmationText(r.code), r.code);
    throw new SensorError(`Img2Tz: ${confirmationText(r.code)}`, r.code);
  }

  private async waitForFinger(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.genImg()) return;
      await sleep(60);
    } while (Date.now() < deadline);
    throw new NoFingerError();
  }

  private async waitForRemoval(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.genImg())) return;
      await sleep(100);
    }
    throw new SensorError('Finger was not lifted from the sensor', 'not_lifted');
  }

  private scale(raw: number) {
    return clamp(Math.round((raw * 100) / this.opts.scoreScale), 0, 100);
  }

  private async upChar(bufferId: 1 | 2): Promise<Buffer> {
    const r = await this.command(CMD.UpChar, Buffer.from([bufferId]));
    if (r.code !== 0) throw new SensorError(`UpChar: ${confirmationText(r.code)}`, r.code);
    const parts: Buffer[] = [];
    for (;;) {
      const p = await this.readPacket(3000);
      if (p.pid !== PID_DATA && p.pid !== PID_END) continue;
      parts.push(p.data);
      if (p.pid === PID_END) break;
      if (parts.length > 64) throw new SensorError('UpChar: template transfer did not terminate', 'protocol');
    }
    return Buffer.concat(parts);
  }

  private async downChar(bufferId: 1 | 2, template: Buffer) {
    const r = await this.command(CMD.DownChar, Buffer.from([bufferId]));
    if (r.code !== 0) throw new SensorError(`DownChar: ${confirmationText(r.code)}`, r.code);
    for (let off = 0; off < template.length; off += this.packetSize) {
      const chunk = template.subarray(off, off + this.packetSize);
      const last = off + this.packetSize >= template.length;
      await this.write(this.frame(last ? PID_END : PID_DATA, chunk));
    }
    // The module needs a moment to assemble the character file before the next command.
    await sleep(20);
  }

  private page(slot: number): Buffer {
    if (!Number.isInteger(slot) || slot < 0 || (this.capacity && slot >= this.capacity)) throw new SensorError(`Slot ${slot} outside library 0..${this.capacity - 1}`, 'slot');
    const b = Buffer.alloc(2);
    b.writeUInt16BE(slot);
    return b;
  }

  // ───────────── FingerprintSensor ─────────────
  async identify(opts: IdentifyOptions): Promise<IdentifyResult | null> {
    await this.waitForFinger(opts.timeoutMs);
    await this.img2Tz(1);
    const params = Buffer.alloc(5);
    params[0] = 1;
    params.writeUInt16BE(0, 1);
    params.writeUInt16BE(this.capacity || 0xffff, 3);
    const r = await this.command(CMD.Search, params, 5000);
    if (r.code === 0x09) return null;
    if (r.code !== 0x00) throw new SensorError(`Search: ${confirmationText(r.code)}`, r.code);
    return { slot: r.data.readUInt16BE(0), score: this.scale(r.data.readUInt16BE(2)) };
  }

  async capture(opts: CaptureOptions): Promise<CaptureResult> {
    opts.prompt?.('Place the finger on the sensor');
    await this.waitForFinger(opts.timeoutMs);
    await this.img2Tz(1);
    opts.prompt?.('Lift the finger');
    await this.waitForRemoval(15_000);
    opts.prompt?.('Place the same finger again');
    await this.waitForFinger(opts.timeoutMs);
    await this.img2Tz(2);
    // Quality: both images converted (Img2Tz OK) + agreement between the two captures.
    const m = await this.command(CMD.Match);
    if (m.code === 0x08) throw new PoorImageError('The two captures do not match — use the same finger and press flat', 0x08);
    if (m.code !== 0x00) throw new SensorError(`Match: ${confirmationText(m.code)}`, m.code);
    const quality = this.scale(m.data.readUInt16BE(0));
    const reg = await this.command(CMD.RegModel);
    if (reg.code === 0x0a) throw new PoorImageError(confirmationText(reg.code), reg.code);
    if (reg.code !== 0x00) throw new SensorError(`RegModel: ${confirmationText(reg.code)}`, reg.code);
    const template = await this.upChar(1);
    if (template.length < 16) throw new SensorError('Template read from the module is too short', 'protocol');
    return { template, quality };
  }

  async store(slot: number, template: Buffer) {
    const page = this.page(slot);
    await this.downChar(1, template);
    const r = await this.command(CMD.Store, Buffer.concat([Buffer.from([1]), page]), 3000);
    if (r.code !== 0) throw new SensorError(`Store to slot ${slot}: ${confirmationText(r.code)}`, r.code);
  }

  /** Read a stored template back from the library (LoadChar + UpChar). */
  async load(slot: number): Promise<Buffer> {
    const r = await this.command(CMD.LoadChar, Buffer.concat([Buffer.from([1]), this.page(slot)]));
    if (r.code !== 0) throw new SensorError(`LoadChar slot ${slot}: ${confirmationText(r.code)}`, r.code);
    return this.upChar(1);
  }

  async remove(slot: number) {
    const count = Buffer.alloc(2);
    count.writeUInt16BE(1);
    const r = await this.command(CMD.DeletChar, Buffer.concat([this.page(slot), count]), 3000);
    if (r.code !== 0) throw new SensorError(`Delete slot ${slot}: ${confirmationText(r.code)}`, r.code);
  }

  async clear() {
    const r = await this.command(CMD.Empty, Buffer.alloc(0), 10_000);
    if (r.code !== 0) throw new SensorError(`Empty library: ${confirmationText(r.code)}`, r.code);
  }

  async count() {
    const r = await this.command(CMD.TemplateNum);
    if (r.code !== 0) throw new SensorError(`TemplateNum: ${confirmationText(r.code)}`, r.code);
    return r.data.readUInt16BE(0);
  }
}
