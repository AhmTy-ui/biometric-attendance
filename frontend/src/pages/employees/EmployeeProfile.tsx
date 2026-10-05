import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  KV,
  Loading,
  PageHeader,
  Panel,
  PermissionDenied,
  Progress,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  type Tone
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, FINGERS, humanize, num, relative, time, todayIso } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import {
  addDays,
  BiometricBadge,
  biometricLabel,
  biometricState,
  biometricTone,
  calendarDate,
  EmploymentBadge,
  LocationCell,
  minutesToHours,
  REQUIRED_FINGERS,
  TodayStatus
} from './components';

type TabKey = 'profile' | 'attendance' | 'biometric' | 'sync';

interface ProfileData {
  employee: any;
  templates: any[];
  devices: any[];
  recent: any[];
  enrolments: any[];
  stats30: any;
  audits: any[];
}

const sessionTone = (s?: string): Tone =>
  s === 'completed' ? 'success' : s === 'started' || s === 'finger_captured' ? 'info' : s === 'aborted' ? 'neutral' : 'error';

export default function EmployeeProfile() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as TabKey) || 'profile';
  const setTab = (t: TabKey) => {
    const n = new URLSearchParams(sp);
    if (t === 'profile') n.delete('tab');
    else n.set('tab', t);
    setSp(n, { replace: true });
  };
  const [liveAt, setLiveAt] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['employee', id],
    queryFn: () => api.get<ProfileData>(`/api/employees/${id}`),
    enabled: Boolean(id)
  });

  // Live refresh when this employee's biometrics change or they clock in/out.
  useLiveEvents('employee/biometric', (f) => {
    if (f.data?.employeeId === id) {
      setLiveAt(f.at);
      void qc.invalidateQueries({ queryKey: ['employee', id] });
    }
  });
  useLiveEvents('enrolment/session', (f) => {
    if (f.data?.employee_id === id) void qc.invalidateQueries({ queryKey: ['employee', id] });
  });
  useLiveEvents('attendance/event', (f) => {
    if (f.data?.employee_id === id) {
      setLiveAt(f.at);
      void qc.invalidateQueries({ queryKey: ['employee', id] });
    }
  });

  if (q.isLoading) return <Loading label="Loading employee..." />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return null;

  const { employee: e, templates, devices, enrolments } = q.data;
  const active = e.employment_status === 'active';
  const bState = biometricState(e.fingers_enrolled);

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        crumbs={[{ label: 'Employees', to: '/employees' }, { label: e.full_name }]}
        title="Employee Profile"
        subtitle="Read-only mirror of the web software record, with fingerprint enrolment and device propagation status."
        actions={
          <>
            {liveAt && (
              <span className="flex items-center gap-1.5 font-label-sm text-label-sm text-outline">
                <Dot tone="success" pulse /> Live · updated {relative(liveAt)}
              </span>
            )}
            <Button icon="refresh" loading={q.isFetching} onClick={() => q.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {/* Identity header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md bg-surface-container-lowest p-space-md rounded">
        <div className="flex items-start sm:items-center gap-space-md min-w-0">
          <div className="relative shrink-0">
            <Avatar name={e.full_name} size={14} tone={active ? 'primary' : 'neutral'} />
            <span className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-surface-container-lowest flex items-center justify-center">
              <Icon name={bState === 'enrolled' ? 'verified_user' : 'fingerprint'} className={clsx('text-[14px]', bState === 'enrolled' ? 'text-tertiary' : bState === 'partial' ? 'text-warning' : 'text-error')} />
            </span>
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex flex-wrap items-center gap-x-space-sm gap-y-1">
              <h2 className="font-headline-lg text-headline-lg text-on-surface tracking-tight truncate">{e.full_name}</h2>
              <EmploymentBadge status={e.employment_status} />
              <BiometricBadge fingers={e.fingers_enrolled} />
            </div>
            <div className="flex flex-wrap items-center gap-x-space-md gap-y-1 mt-1 font-body-sm text-body-sm text-on-surface-variant">
              <span>Dept: {e.department ?? '—'}</span>
              <span className="text-outline">•</span>
              <span className="font-label-sm text-label-sm text-outline font-mono">{e.staff_number}</span>
              <span className="text-outline">•</span>
              <span className="font-label-sm text-label-sm text-secondary bg-surface-container-low px-1.5 rounded font-mono">REF: {e.web_reference_id}</span>
              <span className="text-outline">•</span>
              <span>{e.location_name ?? 'Unassigned'}</span>
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <TodayStatus e={e} detailed />
        </div>
      </div>

      {/* Lifecycle banners */}
      {!active && (
        <div className="flex items-start gap-space-sm p-space-sm bg-error-container/20 border border-error/30 rounded">
          <Icon name="person_off" className="text-error text-[20px] shrink-0" />
          <div className="font-body-sm text-body-sm text-on-surface-variant">
            <span className="font-semibold text-on-surface">This employee is {humanize(e.employment_status).toLowerCase()} in the web software.</span> They have been removed from
            device rosters and their fingerprint templates purged from devices and escrow, so they can no longer clock in. Historical attendance records are retained.
          </div>
        </div>
      )}
      {active && !e.location_id && (
        <div className="flex items-start gap-space-sm p-space-sm bg-warning-container/30 border border-warning/30 rounded">
          <Icon name="link_off" className="text-warning text-[20px] shrink-0" />
          <div className="flex-1 font-body-sm text-body-sm text-on-surface-variant">
            <span className="font-semibold text-on-surface">Not assigned to a location.</span>{' '}
            {e.external_location_ref ? (
              <>
                The web software assigns this employee to location reference <code className="font-mono text-warning">{e.external_location_ref}</code>, which is not
                mapped to a platform location. They are not on any device roster until it is mapped.
              </>
            ) : (
              <>The web software record has no location, so the employee is not on any device roster.</>
            )}
          </div>
          {e.external_location_ref && can('integration.view') && (
            <Link to="/integration/unmapped" className="font-label-md text-label-md text-primary hover:underline shrink-0">
              Resolve mapping
            </Link>
          )}
        </div>
      )}

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'profile', label: 'Profile', icon: 'person' },
          { key: 'attendance', label: 'Attendance', icon: 'event_available' },
          { key: 'biometric', label: 'Biometric Status', icon: 'fingerprint', count: templates.length },
          { key: 'sync', label: 'Sync Status', icon: 'cloud_sync', count: devices.length }
        ]}
      />

      {tab === 'profile' && <ProfileTab d={q.data} />}
      {tab === 'attendance' && (can('attendance.view') ? <AttendanceTab id={id} /> : <PermissionDenied />)}
      {tab === 'biometric' && <BiometricTab e={e} templates={templates} enrolments={enrolments} />}
      {tab === 'sync' && <SyncTab e={e} devices={devices} />}
    </div>
  );
}

// ───────────────────────── Profile ─────────────────────────
function ProfileTab({ d }: { d: ProfileData }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { employee: e, stats30, recent, audits } = d;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
      <div className="lg:col-span-4 flex flex-col gap-space-md">
        <Panel title="Identity" icon="badge" actions={<span className="font-label-sm text-label-sm text-outline uppercase font-semibold">Read-only</span>}>
          <KV label="Full name">{e.full_name}</KV>
          <KV label="Staff number" mono>
            {e.staff_number}
          </KV>
          <KV label="Web reference ID" mono>
            {e.web_reference_id}
          </KV>
          <KV label="Department">{e.department ?? '—'}</KV>
          <KV label="Employment status">
            <EmploymentBadge status={e.employment_status} />
          </KV>
          <div className="mt-space-sm p-2 bg-surface-container rounded text-[11px] text-outline">
            Changes to employee details must be made in the web software and synchronised.
          </div>
        </Panel>
        <Panel title="Assignment" icon="storefront">
          <KV label="Assigned location">
            <LocationCell e={e} linkable={can('locations.view') || !e.location_id} />
          </KV>
          <KV label="Web location ref" mono>
            {e.external_location_ref ?? '—'}
          </KV>
          <KV label="Today">
            <TodayStatus e={e} detailed />
          </KV>
        </Panel>
      </div>

      <div className="lg:col-span-8 flex flex-col gap-space-md">
        <Panel title="Last 30 days" icon="insights">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
            <Stat label="Days present" value={num(stats30?.days_present)} icon="event_available" tone="success" />
            <Stat label="Late days" value={num(stats30?.late_days)} icon="schedule" tone={stats30?.late_days ? 'warning' : undefined} />
            <Stat label="Avg hours / day" value={stats30?.avg_hours === null || stats30?.avg_hours === undefined ? '—' : `${stats30.avg_hours}h`} icon="timelapse" />
            <Stat label="Avg match score" value={stats30?.avg_match === null || stats30?.avg_match === undefined ? '—' : num(stats30.avg_match)} icon="fingerprint" />
          </div>
        </Panel>

        <Panel title="Recent clock events" icon="history" subtitle="Last 25 fingerprint verifications">
          {recent.length === 0 ? (
            <Empty title="No attendance records found." icon="event_busy" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Captured</Th>
                  <Th>Direction</Th>
                  <Th>Location · Device</Th>
                  <Th>Match</Th>
                  <Th>Web delivery</Th>
                </tr>
              </THead>
              <tbody>
                {recent.map((ev) => (
                  <Tr key={ev.id} onClick={can('attendance.view') ? () => nav(`/attendance/events/${ev.id}`) : undefined}>
                    <Td className="whitespace-nowrap font-mono text-[11px]">{dateTime(ev.captured_at, ev.location_timezone)}</Td>
                    <Td>
                      <DirectionBadge d={ev.direction} buffered={ev.was_buffered} />
                    </Td>
                    <Td>
                      <span className="text-on-surface">{ev.location_name}</span>
                      <span className="text-outline"> · {ev.device_name}</span>
                    </Td>
                    <Td className="font-mono">{num(ev.match_score)}</Td>
                    <Td>
                      <DeliveryBadge s={ev.delivery_status} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Recent activity" icon="receipt_long" subtitle="Audit trail for this employee">
          {audits.length === 0 ? (
            <Empty title="No audit entries." icon="receipt_long" />
          ) : (
            <ul className="flex flex-col">
              {audits.map((a) => (
                <li key={a.seq} className="flex items-center justify-between gap-space-sm py-1.5 border-b border-outline-variant/15 last:border-0 text-body-sm">
                  <div className="min-w-0">
                    <span className="text-on-surface">{humanize(a.action)}</span>
                    <span className="text-outline"> · {a.actor_name ?? 'System'}</span>
                  </div>
                  <div className="flex items-center gap-space-sm shrink-0">
                    <span className="font-label-sm text-label-sm text-outline">{dateTime(a.occurred_at)}</span>
                    {can('audit.view') && (
                      <Link to={`/audit/${a.seq}`} className="text-primary hover:underline font-label-sm text-label-sm">
                        #{a.seq}
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function DirectionBadge({ d, buffered }: { d: string; buffered?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={d === 'in' ? 'success' : 'info'} icon={d === 'in' ? 'login' : 'logout'}>
        {d === 'in' ? 'IN' : 'OUT'}
      </Badge>
      {buffered && (
        <span title="Captured offline and uploaded later">
          <Icon name="cloud_upload" className="text-[14px] text-outline" />
        </span>
      )}
    </span>
  );
}

function DeliveryBadge({ s }: { s?: string | null }) {
  const tone: Tone = s === 'delivered' || s === 'exported' ? 'success' : s === 'dead_letter' ? 'error' : s === 'retrying' ? 'warning' : s ? 'info' : 'neutral';
  return <Badge tone={tone}>{s ? humanize(s) : 'Not queued'}</Badge>;
}

// ───────────────────────── Attendance ─────────────────────────
function AttendanceTab({ id }: { id: string }) {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const from = sp.get('from') ?? todayIso(-29);
  const to = sp.get('to') ?? todayIso();
  const setRange = (f: string, t: string) => {
    const n = new URLSearchParams(sp);
    n.set('from', f);
    n.set('to', t);
    setSp(n, { replace: true });
  };
  const [eventsShown, setEventsShown] = useState(100);

  const q = useQuery({
    queryKey: ['employee', id, 'attendance', from, to],
    queryFn: () => api.get<{ from: string; to: string; daily: any[]; events: any[] }>(`/api/employees/${id}/attendance`, { from, to }),
    enabled: from <= to
  });

  const tzByLocation = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of q.data?.events ?? []) if (ev.location_id && ev.location_timezone) m.set(ev.location_id, ev.location_timezone);
    return m;
  }, [q.data]);

  const strip = useMemo(() => {
    if (!q.data) return [];
    const byDate = new Map<string, any>();
    for (const d of q.data.daily) {
      const k = String(d.work_date).slice(0, 10);
      const prev = byDate.get(k);
      // Multiple locations on one day: keep late if any.
      byDate.set(k, prev ? { ...prev, is_late: prev.is_late || d.is_late } : d);
    }
    const out: { date: string; rec: any }[] = [];
    let cur = q.data.from;
    let guard = 0;
    while (cur <= q.data.to && guard < 400) {
      out.push({ date: cur, rec: byDate.get(cur) });
      cur = addDays(cur, 1);
      guard++;
    }
    return out;
  }, [q.data]);

  const presets: [string, number][] = [
    ['7 days', 6],
    ['30 days', 29],
    ['90 days', 89]
  ];

  return (
    <div className="flex flex-col gap-space-md">
      <div className="p-space-sm rounded bg-surface-container-low flex flex-wrap items-end gap-space-sm shadow-sm">
        <Field label="From">
          <Input type="date" value={from} max={to} onChange={(ev) => ev.target.value && setRange(ev.target.value, to)} className="h-8" />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from} max={todayIso()} onChange={(ev) => ev.target.value && setRange(from, ev.target.value)} className="h-8" />
        </Field>
        <div className="flex items-center gap-1">
          {presets.map(([l, n]) => (
            <Button key={l} size="sm" variant={from === todayIso(-n) && to === todayIso() ? 'subtle' : 'ghost'} onClick={() => setRange(todayIso(-n), todayIso())}>
              {l}
            </Button>
          ))}
        </div>
      </div>

      {from > to ? (
        <ErrorState error={{ message: '"From" must be on or before "To".' }} compact />
      ) : q.isLoading ? (
        <Loading label="Loading attendance data..." />
      ) : q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data ? null : (
        <>
          <Panel title="Attendance calendar" icon="calendar_month" subtitle={`${calendarDate(q.data.from)} – ${calendarDate(q.data.to)}`}>
            <div className="flex flex-wrap gap-1">
              {strip.map(({ date, rec }) => (
                <div
                  key={date}
                  title={`${calendarDate(date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}: ${
                    rec ? `${rec.is_late ? `Late (${rec.minutes_late} min)` : 'Present'} · in ${time(rec.first_in, tzByLocation.get(rec.location_id), false)}` : 'No attendance'
                  }`}
                  className={clsx(
                    'w-5 h-5 rounded-sm flex items-center justify-center font-mono text-[9px]',
                    rec ? (rec.is_late ? 'bg-warning/70 text-on-tertiary' : 'bg-tertiary/80 text-on-tertiary') : 'bg-surface-container-highest text-outline'
                  )}
                >
                  {Number(date.slice(8, 10))}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-space-md mt-space-sm font-label-sm text-label-sm text-outline">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-tertiary/80" /> Present on time
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-warning/70" /> Late
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-surface-container-highest" /> No attendance (includes non-working days)
              </span>
            </div>
          </Panel>

          <Panel title="Daily attendance" icon="table_rows" subtitle={`${q.data.daily.length} day records`}>
            {q.data.daily.length === 0 ? (
              <Empty title="No attendance records found." icon="event_busy" description="No clock events were recorded in this period." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Location</Th>
                    <Th>First in</Th>
                    <Th>Last out</Th>
                    <Th>Late</Th>
                    <Th>Worked</Th>
                    <Th>Events</Th>
                  </tr>
                </THead>
                <tbody>
                  {q.data.daily.map((d) => {
                    const tz = tzByLocation.get(d.location_id);
                    return (
                      <Tr key={`${d.work_date}-${d.location_id}`}>
                        <Td className="whitespace-nowrap">{calendarDate(String(d.work_date), { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</Td>
                        <Td>{d.location_name}</Td>
                        <Td className="font-mono">{time(d.first_in, tz, false)}</Td>
                        <Td className="font-mono">{time(d.last_out, tz, false)}</Td>
                        <Td>{d.is_late ? <Badge tone="warning">{d.minutes_late} min</Badge> : <span className="text-outline">On time</span>}</Td>
                        <Td className="font-mono">{minutesToHours(d.worked_minutes)}</Td>
                        <Td className="font-mono">{num(d.event_count)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title="Clock events" icon="fingerprint" subtitle={`${num(q.data.events.length)} events${q.data.events.length >= 2000 ? ' (limited to the latest 2,000)' : ''}`}>
            {q.data.events.length === 0 ? (
              <Empty title="No attendance records found." icon="event_busy" />
            ) : (
              <>
                <Table>
                  <THead>
                    <tr>
                      <Th>Captured</Th>
                      <Th>Direction</Th>
                      <Th>Location · Device</Th>
                      <Th>Finger</Th>
                      <Th>Match</Th>
                      <Th>Web delivery</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {q.data.events.slice(0, eventsShown).map((ev) => (
                      <Tr key={ev.id} onClick={() => nav(`/attendance/events/${ev.id}`)}>
                        <Td className="whitespace-nowrap font-mono text-[11px]">{dateTime(ev.captured_at, ev.location_timezone)}</Td>
                        <Td>
                          <DirectionBadge d={ev.direction} buffered={ev.was_buffered} />
                        </Td>
                        <Td>
                          <span className="text-on-surface">{ev.location_name}</span>
                          <span className="text-outline"> · {ev.device_name}</span>
                        </Td>
                        <Td>{ev.finger_index ? FINGERS[ev.finger_index] : '—'}</Td>
                        <Td className="font-mono">{num(ev.match_score)}</Td>
                        <Td>
                          <DeliveryBadge s={ev.delivery_status} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                {q.data.events.length > eventsShown && (
                  <div className="flex justify-center pt-space-sm">
                    <Button size="sm" onClick={() => setEventsShown((n) => n + 100)}>
                      Show more ({num(q.data.events.length - eventsShown)} remaining)
                    </Button>
                  </div>
                )}
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

// ───────────────────────── Biometric status ─────────────────────────
function FingerprintGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2C6.48 2 2 6.48 2 12c0 2.85 1.2 5.41 3.12 7.24" />
      <path d="M12 6c-3.31 0-6 2.69-6 6 0 1.66.67 3.16 1.76 4.24" />
      <path d="M12 10c-1.1 0-2 .9-2 2 0 .55.22 1.05.59 1.41" />
      <path d="M15.54 17.54C14.54 18.45 13.33 19 12 19c-3.87 0-7-3.13-7-7" />
      <path d="M19 12c0-3.87-3.13-7-7-7" />
      <path d="M21.9 14.5C21.4 8.7 16.7 4 11 4" />
    </svg>
  );
}

function BiometricTab({ e, templates, enrolments }: { e: any; templates: any[]; enrolments: any[] }) {
  const { can } = useAuth();
  const n = templates.length;
  const s = biometricState(n);
  const active = e.employment_status === 'active';
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
      <div className="lg:col-span-5 flex flex-col gap-space-md">
        <Panel title="Enrolment status" icon="fingerprint" accent={biometricTone(s)}>
          <div className="flex items-baseline justify-between">
            <span className={clsx('font-headline-md text-headline-md', s === 'enrolled' ? 'text-tertiary' : s === 'partial' ? 'text-warning' : 'text-error')}>{biometricLabel(s)}</span>
            <span className="font-mono text-headline-md text-on-surface">
              {n}
              <span className="text-on-surface-variant text-body-md">/{REQUIRED_FINGERS} fingers</span>
            </span>
          </div>
          <Progress value={(Math.min(n, REQUIRED_FINGERS) / REQUIRED_FINGERS) * 100} tone={biometricTone(s)} className="mt-space-sm" />
          <p className="mt-space-sm font-body-sm text-body-sm text-on-surface-variant">
            {!active
              ? 'Templates are purged when an employee leaves active employment.'
              : s === 'enrolled'
                ? 'The employee can verify on every device at their assigned location.'
                : s === 'partial'
                  ? `One more finger is required to complete enrolment (${REQUIRED_FINGERS} required).`
                  : 'The employee has no enrolled fingerprints and cannot clock in yet.'}
          </p>
          {e.last_enrolled_at && <p className="mt-1 font-label-sm text-label-sm text-outline">Last enrolled {dateTime(e.last_enrolled_at)}</p>}
        </Panel>

        <div className="p-space-sm rounded bg-surface-container-lowest border border-outline-variant/30 flex items-start gap-space-sm">
          <Icon name="shield_person" className="text-secondary text-[18px] shrink-0 mt-0.5" />
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Fingerprint enrolment is performed on an authorised branch device at the employee's assigned location, with a supervisor authorising the session by PIN or
            fingerprint. Templates are held encrypted and distributed only to devices at that location.
            {can('enrolment.view') && (
              <>
                {' '}
                <Link to="/devices/enrolment" className="text-primary hover:underline">
                  Open enrolment monitor
                </Link>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="lg:col-span-7 flex flex-col gap-space-md">
        <Panel title="Enrolled fingers" icon="fingerprint" subtitle={templates[0]?.template_format ? `Template format ${templates[0].template_format}` : undefined}>
          {templates.length === 0 ? (
            <Empty icon="fingerprint" title="No fingerprints enrolled." description={active ? 'Enrol this employee on a device at their assigned location.' : undefined} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
              {templates.map((t, i) => {
                const qTone: Tone = t.quality_score >= 70 ? 'success' : t.quality_score >= 50 ? 'warning' : 'error';
                return (
                  <div key={t.id} className="bg-surface-container rounded p-2.5 flex flex-col space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={clsx('font-label-sm text-label-sm uppercase font-semibold', i === 0 ? 'text-secondary' : 'text-outline')}>Finger {t.finger_index}</span>
                      <Badge tone={qTone}>Quality {t.quality_score}</Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-14 bg-surface-container-high rounded flex items-center justify-center shrink-0">
                        <FingerprintGlyph className="w-10 h-10 text-secondary/80" />
                      </div>
                      <div className="flex flex-col min-w-0 gap-0.5">
                        <span className="font-body-sm text-body-sm text-on-surface font-semibold">{FINGERS[t.finger_index] ?? `Finger ${t.finger_index}`}</span>
                        <span className="font-label-sm text-label-sm text-outline truncate">
                          {t.device_name ?? 'Unknown device'}
                          {t.device_uid ? ` (${t.device_uid})` : ''}
                        </span>
                        <span className="font-label-sm text-label-sm text-outline truncate">{t.location_name ?? '—'}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-outline font-label-sm text-label-sm pt-1 border-t border-outline-variant/20">
                      <span className="truncate">
                        By {t.authorised_by ?? 'unknown'} · <Icon name={t.authorisation_method === 'pin' ? 'pin' : 'fingerprint'} className="text-[11px] align-middle" />{' '}
                        {t.authorisation_method === 'pin' ? 'PIN' : 'Fingerprint'}
                      </span>
                      <span className="shrink-0" title={dateTime(t.enrolled_at)}>
                        {relative(t.enrolled_at)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Enrolment sessions" icon="history" subtitle="Latest 20 sessions on branch devices">
          {enrolments.length === 0 ? (
            <Empty icon="history" title="No enrolment sessions recorded." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Started</Th>
                  <Th>Device</Th>
                  <Th>Authorised by</Th>
                  <Th>Status</Th>
                  <Th>Fingers</Th>
                  <Th>Finished</Th>
                </tr>
              </THead>
              <tbody>
                {enrolments.map((s2) => (
                  <Tr key={s2.id}>
                    <Td className="whitespace-nowrap font-mono text-[11px]">{dateTime(s2.started_at)}</Td>
                    <Td>
                      {can('devices.view') ? (
                        <Link to={`/devices/${s2.device_id}`} className="hover:text-primary">
                          {s2.device_name}
                        </Link>
                      ) : (
                        s2.device_name
                      )}
                    </Td>
                    <Td>
                      {s2.supervisor_name ?? '—'}
                      {s2.authorisation_method && <span className="text-outline"> · {s2.authorisation_method === 'pin' ? 'PIN' : humanize(s2.authorisation_method)}</span>}
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-0.5">
                        <Badge tone={sessionTone(s2.status)}>{humanize(s2.status)}</Badge>
                        {s2.detail && <span className="font-label-sm text-label-sm text-outline max-w-[220px] truncate" title={s2.detail}>{s2.detail}</span>}
                      </div>
                    </Td>
                    <Td className="font-mono">{num(s2.fingers_captured)}</Td>
                    <Td className="whitespace-nowrap font-mono text-[11px]">{s2.finished_at ? dateTime(s2.finished_at) : '—'}</Td>
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

// ───────────────────────── Sync status ─────────────────────────
function PropagationCell({ label, state, detail }: { label: string; state: 'ok' | 'pending' | 'none'; detail: ReactNode }) {
  return (
    <div>
      <span className="text-[10px] block text-outline uppercase tracking-wider">{label}</span>
      <span className={clsx('font-label-md text-label-md font-semibold', state === 'ok' ? 'text-tertiary' : state === 'pending' ? 'text-warning' : 'text-outline')}>{detail}</span>
    </div>
  );
}

function SyncTab({ e, devices }: { e: any; devices: any[] }) {
  const { can } = useAuth();
  const active = e.employment_status === 'active';
  const rows = devices.map((d) => {
    const needR = d.needed_roster_version === null || d.needed_roster_version === undefined ? null : Number(d.needed_roster_version);
    const needT = d.needed_template_version === null || d.needed_template_version === undefined ? null : Number(d.needed_template_version);
    const rosterOk = needR === null ? null : Number(d.roster_version) >= needR;
    const tplOk = needT === null ? null : Number(d.template_version) >= needT;
    return { d, needR, needT, rosterOk, tplOk };
  });
  const synced = rows.filter((r) => r.rosterOk !== false && r.tplOk !== false).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
      <div className="lg:col-span-4 flex flex-col gap-space-md">
        <Panel title="Web software sync" icon="cloud_sync">
          <KV label="Last synced">
            <span title={dateTime(e.last_synced_at)}>{relative(e.last_synced_at)}</span>
          </KV>
          <KV label="Synced at" mono>
            {dateTime(e.last_synced_at)}
          </KV>
          <KV label="Source modified" mono>
            {dateTime(e.source_modified_at)}
          </KV>
          <KV label="First imported" mono>
            {dateTime(e.created_at)}
          </KV>
          {can('integration.view') && (
            <div className="pt-space-sm">
              <Link to="/integration" className="font-label-md text-label-md text-primary hover:underline">
                View integration status
              </Link>
            </div>
          )}
        </Panel>
      </div>

      <div className="lg:col-span-8">
        <Panel
          title="Device propagation"
          icon="hub"
          subtitle={e.location_name ? `Devices at ${e.location_name}` : undefined}
          actions={devices.length > 0 && <span className="font-label-sm text-label-sm text-secondary bg-surface-container px-2 py-0.5 rounded">{synced} OF {devices.length} UP TO DATE</span>}
        >
          <p className="font-body-sm text-body-sm text-on-surface-variant mb-space-sm">
            {active
              ? 'Whether this employee’s roster entry and fingerprint templates have reached each active device at the assigned location.'
              : 'Whether the roster removal and template purge for this employee have reached each device at the last assigned location.'}
          </p>
          {!e.location_id ? (
            <Empty icon="link_off" title="No assigned location." description="The employee is not distributed to any device until assigned to a location." />
          ) : devices.length === 0 ? (
            <Empty icon="router" title="No active devices at this location." description="Roster and templates will be delivered when a device is activated here." />
          ) : (
            <div className="flex flex-col gap-space-xs">
              {rows.map(({ d, needR, needT, rosterOk, tplOk }) => {
                const online = d.connectivity === 'online';
                return (
                  <div key={d.id} className="p-space-sm bg-surface-container rounded border border-outline-variant/20 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-space-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <Dot tone={online ? (d.health === 'warning' || d.health === 'critical' ? 'warning' : 'success') : 'error'} />
                        {can('devices.view') ? (
                          <Link to={`/devices/${d.id}`} className="font-body-sm text-body-sm text-on-surface font-semibold hover:text-primary truncate">
                            {d.name}
                          </Link>
                        ) : (
                          <span className="font-body-sm text-body-sm text-on-surface font-semibold truncate">{d.name}</span>
                        )}
                        <span className="font-label-sm text-label-sm text-outline font-mono truncate">{d.device_uid}</span>
                      </div>
                      <Badge tone={rosterOk === false || tplOk === false ? 'warning' : 'success'}>{rosterOk === false || tplOk === false ? 'Pending' : 'Up to date'}</Badge>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 font-label-sm text-label-sm pt-1">
                      <PropagationCell
                        label="Roster"
                        state={rosterOk === null ? 'none' : rosterOk ? 'ok' : 'pending'}
                        detail={
                          rosterOk === null
                            ? 'No change recorded'
                            : rosterOk
                              ? active
                                ? `On device (v${d.roster_version})`
                                : `Removed (v${d.roster_version})`
                              : `Pending v${needR} (device v${d.roster_version})`
                        }
                      />
                      <PropagationCell
                        label="Templates"
                        state={tplOk === null ? 'none' : tplOk ? 'ok' : 'pending'}
                        detail={
                          tplOk === null
                            ? 'None to distribute'
                            : tplOk
                              ? active
                                ? `Synced (v${d.template_version})`
                                : `Purged (v${d.template_version})`
                              : `Pending v${needT} (device v${d.template_version})`
                        }
                      />
                      <PropagationCell label="Connectivity" state={online ? 'ok' : 'pending'} detail={online ? 'Online' : `Offline · seen ${relative(d.last_heartbeat_at)}`} />
                      <PropagationCell label="Last sync" state="none" detail={<span title={dateTime(d.last_sync_at)}>{relative(d.last_sync_at)}</span>} />
                    </div>
                    {!online && (rosterOk === false || tplOk === false) && (
                      <p className="font-label-sm text-label-sm text-warning">The device is offline; changes will be applied when it reconnects.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
