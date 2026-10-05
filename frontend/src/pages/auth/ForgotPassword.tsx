import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LinkButton } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { AuthField, AuthLayout, ErrorAlert, InlineAlert, PrimaryAction } from './components';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const address = email.trim();
    try {
      await api.post('/api/auth/forgot-password', { email: address });
      setSentTo(address);
    } catch (err) {
      const e = err as ApiError;
      // Only transport / throttling / server problems are surfaced; anything else gets the same neutral answer
      // so the form cannot be used to discover which addresses have accounts.
      if (e.status === 0 || e.status === 429 || e.status >= 500 || (e.status === 400 && e.code === 'bad_request')) setError(err);
      else setSentTo(address);
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <Link to="/login" className="hover:text-on-surface">
      Back to sign in
    </Link>
  );

  if (sentTo !== null)
    return (
      <AuthLayout title="Check your email" badge="Password reset" subtitle="If the address matches an active account, a reset link is on its way." footerLinks={footer}>
        <div className="flex flex-col gap-space-md">
          <InlineAlert tone="info" title="Request received" icon="mark_email_read">
            <p>
              If an active dashboard account exists for <strong className="text-on-surface">{sentTo}</strong>, we've sent it a link to choose a new password. The link
              is valid for 1 hour and can be used once.
            </p>
          </InlineAlert>
          <ul className="list-disc pl-5 font-body-sm text-body-sm text-on-surface-variant flex flex-col gap-1">
            <li>Check your spam or junk folder if the email doesn't arrive within a few minutes.</li>
            <li>Setting a new password signs you out on all devices and clears any temporary lockout.</li>
            <li>Still no email? Your administrator can confirm the address on your account and that outgoing email is configured.</li>
          </ul>
          <div className="flex flex-wrap gap-space-sm">
            <LinkButton to="/login" variant="primary" icon="login">
              Return to sign in
            </LinkButton>
            <button
              type="button"
              className="font-label-md text-label-md text-secondary hover:underline px-2"
              onClick={() => {
                setSentTo(null);
                setEmail('');
              }}
            >
              Use a different email
            </button>
          </div>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Forgot your password?" badge="Password reset" subtitle="Enter the email address of your dashboard account and we'll send you a reset link." footerLinks={footer}>
      <form className="flex flex-col gap-space-md" onSubmit={(e) => void submit(e)}>
        {error ? <ErrorAlert error={error} /> : null}
        <AuthField
          label="Email"
          icon="alternate_email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
          placeholder="name@organisation.com"
        />
        <PrimaryAction icon="send" loading={busy} disabled={!email.trim()}>
          Send reset link
        </PrimaryAction>
        <p className="font-body-sm text-body-sm text-outline">
          Remembered it?{' '}
          <Link to="/login" className="text-secondary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
