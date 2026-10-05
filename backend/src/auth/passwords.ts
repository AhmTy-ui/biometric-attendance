import { hash, verify } from '@node-rs/argon2';

// Argon2id, OWASP 2024 baseline parameters.
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(hashStr: string | null | undefined, pw: string): Promise<boolean> {
  if (!hashStr) return false;
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}

// Constant-time dummy hash to equalise timing when the user does not exist.
let dummy: string | null = null;
export async function dummyVerify(pw: string) {
  if (!dummy) dummy = await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummy, pw);
}
