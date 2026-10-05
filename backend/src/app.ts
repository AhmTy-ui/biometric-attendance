import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { alertRoutes } from './modules/alerts.js';
import { attendanceRoutes } from './modules/attendance.js';
import { auditRoutes } from './modules/audit.js';
import { authRoutes } from './modules/auth.js';
import { dashboardRoutes } from './modules/dashboard.js';
import { deviceApiRoutes } from './modules/deviceApi.js';
import { deviceRoutes } from './modules/devices.js';
import { employeeRoutes } from './modules/employees.js';
import { firmwareRoutes } from './modules/firmware.js';
import { integrationRoutes } from './modules/integration.js';
import { locationRoutes } from './modules/locations.js';
import { reportRoutes } from './modules/reports.js';
import { settingsRoutes } from './modules/settings.js';
import { setupRoutes } from './modules/setup.js';
import { httpDuration, systemRoutes } from './modules/system.js';
import { userRoutes } from './modules/users.js';
import { registerWsGateway } from './services/wsGateway.js';

async function reportError(source: string, err: any, context: Record<string, unknown>) {
  await pool
    .query('INSERT INTO error_events (source, message, stack, context) VALUES ($1,$2,$3,$4)', [source, String(err?.message ?? err), err?.stack ?? null, JSON.stringify(context)])
    .catch(() => undefined);
  if (config.ERROR_WEBHOOK_URL) {
    fetch(config.ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, message: String(err?.message ?? err), stack: err?.stack, context, at: new Date().toISOString() })
    }).catch(() => undefined);
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const https =
    config.TLS_ENABLED && config.TLS_CERT_FILE && config.TLS_KEY_FILE
      ? { cert: readFileSync(config.TLS_CERT_FILE), key: readFileSync(config.TLS_KEY_FILE), minVersion: 'TLSv1.2' as const }
      : null;
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
    ...(https ? { https } : {})
  }) as unknown as FastifyInstance;

  // Keep the raw body for device request signatures (NFR-1.4).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new HttpError(400, 'bad_json', 'Malformed JSON body'), undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'wss:', 'ws:']
      }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true }
  });
  await app.register(cookie);
  if (config.CORS_ORIGINS) await app.register(cors, { origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true });
  // NFR-1.5: rate limiting, shared across instances via Redis.
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', redis, nameSpace: 'bamp-rl:' });
  await app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  // Maintenance mode (set via `npm run maintenance -- on "message"`), device API stays up so terminals keep uploading.
  app.addHook('onRequest', async (req, reply) => {
    (req as any).startedAt = process.hrtime.bigint();
    if (!req.url.startsWith('/api/')) return;
    const m = await redis.get('bamp:maintenance').catch(() => null);
    if (m) {
      return reply.code(503).send({ error: { code: 'maintenance', message: JSON.parse(m).message ?? 'Scheduled maintenance in progress.' } });
    }
  });

  // CSRF defence in depth: mutating dashboard requests must carry a custom header (cannot be sent cross-site without CORS).
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['x-bamp-csrf'] !== '1') throw new HttpError(403, 'csrf', 'Missing CSRF header');
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as any).startedAt as bigint | undefined;
    if (!started) return;
    const secs = Number(process.hrtime.bigint() - started) / 1e9;
    httpDuration.observe({ method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) }, secs);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } });
    }
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    }
    if (err.name === 'ZodError') {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Validation failed', details: err.issues } });
    }
    req.log.error({ err }, 'unhandled error');
    void reportError('http', err, { method: req.method, url: req.url, user: req.principal?.userId ?? null });
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(dashboardRoutes);
  await app.register(attendanceRoutes);
  await app.register(reportRoutes);
  await app.register(employeeRoutes);
  await app.register(locationRoutes);
  await app.register(deviceRoutes);
  await app.register(firmwareRoutes);
  await app.register(alertRoutes);
  await app.register(integrationRoutes);
  await app.register(userRoutes);
  await app.register(auditRoutes);
  await app.register(settingsRoutes);
  await app.register(deviceApiRoutes);
  await app.register(async (ws) => registerWsGateway(ws));

  // Serve the built dashboard (single-page app) when available.
  const dist = config.FRONTEND_DIST ? resolve(config.FRONTEND_DIST) : resolve(process.cwd(), '../frontend/dist');
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, maxAge: '1h' });
    const indexHtml = readFileSync(join(dist, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/device/') || req.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
    });
    logger.info({ dist }, 'serving dashboard');
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  }

  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection');
    void reportError('process', err, {});
  });
  return app;
}
