import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Icon, LinkButton, Panel } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/** 404 inside the application shell (content only — the sidebar and top bar are rendered by AppShell). */
export default function NotFound() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const shortcuts = [
    { to: '/', label: 'Dashboard', icon: 'grid_view', perm: 'dashboard.view' },
    { to: '/attendance/live', label: 'Live Attendance', icon: 'stream', perm: 'attendance.view' },
    { to: '/employees', label: 'Employees', icon: 'badge', perm: 'employees.view' },
    { to: '/devices', label: 'Device Registry', icon: 'router', perm: 'devices.view' },
    { to: '/alerts', label: 'Alerts', icon: 'notifications_active', perm: 'alerts.view' }
  ].filter((s) => can(s.perm));

  return (
    <div className="flex items-center justify-center py-space-xl">
      <Panel className="w-full max-w-2xl" accent="warning">
        <div className="flex items-start gap-space-md pt-space-sm">
          <div className="w-12 h-12 rounded-lg bg-surface-container-lowest flex items-center justify-center shrink-0 text-warning shadow-inner">
            <Icon name="travel_explore" className="text-[28px]" />
          </div>
          <div className="min-w-0">
            <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline mb-1">HTTP 404 · Not found</div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">This page doesn't exist</h1>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1">
              Nothing is available at{' '}
              <code className="font-mono text-[12px] bg-surface-container-lowest px-1.5 py-0.5 rounded text-secondary break-all">{loc.pathname}</code>. The link may be
              outdated, or the record may have been removed.
            </p>
          </div>
        </div>
        <div className="mt-space-lg flex flex-wrap gap-space-sm">
          <Button icon="arrow_back" onClick={() => navigate(-1)}>
            Go back
          </Button>
          {shortcuts.map((s) => (
            <LinkButton key={s.to} to={s.to} icon={s.icon} variant={s.to === '/' ? 'primary' : 'secondary'}>
              {s.label}
            </LinkButton>
          ))}
        </div>
      </Panel>
    </div>
  );
}
