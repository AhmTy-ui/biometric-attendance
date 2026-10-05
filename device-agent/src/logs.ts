import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { DeviceHttp } from './http.js';
import type { LogEntry, Store } from './store.js';
import { errMsg, every } from './util.js';

/**
 * Logging: pino → local rotating file + the SQLite log buffer, which is uploaded to the platform every 60 s
 * (POST /device/v1/logs) so operators can read device logs from the dashboard.
 */

export let log: pino.Logger = pino({ level: 'warn', base: undefined }, pino.destination(2));

const LEVELS: Record<number, LogEntry['level']> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
const OMIT = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);
const MAX_LOG_FILE = 10 * 1024 * 1024;

let pendingEntries: LogEntry[] = [];
let bufferStore: Store | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function toEntry(line: string): LogEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const level = LEVELS[Number(obj.level)] ?? 'info';
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!OMIT.has(k)) context[k] = v;
  let ctx: unknown = Object.keys(context).length ? context : undefined;
  if (ctx !== undefined && JSON.stringify(ctx).length > 8000) ctx = { truncated: true, keys: Object.keys(context) };
  return {
    level,
    message: String(obj.msg ?? '').slice(0, 4000) || '(no message)',
    context: ctx,
    loggedAt: new Date(typeof obj.time === 'number' ? obj.time : Date.now()).toISOString()
  };
}

const bufferStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = toEntry(line);
      if (e) pendingEntries.push(e);
    }
    if (pendingEntries.length > 5000) pendingEntries = pendingEntries.slice(-5000);
    cb();
  }
});

function flushToStore() {
  if (!bufferStore || !pendingEntries.length) return;
  const batch = pendingEntries;
  pendingEntries = [];
  try {
    bufferStore.appendLogs(batch);
  } catch {
    /* database busy/closing — entries are still in the local log file */
  }
}

/** Configure the process logger. Call once at startup of `run`. */
export function initLogger(dataDir: string, level: string, alsoStdout: boolean) {
  const dir = join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent.log');
  if (existsSync(file) && statSync(file).size > MAX_LOG_FILE) {
    rmSync(`${file}.2`, { force: true });
    if (existsSync(`${file}.1`)) renameSync(`${file}.1`, `${file}.2`);
    renameSync(file, `${file}.1`);
  }
  const streams: pino.StreamEntry[] = [
    { level: level as pino.Level, stream: pino.destination({ dest: file, mkdir: true, sync: false }) },
    { level: 'info', stream: bufferStream }
  ];
  if (alsoStdout) streams.push({ level: level as pino.Level, stream: pino.destination(1) });
  log = pino({ level: level === 'trace' || level === 'debug' ? level : 'info', base: { pid: process.pid } }, pino.multistream(streams));
  return log;
}

/** Attach the durable store as the log buffer (entries logged before this are kept in memory and flushed). */
export function attachLogBuffer(store: Store) {
  bufferStore = store;
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flushToStore, 2000);
  flushTimer.unref();
}

export function detachLogBuffer() {
  flushToStore();
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  bufferStore = null;
}

export class LogUploader {
  private loop: ReturnType<typeof every> | null = null;

  constructor(
    private store: Store,
    private http: DeviceHttp
  ) {}

  start() {
    this.loop = every(() => 60_000, () => this.upload(), { onError: () => undefined });
  }

  stop() {
    this.loop?.stop();
  }

  async upload() {
    flushToStore();
    for (let round = 0; round < 5; round++) {
      const entries = this.store.peekLogs(1000);
      if (!entries.length) return;
      try {
        await this.http.request('POST', '/device/v1/logs', {
          body: { entries: entries.map(({ level, message, context, loggedAt }) => ({ level, message, context, loggedAt })) },
          retries: 1
        });
      } catch (err) {
        // Do not log at info+ here: a failing upload would feed the buffer it is trying to drain.
        log.debug({ err: errMsg(err) }, 'log upload deferred');
        return;
      }
      this.store.deleteLogsUpTo(entries[entries.length - 1].id!);
      if (entries.length < 1000) return;
    }
  }
}
