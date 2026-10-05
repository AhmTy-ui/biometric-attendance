import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { rootCertificates } from 'node:tls';
import { Agent, request, type Dispatcher } from 'undici';
import { log } from './logs.js';
import type { Runtime } from './state.js';
import { now, observeServerTime } from './time.js';
import { backoffDelay, errMsg, randomNonce, sha256Hex, sleep } from './util.js';

/**
 * Signed HTTPS client for the durable device channel (NFR-1.3 / NFR-1.4).
 *
 *   X-Device-Id, X-Timestamp (unix s), X-Nonce (random ≥16 chars, single use),
 *   X-Signature = hex HMAC-SHA256(secret, METHOD\nPATH(with query)\nTIMESTAMP\nNONCE\nsha256hex(body))
 *
 * mirrors backend/src/lib/crypto.ts deviceSignature().
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly transient: boolean,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  readonly transient = true;
  constructor(message: string, readonly causeCode?: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface DeviceCredentials {
  deviceUid: string;
  secret: string;
}

export interface HttpOptions {
  baseUrl: () => string | undefined;
  credentials: () => DeviceCredentials | null;
  caPems: () => string[];
  runtime?: Runtime;
}

export interface RequestOptions {
  body?: unknown;
  signed?: boolean;
  retries?: number;
  timeoutMs?: number;
}

export function signRequest(secret: string, method: string, path: string, timestamp: string, nonce: string, body: Buffer) {
  const canonical = [method.toUpperCase(), path, timestamp, nonce, sha256Hex(body)].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class DeviceHttp {
  private agent: Agent | null = null;
  private agentKey = '';

  constructor(private opts: HttpOptions) {}

  private dispatcher(): Dispatcher {
    const custom = this.opts.caPems().filter(Boolean);
    const key = createHash('sha256').update(custom.join('\n')).digest('hex');
    if (!this.agent || key !== this.agentKey) {
      void this.agent?.close().catch(() => undefined);
      this.agent = new Agent({
        connect: { ca: custom.length ? [...rootCertificates, ...custom] : undefined, rejectUnauthorized: true, timeout: 10_000 },
        keepAliveTimeout: 30_000,
        headersTimeout: 30_000,
        bodyTimeout: 120_000
      });
      this.agentKey = key;
    }
    return this.agent;
  }

  async close() {
    await this.agent?.close().catch(() => undefined);
    this.agent = null;
  }

  private base(): string {
    const b = this.opts.baseUrl();
    if (!b) throw new ApiError(0, 'not_configured', 'BAMP_API_URL is not configured', false);
    return b.replace(/\/+$/, '');
  }

  private headers(method: string, path: string, body: Buffer, signed: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', 'user-agent': 'bamp-device-agent' };
    if (body.length) h['content-type'] = 'application/json';
    if (signed) {
      const cred = this.opts.credentials();
      if (!cred) throw new ApiError(0, 'not_activated', 'Device is not activated', false);
      const ts = String(Math.floor(now() / 1000));
      const nonce = randomNonce();
      h['x-device-id'] = cred.deviceUid;
      h['x-timestamp'] = ts;
      h['x-nonce'] = nonce;
      h['x-signature'] = signRequest(cred.secret, method, path, ts, nonce, body);
    }
    return h;
  }

  private noteReachable(ok: boolean) {
    this.opts.runtime?.setHttps(ok ? 'up' : 'down');
  }

  private noteDate(headers: Record<string, string | string[] | undefined>) {
    const d = headers['date'];
    const v = Array.isArray(d) ? d[0] : d;
    if (v) observeServerTime(Date.parse(v), 3000);
  }

  /** One HTTP exchange; returns the raw undici response. Throws NetworkError on transport failures. */
  private async exchange(method: string, path: string, body: Buffer, signed: boolean, timeoutMs: number) {
    const url = this.base() + path;
    try {
      const res = await request(url, {
        method: method as Dispatcher.HttpMethod,
        headers: this.headers(method, path, body, signed),
        body: body.length ? body : undefined,
        dispatcher: this.dispatcher(),
        headersTimeout: timeoutMs,
        bodyTimeout: Math.max(timeoutMs, 60_000),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 60_000) + 5_000)
      });
      this.noteReachable(true);
      this.noteDate(res.headers);
      return res;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      this.noteReachable(false);
      const code = (err as { code?: string }).code;
      throw new NetworkError(`${method} ${path}: ${errMsg(err)}`, code);
    }
  }

  private static async errorFrom(res: Dispatcher.ResponseData): Promise<ApiError> {
    const text = await res.body.text().catch(() => '');
    let code = `http_${res.statusCode}`;
    let message = text.slice(0, 300) || `HTTP ${res.statusCode}`;
    let details: unknown;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
      if (j.error) {
        code = j.error.code ?? code;
        message = j.error.message ?? message;
        details = j.error.details;
      }
    } catch {
      /* non-JSON error body */
    }
    const transient = TRANSIENT_STATUS.has(res.statusCode) || (res.statusCode === 401 && (code === 'stale_request' || code === 'replay'));
    return new ApiError(res.statusCode, code, message, transient, details);
  }

  /** JSON request with retry + exponential backoff for transient failures. */
  async request<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    const signed = opts.signed ?? true;
    const retries = opts.retries ?? 3;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const body = opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body), 'utf8');
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.exchange(method, path, body, signed, timeoutMs);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const text = await res.body.text();
          return (text ? JSON.parse(text) : {}) as T;
        }
        throw await DeviceHttp.errorFrom(res);
      } catch (err) {
        const transient = (err instanceof ApiError || err instanceof NetworkError) && err.transient;
        if (!transient || attempt >= retries) throw err;
        const delay = err instanceof ApiError && err.status === 401 ? 200 : backoffDelay(attempt, 1000, 20_000);
        log.debug({ path, attempt, delay, err: errMsg(err) }, 'transient HTTPS failure; retrying');
        attempt++;
        await sleep(delay);
      }
    }
  }

  /** Stream a (signed) binary download to `dest`, returning its SHA-256 and size. */
  async download(path: string, dest: string, retries = 2): Promise<{ sha256: string; size: number; headerSha256: string | null }> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.exchange('GET', path, Buffer.alloc(0), true, 60_000);
        if (res.statusCode < 200 || res.statusCode >= 300) throw await DeviceHttp.errorFrom(res);
        const hash = createHash('sha256');
        let size = 0;
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
          }
        });
        await pipeline(res.body, tap, createWriteStream(dest, { mode: 0o600 }));
        const h = res.headers['x-sha256'];
        return { sha256: hash.digest('hex'), size, headerSha256: (Array.isArray(h) ? h[0] : h) ?? null };
      } catch (err) {
        await rm(dest, { force: true }).catch(() => undefined);
        const transient = (err instanceof ApiError || err instanceof NetworkError) && err.transient;
        if (!transient || attempt >= retries) throw err;
        await sleep(backoffDelay(attempt, 2000, 30_000));
        attempt++;
      }
    }
  }
}
