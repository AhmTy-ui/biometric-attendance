import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { safeEqual } from '../lib/security.js';
import { recordAttendance, webAttendanceSchema } from '../services/attendance.js';
import { pageForApi } from '../services/employees.js';
import { importAttendanceFile } from '../services/imports.js';
import { recordApiRequest } from '../services/queries.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiDetail: string | null;
  }
}

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const employeesQuery = z.object({
  modifiedSince: z.string().datetime({ offset: true, message: 'modifiedSince must be an ISO-8601 timestamp' }).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000, 'pageSize must be at most 1000').default(100)
});

function fail(req: FastifyRequest, reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) {
  req.apiDetail = error;
  return reply.code(status).send({ error, ...extra });
}

/**
 * Integration API consumed by BAMP's web adapter (backend/src/integration/webAdapter.ts).
 * All routes except /health require `Authorization: Bearer <API_KEY>`.
 */
export const apiRoutes: FastifyPluginAsync = async (app) => {
  const rateLimit = { max: config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };

  // preHandler (not onRequest) so the per-route rate limiter, which runs at onRequest, also throttles
  // unauthenticated key-guessing. Multipart bodies are only consumed inside the handler, after this check.
  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions.url === '/api/v1/health') return;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m || !safeEqual(m[1]!, config.API_KEY)) {
      reply.header('www-authenticate', 'Bearer realm="websoft-integration"');
      return fail(req, reply, 401, 'Missing or invalid API key');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.routeOptions.url === '/api/v1/health') return;
    await recordApiRequest({
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      remoteAddr: req.ip,
      detail: req.apiDetail
    }).catch((err: Error) => req.log.error({ err: err.message }, 'could not write API activity log'));
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'integration API error');
      return fail(req, reply, status, 'Internal error; retry later');
    }
    return fail(req, reply, status, err.message);
  });

  app.get('/api/v1/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable', time: new Date().toISOString() });
    }
  });

  // GET {employeesPath}?modifiedSince=ISO&page=N&pageSize=M → { data, page, pageSize, total, hasMore }
  app.get('/api/v1/employees', { config: { rateLimit } }, async (req, reply) => {
    const q = employeesQuery.safeParse(req.query);
    if (!q.success) return fail(req, reply, 400, q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const since = q.data.modifiedSince ? new Date(q.data.modifiedSince) : null;
    return pageForApi(since, q.data.page, q.data.pageSize);
  });

  // GET {locationsPath} → { data: WebLocation[] }
  app.get('/api/v1/locations', { config: { rateLimit } }, async () => {
    const rows = (
      await pool.query<{ ref: string; name: string; address: string | null; timezone: string | null }>(
        'SELECT ref, name, address, timezone FROM locations ORDER BY ref'
      )
    ).rows;
    return { data: rows.map((r) => ({ ref: r.ref, name: r.name, address: r.address, timezone: r.timezone })) };
  });

  // POST {attendancePath} (Idempotency-Key header) → 201 | 409 duplicate | 422 business rejection | 400 invalid
  app.post('/api/v1/attendance', { config: { rateLimit } }, async (req, reply) => {
    const parsed = webAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(req, reply, 400, 'Invalid attendance payload', {
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
      });
    }
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (idempotencyKey !== undefined && (idempotencyKey.trim() === '' || idempotencyKey.length > 255))
      return fail(req, reply, 400, 'Idempotency-Key must be 1–255 characters');

    const out = await recordAttendance(pool, parsed.data, { source: 'api', idempotencyKey: idempotencyKey ?? null });
    switch (out.kind) {
      case 'created':
        req.apiDetail = `recorded ${parsed.data.eventId}`;
        return reply.code(201).send({ data: { id: out.id, eventId: parsed.data.eventId, receivedAt: out.receivedAt.toISOString() } });
      case 'duplicate':
        return fail(req, reply, 409, out.reason, { code: 'duplicate', recordId: out.id });
      case 'rejected':
        return fail(req, reply, 422, out.message, { code: out.code });
    }
  });

  // POST {attendancePath}/import — multipart `file` (CSV or XLSX in the BAMP scheduled-export layout, FR-1.5)
  app.post('/api/v1/attendance/import', { config: { rateLimit } }, async (req, reply) => {
    if (!req.isMultipart()) return fail(req, reply, 415, 'Send multipart/form-data with the export in a field named "file"');
    const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });
    if (!file) return fail(req, reply, 400, 'No file received: send the export in a multipart field named "file"');
    if (file.fieldname !== 'file') {
      file.file.resume();
      return fail(req, reply, 400, `Unexpected field "${file.fieldname}": the export must be sent in a field named "file"`);
    }
    const body = await file.toBuffer();
    const summary = await importAttendanceFile({ fileName: file.filename, mimeType: file.mimetype, body, channel: 'api' });
    req.apiDetail = summary.fileError
      ? `import #${summary.id} failed: ${summary.fileError}`
      : `import #${summary.id}: ${summary.rows} rows, ${summary.accepted} accepted, ${summary.duplicates} duplicate, ${summary.rejected} rejected`;
    const payload = {
      data: {
        importId: summary.id,
        fileName: summary.fileName,
        format: summary.format,
        rows: summary.rows,
        accepted: summary.accepted,
        duplicates: summary.duplicates,
        rejected: summary.rejected,
        errors: summary.errors.slice(0, 100),
        errorsTruncated: summary.errorsTruncated || summary.errors.length > 100
      }
    };
    if (summary.fileError) return reply.code(422).send({ error: summary.fileError, ...payload });
    return reply.code(200).send(payload);
  });
};
