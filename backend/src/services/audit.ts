import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

export interface Actor {
  type: 'user' | 'device' | 'system' | 'integration';
  id?: string | null;
  name?: string | null;
  role?: string | null;
  organizationId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceInfo?: string | null;
}

export const systemActor = (organizationId: string | null, name = 'BAMP System'): Actor => ({
  type: 'system',
  id: 'system',
  name,
  role: 'system',
  organizationId
});

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  objectLabel?: string | null;
  before?: unknown;
  after?: unknown;
}

const GENESIS = '0'.repeat(64);

function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function redact(state: unknown): unknown {
  if (state === undefined || state === null) return null;
  let v: unknown = state;
  if (typeof state === 'object') {
    const SENSITIVE = /password|secret|token|pin_hash|mfa_secret|wrapped_dek|activation_code/i;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(state as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[redacted]' : val;
    v = out;
  }
  // Hash exactly what jsonb will store: JSON round-trip drops undefined keys and serialises Dates/bigints consistently.
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

/**
 * Append an entry to the hash-chained, append-only audit log (FR-5.4).
 * Must be called inside the same transaction as the mutation it describes.
 */
export async function audit(db: Db, actor: Actor, entry: AuditEntry): Promise<void> {
  // The chain lock is transaction-scoped: when handed the pool (autocommit), open a dedicated transaction.
  if (!('release' in db)) {
    const client = await (db as typeof pool).connect();
    try {
      await client.query('BEGIN');
      await audit(client, actor, entry);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return;
  }
  // Serialise writers so the chain is linear.
  await db.query('SELECT pg_advisory_xact_lock(424242)');
  const prev = await db.query<{ hash: string }>('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prevHash = prev.rows[0]?.hash ?? GENESIS;
  const occurredAt = new Date();
  const before = redact(entry.before);
  const after = redact(entry.after);
  const payload = canonical({
    organizationId: actor.organizationId,
    occurredAt: occurredAt.toISOString(),
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId ?? null,
    before,
    after
  });
  const hash = createHash('sha256').update(prevHash).update(payload).digest('hex');
  await db.query(
    `INSERT INTO audit_log (organization_id, occurred_at, actor_type, actor_id, actor_name, actor_role, action, object_type,
       object_id, object_label, before_state, after_state, ip, user_agent, device_info, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      actor.organizationId,
      occurredAt,
      actor.type,
      actor.id ?? null,
      actor.name ?? null,
      actor.role ?? null,
      entry.action,
      entry.objectType,
      entry.objectId ?? null,
      entry.objectLabel ?? null,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      actor.ip ?? null,
      actor.userAgent ?? null,
      actor.deviceInfo ?? null,
      prevHash,
      hash
    ]
  );
}

/**
 * Recompute the whole chain (all tenants share one linear chain) in batches and report the first broken link.
 */
export async function verifyAuditChain() {
  let expectedPrev = GENESIS;
  let checked = 0;
  let lastSeq = 0;
  const started = Date.now();
  for (;;) {
    const r = await pool.query(
      `SELECT seq, organization_id, occurred_at, actor_type, actor_id, action, object_type, object_id, before_state, after_state, prev_hash, hash
         FROM audit_log WHERE seq > $1 ORDER BY seq ASC LIMIT 5000`,
      [lastSeq]
    );
    if (!r.rowCount) break;
    const res = checkBatch(r.rows, expectedPrev);
    checked += res.checked;
    if (!res.valid) return { valid: false, brokenAtSeq: res.brokenAtSeq, checked, durationMs: Date.now() - started };
    expectedPrev = res.head;
    lastSeq = r.rows[r.rows.length - 1].seq;
  }
  return { valid: true, checked, headHash: expectedPrev, durationMs: Date.now() - started };
}

function checkBatch(rows: any[], startPrev: string): { valid: true; checked: number; head: string } | { valid: false; checked: number; brokenAtSeq: number } {
  let expectedPrev = startPrev;
  let checked = 0;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) return { valid: false, brokenAtSeq: row.seq, checked };
    const payload = canonical({
      organizationId: row.organization_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      before: row.before_state,
      after: row.after_state
    });
    const h = createHash('sha256').update(row.prev_hash).update(payload).digest('hex');
    if (h !== row.hash) return { valid: false, brokenAtSeq: row.seq, checked };
    expectedPrev = row.hash;
    checked++;
  }
  return { valid: true, checked, head: expectedPrev };
}
