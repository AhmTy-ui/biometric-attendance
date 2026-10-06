import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
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
  PageHeader,
  Select,
  useErrorToast,
  useToast, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, num, relative } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { ActivationCodeCard, DeviceStatusBadge, LIFECYCLE_INFO, LifecycleStepper, RosterVersion, useNow, type IssuedCredentials } from './components';

/**
 * Add / Provision device (user flow §13): Enter Device ID → Select Location → Generate credentials →
 * Verify device → Activate → Device online. Device states: Pending → Provisioned → Connected → Active.
 * Resumable for an existing device via ?deviceId=.
 */
type StepKey = 'identity' | 'location' | 'credentials' | 'verify' | 'activate' | 'online';
const STEPS: { key: StepKey; label: string; icon: string }[] = [
  { key: 'identity', label: 'Enter Device ID', icon: 'badge' },
  { key: 'location', label: 'Select Location', icon: 'location_on' },
  { key: 'credentials', label: 'Generate Credentials', icon: 'key' },
  { key: 'verify', label: 'Verify Device', icon: 'wifi_find' },
  { key: 'activate', label: 'Activate', icon: 'verified' },
  { key: 'online', label: 'Device Online', icon: 'check_circle' }
];

interface DeviceDetail {
  device: any;
  sync: { latestRosterVersion: number; latestTemplateVersion: number; rosterUpToDate: boolean; templatesUpToDate: boolean };
  commands: any[];
  heartbeats: any[];
  alerts: any[];
  firmware: any[];
  last24h: any;
  policies: any;
}

const isVerified = (d: any) => Boolean(d && ((d.lifecycle_state === 'connected' && d.last_heartbeat_at) || d.lifecycle_state === 'active'));

function stepFor(d: any): StepKey {
  switch (d.lifecycle_state) {
    case 'pending':
      return 'credentials';
    case 'provisioned':
      return 'credentials';
    case 'connected':
      return d.last_heartbeat_at ? 'activate' : 'verify';
    case 'active':
      return 'online';
    default:
      return 'credentials';
  }
}

export default function DeviceProvisioning() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const [params, setParams] = useSearchParams();
  const deviceId = params.get('deviceId');
  const [globalLoc] = useGlobalLocation();

  const [step, setStep] = useState<StepKey>(deviceId ? 'credentials' : 'identity');
  const [form, setForm] = useState({ deviceUid: '', name: '', model: '', serialNumber: '' });
  const [locationId, setLocationId] = useState(globalLoc ?? '');
  const [formErr, setFormErr] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<IssuedCredentials | null>(null);
  const [confirmNewCode, setConfirmNewCode] = useState(false);
  const [resumed, setResumed] = useState(false);
  useNow(5000);

  const deviceQ = useQuery({
    queryKey: ['device', deviceId],
    queryFn: () => api.get<DeviceDetail>(`/api/devices/${deviceId}`),
    enabled: Boolean(deviceId),
    refetchInterval: step === 'verify' || step === 'activate' ? 5000 : false
  });
  const device = deviceQ.data?.device;

  const locations = useQuery({
    queryKey: ['locations', 'options'],
    queryFn: () => api.get<any[]>('/api/locations'),
    enabled: can('locations.view'),
    staleTime: 60_000
  });

  // Resume: pick the first incomplete step from the device's lifecycle state.
  useEffect(() => {
    if (device && !resumed) {
      setStep(stepFor(device));
      setResumed(true);
    }
  }, [device, resumed]);

  // Live: device/status frames for this device (activation, first heartbeat).
  useLiveEvents('device/status', (f) => {
    const d = f.data;
    if (!deviceId || d?.id !== deviceId) return;
    const { locationId: _l, ...rest } = d;
    qc.setQueryData<DeviceDetail>(['device', deviceId], (old) => (old ? { ...old, device: { ...old.device, ...rest } } : old));
  });

  // Auto-advance once verified.
  useEffect(() => {
    if (step === 'verify' && isVerified(device)) {
      toast({ tone: 'success', title: 'Device verified', description: `${device.name} activated its credentials and sent its first heartbeat.` });
      setStep(device.lifecycle_state === 'active' ? 'online' : 'activate');
    }
  }, [step, device, toast]);

  const create = useMutation({
    mutationFn: () =>
      api.post<any>('/api/devices', {
        deviceUid: form.deviceUid.trim(),
        name: form.name.trim(),
        locationId,
        model: form.model.trim() || undefined,
        serialNumber: form.serialNumber.trim() || undefined
      }),
    onSuccess: (row) => {
      toast({ tone: 'success', title: 'Device registered', description: `${row.name} (${row.device_uid}) is Pending. Generate its activation code next.` });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      setResumed(true);
      setParams({ deviceId: row.id }, { replace: true });
      setStep('credentials');
    },
    onError: (e) => errToast(e, 'Could not register device')
  });

  const issue = useMutation({
    mutationFn: () => api.post<IssuedCredentials>(`/api/devices/${deviceId}/credentials`),
    onSuccess: (c) => {
      setCreds(c);
      setConfirmNewCode(false);
      void qc.invalidateQueries({ queryKey: ['device', deviceId] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => errToast(e, 'Could not generate credentials')
  });

  const activate = useMutation({
    mutationFn: () => api.post(`/api/devices/${deviceId}/activate`),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Device activated', description: 'Configuration and roster sync were sent to the device.' });
      void qc.invalidateQueries({ queryKey: ['device', deviceId] });
      void qc.invalidateQueries({ queryKey: ['devices'] });
      setStep('online');
    },
    onError: (e) => errToast(e, 'Activation failed')
  });

  const validateIdentity = () => {
    const e: Record<string, string> = {};
    const uid = form.deviceUid.trim();
    if (uid.length < 3 || uid.length > 64) e.deviceUid = 'Device ID must be 3–64 characters.';
    else if (!/^[A-Za-z0-9_-]+$/.test(uid)) e.deviceUid = 'Letters, digits, dash and underscore only.';
    if (form.name.trim().length < 2) e.name = 'Give the device a name (at least 2 characters).';
    setFormErr(e);
    return Object.keys(e).length === 0;
  };

  const reset = () => {
    setParams({}, { replace: true });
    setForm({ deviceUid: '', name: '', model: '', serialNumber: '' });
    setCreds(null);
    setResumed(false);
    setStep('identity');
  };

  const selectedLoc = (locations.data ?? []).find((l) => l.id === (device?.location_id ?? locationId));
  const stepIdx = STEPS.findIndex((s) => s.key === step);

  if (deviceId && deviceQ.isLoading) return <Loading label="Loading device…" className="min-h-[50vh]" />;
  if (deviceId && deviceQ.error && !deviceQ.data) return <ErrorState error={deviceQ.error} onRetry={() => deviceQ.refetch()} />;

  return (
    <div className="p-gutter space-y-space-md">
      <PageHeader
        icon="add_circle"
        crumbs={[{ label: 'Devices', to: '/devices' }, { label: 'Add / Provision device' }]}
        title="Add / Provision Device"
        subtitle="Register a fingerprint terminal, issue its one-time activation code, verify it connects, then activate it."
        actions={
          <>
            {device && step !== 'online' && (
              <LinkButton to={`/devices/${device.id}`} icon="router">
                View device
              </LinkButton>
            )}
            {deviceId && step !== 'online' && (
              <Button icon="add" onClick={reset}>
                Provision another
              </Button>
            )}
            <LinkButton to="/devices" icon="close" variant="ghost">
              Exit
            </LinkButton>
          </>
        }
      />

      {/* Stepper */}
      <div className="card rounded-xl p-space-md">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-space-sm">
          {STEPS.map((s, i) => {
            const done = i < stepIdx || (s.key === 'online' && step === 'online');
            const current = i === stepIdx && s.key !== 'online';
            return (
              <div
                key={s.key}
                className={clsx(
                  'flex items-center gap-space-sm p-space-sm rounded-lg relative overflow-hidden',
                  current ? 'bg-surface-container-high shadow-md' : done ? 'bg-surface-container' : 'bg-surface-container-lowest opacity-70'
                )}
              >
                {current && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />}
                <div className={clsx('relative w-8 h-8 rounded-full flex items-center justify-center shrink-0', done ? 'bg-tertiary/20' : current ? 'bg-primary-container/30' : 'bg-surface-container-highest')}>
                  {current && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-40" />}
                  {done ? (
                    <Icon name="check" className="text-[18px] text-tertiary" />
                  ) : current ? (
                    <Icon name={s.icon} className="text-[18px] text-primary" />
                  ) : (
                    <span className="font-label-sm text-label-sm text-on-surface-variant font-mono">{String(i + 1).padStart(2, '0')}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <span className={clsx('font-label-sm text-label-sm font-mono block leading-none', done ? 'text-tertiary' : current ? 'text-primary' : 'text-on-surface-variant')}>
                    STEP {String(i + 1).padStart(2, '0')} // {done ? 'DONE' : current ? 'IN PROGRESS' : 'PENDING'}
                  </span>
                  <span className={clsx('text-body-sm truncate block mt-1', current ? 'text-on-surface font-semibold' : done ? 'text-on-surface font-medium' : 'text-on-surface-variant')}>{s.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {device?.lifecycle_state === 'decommissioned' ? (
        <Empty icon="block" title="This device is decommissioned." description="Decommissioned devices cannot be provisioned again. Register the terminal under a new device ID." action={<Button icon="add" onClick={reset}>Provision a new device</Button>} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md">
          <div className="lg:col-span-8 space-y-space-md">
            {/* ── Step 1: identity ── */}
            {step === 'identity' && (
              <Card icon="developer_board" title="Terminal identification" subtitle="The device ID is the identity configured on the terminal at manufacture (shown on its label / setup screen).">
                <form
                  id="identity"
                  className="grid grid-cols-1 md:grid-cols-2 gap-space-md"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (validateIdentity()) setStep('location');
                  }}
                >
                  <Field label="Device ID" required error={formErr.deviceUid} hint="Letters, digits, dash, underscore">
                    <Input value={form.deviceUid} onChange={(e) => setForm({ ...form, deviceUid: e.target.value })} className="font-mono" maxLength={64} autoFocus />
                  </Field>
                  <Field label="Device name" required error={formErr.name} hint="How it appears in the dashboard, e.g. the entrance it serves">
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
                  </Field>
                  <Field label="Model" hint="Optional — reported by the terminal on activation if left blank">
                    <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} maxLength={64} />
                  </Field>
                  <Field label="Serial number" hint="Optional">
                    <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className="font-mono" maxLength={64} />
                  </Field>
                </form>
                <Footer>
                  <Button type="submit" form="identity" variant="primary" icon="arrow_forward">
                    Continue
                  </Button>
                </Footer>
              </Card>
            )}

            {/* ── Step 2: location ── */}
            {step === 'location' && (
              <Card icon="hub" title="Assign location" subtitle="The device receives the employee roster of this location and records attendance in its time zone.">
                {!can('locations.view') ? (
                  <p className="text-body-sm text-error">You need permission to view locations to assign one.</p>
                ) : locations.isLoading ? (
                  <Loading label="Loading locations…" />
                ) : locations.error ? (
                  <ErrorState error={locations.error} onRetry={() => locations.refetch()} compact />
                ) : (locations.data ?? []).length === 0 ? (
                  <Empty icon="location_off" title="No locations yet." description="Create a location (or import them from the web software) before provisioning devices." action={<LinkButton to="/locations">Locations</LinkButton>} />
                ) : (
                  <div className="space-y-space-md">
                    <Field label="Location" required>
                      <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                        <option value="">Select a location…</option>
                        {(locations.data ?? []).map((l) => (
                          <option key={l.id} value={l.id} disabled={!l.is_active}>
                            {l.name} ({l.code}){l.is_active ? '' : ' — inactive'}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {selectedLoc && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm">
                        <Tile label="Time zone" value={selectedLoc.timezone} />
                        <Tile label="Active employees" value={num(selectedLoc.active_employees)} hint="Roster pushed to the device" />
                        <Tile label="Devices" value={num(selectedLoc.devices)} hint={`${num(selectedLoc.online_devices)} online`} />
                        <Tile label="Working hours" value={`${String(selectedLoc.work_start ?? '').slice(0, 5)}–${String(selectedLoc.work_end ?? '').slice(0, 5)}`} />
                      </div>
                    )}
                  </div>
                )}
                <Footer>
                  <Button variant="ghost" icon="arrow_back" onClick={() => setStep('identity')}>
                    Back
                  </Button>
                  <Button variant="primary" icon="app_registration" disabled={!locationId} loading={create.isPending} onClick={() => create.mutate()}>
                    Register device
                  </Button>
                </Footer>
              </Card>
            )}

            {/* ── Step 3: credentials ── */}
            {step === 'credentials' && device && (
              <Card
                icon="key"
                title="Generate / assign credentials"
                subtitle="A one-time activation code (valid 72 hours). On activation the terminal receives its HMAC request-signing secret and its own MQTT identity."
              >
                {creds ? (
                  <>
                    <ActivationCodeCard creds={creds} />
                    <Footer>
                      <Button variant="ghost" icon="autorenew" onClick={() => setConfirmNewCode(true)}>
                        Issue a new code
                      </Button>
                      <Button variant="primary" icon="arrow_forward" onClick={() => setStep('verify')}>
                        I've entered the code — verify device
                      </Button>
                    </Footer>
                  </>
                ) : device.lifecycle_state === 'provisioned' ? (
                  <>
                    <div className="p-space-md rounded-lg bg-surface-container flex items-start gap-space-sm">
                      <Icon name="key" className="text-secondary text-[22px] shrink-0" />
                      <div className="space-y-1">
                        <div className="font-headline-sm text-headline-sm text-on-surface">An activation code was already issued</div>
                        <p className="text-body-sm text-on-surface-variant">
                          Codes are shown only once and are stored as a hash.{' '}
                          {device.activation_expires_at &&
                            (new Date(device.activation_expires_at).getTime() < Date.now() ? (
                              <span className="text-error">It expired {relative(device.activation_expires_at)}.</span>
                            ) : (
                              <>It expires {relative(device.activation_expires_at)} ({dateTime(device.activation_expires_at)}).</>
                            ))}{' '}
                          If the code was entered on the terminal, continue to verification; otherwise issue a new code (the previous one stops working).
                        </p>
                      </div>
                    </div>
                    <Footer>
                      <Button icon="autorenew" onClick={() => setConfirmNewCode(true)}>
                        Issue a new code
                      </Button>
                      <Button variant="primary" icon="arrow_forward" onClick={() => setStep('verify')}>
                        Continue to verification
                      </Button>
                    </Footer>
                  </>
                ) : device.lifecycle_state === 'pending' ? (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-space-sm">
                      <Explainer icon="password" title="1 · Activation code" text="A random single-use code, stored hashed, valid 72 hours." />
                      <Explainer icon="key" title="2 · Device secret" text="On activation the terminal receives an HMAC secret used to sign every HTTPS request (timestamp + nonce, replay-protected)." />
                      <Explainer icon="hub" title="3 · MQTT identity" text="A per-device broker login restricted to this device's topics, for heartbeats, live events and commands." />
                    </div>
                    <Footer>
                      <Button variant="primary" icon="key" loading={issue.isPending} onClick={() => issue.mutate()}>
                        Generate activation code
                      </Button>
                    </Footer>
                  </>
                ) : (
                  <>
                    <p className="text-body-sm text-on-surface-variant">
                      Credentials are already active on this device (state: {LIFECYCLE_INFO[device.lifecycle_state]?.label}).
                    </p>
                    <Footer>
                      <Button variant="primary" icon="arrow_forward" onClick={() => setStep(stepFor(device))}>
                        Continue
                      </Button>
                    </Footer>
                  </>
                )}
              </Card>
            )}

            {/* ── Step 4: verify ── */}
            {step === 'verify' && device && (
              <Card icon="wifi_find" title="Verify device" subtitle="Waiting for the terminal to activate its credentials, connect to the broker and send its first heartbeat.">
                <div className="flex flex-col items-center text-center gap-space-sm py-space-md">
                  <div className="relative h-20 w-20 rounded-full bg-surface-container-highest flex items-center justify-center">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-20" />
                    <Icon name="sensors" className="text-[40px] text-secondary" />
                  </div>
                  <div className="font-headline-sm text-headline-sm text-on-surface">Listening for {device.device_uid}…</div>
                  <p className="text-body-sm text-outline">Live updates are on; the status is also re-checked every 5 seconds{deviceQ.dataUpdatedAt ? ` (last check ${relative(new Date(deviceQ.dataUpdatedAt))})` : ''}.</p>
                </div>
                <div className="space-y-space-xs">
                  <Check done={['connected', 'active'].includes(device.lifecycle_state)} label="Activation code accepted" detail={device.credential_issued_at ? `Credentials delivered ${relative(device.credential_issued_at)}${device.last_seen_ip ? ` · from ${device.last_seen_ip}` : ''}` : 'Waiting for the terminal to call the activation endpoint'} />
                  <Check done={Boolean(device.last_heartbeat_at)} label="Connected and first heartbeat received" detail={device.last_heartbeat_at ? `Last heartbeat ${relative(device.last_heartbeat_at)}` : 'Waiting for the MQTT connection / first heartbeat'} />
                  <Check done={Boolean(device.firmware_version)} label="Device reported its firmware" detail={device.firmware_version ? `Firmware ${device.firmware_version}${device.model ? ` · ${device.model}` : ''}${device.serial_number ? ` · SN ${device.serial_number}` : ''}` : 'Reported with activation or the first heartbeat'} />
                </div>
                {device.lifecycle_state === 'provisioned' && device.activation_expires_at && new Date(device.activation_expires_at).getTime() < Date.now() && (
                  <div className="mt-space-sm p-space-sm rounded bg-error-container/30 text-body-sm text-on-error-container flex items-center gap-2">
                    <Icon name="timer_off" className="text-[16px]" />
                    The activation code expired {relative(device.activation_expires_at)}. Issue a new code.
                  </div>
                )}
                <div className="mt-space-sm p-space-sm rounded bg-surface-container-lowest text-body-sm text-on-surface-variant">
                  <span className="text-on-surface font-medium">Not connecting?</span> Check the terminal has network access to the platform over HTTPS and to the MQTT broker, that its clock is correct (signed requests must be within the allowed time window) and that the code was typed exactly. The terminal logs its activation attempts on its own screen/console.
                </div>
                <Footer>
                  <Button variant="ghost" icon="arrow_back" onClick={() => setStep('credentials')}>
                    Back to credentials
                  </Button>
                  <Button icon="refresh" onClick={() => deviceQ.refetch()} loading={deviceQ.isFetching}>
                    Check now
                  </Button>
                </Footer>
              </Card>
            )}

            {/* ── Step 5: activate ── */}
            {step === 'activate' && device && (
              <Card icon="verified" title="Activate device" subtitle="Activation lets the device capture attendance and enrolments for its location, and pushes its configuration and roster.">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                  <div>
                    <KV label="Device">{device.name}</KV>
                    <KV label="Device ID" mono>
                      {device.device_uid}
                    </KV>
                    <KV label="Location">{device.location_name ?? 'Unassigned'}</KV>
                    <KV label="Model">{device.model ?? '—'}</KV>
                    <KV label="Serial" mono>
                      {device.serial_number ?? '—'}
                    </KV>
                  </div>
                  <div>
                    <KV label="Status">
                      <DeviceStatusBadge device={device} />
                    </KV>
                    <KV label="Last heartbeat">{device.last_heartbeat_at ? relative(device.last_heartbeat_at) : 'never'}</KV>
                    <KV label="Firmware" mono>
                      {device.firmware_version ?? '—'}
                    </KV>
                    <KV label="IP address" mono>
                      {device.last_seen_ip ?? '—'}
                    </KV>
                    <KV label="Roster size">{num(device.roster_size ?? 0)} employee(s)</KV>
                  </div>
                </div>
                {!device.last_heartbeat_at && (
                  <div className="mt-space-sm p-space-sm rounded bg-warning-container/40 text-warning text-body-sm flex items-center gap-2">
                    <Icon name="hourglass_top" className="text-[16px]" />
                    Waiting for the first heartbeat before the device can be activated.
                  </div>
                )}
                <Footer>
                  <Button variant="ghost" icon="arrow_back" onClick={() => setStep('verify')}>
                    Back
                  </Button>
                  <Button variant="primary" icon="verified" disabled={!isVerified(device)} loading={activate.isPending} onClick={() => activate.mutate()}>
                    Activate device
                  </Button>
                </Footer>
              </Card>
            )}

            {/* ── Step 6: online ── */}
            {step === 'online' && device && (
              <Card icon="check_circle" title="Device online" subtitle="Provisioning complete.">
                <div className="flex flex-col items-center text-center gap-space-sm py-space-md">
                  <div className="h-16 w-16 rounded-full bg-tertiary/20 flex items-center justify-center">
                    <Icon name="verified" className="text-[36px] text-tertiary" fill />
                  </div>
                  <div className="font-headline-md text-headline-md text-on-surface">{device.name} is {LIFECYCLE_INFO[device.lifecycle_state]?.label ?? device.lifecycle_state}</div>
                  <DeviceStatusBadge device={device} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
                  <div>
                    <KV label="Location">{device.location_name ?? 'Unassigned'}</KV>
                    <KV label="Activated">{dateTime(device.activated_at)}</KV>
                    <KV label="Last heartbeat">{device.last_heartbeat_at ? relative(device.last_heartbeat_at) : 'never'}</KV>
                  </div>
                  <div>
                    <KV label="Employee roster">
                      <RosterVersion device={device} latest={deviceQ.data?.sync.latestRosterVersion} />
                    </KV>
                    <KV label="Employees on roster">{num(device.roster_size ?? 0)}</KV>
                    <KV label="Firmware" mono>
                      {device.firmware_version ?? '—'}
                    </KV>
                  </div>
                </div>
                <p className="mt-space-sm text-body-sm text-on-surface-variant">
                  Next: supervisors can enrol employees' fingerprints at this terminal (supervisor fingerprint or PIN, select employee, capture two fingers).
                </p>
                <Footer>
                  <Button icon="add" onClick={reset}>
                    Provision another device
                  </Button>
                  {can('enrolment.view') && (
                    <LinkButton to={`/devices/enrolment?deviceId=${device.id}`} icon="fingerprint">
                      Enrolment monitor
                    </LinkButton>
                  )}
                  <LinkButton to={`/devices/${device.id}`} icon="router" variant="primary">
                    View device
                  </LinkButton>
                </Footer>
              </Card>
            )}
          </div>

          {/* Right column: checklist + lifecycle */}
          <div className="lg:col-span-4 space-y-space-md">
            <SideToggle id="provisioning-side" label="Checklist" />
            <Checklist device={device} form={form} locationName={selectedLoc?.name} creds={creds} />
            <div className="card rounded-xl p-space-md space-y-space-sm">
              <div className="flex items-center gap-space-sm">
                <Icon name="conversion_path" className="text-primary text-[20px]" />
                <h2 className="font-headline-sm text-headline-sm text-on-surface">Device state</h2>
              </div>
              <LifecycleStepper state={device?.lifecycle_state ?? 'pending'} compact className="!grid-cols-2" />
              <p className="text-body-sm text-on-surface-variant">{device ? LIFECYCLE_INFO[device.lifecycle_state]?.hint : 'Not registered yet.'}</p>
            </div>
            <div className="p-space-sm rounded-lg bg-surface-container-lowest flex items-start gap-space-xs">
              <Icon name="info" className="text-[16px] text-secondary shrink-0 mt-0.5" />
              <p className="font-body-sm text-body-sm text-on-surface-variant leading-tight">
                Every step is recorded in the <Link to="/audit" className="text-primary hover:underline">audit log</Link>. Credentials can be re-issued or the device decommissioned later from Device details → Actions.
              </p>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmNewCode}
        onClose={() => setConfirmNewCode(false)}
        title="Issue a new activation code?"
        message="The previous code stops working immediately. If the terminal already activated, its credentials are revoked and it must be activated again with the new code."
        confirmLabel="Issue new code"
        danger
        loading={issue.isPending}
        onConfirm={() => issue.mutate()}
      />
    </div>
  );
}

function Card({ icon, title, subtitle, children }: { icon: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="card rounded-xl p-space-md space-y-space-md">
      <div className="flex items-center gap-space-sm">
        <div className="p-2 rounded-lg bg-primary-container/20 text-primary">
          <Icon name={icon} className="text-[20px]" />
        </div>
        <div>
          <h2 className="font-headline-sm text-headline-sm text-on-surface">{title}</h2>
          {subtitle && <p className="font-body-sm text-body-sm text-on-surface-variant">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-space-xs pt-space-sm border-t border-outline-variant/20">{children}</div>;
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="bg-surface-container p-space-sm rounded-lg flex flex-col">
      <span className="font-label-sm text-label-sm text-on-surface-variant uppercase font-mono">{label}</span>
      <span className="text-label-lg text-on-surface font-mono font-semibold mt-1 break-words">{value}</span>
      {hint && <span className="font-label-sm text-label-sm text-outline mt-0.5">{hint}</span>}
    </div>
  );
}

function Explainer({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div className="bg-surface-container p-space-sm rounded-lg space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon name={icon} className="text-[16px] text-tertiary" />
        <span className="text-body-sm font-semibold text-on-surface">{title}</span>
      </div>
      <p className="text-body-sm text-on-surface-variant">{text}</p>
    </div>
  );
}

function Check({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <div className={clsx('flex items-start gap-space-sm p-space-sm rounded-lg', done ? 'bg-surface-container' : 'bg-surface-container-high')}>
      <Icon name={done ? 'check_circle' : 'progress_activity'} className={clsx('text-[20px] shrink-0 mt-0.5', done ? 'text-tertiary' : 'text-primary animate-spin')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-sm text-on-surface font-medium">{label}</span>
          <span className={clsx('font-label-sm text-label-sm font-mono', done ? 'text-tertiary' : 'text-primary')}>{done ? 'OK' : 'WAITING'}</span>
        </div>
        <p className="text-body-sm text-on-surface-variant mt-0.5">{detail}</p>
      </div>
    </div>
  );
}

function Checklist({ device, form, locationName, creds }: { device: any; form: { deviceUid: string; name: string }; locationName?: string; creds: IssuedCredentials | null }) {
  const items = useMemo(() => {
    const d = device;
    const credIssued = d && ['provisioned', 'connected', 'active'].includes(d.lifecycle_state);
    return [
      {
        label: 'Device registered',
        done: Boolean(d),
        detail: d ? `${d.name} · ${d.device_uid}` : form.deviceUid ? `${form.deviceUid} (not saved yet)` : 'Enter the device ID'
      },
      { label: 'Location assigned', done: Boolean(d?.location_id), detail: d?.location_name ?? locationName ?? 'Choose the branch' },
      {
        label: 'Activation code issued',
        done: Boolean(credIssued),
        detail: creds ? `Expires ${dateTime(creds.expiresAt)}` : d?.activation_expires_at ? `Expires ${dateTime(d.activation_expires_at)}` : credIssued ? 'Used by the terminal' : 'Pending'
      },
      { label: 'Credentials activated on terminal', done: Boolean(d && ['connected', 'active'].includes(d.lifecycle_state)), detail: d?.credential_issued_at ? dateTime(d.credential_issued_at) : 'HMAC secret + MQTT identity' },
      { label: 'First heartbeat received', done: Boolean(d?.last_heartbeat_at), detail: d?.last_heartbeat_at ? relative(d.last_heartbeat_at) : 'Waiting' },
      { label: 'Activated', done: d?.lifecycle_state === 'active', detail: d?.activated_at ? dateTime(d.activated_at) : 'Operator confirmation' }
    ];
  }, [device, form.deviceUid, locationName, creds]);
  const n = items.filter((i) => i.done).length;
  return (
    <div className="card rounded-xl p-space-md space-y-space-sm">
      <div className="flex items-center justify-between pb-space-xs">
        <div className="flex items-center gap-space-sm">
          <Icon name="fact_check" className="text-primary text-[20px]" />
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Provisioning checklist</h2>
        </div>
        <Badge tone={n === items.length ? 'success' : 'neutral'}>
          {n} / {items.length}
        </Badge>
      </div>
      <div className="space-y-space-xs">
        {items.map((i, idx) => {
          const current = !i.done && items.slice(0, idx).every((x) => x.done);
          return (
            <div key={i.label} className={clsx('flex items-start gap-space-sm p-space-sm rounded-lg', current ? 'bg-surface-container-high' : 'bg-surface-container', !i.done && !current && 'opacity-60')}>
              <Icon
                name={i.done ? 'check_circle' : current ? 'radio_button_checked' : 'radio_button_unchecked'}
                className={clsx('text-[20px] shrink-0 mt-0.5', i.done ? 'text-tertiary' : current ? 'text-primary animate-pulse' : 'text-on-surface-variant')}
              />
              <div className="min-w-0 flex-1">
                <span className={clsx('text-body-sm', current ? 'text-on-surface font-semibold' : 'text-on-surface font-medium')}>{i.label}</span>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5 break-words">{i.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
