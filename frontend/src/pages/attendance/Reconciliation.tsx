import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorState,
  Icon,
  LinkButton,
  LiveDot,
  Loading,
  PageHeader,
  Pagination,
  Panel,
  Progress,
  SearchInput,
  Stat,
  StatusPill,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  pillStatusOf,
  useDebounced,
  useErrorToast,
  useToast,
  type Tone
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { date, dateTime, num, relative, time } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { DELIVERY_LABEL, DirectionBadge, EmployeeCell } from './components';

type QueueTab = 'dead_letter' | 'retrying';
const PAGE = 50;

/** Re-renders every `ms` so relative times ("4 seconds ago") stay current. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export default function Reconciliation() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [globalLoc] = useGlobalLocation();
  const [tab, setTab] = useState<QueueTab>('dead_letter');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const dSearch = useDebounced(search.trim(), 300);
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [confirmAll, setConfirmAll] = useState(false);
  const canRedeliver = can('attendance.redeliver');

  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [tab, globalLoc, dSearch, sortAsc]);

  const summary = useQuery<any>({ queryKey: ['delivery-summary', globalLoc], queryFn: () => api.get('/api/attendance/delivery/summary', { locationId: globalLoc ?? undefined }), refetchInterval: 30_000 });
  const integ = useQuery<any>({ queryKey: ['integration-status'], queryFn: () => api.get('/api/integration/status'), enabled: can('integration.view'), staleTime: 60_000 });
  const queue = useQuery<any>({
    queryKey: ['attendance-queue', tab, globalLoc, offset, dSearch, sortAsc],
    queryFn: () =>
      api.get('/api/attendance/events', {
        status: tab,
        locationId: globalLoc ?? undefined,
        q: dSearch || undefined,
        limit: PAGE,
        offset,
        sort: sortAsc ? 'captured_asc' : 'captured_desc'
      }),
    refetchInterval: 30_000,
    placeholderData: (prev: any) => prev
  });
  const rows: any[] = queue.data?.rows ?? [];

  // delivery/updated frames: refresh the queue (throttled) — rows leave the DLQ when a replay succeeds — and confirm
  // outcomes for events currently on screen.
  const lastRefresh = useRef(0);
  const visibleIds = useRef(new Set<string>());
  visibleIds.current = new Set(rows.map((r) => r.id));
  const lastToast = useRef(0);
  useLiveEvents('delivery/updated', (f) => {
    const id = f.data?.eventId ?? f.data?.id;
    const status = f.data?.status;
    if (id && visibleIds.current.has(id) && Date.now() - lastToast.current > 1500) {
      if (status === 'delivered') {
        lastToast.current = Date.now();
        toast({ tone: 'success', title: 'Attendance event delivered', description: 'The web software accepted the event.' });
      } else if (status === 'dead_letter') {
        lastToast.current = Date.now();
        toast({ tone: 'error', title: 'Event delivery failed', description: f.data?.error ?? 'The event was moved to the dead-letter queue.' });
      }
    }
    if (id) setInFlight((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s));
    if (Date.now() - lastRefresh.current > 2000) {
      lastRefresh.current = Date.now();
      void qc.invalidateQueries({ queryKey: ['attendance-queue'] });
    }
  });

  const replay = useMutation({
    mutationFn: (body: { eventIds?: string[]; allDeadLetter?: boolean }) => api.post<{ replayed: number }>('/api/attendance/delivery/replay', body),
    onMutate: (body) => {
      if (body.eventIds) setInFlight((s) => new Set([...s, ...body.eventIds!]));
    },
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
    onError: (e, body) => {
      if (body.eventIds) setInFlight((s) => new Set([...s].filter((x) => !body.eventIds!.includes(x))));
      errorToast(e, 'Replay failed');
    }
  });
  // Rows stop showing "processing" once the queue refreshes without them in flight.
  useEffect(() => {
    if (!inFlight.size) return;
    const t = setTimeout(() => setInFlight(new Set()), 15_000);
    return () => clearTimeout(t);
  }, [inFlight]);

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
  const pending = (by.pending ?? 0) + (by.delivering ?? 0);
  const undelivered = pending + retrying + dlq;
  const today = summary.data?.today ?? { delivered: 0, failed: 0 };
  const mode: string | undefined = integ.data?.config?.deliveryMode;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <PageHeader
        title="Event Reconciliation"
        icon="sync_problem"
        subtitle="Attendance that is safely stored in the platform but not yet accepted by the web software. Retry failed deliveries, clear the dead-letter queue and watch devices upload events they buffered while offline."
        crumbs={[{ label: 'Attendance' }, { label: 'Reconciliation' }]}
        actions={
          <>
            <LinkButton to="/attendance/live" icon="sensors">
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

      <HealthBar loading={summary.isLoading} dlq={dlq} retrying={retrying} pending={pending} nextRetryAt={summary.data?.nextRetryAt} oldest={summary.data?.oldestPendingCapturedAt} updatedAt={summary.dataUpdatedAt} />

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

      {/* Summary */}
      {summary.error && !summary.data ? (
        <Panel>
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Panel>
      ) : (
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-space-md">
          {summary.isLoading ? (
            Array.from({ length: 5 }, (_, i) => <StatSkeleton key={i} />)
          ) : (
            <>
              <Stat
                label="Undelivered events"
                icon="pending_actions"
                tone={undelivered ? 'warning' : 'success'}
                value={num(undelivered)}
                hint={undelivered ? `${num(pending)} pending · ${num(retrying)} retrying · ${num(dlq)} DLQ` : 'Everything delivered'}
              />
              <Stat label="Dead-letter queue" icon="report" tone={dlq ? 'error' : 'success'} value={num(dlq)} hint={dlq ? 'Needs administrator action' : 'Queue is empty'} />
              <Stat
                label="Retrying"
                icon="autorenew"
                tone={retrying ? 'warning' : undefined}
                value={num(retrying)}
                hint={summary.data?.nextRetryAt ? `Next retry ${relative(summary.data.nextRetryAt)}` : 'No retries scheduled'}
              />
              <Stat
                label="Delivered today"
                icon="done_all"
                tone="success"
                value={num(today.delivered)}
                hint={`${num(by.delivered ?? 0)} delivered · ${num(by.exported ?? 0)} exported all-time`}
              />
              <Stat label="Failed today" icon="error" tone={today.failed ? 'error' : undefined} value={num(today.failed)} hint={today.failed ? 'Moved to the dead-letter queue today' : 'No failures since midnight'} />
            </>
          )}
        </section>
      )}

      {/* Event queue */}
        <Panel title="Event queue" icon="list_alt" subtitle="Events rejected by or timed out at the web software, oldest first." bodyClassName="px-0 pb-0">
          <div className="px-space-md pb-3 flex flex-wrap items-center gap-2">
            <Tabs<QueueTab>
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'dead_letter', label: DELIVERY_LABEL.dead_letter!, icon: 'report', count: dlq },
                { key: 'retrying', label: DELIVERY_LABEL.retrying!, icon: 'autorenew', count: retrying }
              ]}
            />
            <SearchInput value={search} onChange={setSearch} placeholder="Search employee, event ID, device…" className="flex-1 min-w-[200px] max-w-xs" />
            <Button size="sm" variant="ghost" icon={sortAsc ? 'arrow_upward' : 'arrow_downward'} onClick={() => setSortAsc((s) => !s)} title="Sort by capture time">
              {sortAsc ? 'Oldest first' : 'Newest first'}
            </Button>
          </div>

          {/* Bulk action bar */}
          {canRedeliver && selected.size > 0 && (
            <div className="reveal mx-space-md mb-3 flex items-center justify-between gap-2 rounded-lg bg-primary/[0.07] shadow-[inset_0_0_0_1px_rgba(92,200,255,0.2)] px-3 py-2">
              <span className="text-body-sm text-on-surface">
                <span className="font-semibold tabular">{selected.size}</span> selected
              </span>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <Button size="sm" variant="primary" icon="replay" loading={replay.isPending && !confirmAll} onClick={() => replay.mutate({ eventIds: [...selected] })}>
                  Replay selected
                </Button>
              </div>
            </div>
          )}

          {queue.isLoading ? (
            <Loading label="Loading the event queue…" className="px-space-md" />
          ) : queue.error && !queue.data ? (
            <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
          ) : rows.length === 0 ? (
            dSearch ? (
              <Empty icon="search_off" title={`No queued events match “${dSearch}”`} description="Try an employee name, staff number, event ID or device." />
            ) : (
              <Empty
                tone="success"
                icon="check"
                title="All systems operational"
                description={
                  tab === 'dead_letter'
                    ? 'No failed attendance events are waiting for reconciliation.'
                    : 'No attendance events are waiting for a retry — deliveries are going through first time.'
                }
              />
            )
          ) : (
            <div className={clsx('transition-opacity duration-200', queue.isFetching && queue.isPlaceholderData && 'opacity-60')}>
              <Table maxHeight={600}>
                <THead>
                  <tr>
                    {canRedeliver && (
                      <Th className="w-10 pr-0">
                        <input
                          type="checkbox"
                          aria-label="Select all events on this page"
                          checked={allOn}
                          onChange={(e) =>
                            setSelected((s) => {
                              const n = new Set(s);
                              rows.forEach((r) => (e.target.checked ? n.add(r.id) : n.delete(r.id)));
                              return n;
                            })
                          }
                        />
                      </Th>
                    )}
                    <Th>Event ID</Th>
                    <Th>Employee</Th>
                    <Th>Device</Th>
                    <Th>Location</Th>
                    <Th>Timestamp</Th>
                    <Th>Event type</Th>
                    <Th>Delivery status</Th>
                    <Th className="text-right">Retries</Th>
                    <Th>Last attempt</Th>
                    {canRedeliver && <Th className="text-right">Actions</Th>}
                  </tr>
                </THead>
                <tbody className="text-on-surface">
                  {rows.map((ev) => (
                    <QueueRow
                      key={ev.id}
                      ev={ev}
                      selectable={canRedeliver}
                      selected={selected.has(ev.id)}
                      onToggle={toggle}
                      processing={inFlight.has(ev.id)}
                      onRetry={canRedeliver ? () => replay.mutate({ eventIds: [ev.id] }) : undefined}
                      retryDisabled={replay.isPending}
                    />
                  ))}
                </tbody>
              </Table>
              <Pagination total={queue.data?.total ?? 0} limit={PAGE} offset={offset} onChange={setOffset} />
            </div>
          )}
        </Panel>

      <DeliveryHealth summary={summary.data} loading={summary.isLoading} />

      <DeviceMonitoring />

      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => replay.mutate({ allDeadLetter: true })}
        loading={replay.isPending}
        title="Replay all dead-letter events?"
        message={
          <>
            All {num(dlq)} event(s) in the dead-letter queue{globalLoc ? ' you can access' : ''} will be re-sent to the web software now. Make sure the cause of the rejection
            (shown under “Delivery health”) has been corrected first.
          </>
        }
        confirmLabel={`Replay ${num(dlq)} event(s)`}
      />
    </>
  );
}

function StatSkeleton() {
  return (
    <div className="card rounded-xl p-4 flex flex-col gap-3 h-[118px]" aria-hidden>
      <div className="flex justify-between">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-7 w-7 rounded-md" />
      </div>
      <div className="skeleton h-6 w-16" />
      <div className="skeleton h-2.5 w-32" />
    </div>
  );
}

/** One-line system state under the header: overall health, next retry and how fresh the numbers are. */
function HealthBar({ loading, dlq, retrying, pending, nextRetryAt, oldest, updatedAt }: { loading: boolean; dlq: number; retrying: number; pending: number; nextRetryAt?: string | null; oldest?: string | null; updatedAt: number }) {
  useNow(10_000);
  if (loading) return <div className="skeleton h-11 rounded-xl" aria-hidden />;
  const state: { tone: Tone; title: string; text: string } = dlq
    ? { tone: 'error', title: 'Action required', text: `${num(dlq)} event(s) failed delivery and are waiting in the dead-letter queue.` }
    : retrying
      ? { tone: 'warning', title: 'Recovering', text: `${num(retrying)} event(s) are being retried automatically — no action needed yet.` }
      : { tone: 'success', title: 'All systems operational', text: pending ? `${num(pending)} event(s) are moving through the normal delivery queue.` : 'Every captured event has been delivered.' };
  const ring: Record<string, string> = {
    error: 'shadow-[inset_0_0_0_1px_rgba(255,122,122,0.25)] bg-error/[0.05]',
    warning: 'shadow-[inset_0_0_0_1px_rgba(245,184,74,0.22)] bg-warning/[0.05]',
    success: 'shadow-[inset_0_0_0_1px_rgba(61,220,151,0.18)] bg-tertiary/[0.04]'
  };
  return (
    <div role="status" className={clsx('rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1', ring[state.tone])}>
      <LiveDot tone={state.tone} pulse={state.tone !== 'success'} label={<span className="font-semibold">{state.title}</span>} />
      <span className="text-body-sm text-on-surface-variant flex-1 min-w-[200px]">{state.text}</span>
      <span className="flex items-center gap-3 text-[11.5px] text-outline tabular">
        {nextRetryAt && (
          <span className="flex items-center gap-1">
            <Icon name="schedule" className="text-[14px]" /> Next retry {relative(nextRetryAt)}
          </span>
        )}
        {oldest && (
          <span className="flex items-center gap-1" title={`Captured ${dateTime(oldest)}`}>
            <Icon name="hourglass_top" className="text-[14px]" /> Oldest undelivered {relative(oldest)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Icon name="update" className="text-[14px]" /> Updated {relative(new Date(updatedAt))}
        </span>
      </span>
    </div>
  );
}

function QueueRow({ ev, selectable, selected, onToggle, processing, onRetry, retryDisabled }: { ev: any; selectable: boolean; selected: boolean; onToggle: (id: string) => void; processing: boolean; onRetry?: () => void; retryDisabled: boolean }) {
  const navigate = useNavigate();
  const status = processing ? 'processing' : pillStatusOf(ev.delivery_status);
  return (
    <Tr onClick={() => navigate(`/attendance/events/${ev.id}`)} className={clsx(selected && 'bg-primary/[0.05]', ev.delivery_status === 'dead_letter' && !selected && 'bg-error/[0.025]')}>
      {selectable && (
        <Td className="w-10 pr-0">
          <input type="checkbox" aria-label={`Select event ${ev.event_uid}`} checked={selected} onClick={(e) => e.stopPropagation()} onChange={() => onToggle(ev.id)} />
        </Td>
      )}
      <Td className="whitespace-nowrap">
        <span className="font-mono text-[11.5px] text-on-surface-variant" title={ev.event_uid}>
          {ev.event_uid.length > 14 ? `${ev.event_uid.slice(0, 6)}…${ev.event_uid.slice(-6)}` : ev.event_uid}
        </span>
      </Td>
      <Td className="whitespace-nowrap">
        <EmployeeCell ev={ev} />
      </Td>
      <Td className="whitespace-nowrap">
        <div className="text-body-sm text-on-surface">{ev.device_name ?? '—'}</div>
        <div className="font-mono text-[10.5px] text-outline">{ev.device_uid}</div>
      </Td>
      <Td className="whitespace-nowrap text-on-surface-variant">{ev.location_name ?? '—'}</Td>
      <Td className="whitespace-nowrap">
        <div title={`${dateTime(ev.captured_at, ev.location_timezone ?? undefined)}${ev.location_timezone ? ` · ${ev.location_timezone}` : ''}`}>
          <div className="font-mono text-[12.5px] text-on-surface">{time(ev.captured_at, ev.location_timezone ?? undefined)}</div>
          <div className="text-[11px] text-outline">{date(ev.captured_at, ev.location_timezone ?? undefined)}</div>
        </div>
      </Td>
      <Td className="whitespace-nowrap">
        <DirectionBadge direction={ev.direction} />
      </Td>
      <Td className="whitespace-nowrap">
        <div className="flex flex-col items-start gap-1">
          <StatusPill status={status} />
          {!processing && ev.delivery_error && (
            <span className="font-mono text-[10.5px] text-outline max-w-[150px] truncate" title={ev.delivery_error}>
              {ev.delivery_http_status ? `HTTP ${ev.delivery_http_status} · ` : ''}
              {ev.delivery_error}
            </span>
          )}
        </div>
      </Td>
      <Td className="text-right font-mono tabular text-on-surface-variant">{num(ev.delivery_attempts ?? 0)}</Td>
      <Td className="whitespace-nowrap text-[12px] text-on-surface-variant" >
        <span title={ev.delivery_last_attempt_at ? dateTime(ev.delivery_last_attempt_at) : undefined}>{ev.delivery_last_attempt_at ? relative(ev.delivery_last_attempt_at) : '—'}</span>
        {ev.delivery_status === 'retrying' && ev.next_attempt_at && <div className="text-[10.5px] text-outline">next {relative(ev.next_attempt_at)}</div>}
      </Td>
      {onRetry && (
        <Td className="text-right whitespace-nowrap">
          <div onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant={ev.delivery_status === 'dead_letter' ? 'subtle' : 'secondary'} icon="replay" disabled={retryDisabled || processing} onClick={onRetry}>
              Retry
            </Button>
          </div>
        </Td>
      )}
    </Tr>
  );
}

function Notice({ tone, icon, title, children }: { tone: 'info' | 'warning'; icon: string; title: string; children: ReactNode }) {
  return (
    <section className="card rounded-xl p-space-md flex items-start gap-3 relative overflow-hidden">
      <span className={clsx('absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full', tone === 'info' ? 'bg-secondary' : 'bg-warning')} />
      <span className={clsx('flex items-center justify-center w-8 h-8 rounded-lg shrink-0 ring-1 ring-inset', tone === 'info' ? 'bg-secondary/10 text-secondary ring-secondary/20' : 'bg-warning/10 text-warning ring-warning/25')}>
        <Icon name={icon} className="text-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
        <div className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">{children}</div>
      </div>
    </section>
  );
}

// ───────────────────────── Delivery health diagnostics ─────────────────────────
/** Explains a failure class from the web software's response (HTTP status) in operator terms. */
function diagnose(status: number | null | undefined): { icon: string; reason: string; guidance: string } {
  if (status === null || status === undefined)
    return { icon: 'wifi_off', reason: 'No response (network or timeout)', guidance: 'The web software could not be reached or did not answer in time. Check its availability and the network path; retries continue automatically.' };
  if (status === 401 || status === 403)
    return { icon: 'key_off', reason: 'Credentials rejected', guidance: 'The web software refused the integration credentials. Update the API key under Integration settings, then replay the affected events.' };
  if (status === 404) return { icon: 'link_off', reason: 'Endpoint not found', guidance: 'The delivery endpoint returned 404. Verify the integration base URL and path.' };
  if (status === 429) return { icon: 'speed', reason: 'Rate limited', guidance: 'The web software is throttling requests. Retries back off automatically; no action is usually needed.' };
  if (status === 409 || status === 422 || status === 400)
    return {
      icon: 'rule',
      reason: 'Payload rejected',
      guidance: 'The web software rejected the event content — commonly an employee or location that is not mapped in the web software. Fix the mapping, then replay.'
    };
  if (status >= 500) return { icon: 'dns', reason: 'Web software error', guidance: 'The web software returned a server error. Retries continue automatically; persistent errors should be raised with its operators.' };
  return { icon: 'help', reason: `Unexpected response`, guidance: 'The web software answered with an unexpected status. Inspect the error detail below.' };
}

function DeliveryHealth({ summary, loading }: { summary: any; loading: boolean }) {
  const errors: any[] = summary?.topErrors ?? [];
  const total = errors.reduce((a, e) => a + Number(e.n), 0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <Panel
      title="Delivery health"
      icon="monitor_heart"
      subtitle="Why deliveries are failing, grouped by the web software's response."
      actions={total ? <span className="text-[12px] text-outline tabular">{num(total)} failing event(s)</span> : undefined}
    >
      {loading ? (
        <Loading label="Analysing failures…" rows={3} />
      ) : errors.length === 0 ? (
        <Empty tone="success" icon="check" title="Deliveries are healthy" description="No events are currently failing or retrying." />
      ) : (
        <>
          {/* Share of failures by reason */}
          <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-white/[0.06] mb-4" role="img" aria-label="Share of failing events by reason">
            {errors.map((e, i) => (
              <span key={i} className={clsx('h-full', i === 0 ? 'bg-error' : i === 1 ? 'bg-warning' : 'bg-outline')} style={{ width: `${(Number(e.n) / total) * 100}%` }} />
            ))}
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
            {errors.map((e, i) => {
              const d = diagnose(e.last_http_status);
              const pct = total ? (Number(e.n) / total) * 100 : 0;
              const critical = pct >= 50;
              const expanded = open.has(i);
              return (
                <li key={i} className="rounded-lg bg-white/[0.02] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() =>
                      setOpen((o) => {
                        const n = new Set(o);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                    aria-expanded={expanded}
                    className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/[0.025] transition-colors"
                  >
                    <span className={clsx('flex items-center justify-center w-8 h-8 rounded-lg shrink-0 ring-1 ring-inset', critical ? 'bg-error/10 text-error ring-error/25' : 'bg-warning/10 text-warning ring-warning/25')}>
                      <Icon name={d.icon} className="text-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-on-surface truncate">{d.reason}</span>
                        <span className="font-mono text-[10.5px] text-outline shrink-0">{e.last_http_status ? `HTTP ${e.last_http_status}` : 'no status'}</span>
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <Progress value={pct} tone={critical ? 'error' : 'warning'} className="h-1 flex-1" />
                        <span className="text-[11px] text-outline tabular w-9 text-right">{pct.toFixed(0)}%</span>
                      </span>
                    </span>
                    <span className="flex flex-col items-end shrink-0">
                      <span className="text-[15px] font-semibold tabular text-on-surface">{num(e.n)}</span>
                      <span className={clsx('text-[10.5px] font-semibold uppercase tracking-wide', critical ? 'text-error' : 'text-warning')}>{critical ? 'Critical' : 'Warning'}</span>
                    </span>
                    <Icon name="expand_more" className={clsx('text-[18px] text-outline transition-transform duration-200', expanded && 'rotate-180')} />
                  </button>
                  {expanded && (
                    <div className="reveal px-3 pb-3 flex flex-col gap-2">
                      <p className="text-body-sm text-on-surface-variant">{d.guidance}</p>
                      <pre className="well rounded-md p-2 font-mono text-[11px] leading-4 text-on-surface-variant whitespace-pre-wrap break-words">{e.last_error ?? 'No error detail recorded'}</pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="mt-4 pt-3 border-t border-white/[0.05] font-body-sm text-body-sm text-outline max-w-4xl">
        Rejected events are retried automatically; after repeated rejections they move to the dead-letter queue and an administrator alert is raised. Replaying re-sends the same
        event ID, so the web software never records a duplicate.
      </p>
    </Panel>
  );
}

// ───────────────────────── Device monitoring & offline reconciliation ─────────────────────────
interface ReconcileProgress {
  deviceId: string;
  deviceName: string;
  locationId?: string;
  uploaded: number;
  remaining: number;
  complete: boolean;
  at: string;
}

/** Connection quality from heartbeat freshness (devices heartbeat every ~30s by default). */
function linkQuality(d: any): { bars: number; label: string; tone: Tone } {
  if (d.connectivity === 'offline') return { bars: 0, label: 'No connection', tone: 'error' };
  const age = d.last_heartbeat_at ? (Date.now() - new Date(d.last_heartbeat_at).getTime()) / 1000 : Infinity;
  if (d.health === 'critical') return { bars: 1, label: 'Unstable', tone: 'error' };
  if (age > 120 || d.health === 'warning') return { bars: 2, label: 'Degraded', tone: 'warning' };
  if (age > 60) return { bars: 3, label: 'Good', tone: 'success' };
  return { bars: 4, label: 'Excellent', tone: 'success' };
}

function SignalBars({ bars, tone }: { bars: number; tone: Tone }) {
  const color = tone === 'error' ? 'bg-error' : tone === 'warning' ? 'bg-warning' : 'bg-tertiary';
  return (
    <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={clsx('w-[3px] rounded-sm transition-colors duration-300', b <= bars ? color : 'bg-white/10')} style={{ height: `${b * 25}%` }} />
      ))}
    </span>
  );
}

type DeviceFilter = 'attention' | 'all';

function DeviceMonitoring() {
  const { can } = useAuth();
  const [globalLoc] = useGlobalLocation();
  const allowed = can('devices.view');
  useNow(5_000);
  const devices = useQuery<any>({
    queryKey: ['devices', { reconciliation: true, locationId: globalLoc }],
    queryFn: () => api.get('/api/devices', { locationId: globalLoc ?? undefined, limit: 1000 }),
    enabled: allowed,
    refetchInterval: 30_000
  });
  const [progress, setProgress] = useState<Record<string, ReconcileProgress>>({});
  const [filter, setFilter] = useState<DeviceFilter | null>(null);
  const toast = useToast();

  useLiveEvents('device/reconcile', (f) => {
    const d = f.data ?? {};
    if (!d.deviceId) return;
    if (globalLoc && d.locationId && d.locationId !== globalLoc) return;
    if (d.complete) toast({ tone: 'success', title: 'Device synchronized', description: `${d.deviceName ?? 'A device'} finished uploading its buffered events.` });
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
  // Warn only on a real online → offline transition of a device shown here.
  const lastConn = useRef(new Map<string, string>());
  useEffect(() => {
    for (const d of devices.data?.rows ?? []) if (!lastConn.current.has(d.id)) lastConn.current.set(d.id, d.connectivity);
  }, [devices.data]);
  useLiveEvents('device/status', (f) => {
    const d = f.data ?? {};
    if (!d.id) return;
    const prev = lastConn.current.get(d.id);
    lastConn.current.set(d.id, d.connectivity);
    if (prev === 'online' && d.connectivity === 'offline' && d.lifecycle_state === 'active')
      toast({ tone: 'warning', title: 'Device connection unstable', description: `${d.name} stopped sending heartbeats and is now offline.` });
  });

  const list = useMemo(() => {
    const active: any[] = (devices.data?.rows ?? []).filter((d: any) => ['connected', 'active'].includes(d.lifecycle_state));
    const needs = (d: any) => d.connectivity === 'offline' || Number(d.pending_events) > 0 || d.health === 'warning' || d.health === 'critical';
    const rank = (d: any) => (d.connectivity === 'offline' ? 0 : Number(d.pending_events) > 0 ? 1 : d.health !== 'healthy' ? 2 : 3);
    const sorted = [...active].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
    const attention = sorted.filter(needs);
    const ids = new Set(active.map((r) => r.id));
    const extra = Object.values(progress).filter((p) => !ids.has(p.deviceId));
    return { all: sorted, attention, extra };
  }, [devices.data, progress]);

  if (!allowed) return null;
  const effective: DeviceFilter = filter ?? (list.attention.length ? 'attention' : 'all');
  const rows = effective === 'attention' ? list.attention : list.all;
  const online = list.all.filter((d) => d.connectivity === 'online').length;
  const buffered = list.all.reduce((a, d) => a + Number(d.pending_events ?? 0), 0);

  return (
    <Panel
      title="Device monitoring"
      icon="memory"
      subtitle="Devices keep recording while offline and upload buffered events (oldest first) when the connection returns."
      actions={
        <LinkButton size="sm" to="/devices" icon="open_in_new" variant="ghost">
          Device registry
        </LinkButton>
      }
      bodyClassName="px-0 pb-0"
    >
      <div className="px-space-md pb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs<DeviceFilter>
          value={effective}
          onChange={setFilter}
          tabs={[
            { key: 'attention', label: 'Needs attention', icon: 'priority_high', count: list.attention.length },
            { key: 'all', label: 'All devices', icon: 'memory', count: list.all.length }
          ]}
        />
        {!devices.isLoading && list.all.length > 0 && (
          <div className="flex items-center gap-4 text-[12px] text-outline tabular">
            <LiveDot tone={online === list.all.length ? 'success' : 'warning'} pulse={false} label={<span className="text-on-surface-variant">{online}/{list.all.length} online</span>} />
            <span className="flex items-center gap-1">
              <Icon name="inventory_2" className="text-[14px]" /> {num(buffered)} buffered
            </span>
          </div>
        )}
      </div>
      {devices.isLoading ? (
        <Loading label="Loading devices…" className="px-space-md" />
      ) : devices.error && !devices.data ? (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} compact />
      ) : rows.length === 0 && list.extra.length === 0 ? (
        effective === 'attention' ? (
          <Empty tone="success" icon="check" title="All devices are online with nothing buffered" description="Every active device is sending heartbeats and has delivered its events." />
        ) : (
          <Empty icon="memory" title="No active devices" description="Devices appear here once they are provisioned and activated." />
        )
      ) : (
        <Table maxHeight={520}>
          <THead>
            <tr>
              <Th>Device</Th>
              <Th>Location</Th>
              <Th>Status</Th>
              <Th>Last sync</Th>
              <Th className="text-right">Buffered</Th>
              <Th>Connection</Th>
              <Th>Reconciliation</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </THead>
          <tbody className="text-on-surface">
            {rows.map((d: any) => {
              const q = linkQuality(d);
              const offline = d.connectivity === 'offline';
              return (
                <Tr key={d.id} className={offline ? 'bg-error/[0.025]' : undefined}>
                  <Td className="whitespace-nowrap">
                    <div className="font-medium">{d.name}</div>
                    <div className="font-mono text-[10.5px] text-outline">{d.device_uid}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-on-surface-variant">
                    {d.location_id && can('locations.view') ? (
                      <Link to={`/locations/${d.location_id}`} className="hover:text-primary hover:underline underline-offset-2">
                        {d.location_name}
                      </Link>
                    ) : (
                      d.location_name ?? 'Unassigned'
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <LiveDot tone={offline ? 'error' : d.health === 'healthy' ? 'success' : 'warning'} pulse={!offline} label={offline ? 'Offline' : d.health === 'healthy' ? 'Online' : 'Online · warning'} />
                    <div className="mt-0.5 text-[11px] text-outline" title={d.last_heartbeat_at ? dateTime(d.last_heartbeat_at, d.location_timezone ?? undefined) : undefined}>
                      Last heartbeat: {relative(d.last_heartbeat_at)}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-[12px] text-on-surface-variant">
                    <span title={d.last_sync_at ? dateTime(d.last_sync_at, d.location_timezone ?? undefined) : undefined}>{relative(d.last_sync_at)}</span>
                  </Td>
                  <Td className={clsx('text-right font-mono tabular', Number(d.pending_events) > 0 ? 'text-warning' : 'text-outline')}>{num(d.pending_events)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-2 text-[12px] text-on-surface-variant">
                      <SignalBars bars={q.bars} tone={q.tone} />
                      {q.label}
                    </span>
                  </Td>
                  <Td className="min-w-[220px]">
                    <ReconcileCell device={d} p={progress[d.id]} />
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <LinkButton size="sm" to={`/devices/${d.id}`}>
                      View Device
                    </LinkButton>
                  </Td>
                </Tr>
              );
            })}
            {list.extra.map((p) => (
              <Tr key={p.deviceId}>
                <Td className="whitespace-nowrap font-medium">{p.deviceName}</Td>
                <Td className="text-outline">—</Td>
                <Td>
                  <LiveDot tone="success" label="Online" />
                </Td>
                <Td className="text-[12px] text-on-surface-variant">{relative(p.at)}</Td>
                <Td className="text-right font-mono tabular">{num(p.remaining)}</Td>
                <Td className="text-outline">—</Td>
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
        <span className={clsx('text-[12px] font-medium flex items-center gap-1', p.complete ? 'text-tertiary' : 'text-primary')}>
          <Icon name={p.complete ? 'check_circle' : 'progress_activity'} fill={p.complete} className={clsx('text-[14px]', p.complete ? 'check-pop' : 'animate-spin')} />
          {p.complete ? 'Synchronized' : 'Uploading buffered events'}
        </span>
        <Progress value={pct} tone={p.complete ? 'success' : 'primary'} />
        <span className="font-mono text-[10.5px] text-outline">
          {num(p.uploaded)} / {num(total)} uploaded · {relative(p.at)}
        </span>
      </div>
    );
  }
  if (device?.connectivity === 'offline')
    return (
      <span className="text-[12px] text-outline flex items-center gap-1">
        <Icon name="hourglass_empty" className="text-[14px]" /> Waiting for connection — {num(device.pending_events)} event(s) stored on device
      </span>
    );
  if (Number(device?.pending_events) > 0)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-primary flex items-center gap-1">
          <Icon name="cloud_sync" className="text-[14px]" /> Uploading {num(device.pending_events)} buffered event(s)
        </span>
        <Progress value={0} indeterminate />
      </div>
    );
  return (
    <span className="text-[12px] text-tertiary flex items-center gap-1">
      <Icon name="check_circle" className="text-[14px]" /> In sync
    </span>
  );
}
