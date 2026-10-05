import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { pool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 41_004_100;

/** Applies every not-yet-applied `migrations/*.sql` file in name order, each in its own transaction. */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      logger.info({ file }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then(async () => {
      logger.info('migrations complete');
      await pool.end();
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
