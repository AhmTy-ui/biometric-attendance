/** Timezone helpers built on Intl (no external dependencies). */

const zoneCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = zoneCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    zoneCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZoneList(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock value from an <input type="datetime-local"> ("YYYY-MM-DDTHH:mm[:ss]") in `timeZone`
 * to a UTC instant. Returns null when the input is malformed.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v))) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall - zoneOffsetMs(timeZone, wall);
  const second = zoneOffsetMs(timeZone, utc);
  if (wall - second !== utc) utc = wall - second;
  return new Date(utc);
}

/** Formats an instant as "YYYY-MM-DD HH:mm:ss" in `timeZone`. */
export function formatInZone(d: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(d)) if (p.type !== 'literal') parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Formats an instant as the local wall-clock time implied by a fixed UTC offset, e.g. "2026-09-28 08:02:11 +01:00". */
export function formatWithOffset(d: Date, offsetMinutes: number): string {
  const local = new Date(d.getTime() + offsetMinutes * 60_000).toISOString();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${local.slice(0, 10)} ${local.slice(11, 19)} ${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** "YYYY-MM-DDTHH:mm" in `timeZone`, suitable as the value of a datetime-local input. */
export function toDatetimeLocal(d: Date, timeZone: string): string {
  return formatInZone(d, timeZone).slice(0, 16).replace(' ', 'T');
}
