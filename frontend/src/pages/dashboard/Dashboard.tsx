import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  ExportMenu,
  Icon,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  Progress,
  Stat,
  Table,
  Td,
  Th,
  THead,
  Tr,
  severityTone,
  useErrorToast,
  useToast,
  type Tone, SideToggle } from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, humanize, num, pct, relative, todayIso } from '@/lib/format';
import { useLive, useLiveEvents, type LiveFrame } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { EventTable } from '@/pages/attendance/components';
import { KIND_LABEL, SyncResultBanner, SyncStatusBadge, type SyncTrack } from '@/pages/integration/components';

// Service-level targets from the requirements (not data): S-6 availability, NFR-2.2 ingest, S-1 delivery.
const SLA_AVAILABILITY_PCT = 99.5;
const SLA_INGEST_MS = 5_000;
const SLA_DELIVERY_MS = 10_000;
const FEED_ROWS = 15;

const C_IN = '#3ddc97'; // tertiary
const C_OUT = '#a5b0ff'; // secondary

const toneText: Record<Tone, string> = {
  success: 'text-tertiary',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-secondary',
  neutral: 'text-on-surface',
  primary: 'text-primary'
};

interface DeviceStats {
  online: number;
  offline: number;
  warning: number;
  pending: number;
  total: number;
  buffered_events: number;
  storage_warning: number;
}

function isOperational(d: any) {
  return d.lifecycle_state === 'connected' || d.lifecycle_state === 'active';
}

function deliveryPatch(f: LiveFrame): Record<string, unknown> | null {
  const d = f.data ?? {};
  if (d.employee_name !== undefined) return d;
  if (!d.status) return null;
  return {
    delivery_status: d.status,
    ...(d.attempts !== undefined ? { delivery_attempts: d.attempts } : {}),
    delivery_error: d.status === 'delivered' ? null : d.error ?? null,
    ...(d.status === 'delivered' ? { delivered_at: f.at ?? new Date().toISOString() } : {})
  };
}

export default function Dashboard() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const live = useLive();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [globalLoc] = useGlobalLocation();
  const scoped = Boolean(globalLoc);

  const q = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000, refetchInterval: 60_000 });
  const todayScoped = useQuery<any>({
    queryKey: ['attendance-today', globalLoc],
    queryFn: () => api.get('/api/attendance/today', { locationId: globalLoc ?? undefined }),
    enabled: scoped && can('attendance.view'),
    refetchInterval: 60_000
  });
  const devicesQ = useQuery<any>({
    queryKey: ['devices', { dashboard: true, locationId: globalLoc }],
    queryFn: () => api.get('/api/devices', { locationId: globalLoc ?? undefined, limit: 1000 }),
    enabled: can('devices.view'),
    refetchInterval: 60_000
  });
  const locDetail = useQuery<any>({
    queryKey: ['location', globalLoc],
    queryFn: () => api.get(`/api/locations/${globalLoc}`),
    enabled: scoped && can('locations.view'),
    refetchInterval: 60_000
  });
  const summary = useQuery<any>({
    queryKey: ['delivery-summary'],
    queryFn: () => api.get('/api/attendance/delivery/summary'),
    enabled: can('attendance.view'),
    refetchInterval: 60_000
  });

  // ── Live activity feed ──
  const [liveRows, setLiveRows] = useState<any[]>([]);
  const [patches, setPatches] = useState<Record<string, Record<string, unknown>>>({});
  const [flash, setFlash] = useState<Set<string>>(new Set());
  useLiveEvents('attendance/event', (f) => {
    const ev = f.data;
    if (!ev?.id) return;
    if (globalLoc && ev.location_id !== globalLoc) return;
    setLiveRows((cur) => [ev, ...cur.filter((r) => r.id !== ev.id)].slice(0, FEED_ROWS));
    setFlash((s) => new Set(s).add(ev.id));
    setTimeout(
      () =>
        setFlash((s) => {
          const n = new Set(s);
          n.delete(ev.id);
          return n;
        }),
      2400
    );
  });
  useLiveEvents('delivery/updated', (f) => {
    const id = f.data?.eventId ?? f.data?.id;
    const p = deliveryPatch(f);
    if (id && p) setPatches((cur) => ({ ...cur, [id]: { ...cur[id], ...p } }));
  });

  // ── Quick actions ──
  const [syncTrack, setSyncTrack] = useState<SyncTrack | null>(null);
  const sync = useMutation({
    mutationFn: () => api.post<any>('/api/employees/sync'),
    onMutate: () => setSyncTrack({ phase: 'running', kind: 'employees', mine: true }),
    onSuccess: (r) => {
      if (r?.run) setSyncTrack({ phase: 'done', kind: 'employees', run: r.run });
      else setSyncTrack({ phase: 'info', kind: 'employees', message: r?.message ?? 'A synchronisation is already in progress.' });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['employees'] });
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
    },
    onError: (e: any) => {
      setSyncTrack({ phase: 'error', kind: 'employees', message: e?.message ?? 'Request failed' });
      errorToast(e, 'Roster sync failed');
    }
  });
  const onExport = useCallback(
    async (format: 'csv' | 'xlsx' | 'pdf') => {
      try {
        await download('/api/attendance/events/export', { format, date: todayIso(), locationId: globalLoc ?? undefined });
        toast({ tone: 'success', title: "Today's attendance exported", description: `Downloaded as ${format.toUpperCase()}.` });
      } catch (e) {
        errorToast(e, 'Export failed');
      }
    },
    [globalLoc, toast, errorToast]
  );

  const d = q.data;

  const feed = useMemo(() => {
    const recent: any[] = (d?.recent ?? []).filter((r: any) => !globalLoc || r.location_id === globalLoc);
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of [...liveRows, ...recent]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(patches[r.id] ? { ...r, ...patches[r.id] } : r);
      if (out.length >= FEED_ROWS) break;
    }
    return out;
  }, [d, liveRows, patches, globalLoc]);

  // ── Device health (exact per-device list when devices.view, else dashboard aggregate) ──
  const devRows: any[] | null = devicesQ.data?.rows ?? null;
  const deviceStats: DeviceStats | null = useMemo(() => {
    if (scoped && devRows) {
      const s: DeviceStats = { online: 0, offline: 0, warning: 0, pending: 0, total: devRows.length, buffered_events: 0, storage_warning: 0 };
      for (const x of devRows) {
        if (isOperational(x) && x.connectivity === 'offline') s.offline++;
        else if (isOperational(x) && x.connectivity === 'online' && (x.health === 'warning' || x.health === 'critical')) s.warning++;
        else if (isOperational(x) && x.connectivity === 'online') s.online++;
        if (x.lifecycle_state === 'pending' || x.lifecycle_state === 'provisioned') s.pending++;
        s.buffered_events += Number(x.pending_events ?? 0);
        if (Number(x.storage_used_pct ?? 0) >= 80) s.storage_warning++;
      }
      return s;
    }
    return d?.devices ?? null;
  }, [scoped, devRows, d]);

  const troubled: any[] = useMemo(() => {
    if (devRows) {
      return devRows
        .filter((x) => isOperational(x) && (x.connectivity === 'offline' || Number(x.pending_events) > 0))
        .sort((a, b) => (a.connectivity === b.connectivity ? Number(b.pending_events) - Number(a.pending_events) : a.connectivity === 'offline' ? -1 : 1))
        .slice(0, 12)
        .map((x) => ({ ...x, employees_affected: x.roster_size }));
    }
    return (d?.offlineDevices ?? []).filter((x: any) => !globalLoc || x.location_id === globalLoc);
  }, [devRows, d, globalLoc]);

  if (q.isLoading) return <Loading label="Loading attendance data..." />;
  if (q.error && !d)
    return (
      <>
        <PageHeader title="Dashboard" icon="grid_view" />
        <Panel>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      </>
    );
  if (!d) return null;

  // ── Dashboard empty state: nothing configured yet ──
  const nothingYet = (d.locations?.length ?? 0) === 0 && (d.devices?.total ?? 0) === 0 && Number(d.employeeSync?.n ?? 0) === 0;
  if (nothingYet) {
    return (
      <>
        <PageHeader title="Dashboard" icon="grid_view" subtitle={me?.organization.name} />
        <Panel>
          <Empty
            icon="rocket_launch"
            title="Welcome — let's set up your attendance platform."
            description="There are no locations, employees or devices yet. Connect the web software, sync locations and employees, then provision your first fingerprint device."
            action={
              can('settings.manage') ? (
                <LinkButton to="/setup" variant="primary" icon="arrow_forward">
                  Start setup
                </LinkButton>
              ) : (
                <p className="text-body-sm text-outline">Ask an administrator to complete the initial setup.</p>
              )
            }
          />
        </Panel>
      </>
    );
  }

  const today = scoped ? todayScoped.data ?? null : d.today;
  const locations: any[] = (d.locations ?? []).filter((l: any) => !globalLoc || l.id === globalLoc);
  const alerts: any[] = (d.alerts ?? []).filter((a: any) => !globalLoc || a.location_id === globalLoc);
  const scopeName = globalLoc ? locations[0]?.name ?? 'Selected location' : null;
  const delivery = d.delivery ?? {};
  const dlq = delivery.dead_letter ?? 0;
  const backlog = (delivery.pending ?? 0) + (delivery.delivering ?? 0) + (delivery.retrying ?? 0);
  const avail = d.availability?.samples ? Number(d.availability.availability_pct) : null;
  const p95i = d.latency?.p95_ingest_ms !== null && d.latency?.p95_ingest_ms !== undefined ? Number(d.latency.p95_ingest_ms) : null;
  const p95d = d.latency?.p95_delivery_ms !== null && d.latency?.p95_delivery_ms !== undefined ? Number(d.latency.p95_delivery_ms) : null;
  const liveOk = live.status === 'open' && d.realtime?.mqttConnected !== false;
  const empSync = (d.sync ?? []).find((s: any) => s.kind === 'employees');
  const presentPct = today?.active_employees ? (Number(today.present) / Number(today.active_employees)) * 100 : null;

  // Hourly chart data
  const chart = buildHourly(scoped && locDetail.data ? { kind: 'local', rows: locDetail.data.hourly ?? [] } : { kind: 'utc', rows: d.hourly ?? [] });
  const chartCaption = scoped && locDetail.data ? `Today by hour · ${locDetail.data.location?.timezone ?? 'location time'}` : 'Last 24 hours by hour (your local time)';
  const peak = chart.reduce((m, r) => (r.ins + r.outs > m.ins + m.outs ? r : m), chart[0] ?? { label: '', ins: 0, outs: 0 });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = me?.user.fullName?.split(/\s+/)[0];

  return (
    <>
      <PageHeader
        title={firstName ? `${greeting}, ${firstName}` : 'Dashboard'}
        icon="space_dashboard"
        subtitle={
          <>
            {me?.organization.name}
            {scopeName ? ` · ${scopeName}` : ''} · attendance, devices and delivery at a glance · updated {relative(d.serverTime)}
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon="refresh" loading={q.isFetching} onClick={() => void q.refetch()} aria-label="Refresh dashboard">
              Refresh
            </Button>
            {can('attendance.export') && <ExportMenu onExport={onExport} />}
            {can('employees.sync') && (
              <Button icon="sync" loading={sync.isPending} onClick={() => sync.mutate()}>
                Sync roster
              </Button>
            )}
            {can('devices.provision') && (
              <LinkButton to="/devices/provision" variant="primary" icon="add">
                Provision device
              </LinkButton>
            )}
          </>
        }
      />

      <SyncResultBanner track={syncTrack} onDismiss={() => setSyncTrack(null)} />

      {me && !me.organization.setupCompleted && can('settings.manage') && (
        <section className="card rounded-xl p-space-md flex flex-col md:flex-row md:items-center justify-between gap-space-md relative overflow-hidden">
          <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full bg-primary" />
          <div className="flex items-start gap-3">
            <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20 shrink-0">
              <Icon name="checklist" className="text-[19px]" />
            </span>
            <div>
              <div className="font-headline-sm text-headline-sm text-on-surface">Setup is not finished</div>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {num(d.locations?.length ?? 0)} location(s), {num(d.employeeSync?.n ?? 0)} active employee(s) and {num(d.devices?.total ?? 0)} device(s) configured so far.
              </p>
            </div>
          </div>
          <LinkButton to="/setup" variant="primary" icon="arrow_forward">
            Continue setup
          </LinkButton>
        </section>
      )}

      {/* Attendance summary */}
      <section className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-space-md">
        {scoped && todayScoped.isLoading ? (
          <div className="col-span-full">
            <Loading label="Loading attendance data..." />
          </div>
        ) : (
          <>
            <Stat label="Present" icon="how_to_reg" tone="success" value={num(today?.present)} hint={today ? `of ${num(today.active_employees)} active` : undefined} to={can('employees.view') ? '/employees' : undefined} />
            <Stat label="Absent" icon="person_off" tone={today?.absent ? 'error' : undefined} value={num(today?.absent)} hint="Scheduled workday, no record" />
            <Stat label="Late" icon="schedule" tone={today?.late ? 'warning' : undefined} value={num(today?.late)} hint="After start + grace" />
            <Stat label="Clocked in" icon="login" tone="info" value={num(today?.clocked_in)} hint="Last punch = in" />
            <Stat label="Clocked out" icon="logout" value={num(today?.clocked_out)} hint="Last punch = out" />
            <Stat label="Attendance events" icon="fingerprint" value={num(today?.total_events)} hint="Today" to={can('attendance.view') ? `/attendance/history?date=${todayIso()}` : undefined} />
          </>
        )}
      </section>

      {/* Service levels */}
      <section className="card rounded-xl p-space-md">
        <div className="flex flex-col xl:flex-row xl:items-center gap-space-md">
          <div className="flex items-center gap-3 shrink-0 xl:w-[300px]">
            <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
              <Icon name="speed" className="text-[19px]" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-headline-sm text-headline-sm text-on-surface">Service levels</span>
                <Badge tone={liveOk ? 'success' : 'error'}>
                  <Dot tone={liveOk ? 'success' : 'error'} pulse={liveOk} />
                  {liveOk ? 'Live' : d.realtime?.mqttConnected === false ? 'Broker down' : 'Feed offline'}
                </Badge>
              </div>
              <p className="font-body-sm text-body-sm text-outline">Availability this month · P95 latency, last hour ({num(d.latency?.samples ?? 0)} samples)</p>
            </div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 flex-1 gap-2">
            <Readout label="Availability" sla="S-6" value={avail === null ? '—' : pct(avail, 2)} target={`target ≥ ${SLA_AVAILABILITY_PCT}%`} tone={avail === null ? 'neutral' : avail >= SLA_AVAILABILITY_PCT ? 'success' : 'error'} />
            <Readout label="Ingest P95" sla="NFR-2.2" value={p95i === null ? '—' : duration(p95i)} target="target ≤ 5 s" tone={p95i === null ? 'neutral' : p95i <= SLA_INGEST_MS ? 'success' : 'warning'} />
            <Readout label="Delivery P95" sla="S-1" value={p95d === null ? '—' : duration(p95d)} target="target ≤ 10 s" tone={p95d === null ? 'neutral' : p95d <= SLA_DELIVERY_MS ? 'success' : 'warning'} />
            <Readout
              label="Delivery backlog"
              sla="S-2"
              value={num(backlog)}
              target={dlq ? `${num(dlq)} in dead-letter` : 'dead-letter empty'}
              tone={dlq ? 'error' : backlog ? 'info' : 'success'}
              to={can('attendance.view') ? '/attendance/reconciliation' : undefined}
            />
          </div>
        </div>
      </section>

      {/* Unmapped locations */}
      {d.unmappedLocations > 0 && (
        <section className="card rounded-xl p-space-md relative overflow-hidden">
          <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full bg-warning" />
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-md">
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-warning/10 text-warning ring-1 ring-inset ring-warning/25 shrink-0">
                <Icon name="location_off" className="text-[19px]" />
              </span>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-headline-sm text-headline-sm text-on-surface">
                    {num(d.unmappedLocations)} unmapped location{d.unmappedLocations === 1 ? '' : 's'} from the web software
                  </span>
                  <Badge tone="warning">Roster blocked</Badge>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                  Employees assigned to these locations cannot be sent to any device until the location is mapped to a platform location.
                </p>
              </div>
            </div>
            {can('integration.view') && (
              <LinkButton to="/integration/unmapped" variant="secondary" icon="add_location_alt" className="self-end md:self-center">
                Resolve & map locations
              </LinkButton>
            )}
          </div>
        </section>
      )}

      {/* §30 triage grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-md">
        <TriageCard
          accent="bg-secondary-container"
          icon="cloud_off"
          iconCls="text-secondary"
          title="Offline resilience"
          badge={<Badge tone={deviceStats?.offline ? 'warning' : 'success'}>{num(deviceStats?.offline ?? 0)} offline</Badge>}
          description="Devices keep capturing while offline and upload buffered events when the connection returns."
          footer={
            can('devices.view') ? (
              <LinkButton to="/devices?status=offline" size="sm" className="w-full" icon="cloud_off">
                View offline devices
              </LinkButton>
            ) : undefined
          }
        >
          <div className="well rounded-lg p-3 space-y-1.5">
            {troubled.length === 0 ? (
              <div className="font-label-sm text-label-sm text-tertiary flex items-center gap-1">
                <Icon name="cloud_done" className="text-[14px]" /> No offline or buffering devices
              </div>
            ) : (
              troubled.slice(0, 2).map((x) => (
                <div key={x.id} className="space-y-1">
                  <div className="flex justify-between items-center font-label-sm text-label-sm gap-2">
                    <span className="text-outline truncate">
                      {x.location_name ?? 'Unassigned'} · {x.name}
                    </span>
                    {x.storage_used_pct !== null && x.storage_used_pct !== undefined ? (
                      <span className={clsx('font-mono font-bold shrink-0', Number(x.storage_used_pct) >= 80 ? 'text-error' : 'text-on-surface-variant')}>{pct(x.storage_used_pct, 0)} storage</span>
                    ) : null}
                  </div>
                  {x.storage_used_pct !== null && x.storage_used_pct !== undefined && <Progress value={Number(x.storage_used_pct)} tone={Number(x.storage_used_pct) >= 80 ? 'error' : 'info'} />}
                  <div className="flex justify-between font-label-sm text-label-sm">
                    <span className="text-outline">Buffered events:</span>
                    <span className="text-on-surface font-mono">{num(x.pending_events)}</span>
                  </div>
                </div>
              ))
            )}
            <div className="flex justify-between font-label-sm text-label-sm pt-1 border-t border-outline-variant/20">
              <span className="text-outline">Total buffered:</span>
              <span className="text-on-surface font-mono">{num(deviceStats?.buffered_events ?? 0)}</span>
            </div>
          </div>
        </TriageCard>

        <TriageCard
          accent="bg-error"
          icon="assignment_late"
          iconCls="text-error"
          title="DLQ & reconciliation"
          badge={<Badge tone={dlq ? 'error' : 'success'}>{num(dlq)} dead-letter</Badge>}
          description="Attendance rejected or timed out by the web software. Stored safely; retried automatically."
          footer={
            can('attendance.view') ? (
              <LinkButton to="/attendance/reconciliation" size="sm" variant={dlq ? 'danger' : 'secondary'} className="w-full" icon="replay">
                {dlq ? `Inspect & replay (${num(dlq)})` : 'Open reconciliation'}
              </LinkButton>
            ) : undefined
          }
        >
          <div className="well rounded-lg p-3 space-y-1.5 font-label-sm text-label-sm">
            <Row label="Top error:">
              <span className={clsx('font-mono truncate', summary.data?.topErrors?.[0] ? 'text-error' : 'text-tertiary')} title={summary.data?.topErrors?.[0]?.last_error ?? undefined}>
                {summary.data?.topErrors?.[0]
                  ? `${summary.data.topErrors[0].last_http_status ? `HTTP ${summary.data.topErrors[0].last_http_status}` : 'No response'} (${num(summary.data.topErrors[0].n)})`
                  : 'None'}
              </span>
            </Row>
            <Row label="Retrying:">
              <span className="font-mono text-on-surface">{num(delivery.retrying ?? 0)}</span>
            </Row>
            <Row label="Next retry:">
              <span className="font-mono text-primary">{summary.data?.nextRetryAt ? relative(summary.data.nextRetryAt) : '—'}</span>
            </Row>
            <Row label="Pending delivery:">
              <span className="font-mono text-on-surface-variant">{num((delivery.pending ?? 0) + (delivery.delivering ?? 0))}</span>
            </Row>
          </div>
        </TriageCard>

        <TriageCard
          accent="bg-tertiary"
          icon="group"
          iconCls="text-tertiary"
          title="Workforce today"
          badge={<Badge tone="success">{presentPct === null ? '—' : pct(presentPct, 1)} present</Badge>}
          description={chartCaption}
          footer={
            <div className="flex justify-between items-center font-label-sm text-label-sm w-full">
              <span className="text-outline">
                Clocked in: <strong className="text-on-surface font-mono">{num(today?.clocked_in)}</strong>
              </span>
              <span className="text-outline">
                Absent: <strong className="text-on-surface font-mono">{num(today?.absent)}</strong>
              </span>
            </div>
          }
        >
          <div className="well rounded-lg p-2">
            <div className="flex items-center justify-between font-label-sm text-[10px] text-outline px-1 mb-1">
              <span>{chart[0]?.label ?? ''}</span>
              {peak && peak.ins + peak.outs > 0 && (
                <span className="text-tertiary">
                  Peak {peak.label} ({num(peak.ins + peak.outs)})
                </span>
              )}
              <span>{scoped && locDetail.data ? chart[chart.length - 1]?.label : 'NOW'}</span>
            </div>
            <Sparkline values={chart.map((r) => r.ins + r.outs)} />
          </div>
          <div className="grid grid-cols-2 gap-space-xs pt-1">
            <div className="well rounded-lg px-2.5 py-2">
              <span className="font-label-sm text-[10px] text-outline block">PRESENT</span>
              <span className="font-headline-sm text-headline-sm text-tertiary font-mono">{num(today?.present)}</span>
            </div>
            <div className="well rounded-lg px-2.5 py-2">
              <span className="font-label-sm text-[10px] text-outline block">LATE</span>
              <span className="font-headline-sm text-headline-sm text-warning font-mono">{num(today?.late)}</span>
            </div>
          </div>
        </TriageCard>

        <TriageCard
          accent="bg-primary"
          icon="router"
          iconCls="text-primary"
          title="Fleet integrity"
          badge={<Badge tone="primary">{num(deviceStats?.total ?? 0)} total</Badge>}
          description="Heartbeat-based connectivity and health of fingerprint devices."
          footer={
            can('devices.view') ? (
              <LinkButton to="/devices" size="sm" variant="secondary" className="w-full">
                Device registry <Icon name="arrow_forward" className="text-[14px]" />
              </LinkButton>
            ) : undefined
          }
        >
          <FleetBar s={deviceStats} />
        </TriageCard>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-gutter items-start">
        {/* Live activity */}
        <Panel
          className="xl:col-span-8"
          title="Live activity"
          icon="stream"
          subtitle="Newest attendance events — new clock-ins appear instantly"
          bodyClassName="px-0 pb-0"
          actions={
            can('attendance.view') ? (
              <LinkButton to="/attendance/live" size="sm" icon="open_in_new">
                Live feed
              </LinkButton>
            ) : undefined
          }
        >
          {feed.length === 0 ? <Empty title="No attendance records found." icon="fingerprint" description="Events appear here as soon as employees clock in on a device." /> : <EventTable rows={feed} flashIds={flash} compact />}
        </Panel>

        <div className="xl:col-span-4 flex flex-col gap-gutter">
          <SideToggle id="dashboard-side" label="Alerts & sync" />
          {/* Alerts */}
          <Panel
            title="Alerts"
            icon="notifications_active"
            subtitle={`${num(d.alertCounts?.critical ?? 0)} critical · ${num(d.alertCounts?.warning ?? 0)} warning · ${num(d.alertCounts?.info ?? 0)} info`}
            actions={
              can('alerts.view') ? (
                <LinkButton to="/alerts" size="sm">
                  View all
                </LinkButton>
              ) : undefined
            }
          >
            {alerts.length === 0 ? (
              <div className="flex items-center gap-2 py-space-sm text-body-sm text-tertiary">
                <Icon name="verified" /> No open alerts.
              </div>
            ) : (
              <ul className="divide-y divide-outline-variant/20">
                {alerts.slice(0, 6).map((a) => (
                  <li key={a.id}>
                    <Link to={`/alerts/${a.id}`} className="flex items-start gap-2 py-2 hover:bg-white/[0.03] rounded-lg px-2 -mx-2 transition-colors">
                      <span className="pt-1.5">
                        <Dot tone={severityTone(a.severity)} pulse={a.severity === 'critical'} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-body-sm text-on-surface font-semibold truncate">{a.title}</div>
                        <div className="font-label-sm text-label-sm text-outline truncate">
                          {[a.location_name, a.device_name].filter(Boolean).join(' · ') || humanize(a.category ?? a.type)} · {relative(a.last_occurred_at ?? a.created_at)}
                        </div>
                      </div>
                      <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Employee sync */}
          <Panel
            title="Employee sync"
            icon="badge"
            subtitle="Web software is the source of truth for employees"
            actions={
              can('integration.view') ? (
                <LinkButton to="/integration" size="sm">
                  Integration
                </LinkButton>
              ) : undefined
            }
          >
            <div className="space-y-1">
              <div className="flex items-center justify-between py-1 text-body-sm">
                <span className="text-outline">Active employees</span>
                <span className="font-mono text-on-surface">{num(d.employeeSync?.n ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between py-1 text-body-sm">
                <span className="text-outline">Last employee record synced</span>
                <span className="font-mono text-on-surface" title={dateTime(d.employeeSync?.t)}>
                  {d.employeeSync?.t ? relative(d.employeeSync.t) : 'never'}
                </span>
              </div>
              {(['employees', 'locations', 'attendance_export'] as const).map((k) => {
                const s = (d.sync ?? []).find((x: any) => x.kind === k);
                if (!s) return null;
                return (
                  <div key={k} className="py-1.5 border-t border-outline-variant/15">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-body-sm text-on-surface">{KIND_LABEL[k] ?? k}</span>
                      <SyncStatusBadge status={s.status} />
                    </div>
                    <div className="font-label-sm text-label-sm text-outline">
                      {relative(s.finished_at ?? s.started_at)} · {num(s.records_processed)} processed
                    </div>
                    {s.error_message && <div className="font-mono text-[10px] text-error break-words">{s.error_message}</div>}
                  </div>
                );
              })}
              {!empSync && <p className="text-body-sm text-outline">No employee synchronisation has run yet.</p>}
            </div>
          </Panel>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-gutter items-start">
        {/* Device health */}
        <Panel
          className="xl:col-span-7"
          title="Device health"
          icon="router"
          subtitle={scoped ? scopeName ?? undefined : 'All locations you can access'}
        >
          <div className="grid grid-cols-3 md:grid-cols-6 gap-space-sm">
            <Stat label="Online" tone="success" value={num(deviceStats?.online ?? 0)} />
            <Stat label="Offline" tone={deviceStats?.offline ? 'error' : undefined} value={num(deviceStats?.offline ?? 0)} />
            <Stat label="Warning" tone={deviceStats?.warning ? 'warning' : undefined} value={num(deviceStats?.warning ?? 0)} />
            <Stat label="Pending" value={num(deviceStats?.pending ?? 0)} />
            <Stat label="Buffered" tone={deviceStats?.buffered_events ? 'info' : undefined} value={num(deviceStats?.buffered_events ?? 0)} hint="events" />
            <Stat label="Storage ≥80%" tone={deviceStats?.storage_warning ? 'warning' : undefined} value={num(deviceStats?.storage_warning ?? 0)} />
          </div>
          <div className="mt-space-md space-y-space-sm">
            {troubled.length === 0 ? (
              <div className="flex items-center gap-2 text-body-sm text-tertiary">
                <Icon name="cloud_done" /> All operational devices are online and nothing is buffered.
              </div>
            ) : (
              troubled.map((x) => <DeviceTriage key={x.id} d={x} />)
            )}
          </div>
        </Panel>

        {/* Hourly chart */}
        <Panel className="xl:col-span-5" title="Clock-ins & clock-outs" icon="bar_chart" subtitle={chartCaption}>
          <HourlyChart data={chart} />
        </Panel>
      </section>

      {/* Location overview */}
      <Panel title="Location overview" icon="storefront" subtitle={`${num(locations.length)} location(s)`} bodyClassName="px-0 pb-0">
        {locations.length === 0 ? (
          <Empty
            title="No locations yet."
            icon="storefront"
            description={me?.organization.setupCompleted ? 'Add locations on the Locations page, or map them from the web software under Integration & Sync.' : 'Use Continue setup above to add your locations.'}
          />
        ) : (
          <LocationTable rows={locations} />
        )}
      </Panel>
    </>
  );
}

// ───────────────────────── Pieces ─────────────────────────
function Readout({ label, sla, value, target, tone, to }: { label: string; sla: string; value: ReactNode; target: ReactNode; tone: Tone; to?: string }) {
  const body = (
    <div className="h-full rounded-lg px-3 py-2.5 bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] flex flex-col gap-0.5">
      <span className="flex items-center justify-between gap-2 font-label-md text-label-md text-outline">
        {label}
        <span className="text-[10px] font-mono text-outline/70">{sla}</span>
      </span>
      <span className={clsx('text-[18px] leading-6 font-semibold tabular tracking-tight', toneText[tone])}>{value}</span>
      <span className="font-body-sm text-[11.5px] text-outline">{target}</span>
    </div>
  );
  return to ? (
    <Link to={to} className="block rounded-lg lift">
      {body}
    </Link>
  ) : (
    body
  );
}

const ACCENT_TONE: Record<string, Tone> = { 'bg-secondary-container': 'info', 'bg-error': 'error', 'bg-tertiary': 'success', 'bg-primary': 'primary' };
const ICON_BOX: Record<Tone, string> = {
  info: 'bg-secondary/10 text-secondary ring-secondary/20',
  error: 'bg-error/10 text-error ring-error/25',
  success: 'bg-tertiary/10 text-tertiary ring-tertiary/20',
  primary: 'bg-primary/10 text-primary ring-primary/20',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  neutral: 'bg-white/[0.04] text-outline ring-white/10'
};

function TriageCard({ accent, icon, title, badge, description, children, footer }: { accent: string; icon: string; iconCls?: string; title: string; badge: ReactNode; description: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const tone = ACCENT_TONE[accent] ?? 'neutral';
  return (
    <div className="card lift rounded-xl p-space-md flex flex-col justify-between relative overflow-hidden">
      <div>
        <div className="flex items-start gap-3 mb-3">
          <span className={clsx('flex items-center justify-center w-9 h-9 rounded-lg ring-1 ring-inset shrink-0', ICON_BOX[tone])}>
            <Icon name={icon} className="text-[19px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
            <div className="mt-1">{badge}</div>
          </div>
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant mb-3">{description}</p>
        <div className="mb-space-md space-y-space-xs">{children}</div>
      </div>
      {footer && <div className="pt-space-xs flex">{footer}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-outline shrink-0">{label}</span>
      {children}
    </div>
  );
}

function FleetBar({ s }: { s: DeviceStats | null }) {
  if (!s) return <p className="text-body-sm text-outline">No device data.</p>;
  const operational = s.online + s.warning + s.offline;
  const share = (n: number) => (operational ? (n / operational) * 100 : 0);
  return (
    <div className="space-y-space-xs">
      <div className="flex justify-between items-center font-label-sm text-label-sm">
        <span className="text-on-surface font-semibold">{num(s.online)} online & healthy</span>
        <span className="text-tertiary font-mono">{operational ? pct(share(s.online), 1) : '—'}</span>
      </div>
      <div className="h-2 w-full flex gap-0.5 rounded-full overflow-hidden bg-surface-container-highest">
        {s.online > 0 && <div className="bg-tertiary h-full" style={{ width: `${share(s.online)}%` }} />}
        {s.warning > 0 && <div className="bg-warning h-full" style={{ width: `${share(s.warning)}%` }} />}
        {s.offline > 0 && <div className="bg-error h-full" style={{ width: `${share(s.offline)}%` }} />}
      </div>
      <div className="grid grid-cols-2 gap-1 pt-2 font-label-sm text-[10px]">
        <Legendish cls="bg-tertiary" label={`${num(s.online)} OK`} />
        <Legendish cls="bg-warning" label={`${num(s.warning)} Warning`} />
        <Legendish cls="bg-error" label={`${num(s.offline)} Offline`} />
        <Legendish cls="bg-outline" label={`${num(s.pending)} Pending`} />
      </div>
    </div>
  );
}
function Legendish({ cls, label }: { cls: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className={clsx('w-1.5 h-1.5 rounded-full', cls)} />
      <span className="text-outline">{label}</span>
    </div>
  );
}

/** §30 pattern: DEVICE OFFLINE · Location · Device — last seen, buffered, employees affected, [View Device] [View Location]. */
function DeviceTriage({ d }: { d: any }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const offline = d.connectivity ? d.connectivity === 'offline' : Number(d.pending_events ?? 0) === 0;
  return (
    <div className={clsx('rounded-lg p-3 bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] flex flex-col md:flex-row md:items-center justify-between gap-space-sm relative overflow-hidden')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={offline ? 'error' : 'info'} icon={offline ? 'cloud_off' : 'cloud_sync'}>
            {offline ? 'Device offline' : 'Uploading buffer'}
          </Badge>
          <span className="text-body-sm text-on-surface font-semibold truncate">
            {d.location_name ?? 'Unassigned'} · {d.name}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-space-md gap-y-0.5 font-label-sm text-label-sm text-outline">
          <span>
            Last seen: <span className="text-on-surface-variant">{relative(d.last_heartbeat_at)}</span>
          </span>
          <span>
            Buffered events: <span className="text-on-surface font-mono">{num(d.pending_events)}</span>
          </span>
          <span>
            Employees affected: <span className="text-on-surface font-mono">{num(d.employees_affected)}</span>
          </span>
          {d.storage_used_pct !== null && d.storage_used_pct !== undefined && (
            <span>
              Storage: <span className={clsx('font-mono', Number(d.storage_used_pct) >= 80 ? 'text-error' : 'text-on-surface-variant')}>{pct(d.storage_used_pct, 0)}</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {can('devices.view') && (
          <Button size="sm" onClick={() => navigate(`/devices/${d.id}`)}>
            View Device
          </Button>
        )}
        {d.location_id && can('locations.view') && (
          <Button size="sm" variant="ghost" onClick={() => navigate(`/locations/${d.location_id}`)}>
            View Location
          </Button>
        )}
      </div>
    </div>
  );
}

function LocationTable({ rows }: { rows: any[] }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  return (
    <Table>
      <THead>
        <tr>
          <Th>Location</Th>
          <Th>Present today</Th>
          <Th className="text-right">Late</Th>
          <Th>Devices</Th>
          <Th className="text-right">Open alerts</Th>
        </tr>
      </THead>
      <tbody className="text-on-surface">
        {rows.map((l) => {
          const p = l.employees ? (Number(l.present) / Number(l.employees)) * 100 : 0;
          return (
            <Tr key={l.id} onClick={can('locations.view') ? () => navigate(`/locations/${l.id}`) : undefined}>
              <Td className="whitespace-nowrap">
                <div className="font-semibold">{l.name}</div>
                <div className="font-mono text-[10px] text-outline">
                  {l.code} · {l.timezone}
                </div>
              </Td>
              <Td className="min-w-[180px]">
                <div className="flex items-center justify-between font-mono text-[11px] mb-1">
                  <span>
                    {num(l.present)} / {num(l.employees)}
                  </span>
                  <span className="text-outline">{l.employees ? pct(p, 0) : '—'}</span>
                </div>
                <Progress value={p} tone="success" />
              </Td>
              <Td className={clsx('text-right font-mono', l.late ? 'text-warning' : 'text-outline')}>{num(l.late)}</Td>
              <Td className="whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                  <Dot tone="success" /> {num(l.devices_online)} online
                  <span className="text-outline-variant">·</span>
                  <Dot tone={l.devices_offline ? 'error' : 'neutral'} /> <span className={l.devices_offline ? 'text-error' : 'text-outline'}>{num(l.devices_offline)} offline</span>
                </span>
              </Td>
              <Td className="text-right">{l.open_alerts ? <Badge tone="warning">{num(l.open_alerts)}</Badge> : <span className="text-outline font-mono">0</span>}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

// ───────────────────────── Hourly chart ─────────────────────────
interface HourPoint {
  label: string;
  ins: number;
  outs: number;
}

function buildHourly(src: { kind: 'utc'; rows: any[] } | { kind: 'local'; rows: any[] }): HourPoint[] {
  if (src.kind === 'local') {
    const by = new Map<number, any>(src.rows.map((r) => [Number(r.hour), r] as const));
    const out: HourPoint[] = [];
    for (let h = 0; h < 24; h++) {
      const r = by.get(h);
      out.push({ label: `${String(h).padStart(2, '0')}:00`, ins: Number(r?.ins ?? 0), outs: Number(r?.outs ?? 0) });
    }
    return out;
  }
  const by = new Map<number, any>(src.rows.map((r) => [new Date(r.hour).getTime(), r] as const));
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const out: HourPoint[] = [];
  for (let i = 23; i >= 0; i--) {
    const t = now.getTime() - i * 3_600_000;
    const r = by.get(t);
    const dt = new Date(t);
    out.push({ label: `${String(dt.getHours()).padStart(2, '0')}:00`, ins: Number(r?.ins ?? 0), outs: Number(r?.outs ?? 0) });
  }
  return out;
}

function HourlyChart({ data }: { data: HourPoint[] }) {
  const total = data.reduce((s, r) => s + r.ins + r.outs, 0);
  if (total === 0) return <Empty title="No attendance records found." icon="bar_chart" description="No clock-ins or clock-outs in this period." />;
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -16, bottom: 0 }} barGap={2} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="label" tick={{ fill: '#6c717e', fontSize: 10 }} tickLine={false} axisLine={false} interval={3} />
          <YAxis allowDecimals={false} tick={{ fill: '#6c717e', fontSize: 10 }} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            contentStyle={{ background: '#1c1f25', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, boxShadow: '0 12px 32px -12px rgba(0,0,0,0.8)', padding: '8px 10px', fontSize: 12, color: '#ededf0' }}
            labelStyle={{ color: '#a3a7b3', fontFamily: 'JetBrains Mono Variable, monospace' }}
            itemStyle={{ color: '#ededf0' }}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: '#a3a7b3' }} iconType="circle" iconSize={8} />
          <Bar dataKey="ins" name="Clock in" fill={C_IN} radius={[4, 4, 0, 0]} maxBarSize={14} animationDuration={700} animationEasing="ease-out" />
          <Bar dataKey="outs" name="Clock out" fill={C_OUT} radius={[4, 4, 0, 0]} maxBarSize={14} animationDuration={700} animationEasing="ease-out" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n < 2)
    return <div className="h-11" />;
  const pts = values.map((v, i) => [(i / (n - 1)) * 200, 38 - (v / max) * 34] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg className="w-full h-11 overflow-visible text-tertiary" fill="none" viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label="Attendance events per hour">
      <path d={line} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <path d={`${line} L200 40 L0 40 Z`} fill="currentColor" fillOpacity={0.1} />
      <circle className="fill-tertiary animate-pulse" cx={last[0]} cy={last[1]} r={3} />
    </svg>
  );
}
