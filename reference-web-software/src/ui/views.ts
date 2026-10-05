import type { AdminSession } from '../auth/session.js';
import { config } from '../config.js';
import { maskSecret } from '../lib/security.js';
import { formatWithOffset } from '../lib/time.js';
import type { EmployeeRow, StatusHistoryRow } from '../services/employees.js';
import { EMPLOYMENT_STATUSES } from '../services/employees.js';
import { IMPORT_COLUMNS } from '../services/imports.js';
import type { LocationRow } from '../services/locations.js';
import type { ApiLogRow, AttendanceRow, ImportRow } from '../services/queries.js';
import { html, qs, raw } from './html.js';
import {
  APP_NAME,
  csrfField,
  emptyState,
  fieldError,
  type Flash,
  page,
  pageHeader,
  pager,
  STATUS_LABEL,
  statusBadge,
  ts
} from './layout.js';

type Values = Record<string, string>;
type Errors = Record<string, string>;

const selected = (a: string | null | undefined, b: string) => (a === b ? raw(' selected') : '');
const invalid = (errors: Errors, f: string) => (errors[f] ? raw(` aria-invalid="true" aria-describedby="${f}-error"`) : '');

function locationOptions(locations: LocationRow[], current: string | null | undefined, noneLabel: string) {
  return html`<option value=""${selected(current ?? '', '')}>${noneLabel}</option>
${locations.map((l) => html`<option value="${l.ref}"${selected(current, l.ref)}>${l.name} (${l.ref})</option>`)}`;
}

// ───────────────────────────── authentication ─────────────────────────────

export function loginPage(opts: { csrf: string; email?: string; error?: string; next?: string }) {
  return page({
    title: 'Sign in',
    session: null,
    body: html`<div class="auth-card">
  <div class="auth-brand"><span class="brand-mark" aria-hidden="true">W</span><span>${APP_NAME}</span></div>
  <h1>Sign in</h1>
  <p class="muted">Human resources administration — employees, locations and attendance.</p>
  ${opts.error ? html`<div class="flash flash-error" role="alert">${opts.error}</div>` : ''}
  <form method="post" action="/login" class="form">
    <input type="hidden" name="_csrf" value="${opts.csrf}">
    <input type="hidden" name="next" value="${opts.next ?? ''}">
    <label class="field"><span>Email</span>
      <input type="email" name="email" value="${opts.email ?? ''}" autocomplete="username" required autofocus maxlength="254"></label>
    <label class="field"><span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required maxlength="512"></label>
    <button type="submit" class="btn btn-primary btn-block">Sign in</button>
  </form>
</div>`
  });
}

export function errorPage(session: AdminSession | null, status: number, title: string, message: string) {
  return page({
    title,
    session,
    body: html`<div class="card error-card"><p class="error-code">${status}</p><h1>${title}</h1><p>${message}</p>
<p><a class="btn btn-primary" href="${session ? '/employees' : '/login'}">${session ? 'Back to employees' : 'Sign in'}</a></p></div>`
  });
}

// ───────────────────────────── employees ─────────────────────────────

export function employeesPage(opts: {
  session: AdminSession;
  flash: Flash | null;
  rows: EmployeeRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: { q: string; location: string; status: string };
  locations: LocationRow[];
  counts: Record<string, number>;
}) {
  const f = opts.filter;
  const filtered = !!(f.q || f.location || f.status);
  const all = Object.values(opts.counts).reduce((a, b) => a + b, 0);
  const body = html`${pageHeader(
    'Employees',
    'The system of record for staff, their assigned location and employment status. BAMP synchronises from here.',
    html`<a class="btn btn-primary" href="/employees/new">New employee</a>`
  )}
<div class="stats">
  <a class="stat${!f.status ? ' stat-active' : ''}" href="/employees${qs({ q: f.q, location: f.location })}"><span class="stat-value">${all}</span><span class="stat-label">All</span></a>
  ${EMPLOYMENT_STATUSES.map(
    (s) =>
      html`<a class="stat${f.status === s ? ' stat-active' : ''}" href="/employees${qs({ q: f.q, location: f.location, status: s })}"><span class="stat-value">${opts.counts[s] ?? 0}</span><span class="stat-label">${STATUS_LABEL[s]}</span></a>`
  )}
</div>
<form class="filters card" method="get" action="/employees" role="search">
  <label class="field grow"><span>Search</span><input type="search" name="q" value="${f.q}" placeholder="Name, staff number, reference or department" maxlength="100"></label>
  <label class="field"><span>Location</span><select name="location">
    <option value="">All locations</option>
    <option value="__none"${selected(f.location, '__none')}>Unassigned</option>
    ${opts.locations.map((l) => html`<option value="${l.ref}"${selected(f.location, l.ref)}>${l.name}</option>`)}
  </select></label>
  <label class="field"><span>Status</span><select name="status">
    <option value="">Any status</option>
    ${EMPLOYMENT_STATUSES.map((s) => html`<option value="${s}"${selected(f.status, s)}>${STATUS_LABEL[s]}</option>`)}
  </select></label>
  <div class="filter-actions"><button class="btn btn-secondary" type="submit">Apply</button>${filtered ? html`<a class="btn btn-ghost" href="/employees">Reset</a>` : ''}</div>
</form>
${
  opts.rows.length
    ? html`<div class="card table-card"><div class="table-wrap"><table class="table">
<thead><tr><th>Reference</th><th>Staff no.</th><th>Name</th><th>Department</th><th>Location</th><th>Status</th><th>Last modified</th></tr></thead>
<tbody>
${opts.rows.map(
  (e) => html`<tr>
  <td data-label="Reference"><a class="mono" href="/employees/${encodeURIComponent(e.web_reference_id)}">${e.web_reference_id}</a></td>
  <td data-label="Staff no." class="mono">${e.staff_number}</td>
  <td data-label="Name"><a href="/employees/${encodeURIComponent(e.web_reference_id)}">${e.full_name}</a></td>
  <td data-label="Department">${e.department ?? html`<span class="muted">—</span>`}</td>
  <td data-label="Location">${e.location_ref ? html`${e.location_name ?? e.location_ref} <span class="muted mono">${e.location_ref}</span>` : html`<span class="muted">Unassigned</span>`}</td>
  <td data-label="Status">${statusBadge(e.employment_status)}</td>
  <td data-label="Last modified">${ts(e.updated_at)}</td>
</tr>`
)}
</tbody></table></div>
${pager(opts.page, opts.pageSize, opts.total, '/employees', { q: f.q, location: f.location, status: f.status })}</div>`
    : filtered
      ? emptyState('No matching employees', 'Try a different search or clear the filters.', html`<a class="btn btn-secondary" href="/employees">Clear filters</a>`)
      : emptyState(
          'No employees yet',
          opts.locations.length
            ? 'Create the first employee record. BAMP picks it up on its next synchronisation.'
            : 'Start by creating the locations (branches) employees are assigned to, then add employees.',
          opts.locations.length
            ? html`<a class="btn btn-primary" href="/employees/new">New employee</a>`
            : html`<a class="btn btn-primary" href="/locations/new">New location</a>`
        )
}`;
  return page({ title: 'Employees', active: 'employees', session: opts.session, flash: opts.flash, body });
}

function employeeDetailFields(values: Values, errors: Errors, locations: LocationRow[], departments: string[]) {
  return html`<div class="grid-2">
  <label class="field"><span>Staff number <em class="req">required</em></span>
    <input name="staffNumber" value="${values.staffNumber ?? ''}" required maxlength="32" autocomplete="off"${invalid(errors, 'staffNumber')}>
    <small class="hint">Unique payroll / HR number, e.g. 004512.</small>${fieldError(errors, 'staffNumber')}</label>
  <label class="field"><span>Full name <em class="req">required</em></span>
    <input name="fullName" value="${values.fullName ?? ''}" required maxlength="160" autocomplete="off"${invalid(errors, 'fullName')}>${fieldError(errors, 'fullName')}</label>
  <label class="field"><span>Department</span>
    <input name="department" value="${values.department ?? ''}" maxlength="120" list="departments" autocomplete="off"${invalid(errors, 'department')}>
    <datalist id="departments">${departments.map((d) => html`<option value="${d}">`)}</datalist>${fieldError(errors, 'department')}</label>
  <label class="field"><span>Assigned location</span>
    <select name="locationRef"${invalid(errors, 'locationRef')}>${locationOptions(locations, values.locationRef, 'Unassigned')}</select>
    <small class="hint">Determines which branch devices receive the employee's fingerprints in BAMP.</small>${fieldError(errors, 'locationRef')}</label>
</div>`;
}

export function employeeCreatePage(opts: {
  session: AdminSession;
  values: Values;
  errors: Errors;
  locations: LocationRow[];
  departments: string[];
  flash?: Flash | null;
}) {
  const body = html`${pageHeader('New employee', 'A web reference ID (EMP-######) is assigned automatically when the record is saved.')}
<form class="card form" method="post" action="/employees" novalidate>
  ${csrfField(opts.session)}
  ${employeeDetailFields(opts.values, opts.errors, opts.locations, opts.departments)}
  <div class="grid-2">
    <label class="field"><span>Employment status</span>
      <select name="employmentStatus"${invalid(opts.errors, 'employmentStatus')}>
        ${EMPLOYMENT_STATUSES.map((s) => html`<option value="${s}"${selected(opts.values.employmentStatus ?? 'active', s)}>${STATUS_LABEL[s]}</option>`)}
      </select>${fieldError(opts.errors, 'employmentStatus')}</label>
  </div>
  <div class="form-actions"><button class="btn btn-primary" type="submit">Create employee</button><a class="btn btn-ghost" href="/employees">Cancel</a></div>
</form>`;
  return page({ title: 'New employee', active: 'employees', session: opts.session, flash: opts.flash ?? null, body });
}

export function employeeEditPage(opts: {
  session: AdminSession;
  flash: Flash | null;
  employee: EmployeeRow;
  values: Values;
  errors: Errors;
  statusValues: Values;
  statusErrors: Errors;
  locations: LocationRow[];
  departments: string[];
  history: StatusHistoryRow[];
  recent: AttendanceRow[];
  statusTimeZone: string;
}) {
  const e = opts.employee;
  const ref = encodeURIComponent(e.web_reference_id);
  const nextStatuses = EMPLOYMENT_STATUSES.filter((s) => s !== e.employment_status);
  const body = html`${pageHeader(
    e.full_name,
    html`<span class="mono">${e.web_reference_id}</span> · Staff no. <span class="mono">${e.staff_number}</span> · ${statusBadge(e.employment_status)}`,
    html`<a class="btn btn-ghost" href="/employees">← All employees</a>`
  )}
<div class="layout-2">
  <div class="stack">
    <form class="card form" method="post" action="/employees/${ref}" novalidate>
      <h2>Details &amp; assignment</h2>
      ${csrfField(opts.session)}
      ${employeeDetailFields(opts.values, opts.errors, opts.locations, opts.departments)}
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save changes</button></div>
    </form>

    <form class="card form" method="post" action="/employees/${ref}/status" novalidate data-status-form data-current="${e.employment_status}">
      <h2>Employment status</h2>
      <p class="muted">Currently ${statusBadge(e.employment_status)}. Terminated or inactive employees are removed from branch devices by BAMP;
      attendance captured on or after the effective time is refused (HTTP 422).</p>
      ${csrfField(opts.session)}
      <div class="grid-3">
        <label class="field"><span>New status</span>
          <select name="status" data-status-select${invalid(opts.statusErrors, 'status')}>
            ${nextStatuses.map((s) => html`<option value="${s}"${selected(opts.statusValues.status, s)}>${STATUS_LABEL[s]}</option>`)}
          </select>${fieldError(opts.statusErrors, 'status')}</label>
        <label class="field"><span>Effective from <small class="muted">(${opts.statusTimeZone})</small></span>
          <input type="datetime-local" name="effectiveAt" value="${opts.statusValues.effectiveAt ?? ''}"${invalid(opts.statusErrors, 'effectiveAt')}>
          <small class="hint">Leave empty for now. May be backdated, not future-dated.</small>${fieldError(opts.statusErrors, 'effectiveAt')}</label>
        <label class="field"><span>Note</span>
          <input name="note" value="${opts.statusValues.note ?? ''}" maxlength="500" placeholder="Reason (optional)"${invalid(opts.statusErrors, 'note')}>${fieldError(opts.statusErrors, 'note')}</label>
      </div>
      <div class="form-actions"><button class="btn btn-danger-outline" type="submit" data-status-submit>Change status</button></div>
    </form>
  </div>

  <aside class="stack">
    <section class="card">
      <h2>Record</h2>
      <dl class="kv">
        <dt>Web reference ID</dt><dd class="mono">${e.web_reference_id}</dd>
        <dt>Location</dt><dd>${e.location_ref ? html`${e.location_name ?? e.location_ref} <span class="muted mono">${e.location_ref}</span>` : html`<span class="muted">Unassigned</span>`}</dd>
        <dt>Created</dt><dd>${ts(e.created_at)}</dd>
        <dt>Last modified</dt><dd>${ts(e.updated_at)}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Status history</h2>
      ${
        opts.history.length
          ? html`<ol class="timeline">${opts.history.map(
              (h) => html`<li>${statusBadge(h.status)} <span>from ${ts(h.effective_at)}</span>${h.note ? html`<p class="muted">${h.note}</p>` : ''}
              ${h.recorded_at.getTime() - h.effective_at.getTime() > 60_000 ? html`<p class="muted small">Recorded ${ts(h.recorded_at)}</p>` : ''}</li>`
            )}</ol>`
          : html`<p class="muted">No status changes recorded.</p>`
      }
    </section>
    <section class="card">
      <div class="card-head"><h2>Recent attendance</h2><a class="small" href="/attendance${qs({ employee: e.web_reference_id })}">View all</a></div>
      ${
        opts.recent.length
          ? html`<ul class="list">${opts.recent.map(
              (a) => html`<li><span class="badge badge-dir-${a.direction}">${a.direction === 'in' ? 'IN' : 'OUT'}</span>
              <span class="mono small">${formatWithOffset(a.captured_at, a.timezone_offset_minutes)}</span>
              <span class="muted small">${a.location_name ?? a.location_ref ?? ''}</span></li>`
            )}</ul>`
          : html`<p class="muted">No attendance received from BAMP yet.</p>`
      }
    </section>
  </aside>
</div>`;
  return page({ title: e.full_name, active: 'employees', session: opts.session, flash: opts.flash, body });
}

// ───────────────────────────── locations ─────────────────────────────

export function locationsPage(opts: { session: AdminSession; flash: Flash | null; rows: LocationRow[] }) {
  const body = html`${pageHeader(
    'Locations',
    'Branches and sites. BAMP maps each location reference to a branch and its devices.',
    html`<a class="btn btn-primary" href="/locations/new">New location</a>`
  )}
${
  opts.rows.length
    ? html`<div class="card table-card"><div class="table-wrap"><table class="table">
<thead><tr><th>Reference</th><th>Name</th><th>Address</th><th>Time zone</th><th class="num">Employees</th><th class="num">Active</th><th>Last modified</th><th></th></tr></thead>
<tbody>${opts.rows.map(
        (l) => html`<tr>
  <td data-label="Reference" class="mono">${l.ref}</td>
  <td data-label="Name"><a href="/locations/${encodeURIComponent(l.ref)}/edit">${l.name}</a></td>
  <td data-label="Address">${l.address ?? html`<span class="muted">—</span>`}</td>
  <td data-label="Time zone">${l.timezone ?? html`<span class="muted">—</span>`}</td>
  <td data-label="Employees" class="num"><a href="/employees${qs({ location: l.ref })}">${l.employee_count ?? 0}</a></td>
  <td data-label="Active" class="num">${l.active_count ?? 0}</td>
  <td data-label="Last modified">${ts(l.updated_at)}</td>
  <td class="row-actions"><a class="btn btn-sm btn-ghost" href="/locations/${encodeURIComponent(l.ref)}/edit">Edit</a></td>
</tr>`
      )}</tbody></table></div></div>`
    : emptyState('No locations yet', 'Create the branches and sites where employees work.', html`<a class="btn btn-primary" href="/locations/new">New location</a>`)
}`;
  return page({ title: 'Locations', active: 'locations', session: opts.session, flash: opts.flash, body });
}

export function locationFormPage(opts: {
  session: AdminSession;
  mode: 'create' | 'edit';
  values: Values;
  errors: Errors;
  timeZones: string[];
  location?: LocationRow;
}) {
  const edit = opts.mode === 'edit';
  const action = edit ? `/locations/${encodeURIComponent(opts.location!.ref)}` : '/locations';
  const body = html`${pageHeader(
    edit ? `Edit ${opts.location!.name}` : 'New location',
    edit ? html`Reference <span class="mono">${opts.location!.ref}</span> cannot be changed — BAMP location mappings use it.` : 'The reference is permanent: BAMP uses it to map this location to a branch.'
  )}
<form class="card form narrow" method="post" action="${action}" novalidate>
  ${csrfField(opts.session)}
  ${
    edit
      ? ''
      : html`<label class="field"><span>Reference <em class="req">required</em></span>
    <input name="ref" value="${opts.values.ref ?? ''}" required maxlength="32" placeholder="e.g. LAG-HQ" autocomplete="off"${invalid(opts.errors, 'ref')}>
    <small class="hint">Letters, digits, dot, dash or underscore (max 32).</small>${fieldError(opts.errors, 'ref')}</label>`
  }
  <label class="field"><span>Name <em class="req">required</em></span>
    <input name="name" value="${opts.values.name ?? ''}" required maxlength="120"${invalid(opts.errors, 'name')}>${fieldError(opts.errors, 'name')}</label>
  <label class="field"><span>Address</span>
    <textarea name="address" rows="3" maxlength="500"${invalid(opts.errors, 'address')}>${opts.values.address ?? ''}</textarea>${fieldError(opts.errors, 'address')}</label>
  <label class="field"><span>Time zone</span>
    <input name="timezone" value="${opts.values.timezone ?? ''}" list="timezones" maxlength="64" placeholder="e.g. Africa/Lagos" autocomplete="off"${invalid(opts.errors, 'timezone')}>
    <datalist id="timezones">${opts.timeZones.map((z) => html`<option value="${z}">`)}</datalist>
    <small class="hint">IANA time zone name of the site.</small>${fieldError(opts.errors, 'timezone')}</label>
  <div class="form-actions"><button class="btn btn-primary" type="submit">${edit ? 'Save changes' : 'Create location'}</button><a class="btn btn-ghost" href="/locations">Cancel</a></div>
</form>`;
  return page({ title: edit ? 'Edit location' : 'New location', active: 'locations', session: opts.session, body });
}

// ───────────────────────────── attendance ─────────────────────────────

export function attendancePage(opts: {
  session: AdminSession;
  rows: AttendanceRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: Record<string, string>;
  locations: LocationRow[];
  stats: { total: number; last_24h: number; last_received: Date | null };
}) {
  const f = opts.filter;
  const filtered = Object.values(f).some(Boolean);
  const body = html`${pageHeader('Attendance received', 'Clock-in / clock-out records delivered by BAMP through the API or scheduled-export imports.')}
<div class="stats">
  <div class="stat"><span class="stat-value">${opts.stats.total.toLocaleString('en')}</span><span class="stat-label">Records</span></div>
  <div class="stat"><span class="stat-value">${opts.stats.last_24h.toLocaleString('en')}</span><span class="stat-label">Last 24 hours</span></div>
  <div class="stat"><span class="stat-value small-value">${ts(opts.stats.last_received, 'Never')}</span><span class="stat-label">Last received</span></div>
</div>
<form class="filters card" method="get" action="/attendance" role="search">
  ${f.employee ? html`<input type="hidden" name="employee" value="${f.employee}">` : ''}
  <label class="field grow"><span>Search</span><input type="search" name="q" value="${f.q ?? ''}" placeholder="Employee, staff no., event or device ID" maxlength="100"></label>
  <label class="field"><span>Location</span><select name="location">
    <option value="">All</option><option value="__none"${selected(f.location, '__none')}>None</option>
    ${opts.locations.map((l) => html`<option value="${l.ref}"${selected(f.location, l.ref)}>${l.name}</option>`)}
  </select></label>
  <label class="field"><span>Direction</span><select name="direction"><option value="">Both</option>
    <option value="in"${selected(f.direction, 'in')}>In</option><option value="out"${selected(f.direction, 'out')}>Out</option></select></label>
  <label class="field"><span>Channel</span><select name="source"><option value="">Any</option>
    <option value="api"${selected(f.source, 'api')}>API</option><option value="import"${selected(f.source, 'import')}>Import</option></select></label>
  <label class="field"><span>From (local date)</span><input type="date" name="from" value="${f.from ?? ''}"></label>
  <label class="field"><span>To (local date)</span><input type="date" name="to" value="${f.to ?? ''}"></label>
  <div class="filter-actions"><button class="btn btn-secondary" type="submit">Apply</button>${filtered ? html`<a class="btn btn-ghost" href="/attendance">Reset</a>` : ''}</div>
</form>
${f.employee ? html`<p class="chip-row">Employee <span class="chip mono">${f.employee}</span> <a href="/attendance${qs({ ...f, employee: '' })}">remove</a></p>` : ''}
${
  opts.rows.length
    ? html`<div class="card table-card"><div class="table-wrap"><table class="table">
<thead><tr><th>Captured (site local)</th><th>Dir.</th><th>Employee</th><th>Location</th><th class="num">Match</th><th>Device</th><th>Channel</th><th>Received</th><th>Event ID</th></tr></thead>
<tbody>${opts.rows.map(
        (a) => html`<tr>
  <td data-label="Captured" class="mono nowrap">${formatWithOffset(a.captured_at, a.timezone_offset_minutes)}</td>
  <td data-label="Direction"><span class="badge badge-dir-${a.direction}">${a.direction === 'in' ? 'IN' : 'OUT'}</span></td>
  <td data-label="Employee"><a href="/employees/${encodeURIComponent(a.web_reference_id)}">${a.full_name ?? a.web_reference_id}</a>
    <div class="muted small mono">${a.web_reference_id} · ${a.staff_number}</div></td>
  <td data-label="Location">${a.location_ref ? html`${a.location_name ?? a.location_ref}` : html`<span class="muted">—</span>`}</td>
  <td data-label="Match" class="num">${a.match_score}</td>
  <td data-label="Device" class="mono small">${a.device_id}</td>
  <td data-label="Channel">${a.source === 'api' ? 'API' : a.import_file_id ? html`<a href="/imports/${a.import_file_id}">Import #${a.import_file_id}</a>` : 'Import'}</td>
  <td data-label="Received">${ts(a.received_at)}</td>
  <td data-label="Event ID" class="mono small break">${a.event_id}</td>
</tr>`
      )}</tbody></table></div>
${pager(opts.page, opts.pageSize, opts.total, '/attendance', f)}</div>`
    : filtered
      ? emptyState('No matching attendance', 'No records match these filters.')
      : emptyState('No attendance received yet', 'Records appear here once BAMP delivers clock-ins and clock-outs. See the Integration page to connect BAMP.', html`<a class="btn btn-secondary" href="/integration">Integration settings</a>`)
}`;
  return page({ title: 'Attendance received', active: 'attendance', session: opts.session, body });
}

// ───────────────────────────── imports ─────────────────────────────

export function importsPage(opts: { session: AdminSession; flash: Flash | null; rows: ImportRow[]; total: number; page: number; pageSize: number }) {
  const body = html`${pageHeader(
    'Imports',
    'Scheduled attendance exports from BAMP (fallback when API delivery is not used), received at the import endpoint or uploaded here.'
  )}
<form class="card form upload" method="post" action="/imports" enctype="multipart/form-data">
  ${csrfField(opts.session)}
  <div class="upload-row">
    <label class="field grow"><span>Upload an export file (.csv or .xlsx)</span>
      <input type="file" name="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
    <button class="btn btn-primary" type="submit">Import</button>
  </div>
  <p class="hint">Expected columns: <span class="mono">${IMPORT_COLUMNS.join(', ')}</span>. Rows already recorded (same EventId) are skipped as duplicates.</p>
</form>
${
  opts.rows.length
    ? html`<div class="card table-card"><div class="table-wrap"><table class="table">
<thead><tr><th>#</th><th>File</th><th>Received</th><th>Channel</th><th class="num">Rows</th><th class="num">Accepted</th><th class="num">Duplicates</th><th class="num">Rejected</th></tr></thead>
<tbody>${opts.rows.map(
        (r) => html`<tr>
  <td data-label="#"><a href="/imports/${r.id}">${r.id}</a></td>
  <td data-label="File" class="break"><a href="/imports/${r.id}">${r.file_name}</a> <span class="muted small">${r.format.toUpperCase()} · ${formatBytes(r.size_bytes)}</span></td>
  <td data-label="Received">${ts(r.received_at)}</td>
  <td data-label="Channel">${r.channel === 'api' ? 'Import endpoint' : 'Manual upload'}</td>
  <td data-label="Rows" class="num">${r.rows}</td>
  <td data-label="Accepted" class="num">${r.accepted}</td>
  <td data-label="Duplicates" class="num">${r.duplicates}</td>
  <td data-label="Rejected" class="num">${r.rejected ? html`<span class="text-danger">${r.rejected}</span>` : 0}</td>
</tr>`
      )}</tbody></table></div>
${pager(opts.page, opts.pageSize, opts.total, '/imports', {})}</div>`
    : emptyState('No imports yet', html`When BAMP delivers by scheduled export, point its export endpoint at <span class="mono">${config.PUBLIC_URL}/api/v1/attendance/import</span>.`)
}`;
  return page({ title: 'Imports', active: 'imports', session: opts.session, flash: opts.flash, body });
}

export function importDetailPage(opts: { session: AdminSession; flash: Flash | null; row: ImportRow }) {
  const r = opts.row;
  const fileErrors = r.errors.filter((e) => e.row === 0);
  const rowErrors = r.errors.filter((e) => e.row > 0);
  const body = html`${pageHeader(`Import #${r.id}`, html`<span class="break">${r.file_name}</span>`, html`<a class="btn btn-ghost" href="/imports">← All imports</a>`)}
<div class="stats">
  <div class="stat"><span class="stat-value">${r.rows}</span><span class="stat-label">Rows</span></div>
  <div class="stat"><span class="stat-value">${r.accepted}</span><span class="stat-label">Accepted</span></div>
  <div class="stat"><span class="stat-value">${r.duplicates}</span><span class="stat-label">Duplicates</span></div>
  <div class="stat"><span class="stat-value${r.rejected ? ' text-danger' : ''}">${r.rejected}</span><span class="stat-label">Rejected</span></div>
</div>
<section class="card">
  <dl class="kv kv-inline">
    <dt>Received</dt><dd>${ts(r.received_at)}</dd>
    <dt>Format</dt><dd>${r.format.toUpperCase()} · ${formatBytes(r.size_bytes)}</dd>
    <dt>Channel</dt><dd>${r.channel === 'api' ? 'Import endpoint (API)' : 'Manual upload'}</dd>
  </dl>
  ${fileErrors.map((e) => html`<div class="flash flash-error">${e.error}</div>`)}
  ${r.accepted ? html`<p><a href="/attendance${qs({ source: 'import' })}">View imported attendance</a></p>` : ''}
</section>
${
  rowErrors.length
    ? html`<div class="card table-card"><h2 class="card-title">Rejected rows</h2><div class="table-wrap"><table class="table">
<thead><tr><th class="num">Row</th><th>Event ID</th><th>Reason</th></tr></thead>
<tbody>${rowErrors.map((e) => html`<tr><td data-label="Row" class="num">${e.row}</td><td data-label="Event ID" class="mono small break">${e.eventId ?? '—'}</td><td data-label="Reason">${e.error}</td></tr>`)}</tbody>
</table></div></div>`
    : ''
}`;
  return page({ title: `Import #${r.id}`, active: 'imports', session: opts.session, flash: opts.flash, body });
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ───────────────────────────── API activity ─────────────────────────────

const statusClass = (s: number) => (s < 300 ? 'ok' : s === 409 ? 'dup' : s < 500 ? 'warn' : 'err');

export function activityPage(opts: {
  session: AdminSession;
  rows: ApiLogRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: { outcome: string; path: string };
}) {
  const f = opts.filter;
  const body = html`${pageHeader('API activity', `Integration API calls received (kept for ${config.API_LOG_RETENTION_DAYS} days).`)}
<form class="filters card" method="get" action="/activity">
  <label class="field grow"><span>Path contains</span><input type="search" name="path" value="${f.path}" placeholder="/api/v1/attendance" maxlength="100"></label>
  <label class="field"><span>Outcome</span><select name="outcome">
    <option value="">All</option>
    <option value="2xx"${selected(f.outcome, '2xx')}>Success (2xx)</option>
    <option value="409"${selected(f.outcome, '409')}>Duplicate (409)</option>
    <option value="4xx"${selected(f.outcome, '4xx')}>Client errors (4xx)</option>
    <option value="5xx"${selected(f.outcome, '5xx')}>Server errors (5xx)</option>
  </select></label>
  <div class="filter-actions"><button class="btn btn-secondary" type="submit">Apply</button>${f.outcome || f.path ? html`<a class="btn btn-ghost" href="/activity">Reset</a>` : ''}</div>
</form>
${
  opts.rows.length
    ? html`<div class="card table-card"><div class="table-wrap"><table class="table">
<thead><tr><th>Time</th><th>Method</th><th>Path</th><th class="num">Status</th><th class="num">Duration</th><th>Client</th><th>Detail</th></tr></thead>
<tbody>${opts.rows.map(
        (r) => html`<tr>
  <td data-label="Time" class="nowrap">${ts(r.at)}</td>
  <td data-label="Method" class="mono">${r.method}</td>
  <td data-label="Path" class="mono small break">${r.path}</td>
  <td data-label="Status" class="num"><span class="http http-${statusClass(r.status)}">${r.status}</span></td>
  <td data-label="Duration" class="num">${r.duration_ms} ms</td>
  <td data-label="Client" class="mono small">${r.remote_addr ?? '—'}</td>
  <td data-label="Detail" class="small break">${r.detail ?? ''}</td>
</tr>`
      )}</tbody></table></div>
${pager(opts.page, opts.pageSize, opts.total, '/activity', f)}</div>`
    : emptyState('No API activity', 'Calls from BAMP appear here as they arrive.')
}`;
  return page({ title: 'API activity', active: 'activity', session: opts.session, body });
}

// ───────────────────────────── integration ─────────────────────────────

export function integrationPage(opts: {
  session: AdminSession;
  summary: { endpoint: string; calls: number; ok: number; client_errors: number; server_errors: number; last_at: Date | null }[];
}) {
  const base = config.PUBLIC_URL;
  const endpoints: [string, string, string][] = [
    ['GET', '/api/v1/employees', 'Employees, paginated: ?modifiedSince=ISO-8601&page=N&pageSize=M (max 1000) → { data, page, pageSize, total, hasMore }'],
    ['GET', '/api/v1/locations', 'Locations → { data: [{ ref, name, address, timezone }] }'],
    ['POST', '/api/v1/attendance', 'One attendance event (JSON, Idempotency-Key header) → 201 recorded · 409 already recorded · 422 refused · 400 invalid'],
    ['POST', '/api/v1/attendance/import', 'Scheduled-export file (multipart field "file", CSV or XLSX) → 200 with per-row summary · 422 unreadable file'],
    ['GET', '/api/v1/health', 'Liveness and database check (no authentication)']
  ];
  const masked = maskSecret(config.API_KEY);
  const body = html`${pageHeader('Integration', 'How BAMP connects to this HR system.')}
<div class="layout-2">
  <div class="stack">
    <section class="card">
      <h2>Connection</h2>
      <dl class="kv">
        <dt>Base URL</dt><dd><code class="copyable">${base}</code> <button type="button" class="btn btn-sm btn-ghost" data-copy="${base}">Copy</button></dd>
        <dt>API key</dt><dd><code data-secret-target>${masked}</code>
          <button type="button" class="btn btn-sm btn-ghost" data-reveal data-masked="${masked}" data-csrf="${opts.session.csrfToken}">Reveal</button>
          <button type="button" class="btn btn-sm btn-ghost" data-copy-secret hidden>Copy</button></dd>
        <dt>Authentication</dt><dd><code>Authorization: Bearer &lt;API key&gt;</code></dd>
        <dt>Transport</dt><dd>HTTPS only (TLS 1.2+)</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Endpoints</h2>
      <div class="table-wrap"><table class="table compact">
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>${endpoints.map(([m, p, d]) => html`<tr><td class="mono">${m}</td><td class="mono nowrap">${p}</td><td>${d}</td></tr>`)}</tbody>
      </table></div>
    </section>
    <section class="card prose">
      <h2>Configure BAMP</h2>
      <ol>
        <li>In BAMP, open <strong>Settings → Integration</strong>.</li>
        <li>Set <strong>Base URL</strong> to <code>${base}</code> and paste the <strong>API key</strong> shown above.</li>
        <li>Keep the default paths: employees <code>/api/v1/employees</code>, locations <code>/api/v1/locations</code>, attendance <code>/api/v1/attendance</code>.</li>
        <li>Choose <strong>Delivery mode</strong>:
          <ul>
            <li><strong>API</strong> (recommended) — BAMP posts each event to <code>/api/v1/attendance</code>.</li>
            <li><strong>Scheduled export</strong> — set <em>Export endpoint URL</em> to <code>${base}/api/v1/attendance/import</code> and
              <em>Export endpoint auth header</em> to <code>Authorization: Bearer &lt;API key&gt;</code>.</li>
          </ul></li>
        <li>Use <strong>Test connection</strong>, then <strong>Sync now</strong>. In BAMP, map each location reference to a branch.</li>
      </ol>
      <p class="muted">BAMP's server must trust this service's TLS certificate (the local development CA created by <code>scripts/setup-local.mjs</code>).</p>
    </section>
  </div>
  <aside class="stack">
    <section class="card">
      <h2>Last 24 hours</h2>
      ${
        opts.summary.length
          ? html`<table class="table compact"><thead><tr><th>Endpoint</th><th class="num">Calls</th><th class="num">OK</th><th class="num">4xx</th><th class="num">5xx</th></tr></thead>
<tbody>${opts.summary.map(
              (s) => html`<tr><td class="mono small">${s.endpoint}</td><td class="num">${s.calls}</td><td class="num">${s.ok}</td><td class="num">${s.client_errors}</td><td class="num">${s.server_errors}</td></tr>`
            )}</tbody></table>
<p class="small muted">Last call ${ts(opts.summary.reduce<Date | null>((a, s) => (s.last_at && (!a || s.last_at > a) ? s.last_at : a), null))}</p>
<p><a href="/activity">Open API activity log</a></p>`
          : html`<p class="muted">BAMP has not called the API in the last 24 hours.</p>`
      }
    </section>
    <section class="card">
      <h2>Quick check</h2>
      <p class="small muted">From a terminal on the BAMP server:</p>
      <pre class="code">curl -H "Authorization: Bearer $API_KEY" \\
  ${base}/api/v1/locations</pre>
    </section>
  </aside>
</div>`;
  return page({ title: 'Integration', active: 'integration', session: opts.session, body });
}
