import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Empty,
  ErrorState,
  Icon,
  KV,
  LinkButton,
  Loading,
  PageHeader,
  Panel,
  severityTone,
  useErrorToast,
  useToast, SideToggle } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, humanize, num, relative } from '@/lib/format';
import { KIND_LABEL, runDurationMs, shortId, SyncRunsTable } from '@/pages/integration/components';
import { alertLinks, alertSyncKind, CATEGORY_META, ContextFacts, ResolveDialog, SEVERITY_META, STATUS_LABEL, statusTone, typeMeta, useAlertActions } from './components';

const HISTORY_META: Record<string, { label: string; icon: string; cls: string }> = {
  'alert.raised': { label: 'Alert raised', icon: 'notification_important', cls: 'text-error' },
  'alert.acknowledged': { label: 'Acknowledged', icon: 'done', cls: 'text-secondary' },
  'alert.resolved': { label: 'Resolved', icon: 'task_alt', cls: 'text-tertiary' },
  'alert.auto_resolved': { label: 'Resolved automatically — condition cleared', icon: 'auto_mode', cls: 'text-tertiary' }
};

export default function AlertDetails() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('alerts.manage');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [resolving, setResolving] = useState(false);
  const { acknowledge, resolve } = useAlertActions();

  const q = useQuery({ queryKey: ['alert', id], queryFn: () => api.get(`/api/alerts/${id}`) });

  const retry = useMutation({
    mutationFn: (kind: string) => api.post('/api/integration/sync', { kind, mode: 'retry' }),
    onSuccess: (res: any) => {
      void qc.invalidateQueries({ queryKey: ['alert', id] });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['sync-runs'] });
      void qc.invalidateQueries({ queryKey: ['integration-status'] });
      if (res?.running) {
        toast({ tone: 'info', title: 'Synchronization already running', description: res.message });
        return;
      }
      const r = res?.run;
      if (r?.id) {
        const errs = Number(r.error_count ?? 0);
        toast(
          r.status === 'failed'
            ? { tone: 'error', title: 'Retry failed', description: r.error_message ?? undefined, action: { label: 'View run', onClick: () => navigate(`/integration/runs/${r.id}`) } }
            : errs > 0
              ? { tone: 'warning', title: `Synchronization completed with ${errs} errors.`, action: { label: 'View Errors', onClick: () => navigate(`/integration/runs/${r.id}`) } }
              : { tone: 'success', title: 'Synchronization completed successfully.' }
        );
      } else toast({ tone: 'success', title: 'Retry completed' });
    },
    onError: (e) => errorToast(e, 'Retry failed')
  });

  if (q.isLoading) return <Loading label="Loading alert..." />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { alert: a, history, relatedSync } = q.data as { alert: any; history: any[]; relatedSync: any[] };
  const sev = severityTone(a.severity);
  const tm = typeMeta(a.type);
  const links = alertLinks(a);
  const syncKind = alertSyncKind(a);
  const isSyncAlert = a.type === 'sync_failed' || a.type === 'integration_failure';
  const canRetry = isSyncAlert && syncKind && can('integration.manage');
  const resolved = a.status === 'resolved';
  const kindRuns = syncKind ? relatedSync.filter((r) => r.kind === syncKind) : relatedSync;
  const runsToShow = kindRuns.length ? kindRuns : relatedSync;

  return (
    <div className="space-y-space-md">
      <PageHeader
        crumbs={[{ label: 'Alert Center', to: '/alerts' }, { label: tm.label }]}
        title={a.title}
        icon={tm.icon}
        subtitle={
          <span className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <Badge tone={sev} icon={SEVERITY_META[a.severity]?.icon}>
              {a.severity}
            </Badge>
            <Badge icon={CATEGORY_META[a.category]?.icon}>{CATEGORY_META[a.category]?.label ?? a.category}</Badge>
            <Badge tone={statusTone(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
            <span>
              Raised {relative(a.created_at)}
              {Number(a.occurrences) > 1 ? ` · occurred ${num(a.occurrences)}×, last ${relative(a.last_occurred_at)}` : ''}
            </span>
          </span>
        }
        actions={
          <>
            {canManage && a.status === 'open' && (
              <Button icon="done" loading={acknowledge.isPending} onClick={() => acknowledge.mutate(a.id)}>
                Acknowledge
              </Button>
            )}
            {canManage && !resolved && (
              <Button variant="primary" icon="task_alt" onClick={() => setResolving(true)}>
                Resolve
              </Button>
            )}
          </>
        }
      />

      {resolved && (
        <div className="bg-surface-container-low rounded-lg p-space-md relative overflow-hidden flex items-start gap-space-sm">
          <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-tertiary" />
          <Icon name="task_alt" className="text-[20px] text-tertiary ml-space-xs" />
          <div>
            <div className="font-headline-sm text-headline-sm text-on-surface">
              Resolved {relative(a.resolved_at)} by {a.resolved_by_name ?? 'the rules engine'}
            </div>
            {a.resolution_note && <p className="text-body-sm text-on-surface-variant">“{a.resolution_note}”</p>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md items-start">
        <div className="lg:col-span-8 space-y-space-md">
          <Panel title="What happened" icon="description" accent={resolved ? 'success' : sev}>
            <p className="text-body-md text-on-surface break-words">{a.description}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm mt-space-md">
              <div className="bg-surface-container rounded p-space-sm space-y-1">
                <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline flex items-center gap-1">
                  <Icon name="crisis_alert" className="text-[14px]" /> Impact
                </div>
                <div className="text-body-sm text-on-surface">{a.impact ?? '—'}</div>
              </div>
              <div className="bg-surface-container rounded p-space-sm space-y-1">
                <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline flex items-center gap-1">
                  <Icon name="tips_and_updates" className="text-[14px]" /> Recommended action
                </div>
                <div className="text-body-sm text-on-surface">{a.recommended_action ?? '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel title="Key facts" icon="fact_check" subtitle="Recorded by the rules engine when the alert was raised or last re-occurred">
            <ContextFacts context={a.context} />
          </Panel>

          {isSyncAlert && (
            <Panel
              title="Recent synchronisation runs"
              icon="history"
              subtitle={syncKind ? KIND_LABEL[syncKind] : undefined}
              bodyClassName="px-0 pb-0"
              actions={
                <>
                  <LinkButton to="/integration" size="sm" icon="hub">
                    View sync runs
                  </LinkButton>
                  {canRetry && syncKind && (
                    <Button size="sm" variant="primary" icon="replay" loading={retry.isPending} onClick={() => retry.mutate(syncKind)}>
                      Retry sync
                    </Button>
                  )}
                </>
              }
            >
              {retry.isPending && (
                <div className="px-space-md pb-space-sm flex items-center gap-2 text-body-sm text-on-surface">
                  <Icon name="progress_activity" className="animate-spin text-[16px] text-secondary" /> Synchronizing...
                </div>
              )}
              {runsToShow.length ? (
                <SyncRunsTable rows={runsToShow} />
              ) : (
                <Empty icon="sync" title="No synchronisation runs recorded." />
              )}
            </Panel>
          )}

          <Panel title="History" icon="timeline" subtitle="From the tamper-evident audit log">
            {history.length === 0 ? (
              <Empty icon="history" title="No history recorded." />
            ) : (
              <ol className="relative border-l border-outline-variant/40 ml-2 space-y-space-md">
                {history.map((h) => {
                  const m = HISTORY_META[h.action] ?? { label: humanize(h.action), icon: 'radio_button_checked', cls: 'text-outline' };
                  const note = h.after_state?.note;
                  return (
                    <li key={h.seq} className="ml-4">
                      <span className="absolute -left-[9px] flex items-center justify-center w-[18px] h-[18px] rounded-full bg-surface-container-low">
                        <Icon name={m.icon} className={clsx('text-[16px]', m.cls)} />
                      </span>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-body-sm text-body-sm text-on-surface font-semibold">{m.label}</span>
                        <span className="font-mono text-[11px] text-outline">{dateTime(h.occurred_at)}</span>
                      </div>
                      <div className="font-label-sm text-label-sm text-outline flex flex-wrap gap-x-2">
                        <span>by {h.actor_name ?? 'System'}</span>
                        {can('audit.view') && (
                          <Link to={`/audit/${h.seq}`} className="text-primary hover:underline">
                            Audit #{h.seq}
                          </Link>
                        )}
                      </div>
                      {note && <p className="text-body-sm text-on-surface-variant mt-0.5">“{note}”</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-4 space-y-space-md">
          <SideToggle id="alert-details" label="Actions" />
          <Panel title="What you can do" icon="bolt">
            <div className="flex flex-col gap-space-xs">
              {links.map((l) => (
                <LinkButton key={l.to + l.label} to={l.to} icon={l.icon} variant={l.primary ? 'primary' : 'secondary'} className="justify-start">
                  {l.label}
                </LinkButton>
              ))}
              {canRetry && syncKind && (
                <Button icon="replay" loading={retry.isPending} onClick={() => retry.mutate(syncKind)} className="justify-start">
                  Retry {KIND_LABEL[syncKind]?.toLowerCase() ?? 'sync'}
                </Button>
              )}
              {canManage && a.status === 'open' && (
                <Button icon="done" loading={acknowledge.isPending} onClick={() => acknowledge.mutate(a.id)} className="justify-start">
                  Acknowledge
                </Button>
              )}
              {canManage && !resolved && (
                <Button variant="subtle" icon="task_alt" onClick={() => setResolving(true)} className="justify-start">
                  Resolve with note
                </Button>
              )}
              {!links.length && !canManage && !canRetry && <p className="text-body-sm text-outline">No actions available for your role.</p>}
            </div>
          </Panel>

          <Panel title="Affected" icon="location_on">
            {a.device_id ? (
              <>
                <KV label="Device">
                  <Link to={`/devices/${a.device_id}`} className="text-primary hover:underline">
                    {a.device_name ?? 'Device'}
                  </Link>
                </KV>
                {a.device_uid && (
                  <KV label="Device ID" mono>
                    {a.device_uid}
                  </KV>
                )}
                {a.device_connectivity && (
                  <KV label="Connectivity now">
                    <Badge tone={a.device_connectivity === 'online' ? 'success' : 'error'}>{a.device_connectivity}</Badge>
                  </KV>
                )}
                <KV label="Last heartbeat" mono>
                  {a.device_last_heartbeat ? `${dateTime(a.device_last_heartbeat)} (${relative(a.device_last_heartbeat)})` : '—'}
                </KV>
                {a.device_pending_events !== null && a.device_pending_events !== undefined && <KV label="Buffered now">{num(a.device_pending_events)} events</KV>}
              </>
            ) : null}
            {a.location_id ? (
              <KV label="Location">
                <Link to={`/locations/${a.location_id}`} className="text-primary hover:underline">
                  {a.location_name ?? 'Location'}
                </Link>
              </KV>
            ) : null}
            {!a.device_id && !a.location_id && <p className="text-body-sm text-on-surface-variant">Organisation-wide — not tied to a single device or location.</p>}
          </Panel>

          <Panel title="Timeline" icon="schedule">
            <KV label="Type">{tm.label}</KV>
            <KV label="Raised" mono>
              {dateTime(a.created_at)}
            </KV>
            <KV label="Last occurred" mono>
              {dateTime(a.last_occurred_at)}
            </KV>
            <KV label="Occurrences" mono>
              {num(a.occurrences)}
            </KV>
            <KV label="Acknowledged">{a.acknowledged_at ? `${dateTime(a.acknowledged_at)}${a.acknowledged_by_name ? ` · ${a.acknowledged_by_name}` : ''}` : '—'}</KV>
            <KV label="Resolved">{a.resolved_at ? `${dateTime(a.resolved_at)} · ${a.resolved_by_name ?? 'Rules engine'}` : '—'}</KV>
            <KV label="Alert ID" mono>
              {shortId(a.id)}
            </KV>
          </Panel>

          {isSyncAlert && runsToShow[0] && (
            <Panel title="Latest run" icon="sync">
              <KV label="Kind">{KIND_LABEL[runsToShow[0].kind] ?? runsToShow[0].kind}</KV>
              <KV label="Status">{humanize(runsToShow[0].status)}</KV>
              <KV label="Started" mono>
                {dateTime(runsToShow[0].started_at)}
              </KV>
              <KV label="Duration" mono>
                {duration(runDurationMs(runsToShow[0]))}
              </KV>
              {runsToShow[0].error_message && (
                <KV label="Error">
                  <span className="text-error">{runsToShow[0].error_message}</span>
                </KV>
              )}
              <LinkButton to={`/integration/runs/${runsToShow[0].id}`} size="sm" icon="open_in_new" className="mt-space-sm">
                Open run
              </LinkButton>
            </Panel>
          )}
        </div>
      </div>

      <ResolveDialog
        alert={resolving ? a : null}
        onClose={() => setResolving(false)}
        loading={resolve.isPending}
        onConfirm={(note) => resolve.mutate({ id: a.id, note }, { onSuccess: () => setResolving(false) })}
      />
    </div>
  );
}
