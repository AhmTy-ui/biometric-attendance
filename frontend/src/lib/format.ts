const nf = new Intl.NumberFormat('en-US');

export const num = (n: number | string | null | undefined) => (n === null || n === undefined || n === '' ? '—' : nf.format(Number(n)));

export const pct = (n: number | string | null | undefined, digits = 1) =>
  n === null || n === undefined || n === '' ? '—' : `${Number(n).toFixed(digits)}%`;

export function dateTime(v: string | Date | null | undefined, tz?: string) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function date(v: string | Date | null | undefined, tz?: string) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' });
}

export function time(v: string | Date | null | undefined, tz?: string, withSeconds = true) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: false });
}

export function relative(v: string | Date | null | undefined) {
  if (!v) return 'never';
  const diff = Date.now() - new Date(v).getTime();
  const s = Math.round(diff / 1000);
  if (Math.abs(s) < 5) return 'just now';
  if (s < 0) return `in ${relativeAbs(-s)}`;
  return `${relativeAbs(s)} ago`;
}
function relativeAbs(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function bytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function initials(name: string | null | undefined) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export const FINGERS: Record<number, string> = {
  1: 'Right thumb',
  2: 'Right index',
  3: 'Right middle',
  4: 'Right ring',
  5: 'Right little',
  6: 'Left thumb',
  7: 'Left index',
  8: 'Left middle',
  9: 'Left ring',
  10: 'Left little'
};

export function humanize(s: string | null | undefined) {
  if (!s) return '—';
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function todayIso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function tzOffsetLabel(minutes: number) {
  const sign = minutes >= 0 ? '+' : '-';
  const a = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
