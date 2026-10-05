import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Return numeric / bigint as JS numbers where safe; timestamps stay as Date.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1082, (v) => v); // date → 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  return db.query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const r = await db.query<T>(text, params as any[]);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(text, params as any[]);
  return r.rows;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
