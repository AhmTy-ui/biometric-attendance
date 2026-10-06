import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { publishDashboard } from './mqtt.js';
import { getSettings } from './settings.js';
import { kickDelivery } from '../integration/delivery.js';

/** Event payload shared by the MQTT single-event path and the HTTPS batch path (FR-3.1). */
export const attendanceEventSchema = z.object({
  eventUid: z.string().min(8).max(100),
  employeeId: z.string().uuid(),
  direction: z.enum(['in', 'out']),
  capturedAt: z.string().datetime({ offset: true }),
  tzOffsetMinutes: z.number().int().min(-840).max(840),
  matchScore: z.number().int().min(0).max(100),
  fingerIndex: z.number().int().min(1).max(10).optional(),
  buffered: z.boolean().optional()
});
export type AttendanceEventInput = z.infer<typeof attendanceEventSchema>;

export interface DeviceRow {
  id: string;
  organization_id: string;
  device_uid: string;
  name: string;
  location_id: string | null;
}

export type IngestResult =
  | { eventUid: string; status: 'accepted'; id: string }
  | { eventUid: string; status: 'duplicate'; id: string }
  | { eventUid: string; status: 'rejected'; error: string };

/**
 * Idempotent ingestion (FR-3.2): the device-generated eventUid is unique per organisation, so a repeated
 * submission (MQTT redelivery, HTTPS batch retry, or the same event arriving on both channels) returns
 * success without creating a duplicate.
 */
export async function ingestEvent(device: DeviceRow, input: AttendanceEventInput, channel: 'mqtt' | 'https_batch'): Promise<IngestResult> {
  if (!device.location_id) return { eventUid: input.eventUid, status: 'rejected', error: 'Device has no assigned location' };
  const res = await tx(async (db) => {
    const emp = await db.query('SELECT id FROM employees WHERE id=$1 AND organization_id=$2', [input.employeeId, device.organization_id]);
    if (!emp.rowCount) return { eventUid: input.eventUid, status: 'rejected' as const, error: 'Unknown employee' };
    const ins = await db.query(
      `INSERT INTO attendance_events (organization_id, event_uid, employee_id, device_id, location_id, direction, captured_at,
                                      tz_offset_minutes, match_score, finger_index, channel, was_buffered)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, event_uid) DO NOTHING
       RETURNING id, received_at`,
      [
        device.organization_id,
        input.eventUid,
        input.employeeId,
        device.id,
        device.location_id,
        input.direction,
        input.capturedAt,
        input.tzOffsetMinutes,
        input.matchScore,
        input.fingerIndex ?? null,
        channel,
        input.buffered ?? channel === 'https_batch'
      ]
    );
    if (!ins.rowCount) {
      const existing = await db.query('SELECT id FROM attendance_events WHERE organization_id=$1 AND event_uid=$2', [
        device.organization_id,
        input.eventUid
      ]);
      return { eventUid: input.eventUid, status: 'duplicate' as const, id: existing.rows[0].id as string };
    }
    const eventId = ins.rows[0].id as string;
    await refreshDaily(db, device.organization_id, input.employeeId, device.location_id!, input.capturedAt);
    const integ = await getSettings(device.organization_id, 'integration', db);
    if (integ.deliveryMode !== 'disabled') {
      await db.query(`INSERT INTO attendance_deliveries (event_id, organization_id, status) VALUES ($1,$2,'pending')`, [
        eventId,
        device.organization_id
      ]);
    }
    const latency = Date.now() - new Date(input.capturedAt).getTime();
    if (!input.buffered && channel === 'mqtt' && latency >= 0 && latency < 3600_000) {
      await db.query('INSERT INTO ingest_latency (organization_id, capture_to_ingest_ms) VALUES ($1,$2)', [device.organization_id, latency]);
    }
    return { eventUid: input.eventUid, status: 'accepted' as const, id: eventId };
  });

  if (res.status === 'accepted') {
    void broadcastEvent(res.id).catch((err) => logger.warn({ err: err.message }, 'attendance broadcast failed'));
    kickDelivery();
  }
  return res;
}

/** Recompute the per-day record for (employee, location, local date). */
export async function refreshDaily(db: Db, orgId: string, employeeId: string, locationId: string, capturedAt: string | Date) {
  await db.query(
    `WITH loc AS (SELECT timezone, work_start, grace_minutes FROM locations WHERE id=$3),
          d AS (SELECT (($4::timestamptz) AT TIME ZONE loc.timezone)::date AS work_date, loc.* FROM loc),
          agg AS (
            SELECT min(e.captured_at) FILTER (WHERE e.direction='in')  AS first_in,
                   max(e.captured_at) FILTER (WHERE e.direction='out') AS last_out,
                   count(*)::int AS cnt
              FROM attendance_events e, d
             WHERE e.employee_id=$2 AND e.location_id=$3
               AND e.captured_at >= (d.work_date::timestamp AT TIME ZONE d.timezone)
               AND e.captured_at <  ((d.work_date + 1)::timestamp AT TIME ZONE d.timezone))
     INSERT INTO attendance_daily (organization_id, employee_id, location_id, work_date, first_in, last_out, event_count,
                                   is_late, minutes_late, worked_minutes, updated_at)
     SELECT $1, $2, $3, d.work_date, agg.first_in, agg.last_out, agg.cnt,
            COALESCE((agg.first_in AT TIME ZONE d.timezone)::time > d.work_start + make_interval(mins => d.grace_minutes), false),
            CASE WHEN agg.first_in IS NOT NULL AND (agg.first_in AT TIME ZONE d.timezone)::time > d.work_start + make_interval(mins => d.grace_minutes)
                 THEN (EXTRACT(epoch FROM ((agg.first_in AT TIME ZONE d.timezone)::time - d.work_start)) / 60)::int ELSE 0 END,
            CASE WHEN agg.first_in IS NOT NULL AND agg.last_out IS NOT NULL AND agg.last_out > agg.first_in
                 THEN (EXTRACT(epoch FROM (agg.last_out - agg.first_in)) / 60)::int END,
            now()
       FROM d, agg
     ON CONFLICT (employee_id, location_id, work_date) DO UPDATE
        SET first_in=EXCLUDED.first_in, last_out=EXCLUDED.last_out, event_count=EXCLUDED.event_count,
            is_late=EXCLUDED.is_late, minutes_late=EXCLUDED.minutes_late, worked_minutes=EXCLUDED.worked_minutes, updated_at=now()`,
    [orgId, employeeId, locationId, capturedAt]
  );
}

export const EVENT_SELECT = `
  SELECT e.id, e.organization_id, e.event_uid, e.direction, e.captured_at, e.tz_offset_minutes, e.match_score, e.finger_index, e.channel,
         e.was_buffered, e.received_at,
         e.employee_id, emp.full_name AS employee_name, emp.staff_number, emp.web_reference_id, emp.department,
         e.location_id, l.name AS location_name, l.code AS location_code, l.timezone AS location_timezone,
         e.device_id, dv.name AS device_name, dv.device_uid,
         d.status AS delivery_status, d.attempts AS delivery_attempts, d.next_attempt_at, d.last_error AS delivery_error,
         d.last_http_status AS delivery_http_status, d.delivered_at, d.last_attempt_at AS delivery_last_attempt_at
    FROM attendance_events e
    JOIN employees emp ON emp.id = e.employee_id
    JOIN locations l ON l.id = e.location_id
    JOIN devices dv ON dv.id = e.device_id
    LEFT JOIN attendance_deliveries d ON d.event_id = e.id`;

export async function broadcastEvent(eventId: string, kind = 'attendance/event') {
  const r = await pool.query(`${EVENT_SELECT} WHERE e.id=$1`, [eventId]);
  const row = r.rows[0];
  if (row) await publishDashboard(row.organization_id, kind, { ...row, locationId: row.location_id });
}
