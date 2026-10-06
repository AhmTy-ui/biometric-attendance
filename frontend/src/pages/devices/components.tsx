import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, CopyButton, Dot, Icon, LinkButton, deviceStatusLabel, deviceTone, type Tone } from '@/components/ui';
import { useLiveEvents } from '@/lib/live';
import { dateTime, num, relative } from '@/lib/format';

/**
 * Shared building blocks for the device pages (registry, details, provisioning, enrolment).
 * Exported for reuse by other pages (dashboard, location details, alerts).
 */

// ───────────────────────── Lifecycle ─────────────────────────
export const LIFECYCLE = ['pending', 'provisioned', 'connected', 'active'] as const;
export type LifecycleState = (typeof LIFECYCLE)[number] | 'decommissioned';

export const LIFECYCLE_INFO: Record<string, { label: string; icon: string; hint: string }> = {
  pending: { label: 'Pending', icon: 'pending', hint: 'Registered; no credentials issued yet' },
  provisioned: { label: 'Provisioned', icon: 'key', hint: 'Activation code issued; waiting for the terminal to activate' },
  connected: { label: 'Connected', icon: 'link', hint: 'Terminal activated its credentials and is reporting' },
  active: { label: 'Active', icon: 'verified', hint: 'Activated by an operator; capturing attendance and enrolments' },
  decommissioned: { label: 'Decommissioned', icon: 'block', hint: 'Credentials revoked; device retired' }
};

export const isOperational = (d: { lifecycle_state?: string } | null | undefined) => Boolean(d && ['connected', 'active'].includes(d.lifecycle_state ?? ''));
export const isOffline = (d: { lifecycle_state?: string; connectivity?: string } | null | undefined) => Boolean(d && isOperational(d) && d.connectivity === 'offline');

/** Pending → Provisioned → Connected → Active. */
export function LifecycleStepper({ state, compact, className }: { state: string; compact?: boolean; className?: string }) {
  const idx = LIFECYCLE.indexOf(state as (typeof LIFECYCLE)[number]);
  if (state === 'decommissioned') {
    return (
      <div className={clsx('flex items-center gap-2 p-space-sm rounded bg-surface-container-lowest text-on-surface-variant', className)}>
        <Icon name="block" className="text-[18px] text-error" />
        <span className="text-body-sm">This device has been decommissioned. Its credentials and MQTT identity are revoked.</span>
      </div>
    );
  }
  return (
    <div className={clsx('grid gap-space-xs', compact ? 'grid-cols-4' : 'grid-cols-2 md:grid-cols-4', className)}>
      {LIFECYCLE.map((s, i) => {
        const done = i < idx || (s === 'active' && idx === 3);
        const current = i === idx && s !== 'active';
        const info = LIFECYCLE_INFO[s]!;
        return (
          <div
            key={s}
            className={clsx(
              'flex items-center gap-space-sm rounded-lg relative overflow-hidden',
              compact ? 'p-1.5' : 'p-space-sm',
              current ? 'bg-surface-container-high shadow-md' : done ? 'bg-surface-container' : 'bg-surface-container-lowest opacity-70'
            )}
            title={info.hint}
          >
            {current && <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary" />}
            <div
              className={clsx(
                'relative rounded-full flex items-center justify-center shrink-0',
                compact ? 'w-6 h-6' : 'w-8 h-8',
                done ? 'bg-tertiary/20' : current ? 'bg-primary-container/30' : 'bg-surface-container-highest'
              )}
            >
              {current && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-30" />}
              {done ? (
                <Icon name="check" className={clsx('text-tertiary', compact ? 'text-[14px]' : 'text-[18px]')} />
              ) : current ? (
                <Icon name={info.icon} className={clsx('text-primary', compact ? 'text-[14px]' : 'text-[18px]')} />
              ) : (
                <span className="font-label-sm text-label-sm text-on-surface-variant font-mono">{String(i + 1).padStart(2, '0')}</span>
              )}
            </div>
            <div className="min-w-0">
              {!compact && (
                <span className={clsx('font-label-sm text-label-sm font-mono block leading-none uppercase', done ? 'text-tertiary' : current ? 'text-primary' : 'text-on-surface-variant')}>
                  Step {String(i + 1).padStart(2, '0')} · {done ? 'Done' : current ? 'Current' : 'Pending'}
                </span>
              )}
              <span className={clsx('block truncate text-body-sm', !compact && 'mt-1', done || current ? 'text-on-surface font-medium' : 'text-on-surface-variant')}>{info.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────── Status ─────────────────────────
export function DeviceStatusBadge({ device, className }: { device: { lifecycle_state?: string; connectivity?: string; health?: string }; className?: string }) {
  const tone = deviceTone(device);
  const icon =
    device.lifecycle_state === 'decommissioned'
      ? 'block'
      : !isOperational(device)
        ? 'hourglass_top'
        : device.connectivity === 'offline'
          ? 'cloud_off'
          : device.health === 'warning' || device.health === 'critical'
            ? 'warning'
            : 'wifi';
  return (
    <Badge tone={tone} icon={icon} className={className}>
      {deviceStatusLabel(device)}
    </Badge>
  );
}

/** Coloured dot + name used in list rows. */
export function DeviceDot({ device }: { device: { lifecycle_state?: string; connectivity?: string; health?: string } }) {
  const tone = deviceTone(device);
  return <Dot tone={tone} pulse={isOffline(device)} />;
}

/** Re-render every `ms` so relative timestamps stay fresh. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function Heartbeat({ at, offline }: { at?: string | null; offline?: boolean }) {
  useNow();
  return (
    <span className={clsx('flex items-center gap-1 font-label-sm text-label-sm', offline ? 'text-error' : at ? 'text-on-surface-variant' : 'text-outline')} title={at ? dateTime(at) : 'No heartbeat received yet'}>
      <Icon name={offline ? 'heart_broken' : 'monitor_heart'} className="text-[13px]" />
      {at ? relative(at) : 'never'}
    </span>
  );
}

// ───────────────────────── Storage ─────────────────────────
export function storageTone(pct: number | null | undefined, warnPct?: number, critPct?: number): Tone {
  if (pct === null || pct === undefined) return 'neutral';
  if (critPct !== undefined && pct >= critPct) return 'error';
  if (warnPct !== undefined && pct >= warnPct) return 'warning';
  if (warnPct === undefined && critPct === undefined) return 'info';
  return 'success';
}

const barCls: Record<Tone, string> = {
  success: 'bg-tertiary',
  info: 'bg-secondary',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-outline',
  primary: 'bg-primary'
};
const textCls: Record<Tone, string> = {
  success: 'text-on-surface-variant',
  info: 'text-on-surface-variant',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-outline',
  primary: 'text-primary'
};

/**
 * Storage bar (template "NVRAM Storage" cell). Thresholds come from Settings → Device policies; when the caller
 * doesn't have them, `health` from the device is used to colour a device the server already flagged.
 */
export function StorageBar({
  pct,
  capacity,
  warnPct,
  critPct,
  health,
  className
}: {
  pct: number | string | null | undefined;
  capacity?: number | null;
  warnPct?: number;
  critPct?: number;
  health?: string;
  className?: string;
}) {
  if (pct === null || pct === undefined || pct === '') return <span className="font-label-sm text-label-sm text-outline">Not reported</span>;
  const v = Number(pct);
  let tone = storageTone(v, warnPct, critPct);
  if (warnPct === undefined && critPct === undefined) tone = health === 'critical' ? 'error' : health === 'warning' ? 'warning' : 'success';
  const used = capacity ? Math.round((v / 100) * capacity) : null;
  return (
    <div className={clsx('flex flex-col gap-1 w-28', className)}>
      <div className="flex justify-between font-label-sm text-label-sm">
        <span className={clsx('font-mono', textCls[tone], tone === 'error' && 'font-semibold')}>
          {v.toFixed(0)}%{tone === 'error' ? ' CRIT' : tone === 'warning' ? ' WARN' : ''}
        </span>
        {capacity ? <span className="text-outline font-mono">{compactNum(used ?? 0)}/{compactNum(capacity)}</span> : null}
      </div>
      <div className="w-full bg-surface-container-lowest h-1.5 rounded overflow-hidden">
        <div className={clsx('h-full rounded', barCls[tone])} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </div>
    </div>
  );
}

export function compactNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Semi-circular storage gauge for the device overview. */
export function StorageGauge({ pct, warnPct, critPct, capacity, pending }: { pct: number | string | null | undefined; warnPct?: number; critPct?: number; capacity?: number | null; pending?: number }) {
  const has = pct !== null && pct !== undefined && pct !== '';
  const v = has ? Math.max(0, Math.min(100, Number(pct))) : 0;
  const tone = has ? storageTone(v, warnPct, critPct) : 'neutral';
  const stroke = { success: '#3ddc97', info: '#a5b0ff', warning: '#f5b84a', error: '#ff7a7a', neutral: '#262a31', primary: '#5cc8ff' }[tone];
  const r = 52;
  const len = Math.PI * r;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 128 72" className="w-44 h-auto">
        <path d={`M 12 64 A ${r} ${r} 0 0 1 116 64`} fill="none" stroke="#24272e" strokeWidth="10" strokeLinecap="round" />
        {has && <path d={`M 12 64 A ${r} ${r} 0 0 1 116 64`} fill="none" stroke={stroke} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(v / 100) * len} ${len}`} />}
        {warnPct !== undefined && <GaugeTick pct={warnPct} r={r} color="#f5b84a" />}
        {critPct !== undefined && <GaugeTick pct={critPct} r={r} color="#ff7a7a" />}
        <text x="64" y="58" textAnchor="middle" fontSize="18" fontWeight="600" fill="#ededf0" fontFamily='"JetBrains Mono Variable", monospace'>
          {has ? `${v.toFixed(1)}%` : '—'}
        </text>
      </svg>
      <div className="font-label-sm text-label-sm text-outline text-center">
        {has ? 'Local event storage used' : 'Storage not reported yet'}
        {capacity ? ` · capacity ${num(capacity)} events` : ''}
      </div>
      {pending !== undefined && (
        <div className={clsx('mt-1 font-label-sm text-label-sm', pending > 0 ? 'text-secondary' : 'text-outline')}>{num(pending)} event(s) awaiting upload</div>
      )}
      {(warnPct !== undefined || critPct !== undefined) && (
        <div className="mt-1 flex gap-space-sm font-label-sm text-label-sm text-outline">
          {warnPct !== undefined && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-warning" />
              warn {warnPct}%
            </span>
          )}
          {critPct !== undefined && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-error" />
              critical {critPct}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
function GaugeTick({ pct, r, color }: { pct: number; r: number; color: string }) {
  const a = Math.PI - (Math.max(0, Math.min(100, pct)) / 100) * Math.PI;
  const cx = 64;
  const cy = 64;
  const x1 = cx + (r - 8) * Math.cos(a);
  const y1 = cy - (r - 8) * Math.sin(a);
  const x2 = cx + (r + 8) * Math.cos(a);
  const y2 = cy - (r + 8) * Math.sin(a);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="2" />;
}

// ───────────────────────── Roster version ─────────────────────────
export function RosterVersion({ device, latest }: { device: { roster_version?: number | string | null }; latest?: number | string | null }) {
  const dv = Number(device.roster_version ?? 0);
  if (latest === null || latest === undefined) return <span className="font-mono text-body-sm">v{dv}</span>;
  const lv = Number(latest);
  const ok = dv >= lv;
  return (
    <div className="flex flex-col">
      <span className="font-label-sm text-label-sm text-on-surface font-mono">
        v{dv}
        <span className="text-outline"> / v{lv}</span>
      </span>
      <span className={clsx('font-label-sm text-label-sm flex items-center gap-1', ok ? 'text-tertiary' : 'text-warning')}>
        <Icon name={ok ? 'check_circle' : 'sync_problem'} className="text-[12px]" />
        {ok ? 'Up to date' : `Behind by ${num(lv - dv)} change(s)`}
      </span>
    </div>
  );
}

// ───────────────────────── Offline & storage cards (user flow §14, §15, §30) ─────────────────────────
/**
 * Offline device — what is happening (offline), where (location · device), is something wrong (buffered events,
 * employees affected), what can I do ([View device] [View location]).
 */
export function OfflineCard({ device, hideViewDevice, className }: { device: any; hideViewDevice?: boolean; className?: string }) {
  useNow();
  return (
    <div className={clsx('p-space-md rounded bg-surface-container shadow-md space-y-space-sm relative overflow-hidden', className)}>
      <div className="absolute top-0 left-0 right-0 h-1 bg-error" />
      <div className="flex items-start justify-between gap-space-sm">
        <div className="flex items-start gap-2 min-w-0">
          <Icon name="cloud_off" className="text-error text-[22px] shrink-0" />
          <div className="min-w-0">
            <span className="font-headline-sm text-headline-sm text-on-surface block truncate">Device offline</span>
            <span className="font-label-sm text-label-sm text-outline block truncate">
              {device.location_name ?? 'Unassigned'} · {device.name}
            </span>
          </div>
        </div>
        <Badge tone="error">{device.last_heartbeat_at ? `${relative(device.last_heartbeat_at).replace(' ago', '')} offline` : 'Never seen'}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-space-xs">
        <MiniStat label="Last seen" value={device.last_heartbeat_at ? relative(device.last_heartbeat_at) : 'never'} title={dateTime(device.last_heartbeat_at)} />
        <MiniStat label="Buffered events" value={num(device.pending_events ?? 0)} tone={(device.pending_events ?? 0) > 0 ? 'info' : undefined} />
        <MiniStat label="Employees affected" value={num(device.roster_size ?? 0)} />
      </div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        The terminal keeps verifying fingerprints against its local roster and stores events on the device. Buffered events upload automatically, oldest first, when the connection returns.
      </p>
      <div className="flex flex-wrap gap-space-xs">
        {!hideViewDevice && (
          <LinkButton to={`/devices/${device.id}`} icon="router" size="sm" variant="secondary">
            View device
          </LinkButton>
        )}
        {device.location_id && (
          <LinkButton to={`/locations/${device.location_id}`} icon="location_on" size="sm" variant="ghost">
            View location
          </LinkButton>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone, title }: { label: string; value: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className="p-2 rounded bg-surface-container-lowest min-w-0" title={title}>
      <span className="text-outline block text-[9px] uppercase tracking-wider truncate">{label}</span>
      <span className={clsx('font-mono font-semibold text-body-sm truncate block', tone === 'info' ? 'text-secondary' : tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-on-surface')}>
        {value}
      </span>
    </div>
  );
}

const POLICY_TEXT: Record<string, string> = {
  continue_capturing_alert: 'The device continues capturing (default policy). If storage fills, the oldest already-delivered records are recycled first.',
  preserve_oldest: 'Operator-confirmed policy preserves the oldest events: new captures will be refused when storage is full.'
};

/** Storage approaching capacity (user flow §15). */
export function StorageWarningCard({ device, policies, className, hideViewDevice }: { device: any; policies?: any; className?: string; hideViewDevice?: boolean }) {
  const pct = Number(device.storage_used_pct);
  const critical = policies?.storageCriticalPct !== undefined ? pct >= policies.storageCriticalPct : device.health === 'critical';
  return (
    <div className={clsx('p-space-md rounded bg-surface-container-high shadow-md flex flex-col lg:flex-row items-start lg:items-center justify-between gap-space-sm', className)}>
      <div className="flex items-start gap-space-sm min-w-0">
        <div className={clsx('w-8 h-8 rounded flex items-center justify-center shrink-0', critical ? 'bg-error-container/60 text-error' : 'bg-warning-container text-warning')}>
          <Icon name="sd_card_alert" className="text-[18px]" />
        </div>
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-space-xs flex-wrap">
            <span className="font-headline-sm text-headline-sm text-on-surface">Storage approaching capacity</span>
            <Badge tone={critical ? 'error' : 'warning'}>{critical ? 'Critical' : 'Warning'}</Badge>
          </div>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            <code className="font-label-sm text-label-sm text-secondary bg-surface-container px-1 py-0.5 rounded">{device.device_uid}</code> ({device.location_name ?? 'Unassigned'} · {device.name}) local event storage is{' '}
            <span className="text-on-surface font-semibold">{pct.toFixed(1)}%</span> full
            {device.storage_capacity_events ? ` (${num(Math.round((pct / 100) * device.storage_capacity_events))}/${num(device.storage_capacity_events)} events)` : ''} with {num(device.pending_events ?? 0)} event(s)
            awaiting upload.
          </p>
          {policies?.storageFullPolicy && <p className="font-body-sm text-body-sm text-outline mt-0.5">{POLICY_TEXT[policies.storageFullPolicy] ?? policies.storageFullPolicy}</p>}
          <p className="font-body-sm text-body-sm text-outline mt-0.5">Recommended: restore connectivity so buffered events upload, or review the storage policy in Settings → Device policies.</p>
        </div>
      </div>
      <div className="flex items-center gap-space-xs shrink-0 self-end lg:self-center">
        {!hideViewDevice && (
          <LinkButton to={`/devices/${device.id}`} size="sm" icon="router" variant="secondary">
            View device
          </LinkButton>
        )}
        <LinkButton to="/settings?tab=device_policies" size="sm" icon="tune" variant="ghost">
          Storage policy
        </LinkButton>
      </div>
    </div>
  );
}

// ───────────────────────── Reconciliation (buffered upload after reconnect) ─────────────────────────
export interface ReconcileState {
  restoredAt: number | null;
  uploaded: number;
  remaining: number;
  batches: number;
  complete: boolean;
  lastAt: number | null;
}

/**
 * Tracks live `device/reconcile` frames (and the offline → online transition from `device/status`) for one device.
 * Frames carry `{deviceId, uploaded, remaining, complete}` per uploaded batch.
 */
export function useReconcile(deviceId: string | undefined, connectivity?: string) {
  const [state, setState] = useState<ReconcileState | null>(null);
  const prevConn = useRef<string | undefined>(connectivity);
  useEffect(() => {
    if (prevConn.current === 'offline' && connectivity === 'online') {
      setState({ restoredAt: Date.now(), uploaded: 0, remaining: 0, batches: 0, complete: false, lastAt: null });
    }
    prevConn.current = connectivity;
  }, [connectivity]);
  useLiveEvents('device/reconcile', (f) => {
    const d = f.data;
    if (!deviceId || d?.deviceId !== deviceId) return;
    setState((prev) => {
      const base: ReconcileState = prev && !prev.complete ? prev : { restoredAt: prev?.restoredAt ?? null, uploaded: 0, remaining: 0, batches: 0, complete: false, lastAt: null };
      return {
        ...base,
        restoredAt: base.restoredAt ?? Date.now(),
        uploaded: base.uploaded + Number(d.uploaded ?? 0),
        remaining: Number(d.remaining ?? 0),
        batches: base.batches + 1,
        complete: Boolean(d.complete),
        lastAt: Date.now()
      };
    });
  });
  return [state, () => setState(null)] as const;
}

/** "Connection restored → Uploading buffered events → n/n uploaded → Reconciliation complete". */
export function ReconcileProgress({ state, onDismiss }: { state: ReconcileState; onDismiss?: () => void }) {
  const total = state.uploaded + state.remaining;
  const pct = total > 0 ? (state.uploaded / total) * 100 : state.complete ? 100 : 0;
  const steps = [
    { key: 'restored', label: 'Connection restored', done: true, active: false },
    { key: 'uploading', label: 'Uploading buffered events', done: state.batches > 0, active: state.batches === 0 && !state.complete },
    { key: 'count', label: total > 0 ? `${num(state.uploaded)}/${num(total)} uploaded` : 'Waiting for first batch', done: state.complete, active: state.batches > 0 && !state.complete },
    { key: 'complete', label: 'Reconciliation complete', done: state.complete, active: false }
  ];
  return (
    <div className="p-space-md rounded bg-surface-container shadow-md space-y-space-sm">
      <div className="flex items-center justify-between gap-space-sm">
        <div className="flex items-center gap-2">
          <Icon name={state.complete ? 'cloud_done' : 'cloud_sync'} className={clsx('text-[22px]', state.complete ? 'text-tertiary' : 'text-secondary')} />
          <div>
            <span className="font-headline-sm text-headline-sm text-on-surface block">{state.complete ? 'Reconciliation complete' : 'Reconciling buffered events'}</span>
            <span className="font-label-sm text-label-sm text-outline">
              {state.batches} batch(es) received{state.lastAt ? ` · last ${relative(new Date(state.lastAt))}` : ''}
            </span>
          </div>
        </div>
        {onDismiss && state.complete && (
          <button onClick={onDismiss} className="text-outline hover:text-on-surface" aria-label="Dismiss">
            <Icon name="close" className="text-[18px]" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-space-xs">
        {steps.map((s) => (
          <div key={s.key} className={clsx('flex items-center gap-1.5 p-2 rounded', s.done ? 'bg-surface-container-high' : 'bg-surface-container-lowest')}>
            <Icon
              name={s.done ? 'check_circle' : s.active ? 'progress_activity' : 'radio_button_unchecked'}
              className={clsx('text-[16px] shrink-0', s.done ? 'text-tertiary' : s.active ? 'text-secondary animate-spin' : 'text-outline')}
            />
            <span className={clsx('text-body-sm truncate', s.done || s.active ? 'text-on-surface' : 'text-outline')}>{s.label}</span>
          </div>
        ))}
      </div>
      <div className="w-full bg-surface-container-lowest h-1.5 rounded overflow-hidden">
        <div className={clsx('h-full rounded transition-all', state.complete ? 'bg-tertiary' : 'bg-secondary')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ───────────────────────── Commands ─────────────────────────
export const COMMANDS: Record<string, { label: string; icon: string; level: 'basic' | 'advanced'; description: string }> = {
  sync_roster: { label: 'Sync roster', icon: 'sync', level: 'basic', description: 'Pull the latest employee roster and fingerprint templates for this location.' },
  refresh_status: { label: 'Refresh status', icon: 'refresh', level: 'basic', description: 'Ask the device to send a heartbeat with its current health immediately.' },
  restart: { label: 'Restart', icon: 'restart_alt', level: 'advanced', description: 'Reboot the terminal. Buffered events are kept and upload after restart.' },
  send_config: { label: 'Send configuration', icon: 'settings_suggest', level: 'advanced', description: 'Push the device configuration and current device policies.' },
  rollback_firmware: { label: 'Roll back firmware', icon: 'history', level: 'advanced', description: 'Reinstall the previous firmware version kept on the device.' },
  update_firmware: { label: 'Update firmware', icon: 'system_update_alt', level: 'advanced', description: 'Tracked OTA deployment via Firmware → Deploy.' }
};

export const COMMAND_STATUS: Record<string, { label: string; tone: Tone; icon: string }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: 'schedule' },
  sent: { label: 'Sent', tone: 'info', icon: 'send' },
  acknowledged: { label: 'Acknowledged', tone: 'info', icon: 'done' },
  completed: { label: 'Completed', tone: 'success', icon: 'check_circle' },
  failed: { label: 'Failed', tone: 'error', icon: 'error' },
  expired: { label: 'Expired', tone: 'warning', icon: 'timer_off' }
};

export function CommandStatusBadge({ status }: { status: string }) {
  const s = COMMAND_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, icon: 'help' };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

// ───────────────────────── Enrolment sessions (user flow §10) ─────────────────────────
export const ENROLMENT_STATUS: Record<string, { label: string; tone: Tone; icon: string; message: string }> = {
  started: { label: 'In progress', tone: 'info', icon: 'play_circle', message: 'Supervisor authorised on the terminal; selecting the employee and capturing fingers.' },
  finger_captured: { label: 'Finger captured', tone: 'info', icon: 'fingerprint', message: 'A finger template was captured and uploaded; waiting for the next finger.' },
  completed: { label: 'Enrolled successfully', tone: 'success', icon: 'verified', message: 'All required fingers enrolled. Other devices at the location pull the new templates.' },
  failed_quality: { label: 'Quality too low', tone: 'warning', icon: 'blur_on', message: 'Fingerprint quality too low. Clean the sensor and finger, then retry the capture.' },
  employee_unavailable: { label: 'Employee unavailable', tone: 'error', icon: 'person_off', message: 'Employee is not on this device roster. Fix the record in the web software and sync.' },
  unauthorised: { label: 'Unauthorised', tone: 'error', icon: 'gpp_bad', message: 'The supervisor is not authorised to approve enrolment at this branch.' },
  aborted: { label: 'Aborted', tone: 'neutral', icon: 'cancel', message: 'Session cancelled on the terminal.' }
};

/** In-progress sessions not updated for 15 minutes are shown as abandoned. */
export function enrolmentStatusKey(s: { status: string; started_at?: string; finished_at?: string | null }) {
  if ((s.status === 'started' || s.status === 'finger_captured') && s.started_at && Date.now() - new Date(s.started_at).getTime() > 15 * 60_000) return 'stale';
  return s.status;
}

export function EnrolmentStatusBadge({ session }: { session: { status: string; started_at?: string; finished_at?: string | null } }) {
  const key = enrolmentStatusKey(session);
  if (key === 'stale')
    return (
      <Badge tone="neutral" icon="hourglass_disabled">
        Not finished
      </Badge>
    );
  const s = ENROLMENT_STATUS[key] ?? { label: key, tone: 'neutral' as Tone, icon: 'help' };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

// ───────────────────────── Activation code (shown ONCE) ─────────────────────────
export interface IssuedCredentials {
  deviceUid: string;
  activationCode: string;
  expiresAt: string;
  apiBaseUrl: string;
  mqttHost: string;
  mqttPort: number | string;
}

export function ActivationCodeCard({ creds }: { creds: IssuedCredentials }) {
  const cmd = `bamp-device activate --uid ${creds.deviceUid} --code ${creds.activationCode}`;
  return (
    <div className="space-y-space-md">
      <div className="p-space-md rounded-lg bg-surface-container-lowest border border-primary-container/40 flex flex-col items-center gap-space-sm text-center">
        <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider font-mono">One-time activation code</span>
        <span className="font-mono text-[28px] leading-9 font-semibold tracking-[0.2em] text-primary break-all select-all">{creds.activationCode}</span>
        <div className="flex items-center gap-space-xs flex-wrap justify-center">
          <CopyButton value={creds.activationCode} label="Copy code" />
          <span className="font-label-sm text-label-sm text-outline">
            Expires {dateTime(creds.expiresAt)} ({relative(creds.expiresAt)})
          </span>
        </div>
      </div>
      <div className="flex items-start gap-space-xs p-space-sm rounded bg-warning-container/40 text-warning">
        <Icon name="visibility_off" className="text-[16px] mt-0.5 shrink-0" />
        <p className="text-body-sm">
          This code is shown only once and is stored only as a hash. Copy it now. If it is lost or expires, issue a new one — the previous code stops working.
        </p>
      </div>
      <div className="space-y-space-xs">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold block">On the terminal</span>
        <ol className="list-decimal pl-5 space-y-1 text-body-sm text-on-surface-variant">
          <li>Power the terminal and connect it to the branch network.</li>
          <li>
            Enter the activation code on the terminal's setup screen, <span className="text-on-surface">or</span> run on the terminal console:
          </li>
        </ol>
        <div className="flex items-start gap-space-xs">
          <code className="flex-1 min-w-0 bg-surface-container-lowest rounded p-space-sm font-mono text-[12px] text-on-surface break-all">{cmd}</code>
          <CopyButton value={cmd} label="Copy" />
        </div>
        <p className="text-body-sm text-outline">
          The terminal exchanges the code over HTTPS for its HMAC request-signing secret and its own MQTT identity, then connects to the broker and sends its first heartbeat.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-xs">
        <Endpoint label="Device ID" value={creds.deviceUid} />
        <Endpoint label="API base URL" value={creds.apiBaseUrl} />
        <Endpoint label="MQTT broker" value={`${creds.mqttHost}:${creds.mqttPort}`} />
      </div>
    </div>
  );
}
function Endpoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded bg-surface-container min-w-0">
      <span className="text-outline block text-[9px] uppercase tracking-wider">{label}</span>
      <span className="font-mono text-body-sm text-on-surface break-all">{value}</span>
    </div>
  );
}

// ───────────────────────── Misc ─────────────────────────
export function DeviceLink({ id, name, uid }: { id: string; name: string; uid?: string }) {
  return (
    <Link to={`/devices/${id}`} className="flex flex-col min-w-0 group">
      <span className="font-body-sm text-body-sm font-semibold text-on-surface group-hover:text-primary truncate">{name}</span>
      {uid && <span className="font-label-sm text-label-sm text-outline font-mono truncate">{uid}</span>}
    </Link>
  );
}

/** Recharts styling derived from the design tokens. */
export const chartColors = {
  grid: '#262a31',
  tick: { fill: '#6c717e', fontSize: 10, fontFamily: '"Inter Variable", sans-serif' },
  primary: '#5cc8ff',
  secondary: '#a5b0ff',
  tertiary: '#3ddc97',
  warning: '#f5b84a',
  error: '#ff7a7a',
  tooltip: {
    contentStyle: { background: '#1c1f25', border: '1px solid #262a31', borderRadius: 10, boxShadow: '0 12px 32px -12px rgba(0,0,0,0.8)', padding: '8px 10px', fontSize: 12, color: '#ededf0' },
    labelStyle: { color: '#a3a7b3', fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 11 },
    itemStyle: { color: '#ededf0' }
  }
};

export function uptimeText(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
