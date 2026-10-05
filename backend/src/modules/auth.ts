import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool, tx } from '../db/pool.js';
import { hashToken, openSecret, randomToken, sealSecret } from '../lib/crypto.js';
import { HttpError, badRequest, locked, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { dummyVerify, hashPassword, verifyPassword } from '../auth/passwords.js';
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, type Role } from '../auth/rbac.js';
import {
  actorFromRequest,
  clearSessionCookie,
  createSession,
  requireAuth,
  revokeSession,
  setSessionCookie
} from '../auth/session.js';
import { audit, type Actor } from '../services/audit.js';
import { sendMail } from '../services/mailer.js';
import { getSettings, passwordPolicyErrors } from '../services/settings.js';

authenticator.options = { window: 1, step: 30, digits: 6 };

const RECOVERY_CODE_COUNT = 10;

/** Accepts "ABCDE-FGHIJ", "abcde fghij" or "ABCDEFGHIJ". */
function normaliseRecoveryCode(raw: string) {
  const s = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : raw.trim().toUpperCase();
}

function userActor(u: any, req: FastifyRequest): Actor {
  return {
    type: 'user',
    id: u.id,
    name: u.full_name,
    role: u.role,
    organizationId: u.organization_id,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null
  };
}

async function mfaRequiredFor(u: any): Promise<boolean> {
  if (u.mfa_required) return true;
  const m = await getSettings(u.organization_id, 'mfa');
  return (
    (u.role === 'administrator' && m.enforceForAdministrators) ||
    (u.role === 'manager' && m.enforceForManagers) ||
    (u.role === 'branch_supervisor' && m.enforceForSupervisors)
  );
}

async function issueChallenge(userId: string) {
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'mfa_challenge',$2, now() + interval '10 minutes')`,
    [userId, hashToken(token)]
  );
  return token;
}

async function consumeToken(token: string, purpose: string, consume = true) {
  const row = await one(
    `SELECT t.id, t.user_id, t.expires_at, t.used_at, u.*
       FROM user_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.purpose=$2`,
    [hashToken(token), purpose]
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  if (consume) await pool.query('UPDATE user_tokens SET used_at=now() WHERE token_hash=$1', [hashToken(token)]);
  return row;
}

async function startSession(req: FastifyRequest, reply: FastifyReply, u: any, method: string) {
  const { token, expiresAt } = await createSession(u.id, u.organization_id, req.ip, req.headers['user-agent']);
  setSessionCookie(reply, token, expiresAt);
  await tx(async (db) => {
    await db.query('UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now(), last_login_ip=$2 WHERE id=$1', [
      u.id,
      req.ip
    ]);
    await audit(db, userActor(u, req), {
      action: 'auth.login',
      objectType: 'user',
      objectId: u.id,
      objectLabel: u.email,
      after: { method, sessionExpiresAt: expiresAt.toISOString() }
    });
  });
  return { ok: true, sessionExpiresAt: expiresAt.toISOString() };
}

async function generateRecoveryCodes(db: any, userId: string) {
  await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = randomToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase().padEnd(10, 'X');
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    codes.push(code);
    await db.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, hashToken(code)]);
  }
  return codes;
}

export async function recordFailedLogin(u: any, req: FastifyRequest, reason: string) {
  const sec = await getSettings(u.organization_id, 'security');
  const failed = (u.failed_login_count ?? 0) + 1;
  const lockUntil = failed >= sec.lockoutThreshold ? new Date(Date.now() + sec.lockoutMinutes * 60_000) : null;
  await tx(async (db) => {
    await db.query('UPDATE users SET failed_login_count=$2, locked_until=COALESCE($3, locked_until) WHERE id=$1', [u.id, failed, lockUntil]);
    await audit(db, userActor(u, req), {
      action: lockUntil ? 'auth.account_locked' : 'auth.login_failed',
      objectType: 'user',
      objectId: u.id,
      objectLabel: u.email,
      after: { reason, failedAttempts: failed, lockedUntil: lockUntil?.toISOString() ?? null }
    });
  });
  return { failed, lockUntil, threshold: sec.lockoutThreshold };
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/login', strict, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const u = await one('SELECT * FROM users WHERE email=$1', [body.email]);
    if (!u || u.status === 'invited' || !u.password_hash) {
      await dummyVerify(body.password);
      throw unauthorized('Invalid email or password.');
    }
    if (u.status === 'disabled') throw new HttpError(403, 'account_disabled', 'This account has been disabled. Contact your administrator.');
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      throw locked('Account temporarily locked after repeated failed sign-in attempts.', { lockedUntil: u.locked_until });
    }
    if (!(await verifyPassword(u.password_hash, body.password))) {
      const r = await recordFailedLogin(u, req, 'bad_password');
      if (r.lockUntil) throw locked('Account temporarily locked after repeated failed sign-in attempts.', { lockedUntil: r.lockUntil });
      throw new HttpError(401, 'unauthorized', 'Invalid email or password.', { attemptsRemaining: r.threshold - r.failed });
    }
    if (u.mfa_enabled) {
      return { mfaRequired: true, challengeToken: await issueChallenge(u.id) };
    }
    if (await mfaRequiredFor(u)) {
      return { mfaSetupRequired: true, challengeToken: await issueChallenge(u.id) };
    }
    return startSession(req, reply, u, 'password');
  });

  app.post('/api/auth/mfa/verify', strict, async (req, reply) => {
    const body = parse(
      z.object({ challengeToken: z.string(), code: z.string().optional(), recoveryCode: z.string().optional() }),
      req.body
    );
    const u = await consumeToken(body.challengeToken, 'mfa_challenge', false);
    if (!u) throw new HttpError(401, 'challenge_expired', 'Your verification window expired. Please sign in again.');
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      throw locked('Account temporarily locked after repeated failed verification attempts.', { lockedUntil: u.locked_until });
    }
    let ok = false;
    let method = 'totp';
    if (body.code && u.mfa_secret_enc) {
      ok = authenticator.check(body.code.replace(/\s/g, ''), openSecret(u.mfa_secret_enc));
    } else if (body.recoveryCode) {
      method = 'recovery_code';
      const rc = await one(
        'UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id',
        [u.user_id, hashToken(normaliseRecoveryCode(body.recoveryCode))]
      );
      ok = Boolean(rc);
    }
    if (!ok) {
      const r = await recordFailedLogin({ ...u, id: u.user_id }, req, 'bad_mfa_code');
      if (r.lockUntil) throw locked('Account temporarily locked after repeated failed verification attempts.', { lockedUntil: r.lockUntil });
      throw new HttpError(401, 'invalid_code', 'The verification code is incorrect.', { attemptsRemaining: r.threshold - r.failed });
    }
    await consumeToken(body.challengeToken, 'mfa_challenge', true);
    return startSession(req, reply, { ...u, id: u.user_id }, method);
  });

  /** Start MFA enrolment either during sign-in (challengeToken) or from an authenticated session. */
  app.post('/api/auth/mfa/setup/start', strict, async (req) => {
    const body = parse(z.object({ challengeToken: z.string().optional() }), req.body ?? {});
    let user: any;
    if (body.challengeToken) {
      const t = await consumeToken(body.challengeToken, 'mfa_challenge', false);
      if (!t) throw new HttpError(401, 'challenge_expired', 'Your verification window expired. Please sign in again.');
      user = { ...t, id: t.user_id };
    } else {
      await requireAuth(req);
      user = await one('SELECT * FROM users WHERE id=$1', [req.principal!.userId]);
    }
    if (user.mfa_enabled) throw badRequest('Multi-factor authentication is already enabled. Disable it first to enrol a new authenticator.');
    const m = await getSettings(user.organization_id, 'mfa');
    const secret = authenticator.generateSecret(20);
    await pool.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1 AND mfa_enabled=false', [user.id, sealSecret(secret)]);
    const otpauthUrl = authenticator.keyuri(user.email, m.issuer, secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
  });

  app.post('/api/auth/mfa/setup/confirm', strict, async (req, reply) => {
    const body = parse(z.object({ code: z.string().min(6), challengeToken: z.string().optional() }), req.body);
    let user: any;
    if (body.challengeToken) {
      const t = await consumeToken(body.challengeToken, 'mfa_challenge', false);
      if (!t) throw new HttpError(401, 'challenge_expired', 'Your verification window expired. Please sign in again.');
      user = { ...t, id: t.user_id };
    } else {
      await requireAuth(req);
      user = await one('SELECT * FROM users WHERE id=$1', [req.principal!.userId]);
    }
    if (!user.mfa_secret_enc) throw badRequest('Start MFA setup first.');
    if (!authenticator.check(body.code.replace(/\s/g, ''), openSecret(user.mfa_secret_enc))) {
      throw new HttpError(401, 'invalid_code', 'The verification code is incorrect.');
    }
    const codes = await tx(async (db) => {
      await db.query('UPDATE users SET mfa_enabled=true WHERE id=$1', [user.id]);
      const c = await generateRecoveryCodes(db, user.id);
      await audit(db, userActor(user, req), {
        action: 'auth.mfa_enabled',
        objectType: 'user',
        objectId: user.id,
        objectLabel: user.email,
        before: { mfaEnabled: false },
        after: { mfaEnabled: true, recoveryCodesIssued: c.length }
      });
      return c;
    });
    let session = null;
    if (body.challengeToken) {
      await consumeToken(body.challengeToken, 'mfa_challenge', true);
      session = await startSession(req, reply, user, 'totp_enrolment');
    }
    return { recoveryCodes: codes, session };
  });

  app.post('/api/auth/mfa/recovery-codes', { preHandler: requireAuth }, async (req) => {
    const p = req.principal!;
    const codes = await tx(async (db) => {
      const c = await generateRecoveryCodes(db, p.userId);
      await audit(db, actorFromRequest(req), {
        action: 'auth.recovery_codes_regenerated',
        objectType: 'user',
        objectId: p.userId,
        objectLabel: p.email,
        after: { count: c.length }
      });
      return c;
    });
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/mfa/disable', { preHandler: requireAuth }, async (req) => {
    const body = parse(z.object({ password: z.string() }), req.body);
    const p = req.principal!;
    const u = await one('SELECT * FROM users WHERE id=$1', [p.userId]);
    if (!(await verifyPassword(u.password_hash, body.password))) throw unauthorized('Password is incorrect.');
    if (await mfaRequiredFor(u)) throw badRequest('MFA is enforced for your role and cannot be disabled.');
    await tx(async (db) => {
      await db.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL WHERE id=$1', [p.userId]);
      await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [p.userId]);
      await audit(db, actorFromRequest(req), {
        action: 'auth.mfa_disabled',
        objectType: 'user',
        objectId: p.userId,
        objectLabel: p.email,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false }
      });
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    try {
      await requireAuth(req);
    } catch {
      clearSessionCookie(reply);
      return { ok: true };
    }
    await revokeSession(req.principal!.sessionId);
    await tx((db) =>
      audit(db, actorFromRequest(req), {
        action: 'auth.logout',
        objectType: 'user',
        objectId: req.principal!.userId,
        objectLabel: req.principal!.email
      })
    );
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const p = req.principal!;
    const u = await one(
      `SELECT u.id, u.email, u.full_name, u.job_title, u.role, u.mfa_enabled, u.last_login_at, u.created_at,
              o.id AS org_id, o.name AS org_name, o.timezone AS org_timezone, o.setup_completed,
              (SELECT count(*) FROM recovery_codes rc WHERE rc.user_id=u.id AND rc.used_at IS NULL)::int AS recovery_codes_left
         FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1`,
      [p.userId]
    );
    const locations = p.locationIds
      ? (await pool.query('SELECT id, name, code FROM locations WHERE id = ANY($1::uuid[]) ORDER BY name', [p.locationIds])).rows
      : null;
    const session = await one('SELECT expires_at, last_seen_at FROM sessions WHERE id=$1', [p.sessionId]);
    const sec = await getSettings(p.organizationId, 'security');
    return {
      user: {
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        jobTitle: u.job_title,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role as Role],
        mfaEnabled: u.mfa_enabled,
        recoveryCodesLeft: u.recovery_codes_left,
        lastLoginAt: u.last_login_at
      },
      organization: { id: u.org_id, name: u.org_name, timezone: u.org_timezone, setupCompleted: u.setup_completed },
      permissions: ROLE_PERMISSIONS[p.role],
      locationScope: locations,
      session: { expiresAt: session?.expires_at, idleTimeoutMinutes: sec.sessionIdleMinutes },
      passwordPolicy: {
        passwordMinLength: sec.passwordMinLength,
        passwordRequireUpper: sec.passwordRequireUpper,
        passwordRequireLower: sec.passwordRequireLower,
        passwordRequireDigit: sec.passwordRequireDigit,
        passwordRequireSymbol: sec.passwordRequireSymbol
      },
      recoveryCodesTotal: RECOVERY_CODE_COUNT
    };
  });

  app.get('/api/auth/permissions-matrix', { preHandler: requireAuth }, async () => ({
    permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    roles: (Object.keys(ROLE_PERMISSIONS) as Role[]).map((r) => ({ role: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] }))
  }));

  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    const p = req.principal!;
    const u = await one('SELECT * FROM users WHERE id=$1', [p.userId]);
    if (!(await verifyPassword(u.password_hash, body.currentPassword))) throw unauthorized('Current password is incorrect.');
    const errs = passwordPolicyErrors(body.newPassword, await getSettings(p.organizationId, 'security'));
    if (errs.length) throw badRequest('Password does not meet the policy', errs);
    await tx(async (db) => {
      await db.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [p.userId, await hashPassword(body.newPassword)]);
      await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [p.userId, p.sessionId]);
      await audit(db, actorFromRequest(req), { action: 'auth.password_changed', objectType: 'user', objectId: p.userId, objectLabel: p.email });
    });
    return { ok: true };
  });

  // ───── Forgot / reset password ─────
  app.post('/api/auth/forgot-password', strict, async (req) => {
    const body = parse(z.object({ email: z.string().email() }), req.body);
    const u = await one(`SELECT * FROM users WHERE email=$1 AND status='active'`, [body.email]);
    if (u) {
      const token = randomToken(32);
      await tx(async (db) => {
        await db.query(
          `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2, now() + interval '1 hour')`,
          [u.id, hashToken(token)]
        );
        await audit(db, userActor(u, req), { action: 'auth.password_reset_requested', objectType: 'user', objectId: u.id, objectLabel: u.email });
      });
      const link = `${config.PUBLIC_URL}/reset-password?token=${token}`;
      await sendMail(u.email, 'Reset your BAMP password', `A password reset was requested for your account.\n\nReset link (valid 1 hour):\n${link}\n\nIf you did not request this, ignore this email.`);
    }
    // Always the same response so the endpoint cannot be used to enumerate accounts.
    return { ok: true };
  });

  app.get('/api/auth/reset-password/:token', async (req) => {
    const { token } = req.params as { token: string };
    const u = await consumeToken(token, 'password_reset', false);
    if (!u) throw new HttpError(410, 'token_invalid', 'This reset link is invalid or has expired.');
    return { email: u.email, policy: await getSettings(u.organization_id, 'security') };
  });

  app.post('/api/auth/reset-password', strict, async (req) => {
    const body = parse(z.object({ token: z.string(), password: z.string() }), req.body);
    const u = await consumeToken(body.token, 'password_reset', false);
    if (!u) throw new HttpError(410, 'token_invalid', 'This reset link is invalid or has expired.');
    const errs = passwordPolicyErrors(body.password, await getSettings(u.organization_id, 'security'));
    if (errs.length) throw badRequest('Password does not meet the policy', errs);
    await consumeToken(body.token, 'password_reset', true);
    await tx(async (db) => {
      await db.query(
        'UPDATE users SET password_hash=$2, password_changed_at=now(), failed_login_count=0, locked_until=NULL WHERE id=$1',
        [u.user_id, await hashPassword(body.password)]
      );
      await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [u.user_id]);
      await audit(db, userActor({ ...u, id: u.user_id }, req), {
        action: 'auth.password_reset',
        objectType: 'user',
        objectId: u.user_id,
        objectLabel: u.email
      });
    });
    return { ok: true };
  });

  // ───── First-time setup: verify invitation, set password ─────
  app.get('/api/auth/invite/:token', async (req) => {
    const { token } = req.params as { token: string };
    const u = await consumeToken(token, 'invite', false);
    if (!u) throw new HttpError(410, 'token_invalid', 'This invitation is invalid or has expired. Ask an administrator to resend it.');
    const org = await one('SELECT name FROM organizations WHERE id=$1', [u.organization_id]);
    return {
      email: u.email,
      fullName: u.full_name,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role as Role],
      organization: org?.name,
      policy: await getSettings(u.organization_id, 'security'),
      mfaRequired: await mfaRequiredFor(u)
    };
  });

  app.post('/api/auth/invite/accept', strict, async (req, reply) => {
    const body = parse(z.object({ token: z.string(), email: z.string().email(), password: z.string() }), req.body);
    const u = await consumeToken(body.token, 'invite', false);
    if (!u) throw new HttpError(410, 'token_invalid', 'This invitation is invalid or has expired.');
    if (u.email.toLowerCase() !== body.email.toLowerCase()) throw badRequest('The email address does not match this invitation.');
    const errs = passwordPolicyErrors(body.password, await getSettings(u.organization_id, 'security'));
    if (errs.length) throw badRequest('Password does not meet the policy', errs);
    await consumeToken(body.token, 'invite', true);
    await tx(async (db) => {
      await db.query(`UPDATE users SET password_hash=$2, password_changed_at=now(), status='active' WHERE id=$1`, [
        u.user_id,
        await hashPassword(body.password)
      ]);
      await audit(db, userActor({ ...u, id: u.user_id }, req), {
        action: 'auth.account_verified',
        objectType: 'user',
        objectId: u.user_id,
        objectLabel: u.email,
        before: { status: 'invited' },
        after: { status: 'active' }
      });
    });
    const user = { ...u, id: u.user_id };
    if (await mfaRequiredFor(user)) return { mfaSetupRequired: true, challengeToken: await issueChallenge(u.user_id) };
    return startSession(req, reply, user, 'invite');
  });
}

export { consumeToken };
