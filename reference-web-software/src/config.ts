import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('https://localhost:4100'),
  TLS_CERT_FILE: z.string().min(1, 'TLS_CERT_FILE is required (the service only listens over HTTPS)'),
  TLS_KEY_FILE: z.string().min(1, 'TLS_KEY_FILE is required (the service only listens over HTTPS)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_KEY: z.string().min(16, 'API_KEY must be at least 16 characters'),
  ADMIN_EMAIL: z.string().email('ADMIN_EMAIL must be an email address'),
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 characters'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100000).default(1200),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  API_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30)
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  // Treat empty strings as "not set" so defaults apply.
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Configuration errors are fatal and must be readable before the logger exists.
    process.stderr.write(`Invalid configuration (.env):\n${lines}\n`);
    process.exit(1);
  }
  return { ...parsed.data, PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/+$/, '') };
}

export const config = load();
