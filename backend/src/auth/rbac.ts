import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { forbidden } from '../lib/errors.js';

export type Role = 'administrator' | 'manager' | 'branch_supervisor';

export const PERMISSIONS = {
  'dashboard.view': 'View dashboard',
  'attendance.view': 'View attendance',
  'attendance.export': 'Export attendance and reports',
  'attendance.redeliver': 'Retry / replay web-software delivery',
  'reports.view': 'View reports & analytics',
  'employees.view': 'View employees',
  'employees.sync': 'Trigger employee synchronisation',
  'locations.view': 'View locations',
  'locations.manage': 'Create / edit locations and mappings',
  'devices.view': 'View devices',
  'devices.provision': 'Provision, activate and decommission devices',
  'devices.command.basic': 'Sync roster / refresh status on a device',
  'devices.command.advanced': 'Restart, send configuration, update firmware',
  'enrolment.view': 'View enrolment sessions and biometric status',
  'firmware.view': 'View firmware versions and deployments',
  'firmware.manage': 'Upload firmware and deploy OTA updates',
  'alerts.view': 'View alerts',
  'alerts.manage': 'Acknowledge / resolve alerts',
  'integration.view': 'View integration status and sync history',
  'integration.manage': 'Run syncs, resolve unmapped locations, manage DLQ',
  'users.view': 'View users',
  'users.manage': 'Create / edit users and roles',
  'audit.view': 'View and export the audit log',
  'settings.view': 'View system settings',
  'settings.manage': 'Change system settings'
} as const;

export type Permission = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  administrator: ALL,
  manager: [
    'dashboard.view',
    'attendance.view',
    'attendance.export',
    'reports.view',
    'employees.view',
    'employees.sync',
    'locations.view',
    'devices.view',
    'devices.command.basic',
    'devices.command.advanced',
    'enrolment.view',
    'firmware.view',
    'alerts.view',
    'alerts.manage',
    'integration.view'
  ],
  branch_supervisor: [
    'dashboard.view',
    'attendance.view',
    'employees.view',
    'locations.view',
    'devices.view',
    'devices.command.basic',
    'enrolment.view',
    'alerts.view'
  ]
};

export const ROLE_LABELS: Record<Role, string> = {
  administrator: 'Administrator',
  manager: 'Manager',
  branch_supervisor: 'Branch Supervisor'
};

export interface Principal {
  userId: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: Role;
  /** null = unrestricted (administrator) */
  locationIds: string[] | null;
  sessionId: string;
}

export function can(p: Principal, perm: Permission) {
  return ROLE_PERMISSIONS[p.role].includes(perm);
}

export function assertCan(p: Principal, perm: Permission) {
  if (!can(p, perm)) throw forbidden();
}

export async function loadLocationScope(userId: string, role: Role, db: Db = pool): Promise<string[] | null> {
  if (role === 'administrator') return null;
  const r = await db.query<{ location_id: string }>('SELECT location_id FROM user_locations WHERE user_id=$1', [userId]);
  return r.rows.map((x) => x.location_id);
}

/** Throws unless the principal may see the given location. */
export function assertLocation(p: Principal, locationId: string | null | undefined) {
  if (p.locationIds === null) return;
  if (!locationId || !p.locationIds.includes(locationId)) throw forbidden();
}

/**
 * Build a SQL fragment restricting `column` to the principal's locations.
 * Appends the parameter to `params` and returns e.g. ` AND e.location_id = ANY($3)`.
 */
export function scopeSql(p: Principal, column: string, params: unknown[]): string {
  if (p.locationIds === null) return '';
  params.push(p.locationIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}
