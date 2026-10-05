import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Badge, Button, Icon, Input, Select, Table, Td, Th, THead, Tr, useDebounced, type Tone } from '@/components/ui';
import { api, type Query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { LiveFrame } from '@/lib/live';
import { date, duration, relative, time, tzOffsetLabel } from '@/lib/format';

// ───────────────────────── Labels ─────────────────────────
export const DELIVERY_LABEL: Record<string, string> = {
  pending: 'Pending',
  delivering: 'Delivering',
  delivered: 'Delivered',
  retrying: 'Retrying',
  dead_letter: 'Dead-letter queue',
  exported: 'Exported',
  not_queued: 'Not queued'
};
const DELIVERY_ICON: Record<string, string> = {
  pending: 'schedule',
  delivering: 'upload',
  delivered: 'done_all',
  retrying: 'autorenew',
  dead_letter: 'report',
  exported: 'file_export',
  not_queued: 'block'
};
export const CHANNEL_LABEL: Record<string, string> = {
  mqtt: 'MQTT real-time',
  https_batch: 'HTTPS buffered upload'
};
export const OUTCOME_LABEL: Record<string, string> = {
  success: 'Success',
  retryable: 'Failed · will retry',
  rejected: 'Rejected by web software',
  dead_letter: 'Moved to dead-letter queue'
};
export const outcomeTone = (o: string | null | undefined): Tone =>
  o === 'success' ? 'success' : o === 'dead_letter' ? 'error' : o === 'rejected' ? 'error' : o === 'retryable' ? 'warning' : 'neutral';

const toneText: Record<Tone, string> = {
  success: 'text-tertiary',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-secondary',
  neutral: 'text-on-surface-variant',
  primary: 'text-primary'
};
export const toneTextCls = (t: Tone) => toneText[t];

// ───────────────────────── Small cells / badges ─────────────────────────
export function DirectionBadge({ direction }: { direction: string | null | undefined }) {
  if (direction === 'in')
    return (
      <span className="px-2 py-0.5 rounded bg-tertiary-container/30 text-tertiary font-label-sm text-[10px] font-bold tracking-wider uppercase whitespace-nowrap">Clock in</span>
    );
  if (direction === 'out')
    return (
      <span className="px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant font-label-sm text-[10px] font-bold tracking-wider uppercase whitespace-nowrap">Clock out</span>
    );
  return <span className="text-outline">—</span>;
}

export function DeliveryBadge({ status }: { status: string | null | undefined }) {
  const key = status ?? 'not_queued';
  const tone: Tone = status ? deliveryToneOf(status) : 'neutral';
  return (
    <Badge tone={tone} icon={DELIVERY_ICON[key] ?? 'help'}>
      {DELIVERY_LABEL[key] ?? key}
    </Badge>
  );
}
function deliveryToneOf(s: string): Tone {
  if (s === 'delivered' || s === 'exported') return 'success';
  if (s === 'dead_letter') return 'error';
  if (s === 'retrying') return 'warning';
  return 'info';
}

/** Web-software delivery status with attempts / last error / next retry underneath. */
export function DeliveryCell({ ev }: { ev: any }) {
  const s = ev.delivery_status as string | null;
  return (
    <div className="flex flex-col gap-0.5 items-start">
      <DeliveryBadge status={s} />
      {s === 'delivered' && ev.delivered_at && <span className="font-mono text-[10px] text-outline">ACK {ev.delivery_http_status ?? ''} · {relative(ev.delivered_at)}</span>}
      {(s === 'retrying' || s === 'dead_letter') && (
        <span className="font-mono text-[10px] text-error max-w-[220px] truncate" title={ev.delivery_error ?? undefined}>
          {ev.delivery_http_status ? `HTTP ${ev.delivery_http_status} · ` : ''}
          {ev.delivery_error ?? 'No error detail'}
        </span>
      )}
      {s === 'retrying' && ev.next_attempt_at && (
        <span className="font-mono text-[10px] text-outline">
          Attempt {ev.delivery_attempts ?? 0} · next {relative(ev.next_attempt_at)}
        </span>
      )}
      {s === 'dead_letter' && <span className="font-mono text-[10px] text-outline">after {ev.delivery_attempts ?? 0} attempt(s)</span>}
    </div>
  );
}

export function ChannelCell({ ev }: { ev: any }) {
  const mqtt = ev.channel === 'mqtt';
  const lagMs = ev.received_at && ev.captured_at ? new Date(ev.received_at).getTime() - new Date(ev.captured_at).getTime() : null;
  return (
    <div className="flex flex-col">
      <span className={clsx('flex items-center gap-1 font-label-sm text-label-sm whitespace-nowrap', mqtt ? 'text-secondary' : 'text-warning')}>
        <Icon name={mqtt ? 'cell_tower' : 'cloud_sync'} className="text-[14px]" />
        {CHANNEL_LABEL[ev.channel] ?? ev.channel ?? '—'}
      </span>
      <span className="font-mono text-[10px] text-outline whitespace-nowrap">
        {ev.was_buffered ? 'Buffered offline · ' : ''}
        {lagMs !== null && lagMs >= 0 ? `received +${duration(lagMs)}` : ''}
      </span>
    </div>
  );
}

export function MatchScore({ score }: { score: number | string | null | undefined }) {
  if (score === null || score === undefined || score === '') return <span className="text-outline">—</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-label-lg text-on-surface font-semibold">
      <Icon name="fingerprint" className="text-[14px] text-primary" />
      {Number(score)}
      <span className="text-[10px] text-outline font-normal">/100</span>
    </span>
  );
}

/** Capture time in the location's timezone, with the device-reported UTC offset. */
export function EventTime({ ev, withDate = true }: { ev: any; withDate?: boolean }) {
  const tz = ev.location_timezone ?? undefined;
  return (
    <div className="flex flex-col whitespace-nowrap">
      <span className="font-mono text-label-lg text-on-surface font-semibold">{time(ev.captured_at, tz)}</span>
      <span className="font-mono text-[10px] text-outline">
        {withDate && <>{date(ev.captured_at, tz)} · </>}
        {typeof ev.tz_offset_minutes === 'number' ? tzOffsetLabel(ev.tz_offset_minutes) : ''}
        {tz ? ` · ${tz}` : ''}
      </span>
    </div>
  );
}

export function EmployeeCell({ ev, link = true }: { ev: any; link?: boolean }) {
  const { can } = useAuth();
  const name = ev.employee_name ?? 'Unknown employee';
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Avatar name={name} size={7} />
      <div className="flex flex-col min-w-0">
        {link && can('employees.view') && ev.employee_id ? (
          <Link to={`/employees/${ev.employee_id}`} onClick={(e) => e.stopPropagation()} className="text-on-surface font-semibold text-body-sm leading-tight hover:text-primary hover:underline truncate">
            {name}
          </Link>
        ) : (
          <span className="text-on-surface font-semibold text-body-sm leading-tight truncate">{name}</span>
        )}
        {ev.department && <span className="font-label-sm text-[10px] text-outline truncate">{ev.department}</span>}
      </div>
    </div>
  );
}

// ───────────────────────── Event table ─────────────────────────
export interface EventTableProps {
  rows: any[];
  flashIds?: Set<string>;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: (ids: string[], on: boolean) => void;
  actions?: (ev: any) => ReactNode;
  compact?: boolean;
}

export function EventTable({ rows, flashIds, selectable, selected, onToggle, onToggleAll, actions, compact }: EventTableProps) {
  const allOn = selectable && rows.length > 0 && rows.every((r) => selected?.has(r.id));
  return (
    <Table>
      <THead>
        <tr>
          {selectable && (
            <Th className="w-8">
              <input
                type="checkbox"
                aria-label="Select all"
                className="accent-primary-container"
                checked={Boolean(allOn)}
                onChange={(e) => onToggleAll?.(rows.map((r) => r.id), e.target.checked)}
              />
            </Th>
          )}
          <Th>Employee</Th>
          <Th>Staff No</Th>
          <Th>Location · Device</Th>
          <Th className="text-center">Direction</Th>
          <Th>Timestamp (location time)</Th>
          <Th>Match score</Th>
          {!compact && <Th>Channel</Th>}
          <Th>Web delivery</Th>
          {actions && <Th className="text-right">Actions</Th>}
        </tr>
      </THead>
      <tbody className="text-on-surface">
        {rows.map((ev) => (
          <EventRow
            key={ev.id}
            ev={ev}
            flash={flashIds?.has(ev.id)}
            selectable={selectable}
            selected={selected?.has(ev.id)}
            onToggle={onToggle}
            actions={actions}
            compact={compact}
          />
        ))}
      </tbody>
    </Table>
  );
}

export function EventRow({ ev, flash, selectable, selected, onToggle, actions, compact }: { ev: any; flash?: boolean; selectable?: boolean; selected?: boolean; onToggle?: (id: string) => void; actions?: (ev: any) => ReactNode; compact?: boolean }) {
  const navigate = useNavigate();
  const s = ev.delivery_status;
  return (
    <Tr
      onClick={() => navigate(`/attendance/events/${ev.id}`)}
      className={clsx(flash && 'row-flash', s === 'dead_letter' && 'bg-error-container/10', ev.was_buffered && s !== 'dead_letter' && 'bg-surface-container/30')}
    >
      {selectable && (
        <Td className="w-8">
          <input
            type="checkbox"
            aria-label="Select event"
            className="accent-primary-container"
            checked={Boolean(selected)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggle?.(ev.id)}
          />
        </Td>
      )}
      <Td className="whitespace-nowrap">
        <EmployeeCell ev={ev} />
      </Td>
      <Td className="font-mono text-[11px] text-on-surface-variant whitespace-nowrap">{ev.staff_number ?? '—'}</Td>
      <Td className="whitespace-nowrap">
        <div className="text-on-surface text-body-sm">{ev.location_name ?? '—'}</div>
        <div className="font-mono text-[10px] text-outline">
          {ev.device_name ?? '—'}
          {ev.device_uid ? ` · ${ev.device_uid}` : ''}
        </div>
      </Td>
      <Td className="text-center whitespace-nowrap">
        <DirectionBadge direction={ev.direction} />
      </Td>
      <Td>
        <EventTime ev={ev} />
      </Td>
      <Td className="whitespace-nowrap">
        <MatchScore score={ev.match_score} />
      </Td>
      {!compact && (
        <Td>
          <ChannelCell ev={ev} />
        </Td>
      )}
      <Td>
        <DeliveryCell ev={ev} />
      </Td>
      {actions && (
        <Td className="text-right whitespace-nowrap" >
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {actions(ev)}
          </div>
        </Td>
      )}
    </Tr>
  );
}

// ───────────────────────── Filters ─────────────────────────
export interface EventFilters {
  locationId?: string;
  deviceId?: string;
  employeeId?: string;
  direction?: string;
  status?: string;
  channel?: string;
  date?: string;
  from?: string; // datetime-local value (browser local time)
  to?: string;
  q?: string;
  minScore?: string;
  maxScore?: string;
}
export type FilterField = keyof EventFilters;

/** Turn UI filter values into the query accepted by /api/attendance/events(/export). */
export function toApiQuery(f: EventFilters): Query {
  const iso = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  return {
    locationId: f.locationId || undefined,
    deviceId: f.deviceId || undefined,
    employeeId: f.employeeId || undefined,
    direction: f.direction || undefined,
    status: f.status || undefined,
    channel: f.channel || undefined,
    date: f.date || undefined,
    from: iso(f.from),
    to: iso(f.to),
    q: f.q?.trim() || undefined,
    minScore: f.minScore !== undefined && f.minScore !== '' ? Number(f.minScore) : undefined,
    maxScore: f.maxScore !== undefined && f.maxScore !== '' ? Number(f.maxScore) : undefined
  };
}

function localDate(v: string, tz?: string) {
  try {
    return new Date(v).toLocaleDateString('en-CA', { timeZone: tz || undefined });
  } catch {
    return new Date(v).toISOString().slice(0, 10);
  }
}

/** Client-side check used for live frames so the feed respects the active filters. */
export function matchesFilters(ev: any, f: EventFilters): boolean {
  if (f.locationId && ev.location_id !== f.locationId) return false;
  if (f.deviceId && ev.device_id !== f.deviceId) return false;
  if (f.employeeId && ev.employee_id !== f.employeeId) return false;
  if (f.direction && ev.direction !== f.direction) return false;
  if (f.channel && ev.channel !== f.channel) return false;
  if (f.status) {
    const s = ev.delivery_status ?? 'not_queued';
    if (s !== f.status) return false;
  }
  if (f.date && localDate(ev.captured_at, ev.location_timezone) !== f.date) return false;
  if (f.from && new Date(ev.captured_at).getTime() < new Date(f.from).getTime()) return false;
  if (f.to && new Date(ev.captured_at).getTime() >= new Date(f.to).getTime()) return false;
  if (f.minScore && Number(ev.match_score) < Number(f.minScore)) return false;
  if (f.maxScore && Number(ev.match_score) > Number(f.maxScore)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [ev.employee_name, ev.staff_number, ev.event_uid, ev.device_name].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Merge a `delivery/updated` frame into a list of event rows (frames carry either a full row or {eventId,status,...}). */
export function applyDeliveryFrame(rows: any[], f: LiveFrame): any[] {
  const d = f.data ?? {};
  const id = d.eventId ?? d.id;
  if (!id) return rows;
  let changed = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    changed = true;
    if (d.employee_name !== undefined) return { ...r, ...d };
    return {
      ...r,
      delivery_status: d.status ?? r.delivery_status,
      delivery_attempts: d.attempts ?? r.delivery_attempts,
      delivery_error: d.status === 'delivered' ? null : d.error ?? r.delivery_error,
      delivered_at: d.status === 'delivered' ? f.at ?? new Date().toISOString() : r.delivered_at
    };
  });
  return changed ? next : rows;
}

/** Reference lists for the filter bar (locations & devices the user may see). */
export function useFilterOptions() {
  const { can } = useAuth();
  const locations = useQuery<any[]>({
    queryKey: ['locations-lite'],
    queryFn: () => api.get('/api/locations'),
    staleTime: 300_000,
    enabled: can('locations.view')
  });
  const devices = useQuery<any>({
    queryKey: ['devices', { lite: true }],
    queryFn: () => api.get('/api/devices', { limit: 1000 }),
    staleTime: 120_000,
    enabled: can('devices.view')
  });
  return { locations: locations.data ?? [], devices: (devices.data?.rows ?? []) as any[] };
}

/** Search-as-you-type employee selector (returns employee id). */
export function EmployeePicker({ value, onChange }: { value?: string; onChange: (id: string | undefined) => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 250);
  const allowed = can('employees.view');
  const res = useQuery<any>({
    queryKey: ['employees', { q: dq, picker: true }],
    queryFn: () => api.get('/api/employees', { q: dq, limit: 8 }),
    enabled: allowed && dq.length >= 2
  });
  const current = useQuery<any>({
    queryKey: ['employee', value],
    queryFn: () => api.get(`/api/employees/${value}`),
    enabled: allowed && Boolean(value),
    staleTime: 300_000
  });
  if (!allowed) return null;
  if (value) {
    const e = current.data?.employee;
    return (
      <div className="flex items-center justify-between gap-2 h-9 bg-surface-container-lowest border border-outline-variant/40 rounded px-space-sm">
        <span className="truncate text-body-sm text-on-surface">
          {e ? (
            <>
              {e.full_name} <span className="font-mono text-[10px] text-outline">{e.staff_number}</span>
            </>
          ) : (
            'Loading…'
          )}
        </span>
        <button type="button" className="text-outline hover:text-on-surface" onClick={() => onChange(undefined)} aria-label="Clear employee">
          <Icon name="close" className="text-[16px]" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input
        value={q}
        placeholder="Name or staff no…"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && dq.length >= 2 && (
        <div className="absolute left-0 right-0 mt-1 z-50 bg-surface-container-high border border-outline-variant/40 rounded shadow-xl max-h-64 overflow-y-auto py-1">
          {res.isLoading && <div className="px-3 py-2 text-body-sm text-outline">Searching…</div>}
          {res.data && res.data.rows.length === 0 && <div className="px-3 py-2 text-body-sm text-outline">No matching employees</div>}
          {(res.data?.rows ?? []).map((e: any) => (
            <button
              key={e.id}
              type="button"
              onMouseDown={() => {
                onChange(e.id);
                setQ('');
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-container-highest text-left"
            >
              <span className="text-body-sm text-on-surface truncate">{e.full_name}</span>
              <span className="font-mono text-[10px] text-outline">{e.staff_number}</span>
              {e.location_name && <span className="ml-auto text-[10px] text-outline truncate">{e.location_name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterLabel({ children }: { children: ReactNode }) {
  return <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline">{children}</span>;
}

/** Filter toolbar shared by Live Attendance, History and Reconciliation. */
export function EventFiltersBar({
  value,
  onChange,
  fields,
  onReset
}: {
  value: EventFilters;
  onChange: (patch: Partial<EventFilters>) => void;
  fields: FilterField[];
  onReset?: () => void;
}) {
  const { locations, devices } = useFilterOptions();
  const { can } = useAuth();
  const has = (f: FilterField) => fields.includes(f);
  const devs = value.locationId ? devices.filter((d) => d.location_id === value.locationId) : devices;
  const [q, setQ] = useState(value.q ?? '');
  const dq = useDebounced(q, 350);
  useEffect(() => {
    if ((value.q ?? '') !== dq) onChange({ q: dq || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  useEffect(() => {
    setQ(value.q ?? '');
  }, [value.q]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-space-sm">
      {has('q') && (
        <label className="flex flex-col gap-1 xl:col-span-2">
          <FilterLabel>Search</FilterLabel>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Employee, staff no, event ID, device…" />
        </label>
      )}
      {has('locationId') && can('locations.view') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Location</FilterLabel>
          <Select value={value.locationId ?? ''} onChange={(e) => onChange({ locationId: e.target.value || undefined, deviceId: undefined })}>
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {has('deviceId') && can('devices.view') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Device</FilterLabel>
          <Select value={value.deviceId ?? ''} onChange={(e) => onChange({ deviceId: e.target.value || undefined })}>
            <option value="">All devices</option>
            {devs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.device_uid})
              </option>
            ))}
          </Select>
        </label>
      )}
      {has('employeeId') && can('employees.view') && (
        <div className="flex flex-col gap-1">
          <FilterLabel>Employee</FilterLabel>
          <EmployeePicker value={value.employeeId} onChange={(id) => onChange({ employeeId: id })} />
        </div>
      )}
      {has('direction') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Direction</FilterLabel>
          <Select value={value.direction ?? ''} onChange={(e) => onChange({ direction: e.target.value || undefined })}>
            <option value="">Any direction</option>
            <option value="in">Clock in</option>
            <option value="out">Clock out</option>
          </Select>
        </label>
      )}
      {has('status') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Web delivery status</FilterLabel>
          <Select value={value.status ?? ''} onChange={(e) => onChange({ status: e.target.value || undefined })}>
            <option value="">All statuses</option>
            {Object.entries(DELIVERY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </label>
      )}
      {has('channel') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Channel</FilterLabel>
          <Select value={value.channel ?? ''} onChange={(e) => onChange({ channel: e.target.value || undefined })}>
            <option value="">All channels</option>
            <option value="mqtt">MQTT real-time</option>
            <option value="https_batch">HTTPS buffered upload</option>
          </Select>
        </label>
      )}
      {has('date') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>Date (location time)</FilterLabel>
          <Input type="date" value={value.date ?? ''} onChange={(e) => onChange({ date: e.target.value || undefined })} />
        </label>
      )}
      {has('from') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>From</FilterLabel>
          <Input type="datetime-local" value={value.from ?? ''} onChange={(e) => onChange({ from: e.target.value || undefined })} />
        </label>
      )}
      {has('to') && (
        <label className="flex flex-col gap-1">
          <FilterLabel>To</FilterLabel>
          <Input type="datetime-local" value={value.to ?? ''} onChange={(e) => onChange({ to: e.target.value || undefined })} />
        </label>
      )}
      {has('minScore') && (
        <div className="flex flex-col gap-1">
          <FilterLabel>Match score (min – max)</FilterLabel>
          <div className="flex items-center gap-1">
            <Input type="number" min={0} max={100} placeholder="0" value={value.minScore ?? ''} onChange={(e) => onChange({ minScore: e.target.value || undefined })} />
            <span className="text-outline">–</span>
            <Input type="number" min={0} max={100} placeholder="100" value={value.maxScore ?? ''} onChange={(e) => onChange({ maxScore: e.target.value || undefined })} />
          </div>
        </div>
      )}
      {onReset && (
        <div className="flex flex-col justify-end gap-1">
          <Button variant="secondary" icon="filter_alt_off" className="h-9" onClick={onReset}>
            Reset filters
          </Button>
        </div>
      )}
    </div>
  );
}

export const hasActiveFilters = (f: EventFilters) => Object.values(f).some((v) => v !== undefined && v !== '');
