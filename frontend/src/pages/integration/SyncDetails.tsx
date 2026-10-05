import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  CopyButton,
  Empty,
  ErrorState,
  Icon,
  JsonBlock,
  KV,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  SearchInput,
  Stat,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, num, relative } from '@/lib/format';
import { KIND_ICON, KIND_LABEL, MODE_LABEL, runDurationMs, shortId, SyncStatusBadge } from './components';

const RETRYABLE = ['employees', 'locations', 'attendance_export'];

export default function SyncDetails() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const q = useQuery({
    queryKey: ['sync-runs', 'detail', id],
    queryFn: () => api.get(`/api/integration/runs/${id}`),
    refetchInterval: (query) => ((query.state.data as any)?.run?.status === 'running' ? 3000 : false)
  });

  const retry = useMutation({
    mutationFn: (kind: string) => api.post('/api/integration/sync', { kind, mode: 'retry' }),
    onSuccess: (res: any) => {
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      if (res?.running) {
        toast({ tone: 'info', title: 'Synchronization already running', description: res.message });
        return;
      }
      const r = res?.run;
      if (r?.id) {
        const errors = Number(r.error_count ?? 0);
        toast(
          r.status === 'failed'
            ? { tone: 'error', title: 'Retry failed', description: r.error_message ?? undefined }
            : errors > 0
              ? { tone: 'warning', title: `Synchronization completed with ${errors} errors.` }
              : { tone: 'success', title: 'Synchronization completed successfully.' }
        );
        navigate(`/integration/runs/${r.id}`);
      } else {
        toast({ tone: 'success', title: 'Retry completed' });
      }
    },
    onError: (e) => errorToast(e, 'Retry failed')
  });

  const errors: any[] = (q.data as any)?.errors ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return errors;
    return errors.filter((e) => `${e.record_ref ?? ''} ${e.error ?? ''}`.toLowerCase().includes(s));
  }, [errors, search]);

  if (q.isLoading) return <Loading label="Loading sync run..." />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const run: any = (q.data as any).run;
  const failed = run.status === 'failed';
  const partial = run.status === 'partial' || Number(run.error_count) > 0;
  const canRetry = can('integration.manage') && RETRYABLE.includes(run.kind) && run.status !== 'running';
  const kindLabel = KIND_LABEL[run.kind] ?? run.kind;

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="space-y-space-md">
      <PageHeader
        crumbs={[{ label: 'Integration & Sync', to: '/integration' }, { label: 'Sync run' }]}
        title={
          <span className="flex items-center gap-space-sm flex-wrap">
            {kindLabel} · <span className="font-mono text-primary">{shortId(run.id)}</span> <SyncStatusBadge status={run.status} />
          </span>
        }
        icon={KIND_ICON[run.kind] ?? 'sync'}
        subtitle={`${MODE_LABEL[run.mode] ?? run.mode} run started ${relative(run.started_at)} by ${run.triggered_by_name ?? 'the scheduler'}`}
        actions={
          <>
            <LinkButton to="/integration" icon="arrow_back">
              Back to Integration
            </LinkButton>
            {canRetry && (failed || partial) && (
              <Button variant="primary" icon="replay" loading={retry.isPending} onClick={() => retry.mutate(run.kind)}>
                Retry Sync
              </Button>
            )}
          </>
        }
      />

      {retry.isPending && (
        <div className="bg-surface-container rounded-lg px-space-md py-space-sm flex items-center gap-2 text-body-sm text-on-surface">
          <Icon name="progress_activity" className="animate-spin text-[18px] text-secondary" />
          Synchronizing...
        </div>
      )}

      {run.status === 'running' && (
        <div className="bg-surface-container rounded-lg px-space-md py-space-sm flex items-center gap-2 text-body-sm text-on-surface">
          <Icon name="progress_activity" className="animate-spin text-[18px] text-secondary" />
          Synchronizing... this page refreshes automatically when the run finishes.
        </div>
      )}

      {failed && (
        <div className="bg-surface-container-low rounded-lg p-space-md shadow-md relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-error" />
          <div className="pl-space-xs space-y-space-sm">
            <div className="flex items-start gap-space-sm">
              <div className="p-2 bg-error-container/30 text-error rounded shrink-0">
                <Icon name="sync_problem" className="text-[20px]" />
              </div>
              <div className="min-w-0">
                <div className="font-headline-sm text-headline-sm text-on-surface">This synchronisation failed</div>
                <p className="font-body-sm text-body-sm text-on-surface-variant break-words">{run.error_message ?? 'The web software returned an error.'}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
              <div className="bg-surface-container rounded p-space-sm">
                <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline mb-1">How to investigate</div>
                <ol className="list-decimal pl-4 space-y-0.5 text-body-sm text-on-surface-variant">
                  <li>Run “Test connection” on the Integration dashboard to confirm the web software is reachable.</li>
                  <li>Check the base URL, API key and endpoint paths in Settings → Integration.</li>
                  <li>Confirm the web software is up and accepting API requests.</li>
                  <li>Retry the synchronisation once the cause is fixed.</li>
                </ol>
              </div>
              <div className="bg-surface-container rounded p-space-sm">
                <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline mb-1">What happens automatically</div>
                <ul className="list-disc pl-4 space-y-0.5 text-body-sm text-on-surface-variant">
                  {run.kind === 'employees' && <li>After a first failure, the employee sync is retried automatically after one minute.</li>}
                  {run.kind !== 'attendance_export' && <li>Two consecutive failures raise a critical “sync failed” alert.</li>}
                  <li>Devices keep capturing attendance; nothing is lost while synchronisation is down.</li>
                </ul>
              </div>
            </div>
            <div className="flex flex-wrap gap-space-xs">
              {canRetry && (
                <Button variant="primary" icon="replay" loading={retry.isPending} onClick={() => retry.mutate(run.kind)}>
                  Retry Sync
                </Button>
              )}
              <LinkButton to="/integration" icon="lan">
                Test connection
              </LinkButton>
              {can('settings.view') && (
                <LinkButton to="/settings?tab=integration" icon="settings">
                  Integration settings
                </LinkButton>
              )}
              {can('alerts.view') && (
                <LinkButton to="/alerts?category=sync" icon="notifications">
                  Sync alerts
                </LinkButton>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-space-sm">
        <Stat label="Records processed" value={num(run.records_processed)} icon="dataset" />
        <Stat label="Added" value={num(run.records_added)} icon="person_add" tone="success" />
        <Stat label="Updated" value={num(run.records_updated)} icon="edit" tone="info" />
        <Stat label="Removed" value={num(run.records_removed)} icon="person_remove" tone={Number(run.records_removed) > 0 ? 'warning' : undefined} />
        <Stat label="Errors" value={num(run.error_count)} icon="error" tone={Number(run.error_count) > 0 ? 'error' : 'success'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
        <Panel className="lg:col-span-5 xl:col-span-4" title="Run details" icon="info">
          <KV label="Run ID" mono>
            <span className="flex items-center gap-2 justify-end">
              <span className="break-all">{run.id}</span>
              <CopyButton value={run.id} label="" />
            </span>
          </KV>
          <KV label="Kind">{kindLabel}</KV>
          <KV label="Mode">{MODE_LABEL[run.mode] ?? run.mode}</KV>
          <KV label="Status">
            <SyncStatusBadge status={run.status} />
          </KV>
          <KV label="Start time" mono>
            {dateTime(run.started_at)}
          </KV>
          <KV label="End time" mono>
            {run.finished_at ? dateTime(run.finished_at) : run.status === 'running' ? 'Running…' : '—'}
          </KV>
          <KV label="Duration" mono>
            {duration(runDurationMs(run))}
          </KV>
          <KV label="Triggered by">{run.triggered_by_name ?? 'System (scheduler)'}</KV>
          {run.kind === 'employees' && (
            <>
              <KV label="Changes since" mono>
                {run.cursor_from ? dateTime(run.cursor_from) : 'Full fetch'}
              </KV>
              <KV label="Cursor saved" mono>
                {run.cursor_to ? dateTime(run.cursor_to) : '—'}
              </KV>
            </>
          )}
          {run.error_message && (
            <KV label="Error">
              <span className="text-error">{run.error_message}</span>
            </KV>
          )}
        </Panel>

        <Panel
          className="lg:col-span-7 xl:col-span-8"
          title="Failed records"
          icon="bug_report"
          subtitle={errors.length ? `${num(errors.length)} record(s) could not be applied; all other records in this run were processed.` : undefined}
          bodyClassName="px-0 pb-0"
          actions={errors.length > 0 && <SearchInput value={search} onChange={setSearch} placeholder="Search ref or error…" className="w-56" />}
        >
          {errors.length === 0 ? (
            <Empty
              icon={failed ? 'sync_problem' : 'task_alt'}
              title={failed ? 'No individual record errors.' : 'No failed records.'}
              description={failed ? 'The run failed before records were processed — see the error above.' : 'Every record in this run was applied successfully.'}
            />
          ) : filtered.length === 0 ? (
            <Empty icon="search_off" title="No matching failed records." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th className="w-8" />
                  <Th>Record reference</Th>
                  <Th>Error</Th>
                  <Th>Logged</Th>
                </tr>
              </THead>
              <tbody className="text-on-surface">
                {filtered.map((e) => {
                  const k = String(e.id);
                  const isOpen = open.has(k);
                  return (
                    <Fragment key={k}>
                      <Tr onClick={() => toggle(k)}>
                        <Td>
                          <Icon name={isOpen ? 'expand_more' : 'chevron_right'} className="text-[18px] text-outline" />
                        </Td>
                        <Td className="font-mono text-[11px] text-primary whitespace-nowrap">{e.record_ref ?? '—'}</Td>
                        <Td className="text-error break-words">{e.error}</Td>
                        <Td className="font-mono text-[11px] text-outline whitespace-nowrap">{dateTime(e.created_at)}</Td>
                      </Tr>
                      {isOpen && (
                        <tr className="bg-surface-container-lowest">
                          <td colSpan={4} className="p-space-md">
                            <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider mb-1">Payload received from the web software</div>
                            <JsonBlock value={e.payload} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}
