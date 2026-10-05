import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { renderExport, type Column } from '../lib/tabular.js';
import { pageParams, parse } from '../lib/validate.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit, verifyAuditChain } from '../services/audit.js';

/** FR-5.5: searchable, exportable; there is deliberately no update or delete route (and the table rejects them). */
const filterSchema = z.object({
  q: z.string().max(200).optional(),
  actorType: z.enum(['user', 'device', 'system', 'integration']).optional(),
  actorId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  objectType: z.string().max(60).optional(),
  objectId: z.string().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional()
});

function where(orgId: string, f: z.infer<typeof filterSchema>, params: unknown[]) {
  params.push(orgId);
  let w = 'WHERE organization_id=$1';
  const add = (sql: string, v: unknown) => {
    params.push(v);
    w += sql.replaceAll('?', `$${params.length}`);
  };
  if (f.actorType) add(' AND actor_type = ?', f.actorType);
  if (f.actorId) add(' AND actor_id = ?', f.actorId);
  if (f.action) add(' AND action LIKE ?', `${f.action}%`);
  if (f.objectType) add(' AND object_type = ?', f.objectType);
  if (f.objectId) add(' AND object_id = ?', f.objectId);
  if (f.from) add(' AND occurred_at >= ?', f.from);
  if (f.to) add(' AND occurred_at < ?', f.to);
  if (f.q)
    add(
      ' AND (lower(coalesce(actor_name,\'\')) LIKE ? OR lower(action) LIKE ? OR lower(coalesce(object_label,\'\')) LIKE ? OR lower(coalesce(object_id,\'\')) LIKE ? OR host(ip) LIKE ?)',
      `%${f.q.toLowerCase()}%`
    );
  return w;
}

const AUDIT_COLS = `seq, id, organization_id, occurred_at, actor_type, actor_id, actor_name, actor_role, action, object_type, object_id,
  object_label, before_state, after_state, host(ip) AS ip, user_agent, device_info, prev_hash, hash`;

const COLUMNS: Column[] = [
  { key: 'seq', header: 'Seq', width: 7 },
  { key: 'occurred_at', header: 'Timestamp (UTC)', width: 22 },
  { key: 'actor_type', header: 'Actor type', width: 9 },
  { key: 'actor_name', header: 'Actor', width: 18 },
  { key: 'actor_role', header: 'Role', width: 12 },
  { key: 'action', header: 'Action', width: 22 },
  { key: 'object_type', header: 'Object type', width: 12 },
  { key: 'object_label', header: 'Object', width: 18 },
  { key: 'ip', header: 'IP', width: 12 },
  { key: 'before_state', header: 'Before', width: 26 },
  { key: 'after_state', header: 'After', width: 26 },
  { key: 'hash', header: 'Hash', width: 30 }
];

export async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit', { preHandler: requirePerm('audit.view') }, async (req) => {
    const f = parse(filterSchema, req.query);
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [];
    const w = where(req.principal!.organizationId, f, params);
    const total = Number((await one(`SELECT count(*) FROM audit_log ${w}`, params))!.count);
    params.push(limit, offset);
    const rows = await many(
      `SELECT seq, id, occurred_at, actor_type, actor_id, actor_name, actor_role, action, object_type, object_id, object_label,
              host(ip) AS ip, device_info, prev_hash, hash
         FROM audit_log ${w} ORDER BY seq DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { total, limit, offset, rows };
  });

  app.get('/api/audit/facets', { preHandler: requirePerm('audit.view') }, async (req) => {
    const org = req.principal!.organizationId;
    const [actions, objectTypes, stats] = await Promise.all([
      many(`SELECT action, count(*)::int AS n FROM audit_log WHERE organization_id=$1 GROUP BY action ORDER BY action`, [org]),
      many(`SELECT DISTINCT object_type FROM audit_log WHERE organization_id=$1 ORDER BY object_type`, [org]),
      one(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE occurred_at > now() - interval '24 hours')::int AS last_24h,
                min(occurred_at) AS first_at, max(occurred_at) AS last_at FROM audit_log WHERE organization_id=$1`,
        [org]
      )
    ]);
    return { actions, objectTypes: objectTypes.map((o) => o.object_type), stats };
  });

  app.get('/api/audit/verify', { preHandler: requirePerm('audit.view') }, async () => verifyAuditChain());

  app.get('/api/audit/export', { preHandler: requirePerm('audit.view') }, async (req, reply) => {
    const f = parse(filterSchema, req.query);
    const format = parse(z.enum(['csv', 'xlsx', 'pdf']), (req.query as any).format ?? 'csv');
    const params: unknown[] = [];
    const w = where(req.principal!.organizationId, f, params);
    const rows = await many(`SELECT ${AUDIT_COLS} FROM audit_log ${w} ORDER BY seq ASC LIMIT 500000`, params);
    const out = await renderExport(format, 'Audit log', `Exported ${new Date().toISOString()} · filters ${JSON.stringify(f)}`, COLUMNS, rows);
    await tx((db) => audit(db, actorFromRequest(req), { action: 'audit.exported', objectType: 'audit_log', after: { format, rows: rows.length, filters: f } }));
    reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="audit-log-${Date.now()}.${out.ext}"`);
    return out.body;
  });

  app.get('/api/audit/:seq', { preHandler: requirePerm('audit.view') }, async (req) => {
    const { seq } = req.params as { seq: string };
    const org = req.principal!.organizationId;
    const row = await one(`SELECT ${AUDIT_COLS} FROM audit_log WHERE seq=$1 AND organization_id=$2`, [Number(seq), org]);
    if (!row) throw notFound('Audit event');
    // Chain links are global (one linear chain); navigation stays within this organisation.
    const chainPrev = await one(`SELECT seq, hash FROM audit_log WHERE seq < $1 ORDER BY seq DESC LIMIT 1`, [row.seq]);
    const chainNext = await one(`SELECT seq, prev_hash FROM audit_log WHERE seq > $1 ORDER BY seq ASC LIMIT 1`, [row.seq]);
    const navPrev = await one(`SELECT seq FROM audit_log WHERE seq < $1 AND organization_id=$2 ORDER BY seq DESC LIMIT 1`, [row.seq, org]);
    const navNext = await one(`SELECT seq FROM audit_log WHERE seq > $1 AND organization_id=$2 ORDER BY seq ASC LIMIT 1`, [row.seq, org]);
    return {
      event: row,
      chain: {
        linksToPrevious: chainPrev ? chainPrev.hash === row.prev_hash : row.prev_hash === '0'.repeat(64),
        linkedByNext: chainNext ? chainNext.prev_hash === row.hash : null,
        previousSeq: navPrev?.seq ?? null,
        nextSeq: navNext?.seq ?? null
      }
    };
  });
}
