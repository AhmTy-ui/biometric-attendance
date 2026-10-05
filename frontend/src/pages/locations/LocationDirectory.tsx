import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  Icon,
  Loading,
  PageHeader,
  Panel,
  Progress,
  SearchInput,
  Stat,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useDebounced
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num, pct } from '@/lib/format';
import { ExternalRefs, hhmm, localNow, LocationFormModal, locationStatusLabel, locationTone, rate, workdaysLabel } from './components';

type View = 'cards' | 'table';
const VIEW_KEY = 'bamp.locations.view';

export default function LocationDirectory() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [createOpen, setCreateOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(true);
  const [view, setViewState] = useState<View>(() => {
    try {
      return (localStorage.getItem(VIEW_KEY) as View) === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };

  const query = useQuery({ queryKey: ['locations', { q: dq }], queryFn: () => api.get<any[]>('/api/locations', { q: dq }) });
  const all: any[] = query.data ?? [];
  const rows = showInactive ? all : all.filter((l) => l.is_active);

  const totals = useMemo(() => {
    const active = all.filter((l) => l.is_active);
    const sum = (k: string) => active.reduce((a, l) => a + (l[k] ?? 0), 0);
    return {
      locations: active.length,
      inactive: all.length - active.length,
      employees: sum('active_employees'),
      present: sum('present_today'),
      late: sum('late_today'),
      devices: sum('devices'),
      online: sum('online_devices'),
      offline: sum('offline_devices'),
      alerts: sum('open_alerts'),
      buffered: sum('buffered_events')
    };
  }, [all]);

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        icon="storefront"
        title="Locations"
        subtitle="Branches and sites, their devices and today's attendance."
        actions={
          can('locations.manage') && (
            <Button variant="primary" icon="add_location_alt" onClick={() => setCreateOpen(true)}>
              Create location
            </Button>
          )
        }
      />

      {/* Summary */}
      {query.data && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-sm">
          <Stat label="Active locations" icon="storefront" value={num(totals.locations)} hint={totals.inactive ? `${num(totals.inactive)} inactive` : 'all active'} />
          <Stat label="Active employees" icon="badge" value={num(totals.employees)} hint="across active locations" />
          <Stat
            label="Present today"
            icon="how_to_reg"
            tone="success"
            value={num(totals.present)}
            hint={`${pct(rate(totals.present, totals.employees) ?? 0)} of active · ${num(totals.late)} late`}
          />
          <Stat label="Devices online" icon="router" tone={totals.offline ? 'warning' : 'success'} value={`${num(totals.online)}/${num(totals.devices)}`} hint={`${num(totals.offline)} offline`} />
          <Stat label="Open alerts" icon="notifications_active" tone={totals.alerts ? 'error' : undefined} value={num(totals.alerts)} to="/alerts" />
          <Stat label="Buffered events" icon="inventory" tone={totals.buffered ? 'info' : undefined} value={num(totals.buffered)} hint="stored on devices, not yet uploaded" />
        </div>
      )}

      <Panel
        title="Location directory"
        icon="location_on"
        subtitle={query.data ? `${num(rows.length)} locations` : undefined}
        bodyClassName={view === 'table' ? 'px-0 pb-0' : undefined}
        actions={
          <div className="flex items-center gap-space-sm">
            <SearchInput value={q} onChange={setQ} placeholder="Search name or code…" className="w-40 sm:w-56" />
            <label className="hidden md:flex items-center gap-1.5 font-label-sm text-label-sm text-on-surface-variant">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-primary-container" />
              Show inactive
            </label>
            <div className="flex items-center bg-surface-container-lowest rounded p-0.5">
              {(
                [
                  ['cards', 'grid_view'],
                  ['table', 'table_rows']
                ] as const
              ).map(([v, icon]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={clsx('p-1 rounded', view === v ? 'bg-surface-container text-on-surface' : 'text-outline hover:text-on-surface')}
                  aria-label={v === 'cards' ? 'Card view' : 'Table view'}
                  aria-pressed={view === v}
                >
                  <Icon name={icon} className="text-[18px]" />
                </button>
              ))}
            </div>
          </div>
        }
      >
        {query.isLoading ? (
          <Loading label="Loading locations…" />
        ) : query.error && !query.data ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : !rows.length ? (
          <Empty
            icon="location_off"
            title={dq ? 'No locations match your search.' : 'No locations yet.'}
            description={dq ? undefined : 'Create a location, or map the locations referenced by the web software on the Integration page.'}
            action={
              !dq && can('locations.manage') ? (
                <Button icon="add_location_alt" onClick={() => setCreateOpen(true)}>
                  Create location
                </Button>
              ) : undefined
            }
          />
        ) : view === 'cards' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-space-sm">
            {rows.map((l) => (
              <LocationCard key={l.id} l={l} />
            ))}
          </div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Location</Th>
                <Th>Employees</Th>
                <Th>Today</Th>
                <Th>Devices</Th>
                <Th>Alerts</Th>
                <Th>Buffered</Th>
                <Th>Web reference</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((l) => {
                const r = rate(l.present_today, l.active_employees);
                return (
                  <Tr key={l.id} onClick={() => nav(`/locations/${l.id}`)} className={clsx(!l.is_active && 'opacity-60')}>
                    <Td>
                      <div className="font-semibold text-on-surface">{l.name}</div>
                      <div className="font-label-sm text-label-sm text-outline font-mono">
                        {l.code} · {l.timezone}
                      </div>
                    </Td>
                    <Td className="font-mono text-on-surface">{num(l.active_employees)}</Td>
                    <Td className="min-w-[140px]">
                      <div className="flex items-center justify-between font-label-sm text-label-sm">
                        <span className="text-on-surface">
                          {num(l.present_today)} present · <span className={l.late_today ? 'text-warning' : 'text-outline'}>{num(l.late_today)} late</span>
                        </span>
                      </div>
                      <Progress value={r ?? 0} tone="success" className="mt-1" />
                    </Td>
                    <Td>
                      <span className="font-mono text-on-surface">{num(l.online_devices)}</span>
                      <span className="text-outline"> / {num(l.devices)} online</span>
                      {l.offline_devices > 0 && <div className="font-label-sm text-label-sm text-error">{num(l.offline_devices)} offline</div>}
                    </Td>
                    <Td>{l.open_alerts > 0 ? <Badge tone="warning">{num(l.open_alerts)} open</Badge> : <span className="text-outline">—</span>}</Td>
                    <Td className={clsx('font-mono', l.buffered_events ? 'text-secondary' : 'text-outline')}>{num(l.buffered_events)}</Td>
                    <Td>
                      <ExternalRefs refs={l.external_refs} />
                    </Td>
                    <Td>
                      <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <Dot tone={locationTone(l)} />
                        <span className="text-on-surface-variant">{locationStatusLabel(l)}</span>
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <LocationFormModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={(row) => row?.id && nav(`/locations/${row.id}`)} />
    </div>
  );
}

function LocationCard({ l }: { l: any }) {
  const r = rate(l.present_today, l.active_employees);
  const tone = locationTone(l);
  return (
    <Link
      to={`/locations/${l.id}`}
      className={clsx('relative overflow-hidden p-space-md bg-surface-container rounded shadow-sm hover:bg-surface-container-high transition-colors flex flex-col gap-space-sm', !l.is_active && 'opacity-70')}
    >
      <div
        className={clsx(
          'absolute top-0 left-0 right-0 h-0.5',
          tone === 'error' ? 'bg-error' : tone === 'warning' ? 'bg-warning' : tone === 'success' ? 'bg-tertiary' : 'bg-outline-variant'
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-headline-sm text-headline-sm text-on-surface truncate">{l.name}</div>
          <div className="font-label-sm text-label-sm text-outline font-mono truncate">
            {l.code} · {l.timezone} · {localNow(l.timezone)} local
          </div>
        </div>
        <span className="flex items-center gap-1.5 shrink-0 font-label-sm text-label-sm text-on-surface-variant">
          <Dot tone={tone} pulse={tone === 'error'} />
          {locationStatusLabel(l)}
        </span>
      </div>
      {l.address && <p className="font-body-sm text-body-sm text-on-surface-variant line-clamp-1">{l.address}</p>}

      <div>
        <div className="flex items-center justify-between font-label-sm text-label-sm mb-1">
          <span className="text-on-surface-variant">
            Today: <span className="text-on-surface font-semibold">{num(l.present_today)}</span> / {num(l.active_employees)} present
            {l.late_today > 0 && <span className="text-warning"> · {num(l.late_today)} late</span>}
          </span>
          <span className="text-on-surface font-mono">{r === null ? '—' : pct(r, 0)}</span>
        </div>
        <Progress value={r ?? 0} tone="success" />
      </div>

      <div className="grid grid-cols-4 gap-space-xs">
        <Mini label="Employees" value={num(l.active_employees)} />
        <Mini label="Devices" value={`${num(l.online_devices)}/${num(l.devices)}`} cls={l.offline_devices ? 'text-error' : undefined} />
        <Mini label="Alerts" value={num(l.open_alerts)} cls={l.open_alerts ? 'text-warning' : undefined} />
        <Mini label="Buffered" value={num(l.buffered_events)} cls={l.buffered_events ? 'text-secondary' : undefined} />
      </div>

      <div className="flex items-center justify-between gap-2 pt-space-xs border-t border-outline-variant/20">
        <ExternalRefs refs={l.external_refs} />
        <span className="font-label-sm text-label-sm text-outline shrink-0">
          {hhmm(l.work_start)}–{hhmm(l.work_end)} · {workdaysLabel(l.workdays)}
        </span>
      </div>
    </Link>
  );
}

function Mini({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="bg-surface-container-lowest rounded px-2 py-1.5">
      <div className="font-label-sm text-[9px] text-outline uppercase tracking-wider truncate">{label}</div>
      <div className={clsx('font-mono text-body-md text-on-surface', cls)}>{value}</div>
    </div>
  );
}
