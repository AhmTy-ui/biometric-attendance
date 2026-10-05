/**
 * Starts the application processes (expects `npm run infra` to be running):
 *   reference web software (https://localhost:4100), backend API + dashboard (https://localhost:4000)
 *   and, with --dev, the Vite dev server (https://localhost:5173) with hot reload.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { IS_WIN, ROOT, RUNTIME } from './lib.mjs';

const dev = process.argv.includes('--dev');
const npm = IS_WIN ? 'npm.cmd' : 'npm';
const children = [];

function run(name, color, cwd, script) {
  const child = spawn(npm, ['run', script], {
    cwd: join(ROOT, cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: IS_WIN,
    windowsHide: true,
    // Outbound HTTPS between local services (adapter → web software) must trust the private CA from `npm run setup`.
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(RUNTIME, 'pki', 'ca.crt') }
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  for (const s of [child.stdout, child.stderr])
    s.on('data', (d) =>
      d
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log(`${tag} ${l}`))
    );
  child.on('exit', (c) => console.log(`${tag} exited (${c})`));
  children.push(child);
}

run('websoft', 36, 'reference-web-software', dev ? 'dev' : 'start');
run('backend', 32, 'backend', dev ? 'dev' : 'start');
if (dev) run('frontend', 33, 'frontend', 'dev');

const stop = () => {
  for (const c of children) {
    if (IS_WIN && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
