import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Icon, LinkButton, Loading } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import {
  AuthField,
  AuthLayout,
  ErrorAlert,
  InlineAlert,
  passwordAcceptable,
  PasswordField,
  PolicyChecklist,
  PrimaryAction,
  type PasswordPolicy
} from './components';

interface ResetInfo {
  email: string;
  policy: PasswordPolicy & { lockoutThreshold?: number; lockoutMinutes?: number };
}

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);

  const info = useQuery<ResetInfo, ApiError>({
    queryKey: ['reset-token', token],
    queryFn: () => api.get<ResetInfo>(`/api/auth/reset-password/${encodeURIComponent(token)}`),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity
  });

  const footer = (
    <>
      <Link to="/login" className="hover:text-on-surface">
        Sign in
      </Link>
      <span>•</span>
      <Link to="/forgot-password" className="hover:text-on-surface">
        Request a new link
      </Link>
    </>
  );

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
      setPassword('');
      setConfirm('');
    } catch (err) {
      if ((err as ApiError).status === 410) setExpired(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  // ── Invalid / expired link ──
  if (!token || expired || info.error?.status === 410)
    return (
      <AuthLayout title="Reset link unavailable" badge="Password reset">
        <div className="flex flex-col gap-space-md">
          <InlineAlert tone="error" title={token ? 'This reset link is invalid or has expired.' : 'This page needs a reset link.'} icon="link_off">
            Reset links are valid for 1 hour and can be used only once. Request a new link and open the most recent email you receive.
          </InlineAlert>
          <div className="flex flex-wrap gap-space-sm">
            <LinkButton to="/forgot-password" variant="primary" icon="send">
              Request a new link
            </LinkButton>
            <LinkButton to="/login" icon="login">
              Back to sign in
            </LinkButton>
          </div>
        </div>
      </AuthLayout>
    );

  if (done)
    return (
      <AuthLayout title="Password updated" badge="Password reset">
        <div className="flex flex-col gap-space-md">
          <InlineAlert tone="success" title="Your new password is set." icon="task_alt">
            All existing sessions for {info.data?.email ?? 'this account'} were signed out and any temporary lockout was cleared.
          </InlineAlert>
          <LinkButton to="/login?reset=1" variant="primary" icon="login" size="lg">
            Continue to sign in
          </LinkButton>
        </div>
      </AuthLayout>
    );

  if (info.isLoading)
    return (
      <AuthLayout title="Choose a new password" badge="Password reset" footerLinks={footer}>
        <Loading label="Checking your reset link…" />
      </AuthLayout>
    );

  if (info.error || !info.data)
    return (
      <AuthLayout title="Choose a new password" badge="Password reset" footerLinks={footer}>
        <div className="flex flex-col gap-space-md">
          <ErrorAlert error={info.error} title="Could not verify the reset link" />
          <Button icon="refresh" onClick={() => void info.refetch()} className="self-start">
            Try Again
          </Button>
        </div>
      </AuthLayout>
    );

  const policy = info.data.policy;
  const ok = passwordAcceptable(policy, password, confirm);

  return (
    <AuthLayout title="Choose a new password" badge="Password reset" subtitle="Your new password must meet your organisation's policy." footerLinks={footer}>
      <form className="flex flex-col gap-space-md" onSubmit={(e) => void submit(e)}>
        {/* Read-only username field lets password managers attach the new password to the right account. */}
        <AuthField label="Account" icon="badge" type="email" value={info.data.email} readOnly autoComplete="username" aside={<Icon name="lock" className="text-[14px] text-outline" />} />
        <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
        <PasswordField
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          error={confirm && password !== confirm ? 'Passwords do not match.' : null}
        />
        <PolicyChecklist policy={policy} password={password} confirm={confirm} />
        {error ? <ErrorAlert error={error} /> : null}
        <PrimaryAction icon="lock_reset" loading={busy} disabled={!ok}>
          Set new password
        </PrimaryAction>
      </form>
    </AuthLayout>
  );
}
