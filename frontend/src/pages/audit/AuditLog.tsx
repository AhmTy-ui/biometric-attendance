import clsx from 'clsx';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Empty, ErrorState, ExportMenu, Icon, Loading, PageHeader, Pagination, Select, Table, Td, Th, THead, Tr, useDebounced, useErrorToast, useToast } from '@/components/ui';
import { api, download } from '@/lib/api';
import { dateTime, humanize, num, relative } from '@/lib/format';
import { ActionBadge, ACTOR_TYPES, actorIcon, HashText, shortHash } from './components';

const LIMIT = 50;

/** datetime-local value ⇄ ISO string (with offset) */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '');

type Verify = { valid: boolean; checked: number; headHash?: string; brokenAtSeq?: number | string; at: string };

export default function AuditLog() {
  const navigate = useNavigate();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 350);

  const get = (k: string) => sp.get(k) ?? '';
  const filters = {
    q: dq,
    actorType: get('actorType'),
    actorId: get('actorId'),
    action: get('action'),
    objectType: get('objectType'),
    objectId: get('objectId'),
    from: get('from'),
    to: get('to')
  };
  const offset = Number(sp.get('offset') ?? 0) || 0;

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'offset') n.delete('offset');
    setSp(n, { replace: true });
  };
  useEffect(() => {
    if ((sp.get('q') ?? '') !== dq) setParam('q', dq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const list = useQuery<any>({
    queryKey: ['audit', { ...filters, offset }],
    queryFn: () => api.get('/api/audit', { ...filters, limit: LIMIT, offset }),
    placeholderData: keepPreviousData
  });
  const facets = useQuery<any>({ queryKey: ['audit-facets'], queryFn: () => api.get('/api/audit/facets'), staleTime: 60_000 });

  const [verify, setVerify] = useState<Verify | null>(null);
  const verifyM = useMutation({
    mutationFn: () => api.get('/api/audit/verify'),
    onSuccess: (r: any) => {
      setVerify({ ...r, at: new Date().toISOString() });
      if (r.valid) toast({ tone: 'success', title: 'Hash chain verified', description: `${num(r.checked)} events recomputed — no break found.` });
      else toast({ tone: 'error', title: 'Hash chain broken', description: `First mismatch at event #${r.brokenAtSeq}.` });
    },
    onError: (e) => errorToast(e, 'Verification failed')
  });

  const stats = facets.data?.stats;
  const hasFilters = Object.values(filters).some(Boolean);
  const actionOptions: { action: string; n: number }[] = facets.data?.actions ?? [];
  const actionPrefixes = Array.from(new Set(actionOptions.map((a) => a.action.split('.')[0]!))).sort();

  const clearAll = () => {
    setQ('');
    setSp(new URLSearchParams(), { replace: true });
  };

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader title="Audit Log" icon="receipt_long" subtitle="Every change made by users, devices, the integration and the system — append-only and hash-chained." />

      {/* Integrity banner */}
      <div className="relative overflow-hidden rounded bg-surface-container-low p-space-md shadow-md">
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary-container/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col xl:flex-row items-start xl:items-center justify-between gap-space-md z-10">
          <div className="flex items-start gap-space-md">
            <div className="h-10 w-10 shrink-0 rounded bg-surface-container flex items-center justify-center text-tertiary">
              <Icon name="verified_user" className="text-[24px]" />
            </div>
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-headline-sm text-headline-sm text-on-surface tracking-tight">Append-only, SHA-256 hash-chained audit log (FR-5.4 / FR-5.5)</span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-container-high text-tertiary font-label-sm text-label-sm font-semibold">
                  <Icon name="block" className="text-[12px]" />
                  NO EDIT · NO DELETE
                </span>
              </div>
              <p className="font-body-sm text-body-sm text-outline max-w-4xl leading-relaxed">
                Each event stores the hash of the previous event (<span className="font-mono text-on-surface-variant">prev_hash</span>) and its own SHA-256 hash over that link plus the event content. Database triggers reject any UPDATE or DELETE on the table, and there is no edit or delete action in the API or dashboard. Verifying recomputes every hash from the first event.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end xl:self-center">
            <Button icon="lock_reset" loading={verifyM.isPending} onClick={() => verifyM.mutate()}>
              Verify chain
            </Button>
            <ExportMenu
              onExport={async (format) => {
                try {
                  await download('/api/audit/export', { ...filters, format });
                  toast({ tone: 'success', title: 'Export ready', description: `${format.toUpperCase()} download started. The export itself is recorded in the audit log.` });
                } catch (e) {
                  errorToast(e, 'Export failed');
                }
              }}
            />
          </div>
        </div>
        <div
          className={clsx(
            'mt-space-sm flex flex-wrap items-center justify-between gap-2 font-label-sm text-label-sm px-3 py-1.5 rounded',
            !verify ? 'bg-surface-container-lowest/60 text-outline' : verify.valid ? 'bg-tertiary-container/15 text-tertiary' : 'bg-error-container/40 text-on-error-container'
          )}
        >
          {!verify ? (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-outline" />
              Chain not verified in this session — use “Verify chain” to recompute all hashes.
            </span>
          ) : verify.valid ? (
            <span className="flex flex-wrap items-center gap-2">
              <Icon name="check_circle" className="text-[14px]" />
              Chain valid · {num(verify.checked)} events recomputed
              <span className="text-outline-variant">|</span>
              <span className="text-outline">Head hash:</span>
              <span className="font-mono text-on-surface break-all">{verify.headHash ?? '—'}</span>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <Icon name="error" className="text-[14px]" />
              Chain BROKEN at event{' '}
              <Link to={`/audit/${verify.brokenAtSeq}`} className="underline font-mono">
                #{verify.brokenAtSeq}
              </Link>
              · {num(verify.checked)} events before it verified. Investigate immediately — the database may have been modified outside the application.
            </span>
          )}
          {verify && <span className="text-outline">Verified {relative(verify.at)}</span>}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-sm">
        <MetricCard label="Total events" icon="data_object" value={stats ? num(stats.total) : '—'} footer={stats?.first_at ? `Since ${dateTime(stats.first_at)}` : 'No events yet'} />
        <MetricCard label="Last 24 hours" icon="schedule" value={stats ? num(stats.last_24h) : '—'} footer={stats?.last_at ? `Latest ${relative(stats.last_at)}` : '—'} />
        <MetricCard
          label="Chain status"
          icon="account_tree"
          value={!verify ? 'Not verified' : verify.valid ? 'Valid' : 'Broken'}
          tone={!verify ? undefined : verify.valid ? 'text-tertiary' : 'text-error'}
          footer={verify ? `${num(verify.checked)} events checked` : 'Run a verification'}
        />
        <MetricCard label="Distinct actions" icon="tune" value={facets.data ? num(actionOptions.length) : '—'} footer={facets.data ? `${num(facets.data.objectTypes.length)} object types` : '—'} />
      </div>

      {/* Filter toolbar */}
      <div className="rounded bg-surface-container-low p-space-sm shadow-sm flex flex-col gap-space-xs">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-space-sm">
          <div className="flex flex-wrap items-center gap-space-xs flex-1">
            <FilterChip icon="person" label="Actor">
              <select className="bg-transparent text-on-surface font-label-sm focus:outline-none cursor-pointer" value={filters.actorType} onChange={(e) => setParam('actorType', e.target.value)}>
                <option value="">All actor types</option>
                {ACTOR_TYPES.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            </FilterChip>
            <FilterChip icon="tune" label="Action">
              <select className="bg-transparent text-on-surface font-label-sm focus:outline-none cursor-pointer max-w-[240px]" value={filters.action} onChange={(e) => setParam('action', e.target.value)}>
                <option value="">All actions</option>
                {actionPrefixes.map((p) => (
                  <optgroup key={p} label={humanize(p)}>
                    <option value={`${p}.`}>All {p}.* actions</option>
                    {actionOptions
                      .filter((a) => a.action.split('.')[0] === p)
                      .map((a) => (
                        <option key={a.action} value={a.action}>
                          {a.action} ({num(a.n)})
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </FilterChip>
            <FilterChip icon="category" label="Object">
              <select className="bg-transparent text-on-surface font-label-sm focus:outline-none cursor-pointer" value={filters.objectType} onChange={(e) => setParam('objectType', e.target.value)}>
                <option value="">All object types</option>
                {(facets.data?.objectTypes ?? []).map((o: string) => (
                  <option key={o} value={o}>
                    {humanize(o)}
                  </option>
                ))}
              </select>
            </FilterChip>
            <FilterChip icon="tag" label="Object ID">
              <input
                key={filters.objectId}
                defaultValue={filters.objectId}
                placeholder="exact ID"
                className="bg-transparent text-on-surface font-mono text-[11px] focus:outline-none w-28 placeholder:text-outline"
                onBlur={(e) => setParam('objectId', e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setParam('objectId', (e.target as HTMLInputElement).value.trim());
                }}
              />
            </FilterChip>
            <FilterChip icon="date_range" label="From">
              <input
                type="datetime-local"
                className="bg-transparent text-on-surface font-label-sm focus:outline-none [color-scheme:dark]"
                value={toLocalInput(filters.from || null)}
                onChange={(e) => setParam('from', fromLocalInput(e.target.value))}
              />
            </FilterChip>
            <FilterChip icon="event" label="To">
              <input
                type="datetime-local"
                className="bg-transparent text-on-surface font-label-sm focus:outline-none [color-scheme:dark]"
                value={toLocalInput(filters.to || null)}
                onChange={(e) => setParam('to', fromLocalInput(e.target.value))}
              />
            </FilterChip>
          </div>
          <div className="flex items-center gap-space-xs shrink-0">
            <div className="relative w-full sm:w-80">
              <Icon name="search" className="absolute left-2.5 top-2 text-[15px] text-outline" />
              <input
                className="w-full bg-surface-container text-on-surface font-label-sm text-label-sm pl-8 pr-3 py-1.5 rounded placeholder:text-outline focus:outline-none focus:bg-surface-container-high transition-colors"
                placeholder="Search actor, action, object, ID or IP…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <button className="p-1.5 rounded bg-surface-container hover:bg-surface-container-high text-outline hover:text-on-surface transition-colors" onClick={clearAll} title="Reset filters">
              <Icon name="filter_alt_off" className="text-[16px]" />
            </button>
            <button className="p-1.5 rounded bg-surface-container hover:bg-surface-container-high text-outline hover:text-on-surface transition-colors" onClick={() => list.refetch()} title="Reload">
              <Icon name="refresh" className={clsx('text-[16px]', list.isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>
        {filters.actorId && (
          <div className="flex flex-wrap items-center gap-space-xs font-label-sm text-label-sm">
            <ActiveFilter label="Actor ID" value={filters.actorId} onClear={() => setParam('actorId', '')} />
          </div>
        )}
      </div>

      {/* Ledger + inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-md">
        <div className="lg:col-span-8 flex flex-col gap-space-sm min-w-0">
          <div className="flex items-center justify-between px-1 text-outline font-label-sm text-label-sm">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-headline-sm text-on-surface">Event ledger</span>
              {list.data && (
                <span className="bg-surface-container-high text-on-surface-variant px-1.5 rounded font-label-sm">
                  {num(list.data.rows.length)} displayed / {num(list.data.total)} {hasFilters ? 'matching' : 'total'}
                </span>
              )}
            </div>
            <span className="hidden sm:inline">Newest first · click an event to inspect</span>
          </div>
          <div className="rounded bg-surface-container-low shadow-md overflow-hidden">
            {list.isLoading ? (
              <Loading label="Loading audit events…" />
            ) : list.error && !list.data ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : !list.data || list.data.rows.length === 0 ? (
              <Empty
                icon="receipt_long"
                title={hasFilters ? 'No audit events match these filters.' : 'No audit events recorded yet.'}
                action={
                  hasFilters ? (
                    <Button icon="filter_alt_off" onClick={clearAll}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <Table>
                  <THead>
                    <tr>
                      <Th>Seq</Th>
                      <Th>Timestamp</Th>
                      <Th>Actor</Th>
                      <Th>Action</Th>
                      <Th>Object</Th>
                      <Th>IP</Th>
                      <Th className="text-right">Hash</Th>
                    </tr>
                  </THead>
                  <tbody className="text-on-surface">
                    {list.data.rows.map((r: any) => (
                      <Tr key={r.seq} onClick={() => navigate(`/audit/${r.seq}`)}>
                        <Td className="whitespace-nowrap">
                          <span className="font-mono text-[11px] font-bold text-primary">#{r.seq}</span>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <div className="font-mono text-[11px]">{dateTime(r.occurred_at)}</div>
                          <div className="font-label-sm text-label-sm text-outline">{relative(r.occurred_at)}</div>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Icon name={actorIcon(r.actor_type)} className="text-[15px] text-outline" />
                            <div className="flex flex-col min-w-0">
                              <span className="text-body-sm text-on-surface font-medium truncate max-w-[180px]">{r.actor_name ?? r.actor_id ?? humanize(r.actor_type)}</span>
                              <span className="font-label-sm text-[9px] uppercase text-tertiary">
                                {r.actor_type}
                                {r.actor_role ? ` · ${humanize(r.actor_role)}` : ''}
                              </span>
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <ActionBadge action={r.action} />
                        </Td>
                        <Td>
                          <div className="font-label-sm text-label-sm text-on-surface truncate max-w-[200px]">{r.object_label ?? r.object_id ?? '—'}</div>
                          <div className="font-label-sm text-[10px] text-outline">{humanize(r.object_type)}</div>
                        </Td>
                        <Td className="font-mono text-[11px] text-outline whitespace-nowrap">{r.ip ?? (r.device_info ? 'device' : '—')}</Td>
                        <Td className="text-right whitespace-nowrap">
                          <span className="px-1 rounded bg-surface-container font-mono text-[11px] text-tertiary" title={r.hash}>
                            {shortHash(r.hash)}
                          </span>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={(o) => setParam('offset', o ? String(o) : '')} />
              </>
            )}
          </div>
        </div>

        {/* Inspector */}
        <div className="lg:col-span-4 flex flex-col gap-space-sm">
          <div className="rounded bg-surface-container-low p-space-md shadow-md space-y-space-md lg:sticky lg:top-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded bg-surface-container flex items-center justify-center text-primary">
                  <Icon name="gavel" className="text-[18px]" />
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm text-on-surface">Integrity proof</h3>
                  <span className="font-label-sm text-[10px] text-outline block">How tampering is detected</span>
                </div>
              </div>
              <span
                className={clsx(
                  'px-1.5 py-0.5 rounded font-label-sm text-label-sm font-semibold',
                  !verify ? 'bg-surface-container-high text-outline' : verify.valid ? 'bg-tertiary/20 text-tertiary' : 'bg-error-container text-on-error-container'
                )}
              >
                {!verify ? 'UNVERIFIED' : verify.valid ? 'VERIFIED' : 'BROKEN'}
              </span>
            </div>

            <ol className="space-y-1.5 font-label-sm text-label-sm">
              <li className="p-2 rounded bg-surface-container space-y-0.5">
                <div className="text-[10px] text-outline uppercase">1 · Link</div>
                <div className="text-on-surface-variant">Each event copies the previous event's hash into <span className="font-mono text-secondary">prev_hash</span>. The first event links to 64 zeros.</div>
              </li>
              <li className="p-2 rounded bg-surface-container space-y-0.5">
                <div className="text-[10px] text-outline uppercase">2 · Seal</div>
                <div className="text-on-surface-variant">
                  <span className="font-mono text-secondary">hash = SHA-256(prev_hash ‖ canonical event)</span> — covering organisation, time, actor, action, object and before/after state.
                </div>
              </li>
              <li className="p-2 rounded bg-surface-container space-y-0.5">
                <div className="text-[10px] text-outline uppercase">3 · Protect</div>
                <div className="text-on-surface-variant">Database triggers reject UPDATE and DELETE on the audit table. Writers are serialised so the chain stays linear.</div>
              </li>
              <li className="p-2 rounded bg-surface-container space-y-0.5">
                <div className="text-[10px] text-outline uppercase">4 · Verify</div>
                <div className="text-on-surface-variant">Recomputing every hash reveals any altered, inserted or removed event as the first broken link.</div>
              </li>
            </ol>

            {verify && (
              <div className="p-2.5 rounded bg-surface-container-lowest space-y-1 font-label-sm text-label-sm">
                <div className="flex justify-between text-outline">
                  <span>Events checked</span>
                  <span className="text-on-surface">{num(verify.checked)}</span>
                </div>
                <div className="flex justify-between text-outline">
                  <span>Verified at</span>
                  <span className="text-on-surface">{dateTime(verify.at)}</span>
                </div>
                {verify.valid ? (
                  <div className="space-y-0.5">
                    <div className="text-outline">Head hash</div>
                    <HashText value={verify.headHash} />
                  </div>
                ) : (
                  <div className="flex justify-between text-outline">
                    <span>First broken event</span>
                    <Link to={`/audit/${verify.brokenAtSeq}`} className="text-error underline font-mono">
                      #{verify.brokenAtSeq}
                    </Link>
                  </div>
                )}
              </div>
            )}

            <Button className="w-full py-2" icon="check_circle" loading={verifyM.isPending} onClick={() => verifyM.mutate()}>
              {verify ? 'Verify again' : 'Validate hash chain'}
            </Button>
            <p className="font-body-sm text-[11px] text-outline">Exports (CSV / Excel / PDF) include each event's hash so an external copy can be checked against this chain. Exports honour the current filters.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, icon, value, footer, tone }: { label: string; icon: string; value: string; footer: string; tone?: string }) {
  return (
    <div className="rounded bg-surface-container-low p-space-md shadow-sm relative overflow-hidden hover:bg-surface-container transition-colors">
      <div className="flex items-center justify-between mb-1">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">{label}</span>
        <Icon name={icon} className="text-[18px] text-primary" />
      </div>
      <div className={clsx('font-headline-lg text-headline-lg tracking-tight font-bold', tone ?? 'text-on-surface')}>{value}</div>
      <div className="mt-2 text-outline font-label-sm text-label-sm truncate">{footer}</div>
    </div>
  );
}

function FilterChip({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center bg-surface-container rounded px-2 py-1 gap-1.5 text-on-surface-variant font-label-sm text-label-sm">
      <Icon name={icon} className="text-[14px] text-outline" />
      <span className="text-outline">{label}:</span>
      {children}
    </div>
  );
}

function ActiveFilter({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary-container/20 text-primary">
      {label}: <span className="font-mono">{value}</span>
      <button onClick={onClear} className="hover:text-on-surface" aria-label={`Clear ${label}`}>
        <Icon name="close" className="text-[13px]" />
      </button>
    </span>
  );
}
