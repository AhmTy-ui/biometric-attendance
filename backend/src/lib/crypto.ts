import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, readKek } from '../config.js';

let kekCache: Buffer | null = null;
function kek(): Buffer {
  if (!kekCache) kekCache = readKek();
  return kekCache;
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = (token: string) => sha256Hex(token);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM encrypt a small secret with the KEK; output is `iv.tag.ciphertext` base64url. */
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openSecret(sealed: string): string {
  const [iv, tag, ct] = sealed.split('.');
  const d = createDecipheriv('aes-256-gcm', kek(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Envelope encryption for biometric templates (NFR-3.1).
 * A fresh 256-bit data key encrypts the template; the data key is wrapped by the KEK, which lives
 * in a key file managed separately from PostgreSQL. The ciphertext goes to object storage.
 */
export function envelopeEncrypt(plaintext: Buffer) {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  const authTag = c.getAuthTag();
  const wrapIv = randomBytes(12);
  const w = createCipheriv('aes-256-gcm', kek(), wrapIv);
  const wrapped = Buffer.concat([w.update(dek), w.final()]);
  const wrappedDek = [wrapIv.toString('base64'), w.getAuthTag().toString('base64'), wrapped.toString('base64')].join('.');
  dek.fill(0);
  return { ciphertext, iv: iv.toString('base64'), authTag: authTag.toString('base64'), wrappedDek, kekId: config.KEK_ID };
}

export function envelopeDecrypt(ciphertext: Buffer, ivB64: string, tagB64: string, wrappedDek: string): Buffer {
  const [wIv, wTag, wCt] = wrappedDek.split('.');
  const u = createDecipheriv('aes-256-gcm', kek(), Buffer.from(wIv, 'base64'));
  u.setAuthTag(Buffer.from(wTag, 'base64'));
  const dek = Buffer.concat([u.update(Buffer.from(wCt, 'base64')), u.final()]);
  const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  const out = Buffer.concat([d.update(ciphertext), d.final()]);
  dek.fill(0);
  return out;
}

/**
 * Canonical string signed by devices on every HTTPS request (NFR-1.3 / NFR-1.4):
 *   METHOD \n PATH(with query) \n TIMESTAMP(unix seconds) \n NONCE \n SHA256(body)
 */
export function deviceSignature(secret: string, method: string, path: string, timestamp: string, nonce: string, body: Buffer | string) {
  const canonical = [method.toUpperCase(), path, timestamp, nonce, sha256Hex(body)].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/** Human-friendly activation code, e.g. 7KQ4-M2XP-9RTA */
export function activationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
