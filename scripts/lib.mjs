import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const IS_WIN = platform() === 'win32';
export const RUNTIME = process.env.BAMP_RUNTIME ?? (IS_WIN ? join(process.env.LOCALAPPDATA ?? homedir(), 'bamp-runtime') : join(homedir(), '.bamp-runtime'));
export const exe = (name) => (IS_WIN ? `${name}.exe` : name);

export const paths = {
  secrets: join(RUNTIME, 'secrets.json'),
  kek: join(RUNTIME, 'keys', 'template-kek.b64'),
  pki: join(RUNTIME, 'pki'),
  pgBin: join(RUNTIME, 'pgsql', 'bin'),
  pgData: join(RUNTIME, 'data', 'postgres'),
  redisDir: join(RUNTIME, 'redis'),
  redisData: join(RUNTIME, 'data', 'redis'),
  redisConf: join(RUNTIME, 'config', 'redis.conf'),
  weed: join(RUNTIME, 'seaweedfs', exe('weed')),
  s3Data: join(RUNTIME, 'data', 'seaweedfs'),
  s3Config: join(RUNTIME, 'config', 's3-identities.json'),
  mosquittoConf: join(RUNTIME, 'config', 'mosquitto.conf'),
  mosquittoData: join(RUNTIME, 'data', 'mosquitto'),
  dynsec: join(RUNTIME, 'data', 'mosquitto', 'dynamic-security.json'),
  logs: join(RUNTIME, 'logs')
};

export function findMosquittoDir() {
  const candidates = IS_WIN
    ? [process.env.MOSQUITTO_DIR, 'C:\\Program Files\\mosquitto', 'C:\\Program Files (x86)\\mosquitto'].filter(Boolean)
    : ['/usr/sbin', '/usr/local/sbin', '/opt/homebrew/sbin', '/usr/bin'];
  for (const c of candidates) if (existsSync(join(c, exe('mosquitto')))) return c;
  throw new Error('Mosquitto not found. Install Eclipse Mosquitto 2.x (winget install EclipseFoundation.Mosquitto) or set MOSQUITTO_DIR.');
}

export function findDynsecPlugin(mosqDir) {
  const candidates = IS_WIN
    ? [join(mosqDir, 'mosquitto_dynamic_security.dll')]
    : ['/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so', '/usr/lib/mosquitto_dynamic_security.so', '/usr/local/lib/mosquitto_dynamic_security.so'];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('mosquitto_dynamic_security plugin not found');
}

export function findRedisServer() {
  const p = join(paths.redisDir, exe('redis-server'));
  if (existsSync(p)) return p;
  if (!IS_WIN) return 'redis-server';
  throw new Error(`redis-server not found in ${paths.redisDir}`);
}

export function findWeed() {
  if (existsSync(paths.weed)) return paths.weed;
  if (!IS_WIN) return 'weed';
  throw new Error(`SeaweedFS (weed) not found at ${paths.weed}`);
}

export function pgBin(name) {
  const p = join(paths.pgBin, exe(name));
  if (existsSync(p)) return p;
  if (!IS_WIN) return name;
  throw new Error(`${name} not found in ${paths.pgBin}`);
}
