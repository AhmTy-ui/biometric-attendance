import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dot,
  Empty,
  ErrorState,
  Field,
  Icon,
  KV,
  Loading,
  PageHeader,
  Panel,
  Progress,
  Select,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  useErrorToast,
  useToast
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { bytes, dateTime, duration, num, pct, relative } from '@/lib/format';
import { CheckGroup, errFor, Group, NumberField, RadioCards, SecretField, SectionCard, TextField, ToggleRow, useSectionForm, type SectionKey } from './components';

type TabKey = SectionKey | 'system';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'organization', label: 'Organization', icon: 'domain' },
  { key: 'security', label: 'Security', icon: 'lock' },
  { key: 'mfa', label: 'MFA', icon: 'phonelink_lock' },
  { key: 'notifications', label: 'Notifications', icon: 'notifications' },
  { key: 'integration', label: 'Integration', icon: 'sync_alt' },
  { key: 'device_policies', label: 'Device policies', icon: 'fingerprint' },
  { key: 'data_retention', label: 'Data retention', icon: 'inventory_2' },
  { key: 'system', label: 'System status', icon: 'monitor_heart' }
];

const AVAILABILITY_TARGET = 99.5;

export default function Settings() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') as TabKey | null;
  const tab: TabKey = raw && TABS.some((t) => t.key === raw) ? raw : 'organization';
  const readOnly = !can('settings.manage');
  const q = useQuery<any>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });

  const setTab = (t: TabKey) => {
    const n = new URLSearchParams(sp);
    n.set('tab', t);
    setSp(n, { replace: true });
  };

  return (
    <div className="flex flex-col gap-space-md">
      <PageHeader title="Settings" icon="settings" subtitle="Organisation-wide configuration. Changes take effect immediately and every change is recorded in the audit log." />
      {readOnly && (
        <div className="flex items-center gap-2 p-space-sm rounded bg-secondary-container/15 text-body-sm text-on-surface-variant">
          <Icon name="visibility" className="text-[18px] text-secondary" />
          You have read-only access to settings. Ask an Administrator to make changes.
        </div>
      )}
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'system' ? (
        <SystemStatus readOnly={readOnly} />
      ) : q.isLoading ? (
        <Loading label="Loading settings…" />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {tab === 'organization' && <OrganizationSection server={q.data.settings.organization} org={q.data.organization} readOnly={readOnly} />}
          {tab === 'security' && <SecuritySection server={q.data.settings.security} readOnly={readOnly} />}
          {tab === 'mfa' && <MfaSection server={q.data.settings.mfa} readOnly={readOnly} />}
          {tab === 'notifications' && <NotificationsSection server={q.data.settings.notifications} smtpConfigured={Boolean(q.data.environment?.smtpConfigured)} readOnly={readOnly} />}
          {tab === 'integration' && <IntegrationSection server={q.data.settings.integration} readOnly={readOnly} />}
          {tab === 'device_policies' && <DevicePoliciesSection server={q.data.settings.device_policies} readOnly={readOnly} />}
          {tab === 'data_retention' && <DataRetentionSection server={q.data.settings.data_retention} readOnly={readOnly} />}
        </>
      )}
    </div>
  );
}

// ───────────────────────── Organization ─────────────────────────
function timezones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[];
  } catch {
    return [];
  }
}

function OrganizationSection({ server, org, readOnly }: { server: any; org: any; readOnly: boolean }) {
  const f = useSectionForm('organization', server);
  const d = f.draft;
  const tzs = useMemo(timezones, []);
  const tzList = tzs.includes(d.timezone) || !d.timezone ? tzs : [d.timezone, ...tzs];
  return (
    <SectionCard title="Organization" icon="domain" description="Name, default timezone and attendance rules shared by all locations" form={f} readOnly={readOnly}>
      <Group title="Identity">
        <TextField label="Display name" required value={d.displayName} onChange={(v) => f.set('displayName', v)} disabled={readOnly} error={f.errors.displayName} hint="Shown in the dashboard, emails and exports." />
        <TextField label="Support email" type="email" value={d.supportEmail} onChange={(v) => f.set('supportEmail', v)} disabled={readOnly} error={f.errors.supportEmail} hint="Optional contact shown to users who need help." />
        <Field label="Default timezone" error={f.errors.timezone} hint="Used for organisation-wide reports. Each location also has its own timezone.">
          {tzList.length ? (
            <Select value={d.timezone} disabled={readOnly} onChange={(e) => f.set('timezone', e.target.value)}>
              {tzList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          ) : (
            <input className="w-full h-9 bg-surface-container-lowest border border-outline-variant/40 rounded px-space-sm text-body-md text-on-surface" value={d.timezone} disabled={readOnly} onChange={(e) => f.set('timezone', e.target.value)} />
          )}
        </Field>
        <div className="p-space-sm rounded bg-surface-container">
          <KV label="Slug" mono>
            {org?.slug ?? '—'}
          </KV>
          <KV label="Created">{dateTime(org?.created_at)}</KV>
        </div>
      </Group>
      <Group title="Attendance rules">
        <NumberField
          label="Late threshold"
          unit="minutes"
          min={0}
          max={240}
          value={d.lateThresholdMinutes}
          onChange={(v) => f.set('lateThresholdMinutes', v)}
          disabled={readOnly}
          error={f.errors.lateThresholdMinutes}
          hint="Default minutes after work start before a first check-in counts as late."
        />
      </Group>
    </SectionCard>
  );
}

// ───────────────────────── Security ─────────────────────────
function SecuritySection({ server, readOnly }: { server: any; readOnly: boolean }) {
  const f = useSectionForm('security', server);
  const d = f.draft;
  return (
    <SectionCard title="Security" icon="lock" description="Authentication, password policy, account lockout and session lifetime" form={f} readOnly={readOnly}>
      <Group title="Password policy" description="Applied when users set or change their password.">
        <NumberField label="Minimum length" unit="chars" min={8} max={128} value={d.passwordMinLength} onChange={(v) => f.set('passwordMinLength', v)} disabled={readOnly} error={f.errors.passwordMinLength} />
        <NumberField
          label="Password history"
          unit="days"
          min={0}
          max={3650}
          value={d.passwordHistoryDays}
          onChange={(v) => f.set('passwordHistoryDays', v)}
          disabled={readOnly}
          error={f.errors.passwordHistoryDays}
          hint="0 disables the history rule."
        />
        <ToggleRow label="Require an uppercase letter" checked={d.passwordRequireUpper} onChange={(v) => f.set('passwordRequireUpper', v)} disabled={readOnly} />
        <ToggleRow label="Require a lowercase letter" checked={d.passwordRequireLower} onChange={(v) => f.set('passwordRequireLower', v)} disabled={readOnly} />
        <ToggleRow label="Require a digit" checked={d.passwordRequireDigit} onChange={(v) => f.set('passwordRequireDigit', v)} disabled={readOnly} />
        <ToggleRow label="Require a symbol" checked={d.passwordRequireSymbol} onChange={(v) => f.set('passwordRequireSymbol', v)} disabled={readOnly} />
      </Group>
      <Group title="Account lockout" description="Protects against password guessing. Administrators can unlock accounts early from the user's page.">
        <NumberField label="Failed attempts before lockout" min={3} max={20} value={d.lockoutThreshold} onChange={(v) => f.set('lockoutThreshold', v)} disabled={readOnly} error={f.errors.lockoutThreshold} />
        <NumberField label="Lockout duration" unit="minutes" min={1} max={1440} value={d.lockoutMinutes} onChange={(v) => f.set('lockoutMinutes', v)} disabled={readOnly} error={f.errors.lockoutMinutes} />
      </Group>
      <Group title="Sessions">
        <NumberField
          label="Idle timeout"
          unit="minutes"
          min={5}
          max={1440}
          value={d.sessionIdleMinutes}
          onChange={(v) => f.set('sessionIdleMinutes', v)}
          disabled={readOnly}
          error={f.errors.sessionIdleMinutes}
          hint="Users are signed out after this much inactivity."
        />
        <NumberField
          label="Absolute session lifetime"
          unit="hours"
          min={1}
          max={168}
          value={d.sessionAbsoluteHours}
          onChange={(v) => f.set('sessionAbsoluteHours', v)}
          disabled={readOnly}
          error={f.errors.sessionAbsoluteHours}
          hint="Maximum session length regardless of activity."
        />
      </Group>
    </SectionCard>
  );
}

// ───────────────────────── MFA ─────────────────────────
function MfaSection({ server, readOnly }: { server: any; readOnly: boolean }) {
  const f = useSectionForm('mfa', server);
  const d = f.draft;
  return (
    <SectionCard title="MFA" icon="phonelink_lock" description="Time-based one-time passwords (authenticator app)" form={f} readOnly={readOnly}>
      <Group title="Enforce per role" description="Users in an enforced role must enrol an authenticator before they can use the dashboard. A per-user “MFA required” flag applies in addition to this." cols={1}>
        <ToggleRow label="Administrators" description="Strongly recommended — administrators can change every setting." checked={d.enforceForAdministrators} onChange={(v) => f.set('enforceForAdministrators', v)} disabled={readOnly} />
        <ToggleRow label="Managers" checked={d.enforceForManagers} onChange={(v) => f.set('enforceForManagers', v)} disabled={readOnly} />
        <ToggleRow label="Branch Supervisors" checked={d.enforceForSupervisors} onChange={(v) => f.set('enforceForSupervisors', v)} disabled={readOnly} />
      </Group>
      <Group title="Authenticator">
        <TextField label="Issuer name" value={d.issuer} onChange={(v) => f.set('issuer', v)} disabled={readOnly} error={f.errors.issuer} hint="Shown as the account label in the user's authenticator app (1–64 characters). Existing enrolments keep their old label." />
      </Group>
      {!d.enforceForAdministrators && (
        <div className="flex items-start gap-2 p-space-sm rounded bg-warning-container/40 text-body-sm text-warning">
          <Icon name="warning" className="text-[18px]" />
          MFA is not enforced for Administrators. An administrator account protected only by a password is the highest-risk account in the system.
        </div>
      )}
    </SectionCard>
  );
}

// ───────────────────────── Notifications ─────────────────────────
function NotificationsSection({ server, smtpConfigured, readOnly }: { server: any; smtpConfigured: boolean; readOnly: boolean }) {
  const f = useSectionForm('notifications', server);
  const d = f.draft;
  const [recipientsText, setRecipientsText] = useState<string>((server.alertEmailRecipients ?? []).join('\n'));
  const parseRecipients = (t: string) =>
    t
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const invalid = (d.alertEmailRecipients as string[]).filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return (
    <SectionCard
      title="Notifications"
      icon="notifications"
      description="Email delivery of alerts"
      form={{ ...f, reset: () => { f.reset(); setRecipientsText((server.alertEmailRecipients ?? []).join('\n')); } }}
      readOnly={readOnly}
      saveDisabled={invalid.length > 0}
    >
      {!smtpConfigured && (
        <div className="flex items-start gap-2 p-space-sm rounded bg-warning-container/40 text-body-sm text-warning">
          <Icon name="unsubscribe" className="text-[18px]" />
          <div>
            <div className="font-semibold">SMTP is not configured on the server.</div>
            <div className="text-on-surface-variant">No email can be delivered — alerts, invitations and password resets will not be emailed until the SMTP environment variables are set on the backend. Alerts still appear in the dashboard.</div>
          </div>
        </div>
      )}
      <Group title="Email" cols={1}>
        <ToggleRow
          label="Send alert emails"
          description={smtpConfigured ? 'Alerts matching the severities below are emailed to the recipients and roles selected.' : 'Can be enabled now; emails start once SMTP is configured.'}
          checked={d.emailEnabled}
          onChange={(v) => f.set('emailEnabled', v)}
          disabled={readOnly}
        />
        <Field label="Additional recipients" error={errFor(f.errors, 'alertEmailRecipients') ?? (invalid.length ? `Invalid address: ${invalid.join(', ')}` : null)} hint="One address per line (or separated by commas). These receive alerts in addition to the roles below.">
          <Textarea
            value={recipientsText}
            disabled={readOnly}
            placeholder="ops@company.com"
            onChange={(e) => {
              setRecipientsText(e.target.value);
              f.set('alertEmailRecipients', parseRecipients(e.target.value));
            }}
          />
        </Field>
      </Group>
      <Group title="Which alerts" cols={1}>
        <Field label="Severities" error={errFor(f.errors, 'notifyOnSeverities')}>
          <CheckGroup
            options={[
              { key: 'critical', label: 'Critical' },
              { key: 'warning', label: 'Warning' },
              { key: 'info', label: 'Info' }
            ]}
            value={d.notifyOnSeverities}
            onChange={(v) => f.set('notifyOnSeverities', v)}
            disabled={readOnly}
          />
        </Field>
        <Field label="Notify users with role" error={errFor(f.errors, 'notifyRoles')} hint="Managers and Branch Supervisors only receive alerts for their assigned locations.">
          <CheckGroup
            options={[
              { key: 'administrator', label: 'Administrators' },
              { key: 'manager', label: 'Managers' },
              { key: 'branch_supervisor', label: 'Branch Supervisors' }
            ]}
            value={d.notifyRoles}
            onChange={(v) => f.set('notifyRoles', v)}
            disabled={readOnly}
          />
        </Field>
      </Group>
    </SectionCard>
  );
}

// ───────────────────────── Integration ─────────────────────────
function IntegrationSection({ server, readOnly }: { server: any; readOnly: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const errorToast = useErrorToast();
  const f = useSectionForm('integration', server);
  const d = f.draft;
  const [probe, setProbe] = useState<any>(null);
  const test = useMutation({
    mutationFn: () => api.post('/api/integration/test-connection'),
    onSuccess: (r: any) => {
      setProbe({ ...r, at: new Date().toISOString() });
      toast(
        r.reachable && r.ok
          ? { tone: 'success', title: 'Connection successful', description: `HTTP ${r.status} in ${duration(r.latencyMs)}.` }
          : { tone: 'error', title: 'Connection failed', description: r.error ?? `HTTP ${r.status}` }
      );
    },
    onError: (e) => errorToast(e, 'Connection test failed')
  });
  const authHeaderValid = !d.exportEndpointAuthHeader || d.exportEndpointAuthHeader === '••••••••' || /^[A-Za-z0-9-]+:\s*.+$/.test(d.exportEndpointAuthHeader);

  return (
    <div className="flex flex-col gap-space-md">
      <SectionCard
        title="Integration"
        icon="sync_alt"
        description="Connection to the web software (source of truth for employees and locations, destination for attendance)"
        form={f}
        readOnly={readOnly}
        saveDisabled={!authHeaderValid}
      >
        <Group title="Web software API">
          <TextField label="Base URL" type="url" mono value={d.baseUrl} onChange={(v) => f.set('baseUrl', v)} disabled={readOnly} error={f.errors.baseUrl} placeholder="https://hr.example.com" hint="Leave empty to disable all synchronisation." />
          <SecretField
            label="API key"
            value={d.apiKey}
            onChange={(v) => f.set('apiKey', v)}
            disabled={readOnly}
            error={f.errors.apiKey}
            hint="Stored encrypted. ‘••••••••’ means a key is stored and will be kept; entering a new value replaces it."
          />
          <TextField label="Employees path" mono value={d.employeesPath} onChange={(v) => f.set('employeesPath', v)} disabled={readOnly} error={f.errors.employeesPath} />
          <TextField label="Locations path" mono value={d.locationsPath} onChange={(v) => f.set('locationsPath', v)} disabled={readOnly} error={f.errors.locationsPath} />
          <TextField label="Attendance path" mono value={d.attendancePath} onChange={(v) => f.set('attendancePath', v)} disabled={readOnly} error={f.errors.attendancePath} />
          <NumberField label="Request timeout" unit="ms" min={1000} max={60000} step={500} value={d.timeoutMs} onChange={(v) => f.set('timeoutMs', v)} disabled={readOnly} error={f.errors.timeoutMs} />
        </Group>
        <Group title="Synchronisation schedule" description="Employees and locations are pulled from the web software.">
          <NumberField
            label="Incremental sync every"
            unit="minutes"
            min={1}
            max={1440}
            value={d.incrementalSyncMinutes}
            onChange={(v) => f.set('incrementalSyncMinutes', v)}
            disabled={readOnly}
            error={f.errors.incrementalSyncMinutes}
          />
          <NumberField
            label="Full reconciliation hour"
            unit="UTC"
            min={0}
            max={23}
            value={d.fullSyncHourUtc}
            onChange={(v) => f.set('fullSyncHourUtc', v)}
            disabled={readOnly}
            error={f.errors.fullSyncHourUtc}
            hint={Number.isFinite(d.fullSyncHourUtc) ? `Runs daily at ${String(d.fullSyncHourUtc).padStart(2, '0')}:00 UTC.` : undefined}
          />
        </Group>
        <Group title="Attendance delivery" cols={1}>
          <RadioCards
            value={d.deliveryMode}
            onChange={(v) => f.set('deliveryMode', v)}
            disabled={readOnly}
            options={[
              { key: 'api', label: 'Real-time API push', icon: 'cloud_upload', description: 'Each attendance event is POSTed to the attendance path as it arrives, with retries and a dead-letter queue.' },
              { key: 'scheduled_export', label: 'Scheduled file export', icon: 'file_export', description: 'Attendance is batched into CSV/XLSX files on a schedule and optionally uploaded to an endpoint.' },
              { key: 'disabled', label: 'Disabled', icon: 'block', description: 'Attendance is kept in the platform only. Nothing is sent to the web software.' }
            ]}
          />
        </Group>
        {d.deliveryMode === 'api' && (
          <Group title="Retry policy" description="Failed deliveries are retried with exponential backoff; after the last attempt they move to the dead-letter queue." cols={3}>
            <NumberField label="Max attempts" min={1} max={20} value={d.maxDeliveryAttempts} onChange={(v) => f.set('maxDeliveryAttempts', v)} disabled={readOnly} error={f.errors.maxDeliveryAttempts} />
            <NumberField label="Backoff base" unit="s" min={1} max={3600} value={d.backoffBaseSeconds} onChange={(v) => f.set('backoffBaseSeconds', v)} disabled={readOnly} error={f.errors.backoffBaseSeconds} />
            <NumberField label="Backoff max" unit="s" min={10} max={86400} value={d.backoffMaxSeconds} onChange={(v) => f.set('backoffMaxSeconds', v)} disabled={readOnly} error={f.errors.backoffMaxSeconds} />
          </Group>
        )}
        {d.deliveryMode === 'scheduled_export' && (
          <Group title="Scheduled export">
            <Field label="File format" error={f.errors.exportFormat}>
              <Select value={d.exportFormat} disabled={readOnly} onChange={(e) => f.set('exportFormat', e.target.value)}>
                <option value="csv">CSV</option>
                <option value="xlsx">Excel (.xlsx)</option>
              </Select>
            </Field>
            <NumberField
              label="Export every"
              unit="minutes"
              min={5}
              max={1440}
              value={d.exportCron?.everyMinutes}
              onChange={(v) => f.set('exportCron', { ...(d.exportCron ?? {}), everyMinutes: v })}
              disabled={readOnly}
              error={errFor(f.errors, 'exportCron')}
            />
            <TextField
              label="Upload endpoint URL"
              type="url"
              mono
              value={d.exportEndpointUrl}
              onChange={(v) => f.set('exportEndpointUrl', v)}
              disabled={readOnly}
              error={f.errors.exportEndpointUrl}
              placeholder="https://hr.example.com/import"
              hint="Optional. When empty, files are only kept for download under Integration."
            />
            <SecretField
              label="Endpoint auth header"
              value={d.exportEndpointAuthHeader}
              onChange={(v) => f.set('exportEndpointAuthHeader', v)}
              disabled={readOnly}
              placeholder="Authorization: Bearer …"
              error={f.errors.exportEndpointAuthHeader ?? (!authHeaderValid ? 'Use the form "Header-Name: value".' : undefined)}
              hint='Format "Header: value". Stored encrypted; ‘••••••••’ keeps the stored value.'
            />
          </Group>
        )}
      </SectionCard>

      <Panel
        title="Connection test"
        icon="network_check"
        subtitle="Calls the locations path of the saved configuration"
        actions={
          can('integration.manage') ? (
            <Button icon="network_check" loading={test.isPending} disabled={f.dirty} onClick={() => test.mutate()}>
              Test connection
            </Button>
          ) : undefined
        }
      >
        {f.dirty && <p className="font-body-sm text-body-sm text-warning mb-space-sm">Save your changes first — the test uses the saved settings.</p>}
        {!can('integration.manage') && <p className="font-body-sm text-body-sm text-outline">Testing the connection requires the integration.manage permission.</p>}
        {probe ? (
          <div className={clsx('p-space-sm rounded flex items-start gap-space-sm', probe.reachable && probe.ok ? 'bg-tertiary-container/15' : 'bg-error-container/40')}>
            <Icon name={probe.reachable && probe.ok ? 'check_circle' : 'error'} className={clsx('text-[22px]', probe.reachable && probe.ok ? 'text-tertiary' : 'text-error')} />
            <div className="text-body-sm flex-1">
              <div className="font-semibold text-on-surface">{probe.reachable ? (probe.ok ? 'Web software reachable' : `Reachable, but returned HTTP ${probe.status}`) : 'Web software not reachable'}</div>
              <div className="text-on-surface-variant">
                {probe.status ? `HTTP ${probe.status} · ` : ''}
                {duration(probe.latencyMs)} · tested {relative(probe.at)}
              </div>
              {probe.error && <div className="font-mono text-[11px] text-on-error-container mt-1 break-all">{probe.error}</div>}
            </div>
          </div>
        ) : (
          <p className="font-body-sm text-body-sm text-outline">
            No test run yet. See{' '}
            <Link to="/integration" className="text-primary hover:underline">
              Integration
            </Link>{' '}
            for sync history and delivery health.
          </p>
        )}
      </Panel>
    </div>
  );
}

// ───────────────────────── Device policies ─────────────────────────
function DevicePoliciesSection({ server, readOnly }: { server: any; readOnly: boolean }) {
  const f = useSectionForm('device_policies', server);
  const d = f.draft;
  const [confirmPreserve, setConfirmPreserve] = useState(false);
  const switchingToPreserve = d.storageFullPolicy === 'preserve_oldest' && server.storageFullPolicy !== 'preserve_oldest';
  const thresholdErr = Number.isFinite(d.storageCriticalPct) && Number.isFinite(d.storageWarningPct) && d.storageCriticalPct < d.storageWarningPct ? 'Critical threshold must be ≥ warning threshold.' : undefined;
  const offlineAfter = Number.isFinite(d.heartbeatIntervalSeconds) && Number.isFinite(d.offlineAfterMissedHeartbeats) ? d.heartbeatIntervalSeconds * d.offlineAfterMissedHeartbeats : null;

  return (
    <SectionCard
      title="Device policies"
      icon="fingerprint"
      description="Pushed to every terminal with its configuration"
      form={{ ...f, reset: () => { f.reset(); setConfirmPreserve(false); } }}
      readOnly={readOnly}
      saveDisabled={Boolean(thresholdErr) || (switchingToPreserve && !confirmPreserve)}
      saveHint={switchingToPreserve && !confirmPreserve ? <span className="text-warning">Confirm the storage policy change to save.</span> : undefined}
    >
      <Group title="Connectivity">
        <NumberField label="Heartbeat interval" unit="seconds" min={10} max={600} value={d.heartbeatIntervalSeconds} onChange={(v) => f.set('heartbeatIntervalSeconds', v)} disabled={readOnly} error={f.errors.heartbeatIntervalSeconds} />
        <NumberField
          label="Offline after missed heartbeats"
          min={2}
          max={20}
          value={d.offlineAfterMissedHeartbeats}
          onChange={(v) => f.set('offlineAfterMissedHeartbeats', v)}
          disabled={readOnly}
          error={f.errors.offlineAfterMissedHeartbeats}
          hint={offlineAfter !== null ? `A device is marked offline after ~${duration(offlineAfter * 1000)} of silence.` : undefined}
        />
      </Group>
      <Group title="Local storage">
        <NumberField label="Storage warning" unit="%" min={50} max={99} value={d.storageWarningPct} onChange={(v) => f.set('storageWarningPct', v)} disabled={readOnly} error={f.errors.storageWarningPct} />
        <NumberField label="Storage critical" unit="%" min={50} max={100} value={d.storageCriticalPct} onChange={(v) => f.set('storageCriticalPct', v)} disabled={readOnly} error={f.errors.storageCriticalPct ?? thresholdErr} />
      </Group>
      <Group title="When storage is full" cols={1}>
        <RadioCards
          value={d.storageFullPolicy}
          onChange={(v) => {
            f.set('storageFullPolicy', v);
            setConfirmPreserve(false);
          }}
          disabled={readOnly}
          options={[
            {
              key: 'continue_capturing_alert',
              label: 'Continue capturing and alert loudly',
              icon: 'campaign',
              badge: 'Default',
              description: 'Employees can always clock in. The device keeps capturing, raises storage alerts, and when storage fills the oldest already-delivered records are recycled first.'
            },
            {
              key: 'preserve_oldest',
              label: 'Preserve oldest events',
              icon: 'inventory',
              badge: 'Requires confirmation',
              description: 'Never overwrites stored events. When storage is full, new fingerprint captures are refused — employees at that device cannot clock in until events upload.'
            }
          ]}
        />
        {switchingToPreserve && !readOnly && (
          <label className="flex items-start gap-2 p-space-sm rounded bg-warning-container/40 text-body-sm text-warning cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-primary-container" checked={confirmPreserve} onChange={(e) => setConfirmPreserve(e.target.checked)} />
            <span>I understand that with this policy a device with full storage will refuse new attendance captures, and employees will not be able to clock in on it until its backlog is uploaded.</span>
          </label>
        )}
      </Group>
      <Group title="Biometrics" cols={3}>
        <NumberField label="Minimum match score" min={1} max={100} value={d.minMatchScore} onChange={(v) => f.set('minMatchScore', v)} disabled={readOnly} error={f.errors.minMatchScore} hint="Higher is stricter (fewer false accepts, more rejections)." />
        <NumberField label="Minimum enrolment quality" min={1} max={100} value={d.minEnrolQuality} onChange={(v) => f.set('minEnrolQuality', v)} disabled={readOnly} error={f.errors.minEnrolQuality} />
        <NumberField label="Fingers per employee" min={1} max={10} value={d.fingersPerEmployee} onChange={(v) => f.set('fingersPerEmployee', v)} disabled={readOnly} error={f.errors.fingersPerEmployee} />
      </Group>
      <Group title="Events">
        <NumberField label="Upload batch size" unit="events" min={10} max={5000} value={d.uploadBatchSize} onChange={(v) => f.set('uploadBatchSize', v)} disabled={readOnly} error={f.errors.uploadBatchSize} />
        <NumberField
          label="Duplicate punch window"
          unit="seconds"
          min={0}
          max={3600}
          value={d.duplicatePunchWindowSeconds}
          onChange={(v) => f.set('duplicatePunchWindowSeconds', v)}
          disabled={readOnly}
          error={f.errors.duplicatePunchWindowSeconds}
          hint="Repeated scans by the same employee within this window are treated as duplicates. 0 disables."
        />
      </Group>
    </SectionCard>
  );
}

// ───────────────────────── Data retention ─────────────────────────
function DataRetentionSection({ server, readOnly }: { server: any; readOnly: boolean }) {
  const f = useSectionForm('data_retention', server);
  const d = f.draft;
  return (
    <SectionCard title="Data retention" icon="inventory_2" description="How long data is kept before it is purged automatically" form={f} readOnly={readOnly}>
      <Group title="Retention periods">
        <NumberField
          label="Attendance records"
          unit="months"
          min={12}
          max={240}
          value={d.attendanceRetentionMonths}
          onChange={(v) => f.set('attendanceRetentionMonths', v)}
          disabled={readOnly}
          error={f.errors.attendanceRetentionMonths}
          hint={Number.isFinite(d.attendanceRetentionMonths) ? `≈ ${(d.attendanceRetentionMonths / 12).toFixed(1)} years. Minimum 12 months.` : 'Minimum 12 months.'}
        />
        <NumberField label="Device logs" unit="days" min={7} max={3650} value={d.deviceLogRetentionDays} onChange={(v) => f.set('deviceLogRetentionDays', v)} disabled={readOnly} error={f.errors.deviceLogRetentionDays} />
        <NumberField label="Device heartbeats" unit="days" min={1} max={365} value={d.heartbeatRetentionDays} onChange={(v) => f.set('heartbeatRetentionDays', v)} disabled={readOnly} error={f.errors.heartbeatRetentionDays} />
        <NumberField label="Backups" unit="days" min={30} max={365} value={d.backupRetentionDays} onChange={(v) => f.set('backupRetentionDays', v)} disabled={readOnly} error={f.errors.backupRetentionDays} hint="Minimum 30 days." />
      </Group>
      <div className="flex items-start gap-2 p-space-sm rounded bg-surface-container text-body-sm text-on-surface-variant">
        <Icon name="receipt_long" className="text-[18px] text-secondary" />
        The audit log is never purged by these settings — it is append-only and kept in full.
      </div>
    </SectionCard>
  );
}

// ───────────────────────── System status ─────────────────────────
const COMPONENTS: { key: string; label: string; icon: string }[] = [
  { key: 'api', label: 'API server', icon: 'dns' },
  { key: 'database', label: 'Database', icon: 'database' },
  { key: 'redis', label: 'Cache / queue (Redis)', icon: 'memory' },
  { key: 'mqtt', label: 'Device broker (MQTT)', icon: 'router' },
  { key: 'objectStorage', label: 'Object storage', icon: 'cloud' }
];

function SystemStatus({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery<any>({ queryKey: ['system-status'], queryFn: () => api.get('/api/system/status'), refetchInterval: 30_000 });
  const backup = useMutation({
    mutationFn: () => api.post('/api/system/backup'),
    onSuccess: (r: any) => {
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['system-status'] });
      if (r?.status === 'failed') toast({ tone: 'error', title: 'Backup failed', description: r.error ?? undefined });
      else toast({ tone: 'success', title: r?.status === 'running' ? 'Backup started' : 'Backup completed', description: r?.size_bytes ? bytes(Number(r.size_bytes)) : undefined });
    },
    onError: (e) => {
      setConfirm(false);
      errorToast(e, 'Backup could not be started');
    }
  });

  if (q.isLoading) return <Loading label="Loading system status…" />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const allOk = COMPONENTS.every((c) => s.components?.[c.key]);
  const current = s.availability?.[0];
  const lastSuccess = (s.backups ?? []).find((b: any) => b.status === 'success');

  return (
    <div className="flex flex-col gap-space-md">
      {s.maintenance && (
        <div className="flex items-start gap-2 p-space-md rounded bg-warning-container/40 text-body-sm text-warning">
          <Icon name="construction" className="text-[20px]" />
          <div>
            <div className="font-semibold">Maintenance mode is ON</div>
            <div className="text-on-surface-variant">
              {s.maintenance.message ?? 'Scheduled maintenance in progress.'}
              {s.maintenance.since ? ` · since ${dateTime(s.maintenance.since)}` : ''}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-space-md">
        <Panel
          title="Components"
          icon="monitor_heart"
          subtitle={`Checked ${relative(s.time)} · refreshes every 30 s`}
          actions={
            <Badge tone={allOk ? 'success' : 'error'} icon={allOk ? 'check_circle' : 'error'}>
              {allOk ? 'All healthy' : 'Degraded'}
            </Badge>
          }
        >
          <ul className="flex flex-col gap-1">
            {COMPONENTS.map((c) => {
              const ok = Boolean(s.components?.[c.key]);
              return (
                <li key={c.key} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-surface-container">
                  <span className="flex items-center gap-2 text-body-sm text-on-surface">
                    <Icon name={c.icon} className="text-[16px] text-outline" />
                    {c.label}
                  </span>
                  <span className={clsx('flex items-center gap-1.5 font-label-sm text-label-sm', ok ? 'text-tertiary' : 'text-error')}>
                    <Dot tone={ok ? 'success' : 'error'} pulse={!ok} />
                    {ok ? 'Healthy' : 'Unavailable'}
                  </span>
                </li>
              );
            })}
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-surface-container">
              <span className="flex items-center gap-2 text-body-sm text-on-surface">
                <Icon name="cast_connected" className="text-[16px] text-outline" />
                Live dashboard connections
              </span>
              <span className="font-mono text-[12px] text-on-surface">{num(s.wsClients)}</span>
            </li>
          </ul>
        </Panel>

        <Panel title="Availability" icon="speed" subtitle={`Monthly API + database availability vs. ${AVAILABILITY_TARGET}% target (NFR)`} className="xl:col-span-2">
          {(s.availability ?? []).length === 0 ? (
            <Empty icon="speed" title="No uptime samples yet." description="Availability is computed from periodic health samples once the scheduler has been running." />
          ) : (
            <div className="flex flex-col gap-space-sm">
              {current && (
                <div className="flex flex-wrap items-baseline gap-space-md">
                  <span className={clsx('font-headline-xl text-headline-xl font-mono', Number(current.availability_pct) >= AVAILABILITY_TARGET ? 'text-tertiary' : 'text-error')}>{pct(current.availability_pct, 3)}</span>
                  <span className="font-label-sm text-label-sm text-outline">
                    {current.month} (month to date) · {num(current.samples)} samples · MQTT {pct(current.mqtt_pct, 2)}
                  </span>
                  <Badge tone={Number(current.availability_pct) >= AVAILABILITY_TARGET ? 'success' : 'error'}>{Number(current.availability_pct) >= AVAILABILITY_TARGET ? 'Meets target' : 'Below target'}</Badge>
                </div>
              )}
              <Table>
                <THead>
                  <tr>
                    <Th>Month</Th>
                    <Th>Availability</Th>
                    <Th className="w-1/3">vs target</Th>
                    <Th className="text-right">MQTT</Th>
                    <Th className="text-right">Samples</Th>
                  </tr>
                </THead>
                <tbody className="text-on-surface">
                  {s.availability.map((a: any) => {
                    const v = Number(a.availability_pct);
                    const ok = v >= AVAILABILITY_TARGET;
                    // Scale 95–100 % onto the bar so differences around the 99.5 % target are visible.
                    const bar = Math.max(0, Math.min(100, ((v - 95) / 5) * 100));
                    return (
                      <Tr key={a.month}>
                        <Td className="font-mono text-[11px]">{a.month}</Td>
                        <Td className={clsx('font-mono text-[12px]', ok ? 'text-tertiary' : 'text-error')}>{pct(a.availability_pct, 3)}</Td>
                        <Td>
                          <div className="relative">
                            <Progress value={bar} tone={ok ? 'success' : 'error'} />
                            <span className="absolute top-[-3px] h-3 w-px bg-on-surface" style={{ left: `${((AVAILABILITY_TARGET - 95) / 5) * 100}%` }} title={`${AVAILABILITY_TARGET}% target`} />
                          </div>
                        </Td>
                        <Td className="font-mono text-[11px] text-right text-on-surface-variant">{pct(a.mqtt_pct, 2)}</Td>
                        <Td className="font-mono text-[11px] text-right text-outline">{num(a.samples)}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              <p className="font-label-sm text-label-sm text-outline">Bars span 95–100 %; the tick marks the {AVAILABILITY_TARGET}% target.</p>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Backups"
        icon="backup"
        subtitle={lastSuccess ? `Last successful backup ${relative(lastSuccess.finished_at ?? lastSuccess.started_at)}` : 'No successful backup recorded'}
        bodyClassName="px-0"
        actions={
          !readOnly ? (
            <Button variant="primary" icon="backup" loading={backup.isPending} onClick={() => setConfirm(true)}>
              Run backup now
            </Button>
          ) : undefined
        }
      >
        {(s.backups ?? []).length === 0 ? (
          <Empty icon="backup" title="No backups yet." description="Backups run automatically on schedule; you can also start one now." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th>Duration</Th>
                <Th className="text-right">Size</Th>
                <Th>Object key / error</Th>
              </tr>
            </THead>
            <tbody className="text-on-surface">
              {s.backups.map((b: any) => (
                <Tr key={b.id}>
                  <Td className="whitespace-nowrap">
                    <div className="font-mono text-[11px]">{dateTime(b.started_at)}</div>
                    <div className="font-label-sm text-label-sm text-outline">{relative(b.started_at)}</div>
                  </Td>
                  <Td>
                    {b.status === 'success' ? (
                      <Badge tone="success" icon="check_circle">
                        Success
                      </Badge>
                    ) : b.status === 'failed' ? (
                      <Badge tone="error" icon="error">
                        Failed
                      </Badge>
                    ) : (
                      <Badge tone="info">
                        <Icon name="progress_activity" className="animate-spin text-[12px]" />
                        Running
                      </Badge>
                    )}
                  </Td>
                  <Td className="font-mono text-[11px] text-outline">{b.finished_at ? duration(new Date(b.finished_at).getTime() - new Date(b.started_at).getTime()) : '—'}</Td>
                  <Td className="font-mono text-[11px] text-right">{b.size_bytes !== null && b.size_bytes !== undefined ? bytes(Number(b.size_bytes)) : '—'}</Td>
                  <Td>
                    {b.error ? (
                      <span className="text-error text-body-sm break-words">{b.error}</span>
                    ) : (
                      <span className="font-mono text-[11px] text-on-surface-variant break-all">{b.object_key ?? '—'}</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel title="Recent error events" icon="bug_report" subtitle="Last 50 server-side errors" bodyClassName="px-0">
        {(s.errors ?? []).length === 0 ? (
          <Empty icon="check_circle" title="No errors recorded." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Source</Th>
                <Th>Message</Th>
              </tr>
            </THead>
            <tbody className="text-on-surface">
              {s.errors.map((er: any) => (
                <Tr key={er.id}>
                  <Td className="whitespace-nowrap">
                    <div className="font-mono text-[11px]">{dateTime(er.occurred_at)}</div>
                    <div className="font-label-sm text-label-sm text-outline">{relative(er.occurred_at)}</div>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-container-highest">{er.source}</span>
                  </Td>
                  <Td className="text-on-surface-variant break-words">{er.message}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => backup.mutate()}
        title="Run backup now"
        message="Starts a full database backup to object storage immediately. This may take a while on large databases; the action is recorded in the audit log."
        confirmLabel="Start backup"
        loading={backup.isPending}
      />
    </div>
  );
}
