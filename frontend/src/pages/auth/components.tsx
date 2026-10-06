import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, CopyButton, Dot, Icon, type Tone } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth, type Me } from '@/lib/auth';
import { dateTime, relative, time } from '@/lib/format';

/* ════════════════════════════════════════════════════════════════════════════
 * Public platform health (GET /health — unauthenticated)
 * ════════════════════════════════════════════════════════════════════════════ */

export interface HealthComponents {
  api: boolean;
  database: boolean;
  redis: boolean;
  mqtt: boolean;
  objectStorage: boolean;
}
export interface HealthReport {
  status: 'ok' | 'degraded';
  components: HealthComponents;
  time: string;
  /** Browser → API round trip for this health probe. */
  latencyMs: number;
  checkedAt: number;
}

/** /health answers 503 with a body when degraded, so it is fetched raw (api.get would discard the body). */
export async function fetchHealth(): Promise<HealthReport> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch('/health', { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'Connection unavailable.');
  }
  const latencyMs = Math.round(performance.now() - started);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body?.components) throw new ApiError(res.status, 'health_unavailable', `Health endpoint returned HTTP ${res.status}.`);
  return { status: body.status === 'ok' ? 'ok' : 'degraded', components: body.components, time: body.time, latencyMs, checkedAt: Date.now() };
}

export function useHealth(intervalMs = 30_000) {
  return useQuery<HealthReport, ApiError>({
    queryKey: ['public-health'],
    queryFn: fetchHealth,
    refetchInterval: intervalMs,
    retry: false,
    refetchOnWindowFocus: true
  });
}

export const HEALTH_COMPONENTS: { key: keyof HealthComponents; label: string; description: string; icon: string }[] = [
  { key: 'api', label: 'Dashboard API', description: 'REST API and session gateway', icon: 'api' },
  { key: 'database', label: 'Database', description: 'PostgreSQL system of record', icon: 'database' },
  { key: 'redis', label: 'Cache & queues', description: 'Redis: settings cache, rate limits, job locks', icon: 'memory' },
  { key: 'mqtt', label: 'Device broker', description: 'MQTT link to fingerprint terminals', icon: 'settings_input_antenna' },
  { key: 'objectStorage', label: 'Object storage', description: 'Templates, firmware, exports, backups', icon: 'inventory_2' }
];

export function healthSummary(h: { data?: HealthReport; isLoading: boolean; error: unknown }): { tone: Tone; label: string } {
  if (h.isLoading) return { tone: 'warning', label: 'Checking…' };
  if (!h.data) return { tone: 'error', label: 'Unreachable' };
  const down = HEALTH_COMPONENTS.filter((c) => !h.data!.components[c.key]).length;
  if (h.data.status !== 'ok') return { tone: 'error', label: 'Degraded' };
  if (down > 0) return { tone: 'warning', label: `${down} component${down === 1 ? '' : 's'} down` };
  return { tone: 'success', label: 'Operational' };
}

const toneText: Record<Tone, string> = {
  success: 'text-tertiary',
  warning: 'text-warning',
  error: 'text-error',
  info: 'text-secondary',
  neutral: 'text-on-surface-variant',
  primary: 'text-primary'
};
const toneChip: Record<Tone, string> = {
  success: 'text-tertiary bg-tertiary-container/20',
  warning: 'text-warning bg-warning-container/60',
  error: 'text-error bg-error-container/30',
  info: 'text-secondary bg-primary-container/20',
  neutral: 'text-on-surface-variant bg-surface-container-high',
  primary: 'text-on-primary-container bg-primary-container'
};

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={clsx('font-label-sm text-label-sm px-space-xs py-0.5 rounded uppercase whitespace-nowrap', toneChip[tone])}>{children}</span>;
}

const isHttps = () => typeof window !== 'undefined' && window.location.protocol === 'https:';

/* ════════════════════════════════════════════════════════════════════════════
 * Template chrome: telemetry bar, split layout, footer
 * ════════════════════════════════════════════════════════════════════════════ */

export function TelemetryBar() {
  const h = useHealth();
  const s = healthSummary(h);
  const tls = isHttps();
  return (
    <div className="w-full flex flex-wrap items-center justify-between gap-gutter-dense mb-space-md bg-surface-container-lowest px-space-md py-space-xs rounded-lg shadow-sm">
      <div className="flex items-center gap-space-sm min-w-0">
        <Dot tone={s.tone} pulse={s.tone === 'success'} />
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">BAMP Attendance Platform</span>
        <span className="font-label-sm text-label-sm text-outline">/</span>
        <span className={clsx('font-label-sm text-label-sm truncate', toneText[s.tone])}>{typeof window !== 'undefined' ? window.location.host : ''}</span>
      </div>
      <div className="flex items-center gap-space-md text-on-surface-variant font-label-sm text-label-sm">
        <span className="hidden sm:inline">
          TLS: <strong className={clsx('font-medium', tls ? 'text-tertiary' : 'text-warning')}>{tls ? 'ON' : 'OFF'}</strong>
        </span>
        <span className="text-outline hidden sm:inline">|</span>
        <span>
          API RTT: <strong className="text-secondary font-medium">{h.data ? `${h.data.latencyMs}ms` : '—'}</strong>
        </span>
        <span className="text-outline">|</span>
        <span>
          AUDIT LOG: <strong className="text-on-surface font-medium">APPEND-ONLY</strong>
        </span>
      </div>
    </div>
  );
}

function PlatformStatusCard() {
  const h = useHealth();
  const s = healthSummary(h);
  return (
    <div className="bg-surface-container rounded-lg p-space-md shadow-inner flex flex-col gap-space-sm">
      <div className="flex items-center justify-between gap-space-sm">
        <span className="font-label-md text-label-md text-on-surface uppercase tracking-wider">Platform components</span>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <div className="bg-surface-container-lowest rounded p-space-sm flex flex-col divide-y divide-outline-variant/15">
        {HEALTH_COMPONENTS.map((c) => {
          const up = h.data?.components[c.key];
          const tone: Tone = h.isLoading ? 'neutral' : !h.data ? 'error' : up ? 'success' : 'error';
          return (
            <div key={c.key} className="flex items-center justify-between gap-space-sm py-1.5">
              <div className="flex items-center gap-space-sm min-w-0">
                <Icon name={c.icon} className={clsx('text-[18px]', toneText[tone])} />
                <div className="min-w-0">
                  <div className="font-body-sm text-body-sm text-on-surface">{c.label}</div>
                  <div className="font-label-sm text-label-sm text-outline truncate">{c.description}</div>
                </div>
              </div>
              <span className={clsx('flex items-center gap-1.5 font-label-sm text-label-sm uppercase shrink-0', toneText[tone])}>
                <Dot tone={tone} />
                {h.isLoading ? 'Checking' : !h.data ? 'No answer' : up ? 'Up' : 'Down'}
              </span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-space-xs text-center pt-space-xs">
        <div className="bg-surface-container-low p-space-xs rounded">
          <span className="block font-label-sm text-label-sm text-outline">API ROUND-TRIP</span>
          <span className="font-label-md text-label-md text-secondary">{h.data ? `${h.data.latencyMs} ms` : '—'}</span>
        </div>
        <div className="bg-surface-container-low p-space-xs rounded">
          <span className="block font-label-sm text-label-sm text-outline">SERVER TIME UTC</span>
          <span className="font-label-md text-label-md text-on-surface">{h.data?.time ? time(h.data.time, 'UTC') : '—'}</span>
        </div>
        <div className="bg-surface-container-low p-space-xs rounded">
          <span className="block font-label-sm text-label-sm text-outline">LAST CHECK</span>
          <span className="font-label-md text-label-md text-on-surface">{h.data ? relative(new Date(h.data.checkedAt)) : h.error ? 'failed' : '—'}</span>
        </div>
      </div>
      {h.error && !h.data && (
        <div className="flex items-center justify-between gap-space-sm font-body-sm text-body-sm text-on-surface-variant">
          <span>{h.error.message}</span>
          <button type="button" className="font-label-sm text-label-sm text-secondary hover:underline" onClick={() => void h.refetch()}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function SecurityPosture() {
  const tls = isHttps();
  const items: { icon: string; iconCls: string; title: string; desc: string; chip: string; tone: Tone }[] = [
    {
      icon: tls ? 'lock' : 'lock_open',
      iconCls: tls ? 'text-tertiary' : 'text-warning',
      title: 'Encrypted transport',
      desc: tls ? 'This connection uses HTTPS; the server sends HSTS.' : 'This connection is not using HTTPS.',
      chip: tls ? 'TLS' : 'HTTP',
      tone: tls ? 'success' : 'warning'
    },
    {
      icon: 'phonelink_lock',
      iconCls: 'text-secondary',
      title: 'Multi-factor authentication',
      desc: 'Authenticator-app TOTP codes, with single-use recovery codes.',
      chip: 'TOTP',
      tone: 'info'
    },
    {
      icon: 'gpp_maybe',
      iconCls: 'text-error',
      title: 'Account lockout',
      desc: 'Repeated failed password or code attempts lock the account temporarily.',
      chip: 'Enforced',
      tone: 'error'
    },
    {
      icon: 'policy',
      iconCls: 'text-tertiary',
      title: 'Append-only audit log',
      desc: 'Sign-ins, failures and lockouts are written to a SHA-256 hash-chained log.',
      chip: 'Audited',
      tone: 'success'
    },
    {
      icon: 'cookie',
      iconCls: 'text-secondary',
      title: 'Session protection',
      desc: 'HttpOnly, SameSite=Strict cookie with idle and absolute timeouts. Passwords hashed with Argon2id.',
      chip: 'Enforced',
      tone: 'info'
    }
  ];
  return (
    <div className="flex flex-col gap-space-xs">
      <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Security posture</span>
      {items.map((i) => (
        <div key={i.title} className="bg-surface-container rounded p-space-sm flex items-center justify-between gap-space-sm">
          <div className="flex items-center gap-space-sm min-w-0">
            <Icon name={i.icon} className={clsx('text-[20px] shrink-0', i.iconCls)} />
            <div className="min-w-0">
              <div className="font-headline-sm text-body-sm text-on-surface">{i.title}</div>
              <div className="font-body-sm text-body-sm text-outline">{i.desc}</div>
            </div>
          </div>
          <Chip tone={i.tone}>{i.chip}</Chip>
        </div>
      ))}
    </div>
  );
}

function InfoPanel() {
  return (
    <div className="order-2 lg:order-1 lg:col-span-5 bg-surface-container-lowest p-space-lg lg:p-space-xl flex flex-col justify-between relative overflow-hidden">
      <div className="relative z-10 flex flex-col gap-space-lg">
        <div className="flex flex-col gap-space-xs">
          <div className="flex items-center gap-space-sm">
            <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center shadow-md">
              <Icon name="fingerprint" fill className="text-[20px] text-on-primary-container" />
            </div>
            <div>
              <span className="font-headline-md text-headline-md tracking-tight text-on-surface block leading-tight">
                BAMP<span className="text-secondary">.CORE</span>
              </span>
              <span className="font-label-sm text-label-sm text-outline tracking-widest uppercase">Biometric Attendance Management</span>
            </div>
          </div>
          <div className="inline-flex self-start items-center gap-space-xs mt-space-xs bg-surface-container px-space-sm py-1 rounded">
            <Icon name="verified_user" fill className="text-[14px] text-tertiary" />
            <span className="font-label-sm text-label-sm text-tertiary tracking-wide uppercase">Fingerprint attendance · operations dashboard</span>
          </div>
        </div>
        <PlatformStatusCard />
        <SecurityPosture />
      </div>
    </div>
  );
}

export function AuthFooter({ links }: { links?: ReactNode }) {
  const h = useHealth();
  const s = healthSummary(h);
  return (
    <div className="mt-space-lg pt-space-md flex flex-wrap items-center justify-between gap-space-xs font-label-sm text-label-sm text-outline">
      <div className="flex flex-wrap items-center gap-space-md">
        <span className="flex items-center gap-1">
          <Icon name={s.tone === 'success' ? 'check_circle' : s.tone === 'error' ? 'error' : 'warning'} className={clsx('text-[14px]', toneText[s.tone])} />
          System status: {s.label}
        </span>
        {links}
      </div>
      <span className="text-on-surface-variant">Argon2id · TOTP (RFC 6238)</span>
    </div>
  );
}

function BottomLine() {
  const h = useHealth();
  return (
    <div className="flex flex-wrap items-center justify-between gap-space-sm mt-space-md px-space-xs font-label-sm text-label-sm text-outline">
      <span>BAMP · BIOMETRIC ATTENDANCE MANAGEMENT PLATFORM</span>
      <span>{h.data?.time ? `SERVER TIME ${dateTime(h.data.time, 'UTC')} UTC` : 'SERVER TIME UNAVAILABLE'}</span>
    </div>
  );
}

/** Split layout ported from the authentication template: left = live platform status, right = the form. */
export function AuthLayout({
  title,
  subtitle,
  badge,
  children,
  footerLinks,
  top
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  footerLinks?: ReactNode;
  top?: ReactNode;
}) {
  return (
    <main className="w-full min-h-screen bg-background flex items-center justify-center p-gutter">
      <div className="w-full max-w-7xl mx-auto my-auto p-margin-mobile lg:p-margin">
        <TelemetryBar />
        <div className="grid grid-cols-1 lg:grid-cols-12 card rounded-xl overflow-hidden">
          <InfoPanel />
          <div className="order-1 lg:order-2 lg:col-span-7 bg-surface-container p-space-lg lg:p-space-xl flex flex-col justify-between">
            <div>
              {top}
              <div className="flex flex-col gap-space-xs pb-space-md">
                <div className="flex items-center justify-between gap-space-sm">
                  <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">{title}</h1>
                  {badge && <span className="font-label-sm text-label-sm bg-primary-container text-on-primary-container px-space-sm py-1 rounded-full uppercase whitespace-nowrap">{badge}</span>}
                </div>
                {subtitle && <p className="font-body-md text-body-md text-on-surface-variant">{subtitle}</p>}
              </div>
              {children}
            </div>
            <AuthFooter links={footerLinks} />
          </div>
        </div>
        <BottomLine />
      </div>
    </main>
  );
}

/** Full-screen centered card in the template style (system states: session expired, 403, 500, maintenance, locked). */
export function StatusScreen({
  icon,
  tone = 'info',
  code,
  title,
  children,
  actions,
  footerLinks
}: {
  icon: string;
  tone?: Tone;
  code?: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  footerLinks?: ReactNode;
}) {
  const accent: Record<Tone, string> = {
    success: 'bg-tertiary',
    warning: 'bg-warning',
    error: 'bg-error',
    info: 'bg-secondary-container',
    neutral: 'bg-outline',
    primary: 'bg-primary-container'
  };
  return (
    <main className="w-full min-h-screen bg-background flex items-center justify-center p-gutter">
      <div className="w-full max-w-2xl mx-auto my-auto p-margin-mobile lg:p-margin">
        <TelemetryBar />
        <div className="relative bg-surface-container shadow-xl rounded-xl overflow-hidden p-space-lg lg:p-space-xl">
          <div className={clsx('absolute top-0 left-0 right-0 h-1', accent[tone])} />
          <div className="flex items-start gap-space-md">
            <div className={clsx('w-12 h-12 rounded-lg bg-surface-container-lowest flex items-center justify-center shrink-0 shadow-inner', toneText[tone])}>
              <Icon name={icon} fill className="text-[28px]" />
            </div>
            <div className="min-w-0 flex-1">
              {code && <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline mb-1">{code}</div>}
              <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">{title}</h1>
            </div>
          </div>
          {children && <div className="mt-space-md flex flex-col gap-space-md font-body-md text-body-md text-on-surface-variant">{children}</div>}
          {actions && <div className="mt-space-lg flex flex-wrap items-center gap-space-sm">{actions}</div>}
          <AuthFooter links={footerLinks} />
        </div>
        <BottomLine />
      </div>
    </main>
  );
}

/** Compact live component list for system-state screens. */
export function ComponentHealthList() {
  const h = useHealth();
  return (
    <div className="bg-surface-container-lowest rounded p-space-sm grid grid-cols-1 sm:grid-cols-2 gap-x-space-md">
      {HEALTH_COMPONENTS.map((c) => {
        const up = h.data?.components[c.key];
        const tone: Tone = h.isLoading ? 'neutral' : !h.data ? 'error' : up ? 'success' : 'error';
        return (
          <div key={c.key} className="flex items-center justify-between gap-space-sm py-1.5 border-b border-outline-variant/15">
            <span className="flex items-center gap-space-sm font-body-sm text-body-sm text-on-surface">
              <Icon name={c.icon} className={clsx('text-[16px]', toneText[tone])} />
              {c.label}
            </span>
            <span className={clsx('flex items-center gap-1.5 font-label-sm text-label-sm uppercase', toneText[tone])}>
              <Dot tone={tone} />
              {h.isLoading ? 'Checking' : !h.data ? 'No answer' : up ? 'Up' : 'Down'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Form helpers
 * ════════════════════════════════════════════════════════════════════════════ */

export function InlineAlert({ tone, title, children, icon }: { tone: Tone; title?: ReactNode; children?: ReactNode; icon?: string }) {
  const cls: Record<Tone, string> = {
    success: 'border-tertiary/40 bg-tertiary-container/15',
    warning: 'border-warning/40 bg-warning-container/40',
    error: 'border-error/40 bg-error-container/25',
    info: 'border-secondary/30 bg-primary-container/10',
    neutral: 'border-outline-variant/40 bg-surface-container-lowest',
    primary: 'border-primary/30 bg-primary-container/15'
  };
  const defIcon: Record<Tone, string> = { success: 'check_circle', warning: 'warning', error: 'error', info: 'info', neutral: 'info', primary: 'info' };
  return (
    <div className={clsx('rounded border p-space-sm flex items-start gap-space-sm', cls[tone])} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon ?? defIcon[tone]} className={clsx('text-[18px] shrink-0 mt-px', toneText[tone])} />
      <div className="min-w-0 font-body-sm text-body-sm text-on-surface-variant">
        {title && <div className="font-headline-sm text-body-sm font-semibold text-on-surface">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** Human message for an API error, including validation details when present. */
export function errorText(err: unknown): { message: string; details: string[] } {
  const e = err as ApiError;
  if (!e) return { message: 'Something went wrong.', details: [] };
  if (e.status === 0) return { message: 'Connection unavailable. Check your network and try again.', details: [] };
  const details = Array.isArray(e.details)
    ? e.details.map((d: any) => (typeof d === 'string' ? d : `${d?.path ? d.path + ': ' : ''}${d?.message ?? ''}`)).filter(Boolean)
    : [];
  return { message: e.message || 'Something went wrong.', details };
}

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const t = errorText(error);
  return (
    <InlineAlert tone="error" title={title ?? t.message}>
      {title && <p>{t.message}</p>}
      {t.details.length > 0 && (
        <ul className="list-disc pl-4 mt-1">
          {t.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </InlineAlert>
  );
}

const fieldInputCls =
  'w-full h-9 bg-surface-container-lowest text-on-surface font-label-md text-label-md rounded pl-10 pr-space-md border border-outline-variant/30 placeholder:text-outline focus:outline-none focus:bg-surface-container-high focus:border-primary-container focus:ring-1 focus:ring-primary-container transition-colors disabled:opacity-60';

/** Template-style labelled input with a leading icon. */
export const AuthField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; icon: string; hint?: ReactNode; aside?: ReactNode; error?: string | null }
>(function AuthField({ label, icon, hint, aside, error, className, id, ...rest }, ref) {
  const inputId = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="flex flex-col gap-space-xs">
      <div className="flex items-center justify-between gap-space-sm">
        <label htmlFor={inputId} className="font-label-md text-label-md text-on-surface uppercase tracking-wide">
          {label}
        </label>
        {aside}
      </div>
      <div className="relative flex items-center">
        <Icon name={icon} className="absolute left-space-md text-[18px] text-secondary pointer-events-none" />
        <input ref={ref} id={inputId} className={clsx(fieldInputCls, className)} {...rest} />
      </div>
      {error ? <span className="font-body-sm text-body-sm text-error">{error}</span> : hint ? <span className="font-body-sm text-body-sm text-outline">{hint}</span> : null}
    </div>
  );
});

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  aside,
  hint,
  error,
  autoFocus,
  disabled,
  id
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  aside?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  const inputId = id ?? `pw-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="flex flex-col gap-space-xs">
      <div className="flex items-center justify-between gap-space-sm">
        <label htmlFor={inputId} className="font-label-md text-label-md text-on-surface uppercase tracking-wide">
          {label}
        </label>
        {aside}
      </div>
      <div className="relative flex items-center">
        <Icon name="key" className="absolute left-space-md text-[18px] text-outline pointer-events-none" />
        <input
          id={inputId}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          className={clsx(fieldInputCls, 'pr-10')}
          required
        />
        <button type="button" className="absolute right-space-md text-outline hover:text-on-surface" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
          <Icon name={show ? 'visibility' : 'visibility_off'} className="text-[18px]" />
        </button>
      </div>
      {error ? <span className="font-body-sm text-body-sm text-error">{error}</span> : hint ? <span className="font-body-sm text-body-sm text-outline">{hint}</span> : null}
    </div>
  );
}

export function PrimaryAction({ children, icon, loading, disabled, type = 'submit', onClick }: { children: ReactNode; icon: string; loading?: boolean; disabled?: boolean; type?: 'submit' | 'button'; onClick?: () => void }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className="w-full h-11 bg-primary-container hover:bg-inverse-primary text-on-primary-container font-headline-sm text-headline-sm rounded flex items-center justify-center gap-space-sm shadow-lg shadow-primary-container/30 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Icon name={loading ? 'progress_activity' : icon} className={clsx('text-[18px]', loading && 'animate-spin')} />
      <span>{children}</span>
    </button>
  );
}

export function TextLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-label-sm text-label-sm text-secondary hover:underline">
      {children}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Password policy
 * ════════════════════════════════════════════════════════════════════════════ */

export interface PasswordPolicy {
  passwordMinLength: number;
  passwordRequireUpper: boolean;
  passwordRequireLower: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSymbol: boolean;
}

/** Mirrors backend `passwordPolicyErrors` (services/settings.ts). */
export function policyRules(p: PasswordPolicy): { key: string; label: string; test: (pw: string) => boolean }[] {
  const rules = [{ key: 'len', label: `At least ${p.passwordMinLength} characters`, test: (pw: string) => pw.length >= p.passwordMinLength }];
  if (p.passwordRequireUpper) rules.push({ key: 'upper', label: 'An uppercase letter (A–Z)', test: (pw) => /[A-Z]/.test(pw) });
  if (p.passwordRequireLower) rules.push({ key: 'lower', label: 'A lowercase letter (a–z)', test: (pw) => /[a-z]/.test(pw) });
  if (p.passwordRequireDigit) rules.push({ key: 'digit', label: 'A digit (0–9)', test: (pw) => /[0-9]/.test(pw) });
  if (p.passwordRequireSymbol) rules.push({ key: 'symbol', label: 'A symbol (e.g. ! # % &)', test: (pw) => /[^A-Za-z0-9]/.test(pw) });
  return rules;
}

export function passwordAcceptable(p: PasswordPolicy | null | undefined, pw: string, confirm?: string) {
  if (!pw) return false;
  if (confirm !== undefined && pw !== confirm) return false;
  return p ? policyRules(p).every((r) => r.test(pw)) : true;
}

export function PolicyChecklist({ policy, password, confirm }: { policy: PasswordPolicy; password: string; confirm?: string }) {
  const rules = policyRules(policy);
  const passed = rules.filter((r) => r.test(password)).length;
  const items = [...rules.map((r) => ({ key: r.key, label: r.label, ok: r.test(password) }))];
  if (confirm !== undefined) items.push({ key: 'match', label: 'Both passwords match', ok: password.length > 0 && password === confirm });
  const tone: Tone = passed === rules.length ? 'success' : passed >= rules.length / 2 ? 'warning' : 'error';
  const bar: Record<Tone, string> = { success: 'bg-tertiary', warning: 'bg-warning', error: 'bg-error', info: 'bg-secondary', neutral: 'bg-outline', primary: 'bg-primary' };
  return (
    <div className="bg-surface-container-lowest rounded p-space-sm flex flex-col gap-space-xs">
      <div className="flex items-center justify-between font-label-sm text-label-sm">
        <span className="text-outline uppercase tracking-wider">Organisation password policy</span>
        <span className={toneText[password ? tone : 'neutral']}>
          {passed}/{rules.length} met
        </span>
      </div>
      <div className="grid gap-1 h-1" style={{ gridTemplateColumns: `repeat(${rules.length}, minmax(0, 1fr))` }}>
        {rules.map((r, i) => (
          <div key={r.key} className={clsx('rounded-full', i < passed && password ? bar[tone] : 'bg-surface-container-highest')} />
        ))}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-space-md gap-y-0.5 pt-space-xs">
        {items.map((i) => (
          <li key={i.key} className={clsx('flex items-center gap-1.5 font-body-sm text-body-sm', i.ok ? 'text-tertiary' : 'text-on-surface-variant')}>
            <Icon name={i.ok ? 'check_circle' : 'radio_button_unchecked'} fill={i.ok} className="text-[15px]" />
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * One-time code input
 * ════════════════════════════════════════════════════════════════════════════ */

export function CodeInput({ value, onChange, autoFocus, disabled, id = 'totp-code' }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; disabled?: boolean; id?: string }) {
  return (
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder="000000"
      aria-label="6-digit verification code"
      className="w-full h-14 bg-surface-container-lowest text-on-surface font-mono text-[28px] tracking-[0.6em] text-center rounded border border-outline-variant/30 placeholder:text-outline-variant focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container disabled:opacity-60"
    />
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * MFA enrolment (sign-in challenge or authenticated session)
 * ════════════════════════════════════════════════════════════════════════════ */

interface MfaStart {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}
export interface MfaConfirmResult {
  recoveryCodes: string[];
  session: { ok: boolean; sessionExpiresAt: string } | null;
}

const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

export function MfaSetupPanel({
  challengeToken,
  onComplete,
  onExpired,
  onCancel,
  cancelLabel = 'Cancel'
}: {
  challengeToken?: string;
  onComplete: (r: MfaConfirmResult) => void;
  onExpired?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [start, setStart] = useState<MfaStart | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const begin = async () => {
    setStarting(true);
    setStartError(null);
    setError(null);
    setCode('');
    try {
      setStart(await api.post<MfaStart>('/api/auth/mfa/setup/start', challengeToken ? { challengeToken } : {}));
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'challenge_expired' && onExpired) onExpired();
      else setStartError(e);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<MfaConfirmResult>('/api/auth/mfa/setup/confirm', challengeToken ? { code, challengeToken } : { code });
      onComplete(r);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'challenge_expired' && onExpired) return onExpired();
      setError(err.code === 'invalid_code' ? 'That code did not match. Wait for the next code in your authenticator app and try again.' : errorText(e).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (starting && !start)
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-on-surface-variant font-label-md text-label-md">
        <Icon name="progress_activity" className="animate-spin text-primary" /> Generating your authenticator secret…
      </div>
    );
  if (startError && !start)
    return (
      <div className="flex flex-col gap-space-md">
        <ErrorAlert error={startError} title="Could not start MFA setup" />
        <div className="flex gap-space-sm">
          <Button icon="refresh" onClick={() => void begin()}>
            Try Again
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
        </div>
      </div>
    );
  if (!start) return null;

  return (
    <form
      className="flex flex-col gap-space-md"
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
    >
      <div className="bg-surface-container-lowest rounded-lg p-space-md shadow-md flex flex-col gap-space-md">
        <div className="flex items-center gap-space-sm">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary-container" />
          </span>
          <span className="font-headline-sm text-headline-sm text-on-surface tracking-tight">Link an authenticator app</span>
        </div>
        <div className="bg-surface-container p-space-md rounded flex flex-col sm:flex-row items-center gap-space-md">
          <div className="bg-white p-2 rounded shrink-0">
            <img src={start.qrDataUrl} alt="QR code containing your authenticator secret" width={176} height={176} className="block w-44 h-44" />
          </div>
          <ol className="flex flex-col gap-space-sm font-body-sm text-body-sm text-on-surface-variant list-decimal pl-4">
            <li>Open an authenticator app that supports time-based one-time passwords (TOTP) on your phone.</li>
            <li>Add a new account and scan this QR code.</li>
            <li>
              Can't scan? Enter this key manually (time-based, 6 digits, 30 s):
              <div className="mt-1 flex flex-wrap items-center gap-space-xs">
                <code className="bg-surface-container-high px-1.5 py-0.5 rounded text-secondary font-mono text-[12px] break-all">{groupSecret(start.secret)}</code>
                <CopyButton value={start.secret} label="Copy key" />
              </div>
            </li>
            <li>Enter the 6-digit code the app shows to confirm.</li>
          </ol>
        </div>
      </div>
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="mfa-setup-code" className="font-label-md text-label-md text-on-surface uppercase tracking-wide">
          Verification code
        </label>
        <CodeInput id="mfa-setup-code" value={code} onChange={setCode} autoFocus disabled={busy} />
      </div>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <PrimaryAction icon="verified_user" loading={busy} disabled={code.length !== 6}>
        Confirm & enable MFA
      </PrimaryAction>
      <div className="flex flex-wrap items-center justify-between gap-space-sm">
        <TextLink onClick={() => void begin()}>Generate a new key</TextLink>
        {onCancel && <TextLink onClick={onCancel}>{cancelLabel}</TextLink>}
      </div>
    </form>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Recovery codes
 * ════════════════════════════════════════════════════════════════════════════ */

export function downloadRecoveryCodes(codes: string[], email?: string | null) {
  const lines = [
    'BAMP - Biometric Attendance Management Platform',
    'MFA recovery codes',
    email ? `Account: ${email}` : null,
    `Generated: ${new Date().toISOString()}`,
    `Site: ${window.location.origin}`,
    '',
    'Each code can be used once, instead of an authenticator code, if you lose access to your authenticator app.',
    'Generating new codes invalidates all previous codes.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
    ''
  ].filter((l): l is string => l !== null);
  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bamp-recovery-codes${email ? '-' + email.replace(/[^A-Za-z0-9._-]/g, '_') : ''}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function RecoveryCodesPanel({
  codes,
  email,
  onContinue,
  continueLabel = 'Continue',
  continueLoading
}: {
  codes: string[];
  email?: string | null;
  onContinue: () => void;
  continueLabel?: string;
  continueLoading?: boolean;
}) {
  const [ack, setAck] = useState(false);
  return (
    <div className="flex flex-col gap-space-md">
      <InlineAlert tone="warning" title="Save these recovery codes now">
        They are shown only once. Each code signs you in a single time if you lose your authenticator app. Store them somewhere safe and private (a password
        manager or printed copy).
      </InlineAlert>
      <div className="bg-surface-container-lowest rounded-lg p-space-md shadow-inner">
        <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-space-lg gap-y-space-xs">
          {codes.map((c, i) => (
            <li key={c} className="flex items-center gap-space-sm font-mono text-[14px] text-on-surface">
              <span className="font-label-sm text-label-sm text-outline w-5 text-right">{i + 1}.</span>
              <span className="tracking-wider">{c}</span>
            </li>
          ))}
        </ol>
        <div className="mt-space-md pt-space-sm border-t border-outline-variant/20 flex flex-wrap items-center gap-space-sm">
          <CopyButton value={codes.join('\n')} label="Copy all" />
          <Button size="sm" icon="download" onClick={() => downloadRecoveryCodes(codes, email)}>
            Download .txt
          </Button>
          <Button size="sm" icon="print" variant="ghost" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>
      <label className="flex items-start gap-space-sm cursor-pointer font-body-sm text-body-sm text-on-surface">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#2563eb]" />
        <span>I have stored my recovery codes in a safe place.</span>
      </label>
      <PrimaryAction type="button" icon="arrow_forward" disabled={!ack} loading={continueLoading} onClick={onContinue}>
        {continueLabel}
      </PrimaryAction>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Stepper + post-sign-in routing
 * ════════════════════════════════════════════════════════════════════════════ */

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1 mb-space-lg overflow-x-auto" aria-label="Progress">
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        return (
          <li key={s} className="flex items-center gap-1 flex-1 min-w-0">
            <div
              className={clsx(
                'flex items-center gap-1.5 px-space-sm py-1 rounded font-label-md text-label-md whitespace-nowrap',
                state === 'active' && 'bg-primary-container text-on-primary-container',
                state === 'done' && 'bg-tertiary-container/20 text-tertiary',
                state === 'todo' && 'bg-surface-container-lowest text-outline'
              )}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              {state === 'done' ? <Icon name="check" className="text-[14px]" /> : <span className="font-mono">{i + 1}</span>}
              <span className={clsx(state !== 'active' && 'hidden md:inline')}>{s}</span>
            </div>
            {i < steps.length - 1 && <div className={clsx('h-px flex-1 min-w-[8px]', i < current ? 'bg-tertiary/50' : 'bg-outline-variant/40')} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Only allow same-origin, in-app redirect targets. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  const publicPaths = ['/login', '/forgot-password', '/reset-password', '/setup/account', '/account-locked', '/session-expired', '/maintenance'];
  if (publicPaths.some((p) => next.startsWith(p))) return '/';
  return next;
}

export function destinationFor(me: Me | null | undefined, next?: string | null) {
  if (me && !me.organization.setupCompleted && me.permissions.includes('settings.manage')) return '/setup';
  return safeNext(next);
}

/** Refresh the auth context after a session was created, then route to the right place. */
export function useFinishSignIn() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return async (next?: string | null) => {
    const r = (await refresh().catch(() => null)) as { data?: Me } | null;
    navigate(destinationFor(r?.data, next), { replace: true });
    return r?.data ?? null;
  };
}
