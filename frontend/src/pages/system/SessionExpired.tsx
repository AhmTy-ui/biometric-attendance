import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { StatusScreen } from '@/pages/auth/components';

export default function SessionExpired() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Drop the dead session cookie and any cached data belonging to it.
  useEffect(() => {
    void api.post('/api/auth/logout').catch(() => undefined);
  }, []);

  const signIn = async () => {
    setBusy(true);
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    // Full navigation so every cached view is rebuilt for the new session.
    window.location.assign('/login?expired=1');
  };

  return (
    <StatusScreen
      icon="timer_off"
      tone="warning"
      code="HTTP 401 · Session expired"
      title="Your session has expired"
      actions={
        <Button variant="primary" size="lg" icon="login" loading={busy} onClick={() => void signIn()}>
          Sign in again
        </Button>
      }
      footerLinks={
        <Link to="/forgot-password" className="hover:text-on-surface">
          Reset password
        </Link>
      }
    >
      <p>For your security you were signed out. This happens when:</p>
      <ul className="list-disc pl-5 flex flex-col gap-1 font-body-sm text-body-sm">
        <li>the dashboard was idle for longer than your organisation's idle timeout,</li>
        <li>the session reached its maximum lifetime,</li>
        <li>you signed out, changed or reset your password in another window, or</li>
        <li>an administrator disabled your account or changed your access.</li>
      </ul>
      <p className="font-body-sm text-body-sm">Unsaved changes on the previous page were not submitted. Sign in again to continue.</p>
    </StatusScreen>
  );
}
