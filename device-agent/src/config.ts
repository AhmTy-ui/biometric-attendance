import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Root of the package that is currently executing (base install or a staged firmware version). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Root of the base installation (the service always starts this one; it may launch a staged firmware version). */
export const BASE_ROOT = process.env.BAMP_BASE_ROOT ? resolve(process.env.BAMP_BASE_ROOT) : PACKAGE_ROOT;

// Environment: explicit file, working directory, then the installation directory. Existing variables win.
for (const candidate of [process.env.BAMP_ENV_FILE, join(process.cwd(), '.env'), join(BASE_ROOT, '.env')]) {
  if (candidate && existsSync(candidate)) dotenv.config({ path: candidate, override: false });
}

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s.optional());
const hex32 = (def: number) =>
  z.preprocess(blankToUndefined, z.string().regex(/^(0x)?[0-9a-fA-F]{1,8}$/).optional()).transform((v) => (v === undefined ? def : parseInt(v.replace(/^0x/i, ''), 16) >>> 0));

const envSchema = z.object({
  BAMP_API_URL: opt(z.string().url()),
  BAMP_CA_FILE: opt(z.string()),
  BAMP_DATA_DIR: opt(z.string()),
  BAMP_DEVICE_UID: opt(z.string().min(3).max(64)),
  BAMP_TIMEZONE: opt(z.string()),
  BAMP_STORAGE_CAPACITY_EVENTS: opt(z.coerce.number().int().min(1000).max(50_000_000)),
  BAMP_HEADLESS: opt(z.enum(['0', '1', 'true', 'false'])),
  SENSOR_DRIVER: z.preprocess(blankToUndefined, z.enum(['serial', 'console']).default('serial')),
  SENSOR_PORT: opt(z.string()),
  SENSOR_BAUD: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(57600)),
  SENSOR_ADDRESS: hex32(0xffffffff),
  SENSOR_PASSWORD: hex32(0),
  SENSOR_SCORE_SCALE: z.preprocess(blankToUndefined, z.coerce.number().positive().default(150)),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'))
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid device-agent environment configuration:\n${issues}`);
  process.exit(78);
}
const env = parsed.data;

function defaultDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMDATA || process.env.LOCALAPPDATA || homedir();
    return join(base, 'bamp-device');
  }
  return existsSync('/var/lib') && process.getuid?.() === 0 ? '/var/lib/bamp-device' : join(homedir(), '.bamp-device');
}

export const config = {
  apiUrl: env.BAMP_API_URL?.replace(/\/+$/, ''),
  caFile: env.BAMP_CA_FILE,
  dataDir: resolve(env.BAMP_DATA_DIR ?? defaultDataDir()),
  deviceUid: env.BAMP_DEVICE_UID,
  timezone: env.BAMP_TIMEZONE,
  storageCapacityOverride: env.BAMP_STORAGE_CAPACITY_EVENTS,
  headless: env.BAMP_HEADLESS === '1' || env.BAMP_HEADLESS === 'true' || !process.stdin.isTTY,
  sensor: {
    driver: env.SENSOR_DRIVER,
    port: env.SENSOR_PORT ?? (process.platform === 'win32' ? 'COM3' : '/dev/ttyS0'),
    baud: env.SENSOR_BAUD,
    address: env.SENSOR_ADDRESS,
    password: env.SENSOR_PASSWORD,
    scoreScale: env.SENSOR_SCORE_SCALE
  },
  logLevel: env.LOG_LEVEL
};

function readPackageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Version of the base installation (the "factory" firmware). */
export const BASE_VERSION = readPackageVersion(BASE_ROOT);
/** Firmware version currently running: the staged version label when launched by the OTA launcher, else package.json. */
export const RUNNING_VERSION = (process.env.BAMP_FIRMWARE_VERSION || readPackageVersion(PACKAGE_ROOT)).slice(0, 32);

export function readCaFile(): string | null {
  if (!config.caFile) return null;
  if (!existsSync(config.caFile)) throw new Error(`BAMP_CA_FILE not found: ${config.caFile}`);
  return readFileSync(config.caFile, 'utf8');
}
