import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Empty,
  ErrorState,
  Icon,
  Input,
  LinkButton,
  Loading,
  Pagination,
  PageHeader,
  SearchInput,
  Select,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  useDebounced
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, num, relative } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { DeviceDot, DeviceStatusBadge, Heartbeat, OfflineCard, RosterVersion, StorageBar, isOffline, isOperational, useNow } from './components';

type StatusTab = 'all' | 'online' | 'offline' | 'warning' | 'pending';
const LIMIT = 50;

interface DevicesResponse {
  total: number;
  limit: number;
  offset: number;
  rows: any[];
  summary: { online: number; offline: number; warning: number; pending: number; total: number; buffered_events: number };
}

/** Merge a live `device/status` frame into any cached device list. */
function patchRows(old: DevicesResponse | undefined, d: any): DevicesResponse | undefined {
  if (!old || !Array.isArray(old.rows)) return old;
  let hit = false;
  const rows = old.rows.map((r) => {
    if (r.id !== d.id) return r;
    hit = true;
    const { locationId: _l, ...rest } = d;
    return { ...r, ...rest, latest_roster_version: r.latest_roster_version };
  });
  return hit ? { ...old, rows } : old;
}

export default function DeviceRegistry() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [globalLoc] = useGlobalLocation();
  const status = (params.get('status') as StatusTab) || 'all';
  const [locationId, setLocationId] = useState<string>(params.get('locationId') ?? globalLoc ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [firmware, setFirmware] = useState(params.get('firmware') ?? '');
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q);
  const dfw = useDebounced(firmware);
  useNow();

  const firstScope = useRef(true);
  useEffect(() => {
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    setLocationId(globalLoc ?? '');
  }, [globalLoc]);
  useEffect(() => setOffset(0), [status, locationId, dq, dfw]);

  const filters = { status: status === 'all' ? undefined : status, locationId: locationId || undefined, q: dq || undefined, firmware: dfw || undefined, limit: LIMIT, offset };
  const list = useQuery({
    queryKey: ['devices', filters],
    queryFn: () => api.get<DevicesResponse>('/api/devices', filters),
    placeholderData: (prev) => prev
  });
  const offline = useQuery({
    queryKey: ['devices', { status: 'offline', locationId: locationId || undefined, limit: 10, panel: true }],
    queryFn: () => api.get<DevicesResponse>('/api/devices', { status: 'offline', locationId: locationId || undefined, limit: 10 })
  });
  const locations = useQuery({
    queryKey: ['locations', 'options'],
    queryFn: () => api.get<any[]>('/api/locations'),
    enabled: can('locations.view'),
    staleTime: 60_000
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<any>('/api/settings'),
    enabled: can('settings.view'),
    staleTime: 60_000
  });
  const pol = settings.data?.device_policies as { storageWarningPct?: number; storageCriticalPct?: number } | undefined;

  // Live: patch rows in place, and show buffered-upload progress per device.
  const [reconciling, setReconciling] = useState<Record<string, { remaining: number; uploaded: number; complete: boolean; at: number }>>({});
  useLiveEvents('device/status', (f) => {
    const d = f.data;
    if (!d?.id) return;
    qc.setQueriesData<DevicesResponse>({ queryKey: ['devices'] }, (old) => patchRows(old, d));
  });
  useLiveEvents('device/reconcile', (f) => {
    const d = f.data;
    if (!d?.deviceId) return;
    setReconciling((s) => {
      const prev = s[d.deviceId];
      const uploaded = (prev && !prev.complete ? prev.uploaded : 0) + Number(d.uploaded ?? 0);
      return { ...s, [d.deviceId]: { remaining: Number(d.remaining ?? 0), uploaded, complete: Boolean(d.complete), at: Date.now() } };
    });
  });

  const setStatus = (s: StatusTab) => {
    const next = new URLSearchParams(params);
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    setParams(next, { replace: true });
  };

  const summary = list.data?.summary;
  const rows = list.data?.rows ?? [];
  const storageWarnings = rows.filter(
    (r) => isOperational(r) && r.storage_used_pct !== null && pol?.storageWarningPct !== undefined && Number(r.storage_used_pct) >= pol.storageWarningPct
  );

  return (
    <div className="p-gutter space-y-gutter">
      <PageHeader
        icon="router"
        title="Device Registry"
        crumbs={[{ label: 'Devices' }, { label: 'Registry' }]}
        subtitle={
          summary ? (
            <span className="flex flex-wrap items-center gap-x-space-sm">
              <span>{num(summary.total)} device(s) registered</span>
              <span>•</span>
              <span>{num(summary.buffered_events)} buffered event(s) awaiting upload</span>
            </span>
          ) : (
            'Fingerprint terminals: connectivity, health, firmware, roster and storage.'
          )
        }
        actions={
          <>
            <Button icon="refresh" onClick={() => void qc.invalidateQueries({ queryKey: ['devices'] })} loading={list.isFetching && !list.isLoading}>
              Refresh
            </Button>
            {can('enrolment.view') && (
              <LinkButton to="/devices/enrolment" icon="fingerprint">
                Enrolment
              </LinkButton>
            )}
            {can('devices.provision') && (
              <LinkButton to="/devices/provision" icon="add_circle" variant="primary">
                Add / Provision device
              </LinkButton>
            )}
          </>
        }
      />

      {/* Telemetry cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-md">
        <SummaryCard label="Online" icon="wifi" tone="success" value={summary?.online} hint="Connected and healthy" active={status === 'online'} onClick={() => setStatus('online')} />
        <SummaryCard
          label="Offline"
          icon="cloud_off"
          tone="error"
          value={summary?.offline}
          hint={summary ? `${num(summary.buffered_events)} buffered event(s) fleet-wide` : undefined}
          active={status === 'offline'}
          onClick={() => setStatus('offline')}
        />
        <SummaryCard label="Warning" icon="warning" tone="warning" value={summary?.warning} hint="Storage or upload backlog" active={status === 'warning'} onClick={() => setStatus('warning')} />
        <SummaryCard label="Pending activation" icon="hourglass_top" tone="neutral" value={summary?.pending} hint="Pending · provisioned · awaiting activation" active={status === 'pending'} onClick={() => setStatus('pending')} />
      </div>

      {/* Filter bar */}
      <div className="p-space-sm rounded bg-surface-container shadow-sm flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-space-sm">
        <Tabs<StatusTab>
          value={status}
          onChange={setStatus}
          tabs={[
            { key: 'all', label: 'All', count: summary?.total },
            { key: 'online', label: 'Online', icon: 'wifi', count: summary?.online },
            { key: 'offline', label: 'Offline', icon: 'cloud_off', count: summary?.offline },
            { key: 'warning', label: 'Warning', icon: 'warning', count: summary?.warning },
            { key: 'pending', label: 'Pending Activation', icon: 'hourglass_top', count: summary?.pending }
          ]}
        />
        <div className="flex items-center gap-space-xs flex-wrap">
          <SearchInput value={q} onChange={setQ} placeholder="Name, device ID, serial…" className="min-w-[200px] flex-1" />
          {can('locations.view') && (
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-8 w-auto min-w-[160px]">
              <option value="">All locations</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.devices})
                </option>
              ))}
            </Select>
          )}
          <Input value={firmware} onChange={(e) => setFirmware(e.target.value)} placeholder="Firmware (exact)" className="h-8 w-36" />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md items-start">
        {/* Registry table */}
        <div className="xl:col-span-8 overflow-hidden rounded bg-surface-container shadow-md">
          {list.isLoading ? (
            <Loading label="Loading devices…" />
          ) : list.error && !list.data ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : rows.length === 0 ? (
            <Empty
              icon="router"
              title="No devices found."
              description={status !== 'all' || dq || dfw || locationId ? 'No device matches these filters.' : 'Provision a fingerprint terminal to start capturing attendance.'}
              action={
                can('devices.provision') && status === 'all' && !dq ? (
                  <LinkButton to="/devices/provision" icon="add_circle" variant="primary">
                    Add / Provision device
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <Th>Device</Th>
                    <Th>Location</Th>
                    <Th>Status</Th>
                    <Th>Last heartbeat</Th>
                    <Th>Firmware</Th>
                    <Th>Roster version</Th>
                    <Th>Pending events</Th>
                    <Th>Storage</Th>
                  </tr>
                </THead>
                <tbody className="text-on-surface">
                  {rows.map((d) => {
                    const off = isOffline(d);
                    const rec = reconciling[d.id];
                    return (
                      <Tr key={d.id} onClick={() => nav(`/devices/${d.id}`)} className={clsx('group', off && 'bg-error-container/10')}>
                        <Td>
                          <div className="flex items-center gap-2">
                            <DeviceDot device={d} />
                            <div className="flex flex-col min-w-0">
                              <span className={clsx('font-body-sm text-body-sm font-semibold group-hover:text-primary truncate', off ? 'text-error' : 'text-on-surface')}>{d.name}</span>
                              <span className="font-label-sm text-label-sm text-outline font-mono truncate">{d.device_uid}</span>
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <div className="flex flex-col">
                            <span className="text-on-surface">{d.location_name ?? <span className="text-outline">Unassigned</span>}</span>
                            <span className="font-label-sm text-label-sm text-outline font-mono">{d.last_seen_ip ?? d.model ?? ''}</span>
                          </div>
                        </Td>
                        <Td>
                          <div className="flex flex-col gap-0.5 items-start">
                            <DeviceStatusBadge device={d} />
                            {off && (
                              <span className="font-label-sm text-label-sm text-outline whitespace-nowrap" title={dateTime(d.last_heartbeat_at)}>
                                Last seen {relative(d.last_heartbeat_at)} · {num(d.roster_size ?? 0)} employees affected
                              </span>
                            )}
                            {d.lifecycle_state === 'provisioned' && d.activation_expires_at && (
                              <span className="font-label-sm text-label-sm text-outline whitespace-nowrap">Code expires {relative(d.activation_expires_at)}</span>
                            )}
                          </div>
                        </Td>
                        <Td>
                          <Heartbeat at={d.last_heartbeat_at} offline={off} />
                        </Td>
                        <Td>
                          <span className="font-label-sm text-label-sm text-on-surface font-mono">{d.firmware_version ?? '—'}</span>
                        </Td>
                        <Td>{isOperational(d) ? <RosterVersion device={d} latest={d.latest_roster_version} /> : <span className="text-outline">—</span>}</Td>
                        <Td>
                          {rec && !rec.complete && Date.now() - rec.at < 120_000 ? (
                            <span className="flex items-center gap-1 font-label-sm text-label-sm text-secondary">
                              <Icon name="cloud_sync" className="text-[13px] animate-pulse" />
                              Uploading · {num(rec.remaining)} left
                            </span>
                          ) : (d.pending_events ?? 0) > 0 ? (
                            <span className={clsx('px-1.5 py-0.5 rounded bg-surface-container-lowest font-label-sm text-label-sm font-mono font-semibold', off ? 'text-secondary' : 'text-warning')}>
                              {num(d.pending_events)} {off ? 'BUFFERED' : 'PENDING'}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-outline font-label-sm text-label-sm">
                              <Icon name="check_circle" className="text-[13px] text-tertiary" />0
                            </span>
                          )}
                        </Td>
                        <Td>
                          <StorageBar pct={d.storage_used_pct} capacity={d.storage_capacity_events} warnPct={pol?.storageWarningPct} critPct={pol?.storageCriticalPct} health={d.health} />
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              <Pagination total={list.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
            </>
          )}
        </div>

        {/* Right column: offline devices (user flow §14 / §30) and storage warnings (§15) */}
        <div className="xl:col-span-4 space-y-space-md">
          <div className="flex items-center justify-between px-1">
            <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">Offline devices</span>
            {(offline.data?.total ?? 0) > 0 && (
              <button className="font-label-sm text-label-sm text-primary hover:underline" onClick={() => setStatus('offline')}>
                View all {num(offline.data?.total)}
              </button>
            )}
          </div>
          {offline.isLoading ? (
            <Loading label="Checking connectivity…" />
          ) : offline.error && !offline.data ? (
            <ErrorState error={offline.error} onRetry={() => offline.refetch()} compact />
          ) : (offline.data?.rows.length ?? 0) === 0 ? (
            <div className="p-space-md rounded bg-surface-container shadow-sm flex items-center gap-space-sm">
              <Icon name="wifi" className="text-tertiary text-[22px]" />
              <div>
                <div className="font-headline-sm text-headline-sm text-on-surface">All active devices are reporting</div>
                <p className="text-body-sm text-on-surface-variant">No connected or active device has missed its heartbeats.</p>
              </div>
            </div>
          ) : (
            offline.data!.rows.map((d) => <OfflineCard key={d.id} device={d} />)
          )}

          {storageWarnings.length > 0 && (
            <div className="p-space-md rounded bg-surface-container shadow-md space-y-space-sm">
              <div className="flex items-center gap-2">
                <Icon name="sd_card_alert" className="text-warning text-[20px]" />
                <span className="font-headline-sm text-headline-sm text-on-surface">Storage approaching capacity</span>
              </div>
              <p className="text-body-sm text-on-surface-variant">
                Devices on this page at or above the {pol?.storageWarningPct}% warning threshold. The device keeps capturing; restore connectivity so events upload.
              </p>
              <div className="space-y-1">
                {storageWarnings.map((d) => (
                  <button key={d.id} onClick={() => nav(`/devices/${d.id}`)} className="w-full p-2 rounded bg-surface-container-lowest hover:bg-surface-container-high flex items-center justify-between gap-space-sm text-left">
                    <div className="min-w-0">
                      <span className="block text-body-sm text-on-surface font-semibold truncate">{d.name}</span>
                      <span className="block font-label-sm text-label-sm text-outline truncate">
                        {d.location_name ?? 'Unassigned'} · {num(d.pending_events)} pending
                      </span>
                    </div>
                    <StorageBar pct={d.storage_used_pct} warnPct={pol?.storageWarningPct} critPct={pol?.storageCriticalPct} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, hint, icon, tone, active, onClick }: { label: string; value?: number; hint?: string; icon: string; tone: 'success' | 'error' | 'warning' | 'neutral'; active: boolean; onClick: () => void }) {
  const color = tone === 'success' ? 'text-tertiary' : tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-on-surface';
  const chip = tone === 'success' ? 'bg-tertiary-container/30 text-tertiary' : tone === 'error' ? 'bg-error-container/40 text-error' : tone === 'warning' ? 'bg-warning-container/60 text-warning' : 'bg-surface-container-high text-on-surface-variant';
  return (
    <button
      onClick={onClick}
      className={clsx('p-space-md rounded bg-surface-container shadow-sm flex flex-col justify-between text-left hover:bg-surface-container-high transition-colors', active && 'ring-1 ring-primary-container')}
    >
      <div className="flex items-center justify-between w-full">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">{label}</span>
        <span className={clsx('flex items-center px-1.5 py-0.5 rounded', chip)}>
          <Icon name={icon} className="text-[13px]" />
        </span>
      </div>
      <div className="mt-space-sm">
        <span className={clsx('font-headline-xl text-headline-xl font-semibold font-mono', color)}>{value === undefined ? '—' : num(value)}</span>
      </div>
      {hint && <div className="mt-space-xs font-label-sm text-label-sm text-outline">{hint}</div>}
    </button>
  );
}
