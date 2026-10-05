import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import { many, one, pool, tx } from '../db/pool.js';
import { redis } from '../lib/redis.js';
import { storageHealthy } from '../lib/s3.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit, verifyAuditChain } from '../services/audit.js';
import { mqttConnected } from '../services/mqtt.js';
import { wsClientCount } from '../services/wsGateway.js';
import { runBackup } from '../workers/scheduler.js';
import { forbidden } from '../lib/errors.js';

client.collectDefaultMetrics({ prefix: 'bamp_' });
export const httpDuration = new client.Histogram({
  name: 'bamp_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});
new client.Gauge({
  name: 'bamp_ws_clients',
  help: 'Connected dashboard WebSocket clients',
  collect() {
    this.set(wsClientCount());
  }
});
new client.Gauge({
  name: 'bamp_mqtt_connected',
  help: 'Backend connected to MQTT broker',
  collect() {
    this.set(mqttConnected() ? 1 : 0);
  }
});
new client.Gauge({
  name: 'bamp_delivery_backlog',
  help: 'Attendance events awaiting delivery to the web software',
  async collect() {
    const r = await pool.query(`SELECT count(*)::int AS n FROM attendance_deliveries WHERE status IN ('pending','retrying','delivering')`).catch(() => null);
    this.set(r?.rows[0]?.n ?? 0);
  }
});
new client.Gauge({
  name: 'bamp_dead_letter_events',
  help: 'Attendance events in the dead-letter queue',
  async collect() {
    const r = await pool.query(`SELECT count(*)::int AS n FROM attendance_deliveries WHERE status='dead_letter'`).catch(() => null);
    this.set(r?.rows[0]?.n ?? 0);
  }
});

async function components() {
  const [db, rd, st] = await Promise.all([
    pool.query('SELECT 1').then(() => true, () => false),
    redis.ping().then(() => true, () => false),
    storageHealthy()
  ]);
  return { api: true, database: db, redis: rd, mqtt: mqttConnected(), objectStorage: st };
}

export async function systemRoutes(app: FastifyInstance) {
  // Liveness / readiness for uptime monitoring and the reverse proxy.
  app.get('/health', async (_req, reply) => {
    const c = await components();
    const ok = c.database && c.redis;
    reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', components: c, time: new Date().toISOString() };
  });

  app.get('/metrics', async (req, reply) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
    if (!local) throw forbidden();
    reply.header('content-type', client.register.contentType);
    return client.register.metrics();
  });

  app.get('/api/system/status', { preHandler: requirePerm('settings.view') }, async () => {
    const [c, availability, backups, errors, maintenance] = await Promise.all([
      components(),
      many(
        `SELECT to_char(date_trunc('month', sampled_at), 'YYYY-MM') AS month,
                round(100.0 * count(*) FILTER (WHERE api_ok AND db_ok) / NULLIF(count(*),0), 3) AS availability_pct,
                round(100.0 * count(*) FILTER (WHERE mqtt_ok) / NULLIF(count(*),0), 3) AS mqtt_pct,
                count(*)::int AS samples
           FROM uptime_samples GROUP BY 1 ORDER BY 1 DESC LIMIT 12`
      ),
      many(`SELECT * FROM backups ORDER BY started_at DESC LIMIT 35`),
      many(`SELECT id, occurred_at, source, message FROM error_events ORDER BY occurred_at DESC LIMIT 50`),
      redis.get('bamp:maintenance').catch(() => null)
    ]);
    return {
      components: c,
      availability,
      backups,
      errors,
      maintenance: maintenance ? JSON.parse(maintenance) : null,
      wsClients: wsClientCount(),
      time: new Date().toISOString()
    };
  });

  app.post('/api/system/backup', { preHandler: requirePerm('settings.manage'), config: { rateLimit: { max: 2, timeWindow: '10 minutes' } } }, async (req) => {
    await tx((db) => audit(db, actorFromRequest(req), { action: 'system.backup_triggered', objectType: 'backup' }));
    await runBackup();
    return one(`SELECT * FROM backups ORDER BY started_at DESC LIMIT 1`);
  });

  app.get('/api/system/audit-integrity', { preHandler: requirePerm('audit.view') }, async () => verifyAuditChain());
}
