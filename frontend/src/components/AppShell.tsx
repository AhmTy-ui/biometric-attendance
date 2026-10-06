import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relative } from '@/lib/format';
import { useLive, useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { Avatar, Dot, Icon, Kbd, Skeleton, useDebounced, useToast } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perm: string;
  end?: boolean;
  badge?: ReactNode;
  /** Shown as a dot on the collapsed rail. */
  attention?: boolean;
}

const countBadge = (n: number, tone: 'error' | 'warning' = 'error') => (
  <span
    key={n}
    className={clsx(
      'tick min-w-[20px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full text-[10.5px] font-semibold tabular',
      tone === 'error' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'
    )}
  >
    {n > 99 ? '99+' : n}
  </span>
);

function useNav(): { section: string; items: NavItem[] }[] {
  const dash = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000, refetchInterval: 60_000 });
  const d = dash.data;
  const dlq = d?.delivery?.dead_letter ?? 0;
  const critical = d?.alertCounts?.critical ?? 0;
  return [
    { section: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: 'space_dashboard', perm: 'dashboard.view', end: true }] },
    {
      section: 'Attendance',
      items: [
        {
          to: '/attendance/live',
          label: 'Live Attendance',
          icon: 'sensors',
          perm: 'attendance.view',
          badge: (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider text-tertiary">
              <Dot tone="success" pulse />
              LIVE
            </span>
          )
        },
        { to: '/attendance/history', label: 'Attendance History', icon: 'history', perm: 'attendance.view' },
        { to: '/attendance/reconciliation', label: 'Reconciliation', icon: 'sync_problem', perm: 'attendance.view', badge: dlq ? countBadge(dlq) : undefined, attention: dlq > 0 },
        { to: '/reports', label: 'Reports', icon: 'monitoring', perm: 'reports.view' }
      ]
    },
    {
      section: 'Workforce',
      items: [
        { to: '/employees', label: 'Employees', icon: 'group', perm: 'employees.view' },
        { to: '/locations', label: 'Locations', icon: 'location_on', perm: 'locations.view' }
      ]
    },
    {
      section: 'Devices',
      items: [
        {
          to: '/devices',
          label: 'Devices',
          icon: 'memory',
          perm: 'devices.view',
          end: true,
          attention: Boolean(d?.devices?.offline),
          badge: d?.devices ? (
            <span className={clsx('text-[11px] font-medium tabular', d.devices.offline ? 'text-warning' : 'text-outline')} title="Online / active devices">
              {d.devices.online}/{d.devices.total - d.devices.pending}
            </span>
          ) : undefined
        },
        { to: '/devices/enrolment', label: 'Biometric Enrolment', icon: 'fingerprint', perm: 'enrolment.view' },
        { to: '/firmware', label: 'Firmware', icon: 'deployed_code', perm: 'firmware.view' }
      ]
    },
    {
      section: 'System',
      items: [
        { to: '/alerts', label: 'Alerts', icon: 'notifications', perm: 'alerts.view', badge: critical ? countBadge(critical) : undefined, attention: critical > 0 },
        {
          to: '/integration',
          label: 'Integration & Sync',
          icon: 'hub',
          perm: 'integration.view',
          attention: Boolean(d?.unmappedLocations),
          badge: d?.unmappedLocations ? <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unmapped locations" /> : undefined
        },
        { to: '/users', label: 'Users & Roles', icon: 'shield_person', perm: 'users.view' },
        { to: '/audit', label: 'Audit Log', icon: 'policy', perm: 'audit.view' },
        { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.view' }
      ]
    }
  ];
}

/** Desktop sidebar collapse state, remembered per browser. */
const COLLAPSE_KEY = 'bamp.sidebar.collapsed';
function useCollapsed(): [boolean, () => void] {
  const [c, setC] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setC((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  // Ctrl/Cmd + B toggles the sidebar.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return [c, toggle];
}

function Sidebar({ open, onClose, collapsed, onToggle }: { open: boolean; onClose: () => void; collapsed: boolean; onToggle: () => void }) {
  const { can, me, logout } = useAuth();
  const nav = useNav();
  const loc = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  // Labels fade and clip as the rail narrows (desktop only; the mobile drawer is always full width).
  const fade = clsx('whitespace-nowrap transition-[opacity,transform] duration-200 ease-settle', collapsed && 'lg:opacity-0 lg:-translate-x-1 lg:pointer-events-none');
  const visible = nav.map((s) => ({ ...s, items: s.items.filter((i) => can(i.perm)) })).filter((s) => s.items.length);
  const navKey = visible.map((s) => s.items.map((i) => i.to).join()).join('|');

  // One shared highlight glides to whichever item is active.
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!list || !active) return setIndicator(null);
    setIndicator({ top: active.offsetTop, height: active.offsetHeight });
  }, [loc.pathname, collapsed, navKey]);

  return (
    <>
      <div
        className={clsx('fixed inset-0 bg-black/60 z-40 lg:hidden transition-opacity duration-300', open ? 'opacity-100' : 'opacity-0 pointer-events-none')}
        onClick={onClose}
        aria-hidden
      />
      <aside
        aria-label="Primary"
        className={clsx(
          'fixed left-0 top-0 h-full w-[264px] bg-[#0b0c0f] border-r border-white/[0.06] z-50 flex flex-col select-none overflow-hidden',
          'transition-[transform,width] duration-300 ease-settle',
          open ? 'translate-x-0 shadow-pop' : '-translate-x-full lg:translate-x-0',
          collapsed && 'lg:w-[64px]'
        )}
      >
        {/* Brand */}
        <div className="h-14 px-[14px] flex items-center gap-2.5 shrink-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-container to-secondary-container flex items-center justify-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_0_0_1px_rgba(92,200,255,0.25),0_4px_14px_-4px_rgba(31,124,242,0.6)]">
            <Icon name="fingerprint" className="text-[20px] text-white" />
          </div>
          <div className={clsx('flex flex-col min-w-0 leading-tight', fade)}>
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-on-surface">BAMP</span>
            <span className="text-[11px] text-outline truncate max-w-[170px]">{me?.organization.name ?? 'Attendance Operations'}</span>
          </div>
          <button onClick={onClose} className="lg:hidden ml-auto p-1.5 rounded-md text-outline hover:text-on-surface hover:bg-white/[0.05]" aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        {/* Location scope inside the drawer on small screens (the top bar shows it from md up). */}
        <div className="md:hidden px-3 pb-2">
          <ScopeSelect className="w-full" />
        </div>

        <div ref={listRef} className="relative overflow-y-auto overflow-x-hidden flex-1 px-2.5 pt-1 pb-3">
          {indicator && (
            <span
              aria-hidden
              className="absolute left-2.5 right-2.5 rounded-lg bg-white/[0.06] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] transition-[transform,height] duration-300 ease-settle pointer-events-none"
              style={{ top: 0, height: indicator.height, transform: `translateY(${indicator.top}px)` }}
            >
              <span className="absolute -left-2.5 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-r-full bg-primary shadow-[0_0_10px_rgba(92,200,255,0.8)]" />
            </span>
          )}
          {visible.map((s, si) => (
            <nav key={s.section} aria-label={s.section} className={si > 0 ? 'mt-4' : undefined}>
              <div className="relative h-6 px-2 flex items-center">
                <span className={clsx('text-[11px] font-medium text-outline/90', fade)}>{s.section}</span>
                <span className={clsx('absolute left-2 right-2 top-1/2 h-px bg-white/[0.06] transition-opacity duration-200', collapsed ? 'lg:opacity-100' : 'opacity-0')} />
              </div>
              <div className="flex flex-col gap-px">
                {s.items.map((i, ii) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.end}
                    onClick={onClose}
                    title={collapsed ? i.label : undefined}
                    style={{ animationDelay: `${(si * 3 + ii) * 18}ms` }}
                    className={({ isActive }) =>
                      clsx(
                        'nav-item group relative z-[1] flex items-center justify-between gap-2 h-8 px-2.5 rounded-lg text-[13px] transition-colors duration-150',
                        isActive ? 'text-on-surface font-medium' : 'text-on-surface-variant hover:text-on-surface hover:bg-white/[0.035]'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className="relative shrink-0 flex">
                            <Icon name={i.icon} fill={isActive} className={clsx('text-[19px] transition-colors duration-150', isActive ? 'text-primary' : 'text-outline group-hover:text-on-surface-variant')} />
                            {collapsed && i.attention && <span className="hidden lg:block absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-error ring-2 ring-[#0b0c0f]" />}
                          </span>
                          <span className={clsx('truncate', fade)}>{i.label}</span>
                        </span>
                        {i.badge && <span className={clsx('shrink-0', fade)}>{i.badge}</span>}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </nav>
          ))}
        </div>

        {/* User area */}
        <div className="p-2.5 border-t border-white/[0.06] shrink-0 flex flex-col gap-1">
          <div className={clsx('flex items-center gap-1 rounded-lg', !collapsed && 'bg-white/[0.025] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]')}>
            <Link
              to="/profile"
              onClick={onClose}
              title={collapsed ? `${me?.user.fullName ?? 'User profile'} — profile` : 'Your profile'}
              className="flex items-center gap-2.5 min-w-0 flex-1 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"
            >
              <Avatar name={me?.user.fullName ?? '?'} size={8} />
              <span className={clsx('flex flex-col min-w-0 leading-tight', fade)}>
                <span className="text-[13px] font-medium text-on-surface truncate">{me?.user.fullName}</span>
                <span className="text-[11px] text-outline truncate">{me?.user.roleLabel}</span>
              </span>
            </Link>
            <button
              onClick={() => void logout()}
              title="Sign out"
              aria-label="Sign out"
              className={clsx('press p-2 mr-0.5 rounded-md text-outline hover:text-error hover:bg-error/10 shrink-0', collapsed && 'lg:hidden')}
            >
              <Icon name="logout" className="text-[18px]" />
            </button>
          </div>
          <button
            onClick={onToggle}
            title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="hidden lg:flex w-full items-center gap-2.5 h-8 px-[11px] rounded-lg text-outline hover:bg-white/[0.04] hover:text-on-surface text-[12.5px] transition-colors"
          >
            <Icon name="left_panel_close" className={clsx('text-[18px] shrink-0 transition-transform duration-300 ease-settle', collapsed && 'rotate-180')} />
            <span className={clsx('flex-1 text-left', fade)}>Collapse</span>
            <span className={fade}>
              <Kbd>Ctrl B</Kbd>
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}

/** ● LIVE — the dashboard WebSocket (bridged from the MQTT broker) and the broker connection. */
function LiveStatus() {
  const { status } = useLive();
  const dash = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000 });
  const mqtt = dash.data?.realtime?.mqttConnected;
  const p95 = dash.data?.latency?.p95_ingest_ms;
  const ok = status === 'open' && mqtt !== false;
  const label = ok ? 'Live' : status === 'connecting' ? 'Connecting' : mqtt === false ? 'Broker down' : 'Offline';
  const tone = ok ? 'success' : status === 'connecting' ? 'warning' : 'error';
  const detail = ok
    ? `Live feed connected · MQTT broker connected${p95 !== null && p95 !== undefined ? ` · P95 ingest ${(p95 / 1000).toFixed(1)}s` : ''}`
    : status === 'connecting'
      ? 'Connecting to the live feed…'
      : mqtt === false
        ? 'The MQTT broker is disconnected — devices will buffer events until it returns.'
        : 'Live feed offline — data refreshes periodically.';
  return (
    <div
      role="status"
      title={detail}
      aria-label={detail}
      className={clsx(
        'flex items-center gap-2 h-8 pl-2.5 pr-3 rounded-full ring-1 ring-inset text-[11px] font-semibold tracking-[0.08em] uppercase whitespace-nowrap',
        ok ? 'bg-tertiary/[0.08] ring-tertiary/20 text-tertiary' : tone === 'warning' ? 'bg-warning/10 ring-warning/25 text-warning' : 'bg-error/10 ring-error/25 text-error'
      )}
    >
      <Dot tone={tone} pulse={ok || status === 'connecting'} />
      {label}
      {ok && p95 !== null && p95 !== undefined && <span className="hidden 2xl:inline font-medium normal-case tracking-normal text-outline">· P95 {(p95 / 1000).toFixed(1)}s</span>}
    </div>
  );
}

// ───────────────────────── Global search (command menu) ─────────────────────────
interface SearchItem {
  id: string;
  group: string;
  icon: string;
  label: string;
  meta?: string;
  to: string;
}
const QUICK_ACTIONS: { label: string; icon: string; to: string; perm: string; keywords: string }[] = [
  { label: 'Open dashboard', icon: 'space_dashboard', to: '/', perm: 'dashboard.view', keywords: 'home overview' },
  { label: 'View live attendance', icon: 'sensors', to: '/attendance/live', perm: 'attendance.view', keywords: 'feed clock real-time' },
  { label: 'Search attendance history', icon: 'history', to: '/attendance/history', perm: 'attendance.view', keywords: 'records events' },
  { label: 'Reconcile failed events', icon: 'sync_problem', to: '/attendance/reconciliation', perm: 'attendance.view', keywords: 'dlq dead letter retry delivery' },
  { label: 'Open reports', icon: 'monitoring', to: '/reports', perm: 'reports.view', keywords: 'analytics export charts' },
  { label: 'Browse employees', icon: 'group', to: '/employees', perm: 'employees.view', keywords: 'staff people workforce' },
  { label: 'Browse locations', icon: 'location_on', to: '/locations', perm: 'locations.view', keywords: 'sites branches' },
  { label: 'Device registry', icon: 'memory', to: '/devices', perm: 'devices.view', keywords: 'terminals hardware health' },
  { label: 'Provision a device', icon: 'add_circle', to: '/devices/provision', perm: 'devices.provision', keywords: 'new add register' },
  { label: 'Biometric enrolment', icon: 'fingerprint', to: '/devices/enrolment', perm: 'enrolment.view', keywords: 'templates fingerprints' },
  { label: 'Firmware', icon: 'deployed_code', to: '/firmware', perm: 'firmware.view', keywords: 'ota update deploy' },
  { label: 'Alert center', icon: 'notifications', to: '/alerts', perm: 'alerts.view', keywords: 'incidents warnings' },
  { label: 'Integration & sync', icon: 'hub', to: '/integration', perm: 'integration.view', keywords: 'web software api' },
  { label: 'Users & roles', icon: 'shield_person', to: '/users', perm: 'users.view', keywords: 'accounts permissions rbac' },
  { label: 'Audit log', icon: 'policy', to: '/audit', perm: 'audit.view', keywords: 'history trail security' },
  { label: 'Settings', icon: 'settings', to: '/settings', perm: 'settings.view', keywords: 'configuration policies' },
  { label: 'Your profile', icon: 'account_circle', to: '/profile', perm: '', keywords: 'me account password mfa' }
];

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 220);
  const nav = useNavigate();
  const { can } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = 'global-search-results';

  const res = useQuery<any>({
    queryKey: ['global-search', dq],
    enabled: dq.length >= 2,
    queryFn: async () => {
      const [emp, dev, loc, ev] = await Promise.all([
        can('employees.view') ? api.get<any>('/api/employees', { q: dq, limit: 5 }) : Promise.resolve({ rows: [] }),
        can('devices.view') ? api.get<any>('/api/devices', { q: dq, limit: 5 }) : Promise.resolve({ rows: [] }),
        can('locations.view') ? api.get<any[]>('/api/locations', { q: dq }) : Promise.resolve([]),
        can('attendance.view') ? api.get<any>('/api/attendance/events', { q: dq, limit: 5 }) : Promise.resolve({ rows: [] })
      ]);
      return { emp: emp.rows as any[], dev: dev.rows as any[], loc: (loc as any[]).slice(0, 5), ev: ev.rows as any[] };
    }
  });

  const items = useMemo<SearchItem[]>(() => {
    const needle = q.trim().toLowerCase();
    const actions = QUICK_ACTIONS.filter((a) => (!a.perm || can(a.perm)) && (!needle || `${a.label} ${a.keywords}`.toLowerCase().includes(needle)))
      .slice(0, needle ? 4 : 6)
      .map((a) => ({ id: `qa:${a.to}`, group: needle ? 'Quick actions' : 'Jump to', icon: a.icon, label: a.label, to: a.to }));
    const r = dq.length >= 2 && dq === needle ? res.data : undefined;
    return [
      ...actions,
      ...(r?.emp ?? []).map((e: any) => ({ id: `e:${e.id}`, group: 'Employees', icon: 'person', label: e.full_name, meta: [e.staff_number, e.department].filter(Boolean).join(' · '), to: `/employees/${e.id}` })),
      ...(r?.dev ?? []).map((d: any) => ({ id: `d:${d.id}`, group: 'Devices', icon: 'memory', label: d.name, meta: [d.device_uid, d.location_name].filter(Boolean).join(' · '), to: `/devices/${d.id}` })),
      ...(r?.loc ?? []).map((l: any) => ({ id: `l:${l.id}`, group: 'Locations', icon: 'location_on', label: l.name, meta: l.code, to: `/locations/${l.id}` })),
      ...(r?.ev ?? []).map((ev: any) => ({
        id: `a:${ev.id}`,
        group: 'Attendance events',
        icon: ev.direction === 'out' ? 'logout' : 'login',
        label: `${ev.employee_name ?? 'Unknown'} · ${ev.direction === 'out' ? 'Clock out' : 'Clock in'}`,
        meta: `${ev.event_uid} · ${relative(ev.captured_at)}`,
        to: `/attendance/events/${ev.id}`
      }))
    ];
  }, [q, dq, res.data, can]);

  useEffect(() => setActive(0), [items.length, dq]);

  // "/" or Ctrl/Cmd+K focuses search from anywhere.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
    nav(to);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      go(items[active].to);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };
  useEffect(() => {
    document.getElementById(`gs-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const searching = dq.length >= 2 && res.isFetching;
  const noMatches = dq.length >= 2 && !res.isFetching && res.data && items.length === 0;
  let lastGroup = '';
  return (
    <div className={clsx('relative min-w-0 transition-[flex-basis,max-width] duration-300 ease-settle', open ? 'flex-1 max-w-[560px]' : 'flex-1 max-w-[340px]')}>
      <div className="relative flex items-center">
        <Icon name="search" className={clsx('absolute left-3 text-[18px] pointer-events-none transition-colors', open ? 'text-primary' : 'text-outline')} />
        <input
          ref={inputRef}
          id="global-search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && items[active] ? `gs-${active}` : undefined}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          className={clsx(
            'w-full h-9 rounded-lg pl-9 pr-16 text-[13px] text-on-surface placeholder:text-outline transition-[background-color,box-shadow] duration-200 focus:outline-none',
            open
              ? 'bg-surface-container-high shadow-[inset_0_0_0_1px_rgba(92,200,255,0.45),0_0_0_3px_rgba(31,124,242,0.18)]'
              : 'bg-white/[0.035] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-white/[0.05]'
          )}
          placeholder={open ? 'Search employees, staff no., devices, locations, events…' : 'Search anything…'}
          aria-label="Global search"
        />
        <span className="absolute right-2.5 hidden sm:flex items-center gap-1 pointer-events-none">
          {searching ? <Icon name="progress_activity" className="animate-spin text-[15px] text-outline" /> : <Kbd>Ctrl K</Kbd>}
        </span>
      </div>
      {open && (
        <div id={listId} role="listbox" aria-label="Search results" className="drop-in absolute left-0 right-0 mt-2 bg-surface-container-high rounded-xl shadow-pop z-50 max-h-[min(70vh,480px)] overflow-y-auto p-1.5">
          {dq.length < 2 && q.trim().length > 0 && <div className="px-3 py-2 text-body-sm text-outline">Keep typing to search records…</div>}
          {items.map((it, idx) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-outline">{header}</div>}
                <button
                  id={`gs-${idx}`}
                  role="option"
                  aria-selected={idx === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(it.to);
                  }}
                  onMouseMove={() => setActive(idx)}
                  className={clsx('w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-left transition-colors duration-100', idx === active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]')}
                >
                  <span className={clsx('flex items-center justify-center w-6 h-6 rounded-md shrink-0', idx === active ? 'bg-primary/15 text-primary' : 'bg-white/[0.04] text-outline')}>
                    <Icon name={it.icon} className="text-[15px]" />
                  </span>
                  <span className="text-[13px] text-on-surface truncate">{it.label}</span>
                  {it.meta && <span className="text-[11px] text-outline truncate">{it.meta}</span>}
                  {idx === active && <Icon name="keyboard_return" className="ml-auto text-[15px] text-outline shrink-0" />}
                </button>
              </div>
            );
          })}
          {searching && items.length === 0 && <div className="px-3 py-2 text-body-sm text-outline">Searching…</div>}
          {noMatches && <div className="px-3 py-6 text-center text-body-sm text-outline">No matches for “{dq}”</div>}
          <div className="flex items-center gap-3 px-2.5 pt-2 mt-1 border-t border-white/[0.06] text-[11px] text-outline">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd> close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery<any>({ queryKey: ['notifications'], queryFn: () => api.get('/api/notifications'), refetchInterval: 60_000 });
  useLiveEvents('alert/raised', (f) => {
    if (f.data?.occurrences === 1 && (f.data?.severity === 'critical' || f.data?.severity === 'warning')) {
      toast({
        tone: f.data.severity === 'critical' ? 'error' : 'warning',
        title: f.data.title,
        description: f.data.impact ?? f.data.description,
        action: { label: 'View alert', onClick: () => nav(`/alerts/${f.data.id}`) }
      });
    }
  });
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx('press relative flex items-center justify-center w-9 h-9 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-white/[0.05]', open && 'bg-white/[0.06] text-on-surface')}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="notifications" className="text-[20px]" />
        {unread > 0 && (
          <span key={unread} className="tick absolute top-1 right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-error text-[#2b0003] text-[9.5px] font-bold ring-2 ring-background">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Notifications" className="drop-in absolute right-0 mt-2 w-[min(92vw,380px)] z-50 bg-surface-container-high rounded-xl shadow-pop overflow-hidden">
            <div className="flex items-center justify-between px-4 h-11 border-b border-white/[0.06]">
              <span className="text-[13px] font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  className="text-[12px] text-primary hover:underline"
                  onClick={async () => {
                    await api.post('/api/notifications/read');
                    void qc.invalidateQueries({ queryKey: ['notifications'] });
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {(q.data?.rows ?? []).length === 0 && (
                <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
                  <Icon name="notifications_off" className="text-[22px] text-outline" />
                  <span className="text-body-sm text-outline">You're all caught up</span>
                </div>
              )}
              {(q.data?.rows ?? []).map((n: any) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    void api.post('/api/notifications/read', { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
                    if (n.alert_id) nav(`/alerts/${n.alert_id}`);
                  }}
                  className={clsx('w-full text-left px-4 py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.04] transition-colors flex gap-3', !n.read_at && 'bg-primary/[0.04]')}
                >
                  <span className="pt-1.5">
                    <Dot tone={n.severity === 'critical' ? 'error' : n.severity === 'warning' ? 'warning' : 'info'} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={clsx('text-[13px] truncate', n.read_at ? 'text-on-surface-variant' : 'text-on-surface font-medium')}>{n.title}</span>
                      <span className="text-[11px] text-outline shrink-0">{relative(n.created_at)}</span>
                    </span>
                    <span className="block text-[12px] text-on-surface-variant line-clamp-2 mt-0.5">{n.body}</span>
                  </span>
                </button>
              ))}
            </div>
            <Link to="/alerts" onClick={() => setOpen(false)} className="flex items-center justify-center gap-1 h-10 text-[12.5px] text-primary hover:bg-white/[0.04] border-t border-white/[0.06]">
              Open Alert Center <Icon name="arrow_forward" className="text-[15px]" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/** Global location scope (filters every page that supports it). */
function ScopeSelect({ className }: { className?: string }) {
  const { me } = useAuth();
  const [locationId, setLocationId] = useGlobalLocation();
  const locs = useQuery<any[]>({ queryKey: ['locations-lite'], queryFn: () => api.get('/api/locations'), staleTime: 300_000 });
  return (
    <div className={clsx('relative flex items-center', className)}>
      <Icon name="location_on" className={clsx('absolute left-2.5 text-[16px] pointer-events-none', locationId ? 'text-primary' : 'text-outline')} />
      <select
        value={locationId ?? ''}
        onChange={(e) => setLocationId(e.target.value || null)}
        aria-label="Location scope"
        title="Location scope — filters data across the app"
        className={clsx(
          'appearance-none h-9 w-full rounded-lg pl-8 pr-7 text-[12.5px] cursor-pointer truncate focus:outline-none transition-colors',
          locationId
            ? 'bg-primary/10 text-on-surface shadow-[inset_0_0_0_1px_rgba(92,200,255,0.3)]'
            : 'bg-white/[0.035] text-on-surface-variant shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-white/[0.05]'
        )}
      >
        <option value="">{me?.locationScope ? `My locations (${me.locationScope.length})` : `All locations (${locs.data?.length ?? 0})`}</option>
        {(locs.data ?? []).map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <Icon name="unfold_more" className="absolute right-2 text-[15px] text-outline pointer-events-none" />
    </div>
  );
}

function Clock() {
  const { me } = useAuth();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const tz = me?.organization.timezone;
  const local = tz ? now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }) : now.toISOString().slice(11, 19);
  const city = tz ? tz.split('/').pop()!.replace(/_/g, ' ') : 'UTC';
  return (
    <div className="flex flex-col items-end leading-tight tabular" title={`Organisation time (${tz ?? 'UTC'}) · UTC ${now.toISOString().slice(11, 19)}`}>
      <span className="text-[12.5px] font-medium text-on-surface font-mono">{local}</span>
      <span className="text-[10.5px] text-outline">
        {city} · UTC {now.toISOString().slice(11, 16)}
      </span>
    </div>
  );
}

/** Placeholder shaped like a typical page (header, metric row, content card) while a page bundle loads. */
function PageSkeleton() {
  return (
    <div className="flex flex-col gap-gutter" role="status" aria-label="Loading page">
      <div className="flex flex-col gap-2 pt-1">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-3.5 w-[min(520px,80%)]" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-space-md">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card rounded-xl p-4 flex flex-col gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-2.5 w-28" />
          </div>
        ))}
      </div>
      <div className="card rounded-xl p-4 flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="w-7 h-7 rounded-full" />
            <Skeleton className="h-3 flex-1 max-w-[40%]" />
            <Skeleton className="h-3 w-20 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Static backdrop: one soft light from the top and a faint grid that fades out. */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden>
      <div className="ambient-grid" />
    </div>
  );
}

export default function AppShell() {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  // Scroll to top on navigation so every page starts at its header.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);
  const shift = 'transition-[left,padding] duration-300 ease-settle';
  return (
    <div>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[300] focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary-container focus:text-white">
        Skip to content
      </a>
      <Sidebar open={open} onClose={() => setOpen(false)} collapsed={collapsed} onToggle={toggleCollapsed} />
      <div className={clsx(shift, collapsed ? 'lg:pl-[64px]' : 'lg:pl-[264px]')}>
        <header
          className={clsx(
            'fixed top-0 left-0 right-0 h-14 bg-[#08090b]/80 backdrop-blur-xl backdrop-saturate-150 border-b border-white/[0.06] z-40 px-3 sm:px-gutter flex items-center gap-2 sm:gap-3',
            shift,
            collapsed ? 'lg:left-[64px]' : 'lg:left-[264px]'
          )}
        >
          <button className="press lg:hidden flex items-center justify-center w-9 h-9 rounded-lg text-on-surface-variant hover:bg-white/[0.05]" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <GlobalSearch />
          <div className="flex-1 hidden md:block" />
          <ScopeSelect className="hidden md:flex w-[200px] xl:w-[220px] shrink-0" />
          <div className="hidden xl:block pl-1">
            <Clock />
          </div>
          <div className="hidden sm:block">
            <LiveStatus />
          </div>
          <Notifications />
          {/* Signed-in identity (display only; the profile link lives in the sidebar user area). */}
          <div className="hidden sm:flex items-center gap-2 pl-3 ml-0.5 border-l border-white/[0.07]" title={`${me?.user.fullName ?? ''} · ${me?.user.roleLabel ?? ''}`}>
            <Avatar name={me?.user.fullName ?? '?'} size={8} />
            <div className="hidden 2xl:flex flex-col leading-tight">
              <span className="text-[12.5px] font-medium text-on-surface max-w-[140px] truncate">{me?.user.fullName}</span>
              <span className="text-[11px] text-outline truncate max-w-[160px]">{me?.user.roleLabel}</span>
            </div>
          </div>
        </header>
        <main id="main" className="relative pt-14 min-h-screen">
          {/* Keyed by route: every navigation replays the page entrance and the staggered section reveal. */}
          <div key={loc.pathname} className="page-enter stagger flex flex-col w-full gap-gutter px-4 py-5 sm:px-6 lg:px-8 lg:py-7 max-w-[1680px] mx-auto">
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
