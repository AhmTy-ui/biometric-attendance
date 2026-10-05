import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().url().default('https://localhost:4000'),
  // TLS for the API/dashboard listener (NFR-1.1). When the service sits behind the TLS reverse proxy set TLS_ENABLED=false.
  TLS_ENABLED: bool.default('true'),
  TLS_CERT_FILE: z.string().optional(),
  TLS_KEY_FILE: z.string().optional(),
  TRUST_PROXY: bool.default('false'),
  FRONTEND_DIST: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string(),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  MQTT_URL: z.string().default('mqtts://localhost:8883'),
  MQTT_CA_FILE: z.string(),
  MQTT_USERNAME: z.string().default('bamp-cloud'),
  MQTT_PASSWORD: z.string(),
  MQTT_PUBLIC_HOST: z.string().default('localhost'),
  MQTT_PUBLIC_PORT: z.coerce.number().default(8883),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  S3_BUCKET_FIRMWARE: z.string().default('bamp-firmware'),
  S3_BUCKET_TEMPLATES: z.string().default('bamp-templates'),
  S3_BUCKET_EXPORTS: z.string().default('bamp-exports'),
  S3_BUCKET_BACKUPS: z.string().default('bamp-backups'),

  // Key-encryption key for biometric templates and device secrets. Stored OUTSIDE the database (NFR-3.1).
  KEK_FILE: z.string(),
  KEK_ID: z.string().default('kek-1'),

  SESSION_COOKIE_NAME: z.string().default('bamp_session'),
  COOKIE_SECURE: bool.default('true'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('BAMP <no-reply@bamp.local>'),

  PG_DUMP_PATH: z.string().default('pg_dump'),
  BACKUP_RETENTION_DAYS: z.coerce.number().default(30),
  BACKUP_CRON_HOUR_UTC: z.coerce.number().default(1),

  DEVICE_REQUEST_WINDOW_SECONDS: z.coerce.number().default(300),
  HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().default(90),

  ERROR_WEBHOOK_URL: z.string().optional()
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;

export function readKek(): Buffer {
  const raw = readFileSync(config.KEK_FILE, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`KEK at ${config.KEK_FILE} must be 32 bytes base64-encoded`);
  return key;
}
