import { pool } from '../db/pool.js';

export interface AttendanceRow {
  id: number;
  event_id: string;
  web_reference_id: string;
  staff_number: string;
  full_name: string | null;
  location_ref: string | null;
  location_name: string | null;
  direction: 'in' | 'out';
  captured_at: Date;
  timezone_offset_minutes: number;
  match_score: number;
  device_id: string;
  received_at: Date;
  source: 'api' | 'import';
  import_file_id: number | null;
}

export interface AttendanceFilter {
  q?: string;
  employee?: string;
  location?: string;
  direction?: string;
  source?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listAttendance(f: AttendanceFilter) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, v: unknown) => {
    params.push(v);
    conds.push(sql(`$${params.length}`));
  };
  if (f.q) add((p) => `(a.web_reference_id ILIKE ${p} OR a.staff_number ILIKE ${p} OR e.full_name ILIKE ${p} OR a.event_id ILIKE ${p} OR a.device_id ILIKE ${p})`, like(f.q));
  if (f.employee) add((p) => `a.web_reference_id = ${p}`, f.employee);
  if (f.location === '__none') conds.push('a.location_ref IS NULL');
  else if (f.location) add((p) => `a.location_ref = ${p}`, f.location);
  if (f.direction === 'in' || f.direction === 'out') add((p) => `a.direction = ${p}`, f.direction);
  if (f.source === 'api' || f.source === 'import') add((p) => `a.source = ${p}`, f.source);
  // Dates are the local calendar date at the capture site (captured_at shifted by the recorded UTC offset).
  const localDate = `((a.captured_at AT TIME ZONE 'UTC') + make_interval(mins => a.timezone_offset_minutes))::date`;
  if (isDate(f.from)) add((p) => `${localDate} >= ${p}::date`, f.from);
  if (isDate(f.to)) add((p) => `${localDate} <= ${p}::date`, f.to);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const from = `FROM attendance_records a LEFT JOIN employees e ON e.web_reference_id=a.web_reference_id LEFT JOIN locations l ON l.ref=a.location_ref`;
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${from} ${where}`, params)).rows[0]!.n;
  const rows = (
    await pool.query<AttendanceRow>(
      `SELECT a.*, e.full_name, l.name AS location_name ${from} ${where}
        ORDER BY a.received_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize]
    )
  ).rows;
  return { rows, total };
}

export async function attendanceStats() {
  return (
    await pool.query<{ total: number; last_24h: number; last_received: Date | null }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last_24h,
              max(received_at) AS last_received FROM attendance_records`
    )
  ).rows[0]!;
}

export interface ImportRow {
  id: number;
  file_name: string;
  format: string;
  size_bytes: number;
  channel: 'api' | 'admin';
  received_at: Date;
  rows: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  errors: { row: number; eventId?: string; error: string }[];
}

export async function listImports(page: number, pageSize: number) {
  const total = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM import_files')).rows[0]!.n;
  const rows = (
    await pool.query<ImportRow>(
      `SELECT id, file_name, format, size_bytes, channel, received_at, rows, accepted, duplicates, rejected, '[]'::jsonb AS errors
         FROM import_files ORDER BY received_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize]
    )
  ).rows;
  return { rows, total };
}

export async function getImport(id: number): Promise<ImportRow | null> {
  return (await pool.query<ImportRow>('SELECT * FROM import_files WHERE id=$1', [id])).rows[0] ?? null;
}

export interface ApiLogRow {
  id: number;
  at: Date;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  remote_addr: string | null;
  detail: string | null;
}

export async function listApiLog(f: { outcome?: string; path?: string; page: number; pageSize: number }) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.outcome === '2xx') conds.push('status BETWEEN 200 AND 299');
  else if (f.outcome === '409') conds.push('status = 409');
  else if (f.outcome === '4xx') conds.push('status BETWEEN 400 AND 499');
  else if (f.outcome === '5xx') conds.push('status >= 500');
  if (f.path) {
    params.push(like(f.path));
    conds.push(`path ILIKE $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_request_log ${where}`, params)).rows[0]!.n;
  const rows = (
    await pool.query<ApiLogRow>(
      `SELECT * FROM api_request_log ${where} ORDER BY at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize]
    )
  ).rows;
  return { rows, total };
}

export async function apiLogSummary() {
  return (
    await pool.query<{ endpoint: string; calls: number; ok: number; client_errors: number; server_errors: number; last_at: Date | null }>(
      `SELECT CASE
                WHEN path LIKE '/api/v1/employees%' THEN 'employees'
                WHEN path LIKE '/api/v1/locations%' THEN 'locations'
                WHEN path LIKE '/api/v1/attendance/import%' THEN 'attendance/import'
                WHEN path LIKE '/api/v1/attendance%' THEN 'attendance'
                ELSE 'other' END AS endpoint,
              count(*)::int AS calls,
              count(*) FILTER (WHERE status < 400 OR status = 409)::int AS ok,
              count(*) FILTER (WHERE status BETWEEN 400 AND 499 AND status <> 409)::int AS client_errors,
              count(*) FILTER (WHERE status >= 500)::int AS server_errors,
              max(at) AS last_at
         FROM api_request_log WHERE at > now() - interval '24 hours'
        GROUP BY 1 ORDER BY 1`
    )
  ).rows;
}

export async function recordApiRequest(entry: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  remoteAddr: string | null;
  detail: string | null;
}) {
  await pool.query(
    'INSERT INTO api_request_log (method, path, status, duration_ms, remote_addr, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [entry.method, entry.path.slice(0, 500), entry.status, Math.round(entry.durationMs), entry.remoteAddr, entry.detail?.slice(0, 1000) ?? null]
  );
}

export async function pruneApiLog(retentionDays: number) {
  await pool.query(`DELETE FROM api_request_log WHERE at < now() - make_interval(days => $1)`, [retentionDays]);
}
