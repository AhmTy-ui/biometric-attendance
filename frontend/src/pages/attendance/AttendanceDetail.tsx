import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, CopyButton, ErrorState, Icon, JsonBlock, KV, LinkButton, Loading, PageHeader, Panel, useErrorToast, useToast, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, duration, FINGERS, num, relative, time, tzOffsetLabel } from '@/lib/format';
import { useLiveEvents } from '@/lib/live';
import { CHANNEL_LABEL, DeliveryBadge, DirectionBadge, MatchScore, OUTCOME_LABEL, outcomeTone, toneTextCls } from './components';

type StageState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

const RETRYABLE_STATUSES = new Set([null, 'pending', 'retrying', 'dead_letter']);

export default function AttendanceDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();

  const q = useQuery<any>({ queryKey: ['attendance-event', id], queryFn: () => api.get(`/api/attendance/events/${id}`), enabled: Boolean(id) });

  useLiveEvents('delivery/updated', (f) => {
    const evId = f.data?.eventId ?? f.data?.id;
    if (evId === id) void qc.invalidateQueries({ queryKey: ['attendance-event', id] });
  });

  const retry = useMutation({
    mutationFn: () => api.post(`/api/attendance/events/${id}/retry`),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Delivery retry queued', description: 'The event will be re-sent to the web software immediately.' });
      void qc.invalidateQueries({ queryKey: ['attendance-event', id] });
      void qc.invalidateQueries({ queryKey: ['delivery-summary'] });
    },
    onError: (e) => errorToast(e, 'Retry failed')
  });

  if (q.isLoading) return <Loading label="Loading attendance data..." />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const { event: ev, attempts: rawAttempts, daily } = q.data as { event: any; attempts: any[]; daily: any };
  const attempts = [...(rawAttempts ?? [])].sort((a, b) => new Date(a.attempted_at).getTime() - new Date(b.attempted_at).getTime());
  const tz = ev.location_timezone as string | undefined;
  const status = (ev.delivery_status ?? null) as string | null;
  const failures = attempts.filter((a) => a.outcome !== 'success');
  const canRetry = can('attendance.redeliver') && RETRYABLE_STATUSES.has(status);

  // Pipeline: Captured → Upload → Failed → Retry automatically → Success / Dead-letter queue → Admin alert
  const delivered = status === 'delivered' || status === 'exported';
  const stages: { key: string; label: string; icon: string; state: StageState; detail?: string }[] = [
    { key: 'captured', label: 'Captured', icon: 'fingerprint', state: 'done', detail: time(ev.captured_at, tz) },
    {
      key: 'upload',
      label: ev.channel === 'https_batch' ? 'Buffered upload' : 'Real-time upload',
      icon: ev.channel === 'https_batch' ? 'cloud_sync' : 'cell_tower',
      state: 'done',
      detail: ev.received_at ? time(ev.received_at, tz) : undefined
    },
    {
      key: 'failed',
      label: 'Failed',
      icon: 'error',
      state: failures.length ? 'failed' : delivered ? 'skipped' : 'pending',
      detail: failures.length ? `${failures.length} failed attempt(s)` : delivered ? 'No failures' : undefined
    },
    {
      key: 'retry',
      label: 'Retry automatically',
      icon: 'autorenew',
      state: status === 'retrying' ? 'active' : failures.length ? 'done' : delivered ? 'skipped' : 'pending',
      detail: status === 'retrying' && ev.next_attempt_at ? `next ${relative(ev.next_attempt_at)}` : undefined
    },
    status === 'dead_letter'
      ? { key: 'outcome', label: 'Dead-letter queue', icon: 'report', state: 'failed', detail: `after ${ev.delivery_attempts ?? attempts.length} attempt(s)` }
      : {
          key: 'outcome',
          label: status === 'exported' ? 'Exported' : 'Success',
          icon: 'done_all',
          state: delivered ? 'done' : status === 'delivering' ? 'active' : 'pending',
          detail: ev.delivered_at ? time(ev.delivered_at, tz) : undefined
        },
    { key: 'alert', label: 'Admin alert', icon: 'notifications_active', state: status === 'dead_letter' ? 'failed' : delivered ? 'skipped' : 'pending', detail: status === 'dead_letter' ? 'Raised' : undefined }
  ];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-space-sm">
            Attendance event <DirectionBadge direction={ev.direction} />
          </span>
        }
        icon="receipt_long"
        subtitle={
          <>
            {ev.employee_name} · {ev.location_name} · {dateTime(ev.captured_at, tz)}
          </>
        }
        crumbs={[{ label: 'Attendance' }, { label: 'History', to: '/attendance/history' }, { label: ev.event_uid }]}
        actions={
          <>
            {canRetry && (
              <Button variant="primary" icon="replay" loading={retry.isPending} onClick={() => retry.mutate()}>
                Retry delivery
              </Button>
            )}
            <CopyButton value={ev.event_uid} label="Copy event ID" />
          </>
        }
      />

      {status === 'dead_letter' && (
        <section className="bg-surface-container-low border-l-4 border-error rounded-lg p-space-md shadow-sm flex items-start gap-space-sm">
          <Icon name="report_problem" className="text-[24px] text-error shrink-0" />
          <div className="min-w-0">
            <div className="font-headline-sm text-headline-sm text-on-surface">This event did not reach the web software.</div>
            <p className="font-body-sm text-body-sm text-on-surface-variant break-words">
              {ev.delivery_http_status ? `HTTP ${ev.delivery_http_status} — ` : ''}
              {ev.delivery_error ?? 'No error detail recorded.'} The attendance record is stored safely in the platform. Correct the data or mapping in the web software, then retry delivery.
            </p>
          </div>
        </section>
      )}

      {/* Delivery pipeline */}
      <Panel title="Delivery pipeline" icon="route" subtitle="Captured → Upload → Failed → Retry automatically → Success / Dead-letter queue → Admin alert">
        <ol className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-space-sm">
          {stages.map((s, i) => (
            <li key={s.key} className={clsx('relative rounded p-space-sm flex flex-col gap-1 border', stageCls(s.state))}>
              <div className="flex items-center justify-between">
                <span className="font-label-sm text-label-sm text-outline">{String(i + 1).padStart(2, '0')}</span>
                <Icon name={s.state === 'done' ? 'check_circle' : s.state === 'failed' ? 'cancel' : s.state === 'active' ? 'progress_activity' : s.icon} className={clsx('text-[18px]', s.state === 'active' && 'animate-spin')} />
              </div>
              <span className="font-headline-sm text-body-md font-semibold">{s.label}</span>
              <span className="font-mono text-[10px] text-outline min-h-[12px]">{s.state === 'skipped' ? 'Not needed' : s.detail ?? (s.state === 'pending' ? 'Waiting' : '')}</span>
            </li>
          ))}
        </ol>
        {status === 'dead_letter' && can('alerts.view') && (
          <div className="mt-space-sm text-body-sm text-on-surface-variant">
            An administrator alert was raised for dead-lettered deliveries.{' '}
            <Link to="/alerts" className="text-primary hover:underline">
              Open Alert Center →
            </Link>
          </div>
        )}
      </Panel>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-gutter">
        <Panel title="Event" icon="fingerprint" className="xl:col-span-1">
          <KV label="Employee">
            {can('employees.view') ? (
              <Link to={`/employees/${ev.employee_id}`} className="text-primary hover:underline">
                {ev.employee_name}
              </Link>
            ) : (
              ev.employee_name
            )}
          </KV>
          <KV label="Staff number" mono>
            {ev.staff_number ?? '—'}
          </KV>
          {ev.department && <KV label="Department">{ev.department}</KV>}
          <KV label="Location">
            {can('locations.view') ? (
              <Link to={`/locations/${ev.location_id}`} className="text-primary hover:underline">
                {ev.location_name}
              </Link>
            ) : (
              ev.location_name
            )}
          </KV>
          <KV label="Device">
            {can('devices.view') ? (
              <Link to={`/devices/${ev.device_id}`} className="text-primary hover:underline">
                {ev.device_name}
              </Link>
            ) : (
              ev.device_name
            )}{' '}
            <span className="font-mono text-[10px] text-outline">{ev.device_uid}</span>
          </KV>
          <KV label="In / Out">
            <DirectionBadge direction={ev.direction} />
          </KV>
          <KV label="Captured" mono>
            {dateTime(ev.captured_at, tz)}
          </KV>
          <KV label="Timezone offset" mono>
            {typeof ev.tz_offset_minutes === 'number' ? tzOffsetLabel(ev.tz_offset_minutes) : '—'} {tz ? `· ${tz}` : ''}
          </KV>
          <KV label="Captured (UTC)" mono>
            {dateTime(ev.captured_at, 'UTC')}
          </KV>
          <KV label="Match score">
            <MatchScore score={ev.match_score} />
          </KV>
          {ev.finger_index && <KV label="Finger">{FINGERS[Number(ev.finger_index)] ?? `#${ev.finger_index}`}</KV>}
          <KV label="Event ID" mono>
            <span className="select-all break-all">{ev.event_uid}</span>
          </KV>
        </Panel>

        <Panel title="Sync & web delivery" icon="cloud_upload" className="xl:col-span-1">
          <KV label="Channel">{CHANNEL_LABEL[ev.channel] ?? ev.channel}</KV>
          <KV label="Buffered offline">{ev.was_buffered ? <Badge tone="warning" icon="cloud_off">Yes</Badge> : <Badge tone="success">No</Badge>}</KV>
          <KV label="Received by platform" mono>
            {dateTime(ev.received_at, tz)}
          </KV>
          <KV label="Capture → receive" mono>
            {ev.received_at ? duration(new Date(ev.received_at).getTime() - new Date(ev.captured_at).getTime()) : '—'}
          </KV>
          <KV label="Web delivery status">
            <DeliveryBadge status={status} />
          </KV>
          <KV label="Attempts" mono>
            {num(ev.delivery_attempts ?? 0)}
          </KV>
          {ev.delivery_http_status && (
            <KV label="Last HTTP status" mono>
              {ev.delivery_http_status}
            </KV>
          )}
          {ev.delivery_error && (
            <KV label="Last error">
              <span className="text-error">{ev.delivery_error}</span>
            </KV>
          )}
          {status === 'retrying' && (
            <KV label="Next attempt" mono>
              {dateTime(ev.next_attempt_at, tz)} ({relative(ev.next_attempt_at)})
            </KV>
          )}
          {ev.delivered_at && (
            <KV label="Delivered" mono>
              {dateTime(ev.delivered_at, tz)}
            </KV>
          )}
          {ev.web_reference_id && (
            <KV label="Web reference" mono>
              {ev.web_reference_id}
            </KV>
          )}
          {status === null && <p className="mt-space-sm text-body-sm text-outline">This event was not queued for delivery (web-software delivery was disabled when it was captured).</p>}
        </Panel>

        <Panel title="Day record" icon="today" subtitle={daily ? `Work date ${String(daily.work_date).slice(0, 10)} · ${ev.location_name}` : undefined} className="xl:col-span-1">
          {daily ? (
            <>
              <KV label="First in" mono>
                {daily.first_in ? time(daily.first_in, tz) : '—'}
              </KV>
              <KV label="Last out" mono>
                {daily.last_out ? time(daily.last_out, tz) : '—'}
              </KV>
              <KV label="Late">{daily.is_late ? <Badge tone="warning">Late · {num(daily.minutes_late)} min</Badge> : <Badge tone="success">On time</Badge>}</KV>
              <KV label="Worked" mono>
                {daily.worked_minutes !== null && daily.worked_minutes !== undefined ? `${Math.floor(daily.worked_minutes / 60)}h ${String(daily.worked_minutes % 60).padStart(2, '0')}m` : '—'}
              </KV>
              <KV label="Events that day" mono>
                {num(daily.event_count)}
              </KV>
              <div className="mt-space-sm">
                <LinkButton
                  size="sm"
                  icon="history"
                  to={`/attendance/history?employeeId=${ev.employee_id}&locationId=${ev.location_id}&date=${String(daily.work_date).slice(0, 10)}&sort=captured_asc`}
                >
                  All events that day
                </LinkButton>
              </div>
            </>
          ) : (
            <p className="text-body-sm text-outline">No consolidated day record exists for this event yet.</p>
          )}
        </Panel>
      </section>

      <Panel title="Delivery attempts" icon="timeline" subtitle={`${attempts.length} attempt(s) recorded`}>
        {attempts.length === 0 ? (
          <p className="text-body-sm text-outline py-space-sm">{status === 'exported' ? 'Delivered via scheduled file export (no API attempts).' : 'No delivery attempts yet.'}</p>
        ) : (
          <ol className="relative border-l border-outline-variant/40 ml-2 space-y-space-md">
            {attempts.map((a, i) => {
              const tone: Tone = outcomeTone(a.outcome);
              return (
                <li key={`${a.attempt_no}-${a.attempted_at}-${i}`} className="ml-space-md">
                  <span className={clsx('absolute -left-[7px] w-3.5 h-3.5 rounded-full border-2 border-background', dotBg(tone))} />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-label-lg text-on-surface font-semibold">Attempt #{a.attempt_no}</span>
                    <Badge tone={tone}>{OUTCOME_LABEL[a.outcome] ?? a.outcome}</Badge>
                    {a.http_status && <span className="font-mono text-[11px] text-on-surface-variant">HTTP {a.http_status}</span>}
                    <span className="font-mono text-[11px] text-outline">{dateTime(a.attempted_at, tz)}</span>
                    <span className="font-mono text-[11px] text-outline">· {duration(a.duration_ms)}</span>
                  </div>
                  {a.error && <p className={clsx('mt-1 font-mono text-[11px] break-words', toneTextCls(tone))}>{a.error}</p>}
                </li>
              );
            })}
            {status === 'retrying' && (
              <li className="ml-space-md">
                <span className="absolute -left-[7px] w-3.5 h-3.5 rounded-full border-2 border-background bg-secondary animate-pulse" />
                <span className="text-body-sm text-secondary">Next automatic retry {relative(ev.next_attempt_at)} ({dateTime(ev.next_attempt_at, tz)})</span>
              </li>
            )}
          </ol>
        )}
      </Panel>

      <Panel title="Stored record" icon="data_object" subtitle="Exactly as stored by the platform">
        <JsonBlock value={ev} />
      </Panel>
    </>
  );
}

function stageCls(s: StageState) {
  switch (s) {
    case 'done':
      return 'bg-tertiary-container/15 border-tertiary/30 text-tertiary';
    case 'active':
      return 'bg-secondary-container/15 border-secondary/40 text-secondary';
    case 'failed':
      return 'bg-error-container/30 border-error/40 text-error';
    case 'skipped':
      return 'bg-surface-container border-outline-variant/20 text-outline opacity-60';
    default:
      return 'bg-surface-container border-outline-variant/30 text-on-surface-variant';
  }
}
function dotBg(t: Tone) {
  return t === 'success' ? 'bg-tertiary' : t === 'error' ? 'bg-error' : t === 'warning' ? 'bg-warning' : 'bg-outline';
}
