import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Field, Icon, Input, Panel, Toggle, useErrorToast, useToast } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export const MASK = '••••••••';

export type SectionKey = 'organization' | 'security' | 'mfa' | 'notifications' | 'integration' | 'device_policies' | 'data_retention';

export const SECTION_LABEL: Record<SectionKey, string> = {
  organization: 'Organization',
  security: 'Security',
  mfa: 'MFA',
  notifications: 'Notifications',
  integration: 'Integration',
  device_policies: 'Device policies',
  data_retention: 'Data retention'
};

const stable = (v: unknown) => JSON.stringify(v);

/**
 * Draft state for one settings section. The whole section object is PUT on save;
 * validation errors from the server (`details: [{path, message}]`) are mapped per field.
 */
export function useSectionForm<T extends Record<string, any>>(section: SectionKey, server: T) {
  const qc = useQueryClient();
  const toast = useToast();
  const errorToast = useErrorToast();
  const [draft, setDraft] = useState<T>(server);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const serverKey = stable(server);

  // Re-seed the draft when the server copy changes (after save or refetch).
  useEffect(() => {
    setDraft(server);
    setErrors({});
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const dirty = useMemo(() => stable(draft) !== serverKey, [draft, serverKey]);

  const set = <K extends keyof T>(key: K, value: T[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key as string]) return e;
      const n = { ...e };
      delete n[key as string];
      return n;
    });
  };

  const save = useMutation({
    mutationFn: (body: T) => api.put(`/api/settings/${section}`, body),
    onSuccess: () => {
      setErrors({});
      setFormError(null);
      toast({ tone: 'success', title: `${SECTION_LABEL[section]} settings saved`, description: 'The change has been recorded in the audit log.' });
      void qc.invalidateQueries({ queryKey: ['settings'] });
      if (section === 'organization') void qc.invalidateQueries({ queryKey: ['me'] });
      if (section === 'integration') void qc.invalidateQueries({ queryKey: ['integration-status'] });
    },
    onError: (e) => {
      const err = e as ApiError;
      const map: Record<string, string> = {};
      if (Array.isArray(err.details)) for (const d of err.details) if (d && typeof d === 'object' && d.path !== undefined) map[String(d.path)] = d.message;
      setErrors(map);
      setFormError(err.message ?? 'Validation failed');
      errorToast(e, `Could not save ${SECTION_LABEL[section]} settings`);
    }
  });

  return {
    draft,
    set,
    setDraft,
    dirty,
    errors,
    formError,
    save: () => save.mutate(draft),
    saving: save.isPending,
    reset: () => {
      setDraft(server);
      setErrors({});
      setFormError(null);
    }
  };
}

// ───────────────────────── Layout ─────────────────────────
export function SectionCard({
  title,
  icon,
  description,
  children,
  form,
  readOnly,
  saveDisabled,
  saveHint
}: {
  title: string;
  icon: string;
  description?: ReactNode;
  children: ReactNode;
  form: { dirty: boolean; saving: boolean; save: () => void; reset: () => void; formError: string | null; errors: Record<string, string> };
  readOnly: boolean;
  saveDisabled?: boolean;
  saveHint?: ReactNode;
}) {
  const unmapped = Object.entries(form.errors);
  return (
    <Panel title={title} icon={icon} subtitle={description}>
      <div className="flex flex-col gap-space-lg">{children}</div>
      {form.formError && (
        <div className="mt-space-md p-space-sm rounded bg-error-container/40 text-body-sm text-on-error-container flex items-start gap-2">
          <Icon name="error" className="text-[18px]" />
          <div>
            <div className="font-semibold">{form.formError}</div>
            {unmapped.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {unmapped.map(([k, m]) => (
                  <li key={k}>
                    <span className="font-mono">{k || 'section'}</span>: {m}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {!readOnly && (
        <div className="mt-space-lg pt-space-md border-t border-outline-variant/20 flex flex-col sm:flex-row sm:items-center justify-between gap-space-sm">
          <div className="flex items-center gap-1.5 font-label-sm text-label-sm text-outline">
            {form.dirty ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                <span className="text-warning">Unsaved changes</span>
              </>
            ) : (
              <>
                <Icon name="receipt_long" className="text-[14px]" />
                <span>Every saved change is recorded in the audit log with before/after values.</span>
              </>
            )}
            {saveHint && <span className="ml-2">{saveHint}</span>}
          </div>
          <div className="flex gap-space-xs">
            <Button variant="ghost" icon="undo" disabled={!form.dirty || form.saving} onClick={form.reset}>
              Discard
            </Button>
            <Button variant="primary" icon="save" disabled={!form.dirty || saveDisabled} loading={form.saving} onClick={form.save}>
              Save {title.toLowerCase()}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function Group({ title, description, children, cols = 2 }: { title: string; description?: ReactNode; children: ReactNode; cols?: 1 | 2 | 3 }) {
  return (
    <div className="flex flex-col gap-space-sm">
      <div>
        <h3 className="font-label-md text-label-md uppercase tracking-wider text-on-surface">{title}</h3>
        {description && <p className="font-body-sm text-body-sm text-outline">{description}</p>}
      </div>
      <div className={clsx('grid grid-cols-1 gap-space-md', cols === 2 && 'md:grid-cols-2', cols === 3 && 'md:grid-cols-3')}>{children}</div>
    </div>
  );
}

// ───────────────────────── Inputs ─────────────────────────
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  error,
  disabled
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: ReactNode;
  error?: string;
  disabled?: boolean;
}) {
  const valid = Number.isFinite(value);
  const local = !valid ? 'Enter a number.' : min !== undefined && value < min ? `Minimum ${min}.` : max !== undefined && value > max ? `Maximum ${max}.` : null;
  const range = min !== undefined && max !== undefined ? `Allowed ${min}–${max}${unit ? ` ${unit}` : ''}.` : undefined;
  return (
    <Field
      label={label}
      error={error ?? local}
      hint={
        hint || range ? (
          <>
            {hint}
            {hint && range ? ' ' : ''}
            {range}
          </>
        ) : undefined
      }
    >
      <div className="relative">
        <Input
          type="number"
          value={valid ? value : ''}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          className={unit ? 'pr-16' : undefined}
        />
        {unit && <span className="absolute right-2 top-1/2 -translate-y-1/2 font-label-sm text-label-sm text-outline pointer-events-none">{unit}</span>}
      </div>
    </Field>
  );
}

export function ToggleRow({ label, description, checked, onChange, disabled, error }: { label: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; error?: string }) {
  return (
    <div className="flex items-start justify-between gap-space-md p-space-sm rounded bg-surface-container">
      <div className="min-w-0">
        <div className="text-body-sm text-on-surface font-medium">{label}</div>
        {description && <div className="font-body-sm text-[11px] text-outline">{description}</div>}
        {error && <div className="font-body-sm text-body-sm text-error">{error}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function CheckGroup<T extends string>({
  options,
  value,
  onChange,
  disabled
}: {
  options: { key: T; label: string; description?: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-space-xs">
      {options.map((o) => {
        const on = value.includes(o.key);
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== o.key) : [...value, o.key])}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-body-sm transition-colors disabled:opacity-60',
              on ? 'bg-primary-container/15 border-primary-container text-on-surface' : 'bg-surface-container border-transparent text-on-surface-variant hover:bg-surface-container-high'
            )}
            title={o.description}
          >
            <Icon name={on ? 'check_box' : 'check_box_outline_blank'} className={clsx('text-[16px]', on ? 'text-primary' : 'text-outline')} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function RadioCards<T extends string>({
  options,
  value,
  onChange,
  disabled
}: {
  options: { key: T; label: string; description: ReactNode; icon?: string; badge?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={clsx('grid grid-cols-1 gap-space-sm', options.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-3')}>
      {options.map((o) => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.key)}
            className={clsx(
              'p-space-sm rounded border text-left flex flex-col gap-1 transition-colors disabled:opacity-60',
              on ? 'bg-primary-container/15 border-primary-container' : 'bg-surface-container border-transparent hover:bg-surface-container-high'
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-body-sm text-on-surface font-medium">
                {o.icon && <Icon name={o.icon} className={clsx('text-[18px]', on ? 'text-primary' : 'text-outline')} />}
                {o.label}
              </span>
              <span className="flex items-center gap-1">
                {o.badge && <span className="font-label-sm text-label-sm px-1.5 rounded bg-surface-container-highest text-on-surface-variant">{o.badge}</span>}
                <Icon name={on ? 'radio_button_checked' : 'radio_button_unchecked'} className={clsx('text-[18px]', on ? 'text-primary' : 'text-outline')} />
              </span>
            </div>
            <div className="font-body-sm text-[11px] text-on-surface-variant leading-snug">{o.description}</div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A stored secret is returned masked (`••••••••`). Keeping the mask leaves it unchanged,
 * entering a value replaces it, and clearing sets it to empty.
 */
export function SecretField({ label, value, onChange, disabled, hint, placeholder, error }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: ReactNode; placeholder?: string; error?: string }) {
  const [editing, setEditing] = useState(false);
  const stored = value === MASK;
  useEffect(() => {
    if (stored) setEditing(false);
  }, [stored]);
  if (stored && !editing)
    return (
      <Field label={label} hint={hint} error={error}>
        <div className="flex items-center gap-space-xs">
          <div className="flex-1 h-9 flex items-center gap-2 px-space-sm rounded bg-surface-container-lowest border border-outline-variant/40 text-body-md text-on-surface-variant">
            <Icon name="lock" className="text-[15px] text-tertiary" />
            <span className="font-mono tracking-widest">{MASK}</span>
            <span className="font-label-sm text-label-sm text-outline">stored (encrypted)</span>
          </div>
          {!disabled && (
            <>
              <Button size="sm" icon="edit" onClick={() => {
                setEditing(true);
                onChange('');
              }}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" icon="delete" onClick={() => onChange('')}>
                Remove
              </Button>
            </>
          )}
        </div>
      </Field>
    );
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-space-xs">
        <Input type="password" autoComplete="new-password" value={value === MASK ? '' : value} placeholder={placeholder ?? 'Not set'} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              onChange(MASK);
            }}
          >
            Keep stored
          </Button>
        )}
      </div>
    </Field>
  );
}

export function TextField({ label, value, onChange, disabled, hint, error, placeholder, type, mono, required }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: ReactNode; error?: string; placeholder?: string; type?: string; mono?: boolean; required?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <Input type={type ?? 'text'} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={mono ? 'font-mono text-[12px]' : undefined} />
    </Field>
  );
}

/** Pick the first error whose path starts with the given key (e.g. "alertEmailRecipients.2"). */
export function errFor(errors: Record<string, string>, key: string): string | undefined {
  if (errors[key]) return errors[key];
  const k = Object.keys(errors).find((p) => p.startsWith(`${key}.`));
  return k ? errors[k] : undefined;
}
