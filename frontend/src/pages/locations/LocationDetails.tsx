import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  KV,
  LinkButton,
  Loading,
  PageHeader,
  Pagination,
  Panel,
  Progress,
  SearchInput,
  Select,
  Input,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  deliveryTone,
  deviceStatusLabel,
  deviceTone,
  severityTone,
  useDebounced
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLiveEvents, type LiveFrame } from '@/lib/live';
import { date, dateTime, humanize, num, pct, relative, time, todayIso } from '@/lib/format';
import { AlertRow, chartTheme, ExternalRefs, hhmm, localNow, LocationFormModal, locationStatusLabel, locationTone, OfflineDeviceCard, rate, workdaysLabel } from './components';

type TabKey = 'overview' | 'attendance' | 'employees' | 'devices' | 'analytics' | 'alerts';
const PAGE = 25;

export default function LocationDetails() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);

  const query = useQuery({
    queryKey: ['location', id],
    queryFn: () => api.get<{ location: any; devices: any[]; alerts: any[]; today: any; mappings: any[]; hourly: any[] }>(`/api/locations/${id}`),
    enabled: Boolean(id)
  });

  // Live refresh when something happens at this location (throttled).
  const last = useRef(0);
  const onFrame = (f: LiveFrame) => {
    const loc = f.data?.locationId ?? f.data?.location_id;
    if (loc && loc !== id) return;
    if (Date.now() - last.current < 2000) return;
    last.current = Date.now();
    void qc.invalidateQueries({ queryKey: ['location', id] });
  };
  useLiveEvents('attendance/event', onFrame);
  useLiveEvents('device/', onFrame);
  useLiveEvents('alert/', onFrame);

  const tabs = useMemo(() => {
    const t: { key: TabKey; label: string; icon: string; count?: number }[] = [{ key: 'overview', label: 'Overview', icon: 'dashboard' }];
    if (can('attendance.view')) t.push({ key: 'attendance', label: 'Attendance', icon: 'fact_check' });
    if (can('employees.view')) t.push({ key: 'employees', label: 'Employees', icon: 'badge', count: query.data?.location.active_employees });
    t.push({ key: 'devices', label: 'Devices', icon: 'router', count: query.data?.devices.length });
    if (can('reports.view')) t.push({ key: 'analytics', label: 'Analytics', icon: 'analytics' });
    if (can('alerts.view')) t.push({ key: 'alerts', label: 'Alerts', icon: 'notifications', count: query.data?.location.open_alerts });
    return t;
  }, [can, query.data]);

  const requested = (params.get('tab') as TabKey) || 'overview';
  const tab: TabKey = tabs.some((t) => t.key === requested) ? requested : 'overview';
  const setTab = (t: TabKey) => {
    const n = new URLSearchParams(params);
    if (t === 'overview') n.delete('tab');
    else n.set('tab', t);
    setParams(n, { replace: true });
  };

  if (query.isLoading) return <Loading label="Loading location…" />;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return null;

  const { location: l, devices, alerts, today, mappings, hourly } = query.data;
  const tone = locationTone(l);
  const present = today?.present ?? l.present_today ?? 0;
  const active = today?.active_employees ?? l.active_employees ?? 0;

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        icon="storefront"
        title={
          <span className="flex items-center gap-2">
            {l.name}
            {!l.is_active && <Badge tone="neutral">Inactive</Badge>}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono">{l.code}</span>
            <span className="text-outline">•</span>
            <span>
              {l.timezone} ({localNow(l.timezone)} local)
            </span>
            <span className="text-outline">•</span>
            <span>
              {hhmm(l.work_start)}–{hhmm(l.work_end)}, {workdaysLabel(l.workdays)}
            </span>
            <span className="text-outline">•</span>
            <span className="flex items-center gap-1">
              <Dot tone={tone} /> {locationStatusLabel(l)}
            </span>
          </span>
        }
        crumbs={[{ label: 'Locations', to: '/locations' }, { label: l.name }]}
        actions={
          <>
            {can('reports.view') && (
              <LinkButton to={`/reports?locationId=${l.id}`} icon="analytics">
                Reports
              </LinkButton>
            )}
            {can('locations.manage') && (
              <Button variant="primary" icon="edit" onClick={() => setEditOpen(true)}>
                Edit location
              </Button>
            )}
          </>
        }
      />

      {/* Key stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-space-sm">
        <Stat label="Active employees" icon="badge" value={num(active)} />
        <Stat label="Present today" icon="how_to_reg" tone="success" value={num(present)} hint={active ? `${pct(rate(present, active) ?? 0)} of active` : undefined} />
        <Stat label="Late" icon="schedule" tone={today?.late ? 'warning' : undefined} value={num(today?.late ?? l.late_today)} hint={`grace ${num(l.grace_minutes)} min`} />
        <Stat label="Absent" icon="person_off" tone={today?.absent ? 'error' : undefined} value={num(today?.absent)} hint="scheduled, no clock-in" />
        <Stat label="Devices online" icon="router" tone={l.offline_devices ? 'warning' : 'success'} value={`${num(l.online_devices)}/${num(l.devices)}`} hint={`${num(l.offline_devices)} offline`} />
        <Stat label="Open alerts" icon="notifications_active" tone={l.open_alerts ? 'error' : undefined} value={num(l.open_alerts)} />
        <Stat label="Buffered events" icon="inventory" tone={l.buffered_events ? 'info' : undefined} value={num(l.buffered_events)} hint="on devices" />
      </div>

      <Tabs<TabKey> tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && <Overview l={l} devices={devices} alerts={alerts} today={today} mappings={mappings} hourly={hourly} onTab={setTab} />}
      {tab === 'attendance' && <AttendanceTab l={l} />}
      {tab === 'employees' && <EmployeesTab l={l} />}
      {tab === 'devices' && <DevicesTab l={l} devices={devices} />}
      {tab === 'analytics' && <AnalyticsTab l={l} />}
      {tab === 'alerts' && <AlertsTab l={l} />}

      <LocationFormModal open={editOpen} onClose={() => setEditOpen(false)} location={l} />
    </div>
  );
}

// ───────────────────────── Overview ─────────────────────────
function Overview({ l, devices, alerts, today, mappings, hourly, onTab }: { l: any; devices: any[]; alerts: any[]; today: any; mappings: any[]; hourly: any[]; onTab: (t: TabKey) => void }) {
  const { can } = useAuth();
  const hours = useMemo(() => {
    const byHour = new Map<number, any>(hourly.map((h) => [Number(h.hour), h]));
    return Array.from({ length: 24 }, (_, h) => ({ hour: `${String(h).padStart(2, '0')}:00`, In: byHour.get(h)?.ins ?? 0, Out: byHour.get(h)?.outs ?? 0 }));
  }, [hourly]);
  const hasEvents = hours.some((h) => h.In || h.Out);
  const eligible = devices.filter((d) => ['connected', 'active'].includes(d.lifecycle_state));
  const offline = eligible.filter((d) => d.connectivity === 'offline');
  const others = devices.filter((d) => !offline.includes(d));
  const openAlerts = alerts.filter((a) => a.status !== 'resolved');

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md">
      <div className="xl:col-span-8 flex flex-col gap-space-md min-w-0">
        <Panel title="Today" icon="today" subtitle={`${date(new Date(), l.timezone)} · location time`}>
          {today ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-space-sm">
              <Stat label="Present" value={num(today.present)} tone="success" />
              <Stat label="Absent" value={num(today.absent)} tone={today.absent ? 'error' : undefined} />
              <Stat label="Late" value={num(today.late)} tone={today.late ? 'warning' : undefined} />
              <Stat label="Clocked in" value={num(today.clocked_in)} tone="info" />
              <Stat label="Clocked out" value={num(today.clocked_out)} />
              <Stat label="Total events" value={num(today.total_events)} />
            </div>
          ) : (
            <Empty icon="today" title="No summary available." description="Today's summary is only calculated for active locations." />
          )}
        </Panel>

        <Panel title="Clock-ins and clock-outs by hour" icon="bar_chart" subtitle="Today, in location time">
          {!hasEvents ? (
            <Empty icon="fingerprint" title="No attendance records found." description="No fingerprint events have been captured at this location today." />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hours} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeOpacity={0.4} />
                  <XAxis dataKey="hour" tick={chartTheme.tick} axisLine={false} tickLine={false} interval={2} />
                  <YAxis allowDecimals={false} tick={chartTheme.tick} axisLine={false} tickLine={false} />
                  <Tooltip {...chartTheme.tooltip} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#c3c6d7' }} />
                  <Bar dataKey="In" fill={chartTheme.colors.in} radius={[4, 4, 0, 0]} maxBarSize={12} />
                  <Bar dataKey="Out" fill={chartTheme.colors.out} radius={[4, 4, 0, 0]} maxBarSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="Devices"
          icon="router"
          subtitle={`${num(eligible.length - offline.length)} online · ${num(offline.length)} offline`}
          actions={
            <Button size="sm" variant="ghost" onClick={() => onTab('devices')}>
              All devices
            </Button>
          }
        >
          {!devices.length ? (
            <Empty
              icon="router"
              title="No devices at this location."
              action={
                can('devices.provision') ? (
                  <LinkButton to="/devices/provision" icon="add">
                    Provision device
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <div className="flex flex-col gap-space-sm">
              {offline.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
                  {offline.map((d) => (
                    <OfflineDeviceCard key={d.id} device={d} location={l} />
                  ))}
                </div>
              )}
              {others.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
                  {others.map((d) => (
                    <Link key={d.id} to={`/devices/${d.id}`} className="p-space-sm bg-surface-container rounded hover:bg-surface-container-high transition-colors flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Dot tone={deviceTone(d)} />
                          <span className="text-body-sm text-on-surface font-semibold truncate">{d.name}</span>
                        </div>
                        <div className="font-label-sm text-label-sm text-outline truncate">
                          {deviceStatusLabel(d)} · seen {relative(d.last_heartbeat_at)} · fw {d.firmware_version ?? '—'}
                        </div>
                      </div>
                      {d.pending_events > 0 && <Badge tone="info">{num(d.pending_events)} buffered</Badge>}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      <div className="xl:col-span-4 flex flex-col gap-space-md min-w-0">
        <Panel
          title="Recent alerts"
          icon="notifications"
          subtitle={`${num(openAlerts.length)} open`}
          actions={
            can('alerts.view') && (
              <Button size="sm" variant="ghost" onClick={() => onTab('alerts')}>
                View all
              </Button>
            )
          }
        >
          {!alerts.length ? (
            <Empty icon="notifications_off" title="No alerts." description="Nothing needs attention at this location." />
          ) : (
            <div className="flex flex-col gap-1.5">
              {alerts.slice(0, 6).map((a) => (
                <AlertRow key={a.id} a={a} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Web software mapping" icon="hub" subtitle="Location references received from the web software">
          {!mappings.length ? (
            <Empty
              icon="link_off"
              title="No mapped references."
              description="Employees from the web software are assigned here once their location reference is mapped to this location."
              action={
                can('integration.view') ? (
                  <LinkButton to="/integration/unmapped" size="sm" icon="link">
                    Unmapped locations
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {mappings.map((m) => (
                <div key={m.id} className="p-space-sm bg-surface-container rounded flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-body-sm text-on-surface truncate">{m.external_ref}</div>
                    <div className="font-label-sm text-label-sm text-outline truncate">
                      {m.external_name ?? 'No name'} · first seen {date(m.first_seen_at)}
                    </div>
                  </div>
                  <Badge tone={m.status === 'mapped' ? 'success' : m.status === 'ignored' ? 'neutral' : 'warning'}>{m.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Configuration" icon="tune">
          <KV label="Code" mono>
            {l.code}
          </KV>
          <KV label="Address">{l.address || '—'}</KV>
          <KV label="Timezone" mono>
            {l.timezone}
          </KV>
          <KV label="Working hours" mono>
            {hhmm(l.work_start)}–{hhmm(l.work_end)}
          </KV>
          <KV label="Grace period">{num(l.grace_minutes)} min</KV>
          <KV label="Workdays">{workdaysLabel(l.workdays)}</KV>
          <KV label="Status">{l.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</KV>
          <KV label="Created">{dateTime(l.created_at)}</KV>
          <KV label="Updated">{dateTime(l.updated_at)}</KV>
          <div className="pt-space-sm">
            <ExternalRefs refs={l.external_refs} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ───────────────────────── Attendance ─────────────────────────
function AttendanceTab({ l }: { l: any }) {
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState('');
  const [direction, setDirection] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const filters = { locationId: l.id, date: day || undefined, direction: direction || undefined, q: dq || undefined, limit: PAGE, offset };
  const query = useQuery({
    queryKey: ['attendance-events', filters],
    queryFn: () => api.get<any>('/api/attendance/events', filters),
    placeholderData: keepPreviousData
  });
  const historyLink = `/attendance/history?locationId=${l.id}${day ? `&date=${day}` : ''}`;

  return (
    <Panel
      title="Attendance events"
      icon="fact_check"
      subtitle="Times shown in location time"
      bodyClassName="px-0 pb-0"
      actions={
        <LinkButton size="sm" to={historyLink} icon="open_in_new">
          Open in Attendance History
        </LinkButton>
      }
    >
      <div className="flex flex-wrap items-center gap-space-sm px-space-md pb-space-sm">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setOffset(0);
          }}
          placeholder="Employee, staff no., device…"
          className="w-full sm:w-60"
        />
        <Input
          type="date"
          value={day}
          max={todayIso()}
          onChange={(e) => {
            setDay(e.target.value);
            setOffset(0);
          }}
          className="h-8 w-full sm:w-40"
        />
        <Select
          value={direction}
          onChange={(e) => {
            setDirection(e.target.value);
            setOffset(0);
          }}
          className="h-8 w-full sm:w-32"
        >
          <option value="">In & out</option>
          <option value="in">In</option>
          <option value="out">Out</option>
        </Select>
      </div>
      {query.isLoading ? (
        <Loading label="Loading attendance data..." />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data?.rows.length ? (
        <Empty icon="fingerprint" title="No attendance records found." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Captured</Th>
                <Th>Employee</Th>
                <Th>Direction</Th>
                <Th>Device</Th>
                <Th>Match</Th>
                <Th>Web delivery</Th>
              </tr>
            </THead>
            <tbody>
              {query.data.rows.map((e: any) => (
                <Tr key={e.id} onClick={() => nav(`/attendance/events/${e.id}`)}>
                  <Td>
                    <div className="font-mono text-on-surface">{time(e.captured_at, l.timezone)}</div>
                    <div className="font-label-sm text-label-sm text-outline">
                      {date(e.captured_at, l.timezone)}
                      {e.was_buffered && ' · buffered'}
                    </div>
                  </Td>
                  <Td>
                    <div className="text-on-surface font-semibold">{e.employee_name}</div>
                    <div className="font-label-sm text-label-sm text-outline font-mono">{e.staff_number}</div>
                  </Td>
                  <Td>
                    <Badge tone={e.direction === 'in' ? 'success' : 'info'} icon={e.direction === 'in' ? 'login' : 'logout'}>
                      {e.direction}
                    </Badge>
                  </Td>
                  <Td className="text-on-surface-variant">{e.device_name}</Td>
                  <Td className="font-mono text-on-surface-variant">{e.match_score ?? '—'}</Td>
                  <Td>
                    <Badge tone={deliveryTone(e.delivery_status)}>{e.delivery_status ? humanize(e.delivery_status) : 'Not queued'}</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination total={query.data.total} limit={PAGE} offset={offset} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ───────────────────────── Employees ─────────────────────────
function EmployeesTab({ l }: { l: any }) {
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [todayF, setTodayF] = useState('');
  const dq = useDebounced(q.trim());
  const filters = { locationId: l.id, q: dq || undefined, status: status || undefined, today: todayF || undefined, limit: PAGE, offset };
  const query = useQuery({
    queryKey: ['employees', filters],
    queryFn: () => api.get<any>('/api/employees', filters),
    placeholderData: keepPreviousData
  });

  return (
    <Panel
      title="Employees"
      icon="badge"
      subtitle="Synchronised from the web software"
      bodyClassName="px-0 pb-0"
      actions={
        <LinkButton size="sm" to={`/employees?locationId=${l.id}`} icon="open_in_new">
          Open in Employee Directory
        </LinkButton>
      }
    >
      <div className="flex flex-wrap items-center gap-space-sm px-space-md pb-space-sm">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v);
            setOffset(0);
          }}
          placeholder="Name, staff no., web ID…"
          className="w-full sm:w-60"
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
          className="h-8 w-full sm:w-36"
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
          <option value="terminated">Terminated</option>
        </Select>
        <Select
          value={todayF}
          onChange={(e) => {
            setTodayF(e.target.value);
            setOffset(0);
          }}
          className="h-8 w-full sm:w-40"
        >
          <option value="">Any today status</option>
          <option value="in">Clocked in</option>
          <option value="out">Clocked out</option>
          <option value="absent">No record today</option>
        </Select>
      </div>
      {query.isLoading ? (
        <Loading label="Loading employees…" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data?.rows.length ? (
        <Empty icon="group_off" title="No employees found." description="Employees are assigned to this location by the web software sync." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Employee</Th>
                <Th>Department</Th>
                <Th>Status</Th>
                <Th>Fingerprints</Th>
                <Th>Today</Th>
              </tr>
            </THead>
            <tbody>
              {query.data.rows.map((e: any) => (
                <Tr key={e.id} onClick={() => nav(`/employees/${e.id}`)}>
                  <Td>
                    <div className="text-on-surface font-semibold">{e.full_name}</div>
                    <div className="font-label-sm text-label-sm text-outline font-mono">{e.staff_number}</div>
                  </Td>
                  <Td className="text-on-surface-variant">{e.department ?? '—'}</Td>
                  <Td>
                    <Badge tone={e.employment_status === 'active' ? 'success' : 'neutral'}>{e.employment_status}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={e.fingers_enrolled >= 2 ? 'success' : e.fingers_enrolled === 1 ? 'warning' : 'error'} icon="fingerprint">
                      {e.fingers_enrolled >= 2 ? `${e.fingers_enrolled} enrolled` : e.fingers_enrolled === 1 ? 'Partial' : 'Not enrolled'}
                    </Badge>
                  </Td>
                  <Td>
                    {e.today_last_direction ? (
                      <div>
                        <span className={clsx('font-label-sm text-label-sm font-semibold', e.today_last_direction === 'in' ? 'text-tertiary' : 'text-secondary')}>
                          {e.today_last_direction === 'in' ? 'Clocked in' : 'Clocked out'}
                        </span>
                        <span className="font-label-sm text-label-sm text-outline"> · {time(e.today_last_at, l.timezone, false)}</span>
                        {e.today_late && (
                          <Badge tone="warning" className="ml-1">
                            Late
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-outline">No record</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination total={query.data.total} limit={PAGE} offset={offset} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ───────────────────────── Devices ─────────────────────────
function DevicesTab({ l, devices }: { l: any; devices: any[] }) {
  const nav = useNavigate();
  const { can } = useAuth();
  return (
    <Panel
      title="Devices"
      icon="router"
      subtitle={`${num(devices.length)} registered at this location`}
      bodyClassName="px-0 pb-0"
      actions={
        <LinkButton size="sm" to={`/devices?locationId=${l.id}`} icon="open_in_new">
          Open in Device Registry
        </LinkButton>
      }
    >
      {!devices.length ? (
        <Empty icon="router" title="No devices at this location." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Device</Th>
              <Th>Status</Th>
              <Th>Last seen</Th>
              <Th>Firmware</Th>
              <Th>Buffered</Th>
              <Th>Storage</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </THead>
          <tbody>
            {devices.map((d) => {
              const storage = d.storage_used_pct === null || d.storage_used_pct === undefined ? null : Number(d.storage_used_pct);
              return (
                <Tr key={d.id} onClick={() => nav(`/devices/${d.id}`)}>
                  <Td>
                    <div className="text-on-surface font-semibold">{d.name}</div>
                    <div className="font-label-sm text-label-sm text-outline font-mono">{d.device_uid}</div>
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <Dot tone={deviceTone(d)} pulse={deviceTone(d) === 'error'} />
                      <span className="text-on-surface-variant">{deviceStatusLabel(d)}</span>
                    </span>
                  </Td>
                  <Td className="text-on-surface-variant" >
                    <span title={dateTime(d.last_heartbeat_at)}>{relative(d.last_heartbeat_at)}</span>
                  </Td>
                  <Td className="font-mono text-on-surface">{d.firmware_version ?? '—'}</Td>
                  <Td className={clsx('font-mono', d.pending_events ? 'text-secondary' : 'text-outline')}>{num(d.pending_events)}</Td>
                  <Td className="min-w-[110px]">
                    {storage === null ? (
                      <span className="text-outline">—</span>
                    ) : (
                      <>
                        <div className="font-label-sm text-label-sm text-on-surface-variant">{pct(storage, 0)}</div>
                        <Progress value={storage} tone={storage >= 90 ? 'error' : storage >= 75 ? 'warning' : 'success'} />
                      </>
                    )}
                  </Td>
                  <Td className="text-right">
                    {can('firmware.manage') && ['connected', 'active'].includes(d.lifecycle_state) && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <LinkButton size="sm" variant="ghost" icon="system_update" to={`/firmware/deploy?deviceId=${d.id}`}>
                          Update firmware
                        </LinkButton>
                      </span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

// ───────────────────────── Analytics ─────────────────────────
function AnalyticsTab({ l }: { l: any }) {
  const from = todayIso(-29);
  const to = todayIso();
  const query = useQuery({
    queryKey: ['reports', 'analytics', { locationId: l.id, from, to }],
    queryFn: () => api.get<any>('/api/reports/analytics', { locationId: l.id, from, to })
  });

  const daily = useMemo(
    () =>
      (query.data?.daily ?? []).map((d: any) => ({
        period: String(d.period).slice(0, 10),
        rate: d.attendance_rate === null ? null : Number(d.attendance_rate),
        Late: d.late,
        Absent: d.absent,
        present: d.present,
        expected: d.expected
      })),
    [query.data]
  );

  const topLate = useMemo(() => {
    const m = new Map<string, { name: string; staff: string; count: number; minutes: number }>();
    for (const r of query.data?.late ?? []) {
      const k = `${r.staff_number}|${r.full_name}`;
      const cur = m.get(k) ?? { name: r.full_name, staff: r.staff_number, count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += Number(r.minutes_late ?? 0);
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || b.minutes - a.minutes).slice(0, 10);
  }, [query.data]);

  const topAbsent = useMemo(
    () =>
      [...(query.data?.employees ?? [])]
        .filter((e: any) => e.days_absent > 0)
        .sort((a: any, b: any) => b.days_absent - a.days_absent)
        .slice(0, 10),
    [query.data]
  );

  if (query.isLoading) return <Loading label="Loading analytics…" />;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const s = query.data?.summary ?? {};

  return (
    <div className="flex flex-col gap-space-md">
      <div className="flex flex-wrap items-center justify-between gap-space-sm">
        <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">
          Last 30 days · {date(from)} – {date(to)} · scheduled workdays only
        </span>
        <LinkButton size="sm" to={`/reports?locationId=${l.id}&from=${from}&to=${to}`} icon="open_in_new">
          Open full report
        </LinkButton>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-space-sm">
        <Stat label="Attendance rate" icon="percent" tone="success" value={s.attendance_rate === null || s.attendance_rate === undefined ? '—' : pct(s.attendance_rate)} />
        <Stat label="Present days" icon="how_to_reg" value={num(s.present)} hint={`of ${num(s.expected)} expected`} />
        <Stat label="Late arrivals" icon="schedule" tone={s.late ? 'warning' : undefined} value={num(s.late)} hint={s.avg_minutes_late ? `avg ${num(s.avg_minutes_late)} min late` : undefined} />
        <Stat label="Absences" icon="person_off" tone={s.absent ? 'error' : undefined} value={num(s.absent)} />
        <Stat label="Employees" icon="badge" value={num(s.employees)} />
      </div>

      {!daily.length ? (
        <Panel>
          <Empty icon="analytics" title="No attendance records found." description="There were no scheduled workdays with active employees in this period." />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-md">
          <Panel title="Daily attendance rate" icon="show_chart" subtitle="Present ÷ expected, per workday">
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <defs>
                    <linearGradient id="locRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chartTheme.colors.rate} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={chartTheme.colors.rate} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeOpacity={0.4} />
                  <XAxis dataKey="period" tick={chartTheme.tick} axisLine={false} tickLine={false} tickFormatter={(v: string) => v.slice(5)} minTickGap={16} />
                  <YAxis domain={[0, 100]} tick={chartTheme.tick} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip {...chartTheme.tooltip} cursor={{ stroke: '#8d90a0', strokeDasharray: '3 3' }} formatter={(v: any, _n: any, item: any) => [`${pct(v)} (${num(item?.payload?.present)}/${num(item?.payload?.expected)})`, 'Attendance']} />
                  <Area type="monotone" dataKey="rate" stroke={chartTheme.colors.rate} strokeWidth={2} fill="url(#locRate)" dot={false} activeDot={{ r: 4 }} connectNulls />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel title="Late arrivals and absences" icon="bar_chart" subtitle="Per workday">
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeOpacity={0.4} />
                  <XAxis dataKey="period" tick={chartTheme.tick} axisLine={false} tickLine={false} tickFormatter={(v: string) => v.slice(5)} minTickGap={16} />
                  <YAxis allowDecimals={false} tick={chartTheme.tick} axisLine={false} tickLine={false} />
                  <Tooltip {...chartTheme.tooltip} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#c3c6d7' }} />
                  <Bar dataKey="Late" fill={chartTheme.colors.late} radius={[4, 4, 0, 0]} maxBarSize={10} />
                  <Bar dataKey="Absent" fill={chartTheme.colors.absent} radius={[4, 4, 0, 0]} maxBarSize={10} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-md">
        <Panel title="Most late arrivals" icon="schedule" bodyClassName="px-0 pb-0">
          {!topLate.length ? (
            <Empty icon="task_alt" title="No late arrivals in this period." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Employee</Th>
                  <Th className="text-right">Late days</Th>
                  <Th className="text-right">Total minutes</Th>
                </tr>
              </THead>
              <tbody>
                {topLate.map((r) => (
                  <Tr key={`${r.staff}|${r.name}`}>
                    <Td>
                      <div className="text-on-surface font-semibold">{r.name}</div>
                      <div className="font-label-sm text-label-sm text-outline font-mono">{r.staff}</div>
                    </Td>
                    <Td className="text-right font-mono text-warning">{num(r.count)}</Td>
                    <Td className="text-right font-mono text-on-surface-variant">{num(r.minutes)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        <Panel title="Most absences" icon="person_off" bodyClassName="px-0 pb-0">
          {!topAbsent.length ? (
            <Empty icon="task_alt" title="No absences in this period." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Employee</Th>
                  <Th className="text-right">Absent</Th>
                  <Th className="text-right">Attendance</Th>
                </tr>
              </THead>
              <tbody>
                {topAbsent.map((e: any) => (
                  <Tr key={e.employee_id}>
                    <Td>
                      <Link to={`/employees/${e.employee_id}`} className="text-on-surface font-semibold hover:text-primary">
                        {e.full_name}
                      </Link>
                      <div className="font-label-sm text-label-sm text-outline font-mono">
                        {e.staff_number}
                        {e.department ? ` · ${e.department}` : ''}
                      </div>
                    </Td>
                    <Td className="text-right font-mono text-error">
                      {num(e.days_absent)} / {num(e.scheduled_days)}
                    </Td>
                    <Td className="text-right font-mono text-on-surface-variant">{pct(e.attendance_rate)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ───────────────────────── Alerts ─────────────────────────
function AlertsTab({ l }: { l: any }) {
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('active');
  const filters = { locationId: l.id, status: status || undefined, limit: PAGE, offset };
  const query = useQuery({
    queryKey: ['alerts', filters],
    queryFn: () => api.get<any>('/api/alerts', filters),
    placeholderData: keepPreviousData
  });

  return (
    <Panel
      title="Alerts"
      icon="notifications"
      bodyClassName="px-0 pb-0"
      actions={
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
          className="h-8 w-40"
        >
          <option value="active">Open & acknowledged</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </Select>
      }
    >
      {query.isLoading ? (
        <Loading label="Loading alerts…" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data?.rows.length ? (
        <Empty icon="notifications_off" title="No alerts found." description="Nothing needs attention at this location." />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Alert</Th>
                <Th>Severity</Th>
                <Th>Device</Th>
                <Th>Status</Th>
                <Th>Last occurred</Th>
              </tr>
            </THead>
            <tbody>
              {query.data.rows.map((a: any) => (
                <Tr key={a.id} onClick={() => nav(`/alerts/${a.id}`)}>
                  <Td>
                    <div className="text-on-surface font-semibold">{a.title}</div>
                    <div className="font-body-sm text-[11px] text-on-surface-variant line-clamp-1 max-w-xl">{a.description}</div>
                  </Td>
                  <Td>
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                  </Td>
                  <Td className="text-on-surface-variant">{a.device_name ?? '—'}</Td>
                  <Td>
                    <Badge tone={a.status === 'resolved' ? 'success' : a.status === 'acknowledged' ? 'info' : 'warning'}>{a.status}</Badge>
                  </Td>
                  <Td>
                    <div className="text-on-surface-variant">{relative(a.last_occurred_at)}</div>
                    {a.occurrences > 1 && <div className="font-label-sm text-label-sm text-outline">{num(a.occurrences)} occurrences</div>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination total={query.data.total} limit={PAGE} offset={offset} onChange={setOffset} />
        </>
      )}
    </Panel>
  );
}
