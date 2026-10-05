import { z } from 'zod';
import type { Db } from '../db/pool.js';

/**
 * WebAttendance — the exact body BAMP's adapter POSTs to {attendancePath}
 * (backend/src/integration/webAdapter.ts). Unknown extra properties are ignored.
 */
export const webAttendanceSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  webReferenceId: z.string().trim().min(1).max(64),
  staffNumber: z.string().trim().min(1).max(64),
  locationRef: z.string().trim().min(1).max(64).nullable(),
  direction: z.enum(['in', 'out']),
  capturedAt: z.string().datetime({ offset: true, message: 'capturedAt must be an ISO-8601 timestamp with Z or a UTC offset' }),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  matchScore: z.number().int().min(0).max(100),
  deviceId: z.string().trim().min(1).max(128)
});

export type WebAttendance = z.infer<typeof webAttendanceSchema>;

/** Attendance captured further than this in the future is refused as a device clock fault. */
const MAX_FUTURE_SKEW_MS = 24 * 3600 * 1000;

export type RecordOutcome =
  | { kind: 'created'; id: number; receivedAt: Date }
  | { kind: 'duplicate'; id: number | null; reason: string }
  | { kind: 'rejected'; code: 'unknown_employee' | 'employee_not_active' | 'unknown_location' | 'captured_in_future'; message: string };

const INACTIVE_STATUSES = new Set(['terminated', 'inactive']);

/**
 * Validates business rules and stores one attendance record. Shared by the API (`POST /attendance`) and
 * scheduled-export imports so both channels behave identically.
 *
 *  - duplicate eventId or Idempotency-Key            → duplicate (HTTP 409)
 *  - unknown webReferenceId                           → rejected  (HTTP 422)
 *  - employee terminated / inactive at capturedAt     → rejected  (HTTP 422)
 *  - unknown locationRef                              → rejected  (HTTP 422)
 */
export async function recordAttendance(
  db: Db,
  ev: WebAttendance,
  opts: { source: 'api' | 'import'; idempotencyKey?: string | null; importFileId?: number | null }
): Promise<RecordOutcome> {
  const idem = opts.idempotencyKey?.trim() || null;

  const dup = await db.query<{ id: number; event_id: string }>(
    `SELECT id, event_id FROM attendance_records WHERE event_id=$1 OR ($2::text IS NOT NULL AND idempotency_key=$2) LIMIT 1`,
    [ev.eventId, idem]
  );
  if (dup.rows[0]) {
    const same = dup.rows[0].event_id === ev.eventId;
    return {
      kind: 'duplicate',
      id: dup.rows[0].id,
      reason: same ? `Event ${ev.eventId} is already recorded` : `Idempotency-Key ${idem} was already used for event ${dup.rows[0].event_id}`
    };
  }

  const capturedAt = new Date(ev.capturedAt);
  if (capturedAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS)
    return { kind: 'rejected', code: 'captured_in_future', message: `capturedAt ${ev.capturedAt} is more than 24 hours in the future` };

  const emp = (await db.query<{ web_reference_id: string }>('SELECT web_reference_id FROM employees WHERE web_reference_id=$1', [ev.webReferenceId])).rows[0];
  if (!emp) return { kind: 'rejected', code: 'unknown_employee', message: `Unknown employee ${ev.webReferenceId}` };

  // Status in effect at the capture instant; before the first recorded status, the initial status applies.
  const st = (
    await db.query<{ status: string; effective_at: Date }>(
      `SELECT status, effective_at FROM (
         (SELECT status, effective_at, 0 AS pri FROM employee_status_history
           WHERE web_reference_id=$1 AND effective_at <= $2 ORDER BY effective_at DESC, id DESC LIMIT 1)
         UNION ALL
         (SELECT status, effective_at, 1 AS pri FROM employee_status_history
           WHERE web_reference_id=$1 ORDER BY effective_at ASC, id ASC LIMIT 1)
       ) s ORDER BY pri LIMIT 1`,
      [ev.webReferenceId, capturedAt]
    )
  ).rows[0];
  if (st && INACTIVE_STATUSES.has(st.status)) {
    return {
      kind: 'rejected',
      code: 'employee_not_active',
      message: `Employee ${ev.webReferenceId} was ${st.status} at ${capturedAt.toISOString()} (effective ${st.effective_at.toISOString()})`
    };
  }

  if (ev.locationRef !== null) {
    const loc = await db.query('SELECT 1 FROM locations WHERE ref=$1', [ev.locationRef]);
    if (!loc.rowCount) return { kind: 'rejected', code: 'unknown_location', message: `Unknown location ${ev.locationRef}` };
  }

  const ins = await db.query<{ id: number; received_at: Date }>(
    `INSERT INTO attendance_records (event_id, idempotency_key, web_reference_id, staff_number, location_ref, direction, captured_at,
                                     timezone_offset_minutes, match_score, device_id, source, import_file_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT DO NOTHING
     RETURNING id, received_at`,
    [
      ev.eventId,
      idem,
      ev.webReferenceId,
      ev.staffNumber,
      ev.locationRef,
      ev.direction,
      capturedAt,
      ev.timezoneOffsetMinutes,
      ev.matchScore,
      ev.deviceId,
      opts.source,
      opts.importFileId ?? null
    ]
  );
  const row = ins.rows[0];
  // Lost a race with a concurrent delivery of the same event.
  if (!row) return { kind: 'duplicate', id: null, reason: `Event ${ev.eventId} is already recorded` };
  return { kind: 'created', id: row.id, receivedAt: row.received_at };
}
