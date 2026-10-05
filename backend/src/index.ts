import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { ensureBuckets } from './lib/s3.js';
import { startDeliveryLoop, stopDeliveryLoop } from './integration/delivery.js';
import { registerDeviceMqttHandlers } from './services/devices.js';
import { startMqtt, stopMqtt } from './services/mqtt.js';
import { startScheduler, stopScheduler } from './workers/scheduler.js';

async function main() {
  await migrate();
  await ensureBuckets();
  registerDeviceMqttHandlers();
  await startMqtt();
  const app = await buildApp();
  await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
  startDeliveryLoop();
  await startScheduler();
  logger.info({ url: config.PUBLIC_URL }, 'BAMP backend ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopDeliveryLoop();
    await app.close().catch(() => undefined);
    await stopScheduler().catch(() => undefined);
    await stopMqtt().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
