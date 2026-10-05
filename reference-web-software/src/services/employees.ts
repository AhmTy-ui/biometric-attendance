import { z } from 'zod';
import { pool, tx } from '../db/pool.js';

export const EMPLOYMENT_STATUSES = ['active', 'inactive', 'suspended', 'terminated'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export interface EmployeeRow {
  web_reference_id: string;
  staff_number: string;
  full_name: string;
  department: string | null;
  location_ref: string | null;
  employment_status: EmploymentStatus;
  created_at: Date;
  updated_at: Date;
  location_name?: string | null;
  location_timezone?: string | null;
}

export interface StatusHistoryRow {
  id: number;
  status: EmploymentStatus;
  effective_at: Date;
  recorded_at: Date;
  note: string | null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .transform((v) => (v === '' ? null : v));

export const employeeFields = z.object({
  staffNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/, 'Use 1–32 letters, digits, dot, dash, slash or underscore'),
  fullName: z.string().trim().min(1, 'Full name is required').max(160, 'Must be at most 160 characters'),
  department: optionalText(120),
  locationRef: optionalText(64),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES, { message: 'Choose a valid employment status' })
});
export type EmployeeInput = z.infer<typeof employeeFields>;

export class EmployeeError extends Error {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message);
  }
}

function translateDbError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint?.startsWith('employees_staff_number'))
    throw new EmployeeError('Another employee already has this staff number', 'staffNumber');
  if (e.code === '23503' && e.constraint?.includes('location')) throw new EmployeeError('The selected location does not exist', 'locationRef');
  throw err;
}

/** Integration API: page of employees ordered by last modification (BAMP incremental sync). */
export async function pageForApi(modifiedSince: Date | null, page: number, pageSize: number) {
  const where = modifiedSince ? 'WHERE updated_at >= $1' : '';
  const params: unknown[] = modifiedSince ? [modifiedSince] : [];
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM employees ${where}`, params)).rows[0]!.n;
  const rows = (
    await pool.query<EmployeeRow>(
      `SELECT * FROM employees ${where} ORDER BY updated_at ASC, web_reference_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    )
  ).rows;
  return {
    data: rows.map((r) => ({
      webReferenceId: r.web_reference_id,
      staffNumber: r.staff_number,
      fullName: r.full_name,
      department: r.department,
      locationRef: r.location_ref,
      employmentStatus: r.employment_status,
      lastModified: r.updated_at.toISOString()
    })),
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total
  };
}

export interface EmployeeFilter {
  q?: string;
  location?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export async function searchEmployees(f: EmployeeFilter) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    conds.push(`(e.full_name ILIKE ${p} OR e.staff_number ILIKE ${p} OR e.web_reference_id ILIKE ${p} OR e.department ILIKE ${p})`);
  }
  if (f.location === '__none') conds.push('e.location_ref IS NULL');
  else if (f.location) {
    params.push(f.location);
    conds.push(`e.location_ref = $${params.length}`);
  }
  if (f.status && (EMPLOYMENT_STATUSES as readonly string[]).includes(f.status)) {
    params.push(f.status);
    conds.push(`e.employment_status = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM employees e ${where}`, params)).rows[0]!.n;
  const rows = (
    await pool.query<EmployeeRow>(
      `SELECT e.*, l.name AS location_name FROM employees e LEFT JOIN locations l ON l.ref=e.location_ref ${where}
        ORDER BY e.full_name, e.web_reference_id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize]
    )
  ).rows;
  return { rows, total };
}

export async function statusCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = { active: 0, inactive: 0, suspended: 0, terminated: 0 };
  for (const r of (await pool.query<{ employment_status: string; n: number }>(
    'SELECT employment_status, count(*)::int AS n FROM employees GROUP BY 1'
  )).rows)
    out[r.employment_status] = r.n;
  return out;
}

export async function getEmployee(ref: string): Promise<EmployeeRow | null> {
  return (
    (
      await pool.query<EmployeeRow>(
        `SELECT e.*, l.name AS location_name, l.timezone AS location_timezone
           FROM employees e LEFT JOIN locations l ON l.ref=e.location_ref WHERE e.web_reference_id=$1`,
        [ref]
      )
    ).rows[0] ?? null
  );
}

export async function statusHistory(ref: string): Promise<StatusHistoryRow[]> {
  return (
    await pool.query<StatusHistoryRow>(
      'SELECT id, status, effective_at, recorded_at, note FROM employee_status_history WHERE web_reference_id=$1 ORDER BY effective_at DESC, id DESC',
      [ref]
    )
  ).rows;
}

export async function departments(): Promise<string[]> {
  return (
    await pool.query<{ department: string }>(
      'SELECT DISTINCT department FROM employees WHERE department IS NOT NULL ORDER BY department LIMIT 500'
    )
  ).rows.map((r) => r.department);
}

export async function createEmployee(input: EmployeeInput): Promise<EmployeeRow> {
  try {
    return await tx(async (db) => {
      const row = (
        await db.query<EmployeeRow>(
          `INSERT INTO employees (staff_number, full_name, department, location_ref, employment_status)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [input.staffNumber, input.fullName, input.department, input.locationRef, input.employmentStatus]
        )
      ).rows[0]!;
      await db.query(
        `INSERT INTO employee_status_history (web_reference_id, status, effective_at, note) VALUES ($1,$2,$3,'Employee record created')`,
        [row.web_reference_id, row.employment_status, row.created_at]
      );
      return row;
    });
  } catch (err) {
    translateDbError(err);
  }
}

export const employeeDetailFields = employeeFields.omit({ employmentStatus: true });
export type EmployeeDetails = z.infer<typeof employeeDetailFields>;

/** Updates identity and assignment (staff number, name, department, location). */
export async function updateEmployeeDetails(ref: string, input: EmployeeDetails): Promise<EmployeeRow | null> {
  try {
    return (
      (
        await pool.query<EmployeeRow>(
          `UPDATE employees SET staff_number=$2, full_name=$3, department=$4, location_ref=$5 WHERE web_reference_id=$1 RETURNING *`,
          [ref, input.staffNumber, input.fullName, input.department, input.locationRef]
        )
      ).rows[0] ?? null
    );
  } catch (err) {
    translateDbError(err);
  }
}

/**
 * Changes the employment status and records it in the status history with its effective instant. The effective
 * instant defaults to now and may be backdated (e.g. a termination recorded late), but never before the previous
 * status change and never in the future. Attendance captured on or after it is judged against the new status.
 */
export async function changeEmployeeStatus(
  ref: string,
  status: EmploymentStatus,
  effectiveAt: Date | null,
  note: string | null
): Promise<EmployeeRow | null> {
  return tx(async (db) => {
    const before = (await db.query<EmployeeRow>('SELECT * FROM employees WHERE web_reference_id=$1 FOR UPDATE', [ref])).rows[0];
    if (!before) return null;
    if (before.employment_status === status) throw new EmployeeError(`The employee is already ${status}`, 'status');
    const now = new Date();
    let effective = effectiveAt ?? now;
    if (effective.getTime() > now.getTime() + 60_000) throw new EmployeeError('The effective date cannot be in the future', 'effectiveAt');
    if (effective.getTime() > now.getTime()) effective = now;
    const last = (
      await db.query<{ effective_at: Date }>(
        'SELECT effective_at FROM employee_status_history WHERE web_reference_id=$1 ORDER BY effective_at DESC, id DESC LIMIT 1',
        [ref]
      )
    ).rows[0];
    if (last && effective.getTime() < last.effective_at.getTime())
      throw new EmployeeError(`The effective date cannot be earlier than the previous status change (${last.effective_at.toISOString()})`, 'effectiveAt');
    const row = (
      await db.query<EmployeeRow>('UPDATE employees SET employment_status=$2 WHERE web_reference_id=$1 RETURNING *', [ref, status])
    ).rows[0]!;
    await db.query('INSERT INTO employee_status_history (web_reference_id, status, effective_at, note) VALUES ($1,$2,$3,$4)', [
      ref,
      status,
      effective,
      note
    ]);
    return row;
  });
}

