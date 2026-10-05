import { z } from 'zod';
import { pool } from '../db/pool.js';
import { isValidTimeZone } from '../lib/time.js';

export interface LocationRow {
  ref: string;
  name: string;
  address: string | null;
  timezone: string | null;
  created_at: Date;
  updated_at: Date;
  employee_count?: number;
  active_count?: number;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .transform((v) => (v === '' ? null : v));

export const locationFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Must be at most 120 characters'),
  address: optionalText(500),
  timezone: optionalText(64).refine((v) => v === null || isValidTimeZone(v), 'Unknown IANA time zone (e.g. Africa/Lagos)')
});

export const locationCreate = locationFields.extend({
  ref: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, 'Use 1–32 letters, digits, dot, dash or underscore, starting with a letter or digit')
});

export class LocationError extends Error {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message);
  }
}

export async function listLocations(): Promise<LocationRow[]> {
  return (
    await pool.query<LocationRow>(
      `SELECT l.*, count(e.web_reference_id)::int AS employee_count,
              count(e.web_reference_id) FILTER (WHERE e.employment_status='active')::int AS active_count
         FROM locations l LEFT JOIN employees e ON e.location_ref=l.ref
        GROUP BY l.ref ORDER BY l.name, l.ref`
    )
  ).rows;
}

export async function getLocation(ref: string): Promise<LocationRow | null> {
  return (await pool.query<LocationRow>('SELECT * FROM locations WHERE ref=$1', [ref])).rows[0] ?? null;
}

export async function createLocation(input: z.infer<typeof locationCreate>): Promise<LocationRow> {
  try {
    return (
      await pool.query<LocationRow>(`INSERT INTO locations (ref, name, address, timezone) VALUES ($1,$2,$3,$4) RETURNING *`, [
        input.ref,
        input.name,
        input.address,
        input.timezone
      ])
    ).rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new LocationError(`A location with reference "${input.ref}" already exists`, 'ref');
    throw err;
  }
}

export async function updateLocation(ref: string, input: z.infer<typeof locationFields>): Promise<LocationRow | null> {
  return (
    (
      await pool.query<LocationRow>(`UPDATE locations SET name=$2, address=$3, timezone=$4 WHERE ref=$1 RETURNING *`, [
        ref,
        input.name,
        input.address,
        input.timezone
      ])
    ).rows[0] ?? null
  );
}
