import { closeSync, createReadStream, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

/**
 * Minimal streaming extractor for gzip-compressed tar archives (ustar + GNU long names + pax path headers),
 * sufficient for firmware packages produced by `npm pack` or `tar czf`. Symlinks and devices are refused.
 */

function field(h: Buffer, off: number, len: number) {
  const raw = h.subarray(off, off + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? len : end).toString('utf8');
}

function octal(h: Buffer, off: number, len: number) {
  const s = field(h, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer) {
  const expected = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === expected;
}

function safeTarget(dest: string, name: string): string {
  const clean = normalize(name.replace(/\\/g, '/')).replace(/^(\.\/|\.\\)+/, '');
  if (!clean || clean === '.' || isAbsolute(clean) || clean.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path in firmware package: ${name}`);
  const full = join(dest, clean);
  if (!full.startsWith(dest.endsWith(sep) ? dest : dest + sep)) throw new Error(`Unsafe path in firmware package: ${name}`);
  return full;
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space < 0) break;
    const len = parseInt(buf.subarray(i, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

type State =
  | { kind: 'header' }
  | { kind: 'file'; remaining: number; pad: number; fd: number }
  | { kind: 'meta'; remaining: number; pad: number; type: string; parts: Buffer[] }
  | { kind: 'skip'; remaining: number };

export async function extractTarGz(archive: string, dest: string): Promise<number> {
  mkdirSync(dest, { recursive: true });
  let pending: Buffer = Buffer.alloc(0);
  let state: State = { kind: 'header' };
  let longName: string | null = null;
  let paxPath: string | null = null;
  let files = 0;
  let ended = false;

  const finishData = (pad: number): State => (pad ? { kind: 'skip', remaining: pad } : { kind: 'header' });

  try {
    for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
      if (ended) break;
      pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
      for (;;) {
        if (state.kind === 'header') {
          if (pending.length < 512) break;
          const h = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (h.every((b) => b === 0)) {
            ended = true;
            break;
          }
          if (!checksumOk(h)) throw new Error('Corrupt firmware package (tar header checksum)');
          const size = octal(h, 124, 12);
          const type = String.fromCharCode(h[156] || 0x30);
          const prefix = field(h, 345, 155);
          const baseName = field(h, 0, 100);
          const name = longName ?? paxPath ?? (prefix ? `${prefix}/${baseName}` : baseName);
          const pad = (512 - (size % 512)) % 512;
          if (type === 'L' || type === 'x' || type === 'g') {
            state = { kind: 'meta', remaining: size, pad, type, parts: [] };
            continue;
          }
          longName = null;
          paxPath = null;
          if (type === '0' || type === '7' || type === '\0') {
            const target = safeTarget(dest, name);
            mkdirSync(dirname(target), { recursive: true });
            const fd = openSync(target, 'w', (octal(h, 100, 8) & 0o755) | 0o600);
            files++;
            if (size === 0) {
              closeSync(fd);
              state = finishData(pad);
            } else state = { kind: 'file', remaining: size, pad, fd };
          } else if (type === '5') {
            mkdirSync(safeTarget(dest, name), { recursive: true });
            state = finishData(size ? size + pad : 0);
          } else if (type === '2' || type === '1' || type === '3' || type === '4' || type === '6') {
            throw new Error(`Firmware package contains a link or special file (${name}); refusing to install`);
          } else {
            state = finishData(size + pad);
          }
        } else if (state.kind === 'file') {
          if (!pending.length) break;
          const take = Math.min(state.remaining, pending.length);
          writeSync(state.fd, pending, 0, take);
          pending = pending.subarray(take);
          state.remaining -= take;
          if (state.remaining === 0) {
            closeSync(state.fd);
            state = finishData(state.pad);
          }
        } else if (state.kind === 'meta') {
          if (!pending.length) break;
          const take = Math.min(state.remaining, pending.length);
          state.parts.push(Buffer.from(pending.subarray(0, take)));
          pending = pending.subarray(take);
          state.remaining -= take;
          if (state.remaining === 0) {
            const data = Buffer.concat(state.parts);
            if (state.type === 'L') longName = field(data, 0, data.length);
            else if (state.type === 'x') paxPath = parsePax(data).path ?? null;
            state = finishData(state.pad);
          }
        } else {
          if (!pending.length) break;
          const take = Math.min(state.remaining, pending.length);
          pending = pending.subarray(take);
          state.remaining -= take;
          if (state.remaining === 0) state = { kind: 'header' };
        }
      }
    }
  } finally {
    if (state.kind === 'file') closeSync(state.fd);
  }
  if (state.kind !== 'header') throw new Error('Firmware package is truncated');
  return files;
}
