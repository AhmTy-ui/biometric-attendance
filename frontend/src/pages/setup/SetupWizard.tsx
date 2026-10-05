import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  deviceStatusLabel,
  deviceTone,
  Dot,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  Progress,
  Select,
  Stat,
  Table,
  Td,
  Th,
  THead,
  Tr,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, num, relative } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { DELIVERY_MODE_LABEL, SyncResultBanner, SyncRunsTable, type SyncTrack } from '@/pages/integration/components';

// ───────────────────────── Types / constants ─────────────────────────

type StepKey = 'organization' | 'integration' | 'infrastructure' | 'devices' | 'employees' | 'ready';

interface ChecklistStep {
  key: string;
  label: string;
  done: boolean;
}
interface Checklist {
  organization: { id: string; name: string; timezone: string; setup_completed: boolean };
  steps: ChecklistStep[];
  counts: { locations: number; unmapped: number; devices: number; active_devices: number; employees: number; good_syncs: number };
  completed: boolean;
}

const WIZARD: { key: StepKey; label: string; icon: string; optional?: boolean; description: string }[] = [
  { key: 'organization', label: 'Organization', icon: 'apartment', description: 'Confirm name, timezone and support contact.' },
  { key: 'integration', label: 'Web software connection', icon: 'hub', description: 'Connect the HR / payroll web software (source of truth).' },
  { key: 'infrastructure', label: 'Locations', icon: 'storefront', description: 'Import or create the branches where terminals are installed.' },
  { key: 'devices', label: 'Devices', icon: 'router', optional: true, description: 'Register and activate fingerprint terminals.' },
  { key: 'employees', label: 'Employee synchronisation', icon: 'badge', description: 'Pull employees from the web software onto device rosters.' },
  { key: 'ready', label: 'Ready', icon: 'rocket_launch', description: 'Review and finish setup.' }
];

const MASK = '••••••••';
const WEEKDAYS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun']
];

function timezoneList(current?: string | null): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const list = typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  const all = new Set<string>(list);
  all.add('UTC');
  if (current) all.add(current);
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (browser) all.add(browser);
  return [...all].sort();
}

function TimezoneSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const zones = useMemo(() => timezoneList(value), [value]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
      {!value && <option value="">Select a timezone…</option>}
      {zones.map((z) => (
        <option key={z} value={z}>
          {z}
        </option>
      ))}
    </Select>
  );
}

function useSetupInvalidation() {
  const qc = useQueryClient();
  return (...extra: string[][]) => {
    void qc.invalidateQueries({ queryKey: ['setup-checklist'] });
    for (const k of extra) void qc.invalidateQueries({ queryKey: k });
  };
}

function StepShell({
  step,
  done,
  children,
  onBack,
  onNext,
  nextLabel,
  status
}: {
  step: (typeof WIZARD)[number];
  done: boolean;
  children: ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  status?: ReactNode;
}) {
  return (
    <Panel
      title={step.label}
      subtitle={step.description}
      icon={step.icon}
      accent={done ? 'success' : undefined}
      actions={
        status ??
        (done ? (
          <Badge tone="success" icon="check_circle">
            Complete
          </Badge>
        ) : step.optional ? (
          <Badge tone="neutral">Optional</Badge>
        ) : (
          <Badge tone="warning">Incomplete</Badge>
        ))
      }
    >
      <div className="flex flex-col gap-space-md">{children}</div>
      {(onBack || onNext) && (
        <div className="mt-space-lg pt-space-md border-t border-outline-variant/20 flex items-center justify-between gap-space-sm">
          {onBack ? (
            <Button variant="ghost" icon="arrow_back" onClick={onBack}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {onNext && (
            <Button variant={done ? 'primary' : 'secondary'} onClick={onNext}>
              {nextLabel ?? (done ? 'Continue' : 'Skip for now')} <Icon name="arrow_forward" className="text-[15px]" />
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

// ───────────────────────── (a) Organization ─────────────────────────

function OrganizationStep({ checklist, done, onBack, onNext }: { checklist: Checklist; done: boolean; onBack?: () => void; onNext: () => void }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const invalidate = useSetupInvalidation();
  const { refresh } = useAuth();
  const step = WIZARD[0]!;
  const settings = useQuery<any>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const [form, setForm] = useState<{ displayName: string; timezone: string; supportEmail: string } | null>(null);

  useEffect(() => {
    if (form || !settings.data) return;
    const o = settings.data.settings?.organization ?? {};
    setForm({
      displayName: o.displayName || checklist.organization.name || '',
      timezone: o.timezone || checklist.organization.timezone || '',
      supportEmail: o.supportEmail ?? ''
    });
  }, [settings.data, form, checklist.organization]);

  const save = useMutation({
    mutationFn: (b: { displayName: string; timezone: string; supportEmail: string }) => api.post('/api/setup/organization', b),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Organization details confirmed' });
      invalidate(['settings'], ['locations-lite']);
      await refresh();
      onNext();
    },
    onError: (e) => errorToast(e, 'Could not save organization details')
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (form) save.mutate({ displayName: form.displayName.trim(), timezone: form.timezone, supportEmail: form.supportEmail.trim() });
  };

  return (
    <StepShell step={step} done={done} onBack={onBack} onNext={onNext}>
      {settings.isLoading || (!form && !settings.error) ? (
        <Loading label="Loading organization settings…" />
      ) : settings.error || !form ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <form className="flex flex-col gap-space-md" onSubmit={submit}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
            <Field label="Organization name" required hint="Shown in the dashboard, reports and emails.">
              <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} minLength={2} maxLength={120} required />
            </Field>
            <Field label="Default timezone" required hint="Used for reports and as the default for new locations.">
              <TimezoneSelect value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })} />
            </Field>
            <Field label="Support email" hint="Where users are told to ask for help. Leave empty if none.">
              <Input type="email" value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} placeholder="it-support@organisation.com" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon="check" loading={save.isPending} disabled={form.displayName.trim().length < 2 || !form.timezone}>
              Confirm organization
            </Button>
          </div>
        </form>
      )}
    </StepShell>
  );
}

// ───────────────────────── (b) Web software connection ─────────────────────────

interface ProbeResult {
  reachable: boolean;
  status: number | null;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

function IntegrationStep({ done, onBack, onNext }: { done: boolean; onBack: () => void; onNext: () => void }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const invalidate = useSetupInvalidation();
  const { can } = useAuth();
  const step = WIZARD[1]!;
  const settings = useQuery<any>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const integ = settings.data?.settings?.integration;
  const [form, setForm] = useState<any>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  useEffect(() => {
    if (!form && integ) setForm({ ...integ });
  }, [integ, form]);

  const saveM = useMutation({
    mutationFn: (value: any) => api.put('/api/settings/integration', value),
    onSuccess: (saved: any) => {
      setForm({ ...saved });
      invalidate(['settings'], ['integration-status']);
    }
  });
  const testM = useMutation({
    mutationFn: () => api.post<ProbeResult>('/api/integration/test-connection'),
    onSuccess: (r) => setProbe(r),
    onError: (e) => errorToast(e, 'Connection test failed to run')
  });

  const dirty = Boolean(
    form && integ && ['baseUrl', 'apiKey', 'deliveryMode', 'employeesPath', 'locationsPath', 'attendancePath', 'timeoutMs'].some((k) => form[k] !== integ[k])
  );

  const saveAndTest = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!form) return;
    setProbe(null);
    try {
      await saveM.mutateAsync({ ...integ, ...form, baseUrl: String(form.baseUrl ?? '').trim(), timeoutMs: Number(form.timeoutMs) });
      toast({ tone: 'success', title: 'Connection settings saved' });
    } catch (e) {
      errorToast(e, 'Could not save connection settings');
      return;
    }
    if (can('integration.manage')) testM.mutate();
  };

  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <StepShell step={step} done={done} onBack={onBack} onNext={onNext}>
      {settings.isLoading || (!form && !settings.error) ? (
        <Loading label="Loading integration settings…" />
      ) : settings.error || !form ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <form className="flex flex-col gap-space-md" onSubmit={(e) => void saveAndTest(e)}>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            The web software is the source of truth for employees and locations. The platform reads them from its API and sends attendance back.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
            <Field label="Base URL" required hint="HTTPS address of the web software API.">
              <Input type="url" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://hr.organisation.com" required />
            </Field>
            <Field label="API key" hint={integ?.apiKey === MASK ? 'A key is stored. Leave unchanged to keep it, or type a new one.' : 'Sent as a bearer credential to the web software.'}>
              <Input
                type="password"
                value={form.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
                onFocus={(e) => e.currentTarget.value === MASK && e.currentTarget.select()}
                autoComplete="off"
              />
            </Field>
            <Field label="Attendance delivery mode" hint="How captured attendance reaches the web software.">
              <Select value={form.deliveryMode} onChange={(e) => set('deliveryMode', e.target.value)}>
                {(['api', 'scheduled_export', 'disabled'] as const).map((m) => (
                  <option key={m} value={m}>
                    {DELIVERY_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Request timeout (ms)">
              <Input type="number" min={1000} max={60000} step={500} value={form.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value === '' ? '' : Number(e.target.value))} />
            </Field>
          </div>
          <button type="button" className="self-start flex items-center gap-1 font-label-md text-label-md text-secondary hover:underline" onClick={() => setShowAdvanced((s) => !s)}>
            <Icon name={showAdvanced ? 'expand_less' : 'expand_more'} className="text-[16px]" />
            Endpoint paths
          </button>
          {showAdvanced && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
              <Field label="Employees path">
                <Input value={form.employeesPath} onChange={(e) => set('employeesPath', e.target.value)} className="font-mono" />
              </Field>
              <Field label="Locations path">
                <Input value={form.locationsPath} onChange={(e) => set('locationsPath', e.target.value)} className="font-mono" />
              </Field>
              <Field label="Attendance path">
                <Input value={form.attendancePath} onChange={(e) => set('attendancePath', e.target.value)} className="font-mono" />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-space-sm">
            {can('integration.manage') && (
              <Button type="button" icon="network_check" loading={testM.isPending} disabled={dirty || !integ?.baseUrl} onClick={() => testM.mutate()} title={dirty ? 'Save your changes first' : undefined}>
                Test saved connection
              </Button>
            )}
            <Button type="submit" variant="primary" icon="save" loading={saveM.isPending} disabled={!String(form.baseUrl ?? '').trim()}>
              {can('integration.manage') ? 'Save & test connection' : 'Save connection'}
            </Button>
          </div>
          {testM.isPending && <Loading label="Contacting the web software…" className="py-4" />}
          {probe && !testM.isPending && <ProbeResultBox r={probe} />}
        </form>
      )}
    </StepShell>
  );
}

function ProbeResultBox({ r }: { r: ProbeResult }) {
  const tone = r.reachable ? (r.ok ? 'success' : 'warning') : 'error';
  const title = r.reachable ? (r.ok ? 'Connection successful' : `Web software answered with HTTP ${r.status}`) : 'Web software is unreachable';
  const cls = tone === 'success' ? 'border-tertiary/40 bg-tertiary-container/15' : tone === 'warning' ? 'border-warning/40 bg-warning-container/40' : 'border-error/40 bg-error-container/25';
  return (
    <div className={clsx('rounded border p-space-md flex flex-col gap-space-sm', cls)} role="status">
      <div className="flex items-center gap-space-sm">
        <Icon name={tone === 'success' ? 'check_circle' : tone === 'warning' ? 'warning' : 'error'} className={clsx('text-[20px]', tone === 'success' ? 'text-tertiary' : tone === 'warning' ? 'text-warning' : 'text-error')} />
        <span className="font-headline-sm text-headline-sm text-on-surface">{title}</span>
      </div>
      <div className="grid grid-cols-3 gap-space-sm">
        <Stat label="Reachable" value={r.reachable ? 'Yes' : 'No'} tone={r.reachable ? 'success' : 'error'} />
        <Stat label="HTTP status" value={r.status ?? '—'} tone={r.ok ? 'success' : r.status ? 'warning' : undefined} />
        <Stat label="Latency" value={duration(r.latencyMs)} />
      </div>
      {r.error && <p className="font-mono text-[11px] text-on-surface-variant break-words">{r.error}</p>}
      {r.reachable && !r.ok && (
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {r.status === 401 || r.status === 403 ? 'Check the API key.' : r.status === 404 ? 'Check the base URL and the locations path.' : 'Check the web software logs for this request.'}
        </p>
      )}
    </div>
  );
}

// ───────────────────────── (c) Locations ─────────────────────────

const emptyLocation = (tz: string) => ({ name: '', code: '', timezone: tz, workStart: '08:00', workEnd: '17:00', graceMinutes: 15, workdays: [1, 2, 3, 4, 5] });

function InfrastructureStep({ checklist, done, onBack, onNext }: { checklist: Checklist; done: boolean; onBack: () => void; onNext: () => void }) {
  const toast = useToast();
  const errorToast = useErrorToast();
  const invalidate = useSetupInvalidation();
  const { can } = useAuth();
  const step = WIZARD[2]!;
  const orgTz = checklist.organization.timezone;
  const [track, setTrack] = useState<SyncTrack | null>(null);
  const [importTz, setImportTz] = useState(orgTz);
  const [showCreate, setShowCreate] = useState(false);
  const settings = useQuery<any>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const [loc, setLoc] = useState(() => emptyLocation(orgTz));
  const graceSeeded = useRef(false);

  useEffect(() => {
    const late = settings.data?.settings?.organization?.lateThresholdMinutes;
    if (!graceSeeded.current && typeof late === 'number') {
      graceSeeded.current = true;
      setLoc((l) => ({ ...l, graceMinutes: late }));
    }
  }, [settings.data]);

  const mappings = useQuery<any[]>({
    queryKey: ['location-mappings', { status: 'unmapped' }],
    queryFn: () => api.get('/api/location-mappings', { status: 'unmapped' }),
    enabled: can('integration.view')
  });
  const locations = useQuery<any[]>({ queryKey: ['locations', 'setup'], queryFn: () => api.get('/api/locations') });

  const refreshAll = () => invalidate(['location-mappings'], ['locations'], ['locations-lite'], ['dashboard']);

  useLiveEvents('sync/finished', (f) => {
    if (f.data?.kind !== 'locations') return;
    refreshAll();
    setTrack((t) => (t?.phase === 'running' ? { phase: 'done', kind: 'locations', run: f.data } : t));
  });

  const syncM = useMutation({
    mutationFn: () => api.post<{ run?: any; running?: boolean; message?: string }>('/api/integration/sync', { kind: 'locations', mode: 'manual' }),
    onMutate: () => setTrack({ phase: 'running', kind: 'locations', mine: true }),
    onSuccess: (r) => {
      if (r.run) setTrack({ phase: 'done', kind: 'locations', run: r.run });
      else setTrack({ phase: 'running', kind: 'locations', mine: false });
      refreshAll();
    },
    onError: (e) => setTrack({ phase: 'error', kind: 'locations', message: (e as ApiError).message })
  });

  const importM = useMutation({
    mutationFn: () => api.post<{ imported: number }>('/api/location-mappings/import-all', { timezone: importTz }),
    onSuccess: (r) => {
      toast({ tone: 'success', title: `Imported ${num(r.imported)} location${r.imported === 1 ? '' : 's'}`, description: 'Employees assigned to them were placed on the location rosters.' });
      refreshAll();
    },
    onError: (e) => errorToast(e, 'Import failed')
  });

  const createM = useMutation({
    mutationFn: () => api.post('/api/locations', { ...loc, name: loc.name.trim(), code: loc.code.trim(), graceMinutes: Number(loc.graceMinutes) }),
    onSuccess: (row: any) => {
      toast({ tone: 'success', title: `Location ${row?.name ?? ''} created` });
      setLoc({ ...emptyLocation(orgTz), graceMinutes: loc.graceMinutes });
      setShowCreate(false);
      refreshAll();
    },
    onError: (e) => errorToast(e, 'Could not create location')
  });

  const unmapped = mappings.data ?? [];
  const locRows = locations.data ?? [];

  return (
    <StepShell step={step} done={done} onBack={onBack} onNext={onNext}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
        <Stat label="Platform locations" value={num(checklist.counts.locations)} icon="storefront" tone={checklist.counts.locations > 0 ? 'success' : 'warning'} />
        <Stat label="Unmapped web locations" value={num(checklist.counts.unmapped)} icon="link_off" tone={checklist.counts.unmapped > 0 ? 'warning' : 'success'} />
        <Stat label="Employees on file" value={num(checklist.counts.employees)} icon="badge" />
      </div>

      {can('integration.manage') && (
        <div className="bg-surface-container rounded p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
          <div>
            <div className="font-headline-sm text-headline-sm text-on-surface">Fetch locations from the web software</div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Reads the locations list; references with no matching platform location code appear below as unmapped.</p>
          </div>
          <Button icon="sync" variant="primary" loading={syncM.isPending} onClick={() => syncM.mutate()}>
            Sync locations
          </Button>
        </div>
      )}
      <SyncResultBanner track={track} onDismiss={() => setTrack(null)} />

      {can('integration.view') && (
        <div className="flex flex-col gap-space-sm">
          <div className="flex flex-wrap items-center justify-between gap-space-sm">
            <h3 className="font-headline-sm text-headline-sm text-on-surface flex items-center gap-2">
              <Icon name="link_off" className="text-[18px] text-warning" /> Unmapped web-software locations
            </h3>
            {unmapped.length > 0 && can('integration.manage') && (
              <div className="flex flex-wrap items-center gap-space-xs">
                <span className="font-label-sm text-label-sm text-outline">Timezone for new locations</span>
                <div className="w-56">
                  <TimezoneSelect value={importTz} onChange={setImportTz} />
                </div>
                <Button icon="download_done" variant="primary" loading={importM.isPending} onClick={() => importM.mutate()}>
                  Import all as locations ({unmapped.length})
                </Button>
              </div>
            )}
          </div>
          {mappings.isLoading ? (
            <Loading label="Loading location mappings…" />
          ) : mappings.error ? (
            <ErrorState error={mappings.error} onRetry={() => void mappings.refetch()} compact />
          ) : unmapped.length === 0 ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant flex items-center gap-1.5">
              <Icon name="check_circle" className="text-[16px] text-tertiary" /> Every web-software location reference is mapped.
            </p>
          ) : (
            <div className="bg-surface-container-lowest rounded overflow-hidden">
              <Table>
                <THead>
                  <tr>
                    <Th>External ref</Th>
                    <Th>Name in web software</Th>
                    <Th className="text-right">Employees affected</Th>
                    <Th>First seen</Th>
                  </tr>
                </THead>
                <tbody>
                  {unmapped.map((m) => (
                    <Tr key={m.id}>
                      <Td className="font-mono text-[11px] text-primary">{m.external_ref}</Td>
                      <Td>{m.external_name ?? '—'}</Td>
                      <Td className="text-right font-mono">{num(m.employees_affected)}</Td>
                      <Td className="text-on-surface-variant whitespace-nowrap">{relative(m.first_seen_at)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="px-space-md py-space-sm font-label-sm text-label-sm text-outline">
                Import creates one platform location per reference, using the reference as its code. To map a reference to an existing location instead, use{' '}
                <Link to="/integration/unmapped" className="text-secondary hover:underline">
                  Unmapped Locations
                </Link>
                .
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-space-sm">
        <div className="flex flex-wrap items-center justify-between gap-space-sm">
          <h3 className="font-headline-sm text-headline-sm text-on-surface flex items-center gap-2">
            <Icon name="storefront" className="text-[18px] text-primary" /> Platform locations
          </h3>
          {can('locations.manage') && (
            <Button icon={showCreate ? 'close' : 'add'} onClick={() => setShowCreate((s) => !s)}>
              {showCreate ? 'Cancel' : 'Create location'}
            </Button>
          )}
        </div>
        {showCreate && (
          <form
            className="bg-surface-container rounded p-space-md flex flex-col gap-space-md"
            onSubmit={(e) => {
              e.preventDefault();
              createM.mutate();
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
              <Field label="Name" required>
                <Input value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} minLength={2} maxLength={120} required />
              </Field>
              <Field label="Code" required hint="Must equal the web software's location reference to map automatically.">
                <Input value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value })} pattern="[A-Za-z0-9._\-]+" maxLength={40} required className="font-mono" />
              </Field>
              <Field label="Timezone" required>
                <TimezoneSelect value={loc.timezone} onChange={(v) => setLoc({ ...loc, timezone: v })} />
              </Field>
              <Field label="Work starts" required>
                <Input type="time" value={loc.workStart} onChange={(e) => setLoc({ ...loc, workStart: e.target.value })} required />
              </Field>
              <Field label="Work ends" required>
                <Input type="time" value={loc.workEnd} onChange={(e) => setLoc({ ...loc, workEnd: e.target.value })} required />
              </Field>
              <Field label="Grace minutes" required hint="Arrivals after start + grace count as late.">
                <Input type="number" min={0} max={240} value={loc.graceMinutes} onChange={(e) => setLoc({ ...loc, graceMinutes: Number(e.target.value) })} required />
              </Field>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide">Workdays</span>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS.map(([d, label]) => {
                  const on = loc.workdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setLoc({ ...loc, workdays: on ? loc.workdays.filter((x) => x !== d) : [...loc.workdays, d].sort() })}
                      className={clsx(
                        'px-2.5 py-1 rounded font-label-md text-label-md border transition-colors',
                        on ? 'bg-primary-container text-on-primary-container border-primary-container' : 'bg-surface-container-lowest text-outline border-outline-variant/40 hover:text-on-surface'
                      )}
                      aria-pressed={on}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" icon="add_business" loading={createM.isPending} disabled={loc.workdays.length === 0 || loc.name.trim().length < 2 || !loc.code.trim()}>
                Create location
              </Button>
            </div>
          </form>
        )}
        {locations.isLoading ? (
          <Loading label="Loading locations…" />
        ) : locations.error ? (
          <ErrorState error={locations.error} onRetry={() => void locations.refetch()} compact />
        ) : locRows.length === 0 ? (
          <Empty icon="storefront" title="No locations yet." description="Sync from the web software and import the references, or create a location manually." />
        ) : (
          <div className="bg-surface-container-lowest rounded overflow-hidden">
            <Table>
              <THead>
                <tr>
                  <Th>Location</Th>
                  <Th>Code</Th>
                  <Th>Timezone</Th>
                  <Th>Hours</Th>
                  <Th className="text-right">Employees</Th>
                  <Th className="text-right">Devices</Th>
                </tr>
              </THead>
              <tbody>
                {locRows.map((l) => (
                  <Tr key={l.id}>
                    <Td>
                      <Link to={`/locations/${l.id}`} className="text-on-surface hover:text-primary">
                        {l.name}
                      </Link>
                      {!l.is_active && <Badge className="ml-2">Inactive</Badge>}
                    </Td>
                    <Td className="font-mono text-[11px]">{l.code}</Td>
                    <Td className="font-mono text-[11px] text-on-surface-variant">{l.timezone}</Td>
                    <Td className="font-mono text-[11px] text-on-surface-variant whitespace-nowrap">
                      {String(l.work_start ?? '').slice(0, 5)}–{String(l.work_end ?? '').slice(0, 5)}
                    </Td>
                    <Td className="text-right font-mono">{num(l.active_employees)}</Td>
                    <Td className="text-right font-mono">{num(l.devices)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </StepShell>
  );
}

// ───────────────────────── (d) Devices ─────────────────────────

function DevicesStep({ checklist, done, onBack, onNext }: { checklist: Checklist; done: boolean; onBack: () => void; onNext: () => void }) {
  const { can } = useAuth();
  const step = WIZARD[3]!;
  const devices = useQuery<any>({ queryKey: ['devices', { setup: true }], queryFn: () => api.get('/api/devices', { limit: 25 }) });
  const s = devices.data?.summary;
  const rows: any[] = devices.data?.rows ?? [];
  return (
    <StepShell step={step} done={done} onBack={onBack} onNext={onNext}>
      {checklist.counts.locations === 0 && (
        <div className="rounded border border-warning/40 bg-warning-container/40 p-space-sm flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface-variant">
          <Icon name="warning" className="text-[18px] text-warning" /> Devices are installed at a location. Create or import at least one location first.
        </div>
      )}
      {devices.isLoading ? (
        <Loading label="Loading devices…" />
      ) : devices.error ? (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-space-sm">
            <Stat label="Registered" value={num(s?.total)} icon="router" />
            <Stat label="Online" value={num(s?.online)} tone="success" icon="wifi" />
            <Stat label="Warning" value={num(s?.warning)} tone={s?.warning ? 'warning' : undefined} icon="warning" />
            <Stat label="Offline" value={num(s?.offline)} tone={s?.offline ? 'error' : undefined} icon="wifi_off" />
            <Stat label="Pending activation" value={num(s?.pending)} tone={s?.pending ? 'info' : undefined} icon="hourglass_top" />
          </div>
          {rows.length === 0 ? (
            <Empty
              icon="router"
              title="No devices registered yet."
              description="Register each fingerprint terminal, then enter its activation code on the device. You can do this later from Device Registry."
              action={
                can('devices.provision') ? (
                  <LinkButton to="/devices/provision" variant="primary" icon="add">
                    Provision a device
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="bg-surface-container-lowest rounded overflow-hidden">
                <Table>
                  <THead>
                    <tr>
                      <Th>Device</Th>
                      <Th>Location</Th>
                      <Th>Status</Th>
                      <Th>Last heartbeat</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {rows.slice(0, 10).map((d) => (
                      <Tr key={d.id}>
                        <Td>
                          <Link to={`/devices/${d.id}`} className="text-on-surface hover:text-primary">
                            {d.name}
                          </Link>
                          <div className="font-mono text-[10px] text-outline">{d.device_uid}</div>
                        </Td>
                        <Td className="text-on-surface-variant">{d.location_name ?? '—'}</Td>
                        <Td>
                          <span className="flex items-center gap-1.5">
                            <Dot tone={deviceTone(d)} />
                            {deviceStatusLabel(d)}
                          </span>
                        </Td>
                        <Td className="text-on-surface-variant whitespace-nowrap" >{d.last_heartbeat_at ? relative(d.last_heartbeat_at) : 'never'}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                {rows.length > 10 && (
                  <div className="px-space-md py-space-sm font-label-sm text-label-sm text-outline">
                    Showing 10 of {num(devices.data?.total)}.{' '}
                    <Link to="/devices" className="text-secondary hover:underline">
                      Open Device Registry
                    </Link>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-space-sm">
                {can('devices.provision') && (
                  <LinkButton to="/devices/provision" variant="primary" icon="add">
                    Provision another device
                  </LinkButton>
                )}
                <LinkButton to="/devices" icon="router">
                  Device Registry
                </LinkButton>
              </div>
            </>
          )}
          {!done && (
            <p className="font-body-sm text-body-sm text-outline">
              This step completes when at least one device is active. It is optional: you can finish setup now and add devices later.
            </p>
          )}
        </>
      )}
    </StepShell>
  );
}

// ───────────────────────── (e) Employees ─────────────────────────

function EmployeesStep({ checklist, done, onBack, onNext, goTo }: { checklist: Checklist; done: boolean; onBack: () => void; onNext: () => void; goTo: (k: StepKey) => void }) {
  const { can } = useAuth();
  const invalidate = useSetupInvalidation();
  const step = WIZARD[4]!;
  const [track, setTrack] = useState<SyncTrack | null>(null);
  const runs = useQuery<any>({
    queryKey: ['sync-runs', { kind: 'employees', limit: 5 }],
    queryFn: () => api.get('/api/integration/runs', { kind: 'employees', limit: 5 }),
    enabled: can('integration.view')
  });

  useLiveEvents('sync/finished', (f) => {
    if (f.data?.kind !== 'employees') return;
    invalidate(['employees'], ['location-mappings'], ['locations']);
    setTrack((t) => (t?.phase === 'running' ? { phase: 'done', kind: 'employees', run: f.data } : t));
  });

  const syncM = useMutation({
    mutationFn: () => api.post<{ run?: any; running?: boolean; message?: string }>('/api/employees/sync'),
    onMutate: () => setTrack({ phase: 'running', kind: 'employees', mine: true }),
    onSuccess: (r) => {
      if (r.run) setTrack({ phase: 'done', kind: 'employees', run: r.run });
      else setTrack({ phase: 'running', kind: 'employees', mine: false });
      invalidate(['employees'], ['sync-runs'], ['location-mappings'], ['locations'], ['dashboard']);
    },
    onError: (e) => setTrack({ phase: 'error', kind: 'employees', message: (e as ApiError).message })
  });

  const lastRun = runs.data?.rows?.[0];

  return (
    <StepShell step={step} done={done} onBack={onBack} onNext={onNext}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
        <Stat label="Employees on file" value={num(checklist.counts.employees)} icon="badge" tone={checklist.counts.employees > 0 ? 'success' : 'warning'} />
        <Stat label="Successful syncs" value={num(checklist.counts.good_syncs)} icon="sync" tone={checklist.counts.good_syncs > 0 ? 'success' : undefined} />
        <Stat label="Unmapped locations" value={num(checklist.counts.unmapped)} icon="link_off" tone={checklist.counts.unmapped > 0 ? 'warning' : 'success'} />
      </div>
      {checklist.counts.unmapped > 0 && (
        <div className="rounded border border-warning/40 bg-warning-container/40 p-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
          <span className="flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface-variant">
            <Icon name="warning" className="text-[18px] text-warning" />
            {num(checklist.counts.unmapped)} web-software location reference{checklist.counts.unmapped === 1 ? ' is' : 's are'} unmapped. Employees assigned to them are kept
            but not placed on any device roster until mapped.
          </span>
          <Button size="sm" onClick={() => goTo('infrastructure')}>
            Map locations
          </Button>
        </div>
      )}
      {!checklist.steps.find((s) => s.key === 'integration')?.done && (
        <div className="rounded border border-warning/40 bg-warning-container/40 p-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
          <span className="flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface-variant">
            <Icon name="warning" className="text-[18px] text-warning" /> The web software connection is not configured yet; synchronisation will fail.
          </span>
          <Button size="sm" onClick={() => goTo('integration')}>
            Configure connection
          </Button>
        </div>
      )}
      <div className="bg-surface-container rounded p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
        <div>
          <div className="font-headline-sm text-headline-sm text-on-surface">Sync from Web Software</div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Employees are never created here. This pulls new hires, transfers and terminations from the web software and updates device rosters.
            {lastRun && (
              <>
                {' '}
                Last run {relative(lastRun.started_at)} ({dateTime(lastRun.started_at)}).
              </>
            )}
          </p>
        </div>
        {can('employees.sync') ? (
          <Button icon="sync" variant="primary" loading={syncM.isPending} onClick={() => syncM.mutate()}>
            Sync from Web Software
          </Button>
        ) : (
          <Badge tone="neutral">Requires employees.sync permission</Badge>
        )}
      </div>
      <SyncResultBanner track={track} onDismiss={() => setTrack(null)} />
      {can('integration.view') && (
        <div className="flex flex-col gap-space-sm">
          <h3 className="font-headline-sm text-headline-sm text-on-surface flex items-center gap-2">
            <Icon name="history" className="text-[18px] text-primary" /> Recent employee syncs
          </h3>
          {runs.isLoading ? (
            <Loading label="Loading sync history…" />
          ) : runs.error ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} compact />
          ) : (runs.data?.rows ?? []).length === 0 ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">No employee synchronisation has run yet.</p>
          ) : (
            <div className="bg-surface-container-lowest rounded overflow-hidden">
              <SyncRunsTable rows={runs.data.rows} />
            </div>
          )}
        </div>
      )}
    </StepShell>
  );
}

// ───────────────────────── (f) Ready ─────────────────────────

function ReadyStep({ checklist, onBack, goTo }: { checklist: Checklist; onBack: () => void; goTo: (k: StepKey) => void }) {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const step = WIZARD[5]!;
  const incomplete = checklist.steps.filter((s) => !s.done);
  const required = incomplete.filter((s) => s.key !== 'devices');

  const complete = useMutation({
    mutationFn: () => api.post('/api/setup/complete'),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Setup complete', description: `${checklist.organization.name} is ready.` });
      await refresh();
      void qc.invalidateQueries({ queryKey: ['setup-checklist'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      navigate('/', { replace: true });
    },
    onError: (e) => errorToast(e, 'Could not complete setup')
  });

  const wizardKey = (k: string): StepKey | null => (WIZARD.some((w) => w.key === k) ? (k as StepKey) : null);

  return (
    <StepShell
      step={step}
      done={checklist.completed}
      onBack={onBack}
      status={
        checklist.completed ? (
          <Badge tone="success" icon="check_circle">
            Setup completed
          </Badge>
        ) : incomplete.length === 0 ? (
          <Badge tone="success">All steps done</Badge>
        ) : (
          <Badge tone="warning">{incomplete.length} incomplete</Badge>
        )
      }
    >
      <ul className="flex flex-col divide-y divide-outline-variant/15 bg-surface-container-lowest rounded">
        {checklist.steps.map((s) => {
          const wk = wizardKey(s.key);
          return (
            <li key={s.key} className="flex items-center justify-between gap-space-sm px-space-md py-space-sm">
              <span className="flex items-center gap-space-sm font-body-md text-body-md text-on-surface">
                <Icon name={s.done ? 'check_circle' : 'radio_button_unchecked'} fill={s.done} className={clsx('text-[18px]', s.done ? 'text-tertiary' : s.key === 'devices' ? 'text-outline' : 'text-warning')} />
                {s.label}
                {s.key === 'devices' && !s.done && <Badge>Optional</Badge>}
              </span>
              {!s.done &&
                (wk ? (
                  <Button size="sm" variant="ghost" onClick={() => goTo(wk)}>
                    Go to step
                  </Button>
                ) : s.key === 'security' || s.key === 'account' ? (
                  <LinkButton size="sm" variant="ghost" to="/profile">
                    Open profile
                  </LinkButton>
                ) : null)}
            </li>
          );
        })}
      </ul>
      {checklist.completed ? (
        <div className="flex flex-wrap items-center justify-between gap-space-sm">
          <p className="font-body-sm text-body-sm text-on-surface-variant">Setup was already completed. You can revisit any step from here at any time.</p>
          <LinkButton to="/" variant="primary" icon="grid_view">
            Go to dashboard
          </LinkButton>
        </div>
      ) : (
        <>
          {required.length > 0 ? (
            <div className="rounded border border-warning/40 bg-warning-container/40 p-space-sm font-body-sm text-body-sm text-on-surface-variant">
              <strong className="text-on-surface">Still incomplete:</strong> {required.map((s) => s.label).join(', ')}. You can finish now and complete them later, but
              attendance cannot flow end-to-end until they are done.
            </div>
          ) : incomplete.length > 0 ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">Only optional steps remain. Devices can be provisioned at any time from Device Registry.</p>
          ) : (
            <p className="font-body-sm text-body-sm text-on-surface-variant">Everything is configured. Finish setup to open the operations dashboard.</p>
          )}
          <div className="flex justify-end">
            <Button variant="primary" size="lg" icon="rocket_launch" loading={complete.isPending} onClick={() => complete.mutate()}>
              {required.length > 0 ? 'Finish setup anyway' : 'Finish setup'}
            </Button>
          </div>
        </>
      )}
    </StepShell>
  );
}

// ───────────────────────── Wizard ─────────────────────────

export default function SetupWizard() {
  const checklist = useQuery<Checklist>({ queryKey: ['setup-checklist'], queryFn: () => api.get('/api/setup/checklist') });
  const [active, setActive] = useState<StepKey | null>(null);
  const c = checklist.data;

  const doneFor = (k: StepKey) => (k === 'ready' ? Boolean(c?.completed) : Boolean(c?.steps.find((s) => s.key === k)?.done));

  useEffect(() => {
    if (active || !c) return;
    const first = WIZARD.find((w) => w.key !== 'ready' && !w.optional && !c.steps.find((s) => s.key === w.key)?.done);
    setActive(c.completed ? 'ready' : (first?.key ?? 'ready'));
  }, [c, active]);

  const idx = WIZARD.findIndex((w) => w.key === active);
  const go = (k: StepKey) => {
    setActive(k);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const next = () => go(WIZARD[Math.min(idx + 1, WIZARD.length - 1)]!.key);
  const back = () => go(WIZARD[Math.max(idx - 1, 0)]!.key);

  const totalDone = c ? c.steps.filter((s) => s.done).length : 0;
  const total = c?.steps.length ?? 0;

  return (
    <>
      <PageHeader
        title="Organization Setup"
        icon="rocket_launch"
        subtitle={c ? `${c.organization.name} · ${totalDone} of ${total} setup items complete` : 'Progressive first-time configuration'}
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Setup' }]}
        actions={
          c?.completed ? (
            <Badge tone="success" icon="check_circle">
              Setup completed
            </Badge>
          ) : (
            <Button icon="refresh" variant="ghost" onClick={() => void checklist.refetch()} loading={checklist.isFetching}>
              Refresh status
            </Button>
          )
        }
      />
      {checklist.isLoading ? (
        <Loading label="Loading setup checklist…" />
      ) : checklist.error || !c ? (
        <ErrorState error={checklist.error} onRetry={() => void checklist.refetch()} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
          <aside className="lg:col-span-3 flex flex-col gap-gutter lg:sticky lg:top-28">
            <Panel title="Progress" icon="checklist" subtitle={`${totalDone} / ${total} complete`}>
              <Progress value={total ? (totalDone / total) * 100 : 0} tone={totalDone === total ? 'success' : 'primary'} className="mb-space-md" />
              <ol className="flex flex-col gap-1">
                {c.steps
                  .filter((s) => s.key === 'account' || s.key === 'security')
                  .map((s) => (
                    <li key={s.key} className="flex items-center justify-between gap-space-sm px-space-sm py-1.5 rounded text-body-sm text-on-surface-variant">
                      <span className="flex items-center gap-2">
                        <Icon name={s.done ? 'check_circle' : 'radio_button_unchecked'} fill={s.done} className={clsx('text-[18px]', s.done ? 'text-tertiary' : 'text-warning')} />
                        {s.label}
                      </span>
                      {!s.done && (
                        <Link to="/profile" className="font-label-sm text-label-sm text-secondary hover:underline">
                          Fix
                        </Link>
                      )}
                    </li>
                  ))}
                {WIZARD.map((w, i) => {
                  const done = doneFor(w.key);
                  const isActive = w.key === active;
                  return (
                    <li key={w.key}>
                      <button
                        type="button"
                        onClick={() => go(w.key)}
                        className={clsx(
                          'w-full flex items-center justify-between gap-space-sm px-space-sm py-1.5 rounded text-left text-body-sm transition-colors',
                          isActive ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                        )}
                        aria-current={isActive ? 'step' : undefined}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          {done ? (
                            <Icon name="check_circle" fill className={clsx('text-[18px]', isActive ? '' : 'text-tertiary')} />
                          ) : (
                            <span className={clsx('w-[18px] h-[18px] rounded-full border flex items-center justify-center font-mono text-[10px]', isActive ? 'border-on-primary-container' : 'border-outline')}>
                              {i + 1}
                            </span>
                          )}
                          <span className="truncate">{w.label}</span>
                        </span>
                        {w.optional && !done && <span className="font-label-sm text-label-sm opacity-70">optional</span>}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </Panel>
          </aside>
          <div className="lg:col-span-9 flex flex-col gap-gutter min-w-0">
            {active === 'organization' && <OrganizationStep checklist={c} done={doneFor('organization')} onNext={next} />}
            {active === 'integration' && <IntegrationStep done={doneFor('integration')} onBack={back} onNext={next} />}
            {active === 'infrastructure' && <InfrastructureStep checklist={c} done={doneFor('infrastructure')} onBack={back} onNext={next} />}
            {active === 'devices' && <DevicesStep checklist={c} done={doneFor('devices')} onBack={back} onNext={next} />}
            {active === 'employees' && <EmployeesStep checklist={c} done={doneFor('employees')} onBack={back} onNext={next} goTo={go} />}
            {active === 'ready' && <ReadyStep checklist={c} onBack={back} goTo={go} />}
          </div>
        </div>
      )}
    </>
  );
}
