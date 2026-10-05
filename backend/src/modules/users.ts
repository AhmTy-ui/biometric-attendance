import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { type Db, many, one, pool, tx } from '../db/pool.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { pageParams, parse } from '../lib/validate.js';
import { hashPassword } from '../auth/passwords.js';
import { ROLE_LABELS, type Role } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { mailConfigured, sendMail } from '../services/mailer.js';
import { nudgeLocations } from '../services/roster.js';

const roleEnum = z.enum(['administrator', 'manager', 'branch_supervisor']);

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.job_title, u.role, u.status, u.mfa_required, u.mfa_enabled, u.failed_login_count, u.locked_until,
         u.last_login_at, host(u.last_login_ip) AS last_login_ip, u.created_at, u.updated_at, u.supervisor_employee_id,
         (u.supervisor_pin_hash IS NOT NULL) AS has_supervisor_pin,
         coalesce((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'code', l.code) ORDER BY l.name)
                     FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=u.id), '[]'::json) AS locations,
         (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
    FROM users u`;

async function issueInvite(db: Db, user: any) {
  const token = randomToken(32);
  await db.query(`UPDATE user_tokens SET used_at=now() WHERE user_id=$1 AND purpose='invite' AND used_at IS NULL`, [user.id]);
  await db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'invite',$2, now() + interval '7 days')`, [
    user.id,
    hashToken(token)
  ]);
  return `${config.PUBLIC_URL}/setup/account?token=${token}`;
}

async function assertAdminRemains(db: Db, orgId: string, excludingUserId: string) {
  const r = await db.query(`SELECT count(*)::int AS n FROM users WHERE organization_id=$1 AND role='administrator' AND status='active' AND id<>$2`, [
    orgId,
    excludingUserId
  ]);
  if (r.rows[0].n < 1) throw badRequest('At least one active administrator must remain.');
}

async function setLocations(db: Db, orgId: string, userId: string, role: Role, locationIds: string[]) {
  if (role === 'administrator') locationIds = [];
  if (role === 'branch_supervisor' && locationIds.length !== 1) throw badRequest('A Branch Supervisor must be assigned exactly one branch.');
  if (role === 'manager' && locationIds.length < 1) throw badRequest('A Manager must be assigned at least one location.');
  if (locationIds.length) {
    const ok = await db.query('SELECT count(*)::int AS n FROM locations WHERE organization_id=$1 AND id = ANY($2::uuid[])', [orgId, locationIds]);
    if (ok.rows[0].n !== new Set(locationIds).size) throw badRequest('One or more locations are invalid.');
  }
  await db.query('DELETE FROM user_locations WHERE user_id=$1', [userId]);
  for (const l of new Set(locationIds)) await db.query('INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2)', [userId, l]);
}

async function loadUser(req: FastifyRequest, id: string) {
  const u = await one(`${USER_SELECT} WHERE u.id=$1 AND u.organization_id=$2`, [id, req.principal!.organizationId]);
  if (!u) throw notFound('User');
  return u;
}

export async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', { preHandler: requirePerm('users.view') }, async (req) => {
    const p = req.principal!;
    const f = parse(z.object({ q: z.string().max(100).optional(), role: roleEnum.optional(), status: z.enum(['invited', 'active', 'disabled']).optional(), locationId: z.string().uuid().optional() }), req.query);
    const { limit, offset } = pageParams(req.query);
    const params: unknown[] = [p.organizationId];
    let where = ' WHERE u.organization_id=$1';
    if (f.role) {
      params.push(f.role);
      where += ` AND u.role=$${params.length}`;
    }
    if (f.status) {
      params.push(f.status);
      where += ` AND u.status=$${params.length}`;
    }
    if (f.locationId) {
      params.push(f.locationId);
      where += ` AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=$${params.length})`;
    }
    if (f.q) {
      params.push(`%${f.q.toLowerCase()}%`);
      where += ` AND (lower(u.full_name) LIKE $${params.length} OR lower(u.email) LIKE $${params.length})`;
    }
    const total = Number((await one(`SELECT count(*) FROM users u ${where}`, params))!.count);
    const summary = await one(
      `SELECT count(*) FILTER (WHERE role='administrator')::int AS administrators, count(*) FILTER (WHERE role='manager')::int AS managers,
              count(*) FILTER (WHERE role='branch_supervisor')::int AS supervisors, count(*) FILTER (WHERE status='invited')::int AS invited,
              count(*) FILTER (WHERE status='active' AND NOT mfa_enabled)::int AS without_mfa,
              count(*) FILTER (WHERE locked_until > now())::int AS locked
         FROM users WHERE organization_id=$1`,
      [p.organizationId]
    );
    params.push(limit, offset);
    const rows = await many(`${USER_SELECT} ${where} ORDER BY u.status='disabled', u.full_name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total, limit, offset, rows, summary, roleLabels: ROLE_LABELS };
  });

  app.get('/api/users/:id', { preHandler: requirePerm('users.view') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    const [sessions, activity, supervisorEmployee] = await Promise.all([
      many(`SELECT id, host(ip) AS ip, user_agent, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]),
      many(`SELECT seq, occurred_at, action, object_type, object_label, host(ip) AS ip FROM audit_log WHERE actor_type='user' AND actor_id=$1 ORDER BY seq DESC LIMIT 30`, [id]),
      u.supervisor_employee_id ? one('SELECT id, full_name, staff_number FROM employees WHERE id=$1', [u.supervisor_employee_id]) : null
    ]);
    return { user: u, sessions, activity, supervisorEmployee };
  });

  app.post('/api/users', { preHandler: requirePerm('users.manage') }, async (req) => {
    const p = req.principal!;
    const b = parse(
      z.object({
        email: z.string().email(),
        fullName: z.string().min(2).max(120),
        jobTitle: z.string().max(120).optional(),
        role: roleEnum,
        locationIds: z.array(z.string().uuid()).default([]),
        mfaRequired: z.boolean().default(false)
      }),
      req.body
    );
    const result = await tx(async (db) => {
      const dup = await db.query('SELECT 1 FROM users WHERE email=$1', [b.email]);
      if (dup.rowCount) throw conflict('A user with this email already exists.');
      const u = (
        await db.query(
          `INSERT INTO users (organization_id, email, full_name, job_title, role, status, mfa_required) VALUES ($1,$2,$3,$4,$5,'invited',$6) RETURNING *`,
          [p.organizationId, b.email, b.fullName, b.jobTitle ?? null, b.role, b.mfaRequired]
        )
      ).rows[0];
      await setLocations(db, p.organizationId, u.id, b.role, b.locationIds);
      const link = await issueInvite(db, u);
      await audit(db, actorFromRequest(req), {
        action: 'user.created',
        objectType: 'user',
        objectId: u.id,
        objectLabel: u.email,
        after: { email: u.email, fullName: u.full_name, role: u.role, locationIds: b.locationIds, mfaRequired: b.mfaRequired }
      });
      return { user: u, link };
    });
    const org = await one('SELECT name FROM organizations WHERE id=$1', [p.organizationId]);
    const mail = await sendMail(
      b.email,
      `You've been invited to ${org?.name ?? 'BAMP'}`,
      `${p.fullName} invited you to the Biometric Attendance Management Platform as ${ROLE_LABELS[b.role]}.\n\nVerify your account and set your password (link valid 7 days):\n${result.link}`
    );
    return { user: await loadUser(req, result.user.id), inviteLink: result.link, emailSent: mail.sent, smtpConfigured: mailConfigured() };
  });

  app.patch('/api/users/:id', { preHandler: requirePerm('users.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({
        fullName: z.string().min(2).max(120).optional(),
        jobTitle: z.string().max(120).nullable().optional(),
        role: roleEnum.optional(),
        locationIds: z.array(z.string().uuid()).optional(),
        mfaRequired: z.boolean().optional(),
        status: z.enum(['active', 'disabled']).optional()
      }),
      req.body
    );
    await tx(async (db) => {
      const before = (await db.query(`${USER_SELECT} WHERE u.id=$1 AND u.organization_id=$2`, [id, p.organizationId])).rows[0];
      if (!before) throw notFound('User');
      if (id === p.userId && ((b.role && b.role !== before.role) || b.status === 'disabled')) throw badRequest('You cannot change your own role or disable yourself.');
      if (before.role === 'administrator' && ((b.role && b.role !== 'administrator') || b.status === 'disabled')) await assertAdminRemains(db, p.organizationId, id);
      if (b.status === 'active' && before.status === 'invited') throw badRequest('Invited users become active by accepting their invitation.');
      if (b.status === 'active') {
        // A disabled account that never completed setup goes back to "invited" instead of becoming active without a password.
        const hasPw = (await db.query('SELECT password_hash IS NOT NULL AS has FROM users WHERE id=$1', [id])).rows[0].has;
        if (!hasPw) b.status = 'invited' as any;
      }
      await db.query(
        `UPDATE users SET full_name=COALESCE($2,full_name), job_title=CASE WHEN $3::boolean THEN $4 ELSE job_title END, role=COALESCE($5,role),
                mfa_required=COALESCE($6,mfa_required), status=COALESCE($7,status), updated_at=now() WHERE id=$1`,
        [id, b.fullName ?? null, b.jobTitle !== undefined, b.jobTitle ?? null, b.role ?? null, b.mfaRequired ?? null, b.status ?? null]
      );
      const role = (b.role ?? before.role) as Role;
      if (b.locationIds || b.role) await setLocations(db, p.organizationId, id, role, b.locationIds ?? before.locations.map((l: any) => l.id));
      if (b.status === 'disabled' || (b.role && b.role !== before.role)) {
        await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      }
      const after = (await db.query(`${USER_SELECT} WHERE u.id=$1`, [id])).rows[0];
      await audit(db, actorFromRequest(req), {
        action: 'user.updated',
        objectType: 'user',
        objectId: id,
        objectLabel: before.email,
        before: { fullName: before.full_name, jobTitle: before.job_title, role: before.role, status: before.status, mfaRequired: before.mfa_required, locations: before.locations },
        after: { fullName: after.full_name, jobTitle: after.job_title, role: after.role, status: after.status, mfaRequired: after.mfa_required, locations: after.locations }
      });
    });
    return loadUser(req, id);
  });

  app.post('/api/users/:id/resend-invite', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    if (u.status !== 'invited') throw badRequest('User has already accepted the invitation.');
    const link = await tx(async (db) => {
      const l = await issueInvite(db, u);
      await audit(db, actorFromRequest(req), { action: 'user.invite_resent', objectType: 'user', objectId: id, objectLabel: u.email });
      return l;
    });
    const mail = await sendMail(u.email, 'Your BAMP invitation', `Verify your account and set your password (link valid 7 days):\n${link}`);
    return { inviteLink: link, emailSent: mail.sent };
  });

  app.post('/api/users/:id/password-reset-link', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    if (u.status !== 'active') throw badRequest('Only active users can reset their password.');
    const token = randomToken(32);
    await tx(async (db) => {
      await db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2, now() + interval '1 hour')`, [id, hashToken(token)]);
      await audit(db, actorFromRequest(req), { action: 'user.password_reset_issued', objectType: 'user', objectId: id, objectLabel: u.email });
    });
    const link = `${config.PUBLIC_URL}/reset-password?token=${token}`;
    const mail = await sendMail(u.email, 'Reset your BAMP password', `An administrator issued a password reset for your account (valid 1 hour):\n${link}`);
    return { resetLink: link, emailSent: mail.sent };
  });

  app.post('/api/users/:id/unlock', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    await tx(async (db) => {
      await db.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1', [id]);
      await audit(db, actorFromRequest(req), {
        action: 'user.unlocked',
        objectType: 'user',
        objectId: id,
        objectLabel: u.email,
        before: { lockedUntil: u.locked_until, failedLogins: u.failed_login_count },
        after: { lockedUntil: null, failedLogins: 0 }
      });
    });
    return { ok: true };
  });

  app.post('/api/users/:id/reset-mfa', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    await tx(async (db) => {
      await db.query('UPDATE users SET mfa_enabled=false, mfa_secret_enc=NULL WHERE id=$1', [id]);
      await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [id]);
      await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await audit(db, actorFromRequest(req), {
        action: 'user.mfa_reset',
        objectType: 'user',
        objectId: id,
        objectLabel: u.email,
        before: { mfaEnabled: u.mfa_enabled },
        after: { mfaEnabled: false }
      });
    });
    return { ok: true };
  });

  app.post('/api/users/:id/revoke-sessions', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    const n = await tx(async (db) => {
      const r = await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await audit(db, actorFromRequest(req), { action: 'user.sessions_revoked', objectType: 'user', objectId: id, objectLabel: u.email, after: { revoked: r.rowCount } });
      return r.rowCount ?? 0;
    });
    return { revoked: n };
  });

  /** On-device supervisor authorisation credentials (FR-2.1): a PIN and/or a linked employee fingerprint. */
  app.put('/api/users/:id/supervisor-credentials', { preHandler: requirePerm('users.manage') }, async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    const u = await loadUser(req, id);
    const b = parse(
      z.object({
        pin: z.string().regex(/^\d{6,8}$/, 'PIN must be 6–8 digits').nullable().optional(),
        employeeId: z.string().uuid().nullable().optional()
      }),
      req.body
    );
    if (b.employeeId) {
      const e = await one('SELECT id FROM employees WHERE id=$1 AND organization_id=$2', [b.employeeId, p.organizationId]);
      if (!e) throw notFound('Employee');
    }
    await tx(async (db) => {
      if (b.pin !== undefined) await db.query('UPDATE users SET supervisor_pin_hash=$2 WHERE id=$1', [id, b.pin ? await hashPassword(b.pin) : null]);
      if (b.employeeId !== undefined) await db.query('UPDATE users SET supervisor_employee_id=$2 WHERE id=$1', [id, b.employeeId]);
      await audit(db, actorFromRequest(req), {
        action: 'user.supervisor_credentials_updated',
        objectType: 'user',
        objectId: id,
        objectLabel: u.email,
        before: { hasPin: u.has_supervisor_pin, employeeId: u.supervisor_employee_id },
        after: { hasPin: b.pin === undefined ? u.has_supervisor_pin : Boolean(b.pin), employeeId: b.employeeId === undefined ? u.supervisor_employee_id : b.employeeId }
      });
    });
    // Devices hold the supervisor list locally (returned in full with every roster pull); nudge them to refresh.
    const locs =
      u.role === 'administrator'
        ? (await pool.query('SELECT id FROM locations WHERE organization_id=$1', [p.organizationId])).rows.map((r) => r.id)
        : u.locations.map((l: any) => l.id);
    await nudgeLocations(p.organizationId, locs);
    return loadUser(req, id);
  });
}
