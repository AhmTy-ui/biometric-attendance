import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  deliveryTone,
  Empty,
  ErrorState,
  Icon,
  KV,
  LinkButton,
  Loading,
  PageHeader,
  Pagination,
  Panel,
  Progress,
  Select,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useErrorToast,
  useToast,
  SideToggle
} from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLiveEvents } from '@/lib/live';
import { dateTime, duration, humanize, num, relative } from '@/lib/format';
import {
  DELIVERY_MODE_LABEL,
  healthMeta,
  HealthTile,
  KIND_LABEL,
  SyncResultBanner,
  SyncRunsTable,
  SyncStatusBadge,
  type SyncTrack
} from './components';

const P95_TARGET_MS = 10_000; // S-1: capture → web software within 10 s (p95)
const RUNS_LIMIT = 20;
const DELIVERY_ORDER = ['pending', 'retrying', 'delivered', 'exported', 'dead_letter'];

type SyncKind = 'employees' | 'locations' | 'attendance_export';
type SyncMode = 'manual' | 'full' | 'retry';

export default function Integration() {
  const { can } = useAuth();
  const canManage = can('integration.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [track, setTrack] = useState<SyncTrack | null>(null);
  const [probe, setProbe] = useState<any>(null);
  const [kindF, setKindF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [offset, setOffset] = useState(0);

  const status = useQuery({ queryKey: ['integration-status'], queryFn: () => api.get('/api/integration/status'), refetchInterval: 30_000 });
  const runs = useQuery({
    queryKey: ['sync-runs', { kind: kindF, status: statusF, offset }],
    queryFn: () => api.get('/api/integration/runs', { kind: kindF, status: statusF, limit: RUNS_LIMIT, offset }),
    placeholderData: keepPreviousData
  });
  const exportsQ = useQuery({ queryKey: ['integration-exports'], queryFn: () => api.get<any[]>('/api/integration/exports') });

  // Live: surface syncs started elsewhere (scheduler, automatic retry, other users) and their results.
  useLiveEvents('sync/', (f) => {
    const run = f.data;
    if (!run?.kind) return;
    if (f.kind === 'sync/started') {
      setTrack((t) => (t?.phase === 'running' ? t : { phase: 'running', kind: run.kind, runId: run.id, mine: false }));
    } else if (f.kind === 'sync/finished') {
      setTrack((t) => (t?.phase === 'running' && (t.runId === run.id || (!t.runId && t.kind === run.kind)) ? { phase: 'done', kind: run.kind, run } : t));
      if (run.kind === 'attendance_export') void qc.invalidateQueries({ queryKey: ['integration-exports'] });
    }
  });

  const sync = useMutation({
    mutationFn: (b: { kind: SyncKind; mode: SyncMode }) => api.post('/api/integration/sync', b),
    onMutate: (b) => setTrack({ phase: 'running', kind: b.kind, mine: true }),
    onSuccess: (res: any, b) => {
      if (res?.running) setTrack({ phase: 'info', kind: b.kind, message: res.message });
      else if (res?.run?.id) setTrack({ phase: 'done', kind: b.kind, run: res.run });
      else if (res?.run && 'exported' in res.run) {
        const r = res.run;
        if (Number(r.exported) > 0) setTrack({ phase: 'info', kind: b.kind, message: `Exported ${num(r.exported)} attendance event(s) to ${r.fileName}.` });
        else if (r.fileName)
          setTrack({
            phase: 'error',
            kind: b.kind,
            message: `Export ${r.fileName} was generated but could not be delivered to the export endpoint. The file is kept below and an alert was raised; events stay queued for the next export.`
          });
        else setTrack({ phase: 'info', kind: b.kind, message: 'No pending attendance events to export.' });
      } else setTrack(null);
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
      void qc.invalidateQueries({ queryKey: ['integration-exports'] });
    },
    onError: (err: any, b) => {
      setTrack({ phase: 'error', kind: b.kind, message: err?.message ?? 'Request failed' });
      errorToast(err, 'Synchronization failed');
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
    }
  });

  const test = useMutation({
    mutationFn: () => api.post('/api/integration/test-connection'),
    onSuccess: (r: any) => {
      setProbe({ ...r, at: new Date().toISOString() });
      toast(
        r.reachable && r.ok
          ? { tone: 'success', title: 'Web software reachable', description: `HTTP ${r.status} in ${r.latencyMs} ms` }
          : r.reachable
            ? { tone: 'warning', title: 'Web software responded with an error', description: `HTTP ${r.status}` }
            : { tone: 'error', title: 'Web software unreachable', description: r.error }
      );
    },
    onError: (e) => errorToast(e, 'Connection test failed')
  });

  const busyKey = sync.isPending ? `${sync.variables?.kind}:${sync.variables?.mode}` : null;
  const runBtn = (kind: SyncKind, mode: SyncMode, label: string, icon: string, variant: 'primary' | 'secondary' = 'secondary') =>
    canManage ? (
      <Button size="sm" variant={variant} icon={icon} loading={busyKey === `${kind}:${mode}`} disabled={sync.isPending} onClick={() => sync.mutate({ kind, mode })}>
        {label}
      </Button>
    ) : null;

  if (status.isLoading) return <Loading label="Loading integration status..." />;
  if (status.error && !status.data) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;
  const s: any = status.data;
  const cfg = s.config;
  const push = s.attendancePush;
  const exportMode = cfg.deliveryMode === 'scheduled_export';

  const lastRuns = (['employees', 'locations', 'attendance_export'] as const)
    .map((k) => {
      const h = k === 'employees' ? s.employees : k === 'locations' ? s.locations : s.attendanceExport;
      return h?.lastRun ? { ...h.lastRun, kind: k } : null;
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()) as any[];
  const last = lastRuns[0] ?? null;

  const p95 = push.latency?.p95_delivery_ms !== null && push.latency?.p95_delivery_ms !== undefined ? Number(push.latency.p95_delivery_ms) : null;
  const byStatus: Record<string, number> = push.byStatus ?? {};
  const statusKeys = [...DELIVERY_ORDER.filter((k) => k in byStatus), ...Object.keys(byStatus).filter((k) => !DELIVERY_ORDER.includes(k))];
  const deliveryTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const failureNote = (h: any, kind: 'employees' | 'locations') => {
    if (h.consecutiveFailures >= 2) return <span className="text-error">{h.consecutiveFailures} consecutive failures · alert raised</span>;
    if (h.consecutiveFailures === 1)
      return kind === 'employees' && h.lastRun?.mode !== 'retry' ? (
        <span className="text-warning">1 failure · automatic retry scheduled</span>
      ) : (
        <span className="text-warning">1 failure · next failure raises an alert</span>
      );
    return <span>Last success {relative(h.lastSuccessAt)}</span>;
  };

  return (
    <div className="space-y-space-md">
      <PageHeader
        title="Integration & Sync"
        icon="hub"
        subtitle="The web software is the source of truth for employees, locations and employment status. Attendance flows back to it."
        actions={
          <>
            {canManage && (
              <Button icon="lan" loading={test.isPending} onClick={() => test.mutate()}>
                Test connection
              </Button>
            )}
            {canManage && exportMode && (
              <Button icon="file_export" loading={busyKey === 'attendance_export:manual'} disabled={sync.isPending} onClick={() => sync.mutate({ kind: 'attendance_export', mode: 'manual' })}>
                Run export now
              </Button>
            )}
            {canManage && (
              <Button variant="primary" icon="sync" loading={busyKey === 'employees:manual'} disabled={sync.isPending} onClick={() => sync.mutate({ kind: 'employees', mode: 'manual' })}>
                Sync from Web Software
              </Button>
            )}
          </>
        }
      />

      {!cfg.configured && (
        <div className="card rounded-xl p-space-md relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-error" />
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md pl-space-xs">
            <div className="flex items-start gap-space-sm">
              <div className="p-2 bg-error-container/30 text-error rounded shrink-0">
                <Icon name="link_off" className="text-[20px]" />
              </div>
              <div>
                <div className="font-headline-sm text-headline-sm text-on-surface">Integration not configured</div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">No web software base URL is set, so employees cannot be synchronised and attendance cannot be delivered.</p>
              </div>
            </div>
            {can('settings.view') && (
              <LinkButton to="/settings?tab=integration" variant="primary" icon="settings">
                Configure integration
              </LinkButton>
            )}
          </div>
        </div>
      )}

      {s.unmappedLocations > 0 && (
        <div className="card rounded-xl p-space-md relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-secondary-container" />
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md pl-space-xs">
            <div className="flex items-start gap-space-sm min-w-0">
              <div className="p-2 bg-secondary-container/15 text-secondary rounded flex items-center justify-center shrink-0 mt-0.5">
                <Icon name="notification_important" className="text-[20px]" />
              </div>
              <div className="flex flex-col space-y-1">
                <div className="flex items-center gap-space-sm flex-wrap">
                  <span className="font-headline-sm text-headline-sm text-on-surface">Unmapped web-software location{s.unmappedLocations === 1 ? '' : 's'} detected</span>
                  <span className="font-label-sm text-label-sm uppercase px-1.5 py-0.5 rounded bg-secondary-container/20 text-secondary font-semibold">{num(s.unmappedLocations)} pending</span>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant max-w-4xl">
                  The web software references {num(s.unmappedLocations)} location{s.unmappedLocations === 1 ? '' : 's'} with no matching platform location. Employees assigned to them are{' '}
                  <strong className="text-on-surface font-semibold">held, never discarded</strong>, and are placed on device rosters as soon as the location is mapped.
                </p>
              </div>
            </div>
            <LinkButton to="/integration/unmapped" variant="primary" icon="alt_route" className="shrink-0 self-end lg:self-center">
              Resolve {num(s.unmappedLocations)} location{s.unmappedLocations === 1 ? '' : 's'}
            </LinkButton>
          </div>
        </div>
      )}

      <SyncResultBanner track={track} onDismiss={() => setTrack(null)} />

      {probe && (
        <div className="bg-surface-container rounded-lg px-space-md py-space-sm flex flex-wrap items-center gap-x-space-lg gap-y-1 font-label-sm text-label-sm">
          <span className="flex items-center gap-1.5 text-on-surface">
            <Icon name={probe.reachable && probe.ok ? 'check_circle' : probe.reachable ? 'warning' : 'cancel'} className={clsx('text-[16px]', probe.reachable && probe.ok ? 'text-tertiary' : probe.reachable ? 'text-warning' : 'text-error')} />
            Connection test: {probe.reachable ? (probe.ok ? 'Reachable' : 'Reachable with error') : 'Unreachable'}
          </span>
          {probe.status !== null && probe.status !== undefined && <span className="text-outline">HTTP {probe.status}</span>}
          <span className="text-outline">Latency {num(probe.latencyMs)} ms</span>
          {probe.error && <span className="text-error break-all">{probe.error}</span>}
          <span className="text-outline ml-auto">{relative(probe.at)}</span>
        </div>
      )}

      {/* Health tiles */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-md">
        <HealthTile
          label="Employee Sync"
          icon="badge"
          health={s.employees.health}
          running={s.employees.running}
          detail={s.employees.lastRun && <SyncStatusBadge status={s.employees.lastRun.status} />}
          footerLeft={s.employees.health === 'never_run' ? 'No run yet' : failureNote(s.employees, 'employees')}
          footerRight={s.employees.lastRun ? relative(s.employees.lastRun.started_at) : null}
          actions={
            <>
              {runBtn('employees', 'manual', 'Sync now', 'sync')}
              {runBtn('employees', 'full', 'Full sync', 'published_with_changes')}
              {s.employees.health === 'failing' || s.employees.health === 'degraded' ? runBtn('employees', 'retry', 'Retry', 'replay') : null}
            </>
          }
        />
        <HealthTile
          label="Location Sync"
          icon="storefront"
          health={s.locations.health}
          running={s.locations.running}
          detail={s.locations.lastRun && <SyncStatusBadge status={s.locations.lastRun.status} />}
          footerLeft={s.locations.health === 'never_run' ? 'No run yet' : failureNote(s.locations, 'locations')}
          footerRight={
            s.unmappedLocations > 0 ? (
              <span className="text-secondary">{num(s.unmappedLocations)} unmapped</span>
            ) : (
              'All mapped'
            )
          }
          actions={runBtn('locations', 'manual', 'Run location sync', 'sync')}
        />
        <HealthTile
          label={exportMode ? 'Attendance Export' : 'Attendance Push'}
          icon={exportMode ? 'file_export' : 'cloud_upload'}
          health={push.health}
          running={exportMode ? s.attendanceExport.running : false}
          headline={
            p95 !== null && !exportMode ? (
              <>
                {duration(p95)} <span className="font-label-sm text-label-sm text-outline font-normal">p95</span>
              </>
            ) : undefined
          }
          detail={
            !exportMode && p95 !== null ? (
              <Badge tone={p95 <= P95_TARGET_MS ? 'success' : 'error'}>{p95 <= P95_TARGET_MS ? 'Within 10 s target' : 'Above 10 s target'}</Badge>
            ) : (
              <Badge tone={healthMeta(push.health).tone}>{healthMeta(push.health).label}</Badge>
            )
          }
          footerLeft={
            exportMode
              ? `Last export ${relative(s.attendanceExport.lastSuccessAt)}`
              : push.lastDeliveredAt
                ? `Last delivered ${relative(push.lastDeliveredAt)}`
                : 'Nothing delivered yet'
          }
          footerRight={(byStatus.dead_letter ?? 0) > 0 ? <span className="text-error">{num(byStatus.dead_letter)} in DLQ</span> : `${num(byStatus.pending ?? 0)} pending`}
          to="/attendance/reconciliation"
        />
        <HealthTile
          label="Last Sync"
          icon="history"
          health={last ? (last.status === 'failed' ? 'failing' : last.status === 'partial' ? 'degraded' : 'healthy') : 'never_run'}
          running={s.employees.running || s.locations.running || s.attendanceExport.running}
          headline={last ? relative(last.finished_at ?? last.started_at) : 'Never'}
          detail={last && <SyncStatusBadge status={last.status} />}
          footerLeft={last ? KIND_LABEL[last.kind] : 'No synchronisation has run'}
          footerRight={cfg.incrementalSyncMinutes ? `Every ${cfg.incrementalSyncMinutes} min` : null}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
        {/* Configuration summary */}
        <Panel
          className="lg:col-span-5 xl:col-span-4"
          title="Configuration"
          icon="settings_ethernet"
          actions={
            // When unconfigured, the "Configure integration" banner above is the call to action.
            can('settings.view') &&
            Boolean(cfg.baseUrl) && (
              <LinkButton to="/settings?tab=integration" size="sm" icon="edit">
                Settings
              </LinkButton>
            )
          }
        >
          <SideToggle id="integration-config" label="Configuration" />
          <KV label="Web software" mono>
            {cfg.baseUrl ? <span className="break-all">{cfg.baseUrl}</span> : <span className="text-error">Not configured</span>}
          </KV>
          <KV label="Attendance delivery">
            <Badge tone={cfg.deliveryMode === 'disabled' ? 'neutral' : 'info'}>{DELIVERY_MODE_LABEL[cfg.deliveryMode] ?? humanize(cfg.deliveryMode)}</Badge>
          </KV>
          <KV label="Incremental sync">{cfg.incrementalSyncMinutes ? `Every ${cfg.incrementalSyncMinutes} minutes` : '—'}</KV>
          <KV label="Full reconciliation" mono>
            {cfg.fullSyncHourUtc !== null && cfg.fullSyncHourUtc !== undefined ? `Daily at ${String(cfg.fullSyncHourUtc).padStart(2, '0')}:00 UTC` : '—'}
          </KV>
          {exportMode && <KV label="Export schedule">{cfg.exportEveryMinutes ? `Every ${cfg.exportEveryMinutes} minutes` : '—'}</KV>}
          <div className="mt-space-sm p-space-sm rounded bg-surface-container-highest flex items-start gap-2 text-outline font-label-sm text-label-sm">
            <Icon name="policy" className="text-[16px] text-secondary shrink-0" />
            <span>After a failed employee sync the platform retries automatically after one minute. Two consecutive failures raise a critical alert.</span>
          </div>
        </Panel>

        {/* Delivery pipeline */}
        <Panel
          className="lg:col-span-7 xl:col-span-8"
          title="Attendance delivery pipeline"
          icon="insights"
          subtitle={DELIVERY_MODE_LABEL[cfg.deliveryMode] ?? cfg.deliveryMode}
          actions={
            <LinkButton to="/attendance/reconciliation" size="sm" icon="published_with_changes">
              Reconciliation & DLQ
            </LinkButton>
          }
        >
          {deliveryTotal === 0 ? (
            <Empty icon="cloud_upload" title="No attendance deliveries yet." description="Delivery counts appear once devices capture attendance." />
          ) : (
            <div className="space-y-space-md">
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-space-sm">
                {statusKeys.map((k) => (
                  <div key={k} className="bg-surface-container rounded p-space-sm">
                    <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider">{humanize(k)}</div>
                    <div className={clsx('font-headline-md text-headline-md font-mono', deliveryTone(k) === 'error' ? 'text-error' : deliveryTone(k) === 'warning' ? 'text-warning' : deliveryTone(k) === 'success' ? 'text-tertiary' : 'text-on-surface')}>
                      {num(byStatus[k])}
                    </div>
                    <Progress value={(byStatus[k]! / deliveryTotal) * 100} tone={deliveryTone(k)} className="mt-1" />
                  </div>
                ))}
              </div>
              {!exportMode && (
                <div className="space-y-1">
                  <div className="flex justify-between font-label-sm text-label-sm text-outline">
                    <span>Capture → web software latency (p95, last 24 h)</span>
                    <span className={clsx(p95 === null ? 'text-outline' : p95 <= P95_TARGET_MS ? 'text-tertiary' : 'text-error')}>
                      {p95 === null ? 'No samples' : `${duration(p95)} / 10 s target · ${num(push.latency?.samples)} samples`}
                    </span>
                  </div>
                  {p95 !== null && <Progress value={(p95 / P95_TARGET_MS) * 100} tone={p95 <= P95_TARGET_MS ? 'success' : 'error'} />}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-outline font-label-sm text-label-sm">
                <span>Last delivered: {push.lastDeliveredAt ? dateTime(push.lastDeliveredAt) : 'never'}</span>
                <span>{num(deliveryTotal)} events tracked</span>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* Sync history */}
      <Panel
        title="Sync History"
        icon="history"
        subtitle="Every synchronisation run with its results. Select a run to see failed records."
        bodyClassName="px-0 pb-0"
        actions={
          <>
            <Select
              value={kindF}
              onChange={(e) => {
                setKindF(e.target.value);
                setOffset(0);
              }}
              className="h-8 w-auto"
              aria-label="Kind"
            >
              <option value="">All kinds</option>
              <option value="employees">Employee sync</option>
              <option value="locations">Location sync</option>
              <option value="attendance_export">Attendance export</option>
            </Select>
            <Select
              value={statusF}
              onChange={(e) => {
                setStatusF(e.target.value);
                setOffset(0);
              }}
              className="h-8 w-auto"
              aria-label="Status"
            >
              <option value="">All statuses</option>
              <option value="running">Running</option>
              <option value="success">Success</option>
              <option value="partial">Partial</option>
              <option value="failed">Failed</option>
            </Select>
          </>
        }
      >
        {runs.isLoading ? (
          <Loading label="Loading sync history..." />
        ) : runs.error && !runs.data ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} compact />
        ) : !runs.data?.rows.length ? (
          <Empty icon="sync" title="No synchronisation runs found." description={kindF || statusF ? 'Try clearing the filters.' : 'Runs appear after the first scheduled or manual synchronisation.'} />
        ) : (
          <>
            <SyncRunsTable rows={runs.data.rows} />
            <Pagination total={runs.data.total} limit={RUNS_LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </Panel>

      {/* Exports (FR-1.5) */}
      {(exportMode || (exportsQ.data?.length ?? 0) > 0) && (
        <Panel
          title="Attendance exports"
          icon="file_export"
          subtitle="Files generated in the web software's import format"
          bodyClassName="px-0 pb-0"
        >
          <ExportsTable q={exportsQ} />
        </Panel>
      )}
    </div>
  );
}

function ExportsTable({ q }: { q: { data?: any[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  const errorToast = useErrorToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading) return <Loading label="Loading exports..." />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  if (!q.data?.length) return <Empty icon="description" title="No exports generated yet." description="Exports run on the configured schedule, or on demand with Run export now." />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>Generated</Th>
          <Th>Period</Th>
          <Th className="text-right">Records</Th>
          <Th>Format</Th>
          <Th>Status</Th>
          <Th>Delivery target</Th>
          <Th className="text-right">File</Th>
        </tr>
      </THead>
      <tbody className="text-on-surface">
        {q.data.map((b) => (
          <Tr key={b.id}>
            <Td className="whitespace-nowrap">
              <div className="font-mono text-[11px]">{dateTime(b.created_at)}</div>
              <div className="font-label-sm text-label-sm text-outline">{relative(b.created_at)}</div>
            </Td>
            <Td className="font-mono text-[11px] text-on-surface-variant whitespace-nowrap">
              {dateTime(b.period_start)} → {dateTime(b.period_end)}
            </Td>
            <Td className="font-mono text-[11px] text-right">{num(b.record_count)}</Td>
            <Td>
              <Badge>{b.format}</Badge>
            </Td>
            <Td>
              <Badge tone={b.status === 'delivered' ? 'success' : b.status === 'failed' ? 'error' : 'info'}>{humanize(b.status)}</Badge>
              {b.error && <div className="text-[11px] text-error mt-0.5 max-w-xs break-words">{b.error}</div>}
              {b.delivered_at && <div className="font-label-sm text-label-sm text-outline mt-0.5">Delivered {relative(b.delivered_at)}</div>}
            </Td>
            <Td className="font-mono text-[11px] text-outline max-w-[240px] truncate" >
              <span title={b.delivery_target ?? ''}>{b.delivery_target ?? '—'}</span>
            </Td>
            <Td className="text-right">
              <Button
                size="sm"
                icon="download"
                loading={busy === b.id}
                onClick={async () => {
                  setBusy(b.id);
                  try {
                    await download(`/api/integration/exports/${b.id}/download`);
                  } catch (e) {
                    errorToast(e, 'Download failed');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Download
              </Button>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
