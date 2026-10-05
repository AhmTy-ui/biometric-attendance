import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (length differences are hidden by hashing both sides first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Masks a secret for display: first 4 and last 4 characters visible. */
export function maskSecret(value: string): string {
  if (value.length <= 10) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(24, value.length - 8))}${value.slice(-4)}`;
}
