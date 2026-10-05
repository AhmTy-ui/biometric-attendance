import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  Icon,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  Progress,
  Select,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, num, relative } from '@/lib/format';
import { useLive, useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { ENROLMENT_STATUS, EnrolmentStatusBadge, useNow } from './components';

/**
 * Biometric enrolment (user flow §10, Journey B). Enrolment happens on the terminal; this page monitors it live,
 * shows coverage, who still needs enrolment and which supervisors can authorise it.
 */
const LIMIT = 25;

interface SessionsResponse {
  rows: any[];
  stats: { completed: number; failed_quality: number; employee_unavailable: number; unauthorised: number; in_progress: number } | null;
  coverage: { active: number; fully_enrolled: number; partial: number; none: number } | null;
}

const JOURNEY = [
  { icon: 'cloud_sync', title: 'Employee exists in web software', text: 'Employees are created in the company web software only — never on the terminal.' },
  { icon: 'sim_card_download', title: 'Synced to device roster', text: "The employee is synchronised to the platform and pushed to every device at their location." },
  { icon: 'shield_person', title: 'Supervisor authenticates', text: 'An authorised supervisor starts enrolment on the terminal with their fingerprint or PIN.' },
  { icon: 'person_search', title: 'Select employee', text: "The supervisor picks the employee from the device's local roster." },
  { icon: 'fingerprint', title: 'Capture finger #1 and #2', text: 'Two fingers are captured; low-quality captures are rejected and retried.' },
  { icon: 'cloud_upload', title: 'Template uploaded', text: 'The template is generated on the terminal (no raw image leaves it) and uploaded over signed HTTPS.' }
];

interface FeedItem {
  key: string;
  at: number;
  data: any;
}

export default function EnrolmentMonitor() {
  const { can } = useAuth();
  const { status: liveStatus } = useLive();
  const [params, setParams] = useSearchParams();
  const [globalLoc] = useGlobalLocation();
  const [locationId, setLocationId] = useState(params.get('locationId') ?? globalLoc ?? '');
  const deviceId = params.get('deviceId') ?? '';
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  useNow();

  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    setLocationId(globalLoc ?? '');
  }, [globalLoc]);
  useEffect(() => setOffset(0), [locationId, deviceId, status]);

  const setDevice = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('deviceId', id);
    else next.delete('deviceId');
    setParams(next, { replace: true });
  };

  const locations = useQuery({ queryKey: ['locations', 'options'], queryFn: () => api.get<any[]>('/api/locations'), enabled: can('locations.view'), staleTime: 60_000 });
  const devices = useQuery({
    queryKey: ['devices', { locationId: locationId || undefined, limit: 1000, options: true }],
    queryFn: () => api.get<{ rows: any[] }>('/api/devices', { locationId: locationId || undefined, limit: 1000 }),
    enabled: can('devices.view')
  });
  const selectedDevice = (devices.data?.rows ?? []).find((d) => d.id === deviceId);
  const effectiveLoc = locationId || selectedDevice?.location_id || '';

  const sessionFilters = { locationId: locationId || undefined, deviceId: deviceId || undefined, status: status || undefined, limit: LIMIT, offset };
  const sessions = useQuery({
    queryKey: ['enrolment-sessions', sessionFilters],
    queryFn: () => api.get<SessionsResponse>('/api/enrolment-sessions', sessionFilters),
    placeholderData: (p) => p
  });

  // Coverage per location from the employee directory (same data the employee profile uses).
  const empEnabled = can('employees.view');
  const empQuery = (biometric: string, limit: number) => ({ biometric, status: 'active', locationId: effectiveLoc || undefined, limit, offset: 0 });
  const noneQ = useQuery({ queryKey: ['employees', empQuery('none', 15)], queryFn: () => api.get<{ total: number; rows: any[] }>('/api/employees', empQuery('none', 15)), enabled: empEnabled });
  const partialQ = useQuery({ queryKey: ['employees', empQuery('partial', 15)], queryFn: () => api.get<{ total: number; rows: any[] }>('/api/employees', empQuery('partial', 15)), enabled: empEnabled });
  const enrolledQ = useQuery({ queryKey: ['employees', empQuery('enrolled', 1)], queryFn: () => api.get<{ total: number; rows: any[] }>('/api/employees', empQuery('enrolled', 1)), enabled: empEnabled });

  const users = useQuery({
    queryKey: ['users', { status: 'active', limit: 500, enrolment: true }],
    queryFn: () => api.get<{ rows: any[]; roleLabels: Record<string, string> }>('/api/users', { status: 'active', limit: 500 }),
    enabled: can('users.view')
  });

  useLiveEvents('enrolment/session', (f) => {
    const d = f.data;
    if (!d) return;
    if (deviceId && d.device_id !== deviceId) return;
    if (locationId && d.locationId !== locationId) return;
    setFeed((s) => [{ key: `${d.id}-${d.status}-${f.at}`, at: Date.now(), data: d }, ...s].slice(0, 20));
  });

  const coverage = useMemo(() => {
    if (empEnabled && noneQ.data && partialQ.data && enrolledQ.data) {
      const full = enrolledQ.data.total;
      const partial = partialQ.data.total;
      const none = noneQ.data.total;
      return { active: full + partial + none, fully_enrolled: full, partial, none, scoped: Boolean(effectiveLoc) };
    }
    const c = sessions.data?.coverage;
    return c ? { ...c, scoped: false } : null;
  }, [empEnabled, noneQ.data, partialQ.data, enrolledQ.data, sessions.data, effectiveLoc]);

  const stats = sessions.data?.stats;
  const rows = sessions.data?.rows ?? [];
  const locName = (locations.data ?? []).find((l) => l.id === effectiveLoc)?.name ?? selectedDevice?.location_name;

  return (
    <div className="p-gutter space-y-gutter">
      <PageHeader
        icon="fingerprint"
        title="Biometric Enrolment"
        crumbs={[{ label: 'Devices', to: '/devices' }, { label: 'Enrolment' }]}
        subtitle="Fingerprint enrolment is performed on the terminal under supervisor authorisation; sessions appear here live."
        actions={
          <div className="flex items-center gap-space-xs">
            <span className="bg-surface-container px-3 py-1.5 rounded flex items-center gap-2 font-label-sm text-label-sm">
              <Dot tone={liveStatus === 'open' ? 'success' : liveStatus === 'connecting' ? 'warning' : 'error'} pulse={liveStatus === 'open'} />
              <span className="text-outline">LIVE:</span>
              <span className="text-on-surface font-semibold uppercase">{liveStatus === 'open' ? 'Connected' : liveStatus}</span>
            </span>
          </div>
        }
      />

      {/* Journey B: how enrolment works */}
      <div className="bg-surface-container-low rounded-xl p-space-md shadow-sm space-y-space-sm">
        <div className="flex items-center justify-between gap-space-sm flex-wrap">
          <div className="flex items-center gap-2">
            <Icon name="route" className="text-primary text-[20px]" />
            <span className="font-headline-sm text-headline-sm text-on-surface">How enrolment works</span>
            <Badge tone="success">Journey B</Badge>
          </div>
          <span className="font-label-sm text-label-sm text-outline">Fingerprint only · templates encrypted in escrow and distributed to the location's devices</span>
        </div>
        <div className="flex items-center gap-1.5">
          {JOURNEY.map((_, i) => (
            <div key={i} className={clsx('h-1.5 flex-1 rounded', i < 2 ? 'bg-secondary' : i < 5 ? 'bg-primary' : 'bg-tertiary')} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-space-sm">
          {JOURNEY.map((s, i) => (
            <div key={s.title} className="bg-surface-container rounded p-space-sm flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="font-label-sm text-label-sm text-outline font-mono">{String(i + 1).padStart(2, '0')}</span>
                <Icon name={s.icon} className={clsx('text-[18px]', i < 2 ? 'text-secondary' : i < 5 ? 'text-primary' : 'text-tertiary')} />
              </div>
              <span className="text-body-sm font-semibold text-on-surface">{s.title}</span>
              <span className="text-body-sm text-on-surface-variant">{s.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="p-space-sm rounded bg-surface-container shadow-sm flex flex-col md:flex-row md:items-center gap-space-sm">
        {can('locations.view') && (
          <Select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setDevice('');
            }}
            className="h-8 md:w-56"
          >
            <option value="">All locations</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        {can('devices.view') && (
          <Select value={deviceId} onChange={(e) => setDevice(e.target.value)} className="h-8 md:w-64">
            <option value="">All devices</option>
            {(devices.data?.rows ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.device_uid})
              </option>
            ))}
          </Select>
        )}
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 md:w-56">
          <option value="">All outcomes</option>
          {Object.entries(ENROLMENT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        {selectedDevice && (
          <LinkButton to={`/devices/${selectedDevice.id}?tab=biometrics`} size="sm" icon="router" variant="ghost">
            {selectedDevice.name}
          </LinkButton>
        )}
      </div>

      {/* KPIs: coverage + 30-day outcomes */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-md">
        <Panel title="Enrolment coverage" icon="groups" subtitle={coverage?.scoped && locName ? `Active employees at ${locName}` : 'Active employees in your locations'}>
          {!coverage ? (
            sessions.isLoading ? (
              <Loading label="Loading coverage…" />
            ) : (
              <Empty icon="groups" title="Coverage unavailable." />
            )
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
                <Stat label="Active employees" value={num(coverage.active)} icon="groups" />
                <Stat label="Fully enrolled" value={num(coverage.fully_enrolled)} tone="success" icon="verified" hint="2+ fingers" />
                <Stat label="Partial" value={num(coverage.partial)} tone={coverage.partial ? 'warning' : undefined} icon="fingerprint" hint="1 finger" />
                <Stat label="Not enrolled" value={num(coverage.none)} tone={coverage.none ? 'error' : undefined} icon="person_off" hint="0 fingers" />
              </div>
              <div className="mt-space-sm">
                <div className="flex h-2 w-full rounded-full overflow-hidden bg-surface-container-highest gap-[2px]">
                  {coverage.active > 0 && (
                    <>
                      <div className="bg-tertiary" style={{ width: `${(coverage.fully_enrolled / coverage.active) * 100}%` }} />
                      <div className="bg-warning" style={{ width: `${(coverage.partial / coverage.active) * 100}%` }} />
                      <div className="bg-error" style={{ width: `${(coverage.none / coverage.active) * 100}%` }} />
                    </>
                  )}
                </div>
                <div className="mt-1 font-label-sm text-label-sm text-outline">
                  {coverage.active > 0 ? `${((coverage.fully_enrolled / coverage.active) * 100).toFixed(1)}% fully enrolled` : 'No active employees'}
                </div>
              </div>
            </>
          )}
        </Panel>
        <Panel title="Session outcomes · last 30 days" icon="insights" subtitle="Terminal UX states reported by devices">
          {sessions.isLoading ? (
            <Loading label="Loading sessions…" />
          ) : !stats ? (
            <Empty icon="insights" title="No statistics." />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-space-sm">
              <Stat label="Enrolled" value={num(stats.completed)} tone="success" icon="verified" />
              <Stat label="In progress" value={num(stats.in_progress)} tone="info" icon="fingerprint" hint="last 15 min" />
              <Stat label="Quality too low" value={num(stats.failed_quality)} tone={stats.failed_quality ? 'warning' : undefined} icon="blur_on" />
              <Stat label="Employee unavailable" value={num(stats.employee_unavailable)} tone={stats.employee_unavailable ? 'error' : undefined} icon="person_off" />
              <Stat label="Unauthorised" value={num(stats.unauthorised)} tone={stats.unauthorised ? 'error' : undefined} icon="gpp_bad" />
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md items-start">
        <div className="xl:col-span-8 space-y-space-md">
          {/* Live feed */}
          <Panel title="Live session feed" icon="sensors" subtitle="Updates as terminals report each step" actions={feed.length > 0 ? <Badge tone="info">{feed.length}</Badge> : undefined}>
            {feed.length === 0 ? (
              <div className="flex items-center gap-space-sm py-space-sm text-body-sm text-on-surface-variant">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-40" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
                </span>
                Waiting for enrolment activity{selectedDevice ? ` on ${selectedDevice.name}` : locName ? ` at ${locName}` : ''}…
              </div>
            ) : (
              <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {feed.map((it) => {
                  const d = it.data;
                  const info = ENROLMENT_STATUS[d.status];
                  const row = rows.find((r) => r.id === d.id);
                  return (
                    <div key={it.key} className="p-2 rounded bg-surface-container-lowest flex items-start justify-between gap-space-sm">
                      <div className="flex items-start gap-2 min-w-0">
                        <Icon
                          name={info?.icon ?? 'help'}
                          className={clsx('text-[18px] shrink-0', info?.tone === 'success' ? 'text-tertiary' : info?.tone === 'error' ? 'text-error' : info?.tone === 'warning' ? 'text-warning' : 'text-secondary')}
                        />
                        <div className="min-w-0">
                          <div className="text-body-sm text-on-surface">
                            <span className="font-semibold">{info?.label ?? d.status}</span>
                            {row?.employee_name && <> · {row.employee_name}</>}
                            {d.fingers_captured > 0 && <span className="text-outline"> · {d.fingers_captured} finger(s)</span>}
                          </div>
                          <div className="font-label-sm text-label-sm text-outline truncate">
                            {d.deviceName ?? row?.device_name}
                            {row?.supervisor_name ? ` · authorised by ${row.supervisor_name}` : ''}
                            {d.authorisation_method ? ` (${d.authorisation_method === 'pin' ? 'PIN' : 'fingerprint'})` : ''}
                          </div>
                          {(d.detail || info) && <div className="text-body-sm text-on-surface-variant">{d.detail ?? info?.message}</div>}
                        </div>
                      </div>
                      <span className="font-label-sm text-label-sm text-outline shrink-0">{relative(new Date(it.at))}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* Sessions */}
          <Panel title="Enrolment sessions" icon="how_to_reg" bodyClassName="px-0 pb-0">
            {sessions.isLoading ? (
              <Loading label="Loading sessions…" />
            ) : sessions.error && !sessions.data ? (
              <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
            ) : rows.length === 0 ? (
              <Empty icon="fingerprint" title="No enrolment sessions found." description={status || deviceId || locationId ? 'No session matches these filters.' : 'Sessions appear when a supervisor starts enrolment on a terminal.'} />
            ) : (
              <>
                <Table>
                  <THead>
                    <tr>
                      <Th>Started</Th>
                      <Th>Device</Th>
                      <Th>Employee</Th>
                      <Th>Supervisor</Th>
                      <Th>Fingers</Th>
                      <Th>Outcome</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {rows.map((s) => (
                      <Tr key={s.id}>
                        <Td className="whitespace-nowrap">
                          <span className="text-on-surface" title={dateTime(s.started_at)}>
                            {relative(s.started_at)}
                          </span>
                          <span className="block font-label-sm text-label-sm text-outline">
                            {s.finished_at ? `took ${duration(new Date(s.finished_at).getTime() - new Date(s.started_at).getTime())}` : 'open'}
                          </span>
                        </Td>
                        <Td>
                          <Link to={`/devices/${s.device_id}`} className="text-on-surface hover:text-primary">
                            {s.device_name}
                          </Link>
                          <span className="block font-label-sm text-label-sm text-outline">{s.location_name ?? 'Unassigned'}</span>
                        </Td>
                        <Td>
                          {s.employee_id && s.employee_name ? (
                            can('employees.view') ? (
                              <Link to={`/employees/${s.employee_id}`} className="text-on-surface hover:text-primary">
                                {s.employee_name}
                              </Link>
                            ) : (
                              <span className="text-on-surface">{s.employee_name}</span>
                            )
                          ) : (
                            <span className="text-outline">Not selected</span>
                          )}
                          {s.staff_number && <span className="block font-label-sm text-label-sm text-outline font-mono">{s.staff_number}</span>}
                        </Td>
                        <Td>
                          {s.supervisor_name ?? <span className="text-outline">—</span>}
                          {s.authorisation_method && (
                            <span className="block font-label-sm text-label-sm text-outline">
                              <Icon name={s.authorisation_method === 'pin' ? 'pin' : 'fingerprint'} className="text-[11px] align-middle" /> {s.authorisation_method === 'pin' ? 'PIN' : 'Fingerprint'}
                            </span>
                          )}
                        </Td>
                        <Td>
                          <div className="flex gap-1">
                            {[0, 1].map((i) => (
                              <span key={i} className={clsx('w-5 h-5 rounded flex items-center justify-center', i < s.fingers_captured ? 'bg-tertiary/20 text-tertiary' : 'bg-surface-container-highest text-outline')}>
                                <Icon name="fingerprint" className="text-[13px]" />
                              </span>
                            ))}
                            {s.fingers_captured > 2 && <span className="font-mono text-body-sm text-outline">+{s.fingers_captured - 2}</span>}
                          </div>
                        </Td>
                        <Td>
                          <EnrolmentStatusBadge session={s} />
                          <div className="text-body-sm text-outline mt-0.5 max-w-xs">{s.detail ?? ENROLMENT_STATUS[s.status]?.message}</div>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                <div className="flex items-center justify-between px-space-md py-space-sm bg-surface-container-lowest/80 font-label-sm text-label-sm text-outline">
                  <span>
                    Sessions {offset + 1}–{offset + rows.length}
                  </span>
                  <div className="flex gap-1">
                    <Button size="sm" icon="chevron_left" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
                      Newer
                    </Button>
                    <Button size="sm" disabled={rows.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>
                      Older <Icon name="chevron_right" className="text-[15px]" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </Panel>
        </div>

        <div className="xl:col-span-4 space-y-space-md">
          {empEnabled && <NeedsEnrolment noneQ={noneQ} partialQ={partialQ} locName={effectiveLoc ? locName : undefined} />}
          {can('users.view') && <Supervisors q={users} locationId={effectiveLoc} locName={effectiveLoc ? locName : undefined} />}
        </div>
      </div>
    </div>
  );
}

type EmpQ = { data?: { total: number; rows: any[] }; isLoading: boolean; error: unknown; refetch: () => unknown };

function NeedsEnrolment({ noneQ, partialQ, locName }: { noneQ: EmpQ; partialQ: EmpQ; locName?: string }) {
  const [tab, setTab] = useState<'none' | 'partial'>('none');
  const q = tab === 'none' ? noneQ : partialQ;
  return (
    <Panel title="Still needs enrolment" icon="person_alert" subtitle={locName ? `Active employees at ${locName}` : 'Active employees in your locations'}>
      <Tabs<'none' | 'partial'>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'none', label: 'Not enrolled', count: noneQ.data?.total },
          { key: 'partial', label: 'One finger', count: partialQ.data?.total }
        ]}
      />
      <div className="mt-space-sm">
        {q.isLoading ? (
          <Loading label="Loading employees…" />
        ) : q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : !q.data || q.data.rows.length === 0 ? (
          <div className="flex items-center gap-2 py-space-sm text-body-sm text-on-surface-variant">
            <Icon name="check_circle" className="text-tertiary text-[18px]" />
            {tab === 'none' ? 'Every active employee has at least one fingerprint.' : 'No employee is missing a second finger.'}
          </div>
        ) : (
          <div className="space-y-1">
            {q.data.rows.map((e) => (
              <Link key={e.id} to={`/employees/${e.id}`} className="p-2 rounded bg-surface-container-lowest hover:bg-surface-container-high flex items-center justify-between gap-space-sm">
                <div className="min-w-0">
                  <span className="block text-body-sm text-on-surface font-semibold truncate">{e.full_name}</span>
                  <span className="block font-label-sm text-label-sm text-outline truncate">
                    {e.staff_number} · {e.location_name ?? 'Unassigned'}
                    {e.department ? ` · ${e.department}` : ''}
                  </span>
                </div>
                <Badge tone={e.fingers_enrolled === 0 ? 'error' : 'warning'} icon="fingerprint">
                  {e.fingers_enrolled}
                </Badge>
              </Link>
            ))}
            {q.data.total > q.data.rows.length && (
              <LinkButton to={`/employees?biometric=${tab}`} size="sm" variant="ghost" className="w-full mt-1">
                View all {num(q.data.total)}
              </LinkButton>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Supervisors({ q, locationId, locName }: { q: { data?: { rows: any[]; roleLabels: Record<string, string> }; isLoading: boolean; error: unknown; refetch: () => unknown }; locationId: string; locName?: string }) {
  const list = useMemo(() => {
    const rows = (q.data?.rows ?? []).filter((u) => ['branch_supervisor', 'manager', 'administrator'].includes(u.role));
    const scoped = locationId ? rows.filter((u) => u.role === 'administrator' || (u.locations ?? []).some((l: any) => l.id === locationId)) : rows;
    const ready = (u: any) => Boolean(u.has_supervisor_pin || u.supervisor_employee_id);
    const rank: Record<string, number> = { branch_supervisor: 0, manager: 1, administrator: 2 };
    return scoped.sort((a, b) => Number(ready(b)) - Number(ready(a)) || (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || a.full_name.localeCompare(b.full_name));
  }, [q.data, locationId]);
  const readyCount = list.filter((u) => u.has_supervisor_pin || u.supervisor_employee_id).length;
  return (
    <Panel
      title="Authorised supervisors"
      icon="shield_person"
      subtitle={locName ? `Can approve enrolment at ${locName}` : 'Supervisors, managers and administrators'}
      actions={q.data ? <Badge tone={readyCount ? 'success' : 'warning'}>{readyCount} ready</Badge> : undefined}
    >
      <p className="text-body-sm text-on-surface-variant mb-space-sm">
        On the terminal, a supervisor authorises enrolment with a PIN or with their own enrolled fingerprint (linked employee record). Users without either cannot authorise. Credentials are set in Users → user → Supervisor credentials and pushed to the devices of their locations.
      </p>
      {q.isLoading ? (
        <Loading label="Loading users…" />
      ) : q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
      ) : list.length === 0 ? (
        <Empty icon="person_off" title="No supervisors assigned." description={locName ? `No active supervisor or manager is assigned to ${locName}.` : undefined} />
      ) : (
        <div className="space-y-1">
          {list.map((u) => {
            const ready = u.has_supervisor_pin || u.supervisor_employee_id;
            return (
              <Link key={u.id} to={`/users/${u.id}`} className={clsx('p-2 rounded flex items-start justify-between gap-space-sm hover:bg-surface-container-high', ready ? 'bg-surface-container-lowest' : 'bg-warning-container/20')}>
                <div className="min-w-0">
                  <span className="block text-body-sm text-on-surface font-semibold truncate">{u.full_name}</span>
                  <span className="block font-label-sm text-label-sm text-outline truncate">
                    {q.data?.roleLabels?.[u.role] ?? u.role}
                    {u.role !== 'administrator' && (u.locations ?? []).length ? ` · ${(u.locations as any[]).map((l) => l.name).join(', ')}` : u.role === 'administrator' ? ' · all locations' : ''}
                  </span>
                  {!ready && <span className="block font-label-sm text-label-sm text-warning mt-0.5">No PIN or fingerprint — cannot authorise</span>}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge tone={u.has_supervisor_pin ? 'success' : 'neutral'} icon="pin">
                    {u.has_supervisor_pin ? 'PIN set' : 'No PIN'}
                  </Badge>
                  <Badge tone={u.supervisor_employee_id ? 'success' : 'neutral'} icon="fingerprint">
                    {u.supervisor_employee_id ? 'Linked' : 'No finger'}
                  </Badge>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {list.length > 0 && readyCount < list.length && (
        <div className="mt-space-sm">
          <Progress value={(readyCount / list.length) * 100} tone="success" />
          <span className="font-label-sm text-label-sm text-outline">
            {readyCount} of {list.length} can authorise enrolment
          </span>
        </div>
      )}
    </Panel>
  );
}
