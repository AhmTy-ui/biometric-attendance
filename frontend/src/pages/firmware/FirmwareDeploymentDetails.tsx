import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  Empty,
  ErrorState,
  Icon,
  KV,
  Loading,
  PageHeader,
  Panel,
  SearchInput,
  Tabs,
  useErrorToast,
  useToast, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLiveEvents } from '@/lib/live';
import { bytes, dateTime, num, pct, relative } from '@/lib/format';
import { DeploymentStatusBadge, DeployPipeline, FirmwareStateBadge, IN_FLIGHT, PIPELINE, STATE_LABEL, StatesBar, StatesLegend } from './components';

type Filter = 'all' | 'active' | 'failed' | 'verified';

export default function FirmwareDeploymentDetails() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('firmware.manage');
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<any>(null);

  const query = useQuery({
    queryKey: ['firmware-deployment', id],
    queryFn: () => api.get<{ deployment: any; targets: any[] }>(`/api/firmware/deployments/${id}`),
    enabled: Boolean(id)
  });

  // Live per-device state updates from devices (firmware/target frames).
  useLiveEvents('firmware/', (f) => {
    const depId = f.data?.deployment_id ?? f.data?.deploymentId;
    if (!depId || depId === id) void qc.invalidateQueries({ queryKey: ['firmware-deployment', id] });
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['firmware-deployment', id] });
    void qc.invalidateQueries({ queryKey: ['firmware-deployments'] });
  };

  const targetAction = useMutation({
    mutationFn: ({ targetId, action }: { targetId: string; action: 'retry' | 'rollback' }) => api.post(`/api/firmware/targets/${targetId}/${action}`),
    onSuccess: (_r, v) => {
      toast({ tone: 'success', title: v.action === 'retry' ? 'Update re-queued' : 'Rollback queued', description: 'The device will pick it up as soon as it is online.' });
      setRollbackTarget(null);
      refresh();
    },
    onError: (e, v) => errToast(e, v.action === 'retry' ? 'Retry failed' : 'Rollback failed')
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/api/firmware/deployments/${id}/cancel`),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Deployment cancelled', description: 'Devices that had not started were marked as failed.' });
      setConfirmCancel(false);
      refresh();
    },
    onError: (e) => errToast(e, 'Could not cancel deployment')
  });

  const targets: any[] = query.data?.targets ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of targets) c[t.state] = (c[t.state] ?? 0) + 1;
    return c;
  }, [targets]);

  if (query.isLoading) return <Loading label="Loading deployment…" />;
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return null;

  const dep = query.data.deployment;
  const total = targets.length;
  const verified = counts.verified ?? 0;
  const failed = counts.failed ?? 0;
  const rolledBack = counts.rolled_back ?? 0;
  const inFlight = IN_FLIGHT.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const finished = verified + failed + rolledBack;
  const running = dep.status === 'in_progress';

  const needle = q.trim().toLowerCase();
  const shown = targets.filter(
    (t) =>
      (filter === 'all' ||
        (filter === 'active' && IN_FLIGHT.includes(t.state)) ||
        (filter === 'failed' && (t.state === 'failed' || t.state === 'rolled_back')) ||
        (filter === 'verified' && t.state === 'verified')) &&
      (!needle || [t.device_name, t.device_uid, t.location_name].some((x) => String(x ?? '').toLowerCase().includes(needle)))
  );

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        icon="alt_route"
        title={dep.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{dep.version}</span>
            <span className="text-outline">•</span>
            <span>
              Created {dateTime(dep.created_at)} by {dep.created_by_name ?? 'unknown'}
            </span>
            {dep.finished_at && (
              <>
                <span className="text-outline">•</span>
                <span>Finished {dateTime(dep.finished_at)}</span>
              </>
            )}
          </span>
        }
        crumbs={[{ label: 'Firmware', to: '/firmware' }, { label: 'Deployments' }, { label: dep.name }]}
        actions={
          <>
            <DeploymentStatusBadge status={dep.status} />
            <Button icon="refresh" onClick={() => query.refetch()} loading={query.isFetching && !query.isLoading}>
              Refresh
            </Button>
            {canManage && running && (
              <Button variant="danger" icon="cancel" onClick={() => setConfirmCancel(true)}>
                Cancel deployment
              </Button>
            )}
          </>
        }
      />

      {/* Aggregate progress */}
      <Panel
        title={running ? 'Deployment in progress' : 'Deployment summary'}
        icon="monitoring"
        subtitle={`${num(finished)} of ${num(total)} devices finished`}
        actions={
          running && (
            <span className="flex items-center gap-1.5 font-label-sm text-label-sm text-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-secondary animate-pulse" />
              LIVE
            </span>
          )
        }
      >
        <div className="flex flex-col gap-space-md">
          <div>
            <div className="flex items-center justify-between font-label-sm text-label-sm mb-1">
              <span className="text-on-surface-variant">
                {num(verified)} verified • {num(inFlight)} in progress • {num(failed + rolledBack)} failed / rolled back
              </span>
              <span className="text-on-surface font-mono">{pct(total ? (verified / total) * 100 : 0, 0)}</span>
            </div>
            <StatesBar states={counts} total={total} className="h-2.5" />
          </div>
          <StatesLegend states={counts} />

          {/* Stage gates */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-sm">
            {[...PIPELINE, 'failed' as const].map((st, i) => {
              const n = st === 'failed' ? failed + rolledBack : (counts[st] ?? 0);
              const isFail = st === 'failed';
              const isDone = st === 'verified';
              return (
                <div
                  key={st}
                  className={clsx('p-space-sm rounded flex flex-col justify-between shadow-sm', n > 0 && !isDone && !isFail ? 'bg-surface-container-high' : 'bg-surface-container')}
                >
                  <div className={clsx('flex items-center justify-between mb-1', isFail ? (n ? 'text-error' : 'text-outline') : isDone ? 'text-tertiary' : n ? 'text-secondary' : 'text-outline')}>
                    <span className="font-label-sm text-label-sm uppercase tracking-wider font-semibold">
                      {isFail ? 'Failed' : `${String(i + 1).padStart(2, '0')} • ${STATE_LABEL[st]}`}
                    </span>
                    {n > 0 && !isDone && !isFail && <span className="h-1.5 w-1.5 rounded-full bg-secondary animate-pulse" />}
                  </div>
                  <div className="font-headline-md text-headline-md font-mono text-on-surface">{num(n)}</div>
                  <div className="font-label-sm text-label-sm text-outline">{isFail ? `${num(rolledBack)} rolled back` : 'devices'}</div>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md">
        {/* Target devices */}
        <div className="xl:col-span-8 min-w-0">
          <Panel
            title="Devices"
            icon="router"
            subtitle="Queued → Downloading → Installing → Restarting → Verified"
            actions={<SearchInput value={q} onChange={setQ} placeholder="Filter device or location…" className="w-48 hidden sm:flex" />}
          >
            <div className="mb-space-md">
              <Tabs<Filter>
                value={filter}
                onChange={setFilter}
                tabs={[
                  { key: 'all', label: 'All', count: total },
                  { key: 'active', label: 'In progress', count: inFlight },
                  { key: 'failed', label: 'Failed', count: failed + rolledBack },
                  { key: 'verified', label: 'Verified', count: verified }
                ]}
              />
            </div>
            {!shown.length ? (
              <Empty icon="router" title={total ? 'No devices match this filter.' : 'This deployment has no devices you can see.'} />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
                {shown.map((t) => (
                  <TargetCard
                    key={t.id}
                    t={t}
                    version={dep.version}
                    canManage={canManage}
                    busy={targetAction.isPending && targetAction.variables?.targetId === t.id}
                    onRetry={() => targetAction.mutate({ targetId: t.id, action: 'retry' })}
                    onRollback={() => setRollbackTarget(t)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* Firmware info */}
        <div className="xl:col-span-4 flex flex-col gap-space-md min-w-0">
          <SideToggle id="firmware-dep-side" label="Firmware" />
          <Panel title="Firmware" icon="inventory_2">
            <KV label="Version" mono>
              {dep.version}
            </KV>
            <KV label="Size">{bytes(Number(dep.size_bytes))}</KV>
            <KV label="SHA-256" mono>
              <span className="break-all text-[11px]">{dep.sha256}</span>
            </KV>
            <div className="flex justify-end pt-space-sm">
              <CopyButton value={dep.sha256} label="Copy checksum" />
            </div>
            <div className="mt-space-md">
              <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider mb-1">Release notes</div>
              <p className="text-body-sm text-on-surface-variant whitespace-pre-wrap">{dep.release_notes || 'No release notes provided.'}</p>
            </div>
          </Panel>
          <Panel title="Deployment" icon="info">
            <KV label="Status">
              <DeploymentStatusBadge status={dep.status} />
            </KV>
            <KV label="Created">{dateTime(dep.created_at)}</KV>
            <KV label="Created by">{dep.created_by_name ?? '—'}</KV>
            <KV label="Finished">{dateTime(dep.finished_at)}</KV>
            <KV label="Target devices" mono>
              {num(total)}
            </KV>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate()}
        loading={cancel.isPending}
        danger
        title="Cancel deployment?"
        confirmLabel="Cancel deployment"
        message={
          <>
            Devices still <strong className="text-on-surface">queued</strong> ({num(counts.queued ?? 0)}) will not be updated and are marked as failed. Devices that have
            already started downloading or installing will finish their current step.
          </>
        }
      />
      <ConfirmDialog
        open={Boolean(rollbackTarget)}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => rollbackTarget && targetAction.mutate({ targetId: rollbackTarget.id, action: 'rollback' })}
        loading={targetAction.isPending}
        danger
        title="Roll back firmware?"
        confirmLabel="Roll back"
        message={
          rollbackTarget && (
            <>
              <strong className="text-on-surface">{rollbackTarget.device_name}</strong> will be instructed to reinstall{' '}
              <span className="font-mono text-on-surface">{rollbackTarget.from_version ?? 'its previous firmware'}</span>. If the device is offline it will roll back when
              it reconnects.
            </>
          )
        }
      />
    </div>
  );
}

function TargetCard({ t, version, canManage, busy, onRetry, onRollback }: { t: any; version: string; canManage: boolean; busy: boolean; onRetry: () => void; onRollback: () => void }) {
  const failed = t.state === 'failed';
  const rolled = t.state === 'rolled_back';
  const offline = t.connectivity === 'offline';
  return (
    <div className={clsx('p-space-sm rounded shadow-sm transition-colors', failed ? 'bg-error-container/10 hover:bg-error-container/20' : 'bg-surface-container hover:bg-surface-container-high')}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <Link to={`/devices/${t.device_id}`} className="font-label-lg text-label-lg font-bold text-on-surface hover:text-primary truncate">
            {t.device_name}
          </Link>
          <Badge tone={offline ? 'error' : 'success'}>{offline ? 'Offline' : 'Online'}</Badge>
        </div>
        <FirmwareStateBadge state={t.state} />
      </div>
      <div className="font-body-sm text-body-sm text-on-surface-variant truncate">
        {t.location_name ?? 'Unassigned'} · <span className="font-mono text-outline">{t.device_uid}</span>
      </div>

      <div className="mt-2">
        <DeployPipeline state={t.state} />
      </div>

      {failed && (
        <div className="p-2 mt-2 bg-surface-container-lowest rounded flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-error">
            <Icon name="error" className="text-[15px]" />
            <span className="font-label-sm text-label-sm font-semibold">Installation failed</span>
          </div>
          {t.error && <p className="font-body-sm text-[11px] text-on-surface-variant break-words">{t.error}</p>}
          <div className="flex items-center gap-1.5 text-tertiary">
            <Icon name="shield" className="text-[15px]" />
            <span className="font-label-sm text-label-sm">
              Device remains protected on previous firmware{t.current_version ? ` (${t.current_version})` : ''}
            </span>
          </div>
          {canManage && (
            <div className="flex items-center gap-1.5 pt-1">
              <Button size="sm" variant="subtle" icon="replay" onClick={onRetry} loading={busy}>
                Retry
              </Button>
              <Button size="sm" variant="secondary" icon="history" onClick={onRollback} disabled={busy}>
                Rollback
              </Button>
            </div>
          )}
        </div>
      )}

      {rolled && (
        <div className="p-2 mt-2 bg-surface-container-lowest rounded flex items-center justify-between gap-2">
          <span className="font-label-sm text-label-sm text-warning flex items-center gap-1">
            <Icon name="history" className="text-[15px]" />
            Rolled back to {t.current_version ?? t.from_version ?? 'previous firmware'}
          </span>
          {canManage && (
            <Button size="sm" variant="subtle" icon="replay" onClick={onRetry} loading={busy}>
              Retry {version}
            </Button>
          )}
        </div>
      )}

      {t.state === 'verified' && (
        <div className="p-2 mt-2 bg-surface-container-lowest rounded flex items-center justify-between gap-2">
          <span className="font-label-sm text-label-sm text-tertiary flex items-center gap-1">
            <Icon name="done_all" className="text-[15px]" />
            Running {t.current_version ?? version}
          </span>
          {canManage && (
            <Button size="sm" variant="ghost" icon="history" onClick={onRollback} disabled={busy}>
              Rollback
            </Button>
          )}
        </div>
      )}

      {t.state === 'queued' && offline && (
        <div className="p-2 mt-2 bg-surface-container-lowest rounded flex items-center gap-1.5 text-secondary">
          <Icon name="cloud_off" className="text-[15px]" />
          <span className="font-label-sm text-label-sm">Waiting for the device to reconnect</span>
        </div>
      )}

      <p className="font-label-sm text-[10px] text-outline mt-1.5">
        {t.from_version ?? 'unknown'} → {version} • attempt {num((t.attempts ?? 0) + 1)} • updated {relative(t.updated_at)}
      </p>
    </div>
  );
}
