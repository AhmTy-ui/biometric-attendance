import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Field, Icon, LinkButton, Modal, severityTone, Textarea, useErrorToast, useToast, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, humanize, num, pct, relative } from '@/lib/format';

// ───────────────────────── Metadata ─────────────────────────
export const TYPE_META: Record<string, { label: string; icon: string }> = {
  device_offline: { label: 'Device offline', icon: 'wifi_off' },
  storage_capacity: { label: 'Storage capacity', icon: 'sd_card_alert' },
  firmware_failure: { label: 'Firmware failure', icon: 'system_update' },
  device_tamper: { label: 'Device tamper', icon: 'gpp_maybe' },
  unmapped_location: { label: 'Unmapped location', icon: 'wrong_location' },
  sync_failed: { label: 'Sync failed', icon: 'sync_problem' },
  delivery_failure: { label: 'Delivery failure', icon: 'outbox' },
  integration_failure: { label: 'Integration failure', icon: 'link_off' }
};
export const typeMeta = (t: string) => TYPE_META[t] ?? { label: humanize(t), icon: 'notifications' };

export const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  device: { label: 'Device', icon: 'router' },
  sync: { label: 'Sync', icon: 'sync' },
  integration: { label: 'Integration', icon: 'hub' }
};

export const SEVERITY_META: Record<string, { label: string; icon: string }> = {
  critical: { label: 'Critical', icon: 'error' },
  warning: { label: 'Warning', icon: 'warning' },
  info: { label: 'Info', icon: 'info' }
};

export const statusTone = (s: string): Tone => (s === 'resolved' ? 'success' : s === 'acknowledged' ? 'info' : 'error');
export const STATUS_LABEL: Record<string, string> = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };

const accentBar: Record<Tone, string> = {
  error: 'bg-error',
  warning: 'bg-warning',
  info: 'bg-secondary-container',
  success: 'bg-tertiary',
  neutral: 'bg-outline',
  primary: 'bg-primary'
};
const iconBox: Record<Tone, string> = {
  error: 'bg-error-container/30 text-error',
  warning: 'bg-warning-container/60 text-warning',
  info: 'bg-secondary-container/15 text-secondary',
  success: 'bg-tertiary-container/20 text-tertiary',
  neutral: 'bg-surface-container-high text-outline',
  primary: 'bg-primary-container/20 text-primary'
};

/** Sync kind referenced by a sync alert (dedupe key "sync:<kind>"). */
export function alertSyncKind(a: any): 'employees' | 'locations' | 'attendance_export' | null {
  const k = typeof a?.dedupe_key === 'string' && a.dedupe_key.startsWith('sync:') ? a.dedupe_key.slice(5) : null;
  if (k === 'employees' || k === 'locations') return k;
  if (a?.dedupe_key === 'integration:export') return 'attendance_export';
  if (a?.type === 'integration_failure' && a?.dedupe_key === 'integration:web_unreachable') return 'employees';
  return null;
}

/** Contextual navigation actions for an alert, by type (user flow §19/§30). */
export function alertLinks(a: any): { label: string; icon: string; to: string; primary?: boolean }[] {
  const out: { label: string; icon: string; to: string; primary?: boolean }[] = [];
  switch (a.type) {
    case 'device_offline':
    case 'storage_capacity':
    case 'device_tamper':
      if (a.device_id) out.push({ label: 'View Device', icon: 'router', to: `/devices/${a.device_id}`, primary: true });
      if (a.location_id) out.push({ label: 'View Location', icon: 'storefront', to: `/locations/${a.location_id}` });
      break;
    case 'firmware_failure':
      if (a.context?.deploymentId) out.push({ label: 'View Deployment', icon: 'system_update', to: `/firmware/deployments/${a.context.deploymentId}`, primary: true });
      if (a.device_id) out.push({ label: 'View Device', icon: 'router', to: `/devices/${a.device_id}`, primary: !a.context?.deploymentId });
      if (a.location_id) out.push({ label: 'View Location', icon: 'storefront', to: `/locations/${a.location_id}` });
      break;
    case 'unmapped_location':
      out.push({ label: 'Resolve mapping', icon: 'alt_route', to: '/integration/unmapped', primary: true });
      break;
    case 'sync_failed':
    case 'integration_failure':
      out.push({ label: 'View sync runs', icon: 'history', to: '/integration', primary: true });
      break;
    case 'delivery_failure':
      out.push({ label: 'Open Reconciliation & DLQ', icon: 'published_with_changes', to: '/attendance/reconciliation', primary: true });
      if (a.location_id) out.push({ label: 'View Location', icon: 'storefront', to: `/locations/${a.location_id}` });
      break;
    default:
      if (a.device_id) out.push({ label: 'View Device', icon: 'router', to: `/devices/${a.device_id}` });
      if (a.location_id) out.push({ label: 'View Location', icon: 'storefront', to: `/locations/${a.location_id}` });
  }
  return out;
}

// ───────────────────────── Context facts ─────────────────────────
const FACT_LABEL: Record<string, string> = {
  bufferedEvents: 'Buffered events',
  employeesAffected: 'Employees affected',
  lastSeen: 'Last seen',
  dlqCount: 'Events in DLQ',
  externalRef: 'External reference',
  externalName: 'External name',
  storageUsedPct: 'Storage used',
  pendingEvents: 'Pending events',
  policy: 'Storage policy',
  version: 'Firmware version',
  deploymentId: 'Deployment',
  error: 'Error',
  lastError: 'Last error',
  httpStatus: 'HTTP status',
  fileName: 'Export file',
  lastEventId: 'Last failed event',
  deviceName: 'Device',
  locationName: 'Location'
};

function factValue(k: string, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  switch (k) {
    case 'lastSeen':
      return (
        <span>
          {dateTime(String(v))} <span className="text-outline">({relative(String(v))})</span>
        </span>
      );
    case 'storageUsedPct':
      return pct(Number(v));
    case 'bufferedEvents':
    case 'employeesAffected':
    case 'dlqCount':
    case 'pendingEvents':
      return num(Number(v));
    case 'policy':
      return humanize(String(v));
    case 'deploymentId':
      return (
        <Link to={`/firmware/deployments/${v}`} className="text-primary hover:underline font-mono">
          {String(v).slice(0, 8).toUpperCase()}
        </Link>
      );
    case 'lastEventId':
      return (
        <Link to={`/attendance/events/${v}`} className="text-primary hover:underline font-mono">
          {String(v).slice(0, 8).toUpperCase()}
        </Link>
      );
    case 'externalRef':
    case 'fileName':
    case 'version':
    case 'httpStatus':
      return <span className="font-mono">{String(v)}</span>;
    default:
      return typeof v === 'object' ? <span className="font-mono text-[11px] break-all">{JSON.stringify(v)}</span> : String(v);
  }
}

const NUMERIC_FACTS = ['bufferedEvents', 'employeesAffected', 'dlqCount', 'pendingEvents', 'storageUsedPct'];

/** Renders an alert's context JSON as key facts: headline numbers as tiles, the rest as rows. */
export function ContextFacts({ context }: { context: Record<string, unknown> | null | undefined }) {
  const entries = Object.entries(context ?? {}).filter(([, v]) => v !== undefined);
  if (!entries.length) return <p className="text-body-sm text-outline">No additional context was recorded for this alert.</p>;
  const tiles = entries.filter(([k]) => NUMERIC_FACTS.includes(k));
  const rows = entries.filter(([k]) => !NUMERIC_FACTS.includes(k));
  return (
    <div className="space-y-space-sm">
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-space-sm">
          {tiles.map(([k, v]) => (
            <div key={k} className="bg-surface-container rounded p-space-sm">
              <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider">{FACT_LABEL[k] ?? humanize(k)}</div>
              <div className="font-headline-md text-headline-md font-mono text-on-surface">{factValue(k, v)}</div>
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div>
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-space-md py-1.5 border-b border-outline-variant/15 last:border-0">
              <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider shrink-0 pt-0.5">{FACT_LABEL[k] ?? humanize(k)}</span>
              <span className="text-right text-body-sm text-on-surface min-w-0 break-words">{factValue(k, v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Mutations ─────────────────────────
export function useAlertActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const refresh = (id: string) => {
    void qc.invalidateQueries({ queryKey: ['alerts'] });
    void qc.invalidateQueries({ queryKey: ['alert', id] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const acknowledge = useMutation({
    mutationFn: (id: string) => api.post(`/api/alerts/${id}/acknowledge`),
    onSuccess: (_r, id) => {
      toast({ tone: 'success', title: 'Alert acknowledged', description: 'Other operators can see you are handling it.' });
      refresh(id);
    },
    onError: (e) => errorToast(e, 'Could not acknowledge alert')
  });
  const resolve = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => api.post(`/api/alerts/${id}/resolve`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: (_r, v) => {
      toast({ tone: 'success', title: 'Alert resolved' });
      refresh(v.id);
    },
    onError: (e) => errorToast(e, 'Could not resolve alert')
  });
  return { acknowledge, resolve };
}

export function ResolveDialog({ alert, onClose, onConfirm, loading }: { alert: any | null; onClose: () => void; onConfirm: (note: string) => void; loading?: boolean }) {
  const [note, setNote] = useState('');
  const alertId: string | null = alert?.id ?? null;
  useEffect(() => {
    if (alertId) setNote('');
  }, [alertId]);
  return (
    <Modal
      open={Boolean(alert)}
      onClose={onClose}
      title="Resolve alert"
      icon="task_alt"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="task_alt" loading={loading} onClick={() => onConfirm(note)}>
            Resolve
          </Button>
        </>
      }
    >
      <div className="space-y-space-sm">
        <p className="text-body-sm text-on-surface-variant">
          <span className="text-on-surface font-semibold">{alert?.title}</span>
        </p>
        <p className="text-body-sm text-on-surface-variant">
          Resolve only once the underlying problem is fixed. If the condition occurs again, a new alert is raised automatically.
        </p>
        <Field label="Resolution note" hint="Recorded in the alert history and audit log.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What was done to fix it?" />
        </Field>
      </div>
    </Modal>
  );
}

// ───────────────────────── Alert card (triage card) ─────────────────────────
export function AlertCard({
  alert: a,
  canManage,
  onAcknowledge,
  onResolve,
  acknowledging
}: {
  alert: any;
  canManage: boolean;
  onAcknowledge: () => void;
  onResolve: () => void;
  acknowledging?: boolean;
}) {
  const sev = severityTone(a.severity);
  const tone: Tone = a.status === 'resolved' ? 'success' : sev;
  const tm = typeMeta(a.type);
  const links = alertLinks(a);
  const resolved = a.status === 'resolved';
  return (
    <article className={clsx('bg-surface-container-low rounded-lg shadow-md relative overflow-hidden', resolved && 'opacity-80')}>
      <div className={clsx('absolute left-0 top-0 bottom-0 w-1.5', accentBar[tone])} />
      <div className="p-space-md pl-space-lg space-y-space-sm">
        {/* What happened */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-space-sm">
          <div className="flex items-start gap-space-sm min-w-0">
            <div className={clsx('p-2 rounded flex items-center justify-center shrink-0', iconBox[tone])}>
              <Icon name={tm.icon} className="text-[20px]" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone={sev} icon={SEVERITY_META[a.severity]?.icon}>
                  {a.severity}
                </Badge>
                <Badge icon={CATEGORY_META[a.category]?.icon}>{CATEGORY_META[a.category]?.label ?? a.category}</Badge>
                <Badge tone={statusTone(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                <span className="font-label-sm text-label-sm text-outline">{tm.label}</span>
              </div>
              <Link to={`/alerts/${a.id}`} className="block font-headline-sm text-headline-sm text-on-surface hover:text-primary">
                {a.title}
              </Link>
              <p className="font-body-sm text-body-sm text-on-surface-variant break-words">{a.description}</p>
            </div>
          </div>
          <div className="flex flex-col items-start md:items-end gap-0.5 shrink-0 font-label-sm text-label-sm text-outline">
            <span className="flex items-center gap-1 text-on-surface-variant">
              <Icon name="schedule" className="text-[13px]" />
              {relative(a.last_occurred_at ?? a.created_at)}
            </span>
            <span>Raised {dateTime(a.created_at)}</span>
            {Number(a.occurrences) > 1 && <span className="text-warning">Occurred {num(a.occurrences)}×</span>}
          </div>
        </div>

        {/* Where / impact / action */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-sm">
          <div className="bg-surface-container rounded p-space-sm space-y-1">
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Affected</div>
            {a.device_id || a.location_id ? (
              <div className="space-y-0.5 text-body-sm">
                {a.device_id && (
                  <Link to={`/devices/${a.device_id}`} className="flex items-center gap-1 text-primary hover:underline">
                    <Icon name="router" className="text-[14px]" />
                    {a.device_name ?? 'Device'}
                    {a.device_uid && <span className="font-mono text-[10px] text-outline">{a.device_uid}</span>}
                  </Link>
                )}
                {a.location_id && (
                  <Link to={`/locations/${a.location_id}`} className="flex items-center gap-1 text-primary hover:underline">
                    <Icon name="storefront" className="text-[14px]" />
                    {a.location_name ?? 'Location'}
                  </Link>
                )}
              </div>
            ) : (
              <div className="text-body-sm text-on-surface-variant">{a.category === 'device' ? 'Device no longer registered' : 'Organisation-wide'}</div>
            )}
          </div>
          <div className="bg-surface-container rounded p-space-sm space-y-1">
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Impact</div>
            <div className="text-body-sm text-on-surface">{a.impact ?? '—'}</div>
          </div>
          <div className="bg-surface-container rounded p-space-sm space-y-1">
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Recommended action</div>
            <div className="text-body-sm text-on-surface">{a.recommended_action ?? '—'}</div>
          </div>
        </div>

        {/* Footer: ownership + actions */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm pt-1">
          <div className="font-label-sm text-label-sm text-outline">
            {resolved ? (
              <span className="text-tertiary">
                Resolved {relative(a.resolved_at)} by {a.resolved_by_name ?? 'the rules engine (condition cleared)'}
                {a.resolution_note ? ` — “${a.resolution_note}”` : ''}
              </span>
            ) : a.status === 'acknowledged' ? (
              <span className="text-secondary">
                Acknowledged {relative(a.acknowledged_at)}
                {a.acknowledged_by_name ? ` by ${a.acknowledged_by_name}` : ''}
              </span>
            ) : (
              <span>Not yet acknowledged</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-space-xs">
            {links.map((l) => (
              <LinkButton key={l.to + l.label} to={l.to} icon={l.icon} size="sm" variant={l.primary ? 'subtle' : 'secondary'}>
                {l.label}
              </LinkButton>
            ))}
            {canManage && a.status === 'open' && (
              <Button size="sm" icon="done" loading={acknowledging} onClick={onAcknowledge}>
                Acknowledge
              </Button>
            )}
            {canManage && !resolved && (
              <Button size="sm" variant="primary" icon="task_alt" onClick={onResolve}>
                Resolve
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ───────────────────────── Filter chip ─────────────────────────
export function FilterChip({ active, onClick, icon, label, count, tone }: { active: boolean; onClick: () => void; icon: string; label: string; count?: number; tone?: Tone }) {
  const color = tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : tone === 'info' ? 'text-secondary' : 'text-on-surface-variant';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 px-2.5 h-8 rounded border font-label-md text-label-md transition-colors',
        active ? 'bg-primary-container/25 border-primary-container text-on-surface' : 'bg-surface-container-low border-outline-variant/40 text-on-surface-variant hover:bg-surface-container'
      )}
    >
      <Icon name={icon} className={clsx('text-[15px]', color)} />
      {label}
      {count !== undefined && <span className={clsx('px-1 rounded bg-surface-container-high font-mono', count > 0 ? color : 'text-outline')}>{num(count)}</span>}
    </button>
  );
}
