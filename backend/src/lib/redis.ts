import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from './logger.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));

/** Separate connection options for BullMQ (it needs its own blocking connections). */
export const bullConnection = { url: config.REDIS_URL, maxRetriesPerRequest: null } as const;

export function createRedis() {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
