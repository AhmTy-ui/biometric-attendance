import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Icon, KV, LinkButton, Loading } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth, type Me } from '@/lib/auth';
import {
  AuthField,
  AuthLayout,
  ErrorAlert,
  InlineAlert,
  MfaSetupPanel,
  passwordAcceptable,
  PasswordField,
  PolicyChecklist,
  PrimaryAction,
  RecoveryCodesPanel,
  Stepper,
  TextLink,
  type PasswordPolicy
} from './components';

interface Invite {
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
  organization: string | null;
  policy: PasswordPolicy;
  mfaRequired: boolean;
}

const STEPS = ['Account', 'Password', 'MFA', 'Recovery codes', 'Organization'];

function maskEmail(email: string) {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  const shown = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, user.length - shown!.length))}@${domain}`;
}

export default function AccountSetup() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [typedEmail, setTypedEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [challengeExpired, setChallengeExpired] = useState(false);
  const [optionalMfa, setOptionalMfa] = useState<'ask' | 'setup'>('ask');
  const [codes, setCodes] = useState<string[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tokenGone, setTokenGone] = useState(false);

  const invite = useQuery<Invite, ApiError>({
    queryKey: ['invite', token],
    queryFn: () => api.get<Invite>(`/api/auth/invite/${encodeURIComponent(token)}`),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity
  });

  const footer = (
    <Link to="/login" className="hover:text-on-surface">
      Already set up? Sign in
    </Link>
  );

  const goToOrganization = async () => {
    setBusy(true);
    try {
      const r = (await refresh()) as { data?: Me } | undefined;
      setMe(r?.data ?? null);
      setMeFailed(!r?.data);
    } catch {
      setMeFailed(true);
    } finally {
      setBusy(false);
      setStep(4);
    }
  };

  // ── Invalid / expired / missing invitation ──
  if (!accepted && (!token || tokenGone || invite.error?.status === 410))
    return (
      <AuthLayout title="Invitation unavailable" badge="First-time setup" footerLinks={footer}>
        <div className="flex flex-col gap-space-md">
          <InlineAlert tone="error" icon="link_off" title={token ? 'This invitation is invalid or has expired.' : 'This page needs an invitation link.'}>
            Invitation links are valid for 7 days and can be used once. Ask an administrator to resend your invitation from Users &amp; Roles.
          </InlineAlert>
          <LinkButton to="/login" icon="login" className="self-start">
            Go to sign in
          </LinkButton>
        </div>
      </AuthLayout>
    );

  if (invite.isLoading)
    return (
      <AuthLayout title="Set up your account" badge="First-time setup" footerLinks={footer}>
        <Loading label="Checking your invitation…" />
      </AuthLayout>
    );

  if (!invite.data)
    return (
      <AuthLayout title="Set up your account" badge="First-time setup" footerLinks={footer}>
        <div className="flex flex-col gap-space-md">
          <ErrorAlert error={invite.error} title="Could not load your invitation" />
          <Button icon="refresh" className="self-start" onClick={() => void invite.refetch()}>
            Try Again
          </Button>
        </div>
      </AuthLayout>
    );

  const inv = invite.data;
  const stepper = <Stepper steps={STEPS} current={step} />;

  // ── Step 1: verify account ──
  if (step === 0) {
    const submit = (ev: FormEvent) => {
      ev.preventDefault();
      if (typedEmail.trim().toLowerCase() !== inv.email.toLowerCase()) {
        setEmailError('This email address does not match the invitation.');
        return;
      }
      setEmailError(null);
      setStep(1);
    };
    return (
      <AuthLayout
        top={stepper}
        title="Verify your account"
        badge="First-time setup"
        subtitle={`${inv.organization ? `${inv.organization} invited you` : 'You were invited'} to the Biometric Attendance Management Platform.`}
        footerLinks={footer}
      >
        <form className="flex flex-col gap-space-md" onSubmit={submit}>
          <div className="bg-surface-container-lowest rounded-lg p-space-md">
            <KV label="Name">{inv.fullName}</KV>
            <KV label="Role">
              <Badge tone="primary">{inv.roleLabel}</Badge>
            </KV>
            <KV label="Organization">{inv.organization ?? '—'}</KV>
            <KV label="Invited address" mono>
              {maskEmail(inv.email)}
            </KV>
            <KV label="MFA">{inv.mfaRequired ? 'Required for your role' : 'Optional (recommended)'}</KV>
          </div>
          {error ? <ErrorAlert error={error} /> : null}
          <AuthField
            label="Confirm your email address"
            icon="alternate_email"
            type="email"
            value={typedEmail}
            onChange={(e) => setTypedEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            hint="Type the full address this invitation was sent to."
            error={emailError}
          />
          <PrimaryAction icon="arrow_forward" disabled={!typedEmail.trim()}>
            Continue
          </PrimaryAction>
        </form>
      </AuthLayout>
    );
  }

  // ── Step 2: set password ──
  if (step === 1) {
    const ok = passwordAcceptable(inv.policy, password, confirm);
    const submit = async (ev: FormEvent) => {
      ev.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = await api.post<{ ok?: boolean; mfaSetupRequired?: boolean; challengeToken?: string }>('/api/auth/invite/accept', {
          token,
          email: typedEmail.trim(),
          password
        });
        setAccepted(true);
        setPassword('');
        setConfirm('');
        if (r.mfaSetupRequired && r.challengeToken) {
          setChallenge(r.challengeToken);
          setStep(2);
        } else {
          setOptionalMfa('ask');
          setStep(2);
        }
      } catch (err) {
        const e = err as ApiError;
        if (e.status === 410) setTokenGone(true);
        else if (e.status === 400 && /email/i.test(e.message) && !Array.isArray(e.details)) {
          setError(err);
          setStep(0);
        } else setError(err);
      } finally {
        setBusy(false);
      }
    };
    return (
      <AuthLayout top={stepper} title="Set your password" badge="First-time setup" subtitle="Choose a password that meets your organisation's policy." footerLinks={footer}>
        <form className="flex flex-col gap-space-md" onSubmit={(e) => void submit(e)}>
          <AuthField label="Account" icon="badge" type="email" value={typedEmail.trim()} readOnly autoComplete="username" />
          <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
          <PasswordField
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            error={confirm && password !== confirm ? 'Passwords do not match.' : null}
          />
          <PolicyChecklist policy={inv.policy} password={password} confirm={confirm} />
          {error ? <ErrorAlert error={error} /> : null}
          <PrimaryAction icon="lock" loading={busy} disabled={!ok}>
            Save password
          </PrimaryAction>
          <TextLink onClick={() => setStep(0)}>Back</TextLink>
        </form>
      </AuthLayout>
    );
  }

  // ── Step 3: MFA ──
  if (step === 2) {
    if (challengeExpired)
      return (
        <AuthLayout top={stepper} title="Configure MFA" badge="First-time setup" footerLinks={footer}>
          <div className="flex flex-col gap-space-md">
            <InlineAlert tone="warning" title="Your verification window expired">
              Your account is verified and your password is saved. Sign in with your email and new password to finish setting up your authenticator app.
            </InlineAlert>
            <LinkButton to="/login" variant="primary" icon="login" className="self-start">
              Sign in to continue
            </LinkButton>
          </div>
        </AuthLayout>
      );
    if (challenge)
      return (
        <AuthLayout
          top={stepper}
          title="Configure MFA"
          badge="Required"
          subtitle="Your role requires multi-factor authentication. Link an authenticator app to finish activating your account."
          footerLinks={footer}
        >
          <MfaSetupPanel
            challengeToken={challenge}
            onComplete={(r) => {
              setCodes(r.recoveryCodes);
              setChallenge(null);
              setStep(3);
            }}
            onExpired={() => setChallengeExpired(true)}
          />
        </AuthLayout>
      );
    // MFA optional for this role; a session already exists.
    return (
      <AuthLayout
        top={stepper}
        title="Configure MFA"
        badge="Recommended"
        subtitle="Multi-factor authentication is optional for your role, but strongly recommended."
        footerLinks={footer}
      >
        {optionalMfa === 'setup' ? (
          <MfaSetupPanel
            onComplete={(r) => {
              setCodes(r.recoveryCodes);
              setStep(3);
            }}
            onCancel={() => setOptionalMfa('ask')}
          />
        ) : (
          <div className="flex flex-col gap-space-md">
            <InlineAlert tone="success" title="Your account is active" icon="task_alt">
              Your password is saved and you are signed in.
            </InlineAlert>
            <div className="bg-surface-container-lowest rounded-lg p-space-md flex items-start gap-space-md">
              <Icon name="phonelink_lock" fill className="text-[28px] text-secondary shrink-0" />
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                With MFA enabled, signing in also needs a 6-digit code from an authenticator app on your phone, so a leaked password alone cannot open your
                account. You can also enable it later from your User Profile.
              </p>
            </div>
            <PrimaryAction type="button" icon="verified_user" onClick={() => setOptionalMfa('setup')}>
              Set up MFA now
            </PrimaryAction>
            <Button variant="ghost" loading={busy} onClick={() => void goToOrganization()}>
              Skip for now
            </Button>
          </div>
        )}
      </AuthLayout>
    );
  }

  // ── Step 4: recovery codes ──
  if (step === 3)
    return (
      <AuthLayout top={stepper} title="Save your recovery codes" badge="First-time setup" subtitle="MFA is enabled. These codes let you sign in if you lose your authenticator app." footerLinks={footer}>
        <RecoveryCodesPanel codes={codes} email={inv.email} continueLabel="Continue" continueLoading={busy} onContinue={() => void goToOrganization()} />
      </AuthLayout>
    );

  // ── Step 5: organisation review ──
  const needsSetup = Boolean(me && !me.organization.setupCompleted && me.permissions.includes('settings.manage'));
  return (
    <AuthLayout top={stepper} title="Review your organization" badge="Almost done" subtitle="Your account is ready." footerLinks={footer}>
      {meFailed || !me ? (
        <div className="flex flex-col gap-space-md">
          <InlineAlert tone="warning" title="We couldn't load your session">
            Your account is set up. Sign in to continue.
          </InlineAlert>
          <LinkButton to="/login" variant="primary" icon="login" className="self-start">
            Sign in
          </LinkButton>
        </div>
      ) : (
        <div className="flex flex-col gap-space-md">
          <div className="bg-surface-container-lowest rounded-lg p-space-md">
            <KV label="Organization">{me.organization.name}</KV>
            <KV label="Timezone" mono>
              {me.organization.timezone}
            </KV>
            <KV label="Signed in as">{me.user.fullName}</KV>
            <KV label="Role">
              <Badge tone="primary">{me.user.roleLabel}</Badge>
            </KV>
            <KV label="Location access">{me.locationScope ? (me.locationScope.length ? me.locationScope.map((l) => l.name).join(', ') : 'No locations assigned yet') : 'All locations'}</KV>
            <KV label="MFA">{me.user.mfaEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="warning">Not enabled</Badge>}</KV>
            <KV label="Organization setup">{me.organization.setupCompleted ? <Badge tone="success">Completed</Badge> : <Badge tone="warning">Not completed</Badge>}</KV>
          </div>
          {needsSetup ? (
            <>
              <InlineAlert tone="info" title="Your organization still needs to be configured">
                Next you'll confirm organization details, connect the web software, create locations, register devices and synchronise employees.
              </InlineAlert>
              <PrimaryAction type="button" icon="rocket_launch" onClick={() => navigate('/setup', { replace: true })}>
                Start organization setup
              </PrimaryAction>
            </>
          ) : (
            <>
              {me.locationScope && me.locationScope.length === 0 && (
                <InlineAlert tone="warning">No locations are assigned to your account yet. Ask an administrator to grant location access.</InlineAlert>
              )}
              <PrimaryAction type="button" icon="grid_view" onClick={() => navigate('/', { replace: true })}>
                Go to dashboard
              </PrimaryAction>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
