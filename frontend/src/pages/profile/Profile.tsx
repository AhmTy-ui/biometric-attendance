import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Button, ConfirmDialog, Icon, KV, Loading, Modal, PageHeader, Panel, useErrorToast, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, relative } from '@/lib/format';
import {
  ErrorAlert,
  MfaSetupPanel,
  passwordAcceptable,
  PasswordField,
  PolicyChecklist,
  RecoveryCodesPanel,
  type PasswordPolicy
} from '@/pages/auth/components';

function ChangePasswordPanel() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  // The password policy is part of the signed-in user's /api/auth/me payload (available to every role).
  const policy: PasswordPolicy | null = (me?.passwordPolicy as PasswordPolicy | undefined) ?? null;

  const m = useMutation({
    mutationFn: () => api.post('/api/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast({ tone: 'success', title: 'Password changed', description: 'Your other sessions were signed out.' });
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    },
    onError: (e) => setError(e)
  });

  const ok = Boolean(current) && passwordAcceptable(policy, next, confirm);

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    m.mutate();
  };

  return (
    <Panel title="Change password" icon="password" subtitle="Changing your password signs out all your other sessions.">
      <form className="flex flex-col gap-space-md" onSubmit={submit}>
        <input type="text" autoComplete="username" value={me?.user.email ?? ''} readOnly hidden />
        <PasswordField label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" id="pf-current" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <PasswordField label="New password" value={next} onChange={setNext} autoComplete="new-password" id="pf-new" />
          <PasswordField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            id="pf-confirm"
            error={confirm && next !== confirm ? 'Passwords do not match.' : null}
          />
        </div>
        {policy ? (
          <PolicyChecklist policy={policy} password={next} confirm={confirm} />
        ) : (
          <p className="font-body-sm text-body-sm text-outline">Your new password must meet your organisation's password policy; the server will list any unmet requirement.</p>
        )}
        {error ? <ErrorAlert error={error} /> : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon="lock_reset" loading={m.isPending} disabled={!ok}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function MfaPanel() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [enableOpen, setEnableOpen] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePw, setDisablePw] = useState('');
  const [disableError, setDisableError] = useState<unknown>(null);

  const regen = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes'),
    onSuccess: (r) => {
      setConfirmRegen(false);
      setNewCodes(r.recoveryCodes);
      void refresh();
    },
    onError: (e) => {
      setConfirmRegen(false);
      errorToast(e, 'Could not generate recovery codes');
    }
  });

  const disable = useMutation({
    mutationFn: () => api.post('/api/auth/mfa/disable', { password: disablePw }),
    onSuccess: () => {
      setDisableOpen(false);
      setDisablePw('');
      toast({ tone: 'warning', title: 'MFA disabled', description: 'Your recovery codes were deleted.' });
      void refresh();
    },
    onError: (e) => setDisableError(e)
  });

  if (!me) return null;
  const u = me.user;
  const low = u.mfaEnabled && u.recoveryCodesLeft <= 3;

  const closeEnable = () => {
    setEnableOpen(false);
    setNewCodes(null);
    void refresh();
  };

  return (
    <Panel
      title="Multi-factor authentication"
      icon="phonelink_lock"
      subtitle="Authenticator app (TOTP) with single-use recovery codes"
      accent={u.mfaEnabled ? (low ? 'warning' : 'success') : 'warning'}
      actions={u.mfaEnabled ? <Badge tone="success" icon="verified_user">Enabled</Badge> : <Badge tone="warning" icon="gpp_maybe">Not enabled</Badge>}
    >
      <div className="flex flex-col gap-space-md">
        <div>
          <KV label="Status">{u.mfaEnabled ? 'A 6-digit authenticator code is required at every sign-in' : 'Password only'}</KV>
          <KV label="Recovery codes left">
            {u.mfaEnabled ? (
              <span className={low ? 'text-warning font-semibold' : undefined}>
                {u.recoveryCodesLeft} unused{low && ' — generate new codes soon'}
              </span>
            ) : (
              '—'
            )}
          </KV>
        </div>
        {!u.mfaEnabled && (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Protect your account so that a leaked password alone cannot be used to sign in. Your administrator may require MFA for your role.
          </p>
        )}
        <div className="flex flex-wrap gap-space-sm">
          {u.mfaEnabled ? (
            <>
              <Button icon="autorenew" onClick={() => setConfirmRegen(true)}>
                Regenerate recovery codes
              </Button>
              <Button
                variant="ghost"
                icon="no_encryption"
                onClick={() => {
                  setDisableError(null);
                  setDisablePw('');
                  setDisableOpen(true);
                }}
              >
                Disable MFA
              </Button>
            </>
          ) : (
            <Button variant="primary" icon="verified_user" onClick={() => setEnableOpen(true)}>
              Enable MFA
            </Button>
          )}
        </div>
      </div>

      <Modal open={enableOpen} onClose={closeEnable} title={newCodes ? 'Save your recovery codes' : 'Enable multi-factor authentication'} icon="phonelink_lock" width="max-w-2xl">
        {newCodes ? (
          <RecoveryCodesPanel codes={newCodes} email={u.email} continueLabel="Done" onContinue={closeEnable} />
        ) : (
          <MfaSetupPanel
            onComplete={(r) => {
              setNewCodes(r.recoveryCodes);
              toast({ tone: 'success', title: 'MFA enabled' });
            }}
            onCancel={closeEnable}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        onConfirm={() => regen.mutate()}
        loading={regen.isPending}
        title="Regenerate recovery codes?"
        message="A new set of recovery codes will be created and all your existing recovery codes will stop working immediately."
        confirmLabel="Generate new codes"
      />

      <Modal open={Boolean(newCodes) && !enableOpen} onClose={() => setNewCodes(null)} title="Your new recovery codes" icon="password" width="max-w-2xl">
        {newCodes && <RecoveryCodesPanel codes={newCodes} email={u.email} continueLabel="Done" onContinue={() => setNewCodes(null)} />}
      </Modal>

      <Modal
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Disable MFA"
        icon="no_encryption"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon="no_encryption" loading={disable.isPending} disabled={!disablePw} onClick={() => disable.mutate()}>
              Disable MFA
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-space-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (disablePw) disable.mutate();
          }}
        >
          <p className="text-body-md text-on-surface-variant">
            Signing in will require only your password, and your recovery codes will be deleted. If MFA is required for your role, the server will refuse this
            change.
          </p>
          <PasswordField label="Confirm with your password" value={disablePw} onChange={setDisablePw} autoComplete="current-password" autoFocus id="mfa-disable-pw" />
          {disableError ? <ErrorAlert error={disableError} /> : null}
        </form>
      </Modal>
    </Panel>
  );
}

export default function Profile() {
  const { me, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  if (!me) return <Loading label="Loading profile…" />;
  const u = me.user;
  const expires = me.session.expiresAt ? new Date(me.session.expiresAt) : null;

  return (
    <>
      <PageHeader
        title="User Profile"
        icon="account_circle"
        subtitle="Your identity, access and sign-in security"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'User Profile' }]}
        actions={
          <Button
            variant="danger"
            icon="logout"
            loading={loggingOut}
            onClick={() => {
              setLoggingOut(true);
              void logout();
            }}
          >
            Logout
          </Button>
        }
      />
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-gutter items-start">
        <div className="xl:col-span-5 flex flex-col gap-gutter">
          <Panel title="Identity" icon="badge">
            <div className="flex items-center gap-space-md pb-space-md mb-space-sm border-b border-outline-variant/20">
              <Avatar name={u.fullName} size={14} />
              <div className="min-w-0">
                <div className="font-headline-md text-headline-md text-on-surface truncate">{u.fullName}</div>
                <div className="font-body-sm text-body-sm text-on-surface-variant truncate">{u.jobTitle ?? u.email}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone="primary">{u.roleLabel}</Badge>
                  {u.mfaEnabled ? <Badge tone="success" icon="verified_user">MFA</Badge> : <Badge tone="warning">No MFA</Badge>}
                </div>
              </div>
            </div>
            <KV label="Email" mono>
              {u.email}
            </KV>
            <KV label="Organization">{me.organization.name}</KV>
            <KV label="Role">{u.roleLabel}</KV>
            <KV label="Permissions">{me.permissions.length}</KV>
            <KV label="Location scope">
              {me.locationScope === null ? (
                'All locations'
              ) : me.locationScope.length === 0 ? (
                <span className="text-warning">No locations assigned</span>
              ) : (
                <span className="flex flex-wrap justify-end gap-1">
                  {me.locationScope.map((l) => (
                    <Link key={l.id} to={`/locations/${l.id}`} className="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface hover:text-primary font-label-sm text-label-sm">
                      {l.name} <span className="text-outline font-mono">{l.code}</span>
                    </Link>
                  ))}
                </span>
              )}
            </KV>
          </Panel>
          <Panel title="Session" icon="schedule">
            <KV label="Last sign-in">
              {u.lastLoginAt ? (
                <>
                  {dateTime(u.lastLoginAt)} <span className="text-outline">({relative(u.lastLoginAt)})</span>
                </>
              ) : (
                'never'
              )}
            </KV>
            <KV label="Session expires">
              {expires ? (
                <>
                  {dateTime(expires)} <span className="text-outline">({relative(expires)})</span>
                </>
              ) : (
                '—'
              )}
            </KV>
            <KV label="Idle timeout">{me.session.idleTimeoutMinutes} minutes of inactivity</KV>
            <KV label="Timezone" mono>
              {me.organization.timezone}
            </KV>
            <p className="mt-space-sm font-body-sm text-body-sm text-outline flex items-start gap-1.5">
              <Icon name="info" className="text-[15px] mt-px" />
              Signing out, resetting your password by email, or an administrator disabling your account ends this session immediately. Changing your password
              here keeps this session and signs out all others.
            </p>
          </Panel>
        </div>
        <div className="xl:col-span-7 flex flex-col gap-gutter">
          <MfaPanel />
          <ChangePasswordPanel />
        </div>
      </div>
    </>
  );
}
