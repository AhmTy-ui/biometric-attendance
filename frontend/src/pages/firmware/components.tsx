import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Field, Icon, Input, Modal, Select, Textarea, useErrorToast, useToast, type Tone } from '@/components/ui';
import { api } from '@/lib/api';
import { bytes, num } from '@/lib/format';

/** OTA pipeline (user flow §24): queued → downloading → installing → restarting → verified | failed → retry / rollback. */
export const PIPELINE = ['queued', 'downloading', 'installing', 'restarting', 'verified'] as const;
export type TargetState = (typeof PIPELINE)[number] | 'failed' | 'rolled_back';
export const IN_FLIGHT = ['queued', 'downloading', 'installing', 'restarting'];

export const STATE_LABEL: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  installing: 'Installing',
  restarting: 'Restarting',
  verified: 'Verified',
  failed: 'Failed',
  rolled_back: 'Rolled back'
};
const STATE_ICON: Record<string, string> = {
  queued: 'schedule',
  downloading: 'download',
  installing: 'system_update_alt',
  restarting: 'restart_alt',
  verified: 'verified',
  failed: 'error',
  rolled_back: 'history'
};
/** Background class for bar segments of each state. */
export const STATE_BAR: Record<string, string> = {
  queued: 'bg-outline',
  downloading: 'bg-secondary',
  installing: 'bg-primary',
  restarting: 'bg-secondary-container',
  verified: 'bg-tertiary',
  failed: 'bg-error',
  rolled_back: 'bg-warning'
};
export const STATE_ORDER = ['verified', 'restarting', 'installing', 'downloading', 'queued', 'rolled_back', 'failed'];

export function stateTone(s?: string | null): Tone {
  if (s === 'verified') return 'success';
  if (s === 'failed') return 'error';
  if (s === 'rolled_back') return 'warning';
  if (s === 'queued') return 'neutral';
  return 'info';
}

export function FirmwareStateBadge({ state }: { state: string }) {
  return (
    <Badge tone={stateTone(state)} icon={STATE_ICON[state]}>
      {STATE_LABEL[state] ?? state}
    </Badge>
  );
}

export const DEPLOYMENT_STATUS: Record<string, { label: string; tone: Tone; icon: string }> = {
  in_progress: { label: 'In progress', tone: 'info', icon: 'sync' },
  completed: { label: 'Completed', tone: 'success', icon: 'check_circle' },
  completed_with_failures: { label: 'Completed with failures', tone: 'warning', icon: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'cancel' }
};

export function DeploymentStatusBadge({ status }: { status: string }) {
  const s = DEPLOYMENT_STATUS[status] ?? { label: status, tone: 'neutral' as Tone, icon: 'help' };
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  return <Badge tone={channel === 'stable' ? 'success' : 'warning'}>{channel}</Badge>;
}

export const shortSha = (sha?: string | null) => (sha ? `${sha.slice(0, 8)}…${sha.slice(-6)}` : '—');

/**
 * Per-device pipeline: Queued → Downloading → Installing → Restarting → Verified.
 * A failed / rolled-back target marks the stage where it stopped as unknown (we only know the terminal state),
 * so the whole track is shown in the error / warning tone.
 */
export function DeployPipeline({ state, compact }: { state: string; compact?: boolean }) {
  const idx = PIPELINE.indexOf(state as (typeof PIPELINE)[number]);
  const failed = state === 'failed';
  const rolled = state === 'rolled_back';
  return (
    <div className="flex items-center gap-1 w-full">
      {PIPELINE.map((st, i) => {
        const done = idx >= 0 && i < idx;
        const current = idx === i;
        const verifiedDone = state === 'verified' && i <= idx;
        return (
          <div key={st} className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              className={clsx(
                'h-1.5 rounded-full',
                failed
                  ? 'bg-error/60'
                  : rolled
                    ? 'bg-warning/60'
                    : verifiedDone
                      ? 'bg-tertiary'
                      : done
                        ? 'bg-secondary'
                        : current
                          ? 'bg-secondary animate-pulse'
                          : 'bg-surface-container-highest'
              )}
            />
            {!compact && (
              <span
                className={clsx(
                  'font-label-sm text-label-sm truncate',
                  current || verifiedDone ? 'text-on-surface' : done ? 'text-on-surface-variant' : 'text-outline'
                )}
              >
                {STATE_LABEL[st]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Compact stacked bar of target states for a deployment. */
export function StatesBar({ states, total, className }: { states: Record<string, number> | null | undefined; total: number; className?: string }) {
  const s = states ?? {};
  return (
    <div className={clsx('flex h-1.5 w-full rounded-full overflow-hidden bg-surface-container-highest gap-[2px]', className)}>
      {total > 0 &&
        STATE_ORDER.filter((k) => (s[k] ?? 0) > 0).map((k) => (
          <div key={k} className={STATE_BAR[k]} style={{ width: `${((s[k] ?? 0) / total) * 100}%` }} title={`${STATE_LABEL[k]}: ${s[k]}`} />
        ))}
    </div>
  );
}

export function statesText(states: Record<string, number> | null | undefined) {
  const s = states ?? {};
  const parts = STATE_ORDER.filter((k) => (s[k] ?? 0) > 0).map((k) => `${num(s[k])} ${STATE_LABEL[k]!.toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'No targets';
}

export function StatesLegend({ states }: { states: Record<string, number> }) {
  return (
    <div className="flex flex-wrap gap-x-space-md gap-y-1 font-label-sm text-label-sm text-on-surface-variant">
      {STATE_ORDER.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={clsx('h-2 w-2 rounded-full', STATE_BAR[k])} />
          {STATE_LABEL[k]} <span className="text-on-surface font-mono">{num(states[k] ?? 0)}</span>
        </span>
      ))}
    </div>
  );
}

/** Upload a new firmware artefact (multipart). Server computes SHA-256 and size. */
export function UploadFirmwareModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const errToast = useErrorToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setVersion('');
    setChannel('stable');
    setNotes('');
    setFile(null);
    setErr(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('version', version.trim());
      fd.append('channel', channel);
      if (notes.trim()) fd.append('releaseNotes', notes.trim());
      fd.append('file', file as Blob, file!.name);
      return api.upload('/api/firmware/versions', fd);
    },
    onSuccess: (row: any) => {
      toast({ tone: 'success', title: `Firmware ${row?.version ?? version} uploaded`, description: row?.sha256 ? `SHA-256 ${row.sha256}` : undefined });
      void qc.invalidateQueries({ queryKey: ['firmware-versions'] });
      reset();
      onClose();
    },
    onError: (e) => errToast(e, 'Upload failed')
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[0-9A-Za-z.+-]+$/.test(version.trim())) return setErr('Use letters, digits, dot, plus or dash (e.g. 2.4.1).');
    if (!file) return setErr('Choose a firmware file.');
    setErr(null);
    m.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!m.isPending) onClose();
      }}
      title="Upload firmware version"
      icon="cloud_upload"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" icon="upload" type="submit" form="fw-upload" loading={m.isPending}>
            Upload
          </Button>
        </>
      }
    >
      <form id="fw-upload" onSubmit={submit} className="flex flex-col gap-space-md">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-md">
          <Field label="Version" required>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 2.4.1" maxLength={40} autoFocus />
          </Field>
          <Field label="Channel" required>
            <Select value={channel} onChange={(e) => setChannel(e.target.value as 'stable' | 'beta')}>
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </Select>
          </Field>
        </div>
        <Field label="Firmware file" required hint={file ? `${file.name} · ${bytes(file.size)}` : 'The SHA-256 checksum is computed on upload and verified by the device before installing.'}>
          <input
            ref={fileRef}
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-body-sm text-on-surface-variant file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-surface-container-high file:text-on-surface file:font-label-md file:text-label-md hover:file:bg-surface-container-highest"
          />
        </Field>
        <Field label="Release notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} placeholder="What changed in this version" />
        </Field>
        {err && (
          <div className="flex items-center gap-2 text-body-sm text-error">
            <Icon name="error" className="text-[16px]" />
            {err}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Shared recharts styling derived from the design tokens. */
export const chartTheme = {
  grid: '#434655',
  axis: '#8d90a0',
  tick: { fill: '#8d90a0', fontSize: 10, fontFamily: '"JetBrains Mono Variable", monospace' },
  tooltip: {
    contentStyle: { background: '#262a33', border: '1px solid #434655', borderRadius: 4, fontSize: 12, color: '#dfe2ee' },
    labelStyle: { color: '#c3c6d7', fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 11 },
    itemStyle: { color: '#dfe2ee' },
    cursor: { fill: 'rgba(141,144,160,0.08)' }
  }
};
