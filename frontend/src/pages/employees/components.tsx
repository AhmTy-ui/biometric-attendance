import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { Badge, Dot, Icon, type Tone } from '@/components/ui';
import { humanize, relative, time } from '@/lib/format';

/** Fingers required per employee (enrolment policy, user flow §9). */
export const REQUIRED_FINGERS = 2;

export type BiometricState = 'enrolled' | 'partial' | 'none';

export function biometricState(fingers: number | null | undefined, required = REQUIRED_FINGERS): BiometricState {
  const n = Number(fingers ?? 0);
  if (n >= required) return 'enrolled';
  if (n > 0) return 'partial';
  return 'none';
}

export const biometricTone = (s: BiometricState): Tone => (s === 'enrolled' ? 'success' : s === 'partial' ? 'warning' : 'error');
export const biometricLabel = (s: BiometricState) => (s === 'enrolled' ? 'Enrolled' : s === 'partial' ? 'Partial' : 'Not enrolled');

/** Fingers enrolled vs required, e.g. "Enrolled 2/2". */
export function BiometricBadge({ fingers, required = REQUIRED_FINGERS, compact }: { fingers: number | null | undefined; required?: number; compact?: boolean }) {
  const s = biometricState(fingers, required);
  const n = Number(fingers ?? 0);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={biometricTone(s)} icon="fingerprint">
        {compact ? `${n}/${required}` : `${biometricLabel(s)} ${n}/${required}`}
      </Badge>
    </span>
  );
}

export const employmentTone = (s?: string | null): Tone =>
  s === 'active' ? 'success' : s === 'suspended' ? 'warning' : s === 'terminated' ? 'error' : 'neutral';

export function EmploymentBadge({ status }: { status?: string | null }) {
  return <Badge tone={employmentTone(status)}>{humanize(status)}</Badge>;
}

/** Row shape shared by /api/employees rows and /api/employees/:id `employee`. */
export interface EmployeeTodayRow {
  employment_status?: string;
  location_id?: string | null;
  today_first_in?: string | null;
  today_last_out?: string | null;
  today_late?: boolean | null;
  today_last_direction?: 'in' | 'out' | null;
  today_last_at?: string | null;
}

export type TodayKind = 'in' | 'out' | 'present' | 'absent' | 'na';

export function todayKind(e: EmployeeTodayRow): TodayKind {
  if (e.employment_status !== 'active' || !e.location_id) return 'na';
  if (e.today_last_direction === 'in') return 'in';
  if (e.today_last_direction === 'out') return 'out';
  if (e.today_first_in) return 'present';
  return 'absent';
}

/** Attendance status today: clocked in / clocked out / absent (not yet clocked in). */
export function TodayStatus({ e, detailed }: { e: EmployeeTodayRow; detailed?: boolean }) {
  const k = todayKind(e);
  if (k === 'na')
    return (
      <span className="font-label-sm text-label-sm text-outline" title={e.employment_status !== 'active' ? 'Not on device rosters' : 'No assigned location'}>
        {e.employment_status !== 'active' ? 'Not tracked' : 'Unassigned'}
      </span>
    );
  if (k === 'absent')
    return (
      <span className="flex flex-col">
        <span className="font-label-sm text-label-sm text-on-surface-variant font-semibold flex items-center gap-1">
          <Dot tone="neutral" /> NOT CLOCKED IN
        </span>
        {detailed && <span className="font-label-sm text-label-sm text-outline">No attendance recorded today</span>}
      </span>
    );
  const isIn = k === 'in' || k === 'present';
  return (
    <span className="flex flex-col">
      <span className={clsx('font-label-sm text-label-sm font-semibold flex items-center gap-1', isIn ? 'text-tertiary' : 'text-secondary')}>
        <Dot tone={isIn ? 'success' : 'info'} pulse={k === 'in'} />
        {k === 'out' ? 'OUT' : 'IN'} {time(e.today_last_at ?? e.today_first_in, undefined, false)}
        {e.today_late && (
          <Badge tone="warning" className="ml-1">
            Late
          </Badge>
        )}
      </span>
      {detailed ? (
        <span className="font-label-sm text-label-sm text-outline">
          First in {time(e.today_first_in, undefined, false)} · Last out {time(e.today_last_out, undefined, false)}
        </span>
      ) : (
        e.today_last_at && <span className="font-label-sm text-label-sm text-outline">{relative(e.today_last_at)}</span>
      )}
    </span>
  );
}

/** Assigned location, or the unmapped external reference for unassigned employees. */
export function LocationCell({ e, linkable = true }: { e: { location_id?: string | null; location_name?: string | null; location_code?: string | null; external_location_ref?: string | null }; linkable?: boolean }) {
  if (e.location_id)
    return (
      <span className="flex flex-col min-w-0">
        {linkable ? (
          <Link to={`/locations/${e.location_id}`} onClick={(ev) => ev.stopPropagation()} className="text-on-surface hover:text-primary truncate">
            {e.location_name ?? '—'}
          </Link>
        ) : (
          <span className="text-on-surface truncate">{e.location_name ?? '—'}</span>
        )}
        {e.location_code && <span className="font-label-sm text-label-sm text-outline font-mono">{e.location_code}</span>}
      </span>
    );
  return (
    <span className="flex flex-col min-w-0">
      <span className="font-label-sm text-label-sm text-warning font-semibold flex items-center gap-1">
        <Icon name="link_off" className="text-[13px]" /> UNASSIGNED
      </span>
      {e.external_location_ref ? (
        linkable ? (
          <Link to="/integration/unmapped" onClick={(ev) => ev.stopPropagation()} className="font-label-sm text-label-sm text-outline font-mono hover:text-primary truncate" title="Resolve unmapped location">
            Ref: {e.external_location_ref}
          </Link>
        ) : (
          <span className="font-label-sm text-label-sm text-outline font-mono truncate">Ref: {e.external_location_ref}</span>
        )
      ) : (
        <span className="font-label-sm text-label-sm text-outline">No location in web software</span>
      )}
    </span>
  );
}

export function minutesToHours(m: number | null | undefined) {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(Number(m) / 60);
  const r = Math.round(Number(m) % 60);
  return `${h}h ${String(r).padStart(2, '0')}m`;
}

/** Format a 'YYYY-MM-DD' calendar date without timezone shifting. */
export function calendarDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (!y || !m) return d;
  return new Date(y, m - 1, day || 1).toLocaleDateString('en-GB', opts);
}

/** Add days to a 'YYYY-MM-DD' calendar date. */
export function addDays(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number);
  const x = new Date(y!, m! - 1, day! + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
