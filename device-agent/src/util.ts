import { createHash, randomBytes } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Serialises async work (e.g. every operation on the single UART-attached fingerprint module). */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get busy() {
    return this.depth > 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const p = this.last.then(fn).finally(() => {
      this.depth--;
    });
    this.last = p.catch(() => undefined);
    return p;
  }
}

/** Exponential backoff with full jitter. */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 60_000) {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

/**
 * Repeats `fn` forever with a (possibly changing) interval; never overlaps runs.
 * Returns a handle to stop the loop or to run it immediately.
 */
export function every(intervalMs: () => number, fn: () => Promise<void>, opts: { immediate?: boolean; onError?: (err: unknown) => void } = {}) {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = async () => {
    if (stopped) return;
    if (running) return running;
    running = (async () => {
      try {
        await fn();
      } catch (err) {
        opts.onError?.(err);
      } finally {
        running = null;
      }
    })();
    await running;
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), Math.max(250, intervalMs()));
    timer.unref?.();
  };
  if (opts.immediate) setImmediate(() => void run());
  else schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    now: run,
    reschedule: schedule
  };
}

export const randomNonce = () => randomBytes(18).toString('base64url');

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
