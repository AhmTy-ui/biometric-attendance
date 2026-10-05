import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relative } from '@/lib/format';
import { useLive, useLiveEvents } from '@/lib/live';
import { useGlobalLocation } from '@/lib/scope';
import { Avatar, Dot, Icon, useDebounced, useToast } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perm: string;
  end?: boolean;
  badge?: ReactNode;
}

function useNav(): { section: string; items: NavItem[] }[] {
  const dash = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000, refetchInterval: 60_000 });
  const d = dash.data;
  const dlq = d?.delivery?.dead_letter ?? 0;
  const critical = d?.alertCounts?.critical ?? 0;
  return [
    { section: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: 'grid_view', perm: 'dashboard.view', end: true }] },
    {
      section: 'Attendance',
      items: [
        { to: '/attendance/live', label: 'Live Attendance', icon: 'stream', perm: 'attendance.view', badge: <span className="font-label-sm text-label-sm px-1 rounded bg-surface-container text-tertiary">LIVE</span> },
        { to: '/attendance/history', label: 'Attendance History', icon: 'history', perm: 'attendance.view' },
        {
          to: '/attendance/reconciliation',
          label: 'Reconciliation & DLQ',
          icon: 'published_with_changes',
          perm: 'attendance.view',
          badge: dlq ? <span className="font-label-sm text-label-sm px-1.5 rounded bg-error-container text-on-error-container">{dlq}</span> : undefined
        },
        { to: '/reports', label: 'Reports & Analytics', icon: 'analytics', perm: 'reports.view' }
      ]
    },
    {
      section: 'Workforce',
      items: [
        { to: '/employees', label: 'Employees', icon: 'badge', perm: 'employees.view', badge: <span className="font-label-sm text-label-sm text-outline">SSOT</span> },
        { to: '/locations', label: 'Locations', icon: 'storefront', perm: 'locations.view' }
      ]
    },
    {
      section: 'Devices',
      items: [
        {
          to: '/devices',
          label: 'Device Registry',
          icon: 'router',
          perm: 'devices.view',
          end: true,
          badge: d?.devices ? (
            <span className={clsx('font-label-sm text-label-sm', d.devices.offline ? 'text-error' : 'text-tertiary')}>
              {d.devices.online}/{d.devices.total - d.devices.pending}
            </span>
          ) : undefined
        },
        { to: '/devices/enrolment', label: 'Biometric Enrolment', icon: 'fingerprint', perm: 'enrolment.view' },
        { to: '/firmware', label: 'Firmware', icon: 'system_update', perm: 'firmware.view' }
      ]
    },
    {
      section: 'System',
      items: [
        {
          to: '/alerts',
          label: 'Alerts',
          icon: 'notifications_active',
          perm: 'alerts.view',
          badge: critical ? <span className="font-label-sm text-label-sm px-1.5 rounded bg-error-container text-on-error-container">{critical}</span> : undefined
        },
        {
          to: '/integration',
          label: 'Integration & Sync',
          icon: 'hub',
          perm: 'integration.view',
          badge: d?.unmappedLocations ? <span className="h-1.5 w-1.5 rounded-full bg-warning" /> : undefined
        },
        { to: '/users', label: 'Users & Roles', icon: 'manage_accounts', perm: 'users.view' },
        { to: '/audit', label: 'Audit Log', icon: 'verified_user', perm: 'audit.view' },
        { to: '/settings', label: 'Settings', icon: 'tune', perm: 'settings.view' }
      ]
    }
  ];
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can, me } = useAuth();
  const nav = useNav();
  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />}
      <aside
        className={clsx(
          'fixed left-0 top-0 h-full w-72 bg-surface-container-lowest border-r border-outline-variant/40 z-50 flex flex-col select-none transition-transform',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        <div className="h-16 px-space-md border-b border-outline-variant/30 flex items-center gap-space-sm">
          <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center shadow-md">
            <Icon name="fingerprint" fill className="text-[20px] text-on-primary-container" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-headline-sm text-headline-sm text-on-surface tracking-tight truncate">
              BAMP<span className="text-secondary">.CORE</span>
            </span>
            <span className="font-label-sm text-label-sm text-outline uppercase tracking-wider truncate">{me?.organization.name ?? 'Attendance Operations'}</span>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-space-sm py-space-sm space-y-space-md">
          {nav.map((s) => {
            const items = s.items.filter((i) => can(i.perm));
            if (!items.length) return null;
            return (
              <nav key={s.section} className="space-y-space-xs">
                <div className="px-space-sm py-1 font-label-sm text-label-sm uppercase tracking-wider text-outline font-semibold">{s.section}</div>
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.end}
                    onClick={onClose}
                    className={({ isActive }) =>
                      clsx(
                        'group flex items-center justify-between px-space-sm py-1.5 rounded transition-colors font-body-sm text-body-sm',
                        isActive ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                      )
                    }
                  >
                    <div className="flex items-center gap-2">
                      <Icon name={i.icon} className="text-[18px] opacity-80 group-hover:text-primary" />
                      <span>{i.label}</span>
                    </div>
                    {i.badge}
                  </NavLink>
                ))}
              </nav>
            );
          })}
        </div>
        <div className="p-space-sm border-t border-outline-variant/30 bg-surface-container-low/40 space-y-1">
          <Link to="/profile" onClick={onClose} className="flex items-center gap-2 px-space-sm py-1.5 rounded text-on-surface-variant hover:bg-surface-container hover:text-on-surface text-body-sm">
            <Icon name="account_circle" className="text-[18px]" /> User Profile
          </Link>
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}

function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button onClick={() => void logout()} className="w-full flex items-center gap-2 px-space-sm py-1.5 rounded text-on-surface-variant hover:bg-error-container/40 hover:text-on-surface text-body-sm">
      <Icon name="logout" className="text-[18px]" /> Logout
    </button>
  );
}

function HealthPill() {
  const { status } = useLive();
  const dash = useQuery<any>({ queryKey: ['dashboard'], queryFn: () => api.get('/api/dashboard'), staleTime: 30_000 });
  const mqtt = dash.data?.realtime?.mqttConnected;
  const p95 = dash.data?.latency?.p95_ingest_ms;
  const ok = status === 'open' && mqtt !== false;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 bg-surface-container-low border border-outline-variant/40 rounded" title="Live channel: dashboard WebSocket bridged from the MQTT broker">
      <Dot tone={ok ? 'success' : status === 'connecting' ? 'warning' : 'error'} pulse={ok} />
      <span className={clsx('font-label-sm text-label-sm whitespace-nowrap', ok ? 'text-tertiary' : 'text-error')}>
        {ok ? 'Live · MQTT connected' : status === 'connecting' ? 'Connecting…' : mqtt === false ? 'Broker disconnected' : 'Live feed offline'}
      </span>
      {p95 !== null && p95 !== undefined && (
        <>
          <span className="text-outline text-[10px]">|</span>
          <span className="font-label-sm text-label-sm text-outline whitespace-nowrap">P95 {(p95 / 1000).toFixed(1)}s</span>
        </>
      )}
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 250);
  const nav = useNavigate();
  const { can } = useAuth();
  const res = useQuery<any>({
    queryKey: ['global-search', dq],
    enabled: dq.length >= 2,
    queryFn: async () => {
      const [emp, dev, loc] = await Promise.all([
        can('employees.view') ? api.get('/api/employees', { q: dq, limit: 5 }) : Promise.resolve({ rows: [] }),
        can('devices.view') ? api.get('/api/devices', { q: dq, limit: 5 }) : Promise.resolve({ rows: [] }),
        can('locations.view') ? api.get('/api/locations', { q: dq }) : Promise.resolve([])
      ]);
      return { emp: emp.rows, dev: dev.rows, loc: (loc as any[]).slice(0, 5) };
    }
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const go = (to: string) => {
    setOpen(false);
    setQ('');
    nav(to);
  };
  const r = res.data;
  return (
    <div className="relative flex-1 max-w-xl mx-space-sm">
      <div className="relative flex items-center">
        <Icon name="search" className="absolute left-2.5 text-[18px] text-outline" />
        <input
          id="global-search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="w-full bg-surface-container-low border border-outline-variant/40 rounded h-8 pl-8 pr-8 font-body-sm text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container"
          placeholder="Search employees, staff number, devices, locations…"
        />
        <kbd className="absolute right-2 px-1.5 py-0.5 font-label-sm text-label-sm bg-surface-container-high text-outline rounded border border-outline-variant/40">/</kbd>
      </div>
      {open && dq.length >= 2 && (
        <div className="absolute left-0 right-0 mt-1 bg-surface-container-high border border-outline-variant/40 rounded shadow-xl z-50 max-h-96 overflow-y-auto py-1">
          {res.isLoading && <div className="px-3 py-2 text-body-sm text-outline">Searching…</div>}
          {r && !r.emp.length && !r.dev.length && !r.loc.length && <div className="px-3 py-2 text-body-sm text-outline">No matches</div>}
          {r?.emp.map((e: any) => (
            <button key={e.id} onMouseDown={() => go(`/employees/${e.id}`)} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-container-highest text-left">
              <Icon name="badge" className="text-[16px] text-outline" />
              <span className="text-body-sm text-on-surface">{e.full_name}</span>
              <span className="font-mono text-[10px] text-outline">{e.staff_number}</span>
            </button>
          ))}
          {r?.dev.map((d: any) => (
            <button key={d.id} onMouseDown={() => go(`/devices/${d.id}`)} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-container-highest text-left">
              <Icon name="router" className="text-[16px] text-outline" />
              <span className="text-body-sm text-on-surface">{d.name}</span>
              <span className="font-mono text-[10px] text-outline">{d.device_uid}</span>
            </button>
          ))}
          {r?.loc.map((l: any) => (
            <button key={l.id} onMouseDown={() => go(`/locations/${l.id}`)} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-container-highest text-left">
              <Icon name="storefront" className="text-[16px] text-outline" />
              <span className="text-body-sm text-on-surface">{l.name}</span>
              <span className="font-mono text-[10px] text-outline">{l.code}</span>
            </button>
          ))}
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
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-1.5 rounded bg-surface-container-low border border-outline-variant/40 text-on-surface-variant hover:text-on-surface hover:bg-surface-container"
        aria-label="Notifications"
      >
        <Icon name="notifications" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-error-container text-on-error-container font-label-sm text-[9px] font-bold border border-background">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-96 z-50 bg-surface-container-high border border-outline-variant/40 rounded-lg shadow-2xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/30">
              <span className="font-headline-sm text-body-sm font-semibold">Notifications</span>
              <button
                className="font-label-sm text-label-sm text-primary hover:underline"
                onClick={async () => {
                  await api.post('/api/notifications/read');
                  void qc.invalidateQueries({ queryKey: ['notifications'] });
                }}
              >
                Mark all read
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {(q.data?.rows ?? []).length === 0 && <div className="px-3 py-6 text-center text-body-sm text-outline">No notifications</div>}
              {(q.data?.rows ?? []).map((n: any) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    void api.post('/api/notifications/read', { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
                    if (n.alert_id) nav(`/alerts/${n.alert_id}`);
                  }}
                  className={clsx('w-full text-left px-3 py-2 border-b border-outline-variant/15 hover:bg-surface-container-highest', !n.read_at && 'bg-primary-container/10')}
                >
                  <div className="flex items-center gap-2">
                    <Dot tone={n.severity === 'critical' ? 'error' : n.severity === 'warning' ? 'warning' : 'info'} />
                    <span className="text-body-sm text-on-surface font-semibold truncate">{n.title}</span>
                  </div>
                  <p className="text-[11px] text-on-surface-variant line-clamp-2 mt-0.5">{n.body}</p>
                  <span className="font-label-sm text-label-sm text-outline">{relative(n.created_at)}</span>
                </button>
              ))}
            </div>
            <Link to="/alerts" onClick={() => setOpen(false)} className="block text-center py-2 font-label-md text-label-md text-primary hover:bg-surface-container-highest">
              Open Alert Center
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function ScopeBar() {
  const { me } = useAuth();
  const [locationId, setLocationId] = useGlobalLocation();
  const locs = useQuery<any[]>({ queryKey: ['locations-lite'], queryFn: () => api.get('/api/locations'), staleTime: 300_000 });
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const tz = me?.organization.timezone;
  return (
    <div className="fixed top-16 left-0 lg:left-72 right-0 h-10 bg-surface-container-low border-b border-outline-variant/30 z-30 px-gutter flex items-center justify-between gap-space-md">
      <div className="flex items-center gap-space-sm min-w-0 font-label-sm text-label-sm">
        <Icon name="dns" className="text-[15px] text-outline" />
        <span className="text-outline hidden sm:inline">Location scope:</span>
        <select
          value={locationId ?? ''}
          onChange={(e) => setLocationId(e.target.value || null)}
          className="bg-surface-container border border-outline-variant/40 rounded px-2 py-0.5 font-label-sm text-label-sm text-on-surface focus:outline-none focus:border-primary-container max-w-[260px]"
        >
          <option value="">{me?.locationScope ? `My locations (${me.locationScope.length})` : `All locations (${locs.data?.length ?? 0})`}</option>
          {(locs.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5 text-outline font-mono text-[11px] whitespace-nowrap">
        <Icon name="schedule" className="text-[14px]" />
        <span>
          UTC {now.toISOString().slice(11, 19)}
          {tz && <> · {tz} {now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false })}</>}
        </span>
      </div>
    </div>
  );
}

export default function AppShell() {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div>
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="lg:pl-72">
        <header className="fixed top-0 left-0 lg:left-72 right-0 h-16 bg-surface-container-lowest/95 backdrop-blur border-b border-outline-variant/40 z-40 px-gutter flex items-center justify-between gap-space-md">
          <div className="flex items-center gap-space-sm min-w-0">
            <button className="lg:hidden p-1.5 text-on-surface-variant" onClick={() => setOpen(true)} aria-label="Menu">
              <Icon name="menu" />
            </button>
            <div className="hidden md:block">
              <HealthPill />
            </div>
          </div>
          <GlobalSearch />
          <div className="flex items-center gap-space-md shrink-0">
            <Notifications />
            <Link to="/profile" className="flex items-center gap-2 pl-2 border-l border-outline-variant/30">
              <Avatar name={me?.user.fullName ?? '?'} size={8} />
              <div className="hidden lg:flex flex-col text-left">
                <div className="flex items-center gap-1.5">
                  <span className="font-body-sm text-body-sm text-on-surface font-semibold max-w-[140px] truncate">{me?.user.fullName}</span>
                  <span className="font-label-sm text-[9px] tracking-wider uppercase px-1 bg-primary-container text-on-primary-container rounded font-bold">{me?.user.roleLabel}</span>
                </div>
                <span className="font-label-sm text-[10px] text-outline truncate max-w-[170px]">{me?.user.jobTitle ?? me?.user.email}</span>
              </div>
            </Link>
          </div>
        </header>
        <ScopeBar />
        <main className="relative pt-26 min-h-screen">
          <div className="flex flex-col w-full space-y-gutter p-gutter max-w-[1800px] mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
