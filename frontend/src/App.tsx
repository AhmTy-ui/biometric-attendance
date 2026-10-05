import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { Icon, Loading, PermissionDenied } from '@/components/ui';
import { onGlobalApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { LiveProvider } from '@/lib/live';

// ── Authentication & system states (public) ──
const Login = lazy(() => import('@/pages/auth/Login'));
const ForgotPassword = lazy(() => import('@/pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/auth/ResetPassword'));
const AccountSetup = lazy(() => import('@/pages/auth/AccountSetup'));
const AccountLocked = lazy(() => import('@/pages/auth/AccountLocked'));
const SessionExpired = lazy(() => import('@/pages/system/SessionExpired'));
const Maintenance = lazy(() => import('@/pages/system/Maintenance'));
const NotFound = lazy(() => import('@/pages/system/NotFound'));
const Forbidden = lazy(() => import('@/pages/system/Forbidden'));
const ServerError = lazy(() => import('@/pages/system/ServerError'));

// ── Application ──
const SetupWizard = lazy(() => import('@/pages/setup/SetupWizard'));
const Dashboard = lazy(() => import('@/pages/dashboard/Dashboard'));
const LiveAttendance = lazy(() => import('@/pages/attendance/LiveAttendance'));
const AttendanceHistory = lazy(() => import('@/pages/attendance/AttendanceHistory'));
const AttendanceDetail = lazy(() => import('@/pages/attendance/AttendanceDetail'));
const Reconciliation = lazy(() => import('@/pages/attendance/Reconciliation'));
const Reports = lazy(() => import('@/pages/reports/Reports'));
const EmployeeDirectory = lazy(() => import('@/pages/employees/EmployeeDirectory'));
const EmployeeProfile = lazy(() => import('@/pages/employees/EmployeeProfile'));
const LocationDirectory = lazy(() => import('@/pages/locations/LocationDirectory'));
const LocationDetails = lazy(() => import('@/pages/locations/LocationDetails'));
const DeviceRegistry = lazy(() => import('@/pages/devices/DeviceRegistry'));
const DeviceDetails = lazy(() => import('@/pages/devices/DeviceDetails'));
const DeviceProvisioning = lazy(() => import('@/pages/devices/DeviceProvisioning'));
const EnrolmentMonitor = lazy(() => import('@/pages/devices/EnrolmentMonitor'));
const Firmware = lazy(() => import('@/pages/firmware/Firmware'));
const FirmwareDeploy = lazy(() => import('@/pages/firmware/FirmwareDeploy'));
const FirmwareDeploymentDetails = lazy(() => import('@/pages/firmware/FirmwareDeploymentDetails'));
const Alerts = lazy(() => import('@/pages/alerts/Alerts'));
const AlertDetails = lazy(() => import('@/pages/alerts/AlertDetails'));
const Integration = lazy(() => import('@/pages/integration/Integration'));
const SyncDetails = lazy(() => import('@/pages/integration/SyncDetails'));
const UnmappedLocations = lazy(() => import('@/pages/integration/UnmappedLocations'));
const Users = lazy(() => import('@/pages/users/Users'));
const CreateUser = lazy(() => import('@/pages/users/CreateUser'));
const UserDetails = lazy(() => import('@/pages/users/UserDetails'));
const RolesPermissions = lazy(() => import('@/pages/users/RolesPermissions'));
const AuditLog = lazy(() => import('@/pages/audit/AuditLog'));
const AuditDetail = lazy(() => import('@/pages/audit/AuditDetail'));
const Settings = lazy(() => import('@/pages/settings/Settings'));
const Profile = lazy(() => import('@/pages/profile/Profile'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, error } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading label="Loading…" className="min-h-screen" />;
  if (!me) {
    if (error?.code === 'session_expired') return <Navigate to="/session-expired" replace />;
    if (error?.code === 'maintenance') return <Navigate to="/maintenance" replace />;
    if (error && error.status !== 401) return <Navigate to="/500" replace />;
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  return <>{children}</>;
}

function Perm({ p, children }: { p: string; children: ReactNode }) {
  const { can } = useAuth();
  return can(p) ? <>{children}</> : <PermissionDenied />;
}

function GlobalErrorRouter() {
  const nav = useNavigate();
  const loc = useLocation();
  const [offline, setOffline] = useState(false);
  useEffect(
    () =>
      onGlobalApiError((e) => {
        const publicRoute = ['/login', '/forgot-password', '/reset-password', '/setup/account', '/session-expired', '/maintenance', '/account-locked'].some((p) => loc.pathname.startsWith(p));
        if (e.code === 'session_expired' && !publicRoute) nav('/session-expired', { replace: true });
        else if (e.code === 'maintenance') nav('/maintenance', { replace: true });
        else if (e.status === 0) setOffline(true);
      }),
    [nav, loc.pathname]
  );
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[150] bg-secondary-container/90 text-on-secondary-container px-4 py-2 rounded shadow-xl flex items-center gap-2 text-body-sm">
      <Icon name="cloud_off" />
      <span>Connection unavailable. Showing the latest synchronized data.</span>
      <button className="underline ml-2" onClick={() => location.reload()}>
        Try Again
      </button>
    </div>
  );
}

export default function App() {
  const { me } = useAuth();
  return (
    <LiveProvider enabled={Boolean(me)}>
      <GlobalErrorRouter />
      <Suspense fallback={<Loading className="min-h-screen" />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/setup/account" element={<AccountSetup />} />
          <Route path="/account-locked" element={<AccountLocked />} />
          <Route path="/session-expired" element={<SessionExpired />} />
          <Route path="/maintenance" element={<Maintenance />} />
          <Route path="/403" element={<Forbidden />} />
          <Route path="/500" element={<ServerError />} />

          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Perm p="dashboard.view"><Dashboard /></Perm>} />
            <Route path="setup" element={<Perm p="settings.manage"><SetupWizard /></Perm>} />
            <Route path="attendance/live" element={<Perm p="attendance.view"><LiveAttendance /></Perm>} />
            <Route path="attendance/history" element={<Perm p="attendance.view"><AttendanceHistory /></Perm>} />
            <Route path="attendance/events/:id" element={<Perm p="attendance.view"><AttendanceDetail /></Perm>} />
            <Route path="attendance/reconciliation" element={<Perm p="attendance.view"><Reconciliation /></Perm>} />
            <Route path="reports" element={<Perm p="reports.view"><Reports /></Perm>} />
            <Route path="employees" element={<Perm p="employees.view"><EmployeeDirectory /></Perm>} />
            <Route path="employees/:id" element={<Perm p="employees.view"><EmployeeProfile /></Perm>} />
            <Route path="locations" element={<Perm p="locations.view"><LocationDirectory /></Perm>} />
            <Route path="locations/:id" element={<Perm p="locations.view"><LocationDetails /></Perm>} />
            <Route path="devices" element={<Perm p="devices.view"><DeviceRegistry /></Perm>} />
            <Route path="devices/provision" element={<Perm p="devices.provision"><DeviceProvisioning /></Perm>} />
            <Route path="devices/enrolment" element={<Perm p="enrolment.view"><EnrolmentMonitor /></Perm>} />
            <Route path="devices/:id" element={<Perm p="devices.view"><DeviceDetails /></Perm>} />
            <Route path="firmware" element={<Perm p="firmware.view"><Firmware /></Perm>} />
            <Route path="firmware/deploy" element={<Perm p="firmware.manage"><FirmwareDeploy /></Perm>} />
            <Route path="firmware/deployments/:id" element={<Perm p="firmware.view"><FirmwareDeploymentDetails /></Perm>} />
            <Route path="alerts" element={<Perm p="alerts.view"><Alerts /></Perm>} />
            <Route path="alerts/:id" element={<Perm p="alerts.view"><AlertDetails /></Perm>} />
            <Route path="integration" element={<Perm p="integration.view"><Integration /></Perm>} />
            <Route path="integration/runs/:id" element={<Perm p="integration.view"><SyncDetails /></Perm>} />
            <Route path="integration/unmapped" element={<Perm p="integration.view"><UnmappedLocations /></Perm>} />
            <Route path="users" element={<Perm p="users.view"><Users /></Perm>} />
            <Route path="users/new" element={<Perm p="users.manage"><CreateUser /></Perm>} />
            <Route path="users/roles" element={<Perm p="users.view"><RolesPermissions /></Perm>} />
            <Route path="users/:id" element={<Perm p="users.view"><UserDetails /></Perm>} />
            <Route path="audit" element={<Perm p="audit.view"><AuditLog /></Perm>} />
            <Route path="audit/:seq" element={<Perm p="audit.view"><AuditDetail /></Perm>} />
            <Route path="settings" element={<Perm p="settings.view"><Settings /></Perm>} />
            <Route path="profile" element={<Profile />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </LiveProvider>
  );
}
