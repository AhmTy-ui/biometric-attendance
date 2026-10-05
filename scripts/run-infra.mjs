/**
 * Runs the local infrastructure in the foreground: PostgreSQL 16, Redis, SeaweedFS (S3 API on :9000) and
 * Mosquitto (MQTT/TLS on :8883). Ctrl+C stops everything cleanly.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { exe, findMosquittoDir, findRedisServer, findWeed, paths, pgBin } from './lib.mjs';

if (!existsSync(paths.secrets)) {
  console.error('Run `npm run setup` first.');
  process.exit(1);
}

const colors = { postgres: 34, redis: 31, s3: 33, mosquitto: 35 };
const children = [];

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  const tag = `\x1b[${colors[name] ?? 37}m[${name}]\x1b[0m`;
  const pipe = (s) =>
    s.on('data', (d) =>
      d
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        // SeaweedFS logs every info event (glog "I…" lines); keep warnings and errors only.
        .filter((l) => name !== 's3' || !/^I\d{4} /.test(l))
        .forEach((l) => console.log(`${tag} ${l}`))
    );
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => console.log(`${tag} exited (${code})`));
  children.push({ name, child });
  return child;
}

export function waitPort(port, host = '127.0.0.1', timeoutMs = 240000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = connect(port, host);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > until) reject(new Error(`port ${port} not ready`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

start('postgres', pgBin('postgres'), ['-D', paths.pgData, '-p', '5432', '-c', 'listen_addresses=127.0.0.1']);
// The Windows Redis build is msys-based and misreads absolute "C:\" paths; pass the config relative to its folder.
start('redis', findRedisServer(), [basename(paths.redisConf)], { cwd: dirname(paths.redisConf) });
start('s3', findWeed(), [
  'server',
  `-dir=${paths.s3Data}`,
  '-ip=127.0.0.1',
  '-ip.bind=127.0.0.1',
  '-master.port=9333',
  '-master.volumeSizeLimitMB=1024',
  '-volume.port=9380',
  '-volume.max=0',
  '-filer',
  '-filer.port=8888',
  '-s3',
  '-s3.port=9000',
  `-s3.config=${paths.s3Config}`
]);
const mosq = findMosquittoDir();
start('mosquitto', join(mosq, exe('mosquitto')), ['-c', paths.mosquittoConf], { cwd: mosq });

await Promise.all([waitPort(5432), waitPort(6379), waitPort(9000), waitPort(8883)]).then(
  () => console.log('\n\x1b[32mInfrastructure ready:\x1b[0m PostgreSQL :5432 · Redis :6379 · S3 :9000 · MQTT/TLS :8883\n'),
  (err) => console.error(`\x1b[31m${err.message}\x1b[0m`)
);

const stop = () => {
  for (const { name, child } of children.reverse()) {
    if (name === 'postgres') {
      try {
        spawn(pgBin('pg_ctl'), ['-D', paths.pgData, 'stop', '-m', 'fast'], { stdio: 'ignore' });
      } catch {
        child.kill();
      }
    } else child.kill();
  }
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
