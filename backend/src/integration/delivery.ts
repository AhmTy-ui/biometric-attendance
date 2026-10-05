import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { raiseAlert, resolveAlertByKey } from '../services/alerts.js';
import { publishDashboard } from '../services/mqtt.js';
import { getSettings } from '../services/settings.js';
import { IntegrationError, pushAttendance } from './webAdapter.js';

/**
 * Outbound delivery of attendance events to the web software (FR-1.4).
 * Transactional outbox in PostgreSQL; retries with exponential backoff + jitter; a dead-letter queue for events
 * the web software keeps rejecting (or that exhaust the retry budget), which raises an admin alert.
 */

const REJECTION_RETRIES = 3; // "Retry → Retry → Retry → Dead Letter Queue → Admin Alert"
let running = false;
let rerun = false;
let timer: NodeJS.Timeout | null = null;

export function kickDelivery() {
  if (running) {
    rerun = true;
    return;
  }
  setImmediate(() => void runDeliveryCycle());
}

export function startDeliveryLoop() {
  timer = setInterval(() => void runDeliveryCycle(), 2000);
}

export function stopDeliveryLoop() {
  if (timer) clearInterval(timer);
}

export function backoffSeconds(attempt: number, base: number, max: number) {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * 0.2 * Math.random();
  return Math.round(exp + jitter);
}

async function runDeliveryCycle() {
  if (running) return;
  running = true;
  try {
    // Recover rows orphaned by a crash mid-delivery.
    await pool.query(
      `UPDATE attendance_deliveries SET status='retrying', updated_at=now() WHERE status='delivering' AND updated_at < now() - interval '5 minutes'`
    );
    do {
      rerun = false;
      const claimed = await pool.query(
        `UPDATE attendance_deliveries d SET status='delivering', updated_at=now()
          WHERE d.event_id IN (
            SELECT ad.event_id FROM attendance_deliveries ad
              JOIN settings s ON s.organization_id = ad.organization_id AND s.section='integration'
             WHERE ad.status IN ('pending','retrying') AND ad.next_attempt_at <= now()
               AND s.value->>'deliveryMode' = 'api' AND coalesce(s.value->>'baseUrl','') <> ''
             ORDER BY ad.next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)
          RETURNING d.*`
      );
      if (!claimed.rowCount) break;
      await Promise.all(claimed.rows.map((row) => deliverOne(row).catch((err) => logger.error({ err: err.message }, 'deliver failed'))));
    } while (rerun);
  } catch (err: any) {
    logger.error({ err: err.message }, 'delivery cycle failed');
  } finally {
    running = false;
  }
}

async function deliverOne(row: any) {
  const ev = (
    await pool.query(
      `SELECT e.*, emp.web_reference_id, emp.staff_number, emp.full_name, l.name AS location_name, dv.device_uid,
              (SELECT m.external_ref FROM location_mappings m WHERE m.location_id=e.location_id AND m.status='mapped' LIMIT 1) AS location_ref
         FROM attendance_events e JOIN employees emp ON emp.id=e.employee_id
         JOIN locations l ON l.id=e.location_id JOIN devices dv ON dv.id=e.device_id
        WHERE e.id=$1`,
      [row.event_id]
    )
  ).rows[0];
  if (!ev) return;
  const s = await getSettings(row.organization_id, 'integration');
  const attemptNo = row.attempts + 1;
  const started = Date.now();
  try {
    const r = await pushAttendance(row.organization_id, {
      eventId: ev.event_uid,
      webReferenceId: ev.web_reference_id,
      staffNumber: ev.staff_number,
      locationRef: ev.location_ref,
      direction: ev.direction,
      capturedAt: new Date(ev.captured_at).toISOString(),
      timezoneOffsetMinutes: ev.tz_offset_minutes,
      matchScore: ev.match_score,
      deviceId: ev.device_uid
    });
    await pool.query(
      `UPDATE attendance_deliveries SET status='delivered', attempts=$2, last_attempt_at=now(), last_http_status=$3, last_error=NULL,
              delivered_at=now(), updated_at=now() WHERE event_id=$1`,
      [row.event_id, attemptNo, r.status]
    );
    await pool.query(
      `INSERT INTO delivery_attempts (event_id, attempt_no, http_status, outcome, duration_ms) VALUES ($1,$2,$3,'success',$4)`,
      [row.event_id, attemptNo, r.status, Date.now() - started]
    );
    if (!ev.was_buffered) {
      await pool.query(
        `INSERT INTO ingest_latency (organization_id, capture_to_ingest_ms, capture_to_delivery_ms) VALUES ($1,$2,$3)`,
        [row.organization_id, Math.max(0, new Date(ev.received_at).getTime() - new Date(ev.captured_at).getTime()), Math.max(0, Date.now() - new Date(ev.captured_at).getTime())]
      );
    }
    await resolveAlertByKey(row.organization_id, 'integration:attendance_push', 'Attendance delivery recovered');
    void publishDashboard(row.organization_id, 'delivery/updated', {
      id: row.event_id,
      eventId: row.event_id,
      status: 'delivered',
      attempts: attemptNo,
      httpStatus: r.status,
      deliveredAt: new Date().toISOString(),
      locationId: ev.location_id
    });
  } catch (err: any) {
    const ie = err instanceof IntegrationError ? err : new IntegrationError(err.message, null, true);
    // Budgets restart after an operator replay (attempt numbers keep increasing for a complete history).
    const rejectedAttempts =
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM delivery_attempts WHERE event_id=$1 AND outcome='rejected' AND attempted_at > coalesce($2::timestamptz, '-infinity'::timestamptz)`,
            [row.event_id, row.replayed_at]
          )
        ).rows[0].count
      ) + (ie.retryable ? 0 : 1);
    const attemptsSinceReplay = attemptNo - (row.attempts_at_replay ?? 0);
    const dead = ie.retryable ? attemptsSinceReplay >= s.maxDeliveryAttempts : rejectedAttempts >= REJECTION_RETRIES;
    const next = new Date(Date.now() + backoffSeconds(attemptsSinceReplay, s.backoffBaseSeconds, s.backoffMaxSeconds) * 1000);
    await pool.query(
      `UPDATE attendance_deliveries SET status=$2, attempts=$3, last_attempt_at=now(), last_http_status=$4, last_error=$5,
              next_attempt_at=$6, updated_at=now() WHERE event_id=$1`,
      [row.event_id, dead ? 'dead_letter' : 'retrying', attemptNo, ie.status, ie.message.slice(0, 1000), next]
    );
    await pool.query(
      `INSERT INTO delivery_attempts (event_id, attempt_no, http_status, outcome, error, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.event_id, attemptNo, ie.status, dead ? 'dead_letter' : ie.retryable ? 'retryable' : 'rejected', ie.message.slice(0, 1000), Date.now() - started]
    );
    void publishDashboard(row.organization_id, 'delivery/updated', {
      id: row.event_id,
      eventId: row.event_id,
      status: dead ? 'dead_letter' : 'retrying',
      attempts: attemptNo,
      error: ie.message,
      httpStatus: ie.status,
      nextAttemptAt: dead ? null : next.toISOString(),
      locationId: ev.location_id
    });
    if (dead) {
      const dlq = Number(
        (await pool.query(`SELECT count(*) FROM attendance_deliveries WHERE organization_id=$1 AND status='dead_letter'`, [row.organization_id])).rows[0].count
      );
      await raiseAlert({
        organizationId: row.organization_id,
        type: 'delivery_failure',
        severity: 'critical',
        title: 'Attendance delivery failure — events in dead-letter queue',
        description: `Event ${ev.event_uid} for ${ev.full_name} (${ev.staff_number}) at ${ev.location_name} was moved to the dead-letter queue after ${attemptNo} attempt(s). Last error: ${ie.message}`,
        impact: `${dlq} attendance event(s) are not recorded in the web software.`,
        recommendedAction: 'Open Attendance → Reconciliation & DLQ, inspect the rejection reason, correct the data or mapping in the web software, then replay.',
        locationId: ev.location_id,
        dedupeKey: 'delivery:dead_letter',
        context: { dlqCount: dlq, lastEventId: row.event_id, lastError: ie.message, httpStatus: ie.status }
      });
    } else if (ie.retryable && attemptNo >= 3) {
      await raiseAlert({
        organizationId: row.organization_id,
        type: 'integration_failure',
        severity: 'warning',
        title: 'Web software not accepting attendance',
        description: `Attendance push is failing: ${ie.message}. Events are being retried with exponential backoff.`,
        impact: 'Attendance is captured and stored in the platform but delayed in the web software.',
        recommendedAction: 'Check web software availability and the integration settings (base URL, API key).',
        dedupeKey: 'integration:attendance_push',
        context: { httpStatus: ie.status, error: ie.message }
      });
    }
  }
}
