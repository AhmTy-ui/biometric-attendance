import { randomBytes } from 'node:crypto';

/**
 * Device clock. Terminals often have poor RTCs, so the offset measured against the platform's clock
 * (HTTP Date header / serverTime) is applied to request signatures and capture timestamps.
 */
let clockOffsetMs = 0;

export const now = () => Date.now() + clockOffsetMs;
export const getClockOffset = () => clockOffsetMs;

/** Adopt the server clock when the local clock differs by more than `thresholdMs`. */
export function observeServerTime(serverMs: number, thresholdMs = 2000): boolean {
  if (!Number.isFinite(serverMs)) return false;
  const diff = serverMs - Date.now();
  if (Math.abs(diff - clockOffsetMs) > thresholdMs) {
    clockOffsetMs = Math.abs(diff) > thresholdMs ? diff : 0;
    return true;
  }
  return false;
}

export function setClockOffset(ms: number) {
  clockOffsetMs = Number.isFinite(ms) ? ms : 0;
}

// ───────────── Time zones ─────────────
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset (minutes east of UTC) of time zone `tz` at instant `ms`; system zone when tz is undefined. */
export function tzOffsetMinutes(ms: number, tz?: string): number {
  if (!tz) return -new Date(ms).getTimezoneOffset();
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** ISO-8601 with the local offset of `tz`, e.g. 2026-09-28T08:01:12.345+01:00 */
export function isoWithOffset(ms: number, tz?: string): string {
  const off = tzOffsetMinutes(ms, tz);
  const local = new Date(ms + off * 60000).toISOString().slice(0, 23);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export const localDate = (ms: number, tz?: string) => isoWithOffset(ms, tz).slice(0, 10);
export const localTime = (ms: number, tz?: string) => isoWithOffset(ms, tz).slice(11, 19);

// ───────────── ULID (time-sortable unique id) ─────────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlidTime = -1;
let lastUlidRandom = 0n;
const RANDOM_MAX = (1n << 80n) - 1n;

/** Monotonic ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (26 chars). */
export function ulid(ms: number = now()): string {
  let t = Math.floor(ms);
  let r: bigint;
  if (t <= lastUlidTime) {
    t = lastUlidTime;
    r = lastUlidRandom + 1n;
    if (r > RANDOM_MAX) {
      t += 1;
      r = BigInt('0x' + randomBytes(10).toString('hex'));
    }
  } else {
    r = BigInt('0x' + randomBytes(10).toString('hex'));
  }
  lastUlidTime = t;
  lastUlidRandom = r;
  let timePart = '';
  let tt = t;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[tt % 32] + timePart;
    tt = Math.floor(tt / 32);
  }
  let randPart = '';
  let rr = r;
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(rr & 31n)] + randPart;
    rr >>= 5n;
  }
  return timePart + randPart;
}
