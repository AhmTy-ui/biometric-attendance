import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  KV,
  LinkButton,
  Loading,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Tabs,
  Toggle,
  useErrorToast,
  useToast,
  type Tone, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLiveEvents } from '@/lib/live';
import { dateTime, num, relative, time } from '@/lib/format';
import { SyncStatusBadge } from './components';

type TabKey = 'unmapped' | 'mapped' | 'ignored';
const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun']
] as const;

interface CreateForm {
  name: string;
  code: string;
  address: string;
  timezone: string;
  workStart: string;
  workEnd: string;
  graceMinutes: number;
  workdays: number[];
}

interface LogLine {
  at: string;
  tone: Tone;
  text: string;
}

interface Outcome {
  externalRef: string;
  externalName: string | null;
  locationId: string;
  locationName: string;
  employeesAssigned: number;
  rerun: boolean;
  sync: 'waiting' | 'running' | 'done';
  run?: any;
}

const toCode = (ref: string) => ref.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function allTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

const statusTone: Record<string, Tone> = { unmapped: 'warning', mapped: 'success', ignored: 'neutral' };

export default function UnmappedLocations() {
  const { can, me } = useAuth();
  const canManage = can('integration.manage');
  const orgTz = me?.organization.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const timezones = useMemo(allTimezones, []);

  const [tab, setTab] = useState<TabKey>('unmapped');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [locationId, setLocationId] = useState('');
  const [form, setForm] = useState<CreateForm>({ name: '', code: '', address: '', timezone: orgTz, workStart: '08:00', workEnd: '17:00', graceMinutes: 15, workdays: [1, 2, 3, 4, 5] });
  const [rerunSync, setRerunSync] = useState(true);
  const [log, setLog] = useState<LogLine[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmIgnore, setConfirmIgnore] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTz, setImportTz] = useState(orgTz);

  const mappings = useQuery({ queryKey: ['location-mappings'], queryFn: () => api.get<any[]>('/api/location-mappings') });
  const locations = useQuery({ queryKey: ['locations', 'all'], queryFn: () => api.get<any[]>('/api/locations'), enabled: can('locations.view') });

  const all = mappings.data ?? [];
  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { unmapped: 0, mapped: 0, ignored: 0 };
    for (const m of all) if (m.status in c) c[m.status as TabKey]++;
    return c;
  }, [all]);
  const heldEmployees = useMemo(() => all.filter((m) => m.status === 'unmapped').reduce((a, m) => a + Number(m.employees_affected ?? 0), 0), [all]);
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((m) => m.status === tab && (!s || `${m.external_ref} ${m.external_name ?? ''} ${m.location_name ?? ''}`.toLowerCase().includes(s)));
  }, [all, tab, search]);
  const selected = all.find((m) => m.id === selectedId) ?? null;

  const addLog = (tone: Tone, text: string) => setLog((l) => [...l.slice(-19), { at: new Date().toISOString(), tone, text }]);

  // Auto-select the first item of the current tab.
  useEffect(() => {
    if (!mappings.data) return;
    if (!selectedId || !all.some((m) => m.id === selectedId)) setSelectedId(list[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappings.data, tab]);

  // Prefill the resolver form from the selected mapping.
  useEffect(() => {
    if (!selected) return;
    setMode('existing');
    setLocationId(selected.location_id ?? '');
    setForm({
      name: selected.external_name ?? selected.external_ref,
      code: toCode(selected.external_ref),
      address: '',
      timezone: orgTz,
      workStart: '08:00',
      workEnd: '17:00',
      graceMinutes: 15,
      workdays: [1, 2, 3, 4, 5]
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Follow the employee sync re-run that the resolve call starts.
  useLiveEvents('sync/', (f) => {
    const run = f.data;
    if (run?.kind !== 'employees') return;
    if (f.kind === 'sync/started') {
      setOutcome((o) => (o && o.rerun && o.sync === 'waiting' ? { ...o, sync: 'running', run } : o));
      if (outcome?.rerun && outcome.sync === 'waiting') addLog('info', 'Employee synchronisation started.');
    } else if (f.kind === 'sync/finished') {
      if (outcome?.rerun && outcome.sync !== 'done') {
        const errs = Number(run.error_count ?? 0);
        addLog(
          run.status === 'failed' ? 'error' : errs > 0 ? 'warning' : 'success',
          run.status === 'failed'
            ? `Employee synchronisation failed: ${run.error_message ?? 'unknown error'}`
            : `Employee synchronisation ${errs > 0 ? `completed with ${errs} errors` : 'completed successfully'}: ${num(run.records_processed)} processed, +${num(run.records_added)} added, ${num(run.records_updated)} updated.`
        );
      }
      setOutcome((o) => (o && o.rerun && o.sync !== 'done' ? { ...o, sync: 'done', run } : o));
      void qc.invalidateQueries({ queryKey: ['location-mappings'] });
    }
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['location-mappings'] });
    void qc.invalidateQueries({ queryKey: ['integration-status'] });
    void qc.invalidateQueries({ queryKey: ['locations'] });
    void qc.invalidateQueries({ queryKey: ['alerts'] });
    void qc.invalidateQueries({ queryKey: ['employees'] });
  };

  const resolve = useMutation({
    mutationFn: (m: any) =>
      api.post<{ locationId: string; externalRef: string; employeesAssigned: number }>(`/api/location-mappings/${m.id}/resolve`, {
        ...(mode === 'existing'
          ? { locationId }
          : { createLocation: { ...form, address: form.address.trim() || null, name: form.name.trim(), code: form.code.trim() } }),
        rerunSync
      }),
    onMutate: (m) => addLog('info', `Mapping ${m.external_ref} → ${mode === 'existing' ? (locations.data?.find((l) => l.id === locationId)?.name ?? 'selected location') : `new location "${form.name}"`}…`),
    onSuccess: (r, m) => {
      const locName = mode === 'existing' ? (locations.data?.find((l) => l.id === r.locationId)?.name ?? 'the selected location') : form.name.trim();
      addLog('success', `${r.externalRef} mapped to ${locName}. ${r.employeesAssigned} employee(s) assigned and queued for device rosters.`);
      if (rerunSync) addLog('info', 'Employee synchronisation re-run requested.');
      setOutcome({
        externalRef: r.externalRef,
        externalName: m.external_name ?? null,
        locationId: r.locationId,
        locationName: locName,
        employeesAssigned: r.employeesAssigned,
        rerun: rerunSync,
        sync: rerunSync ? 'waiting' : 'done'
      });
      toast({ tone: 'success', title: 'Location mapped', description: `${r.employeesAssigned} employee(s) assigned to ${locName}.` });
      invalidate();
    },
    onError: (e) => {
      addLog('error', `Mapping failed: ${(e as any)?.message ?? 'error'}`);
      errorToast(e, 'Could not map location');
    }
  });

  const ignore = useMutation({
    mutationFn: (m: any) => api.post(`/api/location-mappings/${m.id}/ignore`),
    onSuccess: (_r, m) => {
      setConfirmIgnore(false);
      addLog('neutral', `${m.external_ref} marked as ignored. Its employees stay held and are not placed on any device roster.`);
      toast({ tone: 'success', title: 'Location reference ignored' });
      setSelectedId(null);
      invalidate();
    },
    onError: (e) => errorToast(e, 'Could not ignore location')
  });

  const importAll = useMutation({
    mutationFn: () => api.post<{ imported: number }>('/api/location-mappings/import-all', { timezone: importTz }),
    onSuccess: (r) => {
      setImportOpen(false);
      addLog('success', `Imported ${r.imported} web-software location(s) as new platform locations.`);
      toast({ tone: 'success', title: `${r.imported} location(s) imported`, description: 'Held employees were assigned to the new locations.' });
      setSelectedId(null);
      invalidate();
    },
    onError: (e) => errorToast(e, 'Import failed')
  });

  const formErrors = useMemo(() => {
    if (mode === 'existing') return locationId ? null : 'Choose a location';
    if (form.name.trim().length < 2) return 'Name must have at least 2 characters';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(form.code.trim())) return 'Code: 1–40 letters, digits, dot, dash or underscore';
    if (!form.timezone) return 'Timezone is required';
    if (!/^\d{2}:\d{2}$/.test(form.workStart) || !/^\d{2}:\d{2}$/.test(form.workEnd)) return 'Work hours must be HH:MM';
    if (!form.workdays.length) return 'Select at least one workday';
    return null;
  }, [mode, locationId, form]);

  if (mappings.isLoading) return <Loading label="Loading location mappings..." />;
  if (mappings.error && !mappings.data) return <ErrorState error={mappings.error} onRetry={() => mappings.refetch()} />;

  const samples: any[] = selected?.sample_employees ?? [];
  const affected = Number(selected?.employees_affected ?? 0);

  return (
    <div className="space-y-space-md">
      <PageHeader
        crumbs={[{ label: 'Integration & Sync', to: '/integration' }, { label: 'Unmapped locations' }]}
        title="Unmapped Location Resolution"
        icon="share_location"
        subtitle="Map web-software location references to platform locations so their employees reach the right device rosters."
        actions={
          canManage &&
          counts.unmapped > 0 && (
            <Button icon="playlist_add" onClick={() => setImportOpen(true)}>
              Import all as new locations
            </Button>
          )
        }
      />

      {/* Banner (template: operational triage) */}
      <div className="card rounded-xl p-space-md relative overflow-hidden">
        <div className={clsx('absolute left-0 top-0 bottom-0 w-1.5', counts.unmapped ? 'bg-secondary-container' : 'bg-tertiary')} />
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-space-md pl-space-xs">
          <div className="flex items-start gap-space-sm min-w-0">
            <div className={clsx('p-2 rounded flex items-center justify-center shrink-0 mt-0.5', counts.unmapped ? 'bg-secondary-container/15 text-secondary' : 'bg-tertiary-container/20 text-tertiary')}>
              <Icon name={counts.unmapped ? 'notification_important' : 'task_alt'} className="text-[20px]" />
            </div>
            <div className="flex flex-col space-y-1">
              <div className="flex items-center gap-space-sm flex-wrap">
                <span className="font-headline-sm text-headline-sm text-on-surface">
                  {counts.unmapped ? `${num(counts.unmapped)} unmapped location reference${counts.unmapped === 1 ? '' : 's'}` : 'All web-software locations are resolved'}
                </span>
                {counts.unmapped > 0 && (
                  <span className="font-label-sm text-label-sm uppercase px-1.5 py-0.5 rounded bg-secondary-container/20 text-secondary font-semibold">{num(heldEmployees)} employees held</span>
                )}
              </div>
              <p className="font-body-sm text-body-sm text-on-surface-variant max-w-4xl">
                Employees are <strong className="text-on-surface font-semibold">never discarded</strong> because of an unknown location. They are kept in the platform and held off device rosters until their
                location is mapped; once mapped, they are assigned and pushed to that location's devices automatically.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
        {/* RESOLVER PANEL */}
        <div className="lg:col-span-7 xl:col-span-8 bg-surface-container rounded-lg p-space-md shadow-md space-y-space-md" id="resolver-panel">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-space-sm">
              <span className="p-1.5 rounded bg-primary-container/20 text-primary">
                <Icon name="share_location" className="text-[18px]" />
              </span>
              <div>
                <h2 className="font-headline-md text-headline-md text-on-surface">Location Resolution Wizard</h2>
                <p className="font-body-sm text-body-sm text-outline">Map to an existing location, or create a new one from the web-software reference</p>
              </div>
            </div>
            <span className="font-label-sm text-label-sm px-2 py-0.5 rounded bg-secondary-container/20 text-secondary font-medium">{num(counts.unmapped)} pending</span>
          </div>

          {outcome && (
            <div className="bg-surface-container-low rounded p-space-md space-y-space-sm border border-tertiary/30">
              <div className="flex items-start justify-between gap-space-sm">
                <div className="flex items-start gap-space-sm">
                  <Icon name="task_alt" className="text-[22px] text-tertiary" />
                  <div>
                    <div className="font-headline-sm text-headline-sm text-on-surface">
                      {outcome.employeesAssigned > 0 ? 'Employees assigned correctly' : 'Location mapped'}
                    </div>
                    <p className="font-body-sm text-body-sm text-on-surface-variant">
                      <span className="font-mono text-secondary">{outcome.externalRef}</span>
                      {outcome.externalName ? ` (${outcome.externalName})` : ''} →{' '}
                      <span className="text-on-surface font-semibold">{outcome.locationName}</span>
                      . {num(outcome.employeesAssigned)} employee(s) assigned and added to the location's device roster.
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="ghost" icon="close" onClick={() => setOutcome(null)}>
                  Close
                </Button>
              </div>
              {outcome.rerun && (
                <div className="flex items-center gap-2 font-label-sm text-label-sm text-outline">
                  {outcome.sync === 'done' ? (
                    <>
                      <span>Employee sync re-run:</span>
                      {outcome.run ? <SyncStatusBadge status={outcome.run.status} /> : <Badge tone="success">Finished</Badge>}
                      {outcome.run?.id && (
                        <Link to={`/integration/runs/${outcome.run.id}`} className="text-primary hover:underline">
                          View run
                        </Link>
                      )}
                    </>
                  ) : (
                    <>
                      <Icon name="progress_activity" className="animate-spin text-[14px] text-secondary" />
                      <span>Synchronizing... re-running employee sync so pending changes resolve against the new mapping.</span>
                    </>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-space-xs">
                <LinkButton size="sm" to={`/locations/${outcome.locationId}`} icon="storefront">
                  View location
                </LinkButton>
                {counts.unmapped > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon="arrow_forward"
                    onClick={() => {
                      setTab('unmapped');
                      setSelectedId(all.find((m) => m.status === 'unmapped')?.id ?? null);
                      setOutcome(null);
                    }}
                  >
                    Resolve next
                  </Button>
                )}
              </div>
            </div>
          )}

          {!selected ? (
            <Empty
              icon={counts.unmapped ? 'touch_app' : 'task_alt'}
              title={counts.unmapped ? 'Select a location reference' : 'Nothing to resolve'}
              description={counts.unmapped ? 'Choose an unmapped reference from the queue to resolve it.' : 'Every location referenced by the web software is mapped or ignored.'}
            />
          ) : (
            <>
              {/* Held employees */}
              <div className="bg-surface-container-lowest rounded overflow-hidden">
                <div className="px-space-md py-2 bg-surface-container-high flex items-center justify-between gap-2">
                  <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">
                    {selected.status === 'mapped' ? 'Assigned employees' : 'Held employees'}
                  </span>
                  <span className="font-label-sm text-label-sm text-outline">
                    {num(affected)} active employee{affected === 1 ? '' : 's'} reference <span className="font-mono text-secondary">{selected.external_ref}</span>
                  </span>
                </div>
                {samples.length === 0 ? (
                  <Empty icon="group_off" title="No active employees reference this location yet." description="Employees will be held here if the web software assigns them to it before it is mapped." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-body-sm text-body-sm">
                      <thead className="bg-surface-container-low font-label-sm text-label-sm text-outline uppercase tracking-wider">
                        <tr>
                          <th className="py-2 px-space-md">Employee</th>
                          <th className="py-2 px-space-md">Staff number</th>
                          <th className="py-2 px-space-md">Web-software location</th>
                          <th className="py-2 px-space-md text-right">Roster</th>
                        </tr>
                      </thead>
                      <tbody className="text-on-surface">
                        {samples.map((e) => (
                          <tr key={e.id} className="hover:bg-surface-container/60 transition-colors border-t border-outline-variant/10">
                            <td className="py-2.5 px-space-md">
                              <Link to={`/employees/${e.id}`} className="flex items-center gap-2 hover:text-primary">
                                <Avatar name={e.full_name} size={6} />
                                <span className="font-medium">{e.full_name}</span>
                              </Link>
                            </td>
                            <td className="py-2.5 px-space-md font-mono text-[11px] text-primary">{e.staff_number}</td>
                            <td className="py-2.5 px-space-md">
                              <span className="font-label-sm text-label-sm px-1.5 py-0.5 rounded bg-surface-container-high text-secondary font-mono">{selected.external_ref}</span>
                              {selected.external_name && <span className="text-outline text-[11px] block">{selected.external_name}</span>}
                            </td>
                            <td className={clsx('py-2.5 px-space-md text-right font-label-sm text-label-sm', selected.status === 'mapped' ? 'text-tertiary' : 'text-secondary')}>
                              {selected.status === 'mapped' ? 'Assigned' : 'Held'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {affected > samples.length && (
                      <div className="px-space-md py-2 font-label-sm text-label-sm text-outline border-t border-outline-variant/10">
                        + {num(affected - samples.length)} more employee{affected - samples.length === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {selected.status !== 'unmapped' && (
                <div className="bg-surface-container-low rounded p-space-md">
                  <KV label="Status">
                    <Badge tone={statusTone[selected.status]}>{selected.status}</Badge>
                  </KV>
                  {selected.status === 'mapped' && (
                    <KV label="Platform location">
                      {selected.location_id ? (
                        <Link to={`/locations/${selected.location_id}`} className="text-primary hover:underline">
                          {selected.location_name ?? 'View location'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </KV>
                  )}
                  <KV label="Resolved" mono>
                    {selected.resolved_at ? dateTime(selected.resolved_at) : '—'}
                  </KV>
                  <KV label="Resolved by">{selected.resolved_by_name ?? (selected.resolved_at ? 'Automatic (matching code)' : '—')}</KV>
                </div>
              )}

              {/* Resolution form */}
              {canManage ? (
                <div className="bg-surface-container-low rounded p-space-md space-y-space-sm">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">
                      {selected.status === 'mapped' ? 'Remap to a different location' : 'Location binding target'}
                    </span>
                    <span className="font-label-sm text-label-sm text-outline">Affects {num(affected)} employee{affected === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-2 font-body-sm text-body-sm text-on-surface flex-wrap">
                    <Icon name="input" className="text-[16px] text-outline" />
                    <span>Incoming source identifier:</span>
                    <span className="font-label-sm text-label-sm px-2 py-0.5 rounded bg-surface-container-highest text-secondary font-mono">{selected.external_ref}</span>
                    {selected.external_name && <span className="text-on-surface-variant">{selected.external_name}</span>}
                  </div>

                  <div className="flex gap-1 bg-surface-container-lowest p-1 rounded-lg w-fit">
                    {(
                      [
                        ['existing', 'Map to existing location', 'link'],
                        ['create', 'Create new location', 'add_location_alt']
                      ] as const
                    ).map(([k, l, i]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setMode(k)}
                        className={clsx(
                          'flex items-center gap-1.5 px-space-sm py-1.5 rounded font-label-md text-label-md transition-colors',
                          mode === k ? 'bg-surface-container text-on-surface shadow-sm' : 'text-outline hover:text-on-surface'
                        )}
                      >
                        <Icon name={i} className="text-[15px]" />
                        {l}
                      </button>
                    ))}
                  </div>

                  {mode === 'existing' ? (
                    <div className="flex items-center gap-2">
                      <Icon name="arrow_forward" className="text-[16px] text-outline" />
                      {locations.isLoading ? (
                        <Loading label="Loading locations..." className="py-2" />
                      ) : locations.error ? (
                        <ErrorState error={locations.error} onRetry={() => locations.refetch()} compact />
                      ) : !can('locations.view') ? (
                        <span className="text-body-sm text-on-surface-variant">You need permission to view locations to map to an existing one. Create a new location instead.</span>
                      ) : (
                        <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="flex-1" aria-label="Target location">
                          <option value="">Select a platform location…</option>
                          {(locations.data ?? []).map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name} ({l.code}){!l.is_active ? ' — inactive' : ''} · {num(l.devices)} device(s)
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
                      <Field label="Name" required>
                        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
                      </Field>
                      <Field label="Code" required hint="Prefilled from the web-software reference">
                        <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={40} className="font-mono" />
                      </Field>
                      <Field label="Address">
                        <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={300} />
                      </Field>
                      <Field label="Timezone" required>
                        <Input list="bamp-timezones" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                      </Field>
                      <div className="grid grid-cols-3 gap-space-sm">
                        <Field label="Work start">
                          <Input type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
                        </Field>
                        <Field label="Work end">
                          <Input type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
                        </Field>
                        <Field label="Grace (min)">
                          <Input
                            type="number"
                            min={0}
                            max={240}
                            value={form.graceMinutes}
                            onChange={(e) => setForm({ ...form, graceMinutes: Math.max(0, Math.min(240, parseInt(e.target.value, 10) || 0)) })}
                          />
                        </Field>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide">Workdays</span>
                        <div className="flex flex-wrap gap-1">
                          {DAYS.map(([d, l]) => {
                            const on = form.workdays.includes(d);
                            return (
                              <button
                                key={d}
                                type="button"
                                onClick={() =>
                                  setForm({ ...form, workdays: on ? form.workdays.filter((x) => x !== d) : [...form.workdays, d].sort((a, b) => a - b) })
                                }
                                className={clsx(
                                  'px-2 h-9 rounded font-label-md text-label-md border transition-colors',
                                  on ? 'bg-primary-container/30 border-primary-container text-primary' : 'bg-surface-container-lowest border-outline-variant/40 text-outline hover:text-on-surface'
                                )}
                              >
                                {l}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <datalist id="bamp-timezones">
                        {timezones.map((tz) => (
                          <option key={tz} value={tz} />
                        ))}
                      </datalist>
                    </div>
                  )}

                  <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
                    <Toggle checked={rerunSync} onChange={setRerunSync} label="Re-run employee sync after mapping" />
                    <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                      {selected.status === 'unmapped' && (
                        <Button variant="ghost" icon="block" onClick={() => setConfirmIgnore(true)}>
                          Ignore
                        </Button>
                      )}
                      <Button
                        variant="primary"
                        icon="sync_saved_locally"
                        loading={resolve.isPending}
                        disabled={Boolean(formErrors)}
                        title={formErrors ?? undefined}
                        onClick={() => resolve.mutate(selected)}
                      >
                        {resolve.isPending ? 'Synchronizing...' : 'Commit mapping & assign employees'}
                      </Button>
                    </div>
                  </div>
                  {formErrors && <p className="font-body-sm text-body-sm text-outline text-right">{formErrors}</p>}
                </div>
              ) : (
                <div className="p-space-sm rounded bg-surface-container-highest flex items-center gap-2 text-outline font-label-sm text-label-sm">
                  <Icon name="lock" className="text-[16px]" />
                  <span>You can view mappings but need the “integration.manage” permission to resolve them.</span>
                </div>
              )}
            </>
          )}

          {/* Activity log (template: dispatch terminal) */}
          {log.length > 0 && (
            <div className="bg-surface-container-lowest rounded p-space-sm font-mono text-[11px] text-outline space-y-1">
              <div className="flex items-center justify-between text-[9px] text-outline-variant uppercase">
                <span>Resolution activity (this session)</span>
                <button className="hover:text-on-surface" onClick={() => setLog([])}>
                  Clear
                </button>
              </div>
              {log.map((l, i) => (
                <p key={i} className="flex items-start gap-1.5 text-on-surface-variant">
                  <span className={clsx(l.tone === 'success' ? 'text-tertiary' : l.tone === 'error' ? 'text-error' : l.tone === 'warning' ? 'text-warning' : 'text-secondary')}>●</span>
                  <span className="shrink-0">[{time(l.at)}]</span>
                  <span className={clsx(l.tone === 'success' ? 'text-tertiary' : l.tone === 'error' ? 'text-error' : 'text-on-surface')}>{l.text}</span>
                </p>
              ))}
            </div>
          )}
        </div>

        {/* QUEUE */}
        <div className="lg:col-span-5 xl:col-span-4 bg-surface-container rounded-lg p-space-md shadow-md space-y-space-sm">
          <SideToggle id="unmapped-queue" label="Queue" />
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-secondary-container/20 text-secondary">
              <Icon name="format_list_bulleted" className="text-[18px]" />
            </span>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Web-software locations</h3>
          </div>
          <Tabs<TabKey>
            value={tab}
            onChange={(t) => {
              setTab(t);
              setSelectedId(all.find((m) => m.status === t)?.id ?? null);
            }}
            tabs={[
              { key: 'unmapped', label: 'Unmapped', count: counts.unmapped },
              { key: 'mapped', label: 'Mapped', count: counts.mapped },
              { key: 'ignored', label: 'Ignored', count: counts.ignored }
            ]}
          />
          <SearchInput value={search} onChange={setSearch} placeholder="Search reference or name…" />
          {list.length === 0 ? (
            <Empty
              icon={tab === 'unmapped' ? 'task_alt' : 'inbox'}
              title={search ? 'No matching locations.' : tab === 'unmapped' ? 'No unmapped locations.' : tab === 'mapped' ? 'No mapped locations yet.' : 'No ignored locations.'}
            />
          ) : (
            <div className="space-y-space-xs max-h-[640px] overflow-y-auto">
              {list.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className={clsx(
                    'w-full text-left rounded p-space-sm space-y-1 transition-colors',
                    m.id === selectedId ? 'bg-surface-container-high ring-1 ring-primary-container' : 'bg-surface-container-low hover:bg-surface-container-high'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-body-sm text-body-sm text-on-surface font-semibold truncate">{m.external_name ?? m.external_ref}</span>
                    <Badge tone={statusTone[m.status]}>{m.status}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-label-sm text-label-sm text-outline">
                    <span className="font-mono text-secondary truncate">{m.external_ref}</span>
                    <span className="shrink-0">
                      <Icon name="group" className="text-[12px] align-middle" /> {num(m.employees_affected)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-label-sm text-label-sm text-outline">
                    <span>First seen {relative(m.first_seen_at)}</span>
                    {m.status === 'mapped' && m.location_name && <span className="truncate text-tertiary">→ {m.location_name}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmIgnore && Boolean(selected)}
        onClose={() => setConfirmIgnore(false)}
        onConfirm={() => selected && ignore.mutate(selected)}
        loading={ignore.isPending}
        danger
        title="Ignore this location reference?"
        confirmLabel="Ignore location"
        message={
          <div className="space-y-2">
            <p>
              <span className="font-mono text-secondary">{selected?.external_ref}</span>
              {selected?.external_name ? ` (${selected.external_name})` : ''} will be marked as ignored and its alert resolved.
            </p>
            <p>
              The {num(affected)} employee{affected === 1 ? '' : 's'} referencing it are <strong className="text-on-surface">not deleted</strong>, but they stay off every device roster and cannot clock in until
              the reference is mapped. You can map it later from the Ignored tab.
            </p>
          </div>
        }
      />

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import all as new locations"
        icon="playlist_add"
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="playlist_add" loading={importAll.isPending} disabled={!importTz} onClick={() => importAll.mutate()}>
              Import {num(counts.unmapped)} location{counts.unmapped === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <div className="space-y-space-sm text-body-sm text-on-surface-variant">
          <p>
            Creates one platform location for each of the {num(counts.unmapped)} unmapped web-software references, named after the web-software location with its reference as the code. An existing
            location with the same code is reused instead. Held employees ({num(heldEmployees)}) are assigned and pushed to device rosters.
          </p>
          <p>New locations get the platform's default work hours; adjust them afterwards in Locations.</p>
          <Field label="Timezone for new locations" required>
            <Input list="bamp-timezones-import" value={importTz} onChange={(e) => setImportTz(e.target.value)} />
          </Field>
          <datalist id="bamp-timezones-import">
            {timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </div>
      </Modal>
    </div>
  );
}
