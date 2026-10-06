import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  AuthField,
  AuthLayout,
  CodeInput,
  destinationFor,
  errorText,
  InlineAlert,
  MfaSetupPanel,
  PasswordField,
  PrimaryAction,
  RecoveryCodesPanel,
  TextLink,
  useFinishSignIn
} from './components';

type Phase = 'credentials' | 'mfa' | 'mfa_setup' | 'recovery_codes';

interface LoginResponse {
  ok?: boolean;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  challengeToken?: string;
}

interface Notice {
  tone: 'error' | 'warning' | 'info' | 'success';
  title?: string;
  text: string;
}

export default function Login() {
  const [params] = useSearchParams();
  const next = params.get('next');
  const navigate = useNavigate();
  const finish = useFinishSignIn();
  const { me, loading: authLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(
    params.get('reset') === '1'
      ? { tone: 'success', text: 'Your password was updated. Sign in with your new password.' }
      : params.get('expired') === '1'
        ? { tone: 'info', text: 'Your session expired. Please sign in again.' }
        : null
  );

  // Already signed in → go straight to the app.
  if (phase === 'credentials' && !busy && !authLoading && me) return <Navigate to={destinationFor(me, next)} replace />;

  const backToCredentials = (n: Notice | null) => {
    setPhase('credentials');
    setChallenge(null);
    setCode('');
    setRecoveryCode('');
    setUseRecovery(false);
    setPassword('');
    setNotice(n);
  };

  const handleError = (err: unknown) => {
    const e = err as ApiError;
    if (e.status === 423) {
      navigate('/account-locked', { state: { lockedUntil: e.details?.lockedUntil ?? null, email } });
      return;
    }
    if (e.code === 'challenge_expired') {
      backToCredentials({ tone: 'warning', text: e.message || 'Your verification window expired. Please sign in again.' });
      return;
    }
    if (e.status === 403 && e.code === 'account_disabled') {
      setNotice({ tone: 'error', title: 'Account disabled', text: e.message });
      return;
    }
    if (e.status === 401) {
      const left = e.details?.attemptsRemaining;
      setNotice({
        tone: 'error',
        text: e.message,
        title:
          typeof left === 'number'
            ? left <= 0
              ? 'No attempts remaining before lockout'
              : `${left} attempt${left === 1 ? '' : 's'} remaining before the account is locked`
            : undefined
      });
      return;
    }
    const t = errorText(err);
    setNotice({ tone: 'error', text: [t.message, ...t.details].join(' · ') });
  };

  const submitCredentials = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.post<LoginResponse>('/api/auth/login', { email: email.trim(), password });
      if (r.mfaRequired && r.challengeToken) {
        setChallenge(r.challengeToken);
        setPhase('mfa');
      } else if (r.mfaSetupRequired && r.challengeToken) {
        setChallenge(r.challengeToken);
        setPhase('mfa_setup');
      } else {
        await finish(next);
        return;
      }
      setPassword('');
    } catch (err) {
      setPassword('');
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!challenge) return;
    if (!useRecovery && code.length !== 6) return;
    if (useRecovery && !recoveryCode.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/auth/mfa/verify', useRecovery ? { challengeToken: challenge, recoveryCode: recoveryCode.trim() } : { challengeToken: challenge, code });
      await finish(next);
    } catch (err) {
      setCode('');
      setRecoveryCode('');
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const noticeBox = notice && (
    <div className="mb-space-md">
      <InlineAlert tone={notice.tone} title={notice.title}>
        {notice.text}
      </InlineAlert>
    </div>
  );

  // ───────────── MFA setup required by policy ─────────────
  if (phase === 'mfa_setup' && challenge)
    return (
      <AuthLayout
        title="Set up multi-factor authentication"
        badge="Step 2 of 3"
        subtitle="Your organisation requires an authenticator app for your role. Link one now to finish signing in."
        footerLinks={<TextLink onClick={() => backToCredentials(null)}>Back to sign in</TextLink>}
      >
        {noticeBox}
        <MfaSetupPanel
          challengeToken={challenge}
          onComplete={(r) => {
            setCodes(r.recoveryCodes);
            setChallenge(null);
            setPhase('recovery_codes');
          }}
          onExpired={() => backToCredentials({ tone: 'warning', text: 'Your verification window expired. Please sign in again.' })}
          onCancel={() => backToCredentials(null)}
          cancelLabel="Cancel and sign in again"
        />
      </AuthLayout>
    );

  // ───────────── Recovery codes after enrolment ─────────────
  if (phase === 'recovery_codes')
    return (
      <AuthLayout title="Recovery codes" badge="Step 3 of 3" subtitle="MFA is now enabled on your account. Keep these codes to regain access if you lose your phone.">
        <RecoveryCodesPanel codes={codes} email={email.trim()} continueLabel="Continue to dashboard" continueLoading={busy} onContinue={() => {
          setBusy(true);
          void finish(next).finally(() => setBusy(false));
        }} />
      </AuthLayout>
    );

  // ───────────── MFA verification ─────────────
  if (phase === 'mfa' && challenge)
    return (
      <AuthLayout
        title="Verify your identity"
        badge="MFA"
        subtitle={useRecovery ? 'Enter one of your unused recovery codes. Each code works only once.' : 'Enter the 6-digit code from your authenticator app.'}
        footerLinks={<TextLink onClick={() => backToCredentials(null)}>Back to sign in</TextLink>}
      >
        {noticeBox}
        <form className="flex flex-col gap-space-md" onSubmit={(e) => void submitMfa(e)}>
          <div className="bg-surface-container-lowest rounded-lg p-space-md shadow-md flex flex-col gap-space-md">
            <div className="flex items-center gap-space-sm">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-primary-container" />
              </span>
              <span className="font-headline-sm text-headline-sm text-on-surface tracking-tight">
                {useRecovery ? 'Step 2: Recovery code' : 'Step 2: Authenticator code (TOTP)'}
              </span>
            </div>
            <div className="bg-surface-container p-space-md rounded flex flex-col sm:flex-row items-center gap-space-md">
              <div className="relative w-16 h-16 bg-surface-container-lowest rounded-lg flex items-center justify-center shrink-0 shadow-inner">
                <div className="absolute inset-0 rounded-lg animate-pulse bg-primary-container/20" />
                <span className="material-symbols-outlined icon-fill text-secondary" style={{ fontSize: 32 }} aria-hidden>
                  {useRecovery ? 'password' : 'phonelink_lock'}
                </span>
              </div>
              <div className="flex flex-col gap-space-xs w-full">
                {useRecovery ? (
                  <AuthField
                    label="Recovery code"
                    icon="password"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                    placeholder="XXXXX-XXXXX"
                    autoComplete="off"
                    autoFocus
                    spellCheck={false}
                    className="font-mono tracking-wider"
                  />
                ) : (
                  <>
                    <div className="font-headline-sm text-body-md text-on-surface">Open your authenticator app</div>
                    <CodeInput
                      value={code}
                      onChange={(v) => {
                        setCode(v);
                      }}
                      autoFocus
                      disabled={busy}
                    />
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-space-xs pt-space-xs font-label-sm text-label-sm">
              <span className="text-outline">{useRecovery ? 'Have your phone?' : 'Lost access to your authenticator app?'}</span>
              <TextLink
                onClick={() => {
                  setUseRecovery((u) => !u);
                  setNotice(null);
                  setCode('');
                  setRecoveryCode('');
                }}
              >
                {useRecovery ? 'Use authenticator code instead' : 'Use a recovery code'}
              </TextLink>
            </div>
          </div>
          <div className="bg-surface-container-lowest/80 p-space-sm rounded flex items-start gap-space-sm">
            <span className="material-symbols-outlined text-error shrink-0 mt-0.5" aria-hidden>
              policy
            </span>
            <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
              <strong className="text-on-surface">Audit notice:</strong> every verification attempt is recorded in the append-only audit log. Repeated incorrect
              codes temporarily lock the account.
            </p>
          </div>
          <PrimaryAction icon="verified_user" loading={busy} disabled={useRecovery ? !recoveryCode.trim() : code.length !== 6}>
            Verify & sign in
          </PrimaryAction>
        </form>
      </AuthLayout>
    );

  // ───────────── Credentials ─────────────
  return (
    <AuthLayout
      title="Sign in"
      badge="Dashboard access"
      subtitle="Sign in with your work email and password. You'll be asked for your authenticator code if MFA is enabled."
    >
      {noticeBox}
      <form className="flex flex-col gap-space-md" onSubmit={(e) => void submitCredentials(e)}>
        <AuthField
          label="Email"
          icon="badge"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          autoFocus
          required
          placeholder="name@organisation.com"
        />
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          aside={
            <Link to="/forgot-password" className="font-label-sm text-label-sm text-secondary hover:underline">
              Forgot password?
            </Link>
          }
        />
        <div className="bg-surface-container-lowest/80 p-space-sm rounded flex items-start gap-space-sm">
          <span className="material-symbols-outlined text-error shrink-0 mt-0.5" aria-hidden>
            policy
          </span>
          <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
            <strong className="text-on-surface">Audit notice:</strong> sign-in attempts, failures and lockouts are recorded in the append-only audit log. Repeated
            failed attempts temporarily lock the account.
          </p>
        </div>
        <PrimaryAction icon="login" loading={busy} disabled={!email.trim() || !password}>
          Sign in
        </PrimaryAction>
      </form>
    </AuthLayout>
  );
}
