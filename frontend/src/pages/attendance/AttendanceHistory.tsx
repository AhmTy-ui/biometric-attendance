import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorState, ExportMenu, LinkButton, Loading, PageHeader, Pagination, Panel, Select, useErrorToast, useToast } from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num } from '@/lib/format';
import { useGlobalLocation } from '@/lib/scope';
import { EventFiltersBar, EventTable, hasActiveFilters, toApiQuery, type EventFilters, type FilterField } from './components';

const FIELDS: FilterField[] = ['q', 'locationId', 'deviceId', 'employeeId', 'direction', 'status', 'channel', 'from', 'to', 'minScore'];
const KEYS: (keyof EventFilters)[] = ['q', 'locationId', 'deviceId', 'employeeId', 'direction', 'status', 'channel', 'from', 'to', 'minScore', 'maxScore', 'date'];
const PAGE_SIZES = [25, 50, 100, 200];

export default function AttendanceHistory() {
  const { can } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [sp, setSp] = useSearchParams();
  const [globalLoc] = useGlobalLocation();

  const filters: EventFilters = useMemo(() => {
    const f: EventFilters = {};
    for (const k of KEYS) {
      const v = sp.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [sp]);
  const limit = PAGE_SIZES.includes(Number(sp.get('limit'))) ? Number(sp.get('limit')) : 50;
  const offset = Math.max(0, Number(sp.get('offset')) || 0);
  const sort = sp.get('sort') === 'captured_asc' ? 'captured_asc' : 'captured_desc';

  const update = (patch: Record<string, string | undefined>, resetPage = true) => {
    setSp(
      (cur) => {
        const n = new URLSearchParams(cur);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '') n.delete(k);
          else n.set(k, v);
        }
        if (resetPage) n.delete('offset');
        return n;
      },
      { replace: true }
    );
  };

  // Global location scope is the default location filter (applied on entry and whenever it changes).
  const prevGlobal = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevGlobal.current === undefined) {
      prevGlobal.current = globalLoc;
      if (globalLoc && !sp.has('locationId')) update({ locationId: globalLoc }, false);
      return;
    }
    if (prevGlobal.current !== globalLoc) {
      prevGlobal.current = globalLoc;
      update({ locationId: globalLoc ?? undefined, deviceId: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalLoc]);

  const apiQuery = toApiQuery(filters);
  const q = useQuery<any>({
    queryKey: ['attendance-history', apiQuery, limit, offset, sort],
    queryFn: () => api.get('/api/attendance/events', { ...apiQuery, limit, offset, sort }),
    placeholderData: keepPreviousData
  });

  const onExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    try {
      await download('/api/attendance/events/export', { ...apiQuery, format });
      toast({ tone: 'success', title: 'Export ready', description: `Attendance history exported as ${format.toUpperCase()}.` });
    } catch (e) {
      errorToast(e, 'Export failed');
    }
  };

  const rows: any[] = q.data?.rows ?? [];
  const total: number = q.data?.total ?? 0;

  return (
    <>
      <PageHeader
        title="Attendance History"
        icon="history"
        subtitle="Search every captured attendance event, inspect delivery to the web software and export the results."
        crumbs={[{ label: 'Attendance' }, { label: 'History' }]}
        actions={
          <>
            <LinkButton to="/attendance/live" icon="stream">
              Live feed
            </LinkButton>
            {can('attendance.export') && <ExportMenu onExport={onExport} disabled={!q.data || total === 0} />}
          </>
        }
      />

      <Panel title="Filters" icon="filter_list" subtitle="Timestamps are filtered in your browser's time zone; results show each location's local time.">
        <EventFiltersBar
          value={filters}
          onChange={(p) => update(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v as string | undefined])))}
          fields={FIELDS}
          onReset={hasActiveFilters(filters) ? () => setSp(new URLSearchParams(), { replace: true }) : undefined}
        />
        {filters.date && (
          <p className="mt-space-sm font-body-sm text-body-sm text-outline">
            Date filter: <span className="font-mono text-on-surface">{filters.date}</span> (location local day){' '}
            <button className="text-primary hover:underline" onClick={() => update({ date: undefined })}>
              Clear
            </button>
          </p>
        )}
      </Panel>

      <Panel
        title="Results"
        icon="table_rows"
        subtitle={q.data ? `${num(total)} matching event${total === 1 ? '' : 's'}${q.isFetching ? ' · refreshing…' : ''}` : undefined}
        bodyClassName="px-0 pb-0"
        actions={
          <div className="flex items-center gap-space-xs">
            <Select className="h-8 w-auto" value={sort} onChange={(e) => update({ sort: e.target.value === 'captured_asc' ? 'captured_asc' : undefined })} aria-label="Sort order">
              <option value="captured_desc">Newest first</option>
              <option value="captured_asc">Oldest first</option>
            </Select>
            <Select className="h-8 w-auto" value={limit} onChange={(e) => update({ limit: e.target.value === '50' ? undefined : e.target.value })} aria-label="Page size">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {q.isLoading ? (
          <Loading label="Loading attendance data..." />
        ) : q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <Empty title="No attendance records found." icon="search_off" description={hasActiveFilters(filters) ? 'Try widening the date range or clearing some filters.' : undefined} />
        ) : (
          <>
            <EventTable rows={rows} />
            <Pagination total={total} limit={limit} offset={offset} onChange={(o) => update({ offset: o ? String(o) : undefined }, false)} />
          </>
        )}
      </Panel>
    </>
  );
}
