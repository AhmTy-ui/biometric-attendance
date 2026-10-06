import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { ErrorState, Icon, LinkButton, Loading, PageHeader, Panel, Table, Td, Th, THead, Tr } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, type Role } from '@/lib/auth';
import { humanize, num } from '@/lib/format';
import { RoleBadge, roleMeta, ROLE_META } from './components';

interface Matrix {
  permissions: { key: string; label: string }[];
  roles: { role: Role; label: string; permissions: string[] }[];
}

const GROUP_LABEL: Record<string, string> = {
  dashboard: 'Dashboard',
  attendance: 'Attendance',
  reports: 'Reports',
  employees: 'Employees',
  locations: 'Locations',
  devices: 'Devices',
  enrolment: 'Enrolment',
  firmware: 'Firmware',
  alerts: 'Alerts',
  integration: 'Integration',
  users: 'Users & roles',
  audit: 'Audit log',
  settings: 'Settings'
};

export default function RolesPermissions() {
  const { can, me } = useAuth();
  const matrix = useQuery<Matrix>({ queryKey: ['permissions-matrix'], queryFn: () => api.get('/api/auth/permissions-matrix'), staleTime: 5 * 60_000 });
  const users = useQuery<any>({ queryKey: ['users', { limit: 1, purpose: 'summary' }], queryFn: () => api.get('/api/users', { limit: 1 }), enabled: can('users.view') });
  const summary = users.data?.summary;
  const countFor = (r: Role) => (summary ? (r === 'administrator' ? summary.administrators : r === 'manager' ? summary.managers : summary.supervisors) : null);

  if (matrix.isLoading) return <Loading label="Loading permissions…" />;
  if (matrix.error || !matrix.data) return <ErrorState error={matrix.error} onRetry={() => matrix.refetch()} />;
  const { permissions, roles } = matrix.data;

  // Group permissions by their prefix, preserving server order.
  const groups: { key: string; items: { key: string; label: string }[] }[] = [];
  for (const p of permissions) {
    const g = p.key.split('.')[0]!;
    let bucket = groups.find((x) => x.key === g);
    if (!bucket) {
      bucket = { key: g, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(p);
  }

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        title="Roles & Permissions"
        icon="shield_person"
        crumbs={[{ label: 'Users', to: '/users' }, { label: 'Roles & Permissions' }]}
        subtitle="Roles are fixed. Each user has exactly one role; what they can see is further restricted to their assigned locations."
        actions={
          <>
            <LinkButton to="/users" icon="group">
              Users
            </LinkButton>
            {can('users.manage') && (
              <LinkButton to="/users/new" variant="primary" icon="person_add">
                Add User
              </LinkButton>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-md">
        {roles.map((r) => {
          const m = roleMeta(r.role);
          const n = countFor(r.role);
          return (
            <div key={r.role} className={clsx('p-space-md rounded bg-surface-container-low shadow-sm flex flex-col gap-3', me?.user.role === r.role && 'ring-1 ring-primary-container/60')}>
              <div className="flex items-center justify-between">
                <RoleBadge role={r.role} label={r.label} />
                <span className="font-label-sm text-label-sm text-outline">
                  {r.permissions.length}/{permissions.length} permissions{n !== null ? ` · ${num(n)} user${n === 1 ? '' : 's'}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Icon name={m.icon} className="text-[22px] text-primary" />
                <h3 className="font-headline-sm text-headline-sm text-on-surface">{r.label}</h3>
                {me?.user.role === r.role && <span className="font-label-sm text-[9px] px-1 rounded bg-primary-container text-on-primary-container font-bold">YOUR ROLE</span>}
              </div>
              <p className="font-body-sm text-body-sm text-outline leading-snug">{m.description}</p>
              <div className="flex items-center justify-between font-label-sm text-label-sm bg-surface-container px-2 py-1 rounded text-on-surface-variant">
                <span>Scope boundary</span>
                <span className="text-secondary">{m.scope}</span>
              </div>
            </div>
          );
        })}
      </div>

      <Panel title="Permission matrix" icon="table_view" subtitle="Served by the backend from the same definition it uses to authorise requests" bodyClassName="px-0">
        <Table>
          <THead>
            <tr>
              <Th>Permission</Th>
              <Th className="hidden md:table-cell">Key</Th>
              {roles.map((r) => (
                <Th key={r.role} className="text-center">
                  {r.label}
                </Th>
              ))}
            </tr>
          </THead>
          <tbody className="text-on-surface">
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="bg-surface-container/60">
                  <td colSpan={2 + roles.length} className="px-space-md py-1.5 font-label-sm text-label-sm uppercase tracking-wider text-outline">
                    {GROUP_LABEL[g.key] ?? humanize(g.key)}
                  </td>
                </tr>
                {g.items.map((p) => (
                  <Tr key={p.key}>
                    <Td>{p.label}</Td>
                    <Td className="hidden md:table-cell font-mono text-[11px] text-outline">{p.key}</Td>
                    {roles.map((r) => {
                      const has = r.permissions.includes(p.key);
                      return (
                        <Td key={r.role} className="text-center">
                          {has ? (
                            <Icon name="check_circle" fill className="text-[18px] text-tertiary" />
                          ) : (
                            <Icon name="remove" className="text-[18px] text-outline-variant" />
                          )}
                          <span className="sr-only">{has ? 'Granted' : 'Not granted'}</span>
                        </Td>
                      );
                    })}
                  </Tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </Table>
      </Panel>

      <div className="rounded-xl card p-space-md space-y-space-md">
        <div className="flex items-center gap-2">
          <Icon name="gavel" className="text-secondary text-[22px]" />
          <div>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Location-scoped access (FR-5.3)</h3>
            <p className="font-body-sm text-body-sm text-outline">Permissions say what a user may do; location scope says where. Both are enforced server-side on every request — hiding a button in the dashboard is never the only control.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
          {(Object.keys(ROLE_META) as Role[]).map((r) => (
            <div key={r} className="p-space-sm rounded bg-surface-container space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-outline uppercase font-semibold">{ROLE_META[r].label}</span>
                <Icon name={ROLE_META[r].icon} className="text-[16px] text-secondary" />
              </div>
              <div className="font-headline-sm text-headline-sm text-on-surface">{ROLE_META[r].scope}</div>
              <p className="font-body-sm text-[11px] text-outline leading-tight">
                {r === 'administrator'
                  ? 'No location filter is applied. Includes locations created after the user was set up.'
                  : r === 'manager'
                    ? 'Every list, detail, report, export and live update is filtered to the assigned locations. Requests for other locations are rejected with 403.'
                    : 'Bound to one branch. Device commands are limited to roster sync and status refresh; restarts, configuration and firmware are not available.'}
              </p>
            </div>
          ))}
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-space-xs font-body-sm text-body-sm text-on-surface-variant">
          <li className="flex items-start gap-2">
            <Icon name="check" className="text-[16px] text-tertiary" />
            The scope is loaded from the database for each session, so reassigning locations takes effect on the user's next request.
          </li>
          <li className="flex items-start gap-2">
            <Icon name="check" className="text-[16px] text-tertiary" />
            Changing a user's role signs them out of all sessions.
          </li>
          <li className="flex items-start gap-2">
            <Icon name="check" className="text-[16px] text-tertiary" />
            At least one active Administrator must always remain; users cannot change their own role or disable themselves.
          </li>
          <li className="flex items-start gap-2">
            <Icon name="check" className="text-[16px] text-tertiary" />
            Every role and scope change is recorded in the append-only audit log.
          </li>
        </ul>
      </div>
    </div>
  );
}
