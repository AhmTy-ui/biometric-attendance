import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/security.js';

export const SESSION_COOKIE = 'ws_session';
export const LOGIN_CSRF_COOKIE = 'ws_login_csrf';

export interface AdminSession {
  tokenHash: string;
  email: string;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: AdminSession | null;
  }
}

let adminHash: string | null = null;

/** Hashes ADMIN_PASSWORD once at startup (argon2id); the plaintext is never compared directly. */
export async function initAdminCredentials() {
  adminHash = await hash(config.ADMIN_PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function checkCredentials(email: string, password: string): Promise<boolean> {
  if (!adminHash) throw new Error('Admin credentials not initialised');
  // Always run the argon2 verification so timing does not reveal whether the email matched.
  const passwordOk = await verify(adminHash, password);
  const emailOk = safeEqual(email.trim().toLowerCase(), config.ADMIN_EMAIL.toLowerCase());
  return passwordOk && emailOk;
}

const cookieBase = { path: '/', httpOnly: true, secure: true, sameSite: 'strict' as const };

export async function createSession(req: FastifyRequest, reply: FastifyReply, email: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.SESSION_ABSOLUTE_HOURS * 3600_000);
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, email, csrf_token, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256Hex(token), email, randomToken(24), expires, req.ip, (req.headers['user-agent'] ?? '').slice(0, 300)]
  );
  reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, expires });
  reply.clearCookie(LOGIN_CSRF_COOKIE, { ...cookieBase });
}

/** Resolves the session from the cookie, enforcing idle and absolute timeouts, and slides the idle window. */
export async function loadSession(req: FastifyRequest): Promise<AdminSession | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const tokenHash = sha256Hex(token);
  const r = await pool.query<{ email: string; csrf_token: string }>(
    `UPDATE admin_sessions SET last_seen_at=now()
      WHERE token_hash=$1 AND expires_at > now() AND last_seen_at > now() - make_interval(mins => $2)
      RETURNING email, csrf_token`,
    [tokenHash, config.SESSION_IDLE_MINUTES]
  );
  const row = r.rows[0];
  return row ? { tokenHash, email: row.email, csrfToken: row.csrf_token } : null;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.session) await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [req.session.tokenHash]);
  reply.clearCookie(SESSION_COOKIE, { ...cookieBase });
}

/** Double-submit token for the (pre-session) login form. */
export function issueLoginCsrf(reply: FastifyReply): string {
  const t = randomToken(24);
  reply.setCookie(LOGIN_CSRF_COOKIE, t, { ...cookieBase, maxAge: 3600 });
  return t;
}

export function verifyLoginCsrf(req: FastifyRequest, submitted: string | undefined): boolean {
  const cookie = req.cookies[LOGIN_CSRF_COOKIE];
  return !!cookie && !!submitted && safeEqual(cookie, submitted);
}

export function verifyCsrf(req: FastifyRequest, submitted: string | undefined): boolean {
  return !!req.session && !!submitted && safeEqual(req.session.csrfToken, submitted);
}

export async function pruneSessions() {
  await pool.query(
    `DELETE FROM admin_sessions WHERE expires_at < now() OR last_seen_at < now() - make_interval(mins => $1)`,
    [config.SESSION_IDLE_MINUTES]
  );
}
