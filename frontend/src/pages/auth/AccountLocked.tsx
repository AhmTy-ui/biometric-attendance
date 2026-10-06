import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LinkButton, Progress } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { InlineAlert, StatusScreen } from './components';

function fmtRemaining(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function AccountLocked() {
  const loc = useLocation();
  const state = (loc.state ?? {}) as { lockedUntil?: string | null; email?: string };
  const until = state.lockedUntil ? new Date(state.lockedUntil) : null;
  const valid = until && !Number.isNaN(until.getTime()) ? until : null;
  const [now, setNow] = useState(Date.now());
  const [initial] = useState(() => (valid ? Math.max(0, valid.getTime() - Date.now()) : 0));

  useEffect(() => {
    if (!valid) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [valid?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = valid ? valid.getTime() - now : null;
  const expired = remaining !== null && remaining <= 0;

  return (
    <StatusScreen
      icon={expired ? 'lock_open' : 'lock_clock'}
      tone={expired ? 'success' : 'error'}
      code="HTTP 423 · Account locked"
      title={expired ? 'The lock has expired' : 'Account temporarily locked'}
      actions={
        <>
          <LinkButton to="/login" variant={expired ? 'primary' : 'secondary'} icon="login">
            {expired ? 'Sign in again' : 'Back to sign in'}
          </LinkButton>
          <LinkButton to="/forgot-password" variant={expired ? 'secondary' : 'primary'} icon="lock_reset">
            Reset password
          </LinkButton>
        </>
      }
    >
      <p>
        {state.email ? (
          <>
            The account <strong className="text-on-surface">{state.email}</strong> was
          </>
        ) : (
          'This account was'
        )}{' '}
        locked after too many failed sign-in or verification attempts. This protects the account from password guessing; the event has been recorded in the audit
        log.
      </p>
      {valid && remaining !== null && (
        <div className="bg-surface-container-lowest rounded-lg p-space-md flex flex-col gap-space-sm">
          <div className="flex items-end justify-between gap-space-md">
            <div>
              <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline">{expired ? 'Unlocked at' : 'Unlocks in'}</div>
              <div className={expired ? 'font-mono text-headline-md text-tertiary' : 'font-mono text-headline-xl text-on-surface'}>
                {expired ? dateTime(valid) : fmtRemaining(remaining)}
              </div>
            </div>
            {!expired && (
              <div className="text-right">
                <div className="font-label-sm text-label-sm uppercase tracking-wider text-outline">Unlock time</div>
                <div className="font-mono text-body-sm text-on-surface-variant">{dateTime(valid)}</div>
              </div>
            )}
          </div>
          {!expired && initial > 0 && <Progress value={100 - (remaining / initial) * 100} tone="warning" />}
        </div>
      )}
      {expired ? (
        <InlineAlert tone="success">You can sign in again now. Further failed attempts will lock the account again.</InlineAlert>
      ) : (
        <ul className="list-disc pl-5 flex flex-col gap-1 font-body-sm text-body-sm">
          <li>{valid ? 'Wait until the lock expires, then sign in again.' : 'Wait for the lockout period set by your administrator to pass, then sign in again.'}</li>
          <li>Resetting your password by email also removes the lock immediately.</li>
          <li>If you did not make these attempts, reset your password and tell your administrator.</li>
        </ul>
      )}
    </StatusScreen>
  );
}
