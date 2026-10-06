import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Button,
  Empty,
  ErrorState,
  Icon,
  Loading,
  PageHeader,
  Pagination,
  SearchInput,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useDebounced,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, num, relative } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { BiometricBadge, EmploymentBadge, LocationCell, REQUIRED_FINGERS, TodayStatus } from './components';

const LIMIT = 50;

type SyncState =
  | { kind: 'idle' }
  | { kind: 'running'; message?: string }
  | { kind: 'done'; run: any };

function FilterSelect({ icon, value, onChange, children, label }: { icon: string; value: string; onChange: (v: string) => void; children: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1 bg-surface-container-lowest rounded px-2.5 py-1">
      <Icon name={icon} className="text-[16px] text-outline" />
      <select
        aria-label={label}
        className="bg-transparent text-on-surface font-body-sm text-body-sm focus:outline-none cursor-pointer pr-1 max-w-[190px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

function SyncResult({ state, onDismiss, canViewErrors }: { state: SyncState; onDismiss: () => void; canViewErrors: boolean }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'running')
    return (
      <div className="p-space-sm rounded bg-secondary-container/10 border border-secondary/30 flex items-center gap-space-sm text-body-sm text-on-surface">
        <Icon name="progress_activity" className="animate-spin text-[18px] text-secondary" />
        <span className="font-semibold">Synchronizing...</span>
        {state.message && <span className="text-on-surface-variant">{state.message}</span>}
      </div>
    );
  const r = state.run;
  const errors = Number(r.error_count ?? 0);
  const failed = r.status === 'failed';
  const ok = !failed && errors === 0;
  return (
    <div
      className={clsx(
        'p-space-sm rounded flex items-start gap-space-sm text-body-sm border',
        ok ? 'bg-tertiary-container/10 border-tertiary/30' : failed ? 'bg-error-container/20 border-error/30' : 'bg-warning-container/30 border-warning/30'
      )}
    >
      <Icon name={ok ? 'check_circle' : failed ? 'error' : 'warning'} className={clsx('text-[18px] mt-px', ok ? 'text-tertiary' : failed ? 'text-error' : 'text-warning')} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-on-surface">
          {ok
            ? 'Synchronization completed successfully.'
            : failed
              ? 'Synchronization failed.'
              : `Synchronization completed with ${num(errors)} error${errors === 1 ? '' : 's'}.`}{' '}
          {!ok && r.id && canViewErrors && (
            <Link to={`/integration/runs/${r.id}`} className="text-primary hover:underline font-normal">
              [View Errors]
            </Link>
          )}
        </div>
        <div className="font-label-sm text-label-sm text-outline mt-0.5">
          {failed && r.error_message ? `${r.error_message} · ` : ''}
          Processed {num(r.records_processed)} · Added {num(r.records_added)} · Updated {num(r.records_updated)} · Removed {num(r.records_removed)}
          {r.finished_at ? ` · Finished ${dateTime(r.finished_at)}` : ''}
        </div>
      </div>
      <button onClick={onDismiss} className="text-outline hover:text-on-surface" aria-label="Dismiss">
        <Icon name="close" className="text-[16px]" />
      </button>
    </div>
  );
}

export default function EmployeeDirectory() {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [globalLoc] = useGlobalLocation();
  const [sp, setSp] = useSearchParams();

  // Filters live in the URL so the view is shareable / survives reloads.
  const loc = sp.get('loc') ?? (globalLoc || 'all');
  const status = sp.get('status') ?? '';
  const biometric = sp.get('biometric') ?? '';
  const department = sp.get('department') ?? '';
  const today = sp.get('today') ?? '';
  const offset = Number(sp.get('offset') ?? 0) || 0;
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);

  const setParam = (patch: Record<string, string | null>, resetOffset = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (resetOffset) next.delete('offset');
    setSp(next, { replace: true });
  };

  useEffect(() => {
    if ((sp.get('q') ?? '') !== q) setParam({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filters = {
    q: q || undefined,
    locationId: loc !== 'all' && loc !== 'unassigned' ? loc : undefined,
    unassigned: loc === 'unassigned' ? 'true' : undefined,
    status: status || undefined,
    biometric: biometric || undefined,
    department: department || undefined,
    today: today || undefined,
    limit: LIMIT,
    offset
  };

  const list = useQuery({
    queryKey: ['employees', filters],
    queryFn: () => api.get<{ total: number; rows: any[]; stats: any }>('/api/employees', filters),
    placeholderData: keepPreviousData
  });

  const locations = useQuery({
    queryKey: ['locations', 'options'],
    queryFn: () => api.get<any[]>('/api/locations'),
    enabled: can('locations.view'),
    staleTime: 60_000
  });
  const locationOptions: { id: string; name: string }[] = locations.data
    ? locations.data.map((l) => ({ id: l.id, name: l.name }))
    : (me?.locationScope ?? []).map((l) => ({ id: l.id, name: l.name }));

  const departments = useQuery({
    queryKey: ['employees', 'departments'],
    queryFn: () => api.get<string[]>('/api/employees/departments'),
    staleTime: 60_000
  });

  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });
  const syncMut = useMutation({
    mutationFn: () => api.post<{ run?: any; running?: boolean; message?: string }>('/api/employees/sync'),
    onMutate: () => setSync({ kind: 'running' }),
    onSuccess: (r) => {
      if (r.run) {
        setSync({ kind: 'done', run: r.run });
        const errors = Number(r.run.error_count ?? 0);
        toast({
          tone: r.run.status === 'failed' ? 'error' : errors ? 'warning' : 'success',
          title:
            r.run.status === 'failed'
              ? 'Synchronization failed.'
              : errors
                ? `Synchronization completed with ${errors} errors.`
                : 'Synchronization completed successfully.'
        });
      } else {
        // Another sync is in progress; wait for its sync/finished frame.
        setSync({ kind: 'running', message: r.message ?? 'A synchronisation is already in progress.' });
      }
      void qc.invalidateQueries({ queryKey: ['employees'] });
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
    },
    onError: (e) => {
      setSync({ kind: 'idle' });
      errToast(e, 'Synchronization failed');
    }
  });

  useLiveEvents('sync/finished', (f) => {
    if (sync.kind === 'running' && !syncMut.isPending && (!f.data?.kind || f.data.kind === 'employees')) setSync({ kind: 'done', run: f.data });
  });

  const stats = list.data?.stats;
  const activeFilters = [q, loc !== 'all' ? loc : '', status, biometric, department, today].filter(Boolean).length;

  const resetFilters = () => {
    setSearch('');
    setSp(new URLSearchParams({ loc: 'all' }), { replace: true });
  };

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        title="Employee Directory"
        icon="badge"
        subtitle="Employees synchronised from the web software, with their assignment, fingerprint enrolment and today's attendance."
        actions={
          can('employees.sync') && (
            <Button variant="primary" icon="sync" loading={syncMut.isPending || sync.kind === 'running'} onClick={() => syncMut.mutate()}>
              Sync from Web Software
            </Button>
          )
        }
      />

      {/* Source-of-truth note */}
      <div className="p-space-sm rounded bg-surface-container-lowest flex items-start gap-space-sm shadow-sm">
        <div className="p-1 rounded bg-secondary/10 text-secondary mt-0.5">
          <Icon name="info" className="text-[18px]" />
        </div>
        <div className="flex-1 flex flex-wrap items-center justify-between gap-space-xs text-on-surface-variant font-body-sm text-body-sm">
          <p>
            <strong className="text-on-surface font-medium">Employee missing?</strong> Employees are managed in the web software; sync to pull changes.
          </p>
          <span className="font-label-sm text-label-sm text-outline flex items-center gap-1">
            <Icon name="lock" className="text-[13px]" /> Read-only mirror
          </span>
        </div>
      </div>

      <SyncResult state={sync} onDismiss={() => setSync({ kind: 'idle' })} canViewErrors={can('integration.view')} />

      {/* KPI strip */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-space-sm">
          <Kpi label="Total employees" icon="badge" value={num(stats.total)} foot={<span>All employment statuses</span>} bar="bg-secondary-container" />
          <Kpi
            label="Active"
            icon="how_to_reg"
            value={num(stats.active)}
            foot={<button className="hover:text-on-surface" onClick={() => setParam({ status: 'active' })}>Show active</button>}
            bar="bg-tertiary"
            valueCls="text-tertiary"
          />
          <Kpi
            label="Unassigned"
            icon="link_off"
            value={num(stats.unassigned)}
            valueCls={stats.unassigned ? 'text-warning' : undefined}
            foot={
              stats.unassigned && can('integration.view') ? (
                <Link to="/integration/unmapped" className="text-warning hover:underline">
                  Resolve unmapped locations
                </Link>
              ) : (
                <span>Active, no mapped location</span>
              )
            }
            bar={stats.unassigned ? 'bg-warning' : 'bg-outline-variant'}
          />
          <Kpi
            label="Not enrolled"
            icon="fingerprint"
            value={num(stats.not_enrolled)}
            valueCls={stats.not_enrolled ? 'text-error' : undefined}
            foot={
              <button className="hover:text-on-surface" onClick={() => setParam({ biometric: 'none', status: 'active' })}>
                Active with no fingerprints
              </button>
            }
            bar={stats.not_enrolled ? 'bg-error-container' : 'bg-outline-variant'}
          />
          <Kpi
            label="Last synced"
            icon="cloud_sync"
            value={<span className="text-headline-md">{relative(stats.last_synced_at)}</span>}
            foot={<span>{dateTime(stats.last_synced_at)}</span>}
            bar="bg-secondary"
          />
        </div>
      )}

      {/* Filter toolbar */}
      <div className="p-space-sm rounded-xl card flex flex-wrap items-center justify-between gap-space-sm">
        <div className="flex flex-wrap items-center gap-space-xs flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, staff number or web reference ID..." className="min-w-[240px] flex-1 max-w-sm" />
          <FilterSelect icon="storefront" label="Location" value={loc} onChange={(v) => setParam({ loc: v })}>
            <option value="all">All locations</option>
            <option value="unassigned">Unassigned</option>
            {locationOptions.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect icon="work" label="Employment status" value={status} onChange={(v) => setParam({ status: v })}>
            <option value="">Status: All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="suspended">Suspended</option>
            <option value="terminated">Terminated</option>
          </FilterSelect>
          <FilterSelect icon="fingerprint" label="Biometric status" value={biometric} onChange={(v) => setParam({ biometric: v })}>
            <option value="">Biometric: All</option>
            <option value="enrolled">Enrolled ({REQUIRED_FINGERS}+ fingers)</option>
            <option value="partial">Partial (1 finger)</option>
            <option value="none">Not enrolled</option>
          </FilterSelect>
          <FilterSelect icon="corporate_fare" label="Department" value={department} onChange={(v) => setParam({ department: v })}>
            <option value="">Department: All</option>
            {(departments.data ?? []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect icon="schedule" label="Today's status" value={today} onChange={(v) => setParam({ today: v })}>
            <option value="">Today: All</option>
            <option value="in">Clocked in</option>
            <option value="out">Clocked out</option>
            <option value="absent">Not clocked in</option>
          </FilterSelect>
        </div>
        <div className="flex items-center gap-space-sm text-outline font-label-sm text-label-sm">
          {list.data && (
            <span>
              <strong className="text-on-surface font-label-md text-label-md">{num(list.data.total)}</strong> matching employees
            </span>
          )}
          {activeFilters > 0 && (
            <button className="p-1 rounded bg-surface-container text-on-surface-variant hover:text-on-surface" title="Reset filters" onClick={resetFilters}>
              <Icon name="restart_alt" className="text-[16px]" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex flex-col rounded-xl card overflow-hidden">
        {list.isLoading ? (
          <Loading label="Loading employees..." />
        ) : list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data || list.data.rows.length === 0 ? (
          <Empty
            icon="person_search"
            title="No employees found."
            description={
              activeFilters
                ? 'No employees match the current filters. Use the reset button beside the filters to clear them.'
                : 'Employees appear here after they are synchronised from the web software (Sync from Web Software, above).'
            }
          />
        ) : (
          <>
            <Table className={clsx(list.isFetching && 'opacity-80')}>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Staff number</Th>
                  <Th>Location</Th>
                  <Th>Employment</Th>
                  <Th>Biometric</Th>
                  <Th>Last sync</Th>
                  <Th>Today</Th>
                </tr>
              </THead>
              <tbody className="text-on-surface">
                {list.data.rows.map((e) => (
                  <Tr key={e.id} onClick={() => nav(`/employees/${e.id}`)}>
                    <Td>
                      <div className="flex items-center gap-2.5 min-w-[180px]">
                        <Avatar name={e.full_name} tone={e.employment_status === 'active' ? 'primary' : 'neutral'} size={8} />
                        <div className="flex flex-col min-w-0">
                          <Link to={`/employees/${e.id}`} className="font-headline-sm text-headline-sm text-on-surface truncate hover:text-primary">
                            {e.full_name}
                          </Link>
                          <span className="font-label-sm text-label-sm text-outline truncate max-w-[200px]">{e.department ?? 'No department'}</span>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-col">
                        <span className="font-label-md text-label-md text-secondary font-mono">{e.staff_number}</span>
                        <span className="font-label-sm text-label-sm text-outline font-mono" title="Web reference ID">
                          {e.web_reference_id}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <LocationCell e={e} linkable={can('locations.view') || !e.location_id} />
                    </Td>
                    <Td>
                      <EmploymentBadge status={e.employment_status} />
                    </Td>
                    <Td>
                      <BiometricBadge fingers={e.fingers_enrolled} />
                    </Td>
                    <Td>
                      <span className="font-label-sm text-label-sm text-on-surface-variant whitespace-nowrap" title={dateTime(e.last_synced_at)}>
                        {relative(e.last_synced_at)}
                      </span>
                    </Td>
                    <Td>
                      <TodayStatus e={e} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={(o) => setParam({ offset: o ? String(o) : null }, false)} />
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, icon, value, foot, bar, valueCls }: { label: string; icon: string; value: ReactNode; foot: ReactNode; bar: string; valueCls?: string }) {
  return (
    <div className="p-space-md rounded-xl card flex flex-col justify-between relative overflow-hidden">
      <div className="flex items-center justify-between text-on-surface-variant">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline">{label}</span>
        <Icon name={icon} className="text-[18px] text-secondary" />
      </div>
      <div className={clsx('mt-2 font-headline-xl text-headline-xl tracking-tight font-mono', valueCls ?? 'text-on-surface')}>{value}</div>
      <div className="mt-2 font-label-sm text-label-sm text-outline truncate">{foot}</div>
      <div className={clsx('absolute bottom-0 left-0 right-0 h-0.5', bar)} />
    </div>
  );
}
