import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dot, Empty, ErrorState, Icon, LinkButton, Loading, PageHeader, Panel, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { duration, num, relative, todayIso } from '@/lib/format';
import { useLive, useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { applyDeliveryFrame, EventFiltersBar, EventTable, hasActiveFilters, matchesFilters, toApiQuery, type EventFilters } from './components';

const MAX_ROWS = 500;
const INITIAL_LIMIT = 100;

export default function LiveAttendance() {
  const { can } = useAuth();
  const live = useLive();
  const [globalLoc] = useGlobalLocation();
  const [filters, setFilters] = useState<EventFilters>(() => ({ locationId: globalLoc ?? undefined }));
  const prevGlobal = useRef(globalLoc);
  useEffect(() => {
    if (prevGlobal.current !== globalLoc) {
      prevGlobal.current = globalLoc;
      setFilters((f) => ({ ...f, locationId: globalLoc ?? undefined, deviceId: undefined }));
    }
  }, [globalLoc]);

  const q = useQuery<any>({
    queryKey: ['attendance-live', filters],
    queryFn: () => api.get('/api/attendance/events', { ...toApiQuery(filters), limit: INITIAL_LIMIT }),
    staleTime: Infinity,
    refetchOnWindowFocus: false
  });

  const [rows, setRows] = useState<any[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [received, setReceived] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const pausedBuffer = useRef<any[]>([]);
  const [bufferedCount, setBufferedCount] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    if (q.data?.rows) {
      setRows(q.data.rows);
      pausedBuffer.current = [];
      setBufferedCount(0);
    }
  }, [q.data]);

  const markFlash = useCallback((ids: string[]) => {
    setFlash((s) => new Set([...s, ...ids]));
    setTimeout(() => setFlash((s) => new Set([...s].filter((x) => !ids.includes(x)))), 2400);
  }, []);

  const prepend = useCallback(
    (evs: any[]) => {
      if (!evs.length) return;
      setRows((cur) => {
        const ids = new Set(evs.map((e) => e.id));
        return [...evs, ...cur.filter((r) => !ids.has(r.id))].slice(0, MAX_ROWS);
      });
      markFlash(evs.map((e) => e.id));
    },
    [markFlash]
  );

  useLiveEvents('attendance/event', (f) => {
    const ev = f.data;
    if (!ev?.id || !matchesFilters(ev, filtersRef.current)) return;
    setReceived((n) => n + 1);
    setLastEventAt(f.at ?? new Date().toISOString());
    if (paused) {
      pausedBuffer.current = [ev, ...pausedBuffer.current.filter((x) => x.id !== ev.id)].slice(0, MAX_ROWS);
      setBufferedCount(pausedBuffer.current.length);
    } else {
      prepend([ev]);
    }
  });

  useLiveEvents('delivery/updated', (f) => {
    setRows((cur) => applyDeliveryFrame(cur, f));
    pausedBuffer.current = applyDeliveryFrame(pausedBuffer.current, f);
  });

  const resume = () => {
    const buf = pausedBuffer.current;
    pausedBuffer.current = [];
    setBufferedCount(0);
    setPaused(false);
    prepend(buf);
  };

  const today = useQuery<any>({
    queryKey: ['attendance-today', filters.locationId ?? null],
    queryFn: () => api.get('/api/attendance/today', { locationId: filters.locationId }),
    refetchInterval: 60_000
  });
  const summary = useQuery<any>({ queryKey: ['delivery-summary'], queryFn: () => api.get('/api/attendance/delivery/summary'), refetchInterval: 60_000 });
  const dash = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000, enabled: can('dashboard.view') });

  const showsToday = !filters.date || filters.date === todayIso();
  const streamState = live.status === 'open' ? (paused ? 'paused' : 'live') : live.status;
  const dlq = summary.data?.byStatus?.dead_letter ?? 0;
  const retrying = summary.data?.byStatus?.retrying ?? 0;
  const p95 = dash.data?.latency?.p95_delivery_ms;
  const p95Ingest = dash.data?.latency?.p95_ingest_ms;

  return (
    <>
      <PageHeader
        title="Live Attendance"
        icon="stream"
        subtitle="Real-time fingerprint clock-ins and clock-outs as devices report them, with web-software delivery status."
        crumbs={[{ label: 'Attendance' }, { label: 'Live Attendance' }]}
        actions={
          <>
            <LinkButton to="/attendance/history" icon="history">
              History
            </LinkButton>
            <LinkButton to="/attendance/reconciliation" icon="published_with_changes">
              Reconciliation & DLQ
            </LinkButton>
          </>
        }
      />

      {/* Stream status & filters (template: top console bar) */}
      <section className="card rounded-xl p-space-md">
        <div className="flex flex-wrap items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-md min-w-0">
            <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0">
              <Icon name="stream" className="text-primary text-[22px]" />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-headline-sm text-headline-sm text-on-surface">Attendance stream</span>
                <StreamBadge state={streamState} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-outline font-label-sm text-label-sm mt-0.5">
                <span>
                  Received this session: <strong className="text-on-surface font-mono">{num(received)}</strong>
                </span>
                <span>•</span>
                <span>Last event: {lastEventAt ? relative(lastEventAt) : 'none yet'}</span>
                {live.lastFrameAt && (
                  <>
                    <span>•</span>
                    <span>Last frame: {relative(new Date(live.lastFrameAt))}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1">
            {paused ? (
              <Button size="sm" variant="primary" icon="play_arrow" onClick={resume}>
                Resume stream{bufferedCount ? ` (${bufferedCount} new)` : ''}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" icon="pause_circle" onClick={() => setPaused(true)}>
                Pause stream
              </Button>
            )}
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void q.refetch()} loading={q.isFetching}>
              Reload
            </Button>
          </div>
        </div>
        <div className="mt-space-md pt-space-md border-t border-outline-variant/30">
          <EventFiltersBar
            value={filters}
            onChange={(p) => setFilters((f) => ({ ...f, ...p }))}
            fields={['locationId', 'deviceId', 'employeeId', 'direction', 'date', 'status']}
            onReset={hasActiveFilters(filters) ? () => setFilters({}) : undefined}
          />
          {!showsToday && (
            <p className="mt-space-sm font-body-sm text-body-sm text-warning flex items-center gap-1">
              <Icon name="info" className="text-[15px]" /> A past date is selected — new live events are not added to this view.
            </p>
          )}
        </div>
      </section>

      {/* Metrics strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-space-md">
        <Stat label="Events today" icon="fingerprint" value={num(today.data?.total_events)} hint={today.data ? `${num(today.data.present)} present · ${num(today.data.clocked_in)} clocked in` : undefined} />
        <Stat label="Live this session" icon="bolt" tone="success" value={num(received)} hint={paused ? `Paused · ${bufferedCount} waiting` : 'Matching current filters'} />
        {can('dashboard.view') ? (
          <Stat
            label="Delivery latency P95"
            icon="timer"
            tone={p95 === null || p95 === undefined ? undefined : p95 <= 10_000 ? 'success' : 'warning'}
            value={p95 === null || p95 === undefined ? '—' : duration(p95)}
            hint={`Target ≤ 10 s · ingest P95 ${p95Ingest === null || p95Ingest === undefined ? '—' : duration(p95Ingest)} (last hour)`}
          />
        ) : (
          <Stat label="Retrying deliveries" icon="autorenew" tone={retrying ? 'warning' : undefined} value={num(retrying)} hint="Automatic retry with backoff" />
        )}
        <Stat
          label="Dead-letter queue"
          icon="report"
          tone={dlq ? 'error' : 'success'}
          value={num(dlq)}
          hint={dlq ? 'Action required — inspect queue →' : `${num(retrying)} retrying`}
          to="/attendance/reconciliation"
        />
      </section>

      <Panel
        title="Ingested attendance events"
        icon="list_alt"
        subtitle={q.data ? `Showing ${num(rows.length)} (latest ${INITIAL_LIMIT} of ${num(q.data.total)} matching, plus live arrivals)` : undefined}
        bodyClassName="px-0 pb-0"
        actions={
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-container-lowest font-label-sm text-label-sm text-outline">
            <Dot tone={streamState === 'live' ? 'success' : streamState === 'paused' ? 'warning' : 'error'} pulse={streamState === 'live'} />
            {streamState === 'live' ? 'Streaming' : streamState === 'paused' ? 'Paused' : 'Not connected'}
          </span>
        }
      >
        {q.isLoading ? (
          <Loading label="Loading attendance data..." />
        ) : q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <Empty title="No attendance records found." icon="fingerprint" description={streamState === 'live' ? 'Waiting for clock-ins… new events appear here as soon as a device reports them.' : undefined} />
        ) : (
          <EventTable rows={rows} flashIds={flash} />
        )}
        <div className="px-space-md py-2 bg-surface-container-lowest flex flex-wrap items-center justify-between gap-2 text-outline font-label-sm text-label-sm">
          <span className="flex items-center gap-2">
            <span className={clsx('inline-block w-2 h-2 rounded-full', streamState === 'live' ? 'bg-tertiary' : 'bg-outline')} />
            Click a row for delivery details · click an employee to open the profile
          </span>
        </div>
      </Panel>
    </>
  );
}

function StreamBadge({ state }: { state: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    live: { cls: 'bg-tertiary/15 text-tertiary', label: 'Live' },
    paused: { cls: 'bg-warning-container/60 text-warning', label: 'Paused' },
    connecting: { cls: 'bg-secondary-container/20 text-secondary', label: 'Connecting…' },
    closed: { cls: 'bg-error-container text-on-error-container', label: 'Disconnected' }
  };
  const m = map[state] ?? map.closed!;
  return (
    <span className={clsx('px-2 py-0.5 rounded font-label-badge text-label-badge uppercase tracking-wider flex items-center gap-1.5', m.cls)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full bg-current', state === 'live' && 'animate-pulse')} />
      {m.label}
    </span>
  );
}
