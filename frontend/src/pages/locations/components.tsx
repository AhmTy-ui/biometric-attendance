import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Field, Icon, Input, LinkButton, Modal, Textarea, Toggle, useErrorToast, useToast, type Tone } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { num, relative } from '@/lib/format';

/** Common IANA zones offered in the picker; any valid IANA name can be typed. */
export const COMMON_TIMEZONES = [
  'Africa/Lagos',
  'Africa/Abidjan',
  'Africa/Accra',
  'Africa/Algiers',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Dakar',
  'Africa/Dar_es_Salaam',
  'Africa/Douala',
  'Africa/Johannesburg',
  'Africa/Kampala',
  'Africa/Kigali',
  'Africa/Kinshasa',
  'Africa/Luanda',
  'Africa/Lusaka',
  'Africa/Maputo',
  'Africa/Nairobi',
  'Africa/Tunis',
  'Africa/Windhoek',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Brussels',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Zurich',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Asia/Dubai',
  'UTC'
];

export const WEEKDAYS: { iso: number; short: string }[] = [
  { iso: 1, short: 'Mon' },
  { iso: 2, short: 'Tue' },
  { iso: 3, short: 'Wed' },
  { iso: 4, short: 'Thu' },
  { iso: 5, short: 'Fri' },
  { iso: 6, short: 'Sat' },
  { iso: 7, short: 'Sun' }
];

export const hhmm = (t?: string | null) => (t ? String(t).slice(0, 5) : '—');

export function workdaysLabel(days?: number[] | null) {
  if (!days?.length) return '—';
  const sorted = [...days].map(Number).sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  const name = (d: number) => WEEKDAYS.find((w) => w.iso === d)?.short ?? String(d);
  if (contiguous && sorted.length > 2) return `${name(sorted[0]!)}–${name(sorted[sorted.length - 1]!)}`;
  return sorted.map(name).join(', ');
}

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Current local time at a location (by IANA zone). */
export function localNow(tz?: string | null) {
  if (!tz || !isValidTimezone(tz)) return '—';
  return new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Overall health tone of a location row (from LOC_SELECT counts). */
export function locationTone(l: any): Tone {
  if (!l.is_active) return 'neutral';
  if ((l.offline_devices ?? 0) > 0) return 'error';
  if ((l.open_alerts ?? 0) > 0) return 'warning';
  if ((l.devices ?? 0) === 0) return 'neutral';
  return 'success';
}
export function locationStatusLabel(l: any) {
  if (!l.is_active) return 'Inactive';
  if ((l.devices ?? 0) === 0) return 'No devices';
  if ((l.offline_devices ?? 0) > 0) return `${l.offline_devices} offline`;
  if ((l.open_alerts ?? 0) > 0) return 'Attention';
  return 'Operational';
}

export function rate(part?: number | null, whole?: number | null) {
  if (!whole) return null;
  return ((part ?? 0) / whole) * 100;
}

interface FormState {
  name: string;
  code: string;
  address: string;
  timezone: string;
  workStart: string;
  workEnd: string;
  graceMinutes: string;
  workdays: number[];
  isActive: boolean;
}

function initial(loc?: any): FormState {
  return loc
    ? {
        name: loc.name ?? '',
        code: loc.code ?? '',
        address: loc.address ?? '',
        timezone: loc.timezone ?? '',
        workStart: hhmm(loc.work_start),
        workEnd: hhmm(loc.work_end),
        graceMinutes: String(loc.grace_minutes ?? 15),
        workdays: (loc.workdays ?? []).map(Number),
        isActive: Boolean(loc.is_active)
      }
    : {
        name: '',
        code: '',
        address: '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos',
        workStart: '08:00',
        workEnd: '17:00',
        graceMinutes: '15',
        workdays: [1, 2, 3, 4, 5],
        isActive: true
      };
}

/** Create / edit location modal (POST /api/locations, PATCH /api/locations/:id). */
export function LocationFormModal({ open, onClose, location, onSaved }: { open: boolean; onClose: () => void; location?: any; onSaved?: (row: any) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const editing = Boolean(location);
  const [f, setF] = useState<FormState>(() => initial(location));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setF(initial(location));
      setErrors({});
    }
  }, [open, location]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(),
        code: f.code.trim(),
        address: f.address.trim() || null,
        timezone: f.timezone.trim(),
        workStart: f.workStart,
        workEnd: f.workEnd,
        graceMinutes: Number(f.graceMinutes),
        workdays: [...f.workdays].sort((a, b) => a - b)
      };
      if (editing) body.isActive = f.isActive;
      return editing ? api.patch(`/api/locations/${location.id}`, body) : api.post('/api/locations', body);
    },
    onSuccess: (row: any) => {
      toast({ tone: 'success', title: editing ? 'Location updated' : 'Location created', description: row?.name });
      void qc.invalidateQueries({ queryKey: ['locations'] });
      void qc.invalidateQueries({ queryKey: ['location'] });
      onSaved?.(row);
      onClose();
    },
    onError: (e) => {
      const err = e as ApiError;
      if (Array.isArray(err?.details)) {
        const map: Record<string, string> = {};
        for (const d of err.details) if (d?.path) map[String(d.path).split('.')[0]!] = d.message;
        setErrors(map);
      }
      errToast(e, editing ? 'Could not update location' : 'Could not create location');
    }
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.name.trim().length < 2) errs.name = 'At least 2 characters.';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(f.code.trim())) errs.code = 'Letters, digits, dot, dash, underscore (max 40).';
    if (!isValidTimezone(f.timezone.trim())) errs.timezone = 'Unknown IANA timezone (e.g. Africa/Lagos).';
    if (!/^\d{2}:\d{2}$/.test(f.workStart)) errs.workStart = 'Use HH:MM.';
    if (!/^\d{2}:\d{2}$/.test(f.workEnd)) errs.workEnd = 'Use HH:MM.';
    const g = Number(f.graceMinutes);
    if (!Number.isInteger(g) || g < 0 || g > 240) errs.graceMinutes = '0 – 240 minutes.';
    if (!f.workdays.length) errs.workdays = 'Choose at least one workday.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    m.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!m.isPending) onClose();
      }}
      title={editing ? `Edit ${location.name}` : 'Create location'}
      icon={editing ? 'edit_location_alt' : 'add_location_alt'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="location-form" icon="save" loading={m.isPending}>
            {editing ? 'Save changes' : 'Create location'}
          </Button>
        </>
      }
    >
      <form id="location-form" onSubmit={submit} className="flex flex-col gap-space-md">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
          <div className="sm:col-span-2">
            <Field label="Location name" required error={errors.name}>
              <Input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus placeholder="e.g. Lagos Head Office" />
            </Field>
          </div>
          <Field label="Location code" required error={errors.code} hint="Reference used by the web software">
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} maxLength={40} className="font-mono" placeholder="LOS-HQ" />
          </Field>
        </div>
        <Field label="Address" error={errors.address}>
          <Textarea value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} className="min-h-[60px]" />
        </Field>
        <Field label="Timezone" required error={errors.timezone} hint="Pick a common zone or type any IANA timezone name">
          <Input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} list="bamp-timezones" className="font-mono" />
        </Field>
        <datalist id="bamp-timezones">
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
          <Field label="Work starts" required error={errors.workStart}>
            <Input type="time" value={f.workStart} onChange={(e) => set('workStart', e.target.value)} />
          </Field>
          <Field label="Work ends" required error={errors.workEnd}>
            <Input type="time" value={f.workEnd} onChange={(e) => set('workEnd', e.target.value)} />
          </Field>
          <Field label="Grace period (min)" required error={errors.graceMinutes} hint="Late after start + grace">
            <Input type="number" min={0} max={240} value={f.graceMinutes} onChange={(e) => set('graceMinutes', e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide">
            Workdays<span className="text-error"> *</span>
          </span>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((d) => {
              const on = f.workdays.includes(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  onClick={() => set('workdays', on ? f.workdays.filter((x) => x !== d.iso) : [...f.workdays, d.iso])}
                  className={clsx(
                    'px-3 h-8 rounded font-label-md text-label-md transition-colors border',
                    on ? 'bg-primary-container text-on-primary-container border-primary-container' : 'bg-surface-container-lowest text-outline border-outline-variant/40 hover:text-on-surface'
                  )}
                  aria-pressed={on}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          {errors.workdays && <span className="font-body-sm text-body-sm text-error">{errors.workdays}</span>}
        </div>
        {editing && (
          <div className="flex items-center justify-between gap-space-md p-space-sm bg-surface-container rounded">
            <div>
              <div className="text-body-sm text-on-surface font-semibold">Location active</div>
              <div className="font-body-sm text-body-sm text-outline">Inactive locations are excluded from today's attendance summaries.</div>
            </div>
            <Toggle checked={f.isActive} onChange={(v) => set('isActive', v)} />
          </div>
        )}
      </form>
    </Modal>
  );
}

/**
 * Offline device card (user flow §30): what is happening, where, since when, impact, and what to do.
 */
export function OfflineDeviceCard({ device, location }: { device: any; location: { id: string; name: string; active_employees?: number } }) {
  return (
    <div className="p-space-sm bg-error-container/10 rounded shadow-sm flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="cloud_off" className="text-error text-[16px]" />
          <span className="font-label-lg text-label-lg font-bold text-on-surface truncate">
            {location.name} · {device.name}
          </span>
        </div>
        <Badge tone="error">Offline</Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 font-label-sm text-label-sm">
        <div>
          <div className="text-outline uppercase tracking-wider">Last seen</div>
          <div className="text-on-surface" title={device.last_heartbeat_at ?? undefined}>
            {relative(device.last_heartbeat_at)}
          </div>
        </div>
        <div>
          <div className="text-outline uppercase tracking-wider">Buffered</div>
          <div className="text-on-surface font-mono">{num(device.pending_events ?? 0)} events</div>
        </div>
        <div>
          <div className="text-outline uppercase tracking-wider">Employees affected</div>
          <div className="text-on-surface font-mono">{num(location.active_employees ?? 0)}</div>
        </div>
      </div>
      <p className="font-body-sm text-[11px] text-outline">Attendance captured by this device is stored on it and will be uploaded when it reconnects.</p>
      <div className="flex items-center gap-1.5">
        <LinkButton size="sm" to={`/devices/${device.id}`} icon="router">
          View device
        </LinkButton>
        <LinkButton size="sm" variant="ghost" to={`/locations/${location.id}`} icon="location_on">
          View location
        </LinkButton>
      </div>
    </div>
  );
}

export function ExternalRefs({ refs }: { refs?: string[] | null }) {
  if (!refs?.length) return <span className="font-label-sm text-label-sm text-outline">No web-software reference</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {refs.map((r) => (
        <span key={r} className="px-1.5 py-0.5 rounded bg-surface-container-high font-mono text-[10px] text-on-surface-variant" title="Web-software location reference">
          {r}
        </span>
      ))}
    </div>
  );
}

export function AlertRow({ a }: { a: any }) {
  const tone: Tone = a.status === 'resolved' ? 'neutral' : a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info';
  return (
    <Link to={`/alerts/${a.id}`} className="flex items-start gap-space-sm p-space-sm rounded bg-surface-container hover:bg-surface-container-high transition-colors">
      <Icon
        name={a.status === 'resolved' ? 'check_circle' : a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : 'info'}
        className={clsx('text-[18px] shrink-0', tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : tone === 'info' ? 'text-secondary' : 'text-outline')}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-sm text-on-surface font-semibold truncate">{a.title}</span>
          <Badge tone={tone}>{a.status}</Badge>
        </div>
        <p className="font-body-sm text-[11px] text-on-surface-variant line-clamp-2">{a.description}</p>
        <div className="font-label-sm text-label-sm text-outline mt-0.5">
          {relative(a.last_occurred_at ?? a.created_at)}
          {a.occurrences > 1 ? ` · ${num(a.occurrences)} occurrences` : ''}
          {a.device_name ? ` · ${a.device_name}` : ''}
        </div>
      </div>
    </Link>
  );
}

/** Shared recharts styling derived from the design tokens. */
export const chartTheme = {
  grid: '#434655',
  tick: { fill: '#8d90a0', fontSize: 10, fontFamily: '"JetBrains Mono Variable", monospace' },
  tooltip: {
    contentStyle: { background: '#262a33', border: '1px solid #434655', borderRadius: 4, fontSize: 12, color: '#dfe2ee' },
    labelStyle: { color: '#c3c6d7', fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 11 },
    itemStyle: { color: '#dfe2ee' },
    cursor: { fill: 'rgba(141,144,160,0.08)' }
  },
  colors: { in: '#4edea3', out: '#93ccff', rate: '#b4c5ff', late: '#f5b54a', absent: '#ffb4ab' }
};
