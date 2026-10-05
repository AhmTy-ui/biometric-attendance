import { pool, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { buckets, putObject } from '../lib/s3.js';
import { renderExport, type Column } from '../lib/tabular.js';
import { raiseAlert, resolveAlertByKey } from '../services/alerts.js';
import { audit, systemActor } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { publishDashboard } from '../services/mqtt.js';
import { evaluateFailures } from './sync.js';
import { uploadExport } from './webAdapter.js';

/**
 * FR-1.5 — where the web software cannot accept programmatic attendance input, generate a scheduled export in
 * its import format and deliver it to the agreed endpoint. Events covered are marked `exported`.
 */
export const EXPORT_COLUMNS: Column[] = [
  { key: 'event_uid', header: 'EventId', width: 30 },
  { key: 'web_reference_id', header: 'WebReferenceId', width: 16 },
  { key: 'staff_number', header: 'StaffNumber', width: 12 },
  { key: 'full_name', header: 'FullName', width: 22 },
  { key: 'location_ref', header: 'LocationRef', width: 12 },
  { key: 'direction', header: 'Direction', width: 8 },
  { key: 'captured_local', header: 'CapturedAt', width: 26 },
  { key: 'tz_offset_minutes', header: 'TzOffsetMinutes', width: 10 },
  { key: 'match_score', header: 'MatchScore', width: 8 },
  { key: 'device_uid', header: 'DeviceId', width: 16 }
];

function isoWithOffset(d: Date, offsetMin: number) {
  const local = new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export async function runScheduledExport(orgId: string, triggeredBy: string | null = null) {
  const s = await getSettings(orgId, 'integration');
  if (s.deliveryMode !== 'scheduled_export') return null;
  const run = (
    await pool.query(
      `INSERT INTO sync_runs (organization_id, kind, mode, status, triggered_by) VALUES ($1,'attendance_export',$2,'running',$3) RETURNING *`,
      [orgId, triggeredBy ? 'manual' : 'incremental', triggeredBy]
    )
  ).rows[0];
  void publishDashboard(orgId, 'sync/started', run);
  const finish = async () => {
    const r = (await pool.query('SELECT * FROM sync_runs WHERE id=$1', [run.id])).rows[0];
    void publishDashboard(orgId, 'sync/finished', r);
    if (r.status === 'failed') await evaluateFailures(orgId, 'attendance_export', r.error_message ?? 'export failed');
    else await resolveAlertByKey(orgId, 'sync:attendance_export', 'Export succeeded');
    return r;
  };
  try {
    const rows = (
      await pool.query(
        `SELECT e.id, e.event_uid, e.direction, e.captured_at, e.tz_offset_minutes, e.match_score, emp.web_reference_id, emp.staff_number,
                emp.full_name, dv.device_uid,
                (SELECT m.external_ref FROM location_mappings m WHERE m.location_id=e.location_id AND m.status='mapped' LIMIT 1) AS location_ref
           FROM attendance_deliveries d JOIN attendance_events e ON e.id=d.event_id
           JOIN employees emp ON emp.id=e.employee_id JOIN devices dv ON dv.id=e.device_id
          WHERE d.organization_id=$1 AND d.status IN ('pending','retrying')
          ORDER BY e.captured_at ASC LIMIT 100000`,
        [orgId]
      )
    ).rows.map((r) => ({ ...r, captured_local: isoWithOffset(new Date(r.captured_at), r.tz_offset_minutes) }));
    if (!rows.length) {
      await pool.query(`UPDATE sync_runs SET status='success', finished_at=now() WHERE id=$1`, [run.id]);
      return finish();
    }
    const periodStart = new Date(rows[0].captured_at);
    const periodEnd = new Date(rows[rows.length - 1].captured_at);
    const out = await renderExport(s.exportFormat, 'Attendance', '', EXPORT_COLUMNS, rows);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `attendance-${stamp}.${out.ext}`;
    const key = `${orgId}/attendance-exports/${fileName}`;
    await putObject(buckets.exports, key, out.body, out.contentType);
    let delivered = false;
    let error: string | null = null;
    if (s.exportEndpointUrl) {
      try {
        await uploadExport(orgId, fileName, out.body, out.contentType);
        delivered = true;
      } catch (err: any) {
        error = err.message;
      }
    }
    await tx(async (db) => {
      const batch = (
        await db.query(
          `INSERT INTO export_batches (organization_id, format, period_start, period_end, record_count, object_key, delivery_target, status, error, delivered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [orgId, s.exportFormat, periodStart, periodEnd, rows.length, key, s.exportEndpointUrl || `s3://${buckets.exports}/${key}`,
            error ? 'failed' : delivered ? 'delivered' : 'generated', error, delivered ? new Date() : null]
        )
      ).rows[0];
      if (!error) {
        await db.query(
          `UPDATE attendance_deliveries SET status='exported', export_batch_id=$2, updated_at=now() WHERE event_id = ANY($1::uuid[])`,
          [rows.map((r) => r.id), batch.id]
        );
      }
      await db.query(
        `UPDATE sync_runs SET status=$2, finished_at=now(), records_processed=$3, records_added=$4, error_count=$5, error_message=$6 WHERE id=$1`,
        [run.id, error ? 'failed' : 'success', rows.length, error ? 0 : rows.length, error ? 1 : 0, error]
      );
      await audit(db, systemActor(orgId, 'Scheduled Export'), {
        action: 'integration.attendance_exported',
        objectType: 'export_batch',
        objectId: batch.id,
        after: { records: rows.length, format: s.exportFormat, objectKey: key, delivered, error }
      });
    });
    if (error) {
      await raiseAlert({
        organizationId: orgId,
        type: 'integration_failure',
        severity: 'critical',
        title: 'Scheduled attendance export could not be delivered',
        description: `Export ${fileName} (${rows.length} events) was generated but delivery to ${s.exportEndpointUrl} failed: ${error}`,
        impact: 'Attendance for this period has not reached the web software. Events remain queued and will be included in the next export.',
        recommendedAction: 'Check the export endpoint in Settings → Integration. The file is kept in object storage and can be downloaded from Integration & Sync.',
        dedupeKey: 'integration:export',
        context: { fileName, error }
      });
    } else {
      await resolveAlertByKey(orgId, 'integration:export', 'Export delivered');
    }
    return finish();
  } catch (err: any) {
    logger.error({ err: err.message }, 'scheduled export failed');
    await pool.query(`UPDATE sync_runs SET status='failed', finished_at=now(), error_count=1, error_message=$2 WHERE id=$1`, [run.id, err.message]);
    return finish();
  }
}
