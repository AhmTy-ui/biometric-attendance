import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge, CopyButton, Icon, Loading, ErrorState, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, type Role } from '@/lib/auth';

// ───────────────────────── Roles (user flow §17) ─────────────────────────
export const ROLES: Role[] = ['administrator', 'manager', 'branch_supervisor'];

export const ROLE_META: Record<Role, { label: string; tone: Tone; icon: string; scope: string; scopeShort: string; description: string; access: string[] }> = {
  administrator: {
    label: 'Administrator',
    tone: 'primary',
    icon: 'admin_panel_settings',
    scope: 'All locations',
    scopeShort: 'ALL LOCATIONS',
    description: 'Full access across the organisation: all locations, devices, employees, system configuration and audit logs.',
    access: ['All locations', 'Devices & firmware', 'Employees', 'System configuration', 'Users & roles', 'Audit logs']
  },
  manager: {
    label: 'Manager',
    tone: 'info',
    icon: 'supervisor_account',
    scope: 'Assigned locations (one or more)',
    scopeShort: 'ASSIGNED LOCATIONS',
    description: 'Operates the locations they are assigned to: attendance, employees, devices and reports.',
    access: ['Assigned locations', 'Attendance', 'Employees', 'Devices', 'Reports']
  },
  branch_supervisor: {
    label: 'Branch Supervisor',
    tone: 'success',
    icon: 'storefront',
    scope: 'Exactly one assigned branch',
    scopeShort: 'SINGLE BRANCH',
    description: 'Runs a single branch: attendance, employees and branch devices, with limited device operations.',
    access: ['Assigned branch', 'Attendance', 'Employees', 'Branch devices', 'Limited device operations']
  }
};

export const roleMeta = (r: string | null | undefined) => ROLE_META[(r ?? 'manager') as Role] ?? ROLE_META.manager;

const roleBadgeCls: Record<Tone, string> = {
  primary: 'bg-primary-container/20 text-primary',
  info: 'bg-secondary-container/20 text-secondary',
  success: 'bg-tertiary-container/20 text-tertiary',
  warning: 'bg-warning-container/60 text-warning',
  error: 'bg-error-container text-on-error-container',
  neutral: 'bg-surface-container-high text-on-surface-variant'
};
const roleDotCls: Record<Tone, string> = {
  primary: 'bg-primary',
  info: 'bg-secondary',
  success: 'bg-tertiary',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-outline'
};

export function RoleBadge({ role, label }: { role: string; label?: string }) {
  const m = roleMeta(role);
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded font-label-sm text-[10px] uppercase font-bold tracking-wider whitespace-nowrap', roleBadgeCls[m.tone])}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', roleDotCls[m.tone])} />
      {label ?? m.label}
    </span>
  );
}

// ───────────────────────── Status / security ─────────────────────────
export const isLocked = (u: any) => Boolean(u?.locked_until && new Date(u.locked_until).getTime() > Date.now());

export function UserStatusBadge({ status }: { status: string }) {
  if (status === 'active')
    return (
      <Badge tone="success" icon="check_circle">
        Active
      </Badge>
    );
  if (status === 'invited')
    return (
      <Badge tone="info" icon="mail">
        Invited
      </Badge>
    );
  if (status === 'disabled')
    return (
      <Badge tone="neutral" icon="block">
        Disabled
      </Badge>
    );
  return <Badge>{status}</Badge>;
}

/** MFA column: enabled (enrolled) vs. required-but-not-yet-enrolled vs. off. */
export function MfaCell({ user }: { user: any }) {
  if (user.mfa_enabled)
    return (
      <div className="flex items-center gap-1.5 font-label-sm text-label-sm text-tertiary whitespace-nowrap">
        <Icon name="verified_user" className="text-[15px]" />
        <span>Enabled (TOTP)</span>
      </div>
    );
  if (user.mfa_required)
    return (
      <div className="flex items-center gap-1.5 font-label-sm text-label-sm text-warning whitespace-nowrap">
        <Icon name="pending" className="text-[15px]" />
        <span>Required · not enrolled</span>
      </div>
    );
  return (
    <div className="flex items-center gap-1.5 font-label-sm text-label-sm text-outline whitespace-nowrap">
      <Icon name="remove_moderator" className="text-[15px]" />
      <span>Not enabled</span>
    </div>
  );
}

export function LocationScopeCell({ user }: { user: any }) {
  const locs: any[] = Array.isArray(user.locations) ? user.locations : [];
  if (user.role === 'administrator')
    return (
      <div className="flex flex-col">
        <span className="font-label-lg text-label-sm text-secondary font-medium">ALL LOCATIONS (*)</span>
        <span className="font-label-sm text-[10px] text-outline">Unrestricted organisation scope</span>
      </div>
    );
  if (locs.length === 0)
    return (
      <div className="flex items-center gap-1 font-label-sm text-label-sm text-error">
        <Icon name="warning" className="text-[14px]" />
        No location assigned
      </div>
    );
  return (
    <div className="flex flex-col min-w-0">
      <span className="font-label-lg text-label-sm text-on-surface font-medium truncate max-w-[220px]">{locs.map((l) => l.code).join(', ')}</span>
      <span className="font-label-sm text-[10px] text-outline truncate max-w-[220px]">{locs.map((l) => l.name).join(' • ')}</span>
    </div>
  );
}

// ───────────────────────── Location picker (role-aware) ─────────────────────────
export function useAllLocations() {
  return useQuery<any[]>({ queryKey: ['locations', 'lookup'], queryFn: () => api.get('/api/locations'), staleTime: 60_000 });
}

export function locationRuleError(role: Role, ids: string[]): string | null {
  if (role === 'branch_supervisor' && ids.length !== 1) return 'A Branch Supervisor must be assigned exactly one branch.';
  if (role === 'manager' && ids.length < 1) return 'A Manager must be assigned at least one location.';
  return null;
}

export function LocationPicker({ role, value, onChange, disabled }: { role: Role; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const q = useAllLocations();
  if (role === 'administrator')
    return (
      <div className="flex items-start gap-space-sm p-space-sm rounded bg-surface-container text-body-sm text-on-surface-variant">
        <Icon name="public" className="text-[18px] text-secondary" />
        <span>Administrators are not restricted to specific locations — they automatically have access to every location, including locations created later.</span>
      </div>
    );
  if (q.isLoading) return <Loading label="Loading locations…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  const locs = q.data ?? [];
  if (locs.length === 0)
    return (
      <div className="flex items-start gap-space-sm p-space-sm rounded bg-warning-container/40 text-body-sm text-warning">
        <Icon name="warning" className="text-[18px]" />
        <span>No locations exist yet. Locations are created from the web software sync or under Locations before they can be assigned.</span>
      </div>
    );
  const single = role === 'branch_supervisor';
  const toggle = (id: string) => {
    if (single) onChange([id]);
    else onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  return (
    <div className="flex flex-col gap-space-xs">
      <div className="flex items-center justify-between font-label-sm text-label-sm text-outline">
        <span>{single ? 'Select exactly one branch' : `Select one or more locations · ${value.length} selected`}</span>
        {!single && (
          <div className="flex items-center gap-2">
            <button type="button" disabled={disabled} className="hover:text-on-surface disabled:opacity-50" onClick={() => onChange(locs.map((l) => l.id))}>
              Select all
            </button>
            <span className="text-outline-variant">|</span>
            <button type="button" disabled={disabled} className="hover:text-on-surface disabled:opacity-50" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-xs max-h-72 overflow-y-auto pr-1">
        {locs.map((l) => {
          const on = value.includes(l.id);
          return (
            <button
              type="button"
              key={l.id}
              disabled={disabled}
              onClick={() => toggle(l.id)}
              className={clsx(
                'flex items-start gap-2 p-space-sm rounded text-left border transition-colors disabled:opacity-60',
                on ? 'bg-primary-container/15 border-primary-container' : 'bg-surface-container border-transparent hover:bg-surface-container-high'
              )}
            >
              <Icon name={single ? (on ? 'radio_button_checked' : 'radio_button_unchecked') : on ? 'check_box' : 'check_box_outline_blank'} className={clsx('text-[18px]', on ? 'text-primary' : 'text-outline')} />
              <div className="min-w-0">
                <div className="text-body-sm text-on-surface font-medium truncate">{l.name}</div>
                <div className="font-label-sm text-label-sm text-outline truncate">
                  {l.code} · {l.active_employees ?? 0} employees · {l.devices ?? 0} devices{l.is_active === false ? ' · inactive' : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Org MFA policy ─────────────────────────
/** Returns whether MFA is enforced for a role by organisation policy (null when settings are not viewable). */
export function useMfaPolicy() {
  const { can } = useAuth();
  const q = useQuery<any>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings'), enabled: can('settings.view'), staleTime: 60_000 });
  const m = q.data?.settings?.mfa;
  const enforced = (role: Role): boolean | null => {
    if (!m) return null;
    return role === 'administrator' ? Boolean(m.enforceForAdministrators) : role === 'manager' ? Boolean(m.enforceForManagers) : Boolean(m.enforceForSupervisors);
  };
  return { enforced, settings: q.data?.settings ?? null, smtpConfigured: q.data?.environment?.smtpConfigured as boolean | undefined };
}

// ───────────────────────── One-time link result ─────────────────────────
export function LinkResult({ title, link, emailSent, smtpConfigured, validity, children }: { title: string; link: string; emailSent: boolean; smtpConfigured?: boolean; validity: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-space-sm">
      <div className={clsx('flex items-start gap-space-sm p-space-sm rounded', emailSent ? 'bg-tertiary-container/15' : 'bg-warning-container/40')}>
        <Icon name={emailSent ? 'mark_email_read' : 'unsubscribe'} className={clsx('text-[20px]', emailSent ? 'text-tertiary' : 'text-warning')} />
        <div className="text-body-sm">
          <div className="font-semibold text-on-surface">{emailSent ? 'Email sent.' : 'Email was not sent.'}</div>
          <div className="text-on-surface-variant">
            {emailSent
              ? 'The recipient has been emailed this link. You can also share it directly.'
              : smtpConfigured === false
                ? 'SMTP is not configured on the server, so no email could be delivered. Copy the link below and share it with the user through a secure channel.'
                : 'The mail server did not accept the message. Copy the link below and share it with the user through a secure channel.'}
          </div>
        </div>
      </div>
      <div>
        <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider mb-1">{title}</div>
        <div className="flex items-center gap-space-xs">
          <code className="flex-1 min-w-0 bg-surface-container-lowest rounded px-space-sm py-2 font-mono text-[11px] text-secondary break-all">{link}</code>
          <CopyButton value={link} />
        </div>
        <div className="mt-1 font-body-sm text-body-sm text-outline">{validity} · the link is single-use and is shown only now.</div>
      </div>
      {children}
    </div>
  );
}
