import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { ComponentHealthList, safeNext, StatusScreen } from '@/pages/auth/components';

export default function ServerError() {
  const loc = useLocation();
  const { error } = useAuth();
  const [busy, setBusy] = useState(false);
  const from = safeNext((loc.state as { from?: string } | null)?.from);

  const retry = () => {
    setBusy(true);
    // Reload the app at the page that failed (or the dashboard when unknown) so all data is fetched again.
    if (loc.pathname === from) window.location.reload();
    else window.location.assign(from);
  };

  return (
    <StatusScreen
      icon="error"
      tone="error"
      code="HTTP 500 · Server error"
      title="Something went wrong."
      actions={
        <Button variant="primary" size="lg" icon="refresh" loading={busy} onClick={retry}>
          Try Again
        </Button>
      }
      footerLinks={
        <Link to="/login" className="hover:text-on-surface">
          Sign in
        </Link>
      }
    >
      <p>The server could not complete the request. Try again in a moment; if it keeps happening, contact your administrator.</p>
      {error && error.status >= 500 && (
        <p className="font-mono text-[12px] bg-surface-container-lowest rounded px-space-sm py-space-xs text-on-surface-variant break-words">
          {error.status} · {error.code} · {error.message}
        </p>
      )}
      <div className="flex flex-col gap-space-xs">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Platform components</span>
        <ComponentHealthList />
      </div>
    </StatusScreen>
  );
}
