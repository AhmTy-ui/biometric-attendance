import { initAdminCredentials, pruneSessions } from './auth/session.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';
import { pruneApiLog } from './services/queries.js';

async function main() {
  await migrate();
  await initAdminCredentials();
  const app = await buildServer();
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ url: config.PUBLIC_URL, integrationBase: `${config.PUBLIC_URL}/api/v1` }, 'reference HR web software ready');

  const housekeeping = async () => {
    try {
      await pruneSessions();
      await pruneApiLog(config.API_LOG_RETENTION_DAYS);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'housekeeping failed');
    }
  };
  await housekeeping();
  const timer = setInterval(() => void housekeeping(), 3600_000);
  timer.unref();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(timer);
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
