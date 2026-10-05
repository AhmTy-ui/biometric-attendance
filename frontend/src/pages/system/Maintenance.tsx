import { useQuery } from '@tanstack/react-query';
import { Button, Loading } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { time } from '@/lib/format';
import { ComponentHealthList, InlineAlert, StatusScreen, useHealth } from '@/pages/auth/components';

interface Probe {
  maintenance: boolean;
  message: string | null;
  signedIn: boolean;
  checkedAt: number;
}

async function raw(path: string) {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, code: body?.error?.code as string | undefined, message: body?.error?.message as string | undefined };
  } catch {
    throw new ApiError(0, 'offline', 'Connection unavailable.');
  }
}

/**
 * GET /api/auth/me is served even during maintenance (so the shell can load), therefore a maintenance-gated
 * endpoint is probed as well. Raw fetch keeps the global error router from re-navigating on every poll.
 */
async function probe(): Promise<Probe> {
  const [me, gated] = await Promise.all([raw('/api/auth/me'), raw('/api/auth/permissions-matrix')]);
  const hit = [me, gated].find((r) => r.status === 503 && r.code === 'maintenance');
  return { maintenance: Boolean(hit), message: hit?.message ?? null, signedIn: me.status === 200, checkedAt: Date.now() };
}

export default function Maintenance() {
  const health = useHealth(15_000);
  const q = useQuery<Probe, ApiError>({ queryKey: ['maintenance-probe'], queryFn: probe, refetchInterval: 15_000, retry: false, refetchOnWindowFocus: true });
  const p = q.data;
  const over = p && !p.maintenance;

  const recheck = () => {
    void q.refetch();
    void health.refetch();
  };

  return (
    <StatusScreen
      icon={over ? 'check_circle' : 'engineering'}
      tone={over ? 'success' : 'info'}
      code={over ? 'Service restored' : 'HTTP 503 · Scheduled maintenance'}
      title={over ? 'Maintenance has finished' : 'The dashboard is under maintenance'}
      actions={
        over ? (
          <Button variant="primary" size="lg" icon={p?.signedIn ? 'grid_view' : 'login'} onClick={() => window.location.assign(p?.signedIn ? '/' : '/login')}>
            {p?.signedIn ? 'Return to dashboard' : 'Sign in'}
          </Button>
        ) : (
          <Button icon="refresh" loading={q.isFetching} onClick={recheck}>
            Check now
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Loading label="Checking service status…" />
      ) : q.error && !p ? (
        <InlineAlert tone="warning" title="The server is not answering">
          {q.error.message} Checking again every 15 seconds.
        </InlineAlert>
      ) : over ? (
        <p>The platform is accepting requests again. Reload the dashboard to continue where you left off.</p>
      ) : (
        <>
          {p?.message && (
            <InlineAlert tone="info" title="Message from the operations team" icon="campaign">
              {p.message}
            </InlineAlert>
          )}
          <p>
            Only the dashboard is paused. The device API stays online, so fingerprint terminals keep capturing and uploading attendance. This page checks
            again automatically and tells you when the dashboard is back.
          </p>
        </>
      )}
      <div className="flex flex-col gap-space-xs">
        <div className="flex items-center justify-between font-label-sm text-label-sm uppercase tracking-wider text-outline">
          <span>Platform components</span>
          <span className="normal-case tracking-normal">
            {p ? `Last checked ${time(new Date(p.checkedAt))} · refreshes every 15 s` : 'Refreshes every 15 s'}
          </span>
        </div>
        <ComponentHealthList />
      </div>
    </StatusScreen>
  );
}
