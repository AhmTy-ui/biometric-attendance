import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { getSettings } from '../services/settings.js';
import type { Actor } from '../services/audit.js';
import { type Permission, type Principal, type Role, assertCan, loadLocationScope } from './rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export async function createSession(userId: string, orgId: string, ip: string, userAgent: string | undefined) {
  const s = await getSettings(orgId, 'security');
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + s.sessionAbsoluteHours * 3600_000);
  const r = await pool.query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, hashToken(token), ip, userAgent ?? null, expiresAt]
  );
  return { token, sessionId: r.rows[0].id as string, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    expires: expiresAt
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}

export async function revokeSession(sessionId: string) {
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [sessionId]);
}

export class SessionExpiredError extends HttpError {
  constructor() {
    super(401, 'session_expired', 'Your session has expired. Please sign in again.');
  }
}

/** Resolve the dashboard principal from the session cookie. Returns null when no cookie is present. */
export async function authenticateRequest(req: FastifyRequest): Promise<Principal | null> {
  const token = req.cookies?.[config.SESSION_COOKIE_NAME];
  if (!token) return null;
  const r = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, s.expires_at, s.revoked_at,
            u.id AS user_id, u.organization_id, u.email, u.full_name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [hashToken(token)]
  );
  const row = r.rows[0];
  if (!row || row.revoked_at || row.status !== 'active') throw new SessionExpiredError();
  const sec = await getSettings(row.organization_id, 'security');
  const now = Date.now();
  const idleDeadline = new Date(row.last_seen_at).getTime() + sec.sessionIdleMinutes * 60_000;
  if (now > new Date(row.expires_at).getTime() || now > idleDeadline) {
    await revokeSession(row.session_id);
    throw new SessionExpiredError();
  }
  if (now - new Date(row.last_seen_at).getTime() > 30_000) {
    await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
  }
  const role = row.role as Role;
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    email: row.email,
    fullName: row.full_name,
    role,
    locationIds: await loadLocationScope(row.user_id, role),
    sessionId: row.session_id
  };
}

/** preHandler: require an authenticated dashboard session. */
export async function requireAuth(req: FastifyRequest) {
  const p = await authenticateRequest(req);
  if (!p) throw unauthorized();
  req.principal = p;
}

/** preHandler factory: require authentication and a permission (FR-5.3, enforced server-side on every request). */
export function requirePerm(perm: Permission) {
  return async (req: FastifyRequest) => {
    if (!req.principal) await requireAuth(req);
    assertCan(req.principal!, perm);
  };
}

export function actorFromRequest(req: FastifyRequest): Actor {
  const p = req.principal;
  return {
    type: 'user',
    id: p?.userId ?? null,
    name: p?.fullName ?? null,
    role: p?.role ?? null,
    organizationId: p?.organizationId ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null
  };
}
