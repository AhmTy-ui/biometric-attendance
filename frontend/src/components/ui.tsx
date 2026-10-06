import clsx from 'clsx';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ApiError } from '@/lib/api';

// ───────────────────────── Icon ─────────────────────────
export function Icon({ name, className, fill, size }: { name: string; className?: string; fill?: boolean; size?: number }) {
  return (
    <span className={clsx('material-symbols-outlined', fill && 'icon-fill', className)} style={size ? { fontSize: size } : undefined} aria-hidden>
      {name}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={clsx('inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded font-sans text-[10.5px] font-medium text-outline bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]', className)}>
      {children}
    </kbd>
  );
}

// ───────────────────────── Buttons ─────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const btnBase =
  'press inline-flex items-center justify-center gap-1.5 rounded-md font-label-md text-label-md font-medium whitespace-nowrap select-none disabled:opacity-45 disabled:cursor-not-allowed disabled:shadow-none';
const btnVariants: Record<BtnVariant, string> = {
  primary:
    'bg-primary-container text-on-primary-container hover:bg-inverse-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_0_1px_rgba(31,124,242,0.7),0_1px_2px_rgba(0,0,0,0.5)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_0_0_1px_rgba(92,200,255,0.55),0_0_20px_-6px_rgba(31,124,242,0.7)]',
  secondary:
    'bg-surface-container-high text-on-surface shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-surface-container-highest hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]',
  ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-white/[0.05]',
  danger: 'bg-error/10 text-error shadow-[inset_0_0_0_1px_rgba(255,122,122,0.28)] hover:bg-error/[0.18] hover:shadow-[inset_0_0_0_1px_rgba(255,122,122,0.45)]',
  subtle: 'bg-primary/10 text-primary shadow-[inset_0_0_0_1px_rgba(92,200,255,0.18)] hover:bg-primary/[0.16]'
};
const btnSizes = { sm: 'px-2.5 py-1 text-[12px]', md: 'px-3 py-[7px]', lg: 'px-4 h-10 text-body-md font-semibold' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: keyof typeof btnSizes;
  icon?: string;
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest },
  ref
) {
  return (
    <button ref={ref} className={clsx(btnBase, btnVariants[variant], btnSizes[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Icon name="progress_activity" className="animate-spin text-[15px]" /> : icon ? <Icon name={icon} className="text-[16px]" /> : null}
      {children}
    </button>
  );
});

export function LinkButton({ to, icon, children, variant = 'secondary', size = 'md', className }: { to: string; icon?: string; children: ReactNode; variant?: BtnVariant; size?: keyof typeof btnSizes; className?: string }) {
  return (
    <Link to={to} className={clsx(btnBase, btnVariants[variant], btnSizes[size], className)}>
      {icon && <Icon name={icon} className="text-[16px]" />}
      {children}
    </Link>
  );
}

// ───────────────────────── Badges / status ─────────────────────────
export type Tone = 'success' | 'info' | 'warning' | 'error' | 'neutral' | 'primary';
const toneCls: Record<Tone, string> = {
  success: 'bg-tertiary/10 text-tertiary ring-tertiary/20',
  info: 'bg-secondary/10 text-secondary ring-secondary/20',
  warning: 'bg-warning/10 text-warning ring-warning/25',
  error: 'bg-error/10 text-error ring-error/25',
  neutral: 'bg-white/[0.04] text-on-surface-variant ring-white/10',
  primary: 'bg-primary/10 text-primary ring-primary/25'
};
const dotCls: Record<Tone, string> = {
  success: 'bg-tertiary',
  info: 'bg-secondary',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-outline',
  primary: 'bg-primary'
};
const textCls: Record<Tone, string> = {
  success: 'text-tertiary',
  info: 'text-secondary',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-outline',
  primary: 'text-primary'
};

export function Badge({ tone = 'neutral', children, icon, className }: { tone?: Tone; children: ReactNode; icon?: string; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 h-5 px-2 rounded-full ring-1 ring-inset font-label-badge text-label-badge uppercase whitespace-nowrap',
        toneCls[tone],
        className
      )}
    >
      {icon && <Icon name={icon} className="text-[12px] -ml-0.5" />}
      {children}
    </span>
  );
}

/** Status dot. `pulse` = live (a soft ring radiates from it). */
export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={clsx('live-dot', textCls[tone], pulse && 'is-pulsing')} aria-hidden />;
}

/** "● Online — Last heartbeat: 4s ago" style live indicator. */
export function LiveDot({ tone = 'success', pulse = true, label, className }: { tone?: Tone; pulse?: boolean; label?: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <span className={clsx('live-dot', textCls[tone], pulse && 'is-pulsing')} aria-hidden />
      {label && <span className={clsx('font-label-md text-label-md', textCls[tone])}>{label}</span>}
    </span>
  );
}

/**
 * Delivery / processing status pill: SUCCESS · RETRYING · FAILED · PENDING · PROCESSING.
 * Retrying spins, processing shows a spinner, success shows a check, failure a warning.
 */
export type PillStatus = 'success' | 'retrying' | 'failed' | 'pending' | 'processing' | 'exported' | 'none';
const PILL: Record<PillStatus, { label: string; tone: Tone; icon: string; spin?: boolean }> = {
  success: { label: 'Success', tone: 'success', icon: 'check' },
  exported: { label: 'Exported', tone: 'success', icon: 'file_export' },
  retrying: { label: 'Retrying', tone: 'warning', icon: 'autorenew', spin: true },
  failed: { label: 'Failed', tone: 'error', icon: 'error' },
  pending: { label: 'Pending', tone: 'info', icon: 'schedule' },
  processing: { label: 'Processing', tone: 'primary', icon: 'progress_activity', spin: true },
  none: { label: 'Not queued', tone: 'neutral', icon: 'remove' }
};
export const pillStatusOf = (deliveryStatus?: string | null): PillStatus =>
  deliveryStatus === 'delivered'
    ? 'success'
    : deliveryStatus === 'exported'
      ? 'exported'
      : deliveryStatus === 'retrying'
        ? 'retrying'
        : deliveryStatus === 'dead_letter'
          ? 'failed'
          : deliveryStatus === 'delivering'
            ? 'processing'
            : deliveryStatus === 'pending'
              ? 'pending'
              : 'none';
export function StatusPill({ status, label, className }: { status: PillStatus; label?: ReactNode; className?: string }) {
  const p = PILL[status];
  return (
    <span className={clsx('inline-flex items-center gap-1 h-[22px] pl-1.5 pr-2 rounded-full ring-1 ring-inset font-label-badge text-label-badge uppercase whitespace-nowrap', toneCls[p.tone], className)}>
      <Icon name={p.icon} className={clsx('text-[13px]', p.spin && 'animate-spin [animation-duration:1.6s]')} />
      {label ?? p.label}
    </span>
  );
}

export const deliveryTone = (s?: string | null): Tone =>
  s === 'delivered' || s === 'exported' ? 'success' : s === 'dead_letter' ? 'error' : s === 'retrying' ? 'warning' : s ? 'info' : 'neutral';
export const severityTone = (s?: string | null): Tone => (s === 'critical' ? 'error' : s === 'warning' ? 'warning' : 'info');
export function deviceTone(d: { lifecycle_state?: string; connectivity?: string; health?: string }): Tone {
  if (d.lifecycle_state && !['connected', 'active'].includes(d.lifecycle_state)) return 'neutral';
  if (d.connectivity === 'offline') return 'error';
  if (d.health === 'warning' || d.health === 'critical') return 'warning';
  return 'success';
}
export function deviceStatusLabel(d: { lifecycle_state?: string; connectivity?: string; health?: string }) {
  if (d.lifecycle_state === 'pending') return 'Pending';
  if (d.lifecycle_state === 'provisioned') return 'Pending activation';
  if (d.lifecycle_state === 'decommissioned') return 'Decommissioned';
  if (d.connectivity === 'offline') return 'Offline';
  if (d.health === 'warning' || d.health === 'critical') return 'Warning';
  return d.lifecycle_state === 'connected' ? 'Connected' : 'Online';
}

// ───────────────────────── Layout primitives ─────────────────────────
export function PageHeader({ title, subtitle, icon, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; icon?: string; actions?: ReactNode; crumbs?: { label: string; to?: string }[] }) {
  return (
    <div className="flex flex-col gap-space-md md:flex-row md:items-end md:justify-between pt-1 pb-1">
      <div className="min-w-0">
        {crumbs && (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 font-label-md text-label-md text-outline mb-2">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <Icon name="chevron_right" className="text-[14px] text-outline-variant" />}
                {c.to ? (
                  <Link to={c.to} className="hover:text-on-surface transition-colors">
                    {c.label}
                  </Link>
                ) : (
                  <span className={i === crumbs.length - 1 ? 'text-on-surface-variant' : undefined}>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex items-start gap-3">
          {icon && (
            <div className="hidden sm:flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-b from-primary/15 to-primary/5 text-primary shrink-0 shadow-[inset_0_0_0_1px_rgba(92,200,255,0.18)]">
              <Icon name={icon} className="text-[22px]" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="font-headline-lg text-headline-lg text-on-surface truncate">{title}</h1>
            {subtitle && <p className="mt-1 font-body-md text-body-md text-on-surface-variant max-w-3xl">{subtitle}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Panel({ title, icon, actions, children, className, bodyClassName, accent, subtitle }: { title?: ReactNode; icon?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; accent?: Tone; subtitle?: ReactNode }) {
  return (
    <section className={clsx('card rounded-xl relative overflow-hidden flex flex-col', className)}>
      {accent && <div className={clsx('absolute top-0 left-4 right-4 h-px opacity-80', dotCls[accent])} />}
      {(title || actions) && (
        <header className="flex items-start justify-between gap-space-sm px-space-md pt-space-md pb-3">
          <div className="flex items-start gap-2.5 min-w-0">
            {icon && <Icon name={icon} className="text-[18px] text-outline mt-px" />}
            <div className="min-w-0">
              <h2 className="font-headline-sm text-headline-sm text-on-surface truncate">{title}</h2>
              {subtitle && <p className="mt-0.5 font-body-sm text-body-sm text-outline">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-space-xs shrink-0">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-space-md pb-space-md flex-1', !title && !actions && 'pt-space-md', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Counts a formatted number up from its previous value when it first appears or changes ("1,234", "98.4%", "12 ms").
 * Non-numeric values render as-is.
 */
export function CountUp({ value, duration = 700 }: { value: ReactNode; duration?: number }) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  const m = text ? /^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/.exec(text) : null;
  const target = m ? Number(m[2].replace(/,/g, '')) : NaN;
  const decimals = m && m[2].includes('.') ? m[2].split('.')[1].length : 0;
  const [shown, setShown] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target);
      prev.current = target;
      return;
    }
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      setShown(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  if (!m || !Number.isFinite(target)) return <>{value}</>;
  const formatted = shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: m[2].includes(',') || Math.abs(target) >= 1000 });
  return (
    <>
      {m[1]}
      {formatted}
      {m[3]}
    </>
  );
}

export interface Trend {
  /** Text shown next to the arrow, e.g. "+12 vs yesterday". */
  label: ReactNode;
  direction: 'up' | 'down' | 'flat';
  /** Whether this direction is good news (colours the trend). */
  good?: boolean;
}

/**
 * Metric card: label, large value, supporting context, optional real trend, a minimal icon and a status colour.
 * Hover: slight elevation and a border highlight.
 */
export function Stat({ label, value, hint, tone, icon, to, trend }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: string; to?: string; trend?: Trend }) {
  const valueColor = tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-on-surface';
  const iconBox = tone ? toneCls[tone] : 'bg-white/[0.04] text-outline ring-white/10';
  const body = (
    <div className={clsx('card lift rounded-xl p-4 flex flex-col gap-2 h-full', to && 'cursor-pointer')}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-label-md text-label-md text-on-surface-variant truncate">{label}</span>
        {icon && (
          <span className={clsx('flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-inset shrink-0', iconBox)}>
            <Icon name={icon} className="text-[16px]" />
          </span>
        )}
      </div>
      <div className={clsx('text-[26px] leading-8 font-semibold tracking-[-0.03em] tabular truncate', valueColor)}>
        <CountUp value={value} />
      </div>
      {(hint || trend) && (
        <div className="flex items-center gap-2 font-body-sm text-body-sm text-outline min-w-0">
          {trend && (
            <span
              className={clsx(
                'inline-flex items-center gap-0.5 font-medium shrink-0',
                trend.direction === 'flat' ? 'text-outline' : trend.good ? 'text-tertiary' : 'text-error'
              )}
            >
              <Icon name={trend.direction === 'up' ? 'arrow_upward' : trend.direction === 'down' ? 'arrow_downward' : 'arrow_forward'} className="text-[13px]" />
              {trend.label}
            </span>
          )}
          {hint && <span className="line-clamp-2">{hint}</span>}
        </div>
      )}
    </div>
  );
  return to ? (
    <Link to={to} className="block rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * Makes a page's side column collapsible. Place it as the first child inside the side column (a direct child of a
 * CSS grid, or anything inside it). Collapsing hides the column's content, shrinks it to a slim rail and lets the
 * main column take the width; clicking the rail expands it again. Only active while the columns sit side by side
 * (the `lg:`/`xl:` breakpoint the column is laid out at); the choice is remembered per panel.
 */
export function SideToggle({ id, label = 'Details' }: { id: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const key = `bamp.side.${id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setCollapsed(v);
      try {
        localStorage.setItem(key, v ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
    },
    [key]
  );
  useEffect(() => {
    // The host = the ancestor that is a direct child of a 12-column grid (main column(s) + this side column).
    let host: HTMLElement | null = ref.current;
    while (host?.parentElement && !/col-span-/.test(host.className) && host.parentElement.tagName !== 'MAIN') host = host.parentElement;
    if (!host?.parentElement || !/col-span-/.test(host.className)) return;
    const h = host;
    const bp = /(^|\s)lg:col-span/.test(h.className) && !/(^|\s)xl:col-span/.test(h.className) ? 'lg' : 'xl';
    const mq = window.matchMedia(`(min-width: ${bp === 'lg' ? 1024 : 1280}px)`);
    h.dataset.sideBp = bp;
    h.dataset.sideLabel = label;
    let widened: HTMLElement[] = [];
    const span = (el: HTMLElement) => Number(/span\s+(\d+)/.exec(getComputedStyle(el).gridColumnEnd)?.[1] ?? 0);
    const clear = () => {
      for (const el of widened) el.style.gridColumn = '';
      widened = [];
      h.style.gridColumn = '';
      h.dataset.sideCollapsed = 'false';
    };
    const apply = () => {
      clear();
      if (!collapsed || !mq.matches) return;
      // Measure while expanded: the columns sharing this row get the width the side column gives up.
      const hr = h.getBoundingClientRect();
      const own = span(h);
      if (own <= 1) return;
      const mates = Array.from(h.parentElement!.children).filter((c): c is HTMLElement => {
        if (c === h || !(c instanceof HTMLElement)) return false;
        const r = c.getBoundingClientRect();
        return r.top < hr.bottom && r.bottom > hr.top && span(c) > 0;
      });
      if (!mates.length) return;
      const widest = mates.reduce((a, b) => (span(b) > span(a) ? b : a));
      widest.style.gridColumn = `span ${span(widest) + own - 1} / span ${span(widest) + own - 1}`;
      widened = [widest];
      h.style.gridColumn = 'span 1 / span 1';
      h.dataset.sideCollapsed = 'true';
    };
    apply();
    mq.addEventListener('change', apply);
    const expand = (e: MouseEvent) => {
      if (h.dataset.sideCollapsed === 'true') {
        e.preventDefault();
        e.stopPropagation();
        set(false);
      }
    };
    h.addEventListener('click', expand, true);
    return () => {
      mq.removeEventListener('change', apply);
      h.removeEventListener('click', expand, true);
      clear();
    };
  }, [collapsed, label, set]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => set(true)}
      title={`Hide ${label.toLowerCase()} panel`}
      className="side-toggle press self-end ml-auto items-center gap-1 px-2 py-0.5 rounded-md font-label-sm text-label-sm text-outline hover:text-on-surface hover:bg-white/[0.05]"
    >
      Hide panel
      <Icon name="right_panel_close" className="text-[15px]" />
    </button>
  );
}

export function KV({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-space-md py-2 border-b border-white/[0.05] last:border-0">
      <span className="font-label-md text-label-md text-outline shrink-0 pt-px">{label}</span>
      <span className={clsx('text-right text-body-sm text-on-surface min-w-0 break-words', mono && 'font-mono text-[12px]')}>{children}</span>
    </div>
  );
}

export function Avatar({ name, tone = 'primary', size = 7 }: { name: string; tone?: Tone; size?: 6 | 7 | 8 | 10 | 14 }) {
  const cls: Record<number, string> = { 6: 'w-6 h-6 text-[10px]', 7: 'w-7 h-7 text-[11px]', 8: 'w-8 h-8 text-[12px]', 10: 'w-10 h-10 text-[14px]', 14: 'w-14 h-14 text-[20px]' };
  const bg: Record<Tone, string> = {
    primary: 'bg-gradient-to-br from-primary/25 to-secondary-container/25 text-primary-fixed',
    info: 'bg-secondary/15 text-secondary',
    success: 'bg-tertiary/15 text-tertiary',
    warning: 'bg-warning/15 text-warning',
    error: 'bg-error/15 text-error',
    neutral: 'bg-white/[0.06] text-on-surface-variant'
  };
  const init = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return (
    <div className={clsx('rounded-full flex items-center justify-center font-semibold shrink-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]', cls[size], bg[tone])} aria-hidden>
      {init || '?'}
    </div>
  );
}

export function Progress({ value, tone = 'primary', className, indeterminate }: { value: number; tone?: Tone; className?: string; indeterminate?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={clsx('w-full bg-white/[0.06] rounded-full h-1.5 overflow-hidden', indeterminate && 'indeterminate', className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {!indeterminate && <div className={clsx('h-full rounded-full transition-[width] duration-500 ease-settle', dotCls[tone])} style={{ width: `${v}%` }} />}
    </div>
  );
}

// ───────────────────────── Tables ─────────────────────────
/** `maxHeight` turns the wrapper into a vertical scroller so the header stays pinned while rows scroll. */
export function Table({ children, className, maxHeight }: { children: ReactNode; className?: string; maxHeight?: number | string }) {
  return (
    <div className={clsx('overflow-x-auto w-full', maxHeight !== undefined && 'overflow-y-auto', className)} style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <table className="w-full text-left border-collapse font-body-sm text-body-sm">{children}</table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-[#0e1013] text-outline font-label-sm text-[11px] uppercase tracking-[0.05em] select-none shadow-[inset_0_-1px_0_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.04)]">
      {children}
    </thead>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th scope="col" className={clsx('h-9 px-space-md font-medium whitespace-nowrap', className)}>
      {children}
    </th>
  );
}
export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={clsx('py-2.5 px-space-md align-middle', className)}>
      {children}
    </td>
  );
}
export function Tr({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <tr
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      tabIndex={onClick ? 0 : undefined}
      className={clsx(
        'border-t border-white/[0.05] first:border-t-0 transition-colors duration-150 hover:bg-white/[0.025]',
        onClick && 'cursor-pointer focus-visible:outline-none focus-visible:bg-primary/[0.06]',
        className
      )}
    >
      {children}
    </tr>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-space-sm px-space-md py-2.5 border-t border-white/[0.05] font-label-md text-label-md text-outline">
      <span className="tabular">
        {total === 0 ? 'No results' : (
          <>
            Showing <span className="text-on-surface-variant">{offset + 1}–{Math.min(offset + limit, total)}</span> of{' '}
            <span className="text-on-surface-variant">{total.toLocaleString()}</span>
          </>
        )}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" icon="chevron_left" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))} aria-label="Previous page">
          Prev
        </Button>
        <span className="px-2 text-on-surface-variant tabular">
          {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onChange(offset + limit)} aria-label="Next page">
          Next <Icon name="chevron_right" className="text-[16px]" />
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Global states (user flow §26) ─────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}

/** Loading state: skeleton rows shaped like the list/table content that is about to appear. */
export function Loading({ label = 'Loading…', className, rows = 4 }: { label?: string; className?: string; rows?: number }) {
  const widths = ['w-2/5', 'w-1/3', 'w-1/2', 'w-1/4', 'w-2/5', 'w-1/3'];
  return (
    <div role="status" aria-live="polite" className={clsx('flex flex-col gap-3 py-5 px-1', className)}>
      <div className="flex items-center gap-2 font-label-md text-label-md text-outline">
        <Icon name="progress_activity" className="animate-spin text-[15px] text-primary" />
        <span>{label}</span>
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3" style={{ opacity: 1 - i * 0.18 }}>
          <Skeleton className="w-7 h-7 rounded-full shrink-0" />
          <div className="flex-1 flex flex-col gap-1.5">
            <Skeleton className={clsx('h-2.5', widths[i % widths.length])} />
            <Skeleton className="h-2 w-1/5" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full hidden sm:block" />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, description, icon = 'inbox', action, tone }: { title: string; description?: ReactNode; icon?: string; action?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
      <div
        className={clsx(
          'w-11 h-11 rounded-full flex items-center justify-center ring-1 ring-inset mb-1',
          tone ? toneCls[tone] : 'bg-white/[0.04] text-outline ring-white/10'
        )}
      >
        <Icon name={icon} className={clsx('text-[22px]', tone === 'success' && 'check-pop')} />
      </div>
      <div className="font-headline-sm text-headline-sm text-on-surface">{title}</div>
      {description && <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const e = error as ApiError;
  if (e?.status === 403) return <PermissionDenied />;
  if (e?.status === 0)
    return (
      <div className={clsx('flex flex-col items-center gap-2 text-center', compact ? 'py-4' : 'py-10')} role="alert">
        <div className="w-11 h-11 rounded-full flex items-center justify-center bg-secondary/10 text-secondary ring-1 ring-inset ring-secondary/20">
          <Icon name="cloud_off" className="text-[22px]" />
        </div>
        <div className="font-headline-sm text-headline-sm">Connection unavailable</div>
        <p className="text-body-sm text-on-surface-variant">Showing the latest synchronized data.</p>
        {onRetry && (
          <Button icon="refresh" onClick={onRetry}>
            Try Again
          </Button>
        )}
      </div>
    );
  return (
    <div className={clsx('flex flex-col items-center gap-2 text-center', compact ? 'py-4' : 'py-10')} role="alert">
      <div className="w-11 h-11 rounded-full flex items-center justify-center bg-error/10 text-error ring-1 ring-inset ring-error/25">
        <Icon name="error" className="text-[22px]" />
      </div>
      <div className="font-headline-sm text-headline-sm">Something went wrong</div>
      {e?.message && <p className="text-body-sm text-on-surface-variant max-w-md">{e.message}</p>}
      {onRetry && (
        <Button icon="refresh" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  );
}

export function PermissionDenied() {
  return (
    <div className="flex flex-col items-center gap-2 text-center py-10">
      <div className="w-11 h-11 rounded-full flex items-center justify-center bg-white/[0.04] text-outline ring-1 ring-inset ring-white/10">
        <Icon name="lock" className="text-[22px]" />
      </div>
      <div className="font-headline-sm text-headline-sm">Permission denied</div>
      <p className="text-body-sm text-on-surface-variant">You don't have permission to access this resource.</p>
    </div>
  );
}

/** Wraps a react-query result with the standard loading / error / empty states. */
export function QueryState<T>({ q, children, empty, loadingLabel }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; children: (d: T) => ReactNode; empty?: (d: T) => ReactNode | null; loadingLabel?: string }) {
  if (q.isLoading) return <Loading label={loadingLabel} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const e = empty?.(q.data);
  if (e) return <>{e}</>;
  return <>{children(q.data)}</>;
}

// ───────────────────────── Forms ─────────────────────────
const inputCls =
  'w-full h-9 bg-surface-container-lowest rounded-md px-3 text-body-md text-on-surface placeholder:text-outline/80 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(92,200,255,0.6),0_0_0_3px_rgba(31,124,242,0.22)] transition-shadow duration-150 disabled:opacity-60 disabled:cursor-not-allowed';

export function Field({ label, hint, error, children, required }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-label-md text-label-md text-on-surface-variant">
        {label}
        {required && <span className="text-error"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="font-body-sm text-body-sm text-outline">{hint}</span>}
      {error && (
        <span className="font-body-sm text-body-sm text-error flex items-center gap-1" role="alert">
          <Icon name="error" className="text-[14px]" />
          {error}
        </span>
      )}
    </label>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={clsx(inputCls, className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={clsx(inputCls, 'pr-8 cursor-pointer', className)} {...p}>
      {children}
    </select>
  );
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'h-auto min-h-[80px] py-2', className)} {...p} />;
});
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="group inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
      <span
        className={clsx(
          'relative w-9 h-5 rounded-full transition-colors duration-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]',
          checked ? 'bg-primary-container' : 'bg-surface-container-highest group-hover:bg-surface-bright'
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-settle',
            checked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </span>
      {label && <span className="text-body-sm text-on-surface">{label}</span>}
    </button>
  );
}

export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={clsx('relative flex items-center', className)}>
      <Icon name="search" className="absolute left-2.5 text-[17px] text-outline pointer-events-none" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder ?? 'Search'} className={clsx(inputCls, 'h-8 pl-8', value && 'pr-8')} />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute right-1.5 p-0.5 rounded text-outline hover:text-on-surface" aria-label="Clear search">
          <Icon name="close" className="text-[15px]" />
        </button>
      )}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ───────────────────────── Tabs ─────────────────────────
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; icon?: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex items-center gap-0.5 bg-surface-container-lowest p-1 rounded-lg overflow-x-auto max-w-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={clsx(
              'press flex items-center gap-1.5 h-7 px-2.5 rounded-md font-label-md text-label-md whitespace-nowrap',
              active ? 'bg-surface-container-high text-on-surface shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.4)]' : 'text-outline hover:text-on-surface'
            )}
          >
            {t.icon && <Icon name={t.icon} className={clsx('text-[15px]', active && 'text-primary')} />}
            {t.label}
            {t.count !== undefined && (
              <span key={t.count} className={clsx('tick min-w-[18px] px-1 rounded-full text-[10.5px] tabular text-center', active ? 'bg-primary/15 text-primary' : 'bg-white/[0.06] text-on-surface-variant')}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Modal / confirm ─────────────────────────
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; icon?: string }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => {
      window.removeEventListener('keydown', h);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="overlay-in absolute inset-0 bg-black/65 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={box}
        tabIndex={-1}
        className={clsx('dialog-in relative w-full bg-surface-container-low rounded-2xl shadow-pop flex flex-col max-h-[90vh] focus:outline-none', width)}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
      >
        <header className="flex items-center justify-between px-space-lg py-space-md border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            {icon && (
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Icon name={icon} className="text-[18px]" />
              </span>
            )}
            <h3 id={titleId} className="font-headline-sm text-[15px] text-on-surface">
              {title}
            </h3>
          </div>
          <button onClick={onClose} className="press p-1 rounded-md text-outline hover:text-on-surface hover:bg-white/[0.05]" aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="px-space-lg py-space-md overflow-y-auto">{children}</div>
        {footer && <footer className="px-space-lg py-space-md border-t border-white/[0.06] flex justify-end gap-space-sm bg-black/10 rounded-b-2xl">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon={danger ? 'warning' : 'help'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-body-md text-on-surface-variant">{message}</div>
    </Modal>
  );
}

// ───────────────────────── Toasts ─────────────────────────
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  leaving?: boolean;
}
const ToastCtx = createContext<(t: Omit<ToastItem, 'id' | 'leaving'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setItems((s) => s.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 200);
  }, []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id' | 'leaving'>) => {
      const id = Date.now() + Math.random();
      setItems((s) => [...s.slice(-4), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === 'error' ? 8000 : 4500);
    },
    [dismiss]
  );
  const icon: Record<Tone, string> = { success: 'check_circle', error: 'cancel', warning: 'warning', info: 'info', neutral: 'info', primary: 'info' };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[200] flex flex-col items-end gap-2" aria-live="polite" aria-relevant="additions">
          {items.map((t) => (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                t.leaving ? 'toast-out' : 'toast-in',
                'relative w-full sm:w-[380px] overflow-hidden bg-surface-container-high rounded-xl shadow-pop p-3.5 pr-10 flex items-start gap-3'
              )}
            >
              <span className={clsx('absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full', dotCls[t.tone])} />
              <Icon name={icon[t.tone]} fill className={clsx('text-[20px] mt-px check-pop', textCls[t.tone])} />
              <div className="min-w-0">
                <h4 className="font-body-md text-body-md font-semibold text-on-surface">{t.title}</h4>
                {t.description && <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant break-words">{t.description}</p>}
                {t.action && (
                  <button
                    className="mt-1.5 font-label-md text-label-md text-primary hover:underline"
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button onClick={() => dismiss(t.id)} className="absolute top-2.5 right-2.5 p-0.5 rounded text-outline hover:text-on-surface" aria-label="Dismiss notification">
                <Icon name="close" className="text-[16px]" />
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastCtx.Provider>
  );
}

/** Convenience: show API errors as toasts. */
export function useErrorToast() {
  const toast = useToast();
  return useCallback((err: unknown, title = 'Action failed') => {
    const e = err as ApiError;
    const details = Array.isArray(e?.details) ? e.details.map((d: any) => (typeof d === 'string' ? d : `${d.path ? d.path + ': ' : ''}${d.message}`)).join(' · ') : undefined;
    toast({ tone: 'error', title, description: [e?.message, details].filter(Boolean).join(' — ') });
  }, [toast]);
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={done ? 'check' : 'content_copy'}
      className={done ? 'text-tertiary' : undefined}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function ExportMenu({ onExport, disabled }: { onExport: (format: 'csv' | 'xlsx' | 'pdf') => Promise<void> | void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
  return (
    <div className="relative">
      <Button icon="download" disabled={disabled} loading={Boolean(busy)} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        Export
        <Icon name="expand_more" className={clsx('text-[16px] -mr-1 transition-transform duration-200', open && 'rotate-180')} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="drop-in absolute right-0 mt-1.5 z-50 w-48 bg-surface-container-high rounded-lg shadow-pop p-1">
            {(
              [
                ['csv', 'CSV', 'table'],
                ['xlsx', 'Excel (.xlsx)', 'grid_on'],
                ['pdf', 'PDF', 'picture_as_pdf']
              ] as const
            ).map(([f, l, i]) => (
              <button
                key={f}
                role="menuitem"
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-body-sm text-on-surface hover:bg-white/[0.06] text-left transition-colors"
                onClick={async () => {
                  setOpen(false);
                  setBusy(f);
                  try {
                    await onExport(f);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Icon name={i} className="text-[16px] text-outline" />
                {l}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={clsx('well rounded-lg p-space-sm font-mono text-[11px] leading-4 text-on-surface-variant overflow-auto max-h-80', className)}>
      {value === null || value === undefined ? 'null' : JSON.stringify(value, null, 2)}
    </pre>
  );
}
