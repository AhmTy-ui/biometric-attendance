import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSession } from './auth/session.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { randomToken } from './lib/security.js';
import { loggerOptions } from './logger.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { errorPage } from './ui/views.js';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), 'static');

function readTlsFile(path: string, label: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`Cannot read ${label} at ${path}: ${(err as Error).message}. Run "node scripts/setup-local.mjs" from the repository root.`);
  }
}

export async function buildServer() {
  const tls = {
    cert: readTlsFile(config.TLS_CERT_FILE, 'TLS_CERT_FILE'),
    key: readTlsFile(config.TLS_KEY_FILE, 'TLS_KEY_FILE'),
    minVersion: 'TLSv1.2' as const
  };

  const app = Fastify({
    logger: loggerOptions,
    // HTTPS only: node:https server with TLS 1.2 as the floor.
    serverFactory: (handler) => createServer(tls, handler),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    return503OnClosing: true
  });

  app.decorateRequest('session', null);
  app.decorateRequest('apiDetail', null);

  // Per-process secret: only signs short-lived flash messages.
  await app.register(cookie, { secret: randomToken(32) });
  await app.register(formbody, { bodyLimit: 256 * 1024 });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10, parts: 20 } });
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('strict-transport-security', 'max-age=31536000');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!req.url.startsWith('/api/')) {
      reply.header('x-frame-options', 'DENY');
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
      );
    }
    return payload;
  });

  // Static assets (one stylesheet, one script), loaded once at startup.
  const assets: Record<string, { body: Buffer; type: string }> = {
    'app.css': { body: readFileSync(join(staticDir, 'app.css')), type: 'text/css; charset=utf-8' },
    'app.js': { body: readFileSync(join(staticDir, 'app.js')), type: 'text/javascript; charset=utf-8' }
  };
  app.get<{ Params: { name: string } }>('/static/:name', async (req, reply) => {
    const a = assets[req.params.name];
    if (!a) return reply.code(404).type('text/plain').send('Not found');
    return reply.type(a.type).header('cache-control', 'public, max-age=300').send(a.body);
  });

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable', time: new Date().toISOString() });
    }
  });

  await app.register(apiRoutes);
  await app.register(adminRoutes);

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: `No route ${req.method} ${req.url.split('?')[0]}` });
    const session = await loadSession(req).catch(() => null);
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(errorPage(session, 404, 'Page not found', 'The page you requested does not exist.'));
  });

  return app;
}
