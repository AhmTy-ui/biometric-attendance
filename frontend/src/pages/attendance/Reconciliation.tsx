import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorState,
  Icon,
  LinkButton,
  Loading,
  PageHeader,
  Pagination,
  Panel,
  Progress,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, num, relative } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { DELIVERY_LABEL, EventTable } from './components';

type QueueTab = 'dead_letter' | 'retrying';
const PAGE = 50;

export default function Reconciliation() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [globalLoc] = useGlobalLocation();
  const [tab, setTab] = useState<QueueTab>('dead_letter');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const canRedeliver = can('attendance.redeliver');

  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [tab, globalLoc]);

  const summary = useQuery<any>({ queryKey: ['delivery-summary'], queryFn: () => api.get('/api/attendance/delivery/summary'), refetchInterval: 30_000 });
  const integ = useQuery<any>({ queryKey: ['integration-status'], queryFn: () => api.get('/api/integration/status'), enabled: can('integration.view'), staleTime: 60_000 });
  const queue = useQuery<any>({
    queryKey: ['attendance-queue', tab, globalLoc, offset],
    queryFn: () => api.get('/api/attendance/events', { status: tab, locationId: globalLoc ?? undefined, limit: PAGE, offset, sort: 'captured_asc' }),
    refetchInterval: 30_000
  });

  // delivery/updated frames: refresh the queue (throttled) — rows leave the DLQ when a replay succeeds.
  const lastRefresh = useRef(0);
  useLiveEvents('delivery/updated', () => {
    if (Date.now() - lastRefresh.current > 2000) {
      lastRefresh.current = Date.now();
      void qc.invalidateQueries({ queryKey: ['attendance-queue'] });
    }
  });

  const replay = useMutation({
    mutationFn: (body: { eventIds?: string[]; allDeadLetter?: boolean }) => api.post<{ replayed: number }>('/api/attendance/delivery/replay', body),
    onSuccess: (r) => {
      toast({
        tone: r.replayed ? 'success' : 'info',
        title: r.replayed ? `${num(r.replayed)} event(s) re-queued for delivery` : 'Nothing to replay',
        description: r.replayed ? 'They are being re-sent to the web software now. Progress updates live below.' : 'The selected events are no longer in the dead-letter or retry queue.'
      });
      setSelected(new Set());
      setConfirmAll(false);
      void qc.invalidateQueries({ queryKey: ['attendance-queue'] });
      void qc.invalidateQueries({ queryKey: ['delivery-summary'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => errorToast(e, 'Replay failed')
  });

  const exportNow = useMutation({
    mutationFn: () => api.post<any>('/api/attendance/export-now'),
    onSuccess: (r) => {
      if (r?.skipped) toast({ tone: 'info', title: 'Export not run', description: r.reason });
      else toast({ tone: 'success', title: `Export completed · ${num(r?.exported ?? 0)} event(s)`, description: r?.fileName ? `File: ${r.fileName}` : 'No pending events to export.' });
      void qc.invalidateQueries({ queryKey: ['delivery-summary'] });
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      void qc.invalidateQueries({ queryKey: ['attendance-queue'] });
    },
    onError: (e) => errorToast(e, 'Export failed')
  });

  const by = summary.data?.byStatus ?? {};
  const dlq = by.dead_letter ?? 0;
  const retrying = by.retrying ?? 0;
  const backlog = (by.pending ?? 0) + (by.delivering ?? 0) + retrying;
  const mode: string | undefined = integ.data?.config?.deliveryMode;
  const rows: any[] = queue.data?.rows ?? [];

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((i) => (on ? n.add(i) : n.delete(i)));
      return n;
    });

  return (
    <>
      <PageHeader
        title="Reconciliation & DLQ"
        icon="published_with_changes"
        subtitle="Attendance that is stored in the platform but not yet accepted by the web software — retries, dead-letter queue and offline device uploads."
        crumbs={[{ label: 'Attendance' }, { label: 'Reconciliation & DLQ' }]}
        actions={
          <>
            <LinkButton to="/attendance/live" icon="stream">
              Live feed
            </LinkButton>
            {canRedeliver && dlq > 0 && (
              <Button variant="primary" icon="restart_alt" onClick={() => setConfirmAll(true)}>
                Replay all dead-letter ({num(dlq)})
              </Button>
            )}
          </>
        }
      />

      {/* Delivery mode notices */}
      {mode === 'scheduled_export' && (
        <Notice tone="info" icon="file_export" title="Delivery mode: scheduled file export">
          Attendance is delivered to the web software as a file every {num(integ.data?.config?.exportEveryMinutes)} minute(s). Pending and retrying events are included in the next export.
          {integ.data?.attendanceExport?.lastRun && (
            <> Last export {relative(integ.data.attendanceExport.lastRun.finished_at ?? integ.data.attendanceExport.lastRun.started_at)} ({integ.data.attendanceExport.lastRun.status}).</>
          )}
          {canRedeliver && (
            <div className="mt-space-sm">
              <Button size="sm" variant="primary" icon="play_arrow" loading={exportNow.isPending} onClick={() => exportNow.mutate()}>
                Run export now
              </Button>
            </div>
          )}
        </Notice>
      )}
      {mode === 'disabled' && (
        <Notice tone="warning" icon="block" title="Web-software delivery is disabled">
          New attendance events are stored in the platform but are not queued for delivery.{' '}
          {can('settings.view') && (
            <Link to="/settings" className="text-primary hover:underline">
              Review integration settings →
            </Link>
          )}
        </Notice>
      )}
      {mode === 'api' && integ.data?.config && !integ.data.config.configured && (
        <Notice tone="warning" icon="link_off" title="Web-software API is not configured">
          Events are queued but cannot be delivered until the integration base URL is set.{' '}
          {can('integration.view') && (
            <Link to="/integration" className="text-primary hover:underline">
              Open Integration & Sync →
            </Link>
          )}
        </Notice>
      )}

      {/* Summary strip */}
      {summary.isLoading ? (
        <Loading label="Loading attendance data..." />
      ) : summary.error && !summary.data ? (
        <Panel>
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Panel>
      ) : (
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-md">
          <Stat label="Dead-letter queue" icon="report" tone={dlq ? 'error' : 'success'} value={num(dlq)} hint={dlq ? 'Needs administrator action' : 'Queue is empty'} />
          <Stat label="Retrying" icon="autorenew" tone={retrying ? 'warning' : undefined} value={num(retrying)} hint={summary.data?.nextRetryAt ? `Next retry ${relative(summary.data.nextRetryAt)}` : 'No retries scheduled'} />
          <Stat label="Pending" icon="schedule" tone="info" value={num((by.pending ?? 0) + (by.delivering ?? 0))} hint={`${num(by.delivering ?? 0)} delivering now`} />
          <Stat label="Delivered" icon="done_all" tone="success" value={num(by.delivered ?? 0)} />
          <Stat label="Exported" icon="file_export" value={num(by.exported ?? 0)} hint="Scheduled file export" />
          <Stat
            label="Oldest undelivered"
            icon="hourglass_top"
            tone={backlog ? 'warning' : undefined}
            value={summary.data?.oldestPendingCapturedAt ? relative(summary.data.oldestPendingCapturedAt) : '—'}
            hint={summary.data?.oldestPendingCapturedAt ? `Captured ${dateTime(summary.data.oldestPendingCapturedAt)}` : 'Nothing outstanding'}
          />
        </section>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-gutter items-start">
        {/* Queue */}
        <Panel
          className="xl:col-span-8"
          title="Undelivered events"
          icon="report_problem"
          subtitle="Events safely recorded in the platform but rejected or timed out during delivery to the web software."
          bodyClassName="px-0 pb-0"
        >
          <div className="px-space-md pb-space-sm flex flex-wrap items-center justify-between gap-space-sm">
            <Tabs<QueueTab>
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'dead_letter', label: DELIVERY_LABEL.dead_letter!, icon: 'report', count: dlq },
                { key: 'retrying', label: DELIVERY_LABEL.retrying!, icon: 'autorenew', count: retrying }
              ]}
            />
            {canRedeliver && (
              <div className="flex items-center gap-space-xs">
                {selected.size > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear ({selected.size})
                  </Button>
                )}
                <Button size="sm" variant="primary" icon="replay" disabled={selected.size === 0} loading={replay.isPending && !confirmAll} onClick={() => replay.mutate({ eventIds: [...selected] })}>
                  Replay selected ({selected.size})
                </Button>
              </div>
            )}
          </div>
          {queue.isLoading ? (
            <Loading label="Loading attendance data..." />
          ) : queue.error && !queue.data ? (
            <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
          ) : rows.length === 0 ? (
            <Empty
              title={tab === 'dead_letter' ? 'The dead-letter queue is empty.' : 'No events are waiting for a retry.'}
              icon="task_alt"
              description="All captured attendance is either delivered or in the normal delivery queue."
            />
          ) : (
            <>
              <EventTable
                rows={rows}
                compact
                selectable={canRedeliver}
                selected={selected}
                onToggle={toggle}
                onToggleAll={toggleAll}
                actions={
                  canRedeliver
                    ? (ev) => (
                        <Button size="sm" variant={tab === 'dead_letter' ? 'danger' : 'secondary'} icon="bolt" disabled={replay.isPending} onClick={() => replay.mutate({ eventIds: [ev.id] })}>
                          Retry now
                        </Button>
                      )
                    : undefined
                }
              />
              <Pagination total={queue.data?.total ?? 0} limit={PAGE} offset={offset} onChange={setOffset} />
            </>
          )}
        </Panel>

        {/* Top errors */}
        <Panel className="xl:col-span-4" title="Why deliveries fail" icon="bug_report" subtitle="Dead-letter and retrying events grouped by the web software's response">
          {summary.data?.topErrors?.length ? (
            <ul className="space-y-space-sm">
              {summary.data.topErrors.map((e: any, i: number) => (
                <li key={i} className="bg-surface-container rounded p-space-sm border-l-2 border-l-error">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone="error">{e.last_http_status ? `HTTP ${e.last_http_status}` : 'No response'}</Badge>
                    <span className="font-mono text-label-lg text-on-surface font-semibold">{num(e.n)}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-on-surface-variant break-words">{e.last_error ?? 'No error detail recorded'}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body-sm text-outline py-space-sm">No delivery errors at the moment.</p>
          )}
          <p className="mt-space-md font-body-sm text-body-sm text-outline">
            Rejected events are retried automatically; after repeated rejections they move to the dead-letter queue and an administrator alert is raised. Replaying
            re-sends the same event ID, so the web software never records a duplicate.
          </p>
        </Panel>
      </section>

      <DeviceReconciliation />

      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => replay.mutate({ allDeadLetter: true })}
        loading={replay.isPending}
        title="Replay all dead-letter events?"
        message={
          <>
            All {num(dlq)} event(s) in the dead-letter queue{globalLoc ? ' you can access' : ''} will be re-sent to the web software now. Make sure the cause of the rejection
            (shown under “Why deliveries fail”) has been corrected first.
          </>
        }
        confirmLabel={`Replay ${num(dlq)} event(s)`}
      />
    </>
  );
}

function Notice({ tone, icon, title, children }: { tone: 'info' | 'warning'; icon: string; title: string; children: ReactNode }) {
  return (
    <section className={clsx('bg-surface-container-low border-l-4 rounded-lg p-space-md shadow-sm flex items-start gap-space-sm', tone === 'info' ? 'border-secondary-container' : 'border-warning')}>
      <Icon name={icon} className={clsx('text-[24px] shrink-0 mt-0.5', tone === 'info' ? 'text-secondary' : 'text-warning')} />
      <div className="min-w-0">
        <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
        <div className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{children}</div>
      </div>
    </section>
  );
}

// ───────────────────────── Offline / buffered device reconciliation ─────────────────────────
interface ReconcileProgress {
  deviceId: string;
  deviceName: string;
  locationId?: string;
  uploaded: number;
  remaining: number;
  complete: boolean;
  at: string;
}

function DeviceReconciliation() {
  const { can } = useAuth();
  const [globalLoc] = useGlobalLocation();
  const allowed = can('devices.view');
  const devices = useQuery<any>({
    queryKey: ['devices', { reconciliation: true, locationId: globalLoc }],
    queryFn: () => api.get('/api/devices', { locationId: globalLoc ?? undefined, limit: 1000 }),
    enabled: allowed,
    refetchInterval: 60_000
  });
  const [progress, setProgress] = useState<Record<string, ReconcileProgress>>({});

  useLiveEvents('device/reconcile', (f) => {
    const d = f.data ?? {};
    if (!d.deviceId) return;
    if (globalLoc && d.locationId && d.locationId !== globalLoc) return;
    setProgress((p) => {
      const prev = p[d.deviceId];
      const carried = prev && !prev.complete ? prev.uploaded : 0;
      return {
        ...p,
        [d.deviceId]: {
          deviceId: d.deviceId,
          deviceName: d.deviceName ?? prev?.deviceName ?? 'Device',
          locationId: d.locationId,
          uploaded: carried + Number(d.uploaded ?? 0),
          remaining: Number(d.remaining ?? 0),
          complete: Boolean(d.complete),
          at: f.at ?? new Date().toISOString()
        }
      };
    });
  });

  const list = useMemo(() => {
    const rows: any[] = (devices.data?.rows ?? []).filter(
      (d: any) => ['connected', 'active'].includes(d.lifecycle_state) && (d.connectivity === 'offline' || Number(d.pending_events) > 0)
    );
    const ids = new Set(rows.map((r) => r.id));
    const extra = Object.values(progress).filter((p) => !ids.has(p.deviceId));
    return { rows, extra };
  }, [devices.data, progress]);

  if (!allowed) return null;

  return (
    <Panel
      title="Device reconciliation"
      icon="cloud_sync"
      subtitle="Devices keep recording while offline and upload buffered events (oldest first) when the connection returns."
      actions={
        <LinkButton size="sm" to="/devices" icon="router">
          Device registry
        </LinkButton>
      }
      bodyClassName="px-0 pb-0"
    >
      {devices.isLoading ? (
        <Loading label="Loading devices…" />
      ) : devices.error && !devices.data ? (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} compact />
      ) : list.rows.length === 0 && list.extra.length === 0 ? (
        <Empty title="All devices are online with nothing buffered." icon="cloud_done" />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Device</Th>
              <Th>Location</Th>
              <Th>Status</Th>
              <Th>Last seen</Th>
              <Th className="text-right">Buffered events</Th>
              <Th className="text-right">Employees affected</Th>
              <Th>Reconciliation</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </THead>
          <tbody className="text-on-surface">
            {list.rows.map((d: any) => (
              <Tr key={d.id} className={d.connectivity === 'offline' ? 'bg-error-container/5' : undefined}>
                <Td className="whitespace-nowrap">
                  <div className="font-semibold">{d.name}</div>
                  <div className="font-mono text-[10px] text-outline">{d.device_uid}</div>
                </Td>
                <Td className="whitespace-nowrap">{d.location_name ?? 'Unassigned'}</Td>
                <Td>
                  {d.connectivity === 'offline' ? (
                    <Badge tone="error" icon="cloud_off">
                      Device offline
                    </Badge>
                  ) : (
                    <Badge tone="info" icon="cloud_sync">
                      Online · uploading
                    </Badge>
                  )}
                </Td>
                <Td className="whitespace-nowrap font-mono text-[11px]">
                  <div>{relative(d.last_heartbeat_at)}</div>
                  <div className="text-outline text-[10px]">{dateTime(d.last_heartbeat_at, d.location_timezone ?? undefined)}</div>
                </Td>
                <Td className="text-right font-mono">{num(d.pending_events)}</Td>
                <Td className="text-right font-mono">{num(d.roster_size)}</Td>
                <Td className="min-w-[220px]">
                  <ReconcileCell device={d} p={progress[d.id]} />
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    <LinkButton size="sm" to={`/devices/${d.id}`}>
                      View Device
                    </LinkButton>
                    {d.location_id && can('locations.view') && (
                      <LinkButton size="sm" variant="ghost" to={`/locations/${d.location_id}`}>
                        View Location
                      </LinkButton>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
            {list.extra.map((p) => (
              <Tr key={p.deviceId}>
                <Td className="whitespace-nowrap font-semibold">{p.deviceName}</Td>
                <Td className="text-outline">—</Td>
                <Td>
                  <Badge tone="success" icon="check_circle">
                    Online
                  </Badge>
                </Td>
                <Td className="font-mono text-[11px]">{relative(p.at)}</Td>
                <Td className="text-right font-mono">{num(p.remaining)}</Td>
                <Td className="text-right text-outline">—</Td>
                <Td className="min-w-[220px]">
                  <ReconcileCell p={p} />
                </Td>
                <Td className="text-right">
                  <LinkButton size="sm" to={`/devices/${p.deviceId}`}>
                    View Device
                  </LinkButton>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function ReconcileCell({ device, p }: { device?: any; p?: ReconcileProgress }) {
  if (p) {
    const total = p.uploaded + p.remaining;
    const pct = total ? (p.uploaded / total) * 100 : 100;
    return (
      <div className="flex flex-col gap-1">
        <span className={clsx('font-label-sm text-label-sm flex items-center gap-1', p.complete ? 'text-tertiary' : 'text-secondary')}>
          <Icon name={p.complete ? 'task_alt' : 'progress_activity'} className={clsx('text-[14px]', !p.complete && 'animate-spin')} />
          {p.complete ? 'Reconciliation complete' : 'Uploading buffered events'}
        </span>
        <Progress value={pct} tone={p.complete ? 'success' : 'info'} />
        <span className="font-mono text-[10px] text-outline">
          {num(p.uploaded)} / {num(total)} uploaded · {relative(p.at)}
        </span>
      </div>
    );
  }
  if (device?.connectivity === 'offline')
    return (
      <span className="font-label-sm text-label-sm text-outline flex items-center gap-1">
        <Icon name="hourglass_empty" className="text-[14px]" /> Waiting for connection — {num(device.pending_events)} event(s) stored on device
      </span>
    );
  return (
    <span className="font-label-sm text-label-sm text-secondary flex items-center gap-1">
      <Icon name="wifi" className="text-[14px]" /> Connection restored → uploading {num(device?.pending_events)} buffered event(s)
    </span>
  );
}
