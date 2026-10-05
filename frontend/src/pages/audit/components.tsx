import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { Icon, type Tone } from '@/components/ui';

export const GENESIS_HASH = '0'.repeat(64);

export const ACTOR_TYPES: { key: string; label: string; icon: string }[] = [
  { key: 'user', label: 'User', icon: 'person' },
  { key: 'device', label: 'Device', icon: 'fingerprint' },
  { key: 'system', label: 'System', icon: 'memory' },
  { key: 'integration', label: 'Integration', icon: 'sync_alt' }
];
export const actorIcon = (t: string | null | undefined) => ACTOR_TYPES.find((a) => a.key === t)?.icon ?? 'help';

export const shortHash = (h: string | null | undefined, n = 6) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : '—');

/** Tone of an action badge, derived from the action verb. */
export function actionTone(action: string | null | undefined): Tone {
  const a = (action ?? '').toLowerCase();
  if (/(delete|deleted|revoke|disabled|decommission|failed|dead_letter|zeroi|purge|wipe|reset|removed|locked)/.test(a)) return 'error';
  if (/(update|updated|changed|override|redeliver|replay|resolved|unlock|acknowledg|mapped|ignored)/.test(a)) return 'warning';
  if (/(create|created|register|provision|activated|enrol|invite|added|imported)/.test(a)) return 'success';
  if (/(login|logout|auth\.|session|mfa|password)/.test(a)) return 'info';
  return 'neutral';
}

const actionCls: Record<Tone, string> = {
  error: 'bg-error-container/40 text-on-error-container',
  warning: 'bg-warning-container/50 text-warning',
  success: 'bg-tertiary-container/25 text-tertiary',
  info: 'bg-secondary-container/20 text-secondary',
  neutral: 'bg-surface-container-highest text-on-surface-variant',
  primary: 'bg-primary-container/20 text-primary'
};

export function ActionBadge({ action, className }: { action: string; className?: string }) {
  return <span className={clsx('px-1.5 py-0.5 rounded font-label-sm text-label-sm font-semibold inline-block whitespace-nowrap', actionCls[actionTone(action)], className)}>{action}</span>;
}

/** Link to the object an audit event refers to, when the dashboard has a page for it. */
export function objectLink(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'user':
      return `/users/${id}`;
    case 'device':
      return `/devices/${id}`;
    case 'employee':
      return `/employees/${id}`;
    case 'location':
      return `/locations/${id}`;
    case 'alert':
      return `/alerts/${id}`;
    case 'sync_run':
      return `/integration/runs/${id}`;
    case 'firmware_deployment':
      return `/firmware/deployments/${id}`;
    case 'attendance_event':
      return `/attendance/events/${id}`;
    case 'settings':
      return `/settings?tab=${encodeURIComponent(id)}`;
    default:
      return null;
  }
}

export function HashText({ value, tone = 'text-tertiary', className }: { value: string | null | undefined; tone?: string; className?: string }) {
  return <span className={clsx('font-mono text-[11px] break-all', tone, className)}>{value ?? '—'}</span>;
}

// ───────────────────────── Before / after diff ─────────────────────────
function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const stable = (v: unknown) => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));

type DiffKind = 'added' | 'removed' | 'changed' | 'same';

/** Side-by-side key diff of two states; changed keys are highlighted on both sides. */
export function StateDiff({ before, after }: { before: unknown; after: unknown }) {
  const [onlyChanged, setOnlyChanged] = useState(false);
  if ((before === null || before === undefined) && (after === null || after === undefined))
    return <p className="font-body-sm text-body-sm text-outline">This event carries no before/after state (for example sign-ins, exports or triggers).</p>;

  if (!isObj(before) && !isObj(after)) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <DiffPane kind="before" title="Before state">
          <pre className="whitespace-pre-wrap break-all">{before === null || before === undefined ? 'null' : pretty(before)}</pre>
        </DiffPane>
        <DiffPane kind="after" title="After state">
          <pre className="whitespace-pre-wrap break-all">{after === null || after === undefined ? 'null' : pretty(after)}</pre>
        </DiffPane>
      </div>
    );
  }

  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  const rows = keys.map((k) => {
    const inB = k in b;
    const inA = k in a;
    const kind: DiffKind = inB && !inA ? 'removed' : !inB && inA ? 'added' : stable(b[k]) === stable(a[k]) ? 'same' : 'changed';
    return { k, kind, bv: b[k], av: a[k], inB, inA };
  });
  const changed = rows.filter((r) => r.kind !== 'same').length;
  const shown = onlyChanged ? rows.filter((r) => r.kind !== 'same') : rows;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 font-label-sm text-label-sm text-outline">
        <span className="flex items-center gap-1.5">
          <Icon name="difference" className="text-[15px] text-secondary" />
          {changed} of {keys.length} key{keys.length === 1 ? '' : 's'} changed
          {before === null || before === undefined ? ' · no previous state (created)' : ''}
          {after === null || after === undefined ? ' · no resulting state (removed)' : ''}
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} className="accent-primary-container" />
          Show changed keys only
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <DiffPane kind="before" title="Before state">
          {shown.map((r) => (
            <DiffLine key={r.k} name={r.k} value={r.bv} present={r.inB} kind={r.kind === 'added' ? 'placeholder' : r.kind === 'same' ? 'same' : 'old'} />
          ))}
        </DiffPane>
        <DiffPane kind="after" title="After state">
          {shown.map((r) => (
            <DiffLine key={r.k} name={r.k} value={r.av} present={r.inA} kind={r.kind === 'removed' ? 'placeholder' : r.kind === 'same' ? 'same' : 'new'} />
          ))}
        </DiffPane>
      </div>
    </div>
  );
}

function DiffPane({ kind, title, children }: { kind: 'before' | 'after'; title: string; children: ReactNode }) {
  return (
    <div className="rounded bg-surface-container-lowest p-2 min-w-0">
      <div className={clsx('font-label-sm text-label-sm font-semibold mb-1 flex items-center gap-1 uppercase tracking-wider', kind === 'before' ? 'text-error' : 'text-tertiary')}>
        <Icon name={kind === 'before' ? 'remove_circle_outline' : 'add_circle_outline'} className="text-[13px]" />
        {title}
      </div>
      <div className="font-mono text-[11px] leading-4 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function DiffLine({ name, value, present, kind }: { name: string; value: unknown; present: boolean; kind: 'old' | 'new' | 'same' | 'placeholder' }) {
  const text = present ? pretty(value) : '';
  return (
    <div
      className={clsx(
        'rounded px-1.5 py-0.5 min-h-[20px]',
        kind === 'old' && 'bg-error-container/30 text-on-error-container',
        kind === 'new' && 'bg-tertiary-container/20 text-tertiary',
        kind === 'same' && 'text-on-surface-variant',
        kind === 'placeholder' && 'text-outline-variant italic'
      )}
    >
      {kind === 'placeholder' ? (
        <span>{name}: (absent)</span>
      ) : (
        <>
          <span className={clsx(kind === 'same' ? 'text-outline' : 'font-semibold')}>{name}</span>
          <span className="text-outline">: </span>
          <span className="whitespace-pre-wrap break-all">{text}</span>
        </>
      )}
    </div>
  );
}
