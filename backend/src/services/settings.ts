import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { redis } from '../lib/redis.js';

export const settingSchemas = {
  security: z.object({
    passwordMinLength: z.number().int().min(8).max(128),
    passwordRequireUpper: z.boolean(),
    passwordRequireLower: z.boolean(),
    passwordRequireDigit: z.boolean(),
    passwordRequireSymbol: z.boolean(),
    passwordHistoryDays: z.number().int().min(0).max(3650),
    lockoutThreshold: z.number().int().min(3).max(20),
    lockoutMinutes: z.number().int().min(1).max(1440),
    sessionIdleMinutes: z.number().int().min(5).max(1440),
    sessionAbsoluteHours: z.number().int().min(1).max(168)
  }),
  mfa: z.object({
    enforceForAdministrators: z.boolean(),
    enforceForManagers: z.boolean(),
    enforceForSupervisors: z.boolean(),
    issuer: z.string().min(1).max(64)
  }),
  notifications: z.object({
    emailEnabled: z.boolean(),
    alertEmailRecipients: z.array(z.string().email()),
    notifyOnSeverities: z.array(z.enum(['critical', 'warning', 'info'])),
    notifyRoles: z.array(z.enum(['administrator', 'manager', 'branch_supervisor']))
  }),
  integration: z.object({
    baseUrl: z.string().url().or(z.literal('')),
    apiKey: z.string(),
    employeesPath: z.string(),
    locationsPath: z.string(),
    attendancePath: z.string(),
    timeoutMs: z.number().int().min(1000).max(60000),
    incrementalSyncMinutes: z.number().int().min(1).max(1440),
    fullSyncHourUtc: z.number().int().min(0).max(23),
    deliveryMode: z.enum(['api', 'scheduled_export', 'disabled']),
    maxDeliveryAttempts: z.number().int().min(1).max(20),
    backoffBaseSeconds: z.number().int().min(1).max(3600),
    backoffMaxSeconds: z.number().int().min(10).max(86400),
    exportFormat: z.enum(['csv', 'xlsx']),
    exportCron: z.object({ everyMinutes: z.number().int().min(5).max(1440) }),
    exportEndpointUrl: z.string().url().or(z.literal('')),
    exportEndpointAuthHeader: z.string()
  }),
  device_policies: z.object({
    heartbeatIntervalSeconds: z.number().int().min(10).max(600),
    offlineAfterMissedHeartbeats: z.number().int().min(2).max(20),
    storageWarningPct: z.number().min(50).max(99),
    storageCriticalPct: z.number().min(50).max(100),
    storageFullPolicy: z.enum(['continue_capturing_alert', 'preserve_oldest']),
    minMatchScore: z.number().int().min(1).max(100),
    minEnrolQuality: z.number().int().min(1).max(100),
    fingersPerEmployee: z.number().int().min(1).max(10),
    uploadBatchSize: z.number().int().min(10).max(5000),
    duplicatePunchWindowSeconds: z.number().int().min(0).max(3600)
  }),
  data_retention: z.object({
    attendanceRetentionMonths: z.number().int().min(12).max(240),
    deviceLogRetentionDays: z.number().int().min(7).max(3650),
    heartbeatRetentionDays: z.number().int().min(1).max(365),
    backupRetentionDays: z.number().int().min(30).max(365)
  }),
  organization: z.object({
    displayName: z.string().min(1),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown IANA timezone'),
    supportEmail: z.string().email().or(z.literal('')),
    lateThresholdMinutes: z.number().int().min(0).max(240)
  })
};

export type SettingSection = keyof typeof settingSchemas;
export type Settings<S extends SettingSection> = z.infer<(typeof settingSchemas)[S]>;

export const defaultSettings: { [S in SettingSection]: Settings<S> } = {
  security: {
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSymbol: true,
    passwordHistoryDays: 0,
    lockoutThreshold: 5,
    lockoutMinutes: 15,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 12
  },
  mfa: { enforceForAdministrators: true, enforceForManagers: true, enforceForSupervisors: false, issuer: 'BAMP' },
  notifications: {
    emailEnabled: false,
    alertEmailRecipients: [],
    notifyOnSeverities: ['critical', 'warning'],
    notifyRoles: ['administrator']
  },
  integration: {
    baseUrl: '',
    apiKey: '',
    employeesPath: '/api/v1/employees',
    locationsPath: '/api/v1/locations',
    attendancePath: '/api/v1/attendance',
    timeoutMs: 10000,
    incrementalSyncMinutes: 5,
    fullSyncHourUtc: 2,
    deliveryMode: 'api',
    maxDeliveryAttempts: 6,
    backoffBaseSeconds: 5,
    backoffMaxSeconds: 3600,
    exportFormat: 'csv',
    exportCron: { everyMinutes: 60 },
    exportEndpointUrl: '',
    exportEndpointAuthHeader: ''
  },
  device_policies: {
    heartbeatIntervalSeconds: 30,
    offlineAfterMissedHeartbeats: 3,
    storageWarningPct: 80,
    storageCriticalPct: 95,
    storageFullPolicy: 'continue_capturing_alert',
    minMatchScore: 60,
    minEnrolQuality: 50,
    fingersPerEmployee: 2,
    uploadBatchSize: 200,
    duplicatePunchWindowSeconds: 60
  },
  data_retention: {
    attendanceRetentionMonths: 84,
    deviceLogRetentionDays: 90,
    heartbeatRetentionDays: 14,
    backupRetentionDays: 30
  },
  organization: { displayName: '', timezone: 'Africa/Lagos', supportEmail: '', lateThresholdMinutes: 15 }
};

const cacheKey = (org: string, s: string) => `settings:${org}:${s}`;

export async function getSettings<S extends SettingSection>(orgId: string, section: S, db: Db = pool): Promise<Settings<S>> {
  const cached = await redis.get(cacheKey(orgId, section)).catch(() => null);
  if (cached) return JSON.parse(cached);
  const r = await db.query('SELECT value FROM settings WHERE organization_id=$1 AND section=$2', [orgId, section]);
  const value = { ...(defaultSettings[section] as object), ...(r.rows[0]?.value ?? {}) } as Settings<S>;
  await redis.set(cacheKey(orgId, section), JSON.stringify(value), 'EX', 60).catch(() => undefined);
  return value;
}

export async function saveSettings<S extends SettingSection>(orgId: string, section: S, value: Settings<S>, userId: string | null, db: Db) {
  const parsed = settingSchemas[section].parse(value);
  await db.query(
    `INSERT INTO settings (organization_id, section, value, updated_at, updated_by) VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (organization_id, section) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [orgId, section, JSON.stringify(parsed), userId]
  );
  await redis.del(cacheKey(orgId, section)).catch(() => undefined);
  return parsed;
}

/**
 * Drop the cached copy of a section. Call AFTER the saving transaction commits: a concurrent reader between the
 * in-transaction delete and COMMIT would otherwise re-cache the old value.
 */
export async function invalidateSettings(orgId: string, section: SettingSection) {
  await redis.del(cacheKey(orgId, section)).catch(() => undefined);
}

export function passwordPolicyErrors(pw: string, s: Settings<'security'>): string[] {
  const errs: string[] = [];
  if (pw.length < s.passwordMinLength) errs.push(`At least ${s.passwordMinLength} characters`);
  if (s.passwordRequireUpper && !/[A-Z]/.test(pw)) errs.push('An uppercase letter');
  if (s.passwordRequireLower && !/[a-z]/.test(pw)) errs.push('A lowercase letter');
  if (s.passwordRequireDigit && !/[0-9]/.test(pw)) errs.push('A digit');
  if (s.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(pw)) errs.push('A symbol');
  return errs;
}
