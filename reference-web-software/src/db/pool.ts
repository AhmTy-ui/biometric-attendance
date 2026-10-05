import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Return BIGINT/COUNT(*) as numbers (all counts here are far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
pool.on('error', (err) => logger.error({ err: err.message }, 'idle PostgreSQL client error'));

export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
