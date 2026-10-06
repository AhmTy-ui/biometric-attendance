import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Dot, Icon, Table, Td, Th, THead, Tr, type Tone } from '@/components/ui';
import { dateTime, duration, num, relative } from '@/lib/format';

// ───────────────────────── Labels ─────────────────────────
export const KIND_LABEL: Record<string, string> = {
  employees: 'Employee sync',
  locations: 'Location sync',
  attendance_export: 'Attendance export',
  attendance_push: 'Attendance push'
};
export const KIND_ICON: Record<string, string> = {
  employees: 'badge',
  locations: 'storefront',
  attendance_export: 'file_export',
  attendance_push: 'cloud_upload'
};
export const MODE_LABEL: Record<string, string> = {
  incremental: 'Scheduled incremental',
  full: 'Full reconciliation',
  manual: 'Manual',
  retry: 'Retry'
};
export const DELIVERY_MODE_LABEL: Record<string, string> = {
  api: 'Real-time API push',
  scheduled_export: 'Scheduled file export',
  disabled: 'Disabled'
};

export type Health = 'healthy' | 'degraded' | 'failing' | 'never_run' | 'disabled';
export const HEALTH: Record<Health, { label: string; tone: Tone; icon: string }> = {
  healthy: { label: 'Healthy', tone: 'success', icon: 'check_circle' },
  degraded: { label: 'Degraded', tone: 'warning', icon: 'warning' },
  failing: { label: 'Failing', tone: 'error', icon: 'error' },
  never_run: { label: 'Never run', tone: 'neutral', icon: 'schedule' },
  disabled: { label: 'Disabled', tone: 'neutral', icon: 'block' }
};
export const healthMeta = (h: string | null | undefined) => HEALTH[(h ?? 'never_run') as Health] ?? HEALTH.never_run;

const toneText: Record<Tone, string> = {
  success: 'text-tertiary',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-secondary',
  neutral: 'text-on-surface-variant',
  primary: 'text-primary'
};
export const toneTextCls = (t: Tone) => toneText[t];

/** Duration of a run in ms (server gives a numeric string); running runs show elapsed time. */
export function runDurationMs(run: any): number | null {
  if (run?.duration_ms !== null && run?.duration_ms !== undefined && run.duration_ms !== '') return Number(run.duration_ms);
  if (run?.status === 'running' && run.started_at) return Date.now() - new Date(run.started_at).getTime();
  if (run?.finished_at && run?.started_at) return new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  return null;
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8).toUpperCase() : '—');

// ───────────────────────── Status badge ─────────────────────────
export function SyncStatusBadge({ status }: { status: string | null | undefined }) {
  switch (status) {
    case 'running':
      return (
        <Badge tone="info">
          <Icon name="progress_activity" className="animate-spin text-[12px]" />
          Running
        </Badge>
      );
    case 'success':
      return (
        <Badge tone="success" icon="check_circle">
          Success
        </Badge>
      );
    case 'partial':
      return (
        <Badge tone="warning" icon="warning">
          Partial
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="error" icon="error">
          Failed
        </Badge>
      );
    default:
      return <Badge>{status ?? '—'}</Badge>;
  }
}

// ───────────────────────── Health tile (template "metric" card) ─────────────────────────
export function HealthTile({
  label,
  icon,
  health,
  running,
  headline,
  detail,
  footerLeft,
  footerRight,
  actions,
  to
}: {
  label: string;
  icon: string;
  health: string | null | undefined;
  running?: boolean;
  headline?: ReactNode;
  detail?: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  actions?: ReactNode;
  to?: string;
}) {
  const m = healthMeta(health);
  return (
    <div className="bg-surface-container rounded-lg p-space-md shadow-sm relative group hover:bg-surface-container-high transition-colors flex flex-col">
      <div className="flex items-center justify-between text-outline mb-1.5">
        <span className="font-label-sm text-label-sm uppercase tracking-wider flex items-center gap-1.5">
          <Icon name={icon} className="text-[15px]" />
          {to ? (
            <Link to={to} className="hover:text-on-surface">
              {label}
            </Link>
          ) : (
            label
          )}
        </span>
        {running ? <Icon name="progress_activity" className="animate-spin text-[16px] text-secondary" /> : <Dot tone={m.tone} pulse={m.tone === 'success' || m.tone === 'error'} />}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={clsx('font-headline-lg text-headline-lg font-semibold tracking-tight', toneText[m.tone])}>{headline ?? m.label}</span>
        {running ? (
          <span className="font-label-sm text-label-sm text-secondary px-1.5 py-0.5 rounded bg-secondary-container/20">Synchronizing…</span>
        ) : (
          detail
        )}
      </div>
      <div className="mt-2.5 pt-2 border-t border-outline-variant/15 flex items-center justify-between gap-2 text-outline font-label-sm text-label-sm">
        <span className="truncate">{footerLeft}</span>
        <span className="shrink-0">{footerRight}</span>
      </div>
      {actions && <div className="mt-space-sm flex flex-wrap gap-space-xs">{actions}</div>}
    </div>
  );
}

// ───────────────────────── Sync progress / result banner (user flow §26) ─────────────────────────
export type SyncTrack =
  | { phase: 'running'; kind: string; runId?: string; mine?: boolean }
  | { phase: 'done'; kind: string; run: any }
  | { phase: 'info'; kind: string; message: string }
  | { phase: 'error'; kind: string; message: string };

export function SyncResultBanner({ track, onDismiss }: { track: SyncTrack | null; onDismiss: () => void }) {
  const navigate = useNavigate();
  if (!track) return null;
  const kind = KIND_LABEL[track.kind] ?? track.kind;
  let tone: Tone = 'info';
  let icon = 'sync';
  let title: ReactNode;
  let body: ReactNode = null;
  let action: ReactNode = null;
  if (track.phase === 'running') {
    title = 'Synchronizing...';
    body = `${kind} is in progress${track.mine ? '' : ' (started by the scheduler or another user)'}. Results appear here when it finishes.`;
  } else if (track.phase === 'done') {
    const r = track.run;
    const errors = Number(r.error_count ?? 0);
    if (r.status === 'failed') {
      tone = 'error';
      icon = 'error';
      title = `${kind} failed.`;
      body = r.error_message ?? 'The web software returned an error.';
    } else if (errors > 0 || r.status === 'partial') {
      tone = 'warning';
      icon = 'warning';
      title = `Synchronization completed with ${num(errors)} error${errors === 1 ? '' : 's'}.`;
      body = `${kind}: ${num(r.records_processed)} processed · +${num(r.records_added)} added · ${num(r.records_updated)} updated · ${num(r.records_removed)} removed.`;
    } else {
      tone = 'success';
      icon = 'check_circle';
      title = 'Synchronization completed successfully.';
      body = `${kind}: ${num(r.records_processed)} processed · +${num(r.records_added)} added · ${num(r.records_updated)} updated · ${num(r.records_removed)} removed.`;
    }
    if (r.id)
      action = (
        <Button size="sm" variant={tone === 'success' ? 'secondary' : 'primary'} icon={tone === 'success' ? 'visibility' : 'bug_report'} onClick={() => navigate(`/integration/runs/${r.id}`)}>
          {tone === 'success' ? 'View Run' : 'View Errors'}
        </Button>
      );
  } else if (track.phase === 'info') {
    title = kind;
    body = track.message;
  } else {
    tone = 'error';
    icon = 'error';
    title = `${kind} could not be started.`;
    body = track.message;
  }
  const accent: Record<Tone, string> = {
    info: 'bg-secondary-container',
    success: 'bg-tertiary',
    warning: 'bg-warning',
    error: 'bg-error',
    neutral: 'bg-outline',
    primary: 'bg-primary'
  };
  return (
    <div className="card rounded-xl p-space-md relative overflow-hidden" role="status">
      <div className={clsx('absolute left-0 top-0 bottom-0 w-1.5', accent[tone])} />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm pl-space-xs">
        <div className="flex items-start gap-space-sm min-w-0">
          <div className={clsx('p-2 rounded flex items-center justify-center shrink-0 bg-surface-container', toneText[tone])}>
            <Icon name={track.phase === 'running' ? 'progress_activity' : icon} className={clsx('text-[20px]', track.phase === 'running' && 'animate-spin')} />
          </div>
          <div className="min-w-0">
            <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
            {body && <p className="font-body-sm text-body-sm text-on-surface-variant break-words">{body}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          {action}
          {track.phase !== 'running' && (
            <Button size="sm" variant="ghost" icon="close" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Sync runs table ─────────────────────────
export function ChangesCell({ run }: { run: any }) {
  return (
    <span className="font-mono text-[11px] text-on-surface-variant whitespace-nowrap">
      <span className="text-tertiary">+{num(run.records_added)}</span> / <span className="text-secondary">~{num(run.records_updated)}</span> /{' '}
      <span className="text-error">−{num(run.records_removed)}</span>
    </span>
  );
}

export function SyncRunsTable({ rows }: { rows: any[] }) {
  const navigate = useNavigate();
  return (
    <Table>
      <THead>
        <tr>
          <Th>Run</Th>
          <Th>Kind</Th>
          <Th>Mode</Th>
          <Th>Status</Th>
          <Th>Started</Th>
          <Th>Duration</Th>
          <Th className="text-right">Processed</Th>
          <Th>Added / Updated / Removed</Th>
          <Th className="text-right">Errors</Th>
          <Th>Triggered by</Th>
        </tr>
      </THead>
      <tbody className="text-on-surface">
        {rows.map((r) => (
          <Tr key={r.id} onClick={() => navigate(`/integration/runs/${r.id}`)}>
            <Td className="font-mono text-[11px] text-primary">{shortId(r.id)}</Td>
            <Td>
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <Icon name={KIND_ICON[r.kind] ?? 'sync'} className="text-[15px] text-outline" />
                {KIND_LABEL[r.kind] ?? r.kind}
              </span>
            </Td>
            <Td>
              <span className="font-label-sm text-label-sm px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface whitespace-nowrap">{MODE_LABEL[r.mode] ?? r.mode}</span>
            </Td>
            <Td>
              <SyncStatusBadge status={r.status} />
            </Td>
            <Td className="whitespace-nowrap">
              <div className="font-mono text-[11px]">{dateTime(r.started_at)}</div>
              <div className="font-label-sm text-label-sm text-outline">{relative(r.started_at)}</div>
            </Td>
            <Td className="font-mono text-[11px] text-outline whitespace-nowrap">{duration(runDurationMs(r))}</Td>
            <Td className="font-mono text-[11px] text-right">{num(r.records_processed)}</Td>
            <Td>
              <ChangesCell run={r} />
            </Td>
            <Td className={clsx('font-mono text-[11px] text-right', Number(r.error_count) > 0 ? 'text-error font-semibold' : 'text-outline')}>{num(r.error_count)}</Td>
            <Td className="whitespace-nowrap text-on-surface-variant">{r.triggered_by_name ?? 'System (scheduler)'}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
