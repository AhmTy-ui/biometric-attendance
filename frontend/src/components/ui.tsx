import clsx from 'clsx';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
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

// ───────────────────────── Buttons ─────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const btnBase =
  'inline-flex items-center justify-center gap-1.5 rounded font-label-md text-label-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
const btnVariants: Record<BtnVariant, string> = {
  primary: 'bg-primary-container text-on-primary-container hover:bg-inverse-primary font-semibold shadow-sm shadow-primary-container/20',
  secondary: 'bg-surface-container border border-outline-variant/40 text-on-surface hover:bg-surface-container-high',
  ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
  danger: 'bg-error-container text-on-error-container hover:bg-error hover:text-on-error font-semibold',
  subtle: 'bg-primary-container/20 text-primary hover:bg-primary-container/30'
};
const btnSizes = { sm: 'px-2 py-1', md: 'px-3 py-1.5', lg: 'px-4 h-10 text-headline-sm font-headline-sm' };

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
    <button ref={ref} className={clsx(btnBase, btnVariants[variant], btnSizes[size], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Icon name="progress_activity" className="animate-spin text-[15px]" /> : icon ? <Icon name={icon} className="text-[15px]" /> : null}
      {children}
    </button>
  );
});

export function LinkButton({ to, icon, children, variant = 'secondary', size = 'md', className }: { to: string; icon?: string; children: ReactNode; variant?: BtnVariant; size?: keyof typeof btnSizes; className?: string }) {
  return (
    <Link to={to} className={clsx(btnBase, btnVariants[variant], btnSizes[size], className)}>
      {icon && <Icon name={icon} className="text-[15px]" />}
      {children}
    </Link>
  );
}

// ───────────────────────── Badges / status ─────────────────────────
export type Tone = 'success' | 'info' | 'warning' | 'error' | 'neutral' | 'primary';
const toneCls: Record<Tone, string> = {
  success: 'bg-tertiary-container/25 text-tertiary',
  info: 'bg-secondary-container/20 text-secondary',
  warning: 'bg-warning-container/60 text-warning',
  error: 'bg-error-container text-on-error-container',
  neutral: 'bg-surface-container-high text-on-surface-variant',
  primary: 'bg-primary-container text-on-primary-container'
};
const dotCls: Record<Tone, string> = {
  success: 'bg-tertiary',
  info: 'bg-secondary',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-outline',
  primary: 'bg-primary'
};

export function Badge({ tone = 'neutral', children, icon, className }: { tone?: Tone; children: ReactNode; icon?: string; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-label-sm text-label-sm font-semibold uppercase tracking-wide whitespace-nowrap', toneCls[tone], className)}>
      {icon && <Icon name={icon} className="text-[12px]" />}
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={clsx('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', dotCls[tone])} />}
      <span className={clsx('relative inline-flex rounded-full h-2 w-2', dotCls[tone])} />
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
    <div className="flex flex-col gap-space-sm md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {crumbs && (
          <nav className="flex items-center gap-1 font-label-sm text-label-sm text-outline mb-1">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-outline-variant">/</span>}
                {c.to ? (
                  <Link to={c.to} className="hover:text-on-surface">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-on-surface-variant">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-space-sm">
          {icon && (
            <div className="flex items-center justify-center w-9 h-9 rounded bg-primary-container/20 text-primary shrink-0">
              <Icon name={icon} className="text-[22px]" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight truncate">{title}</h1>
            {subtitle && <p className="font-body-sm text-body-sm text-on-surface-variant">{subtitle}</p>}
          </div>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-space-xs shrink-0">{actions}</div>}
    </div>
  );
}

export function Panel({ title, icon, actions, children, className, bodyClassName, accent, subtitle }: { title?: ReactNode; icon?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; accent?: Tone; subtitle?: ReactNode }) {
  return (
    <section className={clsx('bg-surface-container-low rounded-lg shadow-md relative overflow-hidden flex flex-col', className)}>
      {accent && <div className={clsx('absolute top-0 left-0 right-0 h-1', dotCls[accent])} />}
      {(title || actions) && (
        <header className="flex items-center justify-between gap-space-sm px-space-md pt-space-md pb-space-sm">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <Icon name={icon} className="text-[20px] text-primary" />}
            <div className="min-w-0">
              <h2 className="font-headline-sm text-headline-sm text-on-surface truncate">{title}</h2>
              {subtitle && <p className="font-label-sm text-label-sm text-outline">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-space-xs shrink-0">{actions}</div>}
        </header>
      )}
      <div className={clsx('px-space-md pb-space-md flex-1', !title && !actions && 'pt-space-md', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone, icon, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: string; to?: string }) {
  const color = tone === 'success' ? 'text-tertiary' : tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : tone === 'info' ? 'text-secondary' : 'text-on-surface';
  const body = (
    <div className="bg-surface-container rounded p-space-sm flex flex-col gap-0.5 h-full hover:bg-surface-container-high transition-colors">
      <div className="flex items-center justify-between font-label-sm text-label-sm text-outline uppercase tracking-wider">
        <span>{label}</span>
        {icon && <Icon name={icon} className={clsx('text-[16px]', color)} />}
      </div>
      <div className={clsx('font-headline-md text-headline-md font-mono', color)}>{value}</div>
      {hint && <div className="font-label-sm text-label-sm text-outline">{hint}</div>}
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

export function KV({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-space-md py-1.5 border-b border-outline-variant/15 last:border-0">
      <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider shrink-0 pt-0.5">{label}</span>
      <span className={clsx('text-right text-body-sm text-on-surface min-w-0 break-words', mono && 'font-mono')}>{children}</span>
    </div>
  );
}

export function Avatar({ name, tone = 'primary', size = 7 }: { name: string; tone?: Tone; size?: 6 | 7 | 8 | 10 | 14 }) {
  const cls: Record<number, string> = { 6: 'w-6 h-6 text-[10px]', 7: 'w-7 h-7 text-[11px]', 8: 'w-8 h-8 text-[12px]', 10: 'w-10 h-10 text-[14px]', 14: 'w-14 h-14 text-[20px]' };
  const bg: Record<Tone, string> = {
    primary: 'bg-primary-container/30 text-primary',
    info: 'bg-secondary-container/30 text-secondary',
    success: 'bg-tertiary-container/30 text-tertiary',
    warning: 'bg-warning-container text-warning',
    error: 'bg-error-container text-on-error-container',
    neutral: 'bg-surface-container-highest text-on-surface-variant'
  };
  const init = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return <div className={clsx('rounded-full flex items-center justify-center font-mono font-bold shrink-0', cls[size], bg[tone])}>{init || '?'}</div>;
}

export function Progress({ value, tone = 'primary', className }: { value: number; tone?: Tone; className?: string }) {
  return (
    <div className={clsx('w-full bg-surface-container-highest rounded-full h-1.5 overflow-hidden', className)}>
      <div className={clsx('h-full rounded-full transition-all', dotCls[tone])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

// ───────────────────────── Tables ─────────────────────────
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto w-full', className)}>
      <table className="w-full text-left border-collapse font-body-sm text-body-sm">{children}</table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-surface-container-lowest text-outline font-label-sm text-[11px] uppercase tracking-wider select-none">{children}</thead>;
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={clsx('py-2.5 px-space-md font-medium whitespace-nowrap', className)}>{children}</th>;
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
    <tr onClick={onClick} className={clsx('border-t border-outline-variant/20 hover:bg-surface-container transition-colors', onClick && 'cursor-pointer', className)}>
      {children}
    </tr>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-space-sm px-space-md py-space-sm bg-surface-container-lowest/80 font-label-sm text-label-sm text-outline">
      <span>
        {total === 0 ? 'No results' : `Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" icon="chevron_left" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
          Prev
        </Button>
        <span className="px-2 text-on-surface-variant">
          {page} / {pages}
        </span>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
          Next <Icon name="chevron_right" className="text-[15px]" />
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Global states (user flow §26) ─────────────────────────
export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center gap-2 py-10 text-on-surface-variant font-label-md text-label-md', className)}>
      <Icon name="progress_activity" className="animate-spin text-[18px] text-primary" />
      {label}
    </div>
  );
}

export function Empty({ title, description, icon = 'inbox', action }: { title: string; description?: ReactNode; icon?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4">
      <div className="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center">
        <Icon name={icon} className="text-[24px] text-outline" />
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
      <div className={clsx('flex flex-col items-center gap-2 text-center', compact ? 'py-4' : 'py-10')}>
        <Icon name="cloud_off" className="text-[28px] text-secondary" />
        <div className="font-headline-sm text-headline-sm">Connection unavailable.</div>
        <p className="text-body-sm text-on-surface-variant">Showing the latest synchronized data.</p>
        {onRetry && (
          <Button icon="refresh" onClick={onRetry}>
            Try Again
          </Button>
        )}
      </div>
    );
  return (
    <div className={clsx('flex flex-col items-center gap-2 text-center', compact ? 'py-4' : 'py-10')}>
      <Icon name="error" className="text-[28px] text-error" />
      <div className="font-headline-sm text-headline-sm">Something went wrong.</div>
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
      <Icon name="lock" className="text-[28px] text-error" />
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
  'w-full h-9 bg-surface-container-lowest border border-outline-variant/40 rounded px-space-sm text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container disabled:opacity-60';

export function Field({ label, hint, error, children, required }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wide">
        {label}
        {required && <span className="text-error"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="font-body-sm text-body-sm text-outline">{hint}</span>}
      {error && <span className="font-body-sm text-body-sm text-error">{error}</span>}
    </label>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={clsx(inputCls, className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={clsx(inputCls, 'pr-8', className)} {...p}>
      {children}
    </select>
  );
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'h-auto min-h-[80px] py-2', className)} {...p} />;
});
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 disabled:opacity-50">
      <span className={clsx('relative w-9 h-5 rounded-full transition-colors', checked ? 'bg-primary-container' : 'bg-surface-container-highest')}>
        <span className={clsx('absolute top-0.5 w-4 h-4 rounded-full bg-on-surface transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label && <span className="text-body-sm text-on-surface">{label}</span>}
    </button>
  );
}

export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={clsx('relative flex items-center', className)}>
      <Icon name="search" className="absolute left-2.5 text-[18px] text-outline" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={clsx(inputCls, 'h-8 pl-8')} />
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
    <div className="flex items-center gap-1 bg-surface-container-lowest p-1 rounded-lg overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={clsx(
            'flex items-center gap-1.5 px-space-sm py-1.5 rounded font-label-md text-label-md transition-colors whitespace-nowrap',
            value === t.key ? 'bg-surface-container text-on-surface shadow-sm' : 'text-outline hover:text-on-surface'
          )}
        >
          {t.icon && <Icon name={t.icon} className="text-[15px]" />}
          {t.label}
          {t.count !== undefined && <span className="px-1 rounded bg-surface-container-high text-on-surface-variant">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Modal / confirm ─────────────────────────
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg', icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; icon?: string }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={clsx('relative w-full bg-surface-container-low rounded-xl shadow-2xl border border-outline-variant/30 flex flex-col max-h-[90vh]', width)} role="dialog" aria-modal>
        <header className="flex items-center justify-between px-space-lg py-space-md border-b border-outline-variant/20">
          <div className="flex items-center gap-2">
            {icon && <Icon name={icon} className="text-[20px] text-primary" />}
            <h3 className="font-headline-sm text-headline-sm text-on-surface">{title}</h3>
          </div>
          <button onClick={onClose} className="text-outline hover:text-on-surface" aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="px-space-lg py-space-md overflow-y-auto">{children}</div>
        {footer && <footer className="px-space-lg py-space-md border-t border-outline-variant/20 flex justify-end gap-space-sm">{footer}</footer>}
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
}
const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-4), { ...t, id }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.tone === 'error' ? 8000 : 4500);
  }, []);
  const icon: Record<Tone, string> = { success: 'check_circle', error: 'error', warning: 'warning', info: 'info', neutral: 'info', primary: 'info' };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 max-w-md">
          {items.map((t) => (
            <div key={t.id} className="bg-surface-container-highest border border-outline-variant/40 rounded shadow-xl p-space-md flex items-start gap-space-sm">
              <Icon name={icon[t.tone]} className={clsx('text-[20px]', t.tone === 'success' ? 'text-tertiary' : t.tone === 'error' ? 'text-error' : t.tone === 'warning' ? 'text-warning' : 'text-secondary')} />
              <div className="min-w-0">
                <h4 className="font-headline-sm text-body-sm font-semibold text-on-surface">{t.title}</h4>
                {t.description && <p className="font-body-sm text-[11px] text-on-surface-variant break-words">{t.description}</p>}
                {t.action && (
                  <button className="mt-1 font-label-md text-label-md text-primary hover:underline" onClick={t.action.onClick}>
                    {t.action.label}
                  </button>
                )}
              </div>
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
  return (
    <div className="relative">
      <Button icon="download" disabled={disabled} loading={Boolean(busy)} onClick={() => setOpen((o) => !o)}>
        Export
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-50 w-44 bg-surface-container-high border border-outline-variant/40 rounded shadow-xl py-1">
            {(
              [
                ['csv', 'CSV', 'table'],
                ['xlsx', 'Excel (.xlsx)', 'grid_on'],
                ['pdf', 'PDF', 'picture_as_pdf']
              ] as const
            ).map(([f, l, i]) => (
              <button
                key={f}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-body-sm text-on-surface hover:bg-surface-container-highest text-left"
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
    <pre className={clsx('bg-surface-container-lowest rounded p-space-sm font-mono text-[11px] leading-4 text-on-surface-variant overflow-auto max-h-80', className)}>
      {value === null || value === undefined ? 'null' : JSON.stringify(value, null, 2)}
    </pre>
  );
}
