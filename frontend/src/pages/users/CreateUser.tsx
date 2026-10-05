import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field, Icon, Input, KV, LinkButton, PageHeader, Panel, Toggle, useErrorToast, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { Role } from '@/lib/auth';
import { LinkResult, LocationPicker, locationRuleError, RoleBadge, ROLE_META, ROLES, useAllLocations, useMfaPolicy } from './components';

const STEPS = [
  { key: 'info', label: 'User information', icon: 'badge' },
  { key: 'role', label: 'Role', icon: 'shield_person' },
  { key: 'locations', label: 'Locations', icon: 'storefront' },
  { key: 'mfa', label: 'MFA & review', icon: 'phonelink_lock' }
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CreateUser() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const policy = useMfaPolicy();
  const locations = useAllLocations();

  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [mfaRequired, setMfaRequired] = useState(true);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);

  const emailErr = !email.trim() ? 'Email is required.' : !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : serverErrors.email ?? null;
  const nameErr = fullName.trim().length < 2 ? 'Full name must be at least 2 characters.' : serverErrors.fullName ?? null;
  const titleErr = jobTitle.length > 120 ? 'Job title must be at most 120 characters.' : null;
  const locErr = role ? locationRuleError(role, locationIds) : null;
  const enforced = role ? policy.enforced(role) : null;

  const stepValid = [!emailErr && !nameErr && !titleErr, Boolean(role), Boolean(role) && !locErr, true];

  const changeRole = (r: Role) => {
    setRole(r);
    if (r === 'administrator') setLocationIds([]);
    else if (r === 'branch_supervisor') setLocationIds((ids) => ids.slice(0, 1));
  };

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/users', {
        email: email.trim(),
        fullName: fullName.trim(),
        jobTitle: jobTitle.trim() || undefined,
        role,
        locationIds: role === 'administrator' ? [] : locationIds,
        mfaRequired
      }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast({ tone: 'success', title: 'User invited', description: `${r.user?.full_name ?? fullName} was created with status "invited".` });
    },
    onError: (e) => {
      const err = e as ApiError;
      const map: Record<string, string> = {};
      if (err.status === 409) map.email = err.message;
      if (Array.isArray(err.details)) for (const d of err.details) if (d?.path) map[String(d.path)] = d.message;
      setServerErrors(map);
      if (map.email || map.fullName) setStep(0);
      errorToast(e, 'Could not create user');
    }
  });

  const next = () => {
    setTouched(true);
    if (!stepValid[step]) return;
    setTouched(false);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  if (result) {
    const u = result.user;
    return (
      <div className="flex flex-col gap-space-md max-w-3xl">
        <PageHeader title="User invited" icon="how_to_reg" crumbs={[{ label: 'Users', to: '/users' }, { label: 'Add User' }]} />
        <Panel title={u?.full_name ?? fullName} icon="person" accent="success" subtitle={u?.email ?? email}>
          <div className="flex flex-col gap-space-md">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-space-lg">
              <div>
                <KV label="Role">
                  <RoleBadge role={u?.role ?? role ?? 'manager'} />
                </KV>
                <KV label="Status">Invited — awaiting verification</KV>
              </div>
              <div>
                <KV label="Locations">{u?.role === 'administrator' ? 'All locations' : (u?.locations ?? []).map((l: any) => l.name).join(', ') || '—'}</KV>
                <KV label="MFA">{u?.mfa_required ? 'Required at first sign-in' : enforced ? 'Enforced by organisation policy' : 'Optional'}</KV>
              </div>
            </div>
            <LinkResult title="Invitation link" link={result.inviteLink} emailSent={Boolean(result.emailSent)} smtpConfigured={result.smtpConfigured} validity="Valid for 7 days">
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                The user opens the link to verify their account and set a password{u?.mfa_required || enforced ? ', then enrols an authenticator app for MFA' : ''}. Until then their status stays <b>Invited</b>; you can resend the invitation from their details page.
              </p>
            </LinkResult>
            <div className="flex flex-wrap justify-end gap-space-sm">
              <Button
                icon="person_add"
                onClick={() => {
                  setResult(null);
                  setStep(0);
                  setEmail('');
                  setFullName('');
                  setJobTitle('');
                  setRole(null);
                  setLocationIds([]);
                  setMfaRequired(true);
                  setServerErrors({});
                }}
              >
                Add another user
              </Button>
              <LinkButton to="/users" icon="group">
                Back to users
              </LinkButton>
              {u?.id && (
                <LinkButton to={`/users/${u.id}`} variant="primary" icon="visibility">
                  View user
                </LinkButton>
              )}
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  const selectedLocs = (locations.data ?? []).filter((l) => locationIds.includes(l.id));

  return (
    <div className="flex flex-col gap-space-md max-w-4xl">
      <PageHeader
        title="Add User"
        icon="person_add"
        crumbs={[{ label: 'Users', to: '/users' }, { label: 'Add User' }]}
        subtitle="The user receives an invitation to verify their account and set a password. Employees are not users — they come from the web software."
      />

      {/* Stepper */}
      <ol className="grid grid-cols-2 md:grid-cols-4 gap-space-xs">
        {STEPS.map((s, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <li key={s.key}>
              <button
                type="button"
                disabled={i > step}
                onClick={() => setStep(i)}
                className={clsx(
                  'w-full flex items-center gap-2 p-space-sm rounded text-left transition-colors',
                  current ? 'bg-primary-container/20 text-on-surface' : done ? 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container' : 'bg-surface-container-low text-outline'
                )}
              >
                <span
                  className={clsx(
                    'w-6 h-6 rounded-full flex items-center justify-center font-mono text-[11px] font-bold shrink-0',
                    done ? 'bg-tertiary-container text-on-tertiary-container' : current ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-highest text-outline'
                  )}
                >
                  {done ? <Icon name="check" className="text-[14px]" /> : i + 1}
                </span>
                <span className="font-label-md text-label-md truncate">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <Panel title={STEPS[step]!.label} icon={STEPS[step]!.icon}>
        {step === 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
            <Field label="Email" required error={touched || serverErrors.email ? emailErr : null} hint="The invitation is sent to this address; it is also the sign-in name.">
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setServerErrors((s) => ({ ...s, email: '' }));
                }}
                placeholder="name@company.com"
              />
            </Field>
            <Field label="Full name" required error={touched || serverErrors.fullName ? nameErr : null}>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Job title" error={titleErr} hint="Optional">
              <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-space-sm">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-space-sm">
              {ROLES.map((r) => {
                const m = ROLE_META[r];
                const on = role === r;
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => changeRole(r)}
                    className={clsx(
                      'p-space-md rounded text-left flex flex-col gap-2 border transition-colors',
                      on ? 'bg-primary-container/15 border-primary-container' : 'bg-surface-container border-transparent hover:bg-surface-container-high'
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <Icon name={m.icon} className={clsx('text-[22px]', on ? 'text-primary' : 'text-outline')} />
                      <Icon name={on ? 'radio_button_checked' : 'radio_button_unchecked'} className={clsx('text-[18px]', on ? 'text-primary' : 'text-outline')} />
                    </div>
                    <div className="font-headline-sm text-headline-sm text-on-surface">{m.label}</div>
                    <p className="font-body-sm text-body-sm text-on-surface-variant leading-snug">{m.description}</p>
                    <ul className="flex flex-wrap gap-1 pt-1">
                      {m.access.map((a) => (
                        <li key={a} className="font-label-sm text-label-sm px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
                          {a}
                        </li>
                      ))}
                    </ul>
                    <div className="font-label-sm text-label-sm text-secondary pt-1">Scope: {m.scope}</div>
                  </button>
                );
              })}
            </div>
            {touched && !role && <p className="text-body-sm text-error">Select a role.</p>}
            <p className="font-body-sm text-body-sm text-outline">
              The exact permissions of each role are listed on{' '}
              <a href="/users/roles" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Roles & Permissions
              </a>
              .
            </p>
          </div>
        )}

        {step === 2 && role && (
          <div className="flex flex-col gap-space-sm">
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {role === 'administrator'
                ? 'Administrators are not bound to locations.'
                : role === 'manager'
                  ? 'Assign at least one location. The manager will only see attendance, employees, devices and alerts for these locations.'
                  : 'Assign exactly one branch. The branch supervisor will only see that branch.'}
            </p>
            <LocationPicker role={role} value={locationIds} onChange={setLocationIds} />
            {touched && locErr && <p className="text-body-sm text-error">{locErr}</p>}
          </div>
        )}

        {step === 3 && role && (
          <div className="flex flex-col gap-space-md">
            <div className="p-space-sm rounded bg-surface-container flex flex-col gap-space-sm">
              <Toggle checked={mfaRequired} onChange={setMfaRequired} label="Require multi-factor authentication (authenticator app) for this user" />
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                When required, the user must enrol a TOTP authenticator app during account setup and enter a code at every sign-in.
              </p>
              {enforced === true && (
                <div className="flex items-start gap-2 text-body-sm text-tertiary">
                  <Icon name="verified_user" className="text-[18px]" />
                  <span>
                    MFA is enforced for all {ROLE_META[role].label}s by organisation policy (Settings → MFA), so it will be required regardless of this toggle.
                  </span>
                </div>
              )}
              {enforced === false && !mfaRequired && (
                <div className="flex items-start gap-2 text-body-sm text-warning">
                  <Icon name="warning" className="text-[18px]" />
                  <span>Organisation policy does not enforce MFA for {ROLE_META[role].label}s — this user will be able to sign in with a password only.</span>
                </div>
              )}
              {enforced === null && <p className="font-body-sm text-body-sm text-outline">Organisation-level MFA enforcement (per role) is configured under Settings → MFA and applies in addition to this per-user setting.</p>}
            </div>

            <div>
              <div className="font-label-sm text-label-sm text-outline uppercase tracking-wider mb-1">Review</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-space-lg">
                <div>
                  <KV label="Email" mono>
                    {email.trim()}
                  </KV>
                  <KV label="Full name">{fullName.trim()}</KV>
                  <KV label="Job title">{jobTitle.trim() || '—'}</KV>
                </div>
                <div>
                  <KV label="Role">
                    <RoleBadge role={role} />
                  </KV>
                  <KV label="Locations">{role === 'administrator' ? 'All locations' : selectedLocs.map((l) => `${l.name} (${l.code})`).join(', ') || '—'}</KV>
                  <KV label="MFA">{mfaRequired || enforced ? 'Required' : 'Optional'}</KV>
                </div>
              </div>
            </div>
            <p className="font-body-sm text-body-sm text-outline flex items-center gap-1.5">
              <Icon name="receipt_long" className="text-[15px]" />
              Creating the user is recorded in the audit log.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-space-sm mt-space-lg pt-space-md border-t border-outline-variant/20">
          <Button variant="ghost" icon="arrow_back" onClick={() => (step === 0 ? navigate('/users') : setStep(step - 1))}>
            {step === 0 ? 'Cancel' : 'Back'}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              Continue <Icon name="arrow_forward" className="text-[15px]" />
            </Button>
          ) : (
            <Button variant="primary" icon="send" loading={create.isPending} disabled={!stepValid[0] || !stepValid[2]} onClick={() => create.mutate()}>
              Create user & send invitation
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
