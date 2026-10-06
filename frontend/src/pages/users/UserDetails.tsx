import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  KV,
  LinkButton,
  Loading,
  Modal,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  Table,
  Td,
  Th,
  THead,
  Toggle,
  Tr,
  useDebounced,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth, type Role } from '@/lib/auth';
import { dateTime, humanize, num, relative } from '@/lib/format';
import { isLocked, LinkResult, LocationPicker, locationRuleError, LocationScopeCell, MfaCell, RoleBadge, ROLE_META, ROLES, useMfaPolicy, UserStatusBadge } from './components';

type ConfirmKind = 'unlock' | 'reset-mfa' | 'revoke-sessions' | 'disable' | 'enable' | null;

export default function UserDetails() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const policy = useMfaPolicy();
  const manage = can('users.manage');
  const isSelf = me?.user.id === id;

  const q = useQuery<any>({ queryKey: ['user', id], queryFn: () => api.get(`/api/users/${id}`), enabled: Boolean(id) });
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [linkResult, setLinkResult] = useState<{ title: string; link: string; emailSent: boolean; validity: string } | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['user', id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };

  const action = useMutation({
    mutationFn: async (kind: Exclude<ConfirmKind, null> | 'resend-invite' | 'password-reset-link') => {
      if (kind === 'disable' || kind === 'enable') return { kind, r: await api.patch(`/api/users/${id}`, { status: kind === 'disable' ? 'disabled' : 'active' }) };
      return { kind, r: await api.post(`/api/users/${id}/${kind}`) };
    },
    onSuccess: ({ kind, r }) => {
      setConfirm(null);
      refresh();
      if (kind === 'resend-invite') setLinkResult({ title: 'Invitation link', link: r.inviteLink, emailSent: Boolean(r.emailSent), validity: 'Valid for 7 days' });
      else if (kind === 'password-reset-link') setLinkResult({ title: 'Password reset link', link: r.resetLink, emailSent: Boolean(r.emailSent), validity: 'Valid for 1 hour' });
      const msg: Record<string, string> = {
        unlock: 'Account unlocked.',
        'reset-mfa': 'MFA reset. The user must enrol a new authenticator at next sign-in; their sessions were ended.',
        'revoke-sessions': `${num(r?.revoked ?? 0)} session(s) revoked.`,
        disable: 'User disabled and signed out everywhere.',
        enable: 'User enabled.',
        'resend-invite': 'Invitation reissued. The previous link no longer works.',
        'password-reset-link': 'Password reset link issued.'
      };
      toast({ tone: 'success', title: msg[kind] ?? 'Done' });
    },
    onError: (e) => {
      setConfirm(null);
      errorToast(e);
    }
  });

  if (q.isLoading) return <Loading label="Loading user…" />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const { user: u, sessions, activity, supervisorEmployee } = q.data as { user: any; sessions: any[]; activity: any[]; supervisorEmployee: any };
  const locked = isLocked(u);
  const enforced = policy.enforced(u.role as Role);
  const activeSessions = sessions.filter((s) => !s.revoked_at && new Date(s.expires_at).getTime() > Date.now());

  const confirmCopy: Record<Exclude<ConfirmKind, null>, { title: string; message: ReactNode; label: string; danger?: boolean }> = {
    unlock: { title: 'Unlock account', message: `Clear the failed sign-in counter and lift the lock on ${u.email}?`, label: 'Unlock' },
    'reset-mfa': {
      title: 'Reset MFA',
      message: `This removes ${u.full_name}'s authenticator and recovery codes and signs them out everywhere. They will have to enrol a new authenticator${u.mfa_required || enforced ? ' at their next sign-in' : ' if MFA is required'}.`,
      label: 'Reset MFA',
      danger: true
    },
    'revoke-sessions': { title: 'Revoke sessions', message: `Sign ${u.full_name} out of all ${activeSessions.length} active session(s)?`, label: 'Revoke all', danger: true },
    disable: {
      title: 'Disable user',
      message: `${u.full_name} will be signed out everywhere and will not be able to sign in until re-enabled. Their audit history is preserved.`,
      label: 'Disable user',
      danger: true
    },
    enable: { title: 'Enable user', message: `Allow ${u.full_name} to sign in again?`, label: 'Enable user' }
  };

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        crumbs={[{ label: 'Users', to: '/users' }, { label: u.full_name }]}
        title={
          <span className="flex items-center gap-space-sm">
            <Avatar name={u.full_name} tone={ROLE_META[u.role as Role]?.tone ?? 'neutral'} size={10} />
            <span className="truncate">{u.full_name}</span>
            {isSelf && <Badge tone="primary">You</Badge>}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{u.email}</span>
            {u.job_title && <span>· {u.job_title}</span>}
          </span>
        }
        actions={
          <>
            {can('audit.view') && (
              <LinkButton to={`/audit?objectType=user&objectId=${u.id}`} icon="receipt_long">
                Changes to this user
              </LinkButton>
            )}
            {manage && (
              <Button variant="primary" icon="edit" onClick={() => setEditOpen(true)}>
                Edit user
              </Button>
            )}
          </>
        }
      />

      {/* Status banner */}
      {(locked || u.status !== 'active') && (
        <div
          className={clsx(
            'rounded-lg p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm',
            locked ? 'bg-error-container/40' : u.status === 'invited' ? 'bg-secondary-container/15' : 'bg-surface-container'
          )}
        >
          <div className="flex items-start gap-space-sm">
            <Icon name={locked ? 'lock' : u.status === 'invited' ? 'mail' : 'block'} className={clsx('text-[22px]', locked ? 'text-error' : u.status === 'invited' ? 'text-secondary' : 'text-outline')} />
            <div className="text-body-sm">
              <div className="font-semibold text-on-surface">
                {locked ? `Account locked until ${dateTime(u.locked_until)}` : u.status === 'invited' ? 'Invitation pending' : 'User disabled'}
              </div>
              <div className="text-on-surface-variant">
                {locked
                  ? `${u.failed_login_count} consecutive failed sign-in attempts.`
                  : u.status === 'invited'
                    ? 'The user has not yet verified their account and set a password.'
                    : 'This user cannot sign in. Their audit history is preserved.'}
              </div>
            </div>
          </div>
          {manage && <span className="font-label-sm text-label-sm text-outline shrink-0">Actions are under Security actions below.</span>}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-space-md">
        {/* Left column */}
        <div className="flex flex-col gap-space-md">
          <Panel title="Account" icon="person">
            <KV label="Status">
              <UserStatusBadge status={u.status} />
            </KV>
            <KV label="Role">
              <RoleBadge role={u.role} />
            </KV>
            <KV label="Email" mono>
              {u.email}
            </KV>
            <KV label="Job title">{u.job_title ?? '—'}</KV>
            <KV label="Created">{dateTime(u.created_at)}</KV>
            <KV label="Updated">{dateTime(u.updated_at)}</KV>
          </Panel>

          <Panel title="Location scope" icon="storefront" subtitle={ROLE_META[u.role as Role]?.scope}>
            {u.role === 'administrator' ? (
              <LocationScopeCell user={u} />
            ) : (u.locations ?? []).length === 0 ? (
              <div className="flex items-center gap-2 text-body-sm text-error">
                <Icon name="warning" className="text-[18px]" />
                No location assigned — this user cannot see any location data.
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {u.locations.map((l: any) => (
                  <li key={l.id}>
                    <Link to={`/locations/${l.id}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-surface-container hover:bg-surface-container-high">
                      <span className="text-body-sm text-on-surface truncate">{l.name}</span>
                      <span className="font-mono text-[11px] text-outline">{l.code}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-space-sm font-body-sm text-body-sm text-outline">Scope is enforced server-side on every request.</p>
          </Panel>

          <Panel title="Sign-in security" icon="shield_lock">
            <KV label="MFA">
              <span className="inline-flex justify-end">
                <MfaCell user={u} />
              </span>
            </KV>
            <KV label="MFA required">{u.mfa_required ? 'Yes (per user)' : enforced ? 'Yes (organisation policy)' : enforced === false ? 'No' : 'Per user: no'}</KV>
            <KV label="Last login">{u.last_login_at ? `${dateTime(u.last_login_at)} (${relative(u.last_login_at)})` : 'Never'}</KV>
            <KV label="Last login IP" mono>
              {u.last_login_ip ?? '—'}
            </KV>
            <KV label="Failed sign-ins">
              <span className={u.failed_login_count > 0 ? 'text-warning' : undefined}>{num(u.failed_login_count)}</span>
            </KV>
            <KV label="Locked">{locked ? <span className="text-error">Until {dateTime(u.locked_until)}</span> : 'No'}</KV>
            <KV label="Active sessions">{num(u.active_sessions)}</KV>
          </Panel>

          {manage && (
            <Panel title="Account actions" icon="build">
              <div className="flex flex-col gap-space-xs">
                {u.status === 'invited' && (
                  <ActionRow icon="forward_to_inbox" title="Resend invitation" text="Issues a new 7-day link and invalidates the previous one.">
                    <Button size="sm" loading={action.isPending && action.variables === 'resend-invite'} onClick={() => action.mutate('resend-invite')}>
                      Resend
                    </Button>
                  </ActionRow>
                )}
                {u.status === 'active' && (
                  <ActionRow icon="password" title="Password reset link" text="Issues a one-hour link the user can use to choose a new password.">
                    <Button size="sm" loading={action.isPending && action.variables === 'password-reset-link'} onClick={() => action.mutate('password-reset-link')}>
                      Issue link
                    </Button>
                  </ActionRow>
                )}
                {(locked || u.failed_login_count > 0) && (
                  <ActionRow icon="lock_open" title="Unlock account" text="Clears the lock and the failed sign-in counter.">
                    <Button size="sm" onClick={() => setConfirm('unlock')}>
                      Unlock
                    </Button>
                  </ActionRow>
                )}
                {u.mfa_enabled && (
                  <ActionRow icon="phonelink_erase" title="Reset MFA" text="For a lost device. Removes the authenticator and signs the user out.">
                    <Button size="sm" variant="danger" onClick={() => setConfirm('reset-mfa')}>
                      Reset
                    </Button>
                  </ActionRow>
                )}
                <ActionRow icon="logout" title="Revoke sessions" text={activeSessions.length ? `${activeSessions.length} active session(s).` : 'No active sessions.'}>
                  <Button size="sm" variant="danger" disabled={activeSessions.length === 0} onClick={() => setConfirm('revoke-sessions')}>
                    Revoke all
                  </Button>
                </ActionRow>
                {!isSelf && u.status !== 'disabled' && (
                  <ActionRow icon="block" title="Disable user" text="Blocks sign-in and ends all sessions.">
                    <Button size="sm" variant="danger" onClick={() => setConfirm('disable')}>
                      Disable
                    </Button>
                  </ActionRow>
                )}
                {!isSelf && u.status === 'disabled' && (
                  <ActionRow icon="check_circle" title="Enable user" text="Allows the user to sign in again.">
                    <Button size="sm" onClick={() => setConfirm('enable')}>
                      Enable
                    </Button>
                  </ActionRow>
                )}
              </div>
              <p className="mt-space-sm font-body-sm text-body-sm text-outline flex items-center gap-1">
                <Icon name="receipt_long" className="text-[14px]" />
                Every action is recorded in the audit log.
              </p>
            </Panel>
          )}
        </div>

        {/* Right column */}
        <div className="xl:col-span-2 flex flex-col gap-space-md">
          <SupervisorCredentials user={u} employee={supervisorEmployee} manage={manage} onSaved={refresh} />

          <Panel title="Sessions" icon="devices" subtitle="Most recent 20 sign-in sessions" bodyClassName="px-0">
            {sessions.length === 0 ? (
              <Empty icon="devices" title="No sessions yet." description="The user has not signed in." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Started</Th>
                    <Th>Last seen</Th>
                    <Th>IP</Th>
                    <Th>Browser / user agent</Th>
                    <Th>State</Th>
                  </tr>
                </THead>
                <tbody className="text-on-surface">
                  {sessions.map((s) => {
                    const expired = new Date(s.expires_at).getTime() <= Date.now();
                    return (
                      <Tr key={s.id}>
                        <Td className="whitespace-nowrap font-mono text-[11px]">{dateTime(s.created_at)}</Td>
                        <Td className="whitespace-nowrap text-on-surface-variant">{relative(s.last_seen_at)}</Td>
                        <Td className="font-mono text-[11px]">{s.ip ?? '—'}</Td>
                        <Td>
                          <span className="block max-w-[280px] truncate text-on-surface-variant" title={s.user_agent ?? ''}>
                            {s.user_agent ?? '—'}
                          </span>
                        </Td>
                        <Td>
                          {s.revoked_at ? (
                            <Badge tone="neutral" icon="logout">
                              Revoked {relative(s.revoked_at)}
                            </Badge>
                          ) : expired ? (
                            <Badge tone="neutral">Expired</Badge>
                          ) : (
                            <Badge tone="success" icon="radio_button_checked">
                              Active · expires {relative(s.expires_at)}
                            </Badge>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel
            title="Recent activity"
            icon="history"
            subtitle="Last 30 audit events performed by this user"
            bodyClassName="px-0"
            actions={can('audit.view') ? <LinkButton size="sm" to={`/audit?actorType=user&actorId=${u.id}`} icon="open_in_new">Open in audit log</LinkButton> : undefined}
          >
            {activity.length === 0 ? (
              <Empty icon="history" title="No activity recorded." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Seq</Th>
                    <Th>When</Th>
                    <Th>Action</Th>
                    <Th>Object</Th>
                    <Th>IP</Th>
                  </tr>
                </THead>
                <tbody className="text-on-surface">
                  {activity.map((a) => (
                    <Tr key={a.seq}>
                      <Td className="font-mono text-[11px]">
                        {can('audit.view') ? (
                          <Link to={`/audit/${a.seq}`} className="text-primary hover:underline">
                            #{a.seq}
                          </Link>
                        ) : (
                          `#${a.seq}`
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <div className="font-mono text-[11px]">{dateTime(a.occurred_at)}</div>
                        <div className="font-label-sm text-label-sm text-outline">{relative(a.occurred_at)}</div>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-container-highest">{a.action}</span>
                      </Td>
                      <Td className="text-on-surface-variant">
                        <span className="text-outline">{humanize(a.object_type)}</span>
                        {a.object_label ? ` · ${a.object_label}` : ''}
                      </Td>
                      <Td className="font-mono text-[11px] text-outline">{a.ip ?? '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>
      </div>

      {editOpen && <EditUserModal user={u} isSelf={isSelf} onClose={() => setEditOpen(false)} onSaved={refresh} />}

      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => action.mutate(confirm)}
          title={confirmCopy[confirm].title}
          message={confirmCopy[confirm].message}
          confirmLabel={confirmCopy[confirm].label}
          danger={confirmCopy[confirm].danger}
          loading={action.isPending}
        />
      )}

      <Modal
        open={Boolean(linkResult)}
        onClose={() => setLinkResult(null)}
        title={linkResult?.title ?? ''}
        icon="link"
        footer={
          <Button variant="primary" onClick={() => setLinkResult(null)}>
            Done
          </Button>
        }
      >
        {linkResult && <LinkResult title={linkResult.title} link={linkResult.link} emailSent={linkResult.emailSent} smtpConfigured={policy.smtpConfigured} validity={linkResult.validity} />}
      </Modal>
    </div>
  );
}

function ActionRow({ icon, title, text, children }: { icon: string; title: string; text: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-space-sm p-space-sm rounded bg-surface-container">
      <div className="flex items-start gap-2 min-w-0">
        <Icon name={icon} className="text-[18px] text-outline" />
        <div className="min-w-0">
          <div className="text-body-sm text-on-surface font-medium">{title}</div>
          <div className="font-body-sm text-[11px] text-outline">{text}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

// ───────────────────────── Edit ─────────────────────────
function EditUserModal({ user, isSelf, onClose, onSaved }: { user: any; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const policy = useMfaPolicy();
  const [fullName, setFullName] = useState<string>(user.full_name);
  const [jobTitle, setJobTitle] = useState<string>(user.job_title ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [locationIds, setLocationIds] = useState<string[]>((user.locations ?? []).map((l: any) => l.id));
  const [mfaRequired, setMfaRequired] = useState<boolean>(Boolean(user.mfa_required));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const nameErr = fullName.trim().length < 2 ? 'Full name must be at least 2 characters.' : errors.fullName ?? null;
  const locErr = locationRuleError(role, locationIds);
  const roleChanged = role !== user.role;
  const enforced = policy.enforced(role);

  const changeRole = (r: Role) => {
    setRole(r);
    if (r === 'administrator') setLocationIds([]);
    else if (r === 'branch_supervisor') setLocationIds((ids) => ids.slice(0, 1));
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/users/${user.id}`, {
        fullName: fullName.trim(),
        jobTitle: jobTitle.trim() || null,
        ...(isSelf ? {} : { role }),
        locationIds: role === 'administrator' ? [] : locationIds,
        mfaRequired
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'User updated', description: roleChanged ? 'Role changed — the user was signed out of all sessions.' : undefined });
      onSaved();
      onClose();
    },
    onError: (e) => {
      const err = e as ApiError;
      const map: Record<string, string> = {};
      if (Array.isArray(err.details)) for (const d of err.details) if (d?.path) map[String(d.path)] = d.message;
      setErrors(map);
      errorToast(e, 'Could not update user');
    }
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.full_name}`}
      icon="edit"
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="save" loading={save.isPending} disabled={Boolean(nameErr) || Boolean(locErr)} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-space-md">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <Field label="Full name" required error={nameErr}>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Job title" error={errors.jobTitle}>
            <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Email" hint="Email is the sign-in identity and cannot be changed.">
            <Input value={user.email} disabled />
          </Field>
          <Field label="Role" hint={isSelf ? 'You cannot change your own role.' : roleChanged ? 'Changing the role signs the user out of all sessions.' : ROLE_META[role].description}>
            <Select value={role} disabled={isSelf} onChange={(e) => changeRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_META[r].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <div className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide mb-1">Assigned locations</div>
          <LocationPicker role={role} value={locationIds} onChange={setLocationIds} />
          {locErr && <p className="mt-1 text-body-sm text-error">{locErr}</p>}
        </div>
        <div className="p-space-sm rounded bg-surface-container flex flex-col gap-1">
          <Toggle checked={mfaRequired} onChange={setMfaRequired} label="Require MFA for this user" />
          {enforced && <p className="font-body-sm text-body-sm text-tertiary">MFA is enforced for {ROLE_META[role].label}s by organisation policy regardless of this setting.</p>}
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── Supervisor on-device credentials (FR-2.1) ─────────────────────────
function SupervisorCredentials({ user, employee, manage, onSaved }: { user: any; employee: any; manage: boolean; onSaved: () => void }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const { can } = useAuth();
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [empOpen, setEmpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search, 300);
  const [clearWhat, setClearWhat] = useState<'pin' | 'employee' | null>(null);

  const save = useMutation({
    mutationFn: (body: { pin?: string | null; employeeId?: string | null }) => api.put(`/api/users/${user.id}/supervisor-credentials`, body),
    onSuccess: (_r, body) => {
      toast({
        tone: 'success',
        title: 'Supervisor credentials updated',
        description: 'Devices at the user’s locations were asked to refresh their roster.'
      });
      if (body.pin !== undefined) {
        setPinOpen(false);
        setPin('');
        setPin2('');
      }
      if (body.employeeId !== undefined) setEmpOpen(false);
      setClearWhat(null);
      onSaved();
    },
    onError: (e) => {
      setClearWhat(null);
      errorToast(e, 'Could not update supervisor credentials');
    }
  });

  const employees = useQuery<any>({
    queryKey: ['employees', { q: dsearch, limit: 10, purpose: 'supervisor-link' }],
    queryFn: () => api.get('/api/employees', { q: dsearch, limit: 10 }),
    enabled: empOpen && can('employees.view')
  });

  const pinErr = pin && !/^\d{6,8}$/.test(pin) ? 'PIN must be 6–8 digits.' : pin2 && pin !== pin2 ? 'PINs do not match.' : null;
  const scopeText = user.role === 'administrator' ? 'all locations' : (user.locations ?? []).map((l: any) => l.name).join(', ') || 'no locations (not pushed to any device)';

  return (
    <Panel title="On-device supervisor credentials" icon="fingerprint" subtitle="FR-2.1 · authorise fingerprint enrolment at the terminal">
      <p className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm">
        Enrolment on a terminal must be authorised by a supervisor, either with a PIN or with the fingerprint of a linked employee record. Credentials are hashed and delivered to devices at{' '}
        <span className="text-on-surface">{scopeText}</span> with the next roster pull.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
        <div className="p-space-sm rounded bg-surface-container flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Supervisor PIN</span>
            <Icon name="pin" className={clsx('text-[18px]', user.has_supervisor_pin ? 'text-tertiary' : 'text-outline')} />
          </div>
          <div className={clsx('font-headline-sm text-headline-sm', user.has_supervisor_pin ? 'text-tertiary' : 'text-outline')}>{user.has_supervisor_pin ? 'PIN set' : 'No PIN'}</div>
          {manage && (
            <div className="flex gap-space-xs">
              <Button size="sm" icon="password" onClick={() => setPinOpen(true)}>
                {user.has_supervisor_pin ? 'Change PIN' : 'Set PIN'}
              </Button>
              {user.has_supervisor_pin && (
                <Button size="sm" variant="ghost" icon="backspace" onClick={() => setClearWhat('pin')}>
                  Clear
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="p-space-sm rounded bg-surface-container flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Linked employee fingerprint</span>
            <Icon name="fingerprint" className={clsx('text-[18px]', employee ? 'text-tertiary' : 'text-outline')} />
          </div>
          {employee ? (
            <Link to={`/employees/${employee.id}`} className="font-headline-sm text-headline-sm text-on-surface hover:text-primary truncate">
              {employee.full_name} <span className="font-mono text-[11px] text-outline">{employee.staff_number}</span>
            </Link>
          ) : user.supervisor_employee_id ? (
            <div className="font-headline-sm text-headline-sm text-warning">Linked employee not found</div>
          ) : (
            <div className="font-headline-sm text-headline-sm text-outline">Not linked</div>
          )}
          {manage && (
            <div className="flex gap-space-xs">
              <Button size="sm" icon="link" onClick={() => setEmpOpen(true)} disabled={!can('employees.view')}>
                {employee ? 'Change' : 'Link employee'}
              </Button>
              {user.supervisor_employee_id && (
                <Button size="sm" variant="ghost" icon="link_off" onClick={() => setClearWhat('employee')}>
                  Unlink
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        title={user.has_supervisor_pin ? 'Change supervisor PIN' : 'Set supervisor PIN'}
        icon="pin"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPinOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="save" loading={save.isPending} disabled={!pin || !pin2 || Boolean(pinErr)} onClick={() => save.mutate({ pin })}>
              Save PIN
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-space-md">
          <p className="text-body-sm text-on-surface-variant">Choose a 6–8 digit PIN. Only a hash is stored; the PIN cannot be displayed again.</p>
          <Field label="New PIN" error={pin && !/^\d{6,8}$/.test(pin) ? 'PIN must be 6–8 digits.' : null}>
            <Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Confirm PIN" error={pin2 && pin !== pin2 ? 'PINs do not match.' : null}>
            <Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      </Modal>

      <Modal open={empOpen} onClose={() => setEmpOpen(false)} title="Link employee fingerprint" icon="fingerprint" width="max-w-2xl">
        <div className="flex flex-col gap-space-sm">
          <p className="text-body-sm text-on-surface-variant">
            Select the employee record belonging to {user.full_name}. Their enrolled fingerprint will then authorise enrolment sessions on the terminal.
          </p>
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name, staff number or web reference…" />
          {employees.isLoading ? (
            <Loading label="Searching employees…" />
          ) : employees.error ? (
            <ErrorState error={employees.error} onRetry={() => employees.refetch()} compact />
          ) : (employees.data?.rows ?? []).length === 0 ? (
            <Empty icon="person_search" title="No employees found." description="Employees come from the web software. Try a different search." />
          ) : (
            <ul className="flex flex-col gap-1 max-h-80 overflow-y-auto">
              {(employees.data?.rows ?? []).map((e: any) => (
                <li key={e.id}>
                  <button
                    type="button"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ employeeId: e.id })}
                    className={clsx('w-full flex items-center justify-between gap-2 p-space-sm rounded text-left bg-surface-container hover:bg-surface-container-high', e.id === user.supervisor_employee_id && 'ring-1 ring-primary-container')}
                  >
                    <div className="min-w-0">
                      <div className="text-body-sm text-on-surface font-medium truncate">{e.full_name}</div>
                      <div className="font-label-sm text-label-sm text-outline truncate">
                        {e.staff_number} · {e.location_name ?? 'Unassigned'} · {humanize(e.employment_status)}
                      </div>
                    </div>
                    {e.fingers_enrolled > 0 ? (
                      <Badge tone="success" icon="fingerprint">
                        {e.fingers_enrolled} finger{e.fingers_enrolled === 1 ? '' : 's'}
                      </Badge>
                    ) : (
                      <Badge tone="warning" icon="warning">
                        Not enrolled
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="font-body-sm text-body-sm text-outline">An employee without enrolled fingerprints can be linked, but cannot authorise until their fingerprint is enrolled.</p>
        </div>
      </Modal>

      <ConfirmDialog
        open={clearWhat !== null}
        onClose={() => setClearWhat(null)}
        onConfirm={() => save.mutate(clearWhat === 'pin' ? { pin: null } : { employeeId: null })}
        title={clearWhat === 'pin' ? 'Clear supervisor PIN' : 'Unlink employee fingerprint'}
        message={
          clearWhat === 'pin'
            ? `${user.full_name} will no longer be able to authorise enrolment with a PIN.`
            : `${user.full_name} will no longer be able to authorise enrolment with their fingerprint.`
        }
        confirmLabel={clearWhat === 'pin' ? 'Clear PIN' : 'Unlink'}
        danger
        loading={save.isPending}
      />
    </Panel>
  );
}
