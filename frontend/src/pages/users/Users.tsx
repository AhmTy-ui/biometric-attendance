import clsx from 'clsx';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Button,
  Empty,
  ErrorState,
  Icon,
  LinkButton,
  Loading,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useDebounced
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, type Role } from '@/lib/auth';
import { dateTime, num, relative, time } from '@/lib/format';
import { isLocked, LocationScopeCell, MfaCell, RoleBadge, ROLE_META, ROLES, useAllLocations, useMfaPolicy, UserStatusBadge } from './components';

const LIMIT = 25;

export default function Users() {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const role = sp.get('role') ?? '';
  const status = sp.get('status') ?? '';
  const locationId = sp.get('locationId') ?? '';
  const offset = Number(sp.get('offset') ?? 0) || 0;

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'offset') n.delete('offset');
    setSp(n, { replace: true });
  };

  useEffect(() => {
    if ((sp.get('q') ?? '') !== dq) setParam('q', dq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const filters = { q: dq, role, status, locationId, limit: LIMIT, offset };
  const list = useQuery<any>({ queryKey: ['users', filters], queryFn: () => api.get('/api/users', filters), placeholderData: keepPreviousData });
  const locations = useAllLocations();
  const policy = useMfaPolicy();
  const summary = list.data?.summary;
  const roleLabels: Record<string, string> = list.data?.roleLabels ?? {};
  const roleCount = (r: Role) => (r === 'administrator' ? summary?.administrators : r === 'manager' ? summary?.managers : summary?.supervisors);
  const totalUsers = summary ? Number(summary.administrators) + Number(summary.managers) + Number(summary.supervisors) : null;
  const security = policy.settings?.security;
  const mfa = policy.settings?.mfa;
  const filtered = Boolean(dq || role || status || locationId);

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        title="Users & Roles"
        icon="group"
        subtitle="Dashboard accounts, their role and the locations they are allowed to see. Location scoping is enforced server-side on every request."
        actions={
          <>
            <LinkButton to="/users/roles" icon="shield_person">
              Roles & Permissions
            </LinkButton>
            {can('users.manage') && (
              <LinkButton to="/users/new" variant="primary" icon="person_add">
                Add User
              </LinkButton>
            )}
          </>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md">
        <Kpi label="Users" icon="badge" value={totalUsers === null ? '—' : num(totalUsers)} hint={summary ? `${num(summary.invited)} invitation${summary.invited === 1 ? '' : 's'} pending` : undefined} onClick={() => setParam('status', '')} />
        <Kpi
          label="Pending invitations"
          icon="mail"
          tone={summary?.invited > 0 ? 'info' : undefined}
          value={summary ? num(summary.invited) : '—'}
          hint="Accounts not yet verified"
          onClick={() => setParam('status', status === 'invited' ? '' : 'invited')}
          active={status === 'invited'}
        />
        <Kpi
          label="Active without MFA"
          icon="security"
          tone={summary?.without_mfa > 0 ? 'warning' : 'success'}
          value={summary ? num(summary.without_mfa) : '—'}
          hint={summary?.without_mfa > 0 ? 'Active users who have not enrolled an authenticator' : 'Every active user has MFA enabled'}
        />
        <Kpi
          label="Locked accounts"
          icon="lock"
          tone={summary?.locked > 0 ? 'error' : undefined}
          value={summary ? num(summary.locked) : '—'}
          hint={security ? `Lockout after ${security.lockoutThreshold} failed sign-ins for ${security.lockoutMinutes} min` : 'Temporarily locked after failed sign-ins'}
        />
      </div>

      {/* Role architecture bento */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-md">
        {ROLES.map((r, i) => {
          const m = ROLE_META[r];
          const count = roleCount(r);
          const enforced = policy.enforced(r);
          return (
            <button
              key={r}
              type="button"
              onClick={() => setParam('role', role === r ? '' : r)}
              className={clsx(
                'p-space-md rounded bg-surface-container-low shadow-sm flex flex-col justify-between gap-3 text-left transition-colors hover:bg-surface-container',
                role === r && 'ring-1 ring-primary-container'
              )}
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      'font-label-sm text-label-sm px-2 py-0.5 rounded font-bold uppercase tracking-wider',
                      m.tone === 'primary' ? 'bg-primary-container/20 text-primary' : m.tone === 'info' ? 'bg-secondary-container/20 text-secondary' : 'bg-tertiary-container/30 text-tertiary'
                    )}
                  >
                    Tier {i + 1} • {m.scopeShort}
                  </span>
                  <span className="font-label-sm text-label-sm text-outline">{count === undefined ? '—' : `${num(count)} account${count === 1 ? '' : 's'}`}</span>
                </div>
                <h3 className="font-headline-sm text-headline-sm text-on-surface pt-1">{roleLabels[r] ?? m.label}</h3>
                <p className="font-body-sm text-body-sm text-outline leading-snug">{m.description}</p>
              </div>
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between font-label-sm text-label-sm bg-surface-container px-2 py-1 rounded text-on-surface-variant">
                  <span>Scope boundary</span>
                  <span className="text-secondary">{m.scope}</span>
                </div>
                <div className="flex items-center justify-between font-label-sm text-label-sm bg-surface-container px-2 py-1 rounded text-on-surface-variant">
                  <span>MFA policy</span>
                  {enforced === null ? (
                    <span className="text-outline">Per user</span>
                  ) : enforced ? (
                    <span className="text-tertiary font-bold">ENFORCED</span>
                  ) : (
                    <span className="text-outline">Optional (per user)</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Directory */}
      <div className="rounded bg-surface-container-low shadow-sm overflow-hidden flex flex-col">
        <div className="p-space-sm bg-surface-container-lowest flex flex-wrap items-center justify-between gap-space-sm">
          <div className="flex flex-wrap items-center gap-space-sm flex-1 min-w-[280px]">
            <SearchInput value={q} onChange={setQ} placeholder="Search by name or email…" className="flex-1 max-w-md min-w-[200px]" />
            <Select value={role} onChange={(e) => setParam('role', e.target.value)} className="h-8 w-auto">
              <option value="">Role: All</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabels[r] ?? ROLE_META[r].label}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setParam('status', e.target.value)} className="h-8 w-auto">
              <option value="">Status: All</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="disabled">Disabled</option>
            </Select>
            <Select value={locationId} onChange={(e) => setParam('locationId', e.target.value)} className="h-8 w-auto max-w-[220px]">
              <option value="">Location: All</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code})
                </option>
              ))}
            </Select>
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                icon="filter_alt_off"
                onClick={() => {
                  setQ('');
                  setSp(new URLSearchParams(), { replace: true });
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 font-label-sm text-label-sm">
            {list.data && (
              <span className="text-outline">
                {num(list.data.total)} user{list.data.total === 1 ? '' : 's'}
                {filtered ? ' match' : ''}
              </span>
            )}
            <button className="p-1.5 rounded bg-surface-container hover:bg-surface-bright text-outline hover:text-on-surface transition-colors" title="Reload" onClick={() => list.refetch()}>
              <Icon name="refresh" className={clsx('text-[16px]', list.isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>

        {list.isLoading ? (
          <Loading label="Loading users…" />
        ) : list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data || list.data.rows.length === 0 ? (
          <Empty
            icon="person_search"
            title={filtered ? 'No users match these filters.' : 'No users found.'}
            description={filtered ? 'Try a different search or clear the filters.' : undefined}
            action={
              can('users.manage') && !filtered ? (
                <LinkButton to="/users/new" variant="primary" icon="person_add">
                  Add User
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Assigned locations</Th>
                  <Th>Status</Th>
                  <Th>MFA</Th>
                  <Th>Last login</Th>
                  <Th>Sessions</Th>
                  <Th className="text-right">Locked</Th>
                </tr>
              </THead>
              <tbody className="text-on-surface">
                {list.data.rows.map((u: any) => {
                  const locked = isLocked(u);
                  return (
                    <Tr key={u.id} onClick={() => navigate(`/users/${u.id}`)} className={clsx(u.status === 'disabled' && 'opacity-60')}>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={u.full_name} tone={ROLE_META[u.role as Role]?.tone ?? 'neutral'} size={8} />
                          <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-1.5">
                              <Link to={`/users/${u.id}`} onClick={(e) => e.stopPropagation()} className="font-headline-sm text-[13px] text-on-surface truncate hover:text-primary">
                                {u.full_name}
                              </Link>
                              {me?.user.id === u.id && <span className="font-label-sm text-[9px] px-1 rounded bg-primary-container text-on-primary-container font-bold">YOU</span>}
                            </div>
                            <span className="font-label-sm text-[11px] text-outline truncate">{u.email}</span>
                            {u.job_title && <span className="font-label-sm text-[10px] text-outline-variant truncate">{u.job_title}</span>}
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <RoleBadge role={u.role} label={roleLabels[u.role]} />
                      </Td>
                      <Td>
                        <LocationScopeCell user={u} />
                      </Td>
                      <Td>
                        <UserStatusBadge status={u.status} />
                      </Td>
                      <Td>
                        <MfaCell user={u} />
                      </Td>
                      <Td className="whitespace-nowrap">
                        {u.last_login_at ? (
                          <div className="flex flex-col" title={dateTime(u.last_login_at)}>
                            <span className="font-label-sm text-label-sm text-on-surface">{relative(u.last_login_at)}</span>
                            <span className="font-label-sm text-[10px] text-outline font-mono">{u.last_login_ip ?? '—'}</span>
                          </div>
                        ) : (
                          <span className="font-label-sm text-label-sm text-outline">Never</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5 font-label-sm text-label-sm">
                          <span className={clsx('h-1.5 w-1.5 rounded-full', u.active_sessions > 0 ? 'bg-tertiary' : 'bg-outline')} />
                          <span className={u.active_sessions > 0 ? 'text-tertiary' : 'text-outline'}>{u.active_sessions > 0 ? `${u.active_sessions} active` : 'None'}</span>
                        </div>
                      </Td>
                      <Td className="text-right">
                        {locked ? (
                          <span className="inline-flex items-center gap-1 font-label-sm text-label-sm text-error whitespace-nowrap" title={`Locked until ${dateTime(u.locked_until)}`}>
                            <Icon name="lock" className="text-[15px]" />
                            until {time(u.locked_until, undefined, false)}
                          </span>
                        ) : u.failed_login_count > 0 ? (
                          <span className="font-label-sm text-label-sm text-warning whitespace-nowrap">{u.failed_login_count} failed</span>
                        ) : (
                          <Icon name="lock_open" className="text-[15px] text-outline-variant" />
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={(o) => setParam('offset', o ? String(o) : '')} />
          </>
        )}
      </div>

      {/* Policy panel (real settings) */}
      <div className="rounded bg-surface-container-low shadow-md p-space-md space-y-space-md">
        <div className="flex items-center gap-2">
          <Icon name="gavel" className="text-secondary text-[22px]" />
          <div>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Access policy & scope boundaries</h3>
            <p className="font-body-sm text-body-sm text-outline">
              Every API request re-checks the caller's role permissions and assigned locations on the server (FR-5.3). Users only ever receive data for locations they are assigned to.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-space-md">
          <PolicyCard label="Idle timeout" icon="timer" value={security ? `${security.sessionIdleMinutes} minutes` : '—'} text={security ? `Sessions also end after ${security.sessionAbsoluteHours} h regardless of activity.` : 'Visible to users with settings access.'} />
          <PolicyCard
            label="Account lockout"
            icon="lock_reset"
            tone="error"
            value={security ? `${security.lockoutThreshold} fails → ${security.lockoutMinutes}m lock` : '—'}
            text="Administrators can unlock an account early from the user's details page."
          />
          <PolicyCard
            label="MFA enforcement"
            icon="phonelink_lock"
            tone="success"
            value={mfa ? [mfa.enforceForAdministrators && 'Admins', mfa.enforceForManagers && 'Managers', mfa.enforceForSupervisors && 'Supervisors'].filter(Boolean).join(' · ') || 'Per user only' : '—'}
            text="Roles enforced by organisation policy must enrol a TOTP authenticator; others follow the per-user setting."
          />
          <PolicyCard label="Location scoping" icon="visibility_off" tone="info" value="Server-side" text="Managers see only their assigned locations; Branch Supervisors exactly one branch. Out-of-scope requests return 403." />
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, icon, value, hint, tone, onClick, active }: { label: string; icon: string; value: string; hint?: string; tone?: 'success' | 'warning' | 'error' | 'info'; onClick?: () => void; active?: boolean }) {
  const color = tone === 'success' ? 'text-tertiary' : tone === 'warning' ? 'text-warning' : tone === 'error' ? 'text-error' : tone === 'info' ? 'text-secondary' : 'text-on-surface';
  const cls = clsx('p-space-md rounded bg-surface-container-low shadow-sm relative overflow-hidden flex flex-col justify-between text-left', onClick && 'hover:bg-surface-container transition-colors', active && 'ring-1 ring-primary-container');
  const body = (
    <>
      <div className="flex items-center justify-between w-full">
        <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">{label}</span>
        <Icon name={icon} className={clsx('text-[20px]', tone ? color : 'text-secondary')} />
      </div>
      <div className="mt-2">
        <span className={clsx('font-headline-xl text-headline-xl font-semibold', color)}>{value}</span>
      </div>
      {hint && <div className="mt-2 font-label-sm text-label-sm text-outline">{hint}</div>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function PolicyCard({ label, icon, value, text, tone }: { label: string; icon: string; value: string; text: string; tone?: 'error' | 'success' | 'info' }) {
  const color = tone === 'error' ? 'text-error' : tone === 'success' ? 'text-tertiary' : tone === 'info' ? 'text-secondary' : 'text-on-surface';
  return (
    <div className="p-space-sm rounded bg-surface-container space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-label-sm text-label-sm text-outline uppercase font-semibold">{label}</span>
        <Icon name={icon} className={clsx('text-[16px]', tone ? color : 'text-outline')} />
      </div>
      <div className={clsx('font-headline-sm text-headline-sm', color)}>{value}</div>
      <p className="font-body-sm text-[11px] text-outline leading-tight">{text}</p>
    </div>
  );
}
