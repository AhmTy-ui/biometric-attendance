import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Single-instance lock: two agents on one sensor/store would corrupt the attendance buffer's ordering guarantees. */

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockHolder(dataDir: string): number | null {
  const file = join(dataDir, 'agent.lock');
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
}

export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const holder = lockHolder(dataDir);
  if (holder) throw new Error(`Another device agent (pid ${holder}) is already running on ${dataDir}`);
  const file = join(dataDir, 'agent.lock');
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  };
  process.once('exit', release);
  return release;
}
