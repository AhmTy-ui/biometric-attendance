import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, CopyButton, ErrorState, Icon, JsonBlock, KV, Loading, Modal, PageHeader, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, humanize, relative } from '@/lib/format';
import { ActionBadge, actorIcon, GENESIS_HASH, HashText, objectLink, shortHash, StateDiff } from './components';

export default function AuditDetail() {
  const { seq = '' } = useParams();
  const navigate = useNavigate();
  const [raw, setRaw] = useState(false);
  const q = useQuery<any>({ queryKey: ['audit-event', seq], queryFn: () => api.get(`/api/audit/${seq}`), enabled: Boolean(seq) });

  if (q.isLoading) return <Loading label="Loading audit event…" />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const { event: e, chain } = q.data as { event: any; chain: { linksToPrevious: boolean; linkedByNext: boolean | null; previousSeq: number | string | null; nextSeq: number | string | null } };
  const link = objectLink(e.object_type, e.object_id);
  const genesis = e.prev_hash === GENESIS_HASH;
  const chainOk = chain.linksToPrevious && chain.linkedByNext !== false;

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader
        crumbs={[{ label: 'Audit Log', to: '/audit' }, { label: `Event #${e.seq}` }]}
        title={
          <span className="flex items-center gap-space-sm">
            <span className="font-mono">#{e.seq}</span>
            <ActionBadge action={e.action} className="text-label-md" />
          </span>
        }
        subtitle={`${dateTime(e.occurred_at)} · ${relative(e.occurred_at)} · read-only record — audit events cannot be edited or deleted`}
        actions={
          <>
            <Button icon="chevron_left" disabled={chain.previousSeq === null} onClick={() => navigate(`/audit/${chain.previousSeq}`)}>
              Previous
            </Button>
            <Button disabled={chain.nextSeq === null} onClick={() => navigate(`/audit/${chain.nextSeq}`)}>
              Next <Icon name="chevron_right" className="text-[15px]" />
            </Button>
            <Button icon="code" onClick={() => setRaw(true)}>
              Raw record
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-space-md">
        <div className="xl:col-span-2 flex flex-col gap-space-md">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
            <Panel title="Actor" icon={actorIcon(e.actor_type)}>
              <KV label="Name">{e.actor_name ?? '—'}</KV>
              <KV label="Type">{humanize(e.actor_type)}</KV>
              <KV label="Role">{e.actor_role ? humanize(e.actor_role) : '—'}</KV>
              <KV label="Actor ID" mono>
                {e.actor_type === 'user' && e.actor_id ? (
                  <Link to={`/users/${e.actor_id}`} className="text-primary hover:underline">
                    {e.actor_id}
                  </Link>
                ) : e.actor_type === 'device' && e.actor_id ? (
                  <Link to={`/devices/${e.actor_id}`} className="text-primary hover:underline">
                    {e.actor_id}
                  </Link>
                ) : (
                  e.actor_id ?? '—'
                )}
              </KV>
              {e.actor_id && (
                <div className="pt-space-sm">
                  <Link to={`/audit?actorId=${encodeURIComponent(e.actor_id)}`} className="font-label-sm text-label-sm text-primary hover:underline">
                    All events by this actor →
                  </Link>
                </div>
              )}
            </Panel>
            <Panel title="Context" icon="lan">
              <KV label="Timestamp">
                <span className="font-mono">{dateTime(e.occurred_at)}</span>
              </KV>
              <KV label="ISO (UTC)" mono>
                {new Date(e.occurred_at).toISOString()}
              </KV>
              <KV label="IP address" mono>
                {e.ip ?? '—'}
              </KV>
              <KV label="Device info">{e.device_info ?? '—'}</KV>
              <KV label="User agent">
                <span className="font-mono text-[11px] break-all">{e.user_agent ?? '—'}</span>
              </KV>
            </Panel>
          </div>

          <Panel title="Object affected" icon="category">
            <KV label="Action">
              <ActionBadge action={e.action} />
            </KV>
            <KV label="Object type">{humanize(e.object_type)}</KV>
            <KV label="Object">
              {link ? (
                <Link to={link} className="text-primary hover:underline">
                  {e.object_label ?? e.object_id}
                </Link>
              ) : (
                e.object_label ?? '—'
              )}
            </KV>
            <KV label="Object ID" mono>
              {e.object_id ?? '—'}
            </KV>
            {e.object_id && (
              <div className="pt-space-sm">
                <Link to={`/audit?objectType=${encodeURIComponent(e.object_type)}&objectId=${encodeURIComponent(e.object_id)}`} className="font-label-sm text-label-sm text-primary hover:underline">
                  Full history of this object →
                </Link>
              </div>
            )}
          </Panel>

          <Panel title="Before / after state" icon="difference" subtitle="Changed keys are highlighted; secrets are stored redacted">
            <StateDiff before={e.before_state} after={e.after_state} />
          </Panel>
        </div>

        {/* Chain inspector */}
        <div className="flex flex-col gap-space-md">
          <div className="rounded-xl card p-space-md space-y-space-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded bg-surface-container flex items-center justify-center text-primary">
                  <Icon name="link" className="text-[18px]" />
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm text-on-surface">Hash chain link</h3>
                  <span className="font-label-sm text-[10px] text-outline block">SHA-256 · append-only</span>
                </div>
              </div>
              <Badge tone={chainOk ? 'success' : 'error'} icon={chainOk ? 'verified' : 'error'}>
                {chainOk ? 'Linked' : 'Broken link'}
              </Badge>
            </div>

            <div className="space-y-1.5 font-label-sm text-label-sm">
              <ChainNode
                title={genesis ? 'Previous hash (genesis)' : `Previous hash · event #${chain.previousSeq ?? '?'}`}
                value={e.prev_hash}
                status={chain.linksToPrevious ? 'Matches' : 'Mismatch'}
                ok={chain.linksToPrevious}
                to={chain.previousSeq !== null ? `/audit/${chain.previousSeq}` : undefined}
              />
              <div className="flex justify-center text-outline">
                <Icon name="arrow_downward" className="text-[16px]" />
              </div>
              <div className="p-2 rounded bg-primary-container/15 space-y-0.5">
                <div className="flex justify-between items-center text-[10px] text-outline">
                  <span className="uppercase">This event's hash · #{e.seq}</span>
                  <CopyButton value={e.hash} />
                </div>
                <HashText value={e.hash} className="font-bold" />
              </div>
              <div className="flex justify-center text-outline">
                <Icon name="arrow_downward" className="text-[16px]" />
              </div>
              {chain.nextSeq === null ? (
                <div className="p-2 rounded bg-surface-container text-[11px] text-on-surface-variant flex items-center gap-1.5">
                  <Icon name="flag" className="text-[14px] text-secondary" />
                  This is the head of the chain — no later event yet.
                </div>
              ) : (
                <ChainNode
                  title={`Next event #${chain.nextSeq} references this hash`}
                  value={chain.linkedByNext ? e.hash : null}
                  status={chain.linkedByNext ? 'Matches' : 'Mismatch'}
                  ok={Boolean(chain.linkedByNext)}
                  to={`/audit/${chain.nextSeq}`}
                  valueFallback="The next event's prev_hash does not equal this event's hash."
                />
              )}
            </div>

            <div className="p-2.5 rounded bg-surface-container-lowest space-y-1 text-[11px] font-label-sm">
              <div className="flex justify-between text-outline">
                <span>Links to previous</span>
                <span className={chain.linksToPrevious ? 'text-tertiary' : 'text-error'}>{chain.linksToPrevious ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex justify-between text-outline">
                <span>Linked by next</span>
                <span className={chain.linkedByNext === null ? 'text-outline' : chain.linkedByNext ? 'text-tertiary' : 'text-error'}>
                  {chain.linkedByNext === null ? 'n/a (head)' : chain.linkedByNext ? 'Yes' : 'No'}
                </span>
              </div>
              <div className="flex justify-between text-outline">
                <span>Mutability</span>
                <span className="text-on-surface">Append-only (UPDATE/DELETE rejected)</span>
              </div>
            </div>
            <p className="font-body-sm text-[11px] text-outline">
              This page checks the links around this event. To recompute every hash from the first event, use <Link to="/audit" className="text-primary hover:underline">Verify chain</Link> on the audit log.
            </p>
          </div>
          <Panel title="Record identifiers" icon="fingerprint">
            <KV label="Sequence" mono>
              #{e.seq}
            </KV>
            <KV label="Event UUID" mono>
              <span className="text-[11px]">{e.id}</span>
            </KV>
            <KV label="Hash (short)" mono>
              {shortHash(e.hash, 10)}
            </KV>
          </Panel>
        </div>
      </div>

      <Modal open={raw} onClose={() => setRaw(false)} title={`Audit event #${e.seq} — raw record`} icon="data_array" width="max-w-3xl" footer={<CopyButton value={JSON.stringify(e, null, 2)} label="Copy JSON" />}>
        <JsonBlock value={e} className="max-h-[60vh]" />
      </Modal>
    </div>
  );
}

function ChainNode({ title, value, status, ok, to, valueFallback }: { title: string; value: string | null; status: string; ok: boolean; to?: string; valueFallback?: string }) {
  const body = (
    <div className={clsx('p-2 rounded space-y-0.5 transition-colors', ok ? 'bg-surface-container' : 'bg-error-container/30', to && 'hover:bg-surface-container-high')}>
      <div className="flex justify-between text-[10px] text-outline">
        <span className="uppercase">{title}</span>
        <span className={ok ? 'text-tertiary' : 'text-error'}>{status}</span>
      </div>
      {value ? <HashText value={value} tone="text-on-surface-variant" /> : <span className="text-[11px] text-error">{valueFallback}</span>}
    </div>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}
