import { pool, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { raiseAlert, resolveAlertByKey } from '../services/alerts.js';
import { audit, systemActor, type Actor } from '../services/audit.js';
import { publishDashboard } from '../services/mqtt.js';
import { deleteTemplateObjects, nudgeLocations, purgeTemplates, rosterChange } from '../services/roster.js';
import { fetchEmployees, fetchLocations, IntegrationError, type WebEmployee } from './webAdapter.js';

export type SyncMode = 'incremental' | 'full' | 'manual' | 'retry';

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const ok = await redis.set(key, String(process.pid), 'EX', 900, 'NX');
  if (!ok) return null;
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}

async function startRun(orgId: string, kind: string, mode: SyncMode, userId: string | null, cursorFrom: Date | null) {
  const r = await pool.query(
    `INSERT INTO sync_runs (organization_id, kind, mode, status, triggered_by, cursor_from) VALUES ($1,$2,$3,'running',$4,$5) RETURNING *`,
    [orgId, kind, mode, userId, cursorFrom]
  );
  void publishDashboard(orgId, 'sync/started', r.rows[0]);
  return r.rows[0];
}

async function finishRun(run: any, patch: Record<string, unknown>) {
  const r = await pool.query(
    `UPDATE sync_runs SET status=$2, finished_at=now(), records_processed=$3, records_added=$4, records_updated=$5,
            records_removed=$6, error_count=$7, error_message=$8, cursor_to=$9 WHERE id=$1 RETURNING *`,
    [
      run.id,
      patch.status,
      patch.processed ?? 0,
      patch.added ?? 0,
      patch.updated ?? 0,
      patch.removed ?? 0,
      patch.errors ?? 0,
      patch.errorMessage ?? null,
      patch.cursorTo ?? null
    ]
  );
  void publishDashboard(run.organization_id, 'sync/finished', r.rows[0]);
  return r.rows[0];
}

const KIND_LABEL: Record<string, string> = {
  employees: 'Employee',
  locations: 'Location',
  attendance_export: 'Attendance export',
  attendance_push: 'Attendance push'
};

/** Two consecutive failures of the same sync kind raise an alert (FR-1.6 / FR-1.7). */
export async function evaluateFailures(orgId: string, kind: string, lastError: string) {
  const last = await pool.query(
    `SELECT status FROM sync_runs WHERE organization_id=$1 AND kind=$2 AND status <> 'running' ORDER BY started_at DESC LIMIT 2`,
    [orgId, kind]
  );
  const consecutive = last.rows.length === 2 && last.rows.every((r) => r.status === 'failed');
  if (consecutive) {
    await raiseAlert({
      organizationId: orgId,
      type: 'sync_failed',
      severity: 'critical',
      title: `${KIND_LABEL[kind] ?? kind} sync failed twice`,
      description: `The ${(KIND_LABEL[kind] ?? kind).toLowerCase()} synchronisation with the web software failed on two consecutive runs. Last error: ${lastError}`,
      impact:
        kind === 'employees'
          ? 'New hires, transfers and terminations are not reaching devices. Device rosters may be stale.'
          : kind === 'locations'
            ? 'New web-software locations are not being mapped.'
            : 'Attendance for the affected period has not reached the web software (it remains safely stored in the platform).',
      recommendedAction: 'Open Integration & Sync → Sync History, inspect the failed run, fix the web-software connection, then Retry Sync.',
      dedupeKey: `sync:${kind}`,
      context: { lastError }
    });
  }
  return consecutive;
}

// ───────────────────────── Locations ─────────────────────────
export async function runLocationSync(orgId: string, mode: SyncMode, actor: Actor | null = null) {
  return withLock(`lock:sync:locations:${orgId}`, async () => {
    const run = await startRun(orgId, 'locations', mode, actor?.type === 'user' ? (actor.id ?? null) : null, null);
    try {
      const list = await fetchLocations(orgId);
      let added = 0;
      let updated = 0;
      const newlyUnmapped: { ref: string; name: string }[] = [];
      await tx(async (db) => {
        for (const loc of list) {
          const existing = (await db.query('SELECT * FROM location_mappings WHERE organization_id=$1 AND external_ref=$2', [orgId, loc.ref])).rows[0];
          if (existing) {
            if (existing.external_name !== loc.name) {
              await db.query('UPDATE location_mappings SET external_name=$3 WHERE organization_id=$1 AND external_ref=$2', [orgId, loc.ref, loc.name]);
              updated++;
            }
            continue;
          }
          const byCode = (await db.query('SELECT id FROM locations WHERE organization_id=$1 AND code=$2', [orgId, loc.ref])).rows[0];
          await db.query(
            `INSERT INTO location_mappings (organization_id, external_ref, external_name, location_id, status, resolved_at)
             VALUES ($1,$2,$3,$4,$5, CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END)`,
            [orgId, loc.ref, loc.name, byCode?.id ?? null, byCode ? 'mapped' : 'unmapped']
          );
          added++;
          if (!byCode) newlyUnmapped.push({ ref: loc.ref, name: loc.name });
        }
        await audit(db, actor ?? systemActor(orgId, 'Integration Adapter'), {
          action: 'sync.locations',
          objectType: 'sync_run',
          objectId: run.id,
          after: { processed: list.length, added, updated, unmapped: newlyUnmapped.length }
        });
      });
      for (const u of newlyUnmapped) await raiseUnmapped(orgId, u.ref, u.name, 0);
      await resolveAlertByKey(orgId, 'sync:locations', 'Location sync succeeded');
      return finishRun(run, { status: 'success', processed: list.length, added, updated });
    } catch (err: any) {
      const r = await finishRun(run, { status: 'failed', errors: 1, errorMessage: err.message });
      await evaluateFailures(orgId, 'locations', err.message);
      return r;
    }
  });
}

async function raiseUnmapped(orgId: string, ref: string, name: string | null, employeesAffected: number) {
  await raiseAlert({
    organizationId: orgId,
    type: 'unmapped_location',
    severity: 'warning',
    title: `Unmapped location: ${name ?? ref}`,
    description: `The web software references location "${name ?? ref}" (ref ${ref}) which has no matching platform location. Employees assigned to it were kept, not discarded.`,
    impact: `${employeesAffected} employee(s) cannot be placed on a device roster until the location is mapped.`,
    recommendedAction: 'Open Integration & Sync → Unmapped Locations, map it to an existing location or create a new one, then re-run synchronisation.',
    dedupeKey: `unmapped:${ref}`,
    context: { externalRef: ref, externalName: name, employeesAffected }
  });
}

// ───────────────────────── Employees ─────────────────────────
export async function runEmployeeSync(orgId: string, mode: SyncMode, actor: Actor | null = null) {
  return withLock(`lock:sync:employees:${orgId}`, async () => {
    // Only the scheduled daily run (mode 'full') performs full reconciliation; manual/retry runs are incremental.
    const incremental = mode !== 'full';
    let cursorFrom: Date | null = null;
    if (incremental) {
      const last = await pool.query(
        `SELECT cursor_to FROM sync_runs WHERE organization_id=$1 AND kind='employees' AND status IN ('success','partial') AND cursor_to IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
        [orgId]
      );
      cursorFrom = last.rows[0]?.cursor_to ?? null;
    }
    const run = await startRun(orgId, 'employees', mode, actor?.type === 'user' ? (actor.id ?? null) : null, cursorFrom);
    const cursorTo = new Date();
    try {
      // Keep the location map fresh first so new references resolve in the same run.
      await runLocationSync(orgId, mode === 'retry' ? 'retry' : mode, actor).catch(() => undefined);
      const list = await fetchEmployees(orgId, cursorFrom ? new Date(cursorFrom.getTime() - 60_000) : null);
      const result = await applyEmployees(orgId, run.id, list, !cursorFrom, actor);
      const status = result.errors > 0 ? 'partial' : 'success';
      await resolveAlertByKey(orgId, 'sync:employees', 'Employee sync succeeded');
      await resolveAlertByKey(orgId, 'integration:web_unreachable', 'Web software reachable again');
      return finishRun(run, { status, ...result, cursorTo });
    } catch (err: any) {
      logger.warn({ err: err.message, orgId }, 'employee sync failed');
      const r = await finishRun(run, { status: 'failed', errors: 1, errorMessage: err.message });
      const escalated = await evaluateFailures(orgId, 'employees', err.message);
      if (!escalated && mode !== 'retry') {
        // Failure #1 → automatic retry in one minute (User flow §21).
        const { scheduleSyncRetry } = await import('../workers/scheduler.js');
        await scheduleSyncRetry(orgId, 60_000);
      }
      if (err instanceof IntegrationError && err.status === null) {
        await raiseAlert({
          organizationId: orgId,
          type: 'integration_failure',
          severity: 'critical',
          title: 'Web software unreachable',
          description: `The integration adapter could not reach the web software: ${err.message}`,
          impact: 'Employee changes and attendance delivery are paused until connectivity is restored. Devices keep capturing.',
          recommendedAction: 'Verify the web software is up and the Integration settings (base URL, API key) are correct.',
          dedupeKey: 'integration:web_unreachable',
          context: { error: err.message }
        });
      }
      return r;
    }
  });
}

async function applyEmployees(orgId: string, runId: string, list: WebEmployee[], isFull: boolean, actor: Actor | null) {
  let added = 0;
  let updated = 0;
  let removed = 0;
  let errors = 0;
  const touched = new Set<string>();
  const blobKeys: string[] = [];
  const purged: { employeeId: string; locationId: string | null }[] = [];
  const unmapped = new Map<string, number>();
  const who = actor ?? systemActor(orgId, 'Integration Adapter');

  const mappings = new Map<string, { location_id: string | null; status: string }>();
  for (const m of (await pool.query('SELECT external_ref, location_id, status FROM location_mappings WHERE organization_id=$1', [orgId])).rows)
    mappings.set(m.external_ref, m);

  for (const w of list) {
    try {
      if (!w.webReferenceId || !w.staffNumber || !w.fullName || !w.employmentStatus) throw new Error('Missing required field');
      if (!['active', 'inactive', 'suspended', 'terminated'].includes(w.employmentStatus)) throw new Error(`Invalid employmentStatus ${w.employmentStatus}`);
      await tx(async (db) => {
        let locationId: string | null = null;
        if (w.locationRef) {
          let m = mappings.get(w.locationRef);
          if (!m) {
            await db.query(
              `INSERT INTO location_mappings (organization_id, external_ref, status) VALUES ($1,$2,'unmapped') ON CONFLICT DO NOTHING`,
              [orgId, w.locationRef]
            );
            m = { location_id: null, status: 'unmapped' };
            mappings.set(w.locationRef, m);
          }
          locationId = m.status === 'mapped' ? m.location_id : null;
          if (!locationId && m.status !== 'ignored') unmapped.set(w.locationRef, (unmapped.get(w.locationRef) ?? 0) + 1);
        }
        const before = (await db.query('SELECT * FROM employees WHERE organization_id=$1 AND web_reference_id=$2', [orgId, w.webReferenceId])).rows[0];
        const row = (
          await db.query(
            `INSERT INTO employees (organization_id, web_reference_id, staff_number, full_name, department, external_location_ref, location_id,
                                    employment_status, source_modified_at, last_synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
             ON CONFLICT (organization_id, web_reference_id) DO UPDATE SET
               staff_number=EXCLUDED.staff_number, full_name=EXCLUDED.full_name, department=EXCLUDED.department,
               external_location_ref=EXCLUDED.external_location_ref, location_id=EXCLUDED.location_id,
               employment_status=EXCLUDED.employment_status, source_modified_at=EXCLUDED.source_modified_at,
               last_synced_at=now(), updated_at=now()
             RETURNING *`,
            [orgId, w.webReferenceId, w.staffNumber, w.fullName, w.department ?? null, w.locationRef, locationId, w.employmentStatus, w.lastModified ?? null]
          )
        ).rows[0];
        const wasOnRoster = before && before.employment_status === 'active' && before.location_id;
        const isOnRoster = row.employment_status === 'active' && row.location_id;
        const changed =
          !before ||
          before.staff_number !== row.staff_number ||
          before.full_name !== row.full_name ||
          before.location_id !== row.location_id ||
          before.employment_status !== row.employment_status ||
          before.department !== row.department;
        if (!before) added++;
        else if (changed) updated++;
        if (wasOnRoster && (!isOnRoster || before.location_id !== row.location_id)) {
          await rosterChange(db, orgId, before.location_id, row.id, 'remove');
          touched.add(before.location_id);
        }
        if (isOnRoster && (changed || !wasOnRoster)) {
          await rosterChange(db, orgId, row.location_id, row.id, 'upsert');
          touched.add(row.location_id);
        }
        // Employee became inactive → drop from rosters and purge templates within this sync cycle (FR-1.3, NFR-3.2).
        if (before && before.employment_status === 'active' && row.employment_status !== 'active') {
          blobKeys.push(...(await purgeTemplates(db, orgId, row.id, before.location_id)));
          purged.push({ employeeId: row.id, locationId: before.location_id });
          removed++;
        }
        if (changed) {
          await audit(db, who, {
            action: before ? 'employee.synced_update' : 'employee.synced_create',
            objectType: 'employee',
            objectId: row.id,
            objectLabel: `${row.full_name} (${row.staff_number})`,
            before: before
              ? { staffNumber: before.staff_number, fullName: before.full_name, locationId: before.location_id, status: before.employment_status }
              : null,
            after: { staffNumber: row.staff_number, fullName: row.full_name, locationId: row.location_id, status: row.employment_status }
          });
        }
      });
    } catch (err: any) {
      errors++;
      await pool.query('INSERT INTO sync_errors (sync_run_id, record_ref, error, payload) VALUES ($1,$2,$3,$4)', [
        runId,
        w?.webReferenceId ?? null,
        err.message,
        JSON.stringify(w)
      ]);
    }
  }

  // Full reconciliation: employees no longer present in the web software are removed from rosters.
  if (isFull) {
    const present = list.map((w) => w.webReferenceId);
    const gone = await pool.query(
      `SELECT * FROM employees WHERE organization_id=$1 AND employment_status='active' AND NOT (web_reference_id = ANY($2::text[]))`,
      [orgId, present]
    );
    for (const e of gone.rows) {
      await tx(async (db) => {
        await db.query(`UPDATE employees SET employment_status='inactive', updated_at=now(), last_synced_at=now() WHERE id=$1`, [e.id]);
        if (e.location_id) {
          await rosterChange(db, orgId, e.location_id, e.id, 'remove');
          touched.add(e.location_id);
        }
        blobKeys.push(...(await purgeTemplates(db, orgId, e.id, e.location_id)));
        purged.push({ employeeId: e.id, locationId: e.location_id });
        await audit(db, who, {
          action: 'employee.removed_from_source',
          objectType: 'employee',
          objectId: e.id,
          objectLabel: `${e.full_name} (${e.staff_number})`,
          before: { status: e.employment_status },
          after: { status: 'inactive', reason: 'No longer present in web software' }
        });
      });
      removed++;
    }
  }

  await deleteTemplateObjects(blobKeys);
  for (const p of purged) void publishDashboard(orgId, 'employee/biometric', { employeeId: p.employeeId, fingers: 0, purged: true, locationId: p.locationId });
  for (const [ref, count] of unmapped) {
    const m = (await pool.query('SELECT external_name FROM location_mappings WHERE organization_id=$1 AND external_ref=$2', [orgId, ref])).rows[0];
    await raiseUnmapped(orgId, ref, m?.external_name ?? null, count);
  }
  await nudgeLocations(orgId, touched);
  if (touched.size) void publishDashboard(orgId, 'employee/roster-changed', { locations: [...touched] });
  return { processed: list.length, added, updated, removed, errors };
}
