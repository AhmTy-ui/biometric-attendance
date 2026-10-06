import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Dot,
  Empty,
  ErrorState,
  Field,
  Icon,
  Input,
  KV,
  Loading,
  PageHeader,
  Panel,
  SearchInput,
  Select,
  Table,
  Td,
  Th,
  THead,
  Tr,
  deviceStatusLabel,
  deviceTone,
  useErrorToast,
  useToast, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useGlobalLocation } from '@/lib/scope';
import { bytes, date, num, relative } from '@/lib/format';
import { ChannelBadge, shortSha } from './components';

const STEPS = [
  { key: 'version', label: 'Select Version', icon: 'inventory_2' },
  { key: 'devices', label: 'Select Devices', icon: 'router' },
  { key: 'review', label: 'Review Deployment', icon: 'fact_check' },
  { key: 'monitor', label: 'Deploy & Monitor', icon: 'monitoring' }
] as const;

type StatusFilter = '' | 'online' | 'offline' | 'warning' | 'not_eligible';

const isEligibleState = (d: any) => ['connected', 'active'].includes(d.lifecycle_state);

function matchesStatus(d: any, s: StatusFilter) {
  if (!s) return true;
  if (s === 'not_eligible') return !isEligibleState(d);
  if (!isEligibleState(d)) return false;
  if (s === 'offline') return d.connectivity === 'offline';
  if (s === 'warning') return d.connectivity === 'online' && ['warning', 'critical'].includes(d.health);
  return d.connectivity === 'online' && d.health === 'healthy';
}

export default function FirmwareDeploy() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [params] = useSearchParams();
  const [globalLoc] = useGlobalLocation();

  const [step, setStep] = useState(0);
  const [firmwareId, setFirmwareId] = useState<string>(params.get('firmwareId') ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(params.getAll('deviceId')));
  const [locationId, setLocationId] = useState<string>(globalLoc ?? '');
  const [status, setStatus] = useState<StatusFilter>('');
  const [currentFw, setCurrentFw] = useState('');
  const [q, setQ] = useState('');
  const [name, setName] = useState('');

  const versionsQ = useQuery({ queryKey: ['firmware-versions'], queryFn: () => api.get<any[]>('/api/firmware/versions') });
  const devicesQ = useQuery({ queryKey: ['devices', { limit: 1000 }], queryFn: () => api.get<any>('/api/devices', { limit: 1000 }) });
  const locationsQ = useQuery({ queryKey: ['locations', { q: '' }], queryFn: () => api.get<any[]>('/api/locations') });

  const versions: any[] = versionsQ.data ?? [];
  const devices: any[] = devicesQ.data?.rows ?? [];
  const fw = versions.find((v) => v.id === firmwareId) ?? null;

  // Preselected device (?deviceId=) → start with its location unfiltered so it stays visible.
  useEffect(() => {
    if (params.get('deviceId')) setLocationId('');
  }, [params]);

  // Default the deployment name whenever the chosen version changes.
  const fwVersion: string | undefined = fw?.version;
  useEffect(() => {
    if (fwVersion) setName(`${fwVersion} rollout — ${date(new Date())}`);
  }, [fwVersion]);

  const fleetVersions = useMemo(() => [...new Set(devices.map((d) => d.firmware_version).filter(Boolean))].sort() as string[], [devices]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return devices.filter(
      (d) =>
        (!locationId || d.location_id === locationId) &&
        matchesStatus(d, status) &&
        (!currentFw || (currentFw === '__none' ? !d.firmware_version : d.firmware_version === currentFw)) &&
        (!needle || [d.name, d.device_uid, d.serial_number, d.location_name].some((x) => String(x ?? '').toLowerCase().includes(needle)))
    );
  }, [devices, locationId, status, currentFw, q]);

  const selectable = (d: any) => isEligibleState(d) && (!fw || d.firmware_version !== fw.version);
  const filteredSelectable = filtered.filter(selectable);
  const allFilteredSelected = filteredSelectable.length > 0 && filteredSelectable.every((d) => selected.has(d.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAllFiltered = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allFilteredSelected) filteredSelectable.forEach((d) => n.delete(d.id));
      else filteredSelectable.forEach((d) => n.add(d.id));
      return n;
    });

  const deviceIds = useMemo(() => [...selected].sort(), [selected]);

  const reviewQ = useQuery({
    queryKey: ['firmware-review', firmwareId, deviceIds],
    queryFn: () => api.post<any>('/api/firmware/deployments', { firmwareId, deviceIds, name: name.trim().length >= 2 ? name.trim() : 'Review', dryRun: true }),
    enabled: step === 2 && Boolean(firmwareId) && deviceIds.length > 0,
    staleTime: 0,
    gcTime: 0
  });
  const review = reviewQ.data?.review;

  const deploy = useMutation({
    mutationFn: () => api.post<any>('/api/firmware/deployments', { firmwareId, deviceIds, name: name.trim() }),
    onSuccess: (res) => {
      toast({ tone: 'success', title: 'Deployment started', description: `${num(res.review?.eligible?.length ?? 0)} devices queued for ${res.review?.firmware?.version ?? ''}` });
      void qc.invalidateQueries({ queryKey: ['firmware-deployments'] });
      nav(`/firmware/deployments/${res.deployment.id}`, { replace: true });
    },
    onError: (e) => errToast(e, 'Deployment failed')
  });

  const canNext = step === 0 ? Boolean(fw) : step === 1 ? selected.size > 0 : false;
  const nameOk = name.trim().length >= 2 && name.trim().length <= 120;

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        icon="play_circle"
        title="New firmware deployment"
        subtitle="Choose a version, choose the devices, review, then deploy."
        crumbs={[{ label: 'Firmware', to: '/firmware' }, { label: 'New deployment' }]}
      />

      {/* Stepper */}
      <ol className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'todo';
          return (
            <li
              key={s.key}
              className={clsx(
                'p-space-sm rounded flex items-center gap-space-sm shadow-sm',
                state === 'current' ? 'bg-surface-container-high' : state === 'done' ? 'bg-surface-container' : 'bg-surface-container/60'
              )}
            >
              <div
                className={clsx(
                  'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                  state === 'done' ? 'bg-tertiary-container/30 text-tertiary' : state === 'current' ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest text-outline'
                )}
              >
                <Icon name={state === 'done' ? 'check' : s.icon} className="text-[16px]" />
              </div>
              <div className="min-w-0">
                <div className={clsx('font-label-sm text-label-sm uppercase tracking-wider font-semibold', state === 'current' ? 'text-secondary' : state === 'done' ? 'text-tertiary' : 'text-outline')}>
                  Step {String(i + 1).padStart(2, '0')}
                </div>
                <div className={clsx('font-body-sm text-body-sm truncate', state === 'todo' ? 'text-outline' : 'text-on-surface font-semibold')}>{s.label}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Step 1 — version */}
      {step === 0 && (
        <Panel title="Select firmware version" icon="inventory_2" subtitle="The version that will be installed on the selected devices">
          {versionsQ.isLoading ? (
            <Loading label="Loading firmware versions…" />
          ) : versionsQ.error && !versionsQ.data ? (
            <ErrorState error={versionsQ.error} onRetry={() => versionsQ.refetch()} />
          ) : !versions.length ? (
            <Empty icon="inventory_2" title="No firmware versions uploaded." description="Upload a firmware version on the Firmware page first." action={<Link className="text-primary hover:underline text-body-sm" to="/firmware">Go to Firmware</Link>} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-sm">
              {versions.map((v) => {
                const active = v.id === firmwareId;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setFirmwareId(v.id)}
                    className={clsx(
                      'text-left p-space-sm rounded shadow-sm transition-colors border',
                      active ? 'bg-surface-container-high border-primary-container' : 'bg-surface-container border-transparent hover:bg-surface-container-high'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon name={active ? 'radio_button_checked' : 'radio_button_unchecked'} className={clsx('text-[18px]', active ? 'text-primary' : 'text-outline')} />
                        <span className="font-label-lg text-label-lg font-semibold text-on-surface truncate">{v.version}</span>
                      </div>
                      <ChannelBadge channel={v.channel} />
                    </div>
                    <div className="font-label-sm text-label-sm text-outline">
                      {bytes(Number(v.size_bytes))} • sha256:{shortSha(v.sha256)} • uploaded {date(v.created_at)}
                    </div>
                    <div className="font-label-sm text-label-sm text-on-surface-variant mt-1">Installed on {num(v.installed_on)} devices</div>
                    {v.release_notes && <p className="mt-1 text-body-sm text-on-surface-variant line-clamp-3 whitespace-pre-wrap">{v.release_notes}</p>}
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
      )}

      {/* Step 2 — devices */}
      {step === 1 && (
        <Panel
          title="Select devices"
          icon="router"
          subtitle={fw ? `Deploying ${fw.version} • ${num(selected.size)} selected` : undefined}
          bodyClassName="px-0 pb-0"
          actions={
            selected.size > 0 && (
              <Button size="sm" variant="ghost" icon="close" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            )
          }
        >
          <div className="flex flex-wrap items-end gap-space-sm px-space-md pb-space-sm">
            <SearchInput value={q} onChange={setQ} placeholder="Search name, device ID, serial…" className="w-full sm:w-64" />
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-8 w-full sm:w-48">
              <option value="">All locations</option>
              {(locationsQ.data ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="h-8 w-full sm:w-40">
              <option value="">Any status</option>
              <option value="online">Online</option>
              <option value="warning">Warning</option>
              <option value="offline">Offline</option>
              <option value="not_eligible">Not activated</option>
            </Select>
            <Select value={currentFw} onChange={(e) => setCurrentFw(e.target.value)} className="h-8 w-full sm:w-44">
              <option value="">Any current firmware</option>
              {fleetVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
              <option value="__none">Not reported</option>
            </Select>
          </div>
          {devicesQ.isLoading ? (
            <Loading label="Loading devices…" />
          ) : devicesQ.error && !devicesQ.data ? (
            <ErrorState error={devicesQ.error} onRetry={() => devicesQ.refetch()} />
          ) : !filtered.length ? (
            <Empty icon="router" title="No devices match these filters." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all matching devices"
                      checked={allFilteredSelected}
                      disabled={!filteredSelectable.length}
                      onChange={toggleAllFiltered}
                      className="accent-primary-container"
                    />
                  </Th>
                  <Th>Device</Th>
                  <Th>Location</Th>
                  <Th>Status</Th>
                  <Th>Current firmware</Th>
                  <Th>Last seen</Th>
                  <Th>Buffered</Th>
                </tr>
              </THead>
              <tbody>
                {filtered.map((d) => {
                  const ok = selectable(d);
                  const already = fw && d.firmware_version === fw.version;
                  return (
                    <Tr key={d.id} onClick={ok ? () => toggle(d.id) : undefined} className={clsx(!ok && 'opacity-60', selected.has(d.id) && 'bg-primary-container/10')}>
                      <Td>
                        <input type="checkbox" checked={selected.has(d.id)} disabled={!ok} onChange={() => toggle(d.id)} onClick={(e) => e.stopPropagation()} className="accent-primary-container" aria-label={`Select ${d.name}`} />
                      </Td>
                      <Td>
                        <div className="font-semibold text-on-surface">{d.name}</div>
                        <div className="font-label-sm text-label-sm text-outline font-mono">{d.device_uid}</div>
                      </Td>
                      <Td className="text-on-surface-variant">{d.location_name ?? 'Unassigned'}</Td>
                      <Td>
                        <span className="flex items-center gap-1.5">
                          <Dot tone={deviceTone(d)} />
                          <span className="text-on-surface-variant">{deviceStatusLabel(d)}</span>
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono text-on-surface">{d.firmware_version ?? '—'}</span>
                        {already && (
                          <Badge tone="neutral" className="ml-2">
                            Already on version
                          </Badge>
                        )}
                        {!isEligibleState(d) && (
                          <Badge tone="neutral" className="ml-2">
                            Not activated
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-on-surface-variant">{relative(d.last_heartbeat_at)}</Td>
                      <Td className="font-mono text-on-surface-variant">{num(d.pending_events)}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <div className="px-space-md py-space-sm bg-surface-container-lowest/80 font-label-sm text-label-sm text-outline flex flex-wrap justify-between gap-2">
            <span>
              {num(filtered.length)} shown • {num(filteredSelectable.length)} selectable • {num(selected.size)} selected
            </span>
            {(devicesQ.data?.total ?? 0) > devices.length && (
              <span>
                Showing the first {num(devices.length)} of {num(devicesQ.data?.total)} devices
              </span>
            )}
          </div>
        </Panel>
      )}

      {/* Step 3 — review */}
      {step === 2 && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-md">
          <div className="xl:col-span-8 min-w-0">
            <Panel title="Review deployment" icon="fact_check" subtitle="Checked by the server against the current device state" bodyClassName="px-0 pb-0">
              {reviewQ.isLoading ? (
                <Loading label="Checking selected devices…" />
              ) : reviewQ.error ? (
                <ErrorState error={reviewQ.error} onRetry={() => reviewQ.refetch()} />
              ) : review ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm px-space-md pb-space-md">
                    <ReviewStat label="Will be updated" value={review.eligible.length} tone="text-tertiary" icon="system_update" />
                    <ReviewStat label="Already on version" value={review.alreadyOnVersion.length} tone="text-outline" icon="done_all" />
                    <ReviewStat label="Not eligible" value={review.notEligible} tone={review.notEligible ? 'text-warning' : 'text-outline'} icon="block" />
                  </div>
                  {review.eligible.some((d: any) => !d.online) && (
                    <div className="mx-space-md mb-space-md p-space-sm bg-secondary-container/10 rounded flex items-start gap-2 text-body-sm text-on-surface-variant">
                      <Icon name="cloud_off" className="text-secondary text-[18px] shrink-0" />
                      <span>
                        {num(review.eligible.filter((d: any) => !d.online).length)} selected devices are offline. They will receive the update when they reconnect.
                      </span>
                    </div>
                  )}
                  {review.eligible.length ? (
                    <Table>
                      <THead>
                        <tr>
                          <Th>Device</Th>
                          <Th>Location</Th>
                          <Th>Upgrade</Th>
                          <Th>Connection</Th>
                        </tr>
                      </THead>
                      <tbody>
                        {review.eligible.map((d: any) => (
                          <Tr key={d.id}>
                            <Td className="font-semibold text-on-surface">{d.name}</Td>
                            <Td className="text-on-surface-variant">{d.location ?? 'Unassigned'}</Td>
                            <Td className="font-mono">
                              <span className="text-outline">{d.from ?? 'unknown'}</span>
                              <Icon name="arrow_forward" className="text-[14px] text-outline mx-1 align-middle" />
                              <span className="text-on-surface">{review.firmware.version}</span>
                            </Td>
                            <Td>
                              {d.online ? (
                                <Badge tone="success">Online</Badge>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <Badge tone="error">Offline</Badge>
                                  <span className="font-label-sm text-label-sm text-outline">on reconnect</span>
                                </span>
                              )}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <Empty icon="block" title="No eligible devices." description="All selected devices already run this version or are not activated. Go back and change the selection." />
                  )}
                  {review.alreadyOnVersion.length > 0 && (
                    <div className="px-space-md py-space-sm border-t border-outline-variant/20 text-body-sm text-on-surface-variant">
                      <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider mr-2">Skipped (already on {review.firmware.version})</span>
                      {review.alreadyOnVersion.join(', ')}
                    </div>
                  )}
                </>
              ) : null}
            </Panel>
          </div>
          <div className="xl:col-span-4 flex flex-col gap-space-md min-w-0">
            <SideToggle id="firmware-deploy-side" label="Deployment" />
            <Panel title="Deployment" icon="alt_route">
              <div className="flex flex-col gap-space-md">
                <Field label="Deployment name" required error={name && !nameOk ? 'Between 2 and 120 characters.' : null}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                </Field>
                {fw && (
                  <div>
                    <KV label="Version" mono>
                      {fw.version}
                    </KV>
                    <KV label="Channel">
                      <ChannelBadge channel={fw.channel} />
                    </KV>
                    <KV label="Size">{bytes(Number(fw.size_bytes))}</KV>
                    <KV label="SHA-256" mono>
                      <span title={fw.sha256}>{shortSha(fw.sha256)}</span>
                    </KV>
                    <KV label="Devices selected" mono>
                      {num(selected.size)}
                    </KV>
                  </div>
                )}
                <Button
                  variant="primary"
                  size="lg"
                  icon="rocket_launch"
                  disabled={!nameOk || !review || !review.eligible.length}
                  loading={deploy.isPending}
                  onClick={() => {
                    setStep(3);
                    deploy.mutate(undefined, { onError: () => setStep(2) });
                  }}
                >
                  Deploy to {num(review?.eligible.length ?? 0)} devices
                </Button>
                <p className="font-label-sm text-label-sm text-outline">If installation fails, the device remains on its previous firmware and can be retried or rolled back.</p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {step === 3 && (
        <Panel>
          <Loading label="Starting deployment…" />
        </Panel>
      )}

      {/* Navigation */}
      {step < 3 && (
        <div className="flex items-center justify-between gap-space-sm">
          <Button variant="ghost" icon="arrow_back" onClick={() => (step === 0 ? nav('/firmware') : setStep(step - 1))}>
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          {step < 2 && (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next: {STEPS[step + 1]!.label}
              <Icon name="arrow_forward" className="text-[15px]" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewStat({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: string }) {
  return (
    <div className="p-space-sm bg-surface-container rounded">
      <div className="flex items-center justify-between font-label-sm text-label-sm text-outline uppercase tracking-wider">
        <span>{label}</span>
        <Icon name={icon} className={clsx('text-[16px]', tone)} />
      </div>
      <div className={clsx('font-headline-md text-headline-md font-mono', tone)}>{num(value)}</div>
    </div>
  );
}
