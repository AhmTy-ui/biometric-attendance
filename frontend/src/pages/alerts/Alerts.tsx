import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Dot,
  Empty,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Stat,
  Tabs,
  useDebounced,
  useToast
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLive, useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { num, relative } from '@/lib/format';
import { AlertCard, FilterChip, ResolveDialog, TYPE_META, useAlertActions } from './components';

type StatusKey = 'active' | 'open' | 'acknowledged' | 'resolved';
const LIMIT = 20;
const pick = <T extends string>(v: string | null, allowed: readonly T[], dflt: T | ''): T | '' => (v && (allowed as readonly string[]).includes(v) ? (v as T) : dflt);

export default function Alerts() {
  const { can } = useAuth();
  const canManage = can('alerts.manage');
  const [params] = useSearchParams();
  const [scopeLocation] = useGlobalLocation();
  const { status: liveStatus } = useLive();
  const toast = useToast();

  const [status, setStatus] = useState<StatusKey>(() => (pick(params.get('status'), ['active', 'open', 'acknowledged', 'resolved'] as const, 'active') || 'active') as StatusKey);
  const [severity, setSeverity] = useState(() => pick(params.get('severity'), ['critical', 'warning', 'info'] as const, ''));
  const [category, setCategory] = useState(() => pick(params.get('category'), ['device', 'sync', 'integration'] as const, ''));
  const [type, setType] = useState(() => pick(params.get('type'), Object.keys(TYPE_META), ''));
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [lastLive, setLastLive] = useState<string | null>(null);
  const [resolving, setResolving] = useState<any | null>(null);
  const q = useDebounced(search, 300);
  const deviceId = params.get('deviceId') ?? undefined;
  const locationId = params.get('locationId') ?? scopeLocation ?? undefined;

  const filters = { status, severity, category, type, q, locationId, deviceId, offset };
  const alerts = useQuery({
    queryKey: ['alerts', filters],
    queryFn: () => api.get('/api/alerts', { status, severity, category, type, q: q.trim(), locationId, deviceId, limit: LIMIT, offset }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000
  });
  const { acknowledge, resolve } = useAlertActions();

  useLiveEvents('alert/', (f) => {
    setLastLive(f.at ?? new Date().toISOString());
    if (f.kind === 'alert/raised' && Number(f.data?.occurrences) === 1 && f.data?.severity === 'critical')
      toast({ tone: 'error', title: 'New critical alert', description: f.data?.title });
  });

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const counts = alerts.data?.counts ?? {};
  const activeTotal = Number(counts.critical ?? 0) + Number(counts.warning ?? 0) + Number(counts.info ?? 0);
  const anyFilter = Boolean(severity || category || type || q || deviceId);

  return (
    <div className="space-y-space-md">
      <PageHeader
        title="Alert Center"
        icon="notifications_active"
        subtitle="What needs attention across devices, synchronisation and the web-software integration."
        actions={
          <span className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-container-low border border-outline-variant/40 rounded font-label-sm text-label-sm">
            <Dot tone={liveStatus === 'open' ? 'success' : liveStatus === 'connecting' ? 'warning' : 'neutral'} pulse={liveStatus === 'open'} />
            <span className={liveStatus === 'open' ? 'text-tertiary' : 'text-outline'}>{liveStatus === 'open' ? 'Live' : liveStatus === 'connecting' ? 'Connecting…' : 'Live updates paused'}</span>
            {lastLive && <span className="text-outline">· updated {relative(lastLive)}</span>}
          </span>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-sm">
        <Stat label="Critical" value={num(counts.critical ?? 0)} icon="error" tone={counts.critical ? 'error' : undefined} hint="Active" />
        <Stat label="Warning" value={num(counts.warning ?? 0)} icon="warning" tone={counts.warning ? 'warning' : undefined} hint="Active" />
        <Stat label="Info" value={num(counts.info ?? 0)} icon="info" tone={counts.info ? 'info' : undefined} hint="Active" />
        <Stat label="Open" value={num(counts.open ?? 0)} icon="notifications" hint="Awaiting acknowledgement" />
        <Stat label="Acknowledged" value={num(counts.acknowledged ?? 0)} icon="done" hint="Being handled" />
        <Stat label="Resolved" value={num(counts.resolved_24h ?? 0)} icon="task_alt" tone="success" hint="Last 24 hours" />
      </div>

      {/* Filters */}
      <div className="bg-surface-container rounded-lg p-space-md space-y-space-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-sm">
          <Tabs<StatusKey>
            value={status}
            onChange={(v) => reset(() => setStatus(v))}
            tabs={[
              { key: 'active', label: 'Active', icon: 'bolt', count: activeTotal },
              { key: 'open', label: 'Open', icon: 'notifications', count: Number(counts.open ?? 0) },
              { key: 'acknowledged', label: 'Acknowledged', icon: 'done', count: Number(counts.acknowledged ?? 0) },
              { key: 'resolved', label: 'Resolved', icon: 'task_alt' }
            ]}
          />
          <div className="flex flex-col sm:flex-row gap-space-xs">
            <Select value={type} onChange={(e) => reset(() => setType(e.target.value))} className="h-8 sm:w-48" aria-label="Alert type">
              <option value="">All alert types</option>
              {Object.entries(TYPE_META).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </Select>
            <SearchInput value={search} onChange={(v) => reset(() => setSearch(v))} placeholder="Search title or description…" className="sm:w-64" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-space-xs">
          <FilterChip active={severity === 'critical'} onClick={() => reset(() => setSeverity(severity === 'critical' ? '' : 'critical'))} icon="error" label="Critical" count={counts.critical} tone="error" />
          <FilterChip active={severity === 'warning'} onClick={() => reset(() => setSeverity(severity === 'warning' ? '' : 'warning'))} icon="warning" label="Warning" count={counts.warning} tone="warning" />
          <FilterChip active={severity === 'info'} onClick={() => reset(() => setSeverity(severity === 'info' ? '' : 'info'))} icon="info" label="Info" count={counts.info} tone="info" />
          <span className="w-px h-6 bg-outline-variant/40 mx-1" />
          <FilterChip active={category === 'device'} onClick={() => reset(() => setCategory(category === 'device' ? '' : 'device'))} icon="router" label="Device" count={counts.device} />
          <FilterChip active={category === 'sync'} onClick={() => reset(() => setCategory(category === 'sync' ? '' : 'sync'))} icon="sync" label="Sync" count={counts.sync} />
          <FilterChip
            active={category === 'integration'}
            onClick={() => reset(() => setCategory(category === 'integration' ? '' : 'integration'))}
            icon="hub"
            label="Integration"
            count={counts.integration}
          />
          {anyFilter && (
            <Button
              size="sm"
              variant="ghost"
              icon="filter_alt_off"
              onClick={() =>
                reset(() => {
                  setSeverity('');
                  setCategory('');
                  setType('');
                  setSearch('');
                })
              }
            >
              Clear filters
            </Button>
          )}
          {locationId && <span className="font-label-sm text-label-sm text-outline ml-auto">Filtered to the selected location scope · chip counts cover all active alerts you can see</span>}
        </div>
      </div>

      {/* List */}
      {alerts.isLoading ? (
        <Loading label="Loading alerts..." />
      ) : alerts.error && !alerts.data ? (
        <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} />
      ) : !alerts.data?.rows.length ? (
        <div className="bg-surface-container-low rounded-lg">
          <Empty
            icon={status === 'active' && !anyFilter ? 'verified' : 'notifications_off'}
            title={status === 'active' && !anyFilter ? 'No active alerts. Everything is operating normally.' : 'No alerts found.'}
            description={anyFilter ? 'Try clearing the filters.' : undefined}
          />
        </div>
      ) : (
        <div className="space-y-space-sm">
          {alerts.data.rows.map((a: any) => (
            <AlertCard
              key={a.id}
              alert={a}
              canManage={canManage}
              acknowledging={acknowledge.isPending && acknowledge.variables === a.id}
              onAcknowledge={() => acknowledge.mutate(a.id)}
              onResolve={() => setResolving(a)}
            />
          ))}
          <div className="rounded-lg overflow-hidden">
            <Pagination total={alerts.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </div>
        </div>
      )}

      <ResolveDialog
        alert={resolving}
        onClose={() => setResolving(null)}
        loading={resolve.isPending}
        onConfirm={(note) => resolve.mutate({ id: resolving.id, note }, { onSuccess: () => setResolving(null) })}
      />
    </div>
  );
}
