import { keepPreviousData, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Button,
  Empty,
  ErrorState,
  ExportMenu,
  Field,
  Icon,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Panel,
  Select,
  Stat,
  Table,
  Tabs,
  Td,
  Th,
  THead,
  Tr,
  useDebounced,
  useErrorToast
} from '@/components/ui';
import { api, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { num, pct, time, todayIso } from '@/lib/format';
import { useGlobalLocation } from '@/lib/scope';

// ───────────────────────── Types & helpers ─────────────────────────
type ViewKey = 'daily' | 'weekly' | 'monthly' | 'employees' | 'locations' | 'late' | 'absences' | 'trend';
type Preset = 'today' | 'last7' | 'last30' | 'this_month' | 'last3m' | 'last12m' | 'custom';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last3m', label: 'Last 3 months' },
  { key: 'last12m', label: 'Last 12 months' },
  { key: 'custom', label: 'Custom range' }
];

const VIEWS: { key: ViewKey; label: string; icon: string }[] = [
  { key: 'daily', label: 'Daily', icon: 'today' },
  { key: 'weekly', label: 'Weekly', icon: 'date_range' },
  { key: 'monthly', label: 'Monthly', icon: 'calendar_month' },
  { key: 'employees', label: 'Employee attendance', icon: 'badge' },
  { key: 'locations', label: 'Location attendance', icon: 'storefront' },
  { key: 'late', label: 'Late arrivals', icon: 'schedule' },
  { key: 'absences', label: 'Absences', icon: 'event_busy' },
  { key: 'trend', label: 'Attendance trends', icon: 'trending_up' }
];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function presetRange(p: Preset): { from: string; to: string } | null {
  const now = new Date();
  const to = todayIso();
  switch (p) {
    case 'today':
      return { from: to, to };
    case 'last7':
      return { from: todayIso(-6), to };
    case 'last30':
      return { from: todayIso(-29), to };
    case 'this_month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to };
    case 'last3m':
      return { from: iso(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate() + 1)), to };
    case 'last12m':
      return { from: iso(new Date(now.getFullYear(), now.getMonth() - 12, now.getDate() + 1)), to };
    default:
      return null;
  }
}

function localDate(d: string) {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, day ?? 1);
}
function fmtDay(d: string | null | undefined, withWeekday = false) {
  if (!d) return '—';
  return localDate(d).toLocaleDateString('en-GB', { weekday: withWeekday ? 'short' : undefined, day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtShort(d: string) {
  return localDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function fmtMonth(d: string) {
  return localDate(`${d}-01`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
function rateTone(r: number | null | undefined) {
  if (r === null || r === undefined) return 'text-outline';
  return r >= 90 ? 'text-tertiary' : r >= 75 ? 'text-warning' : 'text-error';
}

interface Report {
  summary: any;
  daily: any[];
  weekly: any[];
  monthly: any[];
  employees: any[];
  locations: any[];
  late: any[];
  absences: any[];
  trend: any[];
  departments: string[];
}

// Chart tokens (from the Material 3 palette in tailwind.config.js)
const C = {
  onTime: '#4edea3',
  late: '#f5b54a',
  absent: '#ffb4ab',
  rate: '#b4c5ff',
  avg: '#93ccff',
  grid: 'rgba(67,70,85,0.35)',
  axis: '#8d90a0',
  surface: '#181c24'
};
const tooltipStyle = {
  contentStyle: { background: '#262a33', border: '1px solid rgba(67,70,85,0.6)', borderRadius: 4, fontSize: 12, color: '#dfe2ee' },
  labelStyle: { color: '#c3c6d7', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
  cursor: { fill: 'rgba(180,197,255,0.06)' }
};
const axisProps = { stroke: C.axis, tick: { fill: C.axis, fontSize: 10 }, tickLine: false, axisLine: { stroke: C.grid } } as const;

function usePaged<T>(rows: T[], size = 100) {
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [rows]);
  return { page: rows.slice(offset, offset + size), offset, setOffset, size };
}

// ───────────────────────── Page ─────────────────────────
export default function Reports() {
  const { can, me } = useAuth();
  const errToast = useErrorToast();
  const [globalLoc] = useGlobalLocation();
  const [sp, setSp] = useSearchParams();

  // Applied configuration (URL)
  const applied = {
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    locationId: sp.get('loc') ?? '',
    employeeId: sp.get('emp') ?? '',
    department: sp.get('dept') ?? ''
  };
  const generated = Boolean(applied.from && applied.to);
  const view = (sp.get('view') as ViewKey) || 'daily';

  // Draft configuration (form)
  const [preset, setPreset] = useState<Preset>((sp.get('preset') as Preset) || 'last30');
  const initial = presetRange(preset) ?? { from: applied.from || todayIso(-29), to: applied.to || todayIso() };
  const [from, setFrom] = useState(applied.from || initial.from);
  const [to, setTo] = useState(applied.to || initial.to);
  const [locationId, setLocationId] = useState(generated ? applied.locationId : (globalLoc ?? ''));
  const [department, setDepartment] = useState(applied.department);
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(
    applied.employeeId ? { id: applied.employeeId, name: sp.get('empName') ?? applied.employeeId } : null
  );
  const [empSearch, setEmpSearch] = useState('');
  const empQ = useDebounced(empSearch.trim(), 300);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  };

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
    enabled: can('employees.view'),
    staleTime: 60_000
  });

  const empResults = useQuery({
    queryKey: ['employees', 'report-search', empQ],
    queryFn: () => api.get<{ rows: any[] }>('/api/employees', { q: empQ, limit: 8 }),
    enabled: can('employees.view') && empQ.length >= 2
  });

  const rangeDays = (localDate(to).getTime() - localDate(from).getTime()) / 86400000;
  const formError = !from || !to ? 'Select a date range.' : from > to ? '"From" must be on or before "To".' : rangeDays > 400 ? 'Date range is limited to 13 months.' : null;

  const generate = () => {
    if (formError) return;
    const n = new URLSearchParams();
    n.set('from', from);
    n.set('to', to);
    n.set('preset', preset);
    if (locationId) n.set('loc', locationId);
    if (department) n.set('dept', department);
    if (employee) {
      n.set('emp', employee.id);
      n.set('empName', employee.name);
    }
    n.set('view', view);
    setSp(n);
  };

  const setView = (v: ViewKey) => {
    const n = new URLSearchParams(sp);
    n.set('view', v);
    setSp(n, { replace: true });
  };

  const query = {
    from: applied.from,
    to: applied.to,
    locationId: applied.locationId || undefined,
    employeeId: applied.employeeId || undefined,
    department: applied.department || undefined
  };
  const report = useQuery({
    queryKey: ['reports', query],
    queryFn: () => api.get<Report>('/api/reports/analytics', query),
    enabled: generated,
    placeholderData: keepPreviousData
  });

  const exportView = async (v: ViewKey, format: 'csv' | 'xlsx' | 'pdf') => {
    try {
      await download('/api/reports/export', { view: v, format, ...query });
    } catch (e) {
      errToast(e, 'Export failed');
    }
  };
  const exportBtn = (v: ViewKey, rows: number) => (can('attendance.export') ? <ExportMenu disabled={!rows} onExport={(f) => exportView(v, f)} /> : null);

  const appliedLocName = locationOptions.find((l) => l.id === applied.locationId)?.name;
  const scopeLabel = [
    appliedLocName ?? (applied.locationId ? 'Selected location' : 'All locations'),
    applied.department || null,
    applied.employeeId ? (sp.get('empName') ?? 'Selected employee') : null,
    `${fmtDay(applied.from)} – ${fmtDay(applied.to)}`
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader title="Reports & Analytics" icon="analytics" subtitle="Expected vs actual attendance by day, week, month, employee and location." />

      {/* Report configuration */}
      <Panel title="Report configuration" icon="tune">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-space-sm items-end">
          <div className="xl:col-span-3">
            <Field label="Location">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">All locations</option>
                {locationOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="xl:col-span-3">
            <Field label="Date range">
              <Select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)}>
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="xl:col-span-3">
            <Field label="From">
              <Input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset('custom');
                }}
              />
            </Field>
          </div>
          <div className="xl:col-span-3">
            <Field label="To">
              <Input
                type="date"
                value={to}
                min={from || undefined}
                max={todayIso()}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset('custom');
                }}
              />
            </Field>
          </div>
          <div className="xl:col-span-4">
            <Field label="Department">
              <Select value={department} onChange={(e) => setDepartment(e.target.value)} disabled={!departments.data}>
                <option value="">All departments</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="xl:col-span-5 relative">
            <Field label="Employee">
              {employee ? (
                <div className="h-9 flex items-center justify-between gap-2 bg-surface-container-lowest border border-outline-variant/40 rounded px-space-sm">
                  <span className="flex items-center gap-1.5 min-w-0 text-body-md text-on-surface">
                    <Icon name="person" className="text-[16px] text-primary" />
                    <span className="truncate">{employee.name}</span>
                  </span>
                  <button type="button" className="text-outline hover:text-on-surface" onClick={() => setEmployee(null)} aria-label="Clear employee">
                    <Icon name="close" className="text-[16px]" />
                  </button>
                </div>
              ) : (
                <Input
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  placeholder={can('employees.view') ? 'All employees — type a name or staff number' : 'All employees'}
                  disabled={!can('employees.view')}
                />
              )}
            </Field>
            {!employee && empQ.length >= 2 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-surface-container-high border border-outline-variant/40 rounded shadow-xl max-h-64 overflow-y-auto">
                {empResults.isLoading ? (
                  <Loading label="Searching..." className="py-3" />
                ) : empResults.error ? (
                  <ErrorState error={empResults.error} compact />
                ) : (empResults.data?.rows ?? []).length === 0 ? (
                  <div className="px-3 py-2 text-body-sm text-outline">No employees match “{empQ}”.</div>
                ) : (
                  (empResults.data?.rows ?? []).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-surface-container-highest"
                      onClick={() => {
                        setEmployee({ id: r.id, name: r.full_name });
                        setEmpSearch('');
                      }}
                    >
                      <span className="text-body-sm text-on-surface truncate">{r.full_name}</span>
                      <span className="font-mono text-[11px] text-outline shrink-0">
                        {r.staff_number}
                        {r.location_name ? ` · ${r.location_name}` : ''}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="xl:col-span-3 flex flex-col gap-1">
            <Button variant="primary" size="lg" icon="query_stats" onClick={generate} disabled={Boolean(formError)} loading={report.isFetching && generated}>
              Generate report
            </Button>
          </div>
        </div>
        {formError && <p className="mt-space-sm font-body-sm text-body-sm text-error">{formError}</p>}
      </Panel>

      {/* Results */}
      {!generated ? (
        <Panel>
          <Empty icon="query_stats" title="Configure and generate a report." description="Choose a location, date range and optionally an employee or department, then select Generate report." />
        </Panel>
      ) : report.isLoading ? (
        <Loading label="Loading attendance data..." />
      ) : report.error && !report.data ? (
        <Panel>
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        </Panel>
      ) : report.data ? (
        <Results r={report.data} view={view} setView={setView} scopeLabel={scopeLabel} exportBtn={exportBtn} fetching={report.isFetching} />
      ) : null}
    </div>
  );
}

// ───────────────────────── Results ─────────────────────────
function Results({
  r,
  view,
  setView,
  scopeLabel,
  exportBtn,
  fetching
}: {
  r: Report;
  view: ViewKey;
  setView: (v: ViewKey) => void;
  scopeLabel: string;
  exportBtn: (v: ViewKey, rows: number) => ReactNode;
  fetching: boolean;
}) {
  const s = r.summary ?? {};
  const noData = !s.expected;
  return (
    <div className={clsx('flex flex-col gap-space-md', fetching && 'opacity-80')}>
      <div className="flex flex-wrap items-center justify-between gap-space-sm">
        <div className="flex items-center gap-2 font-label-md text-label-md text-on-surface-variant">
          <Icon name="filter_alt" className="text-[16px] text-outline" />
          {scopeLabel}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-space-sm">
        <Stat label="Attendance rate" value={pct(s.attendance_rate)} icon="percent" tone={s.attendance_rate >= 90 ? 'success' : s.attendance_rate >= 75 ? 'warning' : s.attendance_rate !== null && s.attendance_rate !== undefined ? 'error' : undefined} />
        <Stat label="Employees" value={num(s.employees)} icon="badge" />
        <Stat label="Expected" value={num(s.expected)} icon="event" hint="Employee-workdays" />
        <Stat label="Present" value={num(s.present)} icon="event_available" tone="success" />
        <Stat label="Late" value={num(s.late)} icon="schedule" tone={s.late ? 'warning' : undefined} />
        <Stat label="Absent" value={num(s.absent)} icon="event_busy" tone={s.absent ? 'error' : undefined} />
        <Stat label="Avg minutes late" value={s.avg_minutes_late === null || s.avg_minutes_late === undefined ? '—' : num(s.avg_minutes_late)} icon="timer" />
      </div>

      <Tabs<ViewKey>
        value={view}
        onChange={setView}
        tabs={VIEWS.map((v) => ({
          key: v.key,
          label: v.label,
          icon: v.icon,
          count: v.key === 'late' ? r.late.length : v.key === 'absences' ? r.absences.length : undefined
        }))}
      />

      {noData && view !== 'locations' ? (
        <Panel>
          <Empty icon="event_busy" title="No attendance records found." description="No active employees were scheduled to work at the selected locations in this period." />
        </Panel>
      ) : (
        <>
          {(view === 'daily' || view === 'weekly' || view === 'monthly') && <PeriodView view={view} rows={r[view]} exportBtn={exportBtn} />}
          {view === 'employees' && <EmployeesView rows={r.employees} exportBtn={exportBtn} />}
          {view === 'locations' && <LocationsView rows={r.locations} exportBtn={exportBtn} />}
          {view === 'late' && <LateView rows={r.late} exportBtn={exportBtn} />}
          {view === 'absences' && <AbsencesView rows={r.absences} exportBtn={exportBtn} />}
          {view === 'trend' && <TrendView rows={r.trend} exportBtn={exportBtn} />}
        </>
      )}
    </div>
  );
}

const periodLabel = (view: 'daily' | 'weekly' | 'monthly', p: string, short = false) =>
  view === 'monthly' ? fmtMonth(p) : view === 'weekly' ? `${short ? '' : 'Week of '}${short ? fmtShort(p) : fmtDay(p)}` : short ? fmtShort(p) : fmtDay(p, true);

function PeriodView({ view, rows, exportBtn }: { view: 'daily' | 'weekly' | 'monthly'; rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const data = rows.map((x) => ({
    ...x,
    label: periodLabel(view, x.period, true),
    on_time: Math.max(0, x.present - x.late)
  }));
  const title = view === 'daily' ? 'Daily attendance' : view === 'weekly' ? 'Weekly attendance' : 'Monthly attendance';
  return (
    <div className="flex flex-col gap-space-md">
      <Panel title={title} icon="bar_chart" subtitle="Expected employee-workdays split into on time, late and absent" actions={exportBtn(view, rows.length)}>
        {rows.length === 0 ? (
          <Empty title="No attendance records found." icon="event_busy" />
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" {...axisProps} minTickGap={12} />
                <YAxis {...axisProps} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} iconType="square" iconSize={8} />
                <Bar dataKey="on_time" name="On time" stackId="a" fill={C.onTime} stroke={C.surface} strokeWidth={1} maxBarSize={36} />
                <Bar dataKey="late" name="Late" stackId="a" fill={C.late} stroke={C.surface} strokeWidth={1} maxBarSize={36} />
                <Bar dataKey="absent" name="Absent" stackId="a" fill={C.absent} stroke={C.surface} strokeWidth={1} radius={[3, 3, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      {rows.length > 0 && (
        <Panel title="Attendance rate" icon="show_chart" subtitle="Share of expected employee-workdays with a clock-in">
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" {...axisProps} minTickGap={12} />
                <YAxis {...axisProps} domain={[0, 100]} unit="%" />
                <Tooltip {...tooltipStyle} formatter={(v: any) => pct(v)} />
                <Line type="monotone" dataKey="attendance_rate" name="Attendance rate" stroke={C.rate} strokeWidth={2} dot={data.length <= 31 ? { r: 3 } : false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}
      {rows.length > 0 && (
        <Panel title="Breakdown" icon="table_rows">
          <Table>
            <THead>
              <tr>
                <Th>{view === 'daily' ? 'Date' : view === 'weekly' ? 'Week starting' : 'Month'}</Th>
                <Th className="text-right">Expected</Th>
                <Th className="text-right">Present</Th>
                <Th className="text-right">Late</Th>
                <Th className="text-right">Absent</Th>
                <Th className="text-right">Attendance</Th>
              </tr>
            </THead>
            <tbody>
              {[...rows].reverse().map((x) => (
                <Tr key={x.period}>
                  <Td className="whitespace-nowrap">{periodLabel(view, x.period)}</Td>
                  <Td className="text-right font-mono">{num(x.expected)}</Td>
                  <Td className="text-right font-mono text-tertiary">{num(x.present)}</Td>
                  <Td className="text-right font-mono text-warning">{num(x.late)}</Td>
                  <Td className="text-right font-mono text-error">{num(x.absent)}</Td>
                  <Td className={clsx('text-right font-mono font-semibold', rateTone(x.attendance_rate))}>{pct(x.attendance_rate)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

type EmpSort = 'full_name' | 'location_name' | 'scheduled_days' | 'days_present' | 'days_absent' | 'late_days' | 'total_minutes_late' | 'hours_worked' | 'attendance_rate';

function EmployeesView({ rows, exportBtn }: { rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const nav = useNavigate();
  const [sort, setSort] = useState<{ key: EmpSort; dir: 1 | -1 }>({ key: 'attendance_rate', dir: 1 });
  const [filter, setFilter] = useState('');
  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? rows.filter((r) => `${r.full_name} ${r.staff_number} ${r.department ?? ''} ${r.location_name}`.toLowerCase().includes(f)) : rows;
    return [...list].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [rows, sort, filter]);
  const { page, offset, setOffset, size } = usePaged(sorted);
  const H = ({ k, children, right }: { k: EmpSort; children: ReactNode; right?: boolean }) => (
    <Th className={right ? 'text-right' : undefined}>
      <button
        className={clsx('inline-flex items-center gap-0.5 uppercase hover:text-on-surface', sort.key === k && 'text-on-surface')}
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }))}
      >
        {children}
        {sort.key === k && <Icon name={sort.dir === 1 ? 'arrow_upward' : 'arrow_downward'} className="text-[12px]" />}
      </button>
    </Th>
  );
  return (
    <Panel
      title="Employee attendance"
      icon="badge"
      subtitle={`${num(rows.length)} employees · lowest attendance first`}
      actions={
        <>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="h-8 w-40" />
          {exportBtn('employees', rows.length)}
        </>
      }
      bodyClassName="px-0 pb-0"
    >
      {sorted.length === 0 ? (
        <Empty title="No attendance records found." icon="person_search" />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <H k="full_name">Employee</H>
                <H k="location_name">Location</H>
                <H k="scheduled_days" right>
                  Scheduled
                </H>
                <H k="days_present" right>
                  Present
                </H>
                <H k="days_absent" right>
                  Absent
                </H>
                <H k="late_days" right>
                  Late
                </H>
                <H k="total_minutes_late" right>
                  Min late
                </H>
                <H k="hours_worked" right>
                  Hours
                </H>
                <H k="attendance_rate" right>
                  Attendance
                </H>
              </tr>
            </THead>
            <tbody>
              {page.map((x) => (
                <Tr key={`${x.employee_id}-${x.location_name}`} onClick={() => nav(`/employees/${x.employee_id}`)}>
                  <Td>
                    <div className="flex flex-col">
                      <span className="text-on-surface font-medium">{x.full_name}</span>
                      <span className="font-label-sm text-label-sm text-outline font-mono">
                        {x.staff_number}
                        {x.department ? ` · ${x.department}` : ''}
                      </span>
                    </div>
                  </Td>
                  <Td>{x.location_name}</Td>
                  <Td className="text-right font-mono">{num(x.scheduled_days)}</Td>
                  <Td className="text-right font-mono">{num(x.days_present)}</Td>
                  <Td className="text-right font-mono">{num(x.days_absent)}</Td>
                  <Td className="text-right font-mono">{num(x.late_days)}</Td>
                  <Td className="text-right font-mono">{num(x.total_minutes_late)}</Td>
                  <Td className="text-right font-mono">{num(x.hours_worked)}</Td>
                  <Td className={clsx('text-right font-mono font-semibold', rateTone(x.attendance_rate))}>{pct(x.attendance_rate)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {sorted.length > size && <Pagination total={sorted.length} limit={size} offset={offset} onChange={setOffset} />}
        </>
      )}
    </Panel>
  );
}

function LocationsView({ rows, exportBtn }: { rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const data = rows.map((x) => ({ ...x, on_time: Math.max(0, x.present - x.late) }));
  return (
    <div className="flex flex-col gap-space-md">
      <Panel title="Location attendance" icon="storefront" subtitle="Expected employee-workdays per location" actions={exportBtn('locations', rows.length)}>
        {rows.length === 0 ? (
          <Empty title="No attendance records found." icon="storefront" />
        ) : (
          <div style={{ height: Math.max(160, rows.length * 34 + 60) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid horizontal={false} stroke={C.grid} />
                <XAxis type="number" {...axisProps} allowDecimals={false} />
                <YAxis type="category" dataKey="location_name" {...axisProps} width={140} />
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} iconType="square" iconSize={8} />
                <Bar dataKey="on_time" name="On time" stackId="a" fill={C.onTime} stroke={C.surface} strokeWidth={1} maxBarSize={22} />
                <Bar dataKey="late" name="Late" stackId="a" fill={C.late} stroke={C.surface} strokeWidth={1} maxBarSize={22} />
                <Bar dataKey="absent" name="Absent" stackId="a" fill={C.absent} stroke={C.surface} strokeWidth={1} radius={[0, 3, 3, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      {rows.length > 0 && (
        <Panel title="By location" icon="table_rows" bodyClassName="px-0 pb-0">
          <Table>
            <THead>
              <tr>
                <Th>Location</Th>
                <Th className="text-right">Employees</Th>
                <Th className="text-right">Expected</Th>
                <Th className="text-right">Present</Th>
                <Th className="text-right">Late</Th>
                <Th className="text-right">Absent</Th>
                <Th className="text-right">Attendance</Th>
                <Th className="text-right">Late rate</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((x) => (
                <Tr key={x.location_id} onClick={can('locations.view') ? () => nav(`/locations/${x.location_id}`) : undefined}>
                  <Td>
                    <span className="text-on-surface font-medium">{x.location_name}</span>
                    <span className="font-label-sm text-label-sm text-outline font-mono"> {x.code}</span>
                  </Td>
                  <Td className="text-right font-mono">{num(x.employees)}</Td>
                  <Td className="text-right font-mono">{num(x.expected)}</Td>
                  <Td className="text-right font-mono text-tertiary">{num(x.present)}</Td>
                  <Td className="text-right font-mono text-warning">{num(x.late)}</Td>
                  <Td className="text-right font-mono text-error">{num(x.absent)}</Td>
                  <Td className={clsx('text-right font-mono font-semibold', rateTone(x.attendance_rate))}>{pct(x.attendance_rate)}</Td>
                  <Td className="text-right font-mono">{pct(x.late_rate)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </div>
  );
}

function LimitNote({ n }: { n: number }) {
  if (n < 5000) return null;
  return (
    <div className="px-space-md py-space-xs font-label-sm text-label-sm text-warning flex items-center gap-1">
      <Icon name="info" className="text-[13px]" /> Showing the latest 5,000 records. Narrow the filters or export for the full list.
    </div>
  );
}

function LateView({ rows, exportBtn }: { rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const { page, offset, setOffset, size } = usePaged(rows);
  return (
    <Panel title="Late arrivals" icon="schedule" subtitle={`${num(rows.length)} late clock-ins · most recent first`} actions={exportBtn('late', rows.length)} bodyClassName="px-0 pb-0">
      {rows.length === 0 ? (
        <Empty title="No late arrivals." icon="task_alt" description="Everyone who clocked in during this period arrived within the grace period." />
      ) : (
        <>
          <LimitNote n={rows.length} />
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Employee</Th>
                <Th>Department</Th>
                <Th>Location</Th>
                <Th>First in</Th>
                <Th className="text-right">Minutes late</Th>
              </tr>
            </THead>
            <tbody>
              {page.map((x, i) => (
                <Tr key={`${x.work_date}-${x.staff_number}-${i}`}>
                  <Td className="whitespace-nowrap">{fmtDay(x.work_date, true)}</Td>
                  <Td>
                    <span className="text-on-surface">{x.full_name}</span>
                    <span className="font-label-sm text-label-sm text-outline font-mono"> {x.staff_number}</span>
                  </Td>
                  <Td>{x.department ?? '—'}</Td>
                  <Td>{x.location_name}</Td>
                  <Td className="font-mono">{time(x.first_in, undefined, false)}</Td>
                  <Td className="text-right">
                    <Badge tone={x.minutes_late >= 30 ? 'error' : 'warning'}>{num(x.minutes_late)} min</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {rows.length > size && <Pagination total={rows.length} limit={size} offset={offset} onChange={setOffset} />}
        </>
      )}
    </Panel>
  );
}

function AbsencesView({ rows, exportBtn }: { rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const { page, offset, setOffset, size } = usePaged(rows);
  return (
    <Panel title="Absences" icon="event_busy" subtitle={`${num(rows.length)} scheduled workdays without a clock-in`} actions={exportBtn('absences', rows.length)} bodyClassName="px-0 pb-0">
      {rows.length === 0 ? (
        <Empty title="No absences." icon="task_alt" description="Every scheduled employee clocked in on every workday in this period." />
      ) : (
        <>
          <LimitNote n={rows.length} />
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Employee</Th>
                <Th>Staff number</Th>
                <Th>Department</Th>
                <Th>Location</Th>
              </tr>
            </THead>
            <tbody>
              {page.map((x, i) => (
                <Tr key={`${x.work_date}-${x.staff_number}-${i}`}>
                  <Td className="whitespace-nowrap">{fmtDay(x.work_date, true)}</Td>
                  <Td className="text-on-surface">{x.full_name}</Td>
                  <Td className="font-mono">{x.staff_number}</Td>
                  <Td>{x.department ?? '—'}</Td>
                  <Td>{x.location_name}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {rows.length > size && <Pagination total={rows.length} limit={size} offset={offset} onChange={setOffset} />}
        </>
      )}
    </Panel>
  );
}

function TrendView({ rows, exportBtn }: { rows: any[]; exportBtn: (v: ViewKey, n: number) => ReactNode }) {
  const data = rows.map((x) => ({ ...x, label: fmtShort(x.period) }));
  const last = rows[rows.length - 1];
  const first = rows.find((x) => x.moving_avg_7d !== null && x.moving_avg_7d !== undefined);
  const delta = last && first && last.moving_avg_7d !== null && first.moving_avg_7d !== null ? Number(last.moving_avg_7d) - Number(first.moving_avg_7d) : null;
  return (
    <div className="flex flex-col gap-space-md">
      <Panel title="Attendance trend" icon="trending_up" subtitle="Daily attendance rate with 7-day moving average" actions={exportBtn('trend', rows.length)}>
        {rows.length === 0 ? (
          <Empty title="No attendance records found." icon="event_busy" />
        ) : (
          <>
            <div className="flex flex-wrap gap-space-lg mb-space-sm">
              <div>
                <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Latest 7-day average</div>
                <div className={clsx('font-headline-md text-headline-md font-mono', rateTone(last?.moving_avg_7d))}>{pct(last?.moving_avg_7d)}</div>
              </div>
              {delta !== null && (
                <div>
                  <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider">Change over period</div>
                  <div className={clsx('font-headline-md text-headline-md font-mono flex items-center gap-1', delta >= 0 ? 'text-tertiary' : 'text-error')}>
                    <Icon name={delta >= 0 ? 'trending_up' : 'trending_down'} className="text-[18px]" />
                    {delta >= 0 ? '+' : ''}
                    {delta.toFixed(1)} pts
                  </div>
                </div>
              )}
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="label" {...axisProps} minTickGap={16} />
                  <YAxis {...axisProps} domain={[0, 100]} unit="%" />
                  <Tooltip {...tooltipStyle} formatter={(v: any) => pct(v)} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} iconSize={10} />
                  <Line type="monotone" dataKey="attendance_rate" name="Daily rate" stroke={C.rate} strokeOpacity={0.55} strokeWidth={1.5} dot={false} connectNulls />
                  <Line type="monotone" dataKey="moving_avg_7d" name="7-day average" stroke={C.avg} strokeWidth={2.5} strokeDasharray="6 3" dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </Panel>
      {rows.length > 0 && (
        <Panel title="Trend data" icon="table_rows" bodyClassName="px-0 pb-0">
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th className="text-right">Attendance</Th>
                <Th className="text-right">7-day average</Th>
              </tr>
            </THead>
            <tbody>
              {[...rows].reverse().map((x) => (
                <Tr key={x.period}>
                  <Td className="whitespace-nowrap">{fmtDay(x.period, true)}</Td>
                  <Td className={clsx('text-right font-mono', rateTone(x.attendance_rate))}>{pct(x.attendance_rate)}</Td>
                  <Td className="text-right font-mono">{pct(x.moving_avg_7d)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </div>
  );
}
