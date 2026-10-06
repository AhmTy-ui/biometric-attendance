import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  JsonBlock,
  KV,
  LinkButton,
  Loading,
  Modal,
  Pagination,
  PageHeader,
  Panel,
  PermissionDenied,
  Progress,
  QueryState,
  SearchInput,
  Select,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  deliveryTone,
  severityTone,
  useDebounced,
  useErrorToast,
  useToast, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FINGERS, date, dateTime, humanize, num, relative, time } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import {
  ActivationCodeCard,
  COMMANDS,
  CommandStatusBadge,
  DeviceStatusBadge,
  ENROLMENT_STATUS,
  EnrolmentStatusBadge,
  Heartbeat,
  LIFECYCLE_INFO,
  LifecycleStepper,
  OfflineCard,
  ReconcileProgress,
  RosterVersion,
  StorageGauge,
  StorageWarningCard,
  chartColors,
  isOffline,
  isOperational,
  storageTone,
  uptimeText,
  useNow,
  useReconcile,
  type IssuedCredentials
} from './components';

type TabKey = 'overview' | 'attendance' | 'roster' | 'biometrics' | 'logs' | 'actions';

interface DeviceDetailResponse {
  device: any;
  sync: { latestRosterVersion: number; latestTemplateVersion: number; rosterUpToDate: boolean; templatesUpToDate: boolean };
  commands: any[];
  heartbeats: { received_at: string; payload: any }[];
  alerts: any[];
  firmware: any[];
  last24h: { n: number; buffered: number; avg_score: string | number | null } | null;
  policies: any;
}

export default function DeviceDetails() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'overview';
  const setTab = (t: TabKey) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const q = useQuery({
    queryKey: ['device', id],
    queryFn: () => api.get<DeviceDetailResponse>(`/api/devices/${id}`),
    enabled: Boolean(id)
  });

  // Live: patch the device in place; command status updates.
  useLiveEvents('device/status', (f) => {
    const d = f.data;
    if (d?.id !== id) return;
    const { locationId: _l, ...rest } = d;
    qc.setQueryData<DeviceDetailResponse>(['device', id], (old) => (old ? { ...old, device: { ...old.device, ...rest } } : old));
  });
  useLiveEvents('command/updated', (f) => {
    const c = f.data;
    if (c?.device_id !== id) return;
    qc.setQueryData<DeviceDetailResponse>(['device', id], (old) => {
      if (!old) return old;
      const exists = old.commands.some((x) => x.id === c.id);
      const { locationId: _l, ...row } = c;
      const commands = exists ? old.commands.map((x) => (x.id === c.id ? { ...x, ...row } : x)) : [row, ...old.commands];
      return { ...old, commands };
    });
  });

  const [reconcile, clearReconcile] = useReconcile(id, q.data?.device?.connectivity);

  if (q.isLoading) return <Loading label="Loading device…" className="min-h-[50vh]" />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const { device } = q.data;

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'overview', label: 'Overview', icon: 'dashboard' },
    { key: 'attendance', label: 'Attendance', icon: 'schedule' },
    { key: 'roster', label: 'Roster', icon: 'groups' },
    ...(can('enrolment.view') ? [{ key: 'biometrics' as TabKey, label: 'Biometrics', icon: 'fingerprint' }] : []),
    { key: 'logs', label: 'Logs', icon: 'terminal' },
    { key: 'actions', label: 'Actions', icon: 'bolt' }
  ];

  return (
    <div className="p-gutter space-y-gutter">
      <PageHeader
        icon="router"
        crumbs={[{ label: 'Devices', to: '/devices' }, { label: device.name }]}
        title={
          <span className="flex items-center gap-space-sm flex-wrap">
            {device.name}
            <DeviceStatusBadge device={device} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-space-sm">
            <span className="font-mono">{device.device_uid}</span>
            <span>•</span>
            {device.location_id ? (
              <Link to={`/locations/${device.location_id}`} className="hover:text-on-surface">
                {device.location_name}
              </Link>
            ) : (
              <span>Unassigned</span>
            )}
            <span>•</span>
            <span>{LIFECYCLE_INFO[device.lifecycle_state]?.label ?? device.lifecycle_state}</span>
          </span>
        }
        actions={<HeaderActions data={q.data} />}
      />

      <Tabs<TabKey> value={tab} onChange={setTab} tabs={tabs} />

      {tab === 'overview' && <Overview data={q.data} reconcile={reconcile} clearReconcile={clearReconcile} />}
      {tab === 'attendance' && <AttendanceTab device={device} />}
      {tab === 'roster' && <RosterTab device={device} />}
      {tab === 'biometrics' && can('enrolment.view') && <BiometricsTab device={device} />}
      {tab === 'logs' && <LogsTab device={device} />}
      {tab === 'actions' && <ActionsTab data={q.data} />}
    </div>
  );
}

// ───────────────────────── Commands (shared by header + Actions tab) ─────────────────────────
function useCommand(device: any) {
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  return useMutation({
    mutationFn: (command: string) => api.post(`/api/devices/${device.id}/commands`, { command }),
    onSuccess: (row: any, command) => {
      toast({
        tone: 'success',
        title: `${COMMANDS[command]?.label ?? command} ${row?.status === 'sent' ? 'sent' : 'queued'}`,
        description: row?.status === 'sent' ? `Delivered to ${device.name} over MQTT; waiting for acknowledgement.` : `${device.name} is offline — the command is delivered when it reconnects.`
      });
      qc.setQueryData<DeviceDetailResponse>(['device', device.id], (old) => (old && row && !old.commands.some((c) => c.id === row.id) ? { ...old, commands: [row, ...old.commands] } : old));
      void qc.invalidateQueries({ queryKey: ['device', device.id] });
    },
    onError: (e, command) => errToast(e, `${COMMANDS[command]?.label ?? command} failed`)
  });
}

function HeaderActions({ data }: { data: DeviceDetailResponse }) {
  const { can } = useAuth();
  const d = data.device;
  const cmd = useCommand(d);
  const op = isOperational(d);
  return (
    <>
      {op && can('devices.command.basic') && (
        <>
          <Button icon="refresh" onClick={() => cmd.mutate('refresh_status')} loading={cmd.isPending && cmd.variables === 'refresh_status'}>
            Refresh status
          </Button>
          <Button icon="sync" onClick={() => cmd.mutate('sync_roster')} loading={cmd.isPending && cmd.variables === 'sync_roster'}>
            Sync roster
          </Button>
        </>
      )}
      {!['active', 'decommissioned'].includes(d.lifecycle_state) && can('devices.provision') && (
        <LinkButton to={`/devices/provision?deviceId=${d.id}`} icon="play_arrow" variant="primary">
          Continue provisioning
        </LinkButton>
      )}
    </>
  );
}

// ───────────────────────── Overview ─────────────────────────
function Overview({ data, reconcile, clearReconcile }: { data: DeviceDetailResponse; reconcile: ReturnType<typeof useReconcile>[0]; clearReconcile: () => void }) {
  useNow();
  const { device: d, sync, policies: pol, heartbeats, alerts, firmware, last24h } = data;
  const latest = heartbeats[0]?.payload ?? null;
  const off = isOffline(d);
  const storagePct = d.storage_used_pct === null || d.storage_used_pct === undefined ? null : Number(d.storage_used_pct);
  const storageWarn = storagePct !== null && pol?.storageWarningPct !== undefined && storagePct >= pol.storageWarningPct;
  const openAlerts = alerts.filter((a) => a.status !== 'resolved');
  const sTone = storageTone(storagePct, pol?.storageWarningPct, pol?.storageCriticalPct);
  const reconcilingNow = !off && Boolean(latest?.reconciling) && (d.pending_events ?? 0) > 0;

  return (
    <div className="space-y-space-md">
      {off && <OfflineCard device={d} hideViewDevice />}
      {reconcile && <ReconcileProgress state={reconcile} onDismiss={clearReconcile} />}
      {!reconcile && reconcilingNow && (
        <div className="p-space-md rounded bg-surface-container shadow-md flex items-center gap-space-sm">
          <Icon name="cloud_sync" className="text-secondary text-[22px] animate-pulse" />
          <div>
            <div className="font-headline-sm text-headline-sm text-on-surface">Uploading buffered events</div>
            <p className="text-body-sm text-on-surface-variant">
              Connection restored. The device reports {num(d.pending_events)} event(s) still to upload (oldest first). Progress appears here as batches arrive.
            </p>
          </div>
        </div>
      )}
      {storageWarn && isOperational(d) && <StorageWarningCard device={d} policies={pol} hideViewDevice />}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-sm">
        <Stat label="Status" value={<DeviceStatusBadge device={d} />} hint={d.connectivity === 'online' ? `Health: ${humanize(d.health)}` : 'Not reporting'} />
        <Stat label="Last heartbeat" value={d.last_heartbeat_at ? relative(d.last_heartbeat_at) : 'never'} hint={dateTime(d.last_heartbeat_at)} tone={off ? 'error' : undefined} icon="monitor_heart" />
        <Stat label="Pending events" value={num(d.pending_events ?? 0)} hint={off ? 'Buffered on device' : 'Awaiting upload'} tone={(d.pending_events ?? 0) > 0 ? (off ? 'info' : 'warning') : 'success'} icon="inventory_2" />
        <Stat label="Events · 24h" value={num(last24h?.n ?? 0)} hint={`${num(last24h?.buffered ?? 0)} buffered · avg score ${last24h?.avg_score ?? '—'}`} icon="fingerprint" />
        <Stat label="Storage" value={storagePct === null ? '—' : `${storagePct.toFixed(1)}%`} hint={d.storage_capacity_events ? `of ${num(d.storage_capacity_events)} events` : 'Capacity not reported'} tone={sTone === 'neutral' || sTone === 'info' ? undefined : sTone} icon="sd_card" />
        <Stat label="Uptime" value={uptimeText(latest?.uptimeSeconds)} hint={latest ? `As of ${time(heartbeats[0]!.received_at)}` : 'No heartbeat payload yet'} icon="timer" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md items-start">
        <div className="xl:col-span-8 space-y-space-md">
          <Panel title="Lifecycle" icon="conversion_path" subtitle={LIFECYCLE_INFO[d.lifecycle_state]?.hint}>
            <LifecycleStepper state={d.lifecycle_state} />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-xs mt-space-sm font-label-sm text-label-sm">
              <TimelineItem label="Registered" at={d.created_at} />
              <TimelineItem label="Credentials activated" at={d.credential_issued_at} />
              <TimelineItem label="Activated by operator" at={d.activated_at} />
            </div>
            {d.lifecycle_state === 'provisioned' && d.activation_expires_at && (
              <p className="mt-space-sm text-body-sm text-on-surface-variant">
                Activation code issued; it expires {relative(d.activation_expires_at)} ({dateTime(d.activation_expires_at)}).
              </p>
            )}
          </Panel>

          <TelemetryChart heartbeats={heartbeats} policies={pol} />

          <Panel title="Firmware" icon="memory" actions={<FirmwareLink deviceId={d.id} />}>
            <div className="grid grid-cols-2 gap-space-sm mb-space-sm">
              <div className="p-2 rounded bg-surface-container-lowest">
                <span className="text-outline block text-[9px] uppercase tracking-wider">Installed</span>
                <span className="font-mono font-semibold text-on-surface">{d.firmware_version ?? 'Not reported'}</span>
              </div>
              <div className="p-2 rounded bg-surface-container-lowest">
                <span className="text-outline block text-[9px] uppercase tracking-wider">Previous (rollback target)</span>
                <span className="font-mono text-on-surface-variant">{d.previous_firmware_version ?? '—'}</span>
              </div>
            </div>
            {firmware.length === 0 ? (
              <p className="text-body-sm text-outline">This device has not been part of a firmware deployment.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Deployment</Th>
                    <Th>Version</Th>
                    <Th>State</Th>
                    <Th>Updated</Th>
                  </tr>
                </THead>
                <tbody>
                  {firmware.map((t) => (
                    <Tr key={t.id}>
                      <Td>
                        <Link to={`/firmware/deployments/${t.deployment_id}`} className="text-primary hover:underline">
                          {t.deployment_name}
                        </Link>
                      </Td>
                      <Td className="font-mono">
                        {t.from_version ? `${t.from_version} → ` : ''}
                        {t.version}
                      </Td>
                      <Td>
                        <Badge tone={t.state === 'verified' ? 'success' : t.state === 'failed' ? 'error' : t.state === 'rolled_back' ? 'warning' : 'info'}>{humanize(t.state)}</Badge>
                        {t.error && <div className="text-body-sm text-error mt-0.5">{t.error}</div>}
                      </Td>
                      <Td className="text-outline whitespace-nowrap">{relative(t.updated_at)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        <div className="xl:col-span-4 space-y-space-md">
          <SideToggle id="device-overview-side" label="Device info" />
          <Panel title="Identity" icon="badge">
            <KV label="Device ID" mono>
              {d.device_uid}
            </KV>
            <KV label="Name">{d.name}</KV>
            <KV label="Location">{d.location_id ? <Link to={`/locations/${d.location_id}`} className="text-primary hover:underline">{d.location_name} ({d.location_code})</Link> : 'Unassigned'}</KV>
            <KV label="Time zone">{d.location_timezone ?? '—'}</KV>
            <KV label="Model">{d.model ?? '—'}</KV>
            <KV label="Serial" mono>
              {d.serial_number ?? '—'}
            </KV>
            <KV label="MQTT identity" mono>
              {d.mqtt_username ?? 'Not issued'}
            </KV>
          </Panel>

          <Panel title="Connectivity" icon="lan">
            <KV label="Connection">
              <span className={d.connectivity === 'online' ? 'text-tertiary' : 'text-error'}>{humanize(d.connectivity)}</span>
            </KV>
            <KV label="Last heartbeat">
              <Heartbeat at={d.last_heartbeat_at} offline={off} />
            </KV>
            <KV label="Last IP" mono>
              {d.last_seen_ip ?? '—'}
            </KV>
            <KV label="Last sync">{d.last_sync_at ? `${relative(d.last_sync_at)}` : 'never'}</KV>
            {pol && (
              <KV label="Offline rule">
                {pol.offlineAfterMissedHeartbeats} missed × {pol.heartbeatIntervalSeconds}s heartbeats
              </KV>
            )}
            {latest?.tamper && (
              <KV label="Tamper">
                <Badge tone="error" icon="warning">
                  Enclosure open
                </Badge>
              </KV>
            )}
          </Panel>

          <Panel title="Roster & templates" icon="groups">
            <div className="space-y-space-sm">
              <div className="flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Employee roster</span>
                <RosterVersion device={d} latest={sync.latestRosterVersion} />
              </div>
              <div className="flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Fingerprint templates</span>
                <div className="flex flex-col items-end">
                  <span className="font-label-sm text-label-sm font-mono text-on-surface">
                    v{d.template_version}
                    <span className="text-outline"> / v{sync.latestTemplateVersion}</span>
                  </span>
                  <span className={clsx('font-label-sm text-label-sm flex items-center gap-1', sync.templatesUpToDate ? 'text-tertiary' : 'text-warning')}>
                    <Icon name={sync.templatesUpToDate ? 'check_circle' : 'sync_problem'} className="text-[12px]" />
                    {sync.templatesUpToDate ? 'Up to date' : 'Behind'}
                  </span>
                </div>
              </div>
              <KV label="Employees on roster">{num(d.roster_size ?? 0)}</KV>
              {latest?.enrolledTemplates !== undefined && <KV label="Templates on device">{num(latest.enrolledTemplates)}</KV>}
            </div>
          </Panel>

          <Panel title="Storage" icon="sd_card">
            <StorageGauge pct={d.storage_used_pct} warnPct={pol?.storageWarningPct} critPct={pol?.storageCriticalPct} capacity={d.storage_capacity_events} pending={d.pending_events ?? 0} />
            {pol?.storageFullPolicy && <p className="mt-space-sm text-body-sm text-outline text-center">When full: {pol.storageFullPolicy === 'preserve_oldest' ? 'preserve oldest events (refuse new captures)' : 'keep capturing, recycle oldest delivered records'}.</p>}
          </Panel>

          <Panel title="Open alerts" icon="notifications_active" actions={alerts.length > 0 ? <Badge tone={openAlerts.length ? 'error' : 'neutral'}>{openAlerts.length}</Badge> : undefined}>
            {openAlerts.length === 0 ? (
              <p className="text-body-sm text-outline flex items-center gap-1">
                <Icon name="check_circle" className="text-[16px] text-tertiary" />
                No open alerts for this device.
              </p>
            ) : (
              <div className="space-y-1">
                {openAlerts.map((a) => (
                  <Link key={a.id} to={`/alerts/${a.id}`} className="block p-2 rounded bg-surface-container-lowest hover:bg-surface-container-high">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                      <span className="font-label-sm text-label-sm text-outline">{relative(a.last_occurred_at ?? a.created_at)}</span>
                    </div>
                    <div className="text-body-sm text-on-surface mt-1">{a.title}</div>
                    {a.status === 'acknowledged' && <div className="font-label-sm text-label-sm text-secondary mt-0.5">Acknowledged</div>}
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function TimelineItem({ label, at }: { label: string; at?: string | null }) {
  return (
    <div className="p-2 rounded bg-surface-container-lowest">
      <span className="text-outline block text-[9px] uppercase tracking-wider">{label}</span>
      <span className={at ? 'text-on-surface' : 'text-outline'}>{at ? dateTime(at) : '—'}</span>
    </div>
  );
}

function FirmwareLink({ deviceId }: { deviceId: string }) {
  const { can } = useAuth();
  if (!can('firmware.manage')) return null;
  return (
    <LinkButton to={`/firmware/deploy?deviceId=${deviceId}`} icon="system_update_alt" size="sm">
      Update firmware
    </LinkButton>
  );
}

type Metric = 'storage' | 'pending' | 'uptime';
function TelemetryChart({ heartbeats, policies }: { heartbeats: { received_at: string; payload: any }[]; policies: any }) {
  const [metric, setMetric] = useState<Metric>('storage');
  const points = useMemo(
    () =>
      [...heartbeats].reverse().map((h) => ({
        t: new Date(h.received_at).getTime(),
        storage: typeof h.payload?.storageUsedPct === 'number' ? h.payload.storageUsedPct : null,
        pending: typeof h.payload?.pendingEvents === 'number' ? h.payload.pendingEvents : null,
        uptime: typeof h.payload?.uptimeSeconds === 'number' ? Math.round((h.payload.uptimeSeconds / 3600) * 10) / 10 : null
      })),
    [heartbeats]
  );
  const cfg = {
    storage: { label: 'Storage used (%)', color: chartColors.secondary, unit: '%' },
    pending: { label: 'Events awaiting upload', color: chartColors.warning, unit: '' },
    uptime: { label: 'Uptime (hours)', color: chartColors.tertiary, unit: 'h' }
  }[metric];
  const hasData = points.some((p) => p[metric] !== null);
  return (
    <Panel
      title="Heartbeat telemetry"
      icon="monitoring"
      subtitle={heartbeats.length ? `Last ${heartbeats.length} heartbeat(s) · ${relative(heartbeats[heartbeats.length - 1]!.received_at)} → ${relative(heartbeats[0]!.received_at)}` : undefined}
      actions={
        <Tabs<Metric>
          value={metric}
          onChange={setMetric}
          tabs={[
            { key: 'storage', label: 'Storage' },
            { key: 'pending', label: 'Backlog' },
            { key: 'uptime', label: 'Uptime' }
          ]}
        />
      }
    >
      {!hasData ? (
        <Empty icon="monitoring" title="No telemetry yet." description="Heartbeat payloads appear here once the device reports." />
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tick={chartColors.tick} tickFormatter={(v: number) => time(new Date(v), undefined, false)} stroke={chartColors.grid} />
              <YAxis tick={chartColors.tick} stroke={chartColors.grid} domain={metric === 'storage' ? [0, 100] : ['auto', 'auto']} allowDecimals={metric !== 'pending'} />
              <Tooltip
                {...chartColors.tooltip}
                labelFormatter={(v) => dateTime(new Date(Number(v)))}
                formatter={(v, n) => [`${String(v)}${n === cfg.label ? cfg.unit : '%'}`, String(n)] as [string, string]}
              />
              {metric === 'storage' && policies?.storageWarningPct !== undefined && (
                <Line dataKey={() => policies.storageWarningPct} stroke={chartColors.warning} strokeDasharray="4 4" dot={false} isAnimationActive={false} name="Warning threshold" />
              )}
              <Line type="monotone" dataKey={metric} stroke={cfg.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} name={cfg.label} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

// ───────────────────────── Attendance tab ─────────────────────────
function AttendanceTab({ device }: { device: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const q = useQuery({
    queryKey: ['device-events', device.id, offset],
    queryFn: () => api.get<{ total: number; rows: any[] }>('/api/attendance/events', { deviceId: device.id, limit, offset }),
    enabled: can('attendance.view'),
    placeholderData: (p) => p
  });
  useLiveEvents('attendance/event', (f) => {
    if (f.data?.device_id === device.id) void qc.invalidateQueries({ queryKey: ['device-events', device.id] });
  });
  if (!can('attendance.view')) return <PermissionDenied />;
  return (
    <Panel title="Attendance captured on this device" icon="schedule" subtitle={`Times shown in ${device.location_timezone ?? 'the location time zone'}`} bodyClassName="px-0 pb-0">
      <QueryState q={q} loadingLabel="Loading attendance data..." empty={(d) => (d.rows.length === 0 ? <Empty icon="event_busy" title="No attendance records found." description="Events captured on this terminal appear here in real time." /> : null)}>
        {(d) => (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Captured</Th>
                  <Th>Employee</Th>
                  <Th>Direction</Th>
                  <Th>Match</Th>
                  <Th>Channel</Th>
                  <Th>Received</Th>
                  <Th>Web delivery</Th>
                </tr>
              </THead>
              <tbody>
                {d.rows.map((e) => (
                  <Tr key={e.id} onClick={() => nav(`/attendance/events/${e.id}`)}>
                    <Td className="whitespace-nowrap">
                      <span className="font-mono text-on-surface">{time(e.captured_at, e.location_timezone)}</span>
                      <span className="block font-label-sm text-label-sm text-outline">{date(e.captured_at, e.location_timezone)}</span>
                    </Td>
                    <Td>
                      <span className="text-on-surface">{e.employee_name}</span>
                      <span className="block font-label-sm text-label-sm text-outline font-mono">{e.staff_number}</span>
                    </Td>
                    <Td>
                      <Badge tone={e.direction === 'in' ? 'success' : 'info'} icon={e.direction === 'in' ? 'login' : 'logout'}>
                        {e.direction}
                      </Badge>
                    </Td>
                    <Td className="font-mono">
                      {e.match_score}
                      {e.finger_index ? <span className="block font-label-sm text-label-sm text-outline">{FINGERS[e.finger_index]}</span> : null}
                    </Td>
                    <Td>
                      <span className="font-label-sm text-label-sm text-on-surface-variant">{e.channel === 'mqtt' ? 'Real-time' : 'HTTPS batch'}</span>
                      {e.was_buffered && (
                        <Badge tone="info" className="ml-1">
                          Buffered
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-outline whitespace-nowrap">{relative(e.received_at)}</Td>
                    <Td>
                      <Badge tone={deliveryTone(e.delivery_status)}>{e.delivery_status ? humanize(e.delivery_status) : 'Not queued'}</Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={d.total} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </Panel>
  );
}

// ───────────────────────── Roster tab ─────────────────────────
function RosterTab({ device }: { device: any }) {
  const { can } = useAuth();
  const cmd = useCommand(device);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'missing' | 'no_fingers'>('all');
  const q = useQuery({
    queryKey: ['device-roster', device.id, device.roster_version],
    queryFn: () => api.get<{ rows: any[]; deviceRosterVersion: number; latestRosterVersion: number }>(`/api/devices/${device.id}/roster`)
  });
  const rows = q.data?.rows ?? [];
  const onDevice = rows.filter((r) => r.on_device).length;
  const noFingers = rows.filter((r) => Number(r.fingers) === 0).length;
  const s = search.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'missing' && !r.on_device) || (filter === 'no_fingers' && Number(r.fingers) === 0)) &&
      (!s || r.full_name.toLowerCase().includes(s) || String(r.staff_number).toLowerCase().includes(s) || String(r.department ?? '').toLowerCase().includes(s))
  );
  if (!device.location_id) return <Empty icon="location_off" title="Device is not assigned to a location." description="Assign a location in Actions → Edit device to give it an employee roster." />;
  return (
    <div className="space-y-space-md">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
        <Stat label="Roster (active employees)" value={num(rows.length)} icon="groups" />
        <Stat label="On device" value={num(onDevice)} tone={onDevice === rows.length ? 'success' : 'warning'} hint={`Device v${q.data?.deviceRosterVersion ?? device.roster_version} / latest v${q.data?.latestRosterVersion ?? '—'}`} icon="sim_card_download" />
        <Stat label="Waiting to sync" value={num(rows.length - onDevice)} tone={rows.length - onDevice > 0 ? 'warning' : undefined} icon="sync_problem" />
        <Stat label="No fingerprints" value={num(noFingers)} tone={noFingers > 0 ? 'warning' : 'success'} hint="Need enrolment at a terminal" icon="fingerprint" />
      </div>
      <Panel
        title="Employee roster"
        icon="groups"
        subtitle="Employees come from the web software; the device keeps a complete local copy for offline verification."
        bodyClassName="px-0 pb-0"
        actions={
          <>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-8 w-auto">
              <option value="all">All</option>
              <option value="missing">Not yet on device</option>
              <option value="no_fingers">No fingerprints</option>
            </Select>
            <SearchInput value={search} onChange={setSearch} placeholder="Name, staff no…" className="w-48" />
            {isOperational(device) && can('devices.command.basic') && (
              <Button icon="sync" size="sm" onClick={() => cmd.mutate('sync_roster')} loading={cmd.isPending}>
                Sync roster
              </Button>
            )}
          </>
        }
      >
        <QueryState q={q} loadingLabel="Loading roster…" empty={() => (shown.length === 0 ? <Empty icon="group_off" title={rows.length ? 'No employees match.' : 'No active employees at this location.'} description={rows.length ? undefined : 'Use Employees → Sync from Web Software to import staff.'} /> : null)}>
          {() => (
            <Table>
              <THead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th>Fingerprints</Th>
                  <Th>On device</Th>
                  <Th>Last synced from web</Th>
                </tr>
              </THead>
              <tbody>
                {shown.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      {can('employees.view') ? (
                        <Link to={`/employees/${r.id}`} className="text-on-surface hover:text-primary font-semibold">
                          {r.full_name}
                        </Link>
                      ) : (
                        <span className="text-on-surface font-semibold">{r.full_name}</span>
                      )}
                      <span className="block font-label-sm text-label-sm text-outline font-mono">{r.staff_number}</span>
                    </Td>
                    <Td className="text-on-surface-variant">{r.department ?? '—'}</Td>
                    <Td>
                      <Badge tone={Number(r.fingers) >= 2 ? 'success' : Number(r.fingers) === 1 ? 'warning' : 'neutral'} icon="fingerprint">
                        {r.fingers} enrolled
                      </Badge>
                    </Td>
                    <Td>
                      {r.on_device ? (
                        <Badge tone="success" icon="check">
                          Synced
                        </Badge>
                      ) : (
                        <Badge tone="warning" icon="schedule">
                          Pending v{r.required_version}
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-outline whitespace-nowrap">{r.last_synced_at ? relative(r.last_synced_at) : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

// ───────────────────────── Biometrics tab ─────────────────────────
function BiometricsTab({ device }: { device: any }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['device-biometrics', device.id],
    queryFn: () => api.get<{ templates: any[]; sessions: any[]; coverage: { roster: number; fully_enrolled: number; partial: number; none: number } | null }>(`/api/devices/${device.id}/biometrics`)
  });
  useLiveEvents('enrolment/session', (f) => {
    if (f.data?.device_id === device.id) void qc.invalidateQueries({ queryKey: ['device-biometrics', device.id] });
  });
  useLiveEvents('employee/biometric', (f) => {
    if (f.data?.locationId === device.location_id) void qc.invalidateQueries({ queryKey: ['device-biometrics', device.id] });
  });
  return (
    <QueryState q={q} loadingLabel="Loading biometric data…">
      {(d) => {
        const cov = d.coverage;
        const pctFull = cov && cov.roster ? (cov.fully_enrolled / cov.roster) * 100 : 0;
        return (
          <div className="space-y-space-md">
            {cov ? (
              <Panel title="Location enrolment coverage" icon="fingerprint" subtitle={`${device.location_name} · active employees with fingerprint templates`} actions={<LinkButton to={`/devices/enrolment?deviceId=${device.id}`} size="sm" icon="open_in_new">Enrolment monitor</LinkButton>}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
                  <Stat label="Roster" value={num(cov.roster)} icon="groups" />
                  <Stat label="Fully enrolled" value={num(cov.fully_enrolled)} tone="success" icon="verified" />
                  <Stat label="Partial (1 finger)" value={num(cov.partial)} tone={cov.partial ? 'warning' : undefined} icon="fingerprint" />
                  <Stat label="Not enrolled" value={num(cov.none)} tone={cov.none ? 'error' : undefined} icon="person_off" />
                </div>
                <div className="mt-space-sm flex items-center gap-space-sm">
                  <Progress value={pctFull} tone={pctFull >= 100 ? 'success' : 'primary'} />
                  <span className="font-mono text-body-sm text-on-surface shrink-0">{pctFull.toFixed(0)}%</span>
                </div>
              </Panel>
            ) : (
              <Empty icon="location_off" title="Device is not assigned to a location." />
            )}

            <Panel title="Enrolment sessions on this device" icon="how_to_reg" bodyClassName="px-0 pb-0">
              {d.sessions.length === 0 ? (
                <Empty icon="fingerprint" title="No enrolment sessions yet." description="A supervisor starts a session on the terminal (fingerprint or PIN), selects an employee and captures two fingers." />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Started</Th>
                      <Th>Employee</Th>
                      <Th>Supervisor</Th>
                      <Th>Fingers</Th>
                      <Th>Outcome</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.sessions.map((s) => (
                      <Tr key={s.id}>
                        <Td className="whitespace-nowrap">
                          <span className="text-on-surface">{relative(s.started_at)}</span>
                          <span className="block font-label-sm text-label-sm text-outline">{dateTime(s.started_at)}</span>
                        </Td>
                        <Td>
                          {s.employee_id && s.employee_name ? (
                            can('employees.view') ? (
                              <Link to={`/employees/${s.employee_id}`} className="text-on-surface hover:text-primary">
                                {s.employee_name}
                              </Link>
                            ) : (
                              s.employee_name
                            )
                          ) : (
                            <span className="text-outline">Not selected</span>
                          )}
                          {s.staff_number && <span className="block font-label-sm text-label-sm text-outline font-mono">{s.staff_number}</span>}
                        </Td>
                        <Td>
                          {s.supervisor_name ?? <span className="text-outline">—</span>}
                          {s.authorisation_method && <span className="block font-label-sm text-label-sm text-outline">via {s.authorisation_method === 'pin' ? 'PIN' : 'fingerprint'}</span>}
                        </Td>
                        <Td className="font-mono">{s.fingers_captured}</Td>
                        <Td>
                          <EnrolmentStatusBadge session={s} />
                          {(s.detail || ENROLMENT_STATUS[s.status]) && <div className="text-body-sm text-outline mt-0.5 max-w-xs">{s.detail ?? ENROLMENT_STATUS[s.status]?.message}</div>}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>

            <Panel title="Templates enrolled on this device" icon="fingerprint" subtitle="Encrypted templates in escrow; raw fingerprint images never leave the terminal." bodyClassName="px-0 pb-0">
              {d.templates.length === 0 ? (
                <Empty icon="fingerprint" title="No templates enrolled here yet." />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Employee</Th>
                      <Th>Finger</Th>
                      <Th>Quality</Th>
                      <Th>Authorised by</Th>
                      <Th>Enrolled</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.templates.map((t) => (
                      <Tr key={t.id}>
                        <Td>
                          <span className="text-on-surface">{t.full_name}</span>
                          <span className="block font-label-sm text-label-sm text-outline font-mono">{t.staff_number}</span>
                        </Td>
                        <Td>{FINGERS[t.finger_index] ?? `Finger ${t.finger_index}`}</Td>
                        <Td>
                          <div className="flex items-center gap-2 w-28">
                            <Progress value={t.quality_score} tone={t.quality_score >= 70 ? 'success' : t.quality_score >= 50 ? 'warning' : 'error'} />
                            <span className="font-mono text-body-sm">{t.quality_score}</span>
                          </div>
                        </Td>
                        <Td>
                          {t.authorised_by ?? '—'}
                          <span className="block font-label-sm text-label-sm text-outline">{t.authorisation_method === 'pin' ? 'PIN' : 'Fingerprint'}</span>
                        </Td>
                        <Td className="text-outline whitespace-nowrap">{dateTime(t.enrolled_at)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </div>
        );
      }}
    </QueryState>
  );
}

// ───────────────────────── Logs tab ─────────────────────────
const LEVEL_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'error'> = { debug: 'neutral', info: 'info', warn: 'warning', error: 'error' };

function LogsTab({ device }: { device: any }) {
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const dq = useDebounced(search);
  const limit = 100;
  const q = useQuery({
    queryKey: ['device-logs', device.id, level, dq, offset],
    queryFn: () => api.get<any[]>(`/api/devices/${device.id}/logs`, { level: level || undefined, q: dq || undefined, limit, offset }),
    placeholderData: (p) => p
  });
  const rows = q.data ?? [];
  return (
    <Panel
      title="Device logs"
      icon="terminal"
      subtitle="Uploaded by the terminal over HTTPS"
      bodyClassName="px-0 pb-0"
      actions={
        <>
          <Select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              setOffset(0);
            }}
            className="h-8 w-auto"
          >
            <option value="">All levels</option>
            <option value="error">Error</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </Select>
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setOffset(0);
            }}
            placeholder="Search message…"
            className="w-56"
          />
          <Button size="sm" icon="refresh" onClick={() => q.refetch()} loading={q.isFetching && !q.isLoading}>
            Refresh
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <Loading label="Loading logs…" />
      ) : q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <Empty icon="terminal" title="No log entries." description={level || dq ? 'No entries match these filters.' : 'The device has not uploaded any logs yet.'} />
      ) : (
        <>
          <div className="bg-surface-container-lowest font-mono text-[11px] leading-5 divide-y divide-outline-variant/10">
            {rows.map((l) => (
              <div key={l.id} className="px-space-md py-1">
                <button className="w-full flex items-start gap-space-sm text-left" onClick={() => l.context && setOpen((o) => ({ ...o, [l.id]: !o[l.id] }))}>
                  <span className="text-outline shrink-0 whitespace-nowrap">{dateTime(l.logged_at)}</span>
                  <Badge tone={LEVEL_TONE[l.level] ?? 'neutral'} className="shrink-0">
                    {l.level}
                  </Badge>
                  <span className={clsx('flex-1 min-w-0 break-words', l.level === 'error' ? 'text-error' : l.level === 'warn' ? 'text-warning' : 'text-on-surface-variant')}>{l.message}</span>
                  {l.context && <Icon name={open[l.id] ? 'expand_less' : 'expand_more'} className="text-[16px] text-outline shrink-0" />}
                </button>
                {open[l.id] && <JsonBlock value={l.context} className="my-1" />}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between px-space-md py-space-sm bg-surface-container-lowest/80 font-label-sm text-label-sm text-outline">
            <span>
              Entries {offset + 1}–{offset + rows.length}
            </span>
            <div className="flex gap-1">
              <Button size="sm" icon="chevron_left" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Newer
              </Button>
              <Button size="sm" disabled={rows.length < limit} onClick={() => setOffset(offset + limit)}>
                Older <Icon name="chevron_right" className="text-[15px]" />
              </Button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

// ───────────────────────── Actions tab ─────────────────────────
function ActionsTab({ data }: { data: DeviceDetailResponse }) {
  const { can } = useAuth();
  const d = data.device;
  const cmd = useCommand(d);
  const op = isOperational(d);
  const off = isOffline(d);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [reissue, setReissue] = useState(false);
  const [decom, setDecom] = useState(false);
  const [showResult, setShowResult] = useState<Record<string, boolean>>({});
  const commandKeys = ['sync_roster', 'refresh_status', 'restart', 'send_config', ...(d.previous_firmware_version ? ['rollback_firmware'] : [])];
  const allowed = (c: string) => can(COMMANDS[c]!.level === 'basic' ? 'devices.command.basic' : 'devices.command.advanced');

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md items-start">
      <div className="xl:col-span-8 space-y-space-md">
        <Panel title="Remote commands" icon="bolt" subtitle="Delivered over MQTT; queued while the device is offline">
          {!op && (
            <div className="mb-space-sm p-space-sm rounded bg-surface-container-lowest text-body-sm text-on-surface-variant flex items-center gap-2">
              <Icon name="info" className="text-[16px] text-secondary" />
              Commands are available once the device is connected or active (current state: {LIFECYCLE_INFO[d.lifecycle_state]?.label ?? d.lifecycle_state}).
            </div>
          )}
          {op && off && (
            <div className="mb-space-sm p-space-sm rounded bg-surface-container-lowest text-body-sm text-on-surface-variant flex items-center gap-2">
              <Icon name="cloud_off" className="text-[16px] text-error" />
              The device is offline. Commands are queued and delivered when it reconnects.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
            {commandKeys.map((c) => {
              const info = COMMANDS[c]!;
              const ok = allowed(c);
              return (
                <div key={c} className="p-space-sm rounded bg-surface-container flex items-start gap-space-sm">
                  <div className="w-8 h-8 rounded bg-surface-container-high flex items-center justify-center shrink-0">
                    <Icon name={info.icon} className="text-[18px] text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-body-sm font-semibold text-on-surface">{info.label}</span>
                      <Badge tone={info.level === 'basic' ? 'neutral' : 'info'}>{info.level}</Badge>
                    </div>
                    <p className="text-body-sm text-on-surface-variant mt-0.5">{info.description}</p>
                    {!ok && <p className="font-label-sm text-label-sm text-outline mt-0.5">Requires devices.command.{info.level}</p>}
                  </div>
                  <Button
                    size="sm"
                    disabled={!op || !ok}
                    loading={cmd.isPending && cmd.variables === c}
                    onClick={() => (c === 'restart' || c === 'rollback_firmware' ? setConfirm(c) : cmd.mutate(c))}
                  >
                    Run
                  </Button>
                </div>
              );
            })}
            <div className="p-space-sm rounded bg-surface-container flex items-start gap-space-sm">
              <div className="w-8 h-8 rounded bg-surface-container-high flex items-center justify-center shrink-0">
                <Icon name="system_update_alt" className="text-[18px] text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-body-sm font-semibold text-on-surface">Update firmware</span>
                  <Badge tone="info">advanced</Badge>
                </div>
                <p className="text-body-sm text-on-surface-variant mt-0.5">OTA through a tracked deployment (download → install → restart → verify, automatic rollback on failure).</p>
              </div>
              {can('firmware.manage') ? (
                <LinkButton to={`/firmware/deploy?deviceId=${d.id}`} size="sm">
                  Deploy
                </LinkButton>
              ) : (
                <Button size="sm" disabled>
                  Deploy
                </Button>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Command history" icon="history" subtitle="Last 30 commands · updates live" bodyClassName="px-0 pb-0">
          {data.commands.length === 0 ? (
            <Empty icon="history" title="No commands issued yet." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Command</Th>
                  <Th>Status</Th>
                  <Th>Issued</Th>
                  <Th>Sent</Th>
                  <Th>Acknowledged</Th>
                  <Th>Completed</Th>
                </tr>
              </THead>
              <tbody>
                {data.commands.map((c) => (
                  <Fragment key={c.id}>
                    <Tr onClick={c.result || Object.keys(c.payload ?? {}).length ? () => setShowResult((s) => ({ ...s, [c.id]: !s[c.id] })) : undefined}>
                      <Td>
                        <span className="flex items-center gap-1.5 text-on-surface">
                          <Icon name={COMMANDS[c.command]?.icon ?? 'terminal'} className="text-[15px] text-outline" />
                          {COMMANDS[c.command]?.label ?? c.command}
                        </span>
                        <span className="block font-label-sm text-label-sm text-outline">{c.issued_by_name ?? 'System'}</span>
                      </Td>
                      <Td>
                        <CommandStatusBadge status={c.status} />
                      </Td>
                      <Td className="whitespace-nowrap text-on-surface-variant" >
                        <span title={dateTime(c.issued_at)}>{relative(c.issued_at)}</span>
                      </Td>
                      <Td className="whitespace-nowrap text-outline">{c.sent_at ? time(c.sent_at) : '—'}</Td>
                      <Td className="whitespace-nowrap text-outline">{c.acknowledged_at ? time(c.acknowledged_at) : '—'}</Td>
                      <Td className="whitespace-nowrap text-outline">{c.completed_at ? time(c.completed_at) : '—'}</Td>
                    </Tr>
                    {showResult[c.id] && (
                      <tr className="bg-surface-container-lowest">
                        <td colSpan={6} className="px-space-md py-space-sm">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
                            <div>
                              <span className="font-label-sm text-label-sm text-outline uppercase">Payload</span>
                              <JsonBlock value={c.payload} />
                            </div>
                            <div>
                              <span className="font-label-sm text-label-sm text-outline uppercase">Result</span>
                              <JsonBlock value={c.result} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>

      <div className="xl:col-span-4 space-y-space-md">
        <SideToggle id="device-actions-side" label="Management" />
        <Panel title="Device management" icon="manage_accounts">
          {!can('devices.provision') ? (
            <p className="text-body-sm text-outline">Editing, credentials and decommissioning require the devices.provision permission.</p>
          ) : d.lifecycle_state === 'decommissioned' ? (
            <p className="text-body-sm text-outline">This device is decommissioned.</p>
          ) : (
            <div className="space-y-space-sm">
              <ManageRow icon="edit" title="Edit name / location" text="Moving a device to another location resets its roster and triggers a full roster sync." action={<Button size="sm" onClick={() => setEdit(true)}>Edit</Button>} />
              <ManageRow
                icon="key"
                title="Re-issue credentials"
                text="Revokes the current HMAC secret and MQTT identity immediately and issues a new one-time activation code. The device must be re-activated."
                action={
                  <Button size="sm" onClick={() => setReissue(true)}>
                    Re-issue
                  </Button>
                }
              />
              <ManageRow
                icon="delete_forever"
                danger
                title="Decommission"
                text="Permanently retires the device: credentials and MQTT identity are revoked. Attendance history is kept."
                action={
                  <Button size="sm" variant="danger" onClick={() => setDecom(true)}>
                    Decommission
                  </Button>
                }
              />
            </div>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? `${COMMANDS[confirm]?.label} ${d.name}?` : ''}
        message={confirm === 'restart' ? 'The terminal reboots and is unavailable for fingerprint capture for a short time. Buffered events are kept.' : `The device reinstalls firmware ${d.previous_firmware_version ?? ''}.`}
        confirmLabel={confirm ? COMMANDS[confirm]?.label : 'Confirm'}
        danger
        loading={cmd.isPending}
        onConfirm={() => {
          if (confirm) cmd.mutate(confirm, { onSettled: () => setConfirm(null) });
        }}
      />
      {edit && <EditDeviceModal device={d} onClose={() => setEdit(false)} />}
      {reissue && <ReissueModal device={d} onClose={() => setReissue(false)} />}
      {decom && <DecommissionModal device={d} onClose={() => setDecom(false)} />}
    </div>
  );
}

function ManageRow({ icon, title, text, action, danger }: { icon: string; title: string; text: string; action: ReactNode; danger?: boolean }) {
  return (
    <div className={clsx('p-space-sm rounded flex items-start gap-space-sm', danger ? 'bg-error-container/10' : 'bg-surface-container')}>
      <Icon name={icon} className={clsx('text-[18px] mt-0.5', danger ? 'text-error' : 'text-primary')} />
      <div className="flex-1 min-w-0">
        <div className="text-body-sm font-semibold text-on-surface">{title}</div>
        <p className="text-body-sm text-on-surface-variant">{text}</p>
      </div>
      {action}
    </div>
  );
}

function EditDeviceModal({ device, onClose }: { device: any; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [name, setName] = useState(device.name);
  const [locationId, setLocationId] = useState(device.location_id ?? '');
  const locations = useQuery({ queryKey: ['locations', 'options'], queryFn: () => api.get<any[]>('/api/locations'), enabled: can('locations.view'), staleTime: 60_000 });
  const moved = locationId && locationId !== device.location_id;
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      if (name.trim() !== device.name) body.name = name.trim();
      if (moved) body.locationId = locationId;
      return api.patch(`/api/devices/${device.id}`, body);
    },
    onSuccess: () => {
      toast({ tone: 'success', title: 'Device updated', description: moved ? 'A full roster sync was sent to the device.' : undefined });
      void qc.invalidateQueries({ queryKey: ['device', device.id] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    },
    onError: (e) => errToast(e, 'Update failed')
  });
  const valid = name.trim().length >= 2 && (name.trim() !== device.name || moved);
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit device"
      icon="edit"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => m.mutate()} disabled={!valid} loading={m.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-space-md">
        <Field label="Device name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </Field>
        <Field label="Location" hint={moved ? 'The device roster resets and a full roster sync is sent.' : undefined}>
          {locations.isLoading ? (
            <Loading label="Loading locations…" className="py-2" />
          ) : (
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!can('locations.view')}>
              {!device.location_id && <option value="">Unassigned</option>}
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code})
                </option>
              ))}
              {device.location_id && !(locations.data ?? []).some((l) => l.id === device.location_id) && <option value={device.location_id}>{device.location_name}</option>}
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function ReissueModal({ device, onClose }: { device: any; onClose: () => void }) {
  const qc = useQueryClient();
  const errToast = useErrorToast();
  const [creds, setCreds] = useState<IssuedCredentials | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<IssuedCredentials>(`/api/devices/${device.id}/credentials`),
    onSuccess: (c) => {
      setCreds(c);
      void qc.invalidateQueries({ queryKey: ['device', device.id] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => errToast(e, 'Could not issue credentials')
  });
  return (
    <Modal
      open
      onClose={() => {
        if (!m.isPending) onClose();
      }}
      title={creds ? 'New activation code' : 'Re-issue device credentials'}
      icon="key"
      width="max-w-2xl"
      footer={
        creds ? (
          <>
            <LinkButton to={`/devices/provision?deviceId=${device.id}`} icon="play_arrow">
              Continue in provisioning wizard
            </LinkButton>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => m.mutate()} loading={m.isPending}>
              Revoke & issue new code
            </Button>
          </>
        )
      }
    >
      {creds ? (
        <ActivationCodeCard creds={creds} />
      ) : (
        <div className="space-y-space-sm text-body-md text-on-surface-variant">
          <p>
            <span className="text-on-surface font-semibold">{device.name}</span> (<span className="font-mono">{device.device_uid}</span>) will be disconnected immediately:
          </p>
          <ul className="list-disc pl-5 space-y-1 text-body-sm">
            <li>its HMAC request-signing secret is revoked and its MQTT identity disabled;</li>
            <li>it returns to the Provisioned state until the new code is entered on the terminal;</li>
            <li>events captured meanwhile stay buffered on the device and upload after re-activation.</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}

function DecommissionModal({ device, onClose }: { device: any; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const errToast = useErrorToast();
  const [typed, setTyped] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/api/devices/${device.id}/decommission`, { confirmUid: typed }),
    onSuccess: () => {
      toast({ tone: 'success', title: `${device.name} decommissioned`, description: 'Credentials and MQTT identity revoked.' });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      qc.removeQueries({ queryKey: ['device', device.id] });
      nav('/devices');
    },
    onError: (e) => errToast(e, 'Decommission failed')
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Decommission device"
      icon="warning"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => m.mutate()} disabled={typed !== device.device_uid} loading={m.isPending}>
            Decommission
          </Button>
        </>
      }
    >
      <div className="space-y-space-md">
        <p className="text-body-md text-on-surface-variant">
          This permanently retires <span className="text-on-surface font-semibold">{device.name}</span>. Its credentials and MQTT identity are revoked and it disappears from the registry.
          {(device.pending_events ?? 0) > 0 && (
            <span className="block mt-1 text-warning">
              The device still reports {num(device.pending_events)} event(s) not yet uploaded — they will be lost unless uploaded first.
            </span>
          )}
        </p>
        <Field label={`Type the device ID "${device.device_uid}" to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={device.device_uid} className="font-mono" autoFocus />
        </Field>
      </div>
    </Modal>
  );
}
