import { spawn } from 'node:child_process';
import { createReadStream, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { bullConnection, redis } from '../lib/redis.js';
import { buckets, deleteObject, listObjects, s3, storageHealthy } from '../lib/s3.js';
import { checkHeartbeatTimeouts } from '../services/devices.js';
import { mqttConnected } from '../services/mqtt.js';
import { getSettings } from '../services/settings.js';
import { runEmployeeSync } from '../integration/sync.js';
import { runScheduledExport } from '../integration/scheduledExport.js';
import { audit, systemActor } from '../services/audit.js';

const QUEUE = 'bamp-scheduler';
let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startScheduler() {
  queue = new Queue(QUEUE, { connection: bullConnection, defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500 } });
  worker = new Worker(QUEUE, processJob, { connection: bullConnection, concurrency: 4 });
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err: err.message }, 'scheduled job failed'));

  await queue.upsertJobScheduler('heartbeat-check', { every: 15_000 }, { name: 'heartbeat-check' });
  await queue.upsertJobScheduler('uptime-sample', { every: 60_000 }, { name: 'uptime-sample' });
  await queue.upsertJobScheduler('retention', { pattern: '30 3 * * *', tz: 'UTC' }, { name: 'retention' });
  await queue.upsertJobScheduler('backup', { pattern: `0 ${config.BACKUP_CRON_HOUR_UTC} * * *`, tz: 'UTC' }, { name: 'backup' });

  await reconcileOrgSchedules();
  // Organisations created while running (e.g. by the bootstrap CLI) get their schedules within a minute.
  orgTimer = setInterval(() => void reconcileOrgSchedules().catch((err) => logger.error({ err: err.message }, 'schedule reconciliation failed')), 60_000);
}

let orgTimer: NodeJS.Timeout | null = null;
const scheduledOrgs = new Map<string, string>(); // orgId → integration settings fingerprint

async function reconcileOrgSchedules() {
  const orgs = await pool.query('SELECT id FROM organizations');
  for (const o of orgs.rows) {
    const s = await getSettings(o.id, 'integration');
    const fp = JSON.stringify([s.baseUrl, s.incrementalSyncMinutes, s.fullSyncHourUtc, s.deliveryMode, s.exportCron.everyMinutes]);
    if (scheduledOrgs.get(o.id) !== fp) await rescheduleOrg(o.id);
  }
}

export async function stopScheduler() {
  if (orgTimer) clearInterval(orgTimer);
  await worker?.close();
  await queue?.close();
}

/** (Re)create the per-organisation integration schedules from its settings. */
export async function rescheduleOrg(orgId: string) {
  if (!queue) return;
  const s = await getSettings(orgId, 'integration');
  scheduledOrgs.set(orgId, JSON.stringify([s.baseUrl, s.incrementalSyncMinutes, s.fullSyncHourUtc, s.deliveryMode, s.exportCron.everyMinutes]));
  await queue.removeJobScheduler(`sync-inc:${orgId}`);
  await queue.removeJobScheduler(`sync-full:${orgId}`);
  await queue.removeJobScheduler(`export:${orgId}`);
  if (!s.baseUrl) return;
  // Change detection ≤ 15 minutes (S-3): incremental sync every N minutes.
  await queue.upsertJobScheduler(`sync-inc:${orgId}`, { every: s.incrementalSyncMinutes * 60_000 }, { name: 'employee-sync', data: { orgId, mode: 'incremental' } });
  // Guaranteed ≤ 24h reconciliation (S-3): full sync daily.
  await queue.upsertJobScheduler(`sync-full:${orgId}`, { pattern: `0 ${s.fullSyncHourUtc} * * *`, tz: 'UTC' }, { name: 'employee-sync', data: { orgId, mode: 'full' } });
  if (s.deliveryMode === 'scheduled_export') {
    await queue.upsertJobScheduler(`export:${orgId}`, { every: s.exportCron.everyMinutes * 60_000 }, { name: 'attendance-export', data: { orgId } });
  }
}

export async function scheduleSyncRetry(orgId: string, delayMs: number) {
  if (!queue) return;
  await queue.add('employee-sync', { orgId, mode: 'retry' }, { delay: delayMs, jobId: `sync-retry:${orgId}:${Math.floor(Date.now() / 60000)}` });
}

async function processJob(job: Job) {
  switch (job.name) {
    case 'heartbeat-check':
      return checkHeartbeatTimeouts();
    case 'uptime-sample':
      return sampleUptime();
    case 'employee-sync':
      return runEmployeeSync(job.data.orgId, job.data.mode);
    case 'attendance-export':
      return runScheduledExport(job.data.orgId);
    case 'retention':
      return runRetention();
    case 'backup':
      return runBackup();
    default:
      logger.warn({ name: job.name }, 'unknown job');
  }
}

async function sampleUptime() {
  const db = await pool.query('SELECT 1').then(() => true, () => false);
  const r = await redis.ping().then(() => true, () => false);
  const st = await storageHealthy();
  await pool
    .query(
      `INSERT INTO uptime_samples (sampled_at, api_ok, db_ok, redis_ok, mqtt_ok, storage_ok) VALUES (date_trunc('minute', now()), true, $1, $2, $3, $4)
       ON CONFLICT (sampled_at) DO NOTHING`,
      [db, r, mqttConnected(), st]
    )
    .catch(() => undefined);
}

async function runRetention() {
  const orgs = (await pool.query('SELECT id FROM organizations')).rows;
  for (const o of orgs) {
    const r = await getSettings(o.id, 'data_retention');
    await pool.query(
      `DELETE FROM device_heartbeats h USING devices d WHERE d.id=h.device_id AND d.organization_id=$1 AND h.received_at < now() - make_interval(days => $2)`,
      [o.id, r.heartbeatRetentionDays]
    );
    await pool.query(
      `DELETE FROM device_logs l USING devices d WHERE d.id=l.device_id AND d.organization_id=$1 AND l.received_at < now() - make_interval(days => $2)`,
      [o.id, r.deviceLogRetentionDays]
    );
    const old = await pool.query(
      `DELETE FROM attendance_events WHERE organization_id=$1 AND captured_at < now() - make_interval(months => $2) RETURNING id`,
      [o.id, r.attendanceRetentionMonths]
    );
    await pool.query(`DELETE FROM attendance_daily WHERE organization_id=$1 AND work_date < (now() - make_interval(months => $2))::date`, [o.id, r.attendanceRetentionMonths]);
    if (old.rowCount) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await audit(c, systemActor(o.id, 'Retention Policy'), {
          action: 'retention.attendance_purged',
          objectType: 'attendance',
          after: { deleted: old.rowCount, olderThanMonths: r.attendanceRetentionMonths }
        });
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    }
  }
  await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM user_tokens WHERE expires_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM ingest_latency WHERE measured_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM uptime_samples WHERE sampled_at < now() - interval '400 days'`);
  await pool.query(`DELETE FROM device_nonces WHERE seen_at < now() - interval '1 day'`);
}

/** NFR-3.3: daily database backup to object storage, retained for BACKUP_RETENTION_DAYS (default 30). */
export async function runBackup() {
  const row = (await pool.query(`INSERT INTO backups (status) VALUES ('running') RETURNING id`)).rows[0];
  const file = join(tmpdir(), `bamp-${Date.now()}.dump`);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(config.PG_DUMP_PATH, ['--format=custom', '--no-owner', `--file=${file}`, config.DATABASE_URL], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${err.slice(0, 500)}`))));
    });
    const size = statSync(file).size;
    const key = `db/${new Date().toISOString().slice(0, 10)}/bamp-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
    await s3.send(new PutObjectCommand({ Bucket: buckets.backups, Key: key, Body: createReadStream(file), ContentLength: size }));
    await pool.query(`UPDATE backups SET status='success', finished_at=now(), object_key=$2, size_bytes=$3 WHERE id=$1`, [row.id, key, size]);
    // Retention
    const cutoff = Date.now() - config.BACKUP_RETENTION_DAYS * 86400_000;
    for (const o of await listObjects(buckets.backups, 'db/')) {
      if (o.lastModified && o.lastModified.getTime() < cutoff) await deleteObject(buckets.backups, o.key);
    }
    logger.info({ key, size }, 'database backup complete');
  } catch (err: any) {
    await pool.query(`UPDATE backups SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [row.id, err.message]);
    logger.error({ err: err.message }, 'database backup failed');
    const orgs = (await pool.query('SELECT id FROM organizations')).rows;
    const { raiseAlert } = await import('../services/alerts.js');
    for (const o of orgs) {
      await raiseAlert({
        organizationId: o.id,
        type: 'integration_failure',
        severity: 'critical',
        title: 'Database backup failed',
        description: `The nightly database backup failed: ${err.message}`,
        impact: 'Point-in-time recovery for the last day is not available until a backup succeeds.',
        recommendedAction: 'Check PG_DUMP_PATH, database connectivity and backup bucket permissions; then run a backup from System status.',
        dedupeKey: 'system:backup'
      });
    }
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* file may not exist */
    }
  }
}
