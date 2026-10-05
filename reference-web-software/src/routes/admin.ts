import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import {
  checkCredentials,
  createSession,
  destroySession,
  issueLoginCsrf,
  loadSession,
  verifyCsrf,
  verifyLoginCsrf
} from '../auth/session.js';
import { config } from '../config.js';
import { isValidTimeZone, timeZoneList, zonedLocalToUtc } from '../lib/time.js';
import {
  changeEmployeeStatus,
  createEmployee,
  departments,
  EMPLOYMENT_STATUSES,
  EmployeeError,
  employeeDetailFields,
  employeeFields,
  type EmploymentStatus,
  getEmployee,
  searchEmployees,
  statusCounts,
  statusHistory,
  updateEmployeeDetails
} from '../services/employees.js';
import { importAttendanceFile } from '../services/imports.js';
import { createLocation, getLocation, listLocations, LocationError, locationCreate, locationFields, updateLocation } from '../services/locations.js';
import { apiLogSummary, attendanceStats, getImport, listApiLog, listAttendance, listImports } from '../services/queries.js';
import type { Flash } from '../ui/layout.js';
import {
  activityPage,
  attendancePage,
  employeeCreatePage,
  employeeEditPage,
  employeesPage,
  errorPage,
  importDetailPage,
  importsPage,
  integrationPage,
  locationFormPage,
  locationsPage,
  loginPage
} from '../ui/views.js';

const FLASH_COOKIE = 'ws_flash';
const PUBLIC_ROUTES = new Set(['/login']);
const PAGE_SIZE = 50;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type Body = Record<string, unknown>;

class CsrfError extends Error {
  statusCode = 403;
}

// ───────────── helpers ─────────────

function field(body: unknown, name: string): string {
  const v = (body as Body | undefined)?.[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

function formValues(body: unknown, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, field(body, n)]));
}

function queryStr(req: FastifyRequest, name: string, max = 100): string {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function queryPage(req: FastifyRequest): number {
  const n = Number(queryStr(req, 'page', 10));
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
}

function zodErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = String(i.path[0] ?? 'form');
    out[k] ??= i.message;
  }
  return out;
}

function setFlash(reply: FastifyReply, kind: Flash['kind'], text: string) {
  reply.setCookie(FLASH_COOKIE, JSON.stringify({ kind, text }), {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
    maxAge: 60
  });
}

function takeFlash(req: FastifyRequest, reply: FastifyReply): Flash | null {
  const rawCookie = req.cookies[FLASH_COOKIE];
  if (!rawCookie) return null;
  reply.clearCookie(FLASH_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
  const u = req.unsignCookie(rawCookie);
  if (!u.valid || !u.value) return null;
  try {
    const f = JSON.parse(u.value) as Flash;
    return typeof f.text === 'string' && ['success', 'error', 'info'].includes(f.kind) ? f : null;
  } catch {
    return null;
  }
}

function sendHtml(reply: FastifyReply, body: string, status = 200) {
  return reply.code(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(body);
}

const safeNext = (n: string) => (n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/employees');

function requireSession(req: FastifyRequest) {
  if (!req.session) throw new Error('Session required');
  return req.session;
}

// ───────────── routes ─────────────

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    req.session = await loadSession(req);
    const route = req.routeOptions.url ?? '';
    if (PUBLIC_ROUTES.has(route)) return;
    if (!req.session) {
      if (req.method === 'GET') return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 303);
      if (req.headers.accept?.includes('application/json')) return reply.code(401).send({ error: 'Session expired; sign in again' });
      return reply.redirect('/login', 303);
    }
    // Form posts carry the per-session CSRF token; multipart uploads are checked while streaming the parts.
    if (req.method === 'POST' && !req.isMultipart()) {
      const token = field(req.body, '_csrf') || String(req.headers['x-csrf-token'] ?? '');
      if (!verifyCsrf(req, token)) throw new CsrfError('The form has expired or is invalid. Reload the page and try again.');
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'admin UI error');
    if (req.headers.accept?.includes('application/json') && !req.headers.accept.includes('text/html'))
      return reply.code(status).send({ error: status >= 500 ? 'Internal error' : err.message });
    const title = status === 403 ? 'Request refused' : status === 413 ? 'File too large' : status >= 500 ? 'Something went wrong' : 'Request error';
    const message =
      status === 413
        ? `Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can be imported.`
        : status >= 500
          ? 'An unexpected error occurred. The details were logged; please try again.'
          : err.message;
    return sendHtml(reply, errorPage(req.session ?? null, status, title, message), status);
  });

  // ── authentication ──
  app.get('/login', async (req, reply) => {
    if (req.session) return reply.redirect('/employees', 303);
    return sendHtml(reply, loginPage({ csrf: issueLoginCsrf(reply), next: queryStr(req, 'next', 300) }));
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const email = field(req.body, 'email').slice(0, 254);
    const password = field(req.body, 'password').slice(0, 512);
    const next = field(req.body, 'next').slice(0, 300);
    if (!verifyLoginCsrf(req, field(req.body, '_csrf')))
      return sendHtml(reply, loginPage({ csrf: issueLoginCsrf(reply), email, next, error: 'The sign-in form expired. Please try again.' }), 403);
    if (!email || !password || !(await checkCredentials(email, password))) {
      req.log.warn({ email, ip: req.ip }, 'failed HR admin sign-in');
      return sendHtml(reply, loginPage({ csrf: issueLoginCsrf(reply), email, next, error: 'Incorrect email or password.' }), 401);
    }
    await createSession(req, reply, config.ADMIN_EMAIL);
    return reply.redirect(safeNext(next), 303);
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.redirect('/login', 303);
  });

  app.get('/', async (_req, reply) => reply.redirect('/employees', 303));

  // ── employees ──
  app.get('/employees', async (req, reply) => {
    const session = requireSession(req);
    const filter = { q: queryStr(req, 'q'), location: queryStr(req, 'location', 64), status: queryStr(req, 'status', 20) };
    const pageNo = queryPage(req);
    const [{ rows, total }, locations, counts] = await Promise.all([
      searchEmployees({ ...filter, page: pageNo, pageSize: PAGE_SIZE }),
      listLocations(),
      statusCounts()
    ]);
    return sendHtml(
      reply,
      employeesPage({ session, flash: takeFlash(req, reply), rows, total, page: pageNo, pageSize: PAGE_SIZE, filter, locations, counts })
    );
  });

  app.get('/employees/new', async (req, reply) => {
    const session = requireSession(req);
    const [locations, depts] = await Promise.all([listLocations(), departments()]);
    const preset = queryStr(req, 'location', 64);
    return sendHtml(
      reply,
      employeeCreatePage({
        session,
        values: { employmentStatus: 'active', locationRef: preset },
        errors: {},
        locations,
        departments: depts,
        flash: takeFlash(req, reply)
      })
    );
  });

  app.post('/employees', async (req, reply) => {
    const session = requireSession(req);
    const values = formValues(req.body, ['staffNumber', 'fullName', 'department', 'locationRef', 'employmentStatus']);
    const parsed = employeeFields.safeParse(values);
    let errors: Record<string, string> = {};
    if (parsed.success) {
      try {
        const emp = await createEmployee(parsed.data);
        setFlash(reply, 'success', `Employee ${emp.full_name} created with reference ${emp.web_reference_id}.`);
        return reply.redirect(`/employees/${encodeURIComponent(emp.web_reference_id)}`, 303);
      } catch (err) {
        if (!(err instanceof EmployeeError)) throw err;
        errors = { [err.field ?? 'form']: err.message };
      }
    } else errors = zodErrors(parsed.error);
    const [locations, depts] = await Promise.all([listLocations(), departments()]);
    return sendHtml(
      reply,
      employeeCreatePage({
        session,
        values,
        errors,
        locations,
        departments: depts,
        flash: errors.form ? { kind: 'error', text: errors.form } : { kind: 'error', text: 'Please correct the highlighted fields.' }
      }),
      422
    );
  });

  async function renderEdit(
    req: FastifyRequest,
    reply: FastifyReply,
    ref: string,
    over: { values?: Record<string, string>; errors?: Record<string, string>; statusValues?: Record<string, string>; statusErrors?: Record<string, string>; flash?: Flash | null },
    status = 200
  ) {
    const session = requireSession(req);
    const employee = await getEmployee(ref);
    if (!employee) return sendHtml(reply, errorPage(session, 404, 'Employee not found', `No employee has reference ${ref}.`), 404);
    const [locations, depts, history, recent] = await Promise.all([
      listLocations(),
      departments(),
      statusHistory(ref),
      listAttendance({ employee: ref, page: 1, pageSize: 10 })
    ]);
    const tz = employee.location_timezone && isValidTimeZone(employee.location_timezone) ? employee.location_timezone : 'UTC';
    return sendHtml(
      reply,
      employeeEditPage({
        session,
        flash: over.flash !== undefined ? over.flash : takeFlash(req, reply),
        employee,
        values: over.values ?? {
          staffNumber: employee.staff_number,
          fullName: employee.full_name,
          department: employee.department ?? '',
          locationRef: employee.location_ref ?? ''
        },
        errors: over.errors ?? {},
        statusValues: over.statusValues ?? { status: employee.employment_status === 'active' ? 'terminated' : 'active' },
        statusErrors: over.statusErrors ?? {},
        locations,
        departments: depts,
        history,
        recent: recent.rows,
        statusTimeZone: tz
      }),
      status
    );
  }

  app.get<{ Params: { ref: string } }>('/employees/:ref', async (req, reply) => renderEdit(req, reply, req.params.ref, {}));

  app.post<{ Params: { ref: string } }>('/employees/:ref', async (req, reply) => {
    const ref = req.params.ref;
    const values = formValues(req.body, ['staffNumber', 'fullName', 'department', 'locationRef']);
    const parsed = employeeDetailFields.safeParse(values);
    if (!parsed.success)
      return renderEdit(req, reply, ref, { values, errors: zodErrors(parsed.error), flash: { kind: 'error', text: 'Please correct the highlighted fields.' } }, 422);
    try {
      const row = await updateEmployeeDetails(ref, parsed.data);
      if (!row) return sendHtml(reply, errorPage(requireSession(req), 404, 'Employee not found', `No employee has reference ${ref}.`), 404);
      setFlash(reply, 'success', 'Employee details saved.');
      return reply.redirect(`/employees/${encodeURIComponent(ref)}`, 303);
    } catch (err) {
      if (!(err instanceof EmployeeError)) throw err;
      return renderEdit(req, reply, ref, { values, errors: { [err.field ?? 'form']: err.message }, flash: { kind: 'error', text: err.message } }, 422);
    }
  });

  app.post<{ Params: { ref: string } }>('/employees/:ref/status', async (req, reply) => {
    const ref = req.params.ref;
    const statusValues = formValues(req.body, ['status', 'effectiveAt', 'note']);
    const employee = await getEmployee(ref);
    if (!employee) return sendHtml(reply, errorPage(requireSession(req), 404, 'Employee not found', `No employee has reference ${ref}.`), 404);
    const errors: Record<string, string> = {};
    const status = statusValues.status as EmploymentStatus;
    if (!(EMPLOYMENT_STATUSES as readonly string[]).includes(status)) errors.status = 'Choose a valid status';
    const tz = employee.location_timezone && isValidTimeZone(employee.location_timezone) ? employee.location_timezone : 'UTC';
    let effectiveAt: Date | null = null;
    if (statusValues.effectiveAt!.trim()) {
      effectiveAt = zonedLocalToUtc(statusValues.effectiveAt!, tz);
      if (!effectiveAt) errors.effectiveAt = 'Enter a valid date and time';
    }
    const note = statusValues.note!.trim();
    if (note.length > 500) errors.note = 'Must be at most 500 characters';
    if (!Object.keys(errors).length) {
      try {
        await changeEmployeeStatus(ref, status, effectiveAt, note || null);
        setFlash(
          reply,
          'success',
          status === 'terminated'
            ? `${employee.full_name} has been terminated. BAMP removes the employee from branch devices on its next sync.`
            : `Employment status changed to ${status}.`
        );
        return reply.redirect(`/employees/${encodeURIComponent(ref)}`, 303);
      } catch (err) {
        if (!(err instanceof EmployeeError)) throw err;
        errors[err.field ?? 'status'] = err.message;
      }
    }
    return renderEdit(req, reply, ref, { statusValues, statusErrors: errors, flash: { kind: 'error', text: 'The status was not changed.' } }, 422);
  });

  // ── locations ──
  app.get('/locations', async (req, reply) => {
    const session = requireSession(req);
    return sendHtml(reply, locationsPage({ session, flash: takeFlash(req, reply), rows: await listLocations() }));
  });

  app.get('/locations/new', async (req, reply) =>
    sendHtml(reply, locationFormPage({ session: requireSession(req), mode: 'create', values: {}, errors: {}, timeZones: timeZoneList() }))
  );

  app.post('/locations', async (req, reply) => {
    const session = requireSession(req);
    const values = formValues(req.body, ['ref', 'name', 'address', 'timezone']);
    const parsed = locationCreate.safeParse(values);
    let errors: Record<string, string>;
    if (parsed.success) {
      try {
        const loc = await createLocation(parsed.data);
        setFlash(reply, 'success', `Location ${loc.name} (${loc.ref}) created.`);
        return reply.redirect('/locations', 303);
      } catch (err) {
        if (!(err instanceof LocationError)) throw err;
        errors = { [err.field ?? 'ref']: err.message };
      }
    } else errors = zodErrors(parsed.error);
    return sendHtml(reply, locationFormPage({ session, mode: 'create', values, errors, timeZones: timeZoneList() }), 422);
  });

  app.get<{ Params: { ref: string } }>('/locations/:ref/edit', async (req, reply) => {
    const session = requireSession(req);
    const loc = await getLocation(req.params.ref);
    if (!loc) return sendHtml(reply, errorPage(session, 404, 'Location not found', `No location has reference ${req.params.ref}.`), 404);
    return sendHtml(
      reply,
      locationFormPage({
        session,
        mode: 'edit',
        location: loc,
        values: { name: loc.name, address: loc.address ?? '', timezone: loc.timezone ?? '' },
        errors: {},
        timeZones: timeZoneList()
      })
    );
  });

  app.post<{ Params: { ref: string } }>('/locations/:ref', async (req, reply) => {
    const session = requireSession(req);
    const loc = await getLocation(req.params.ref);
    if (!loc) return sendHtml(reply, errorPage(session, 404, 'Location not found', `No location has reference ${req.params.ref}.`), 404);
    const values = formValues(req.body, ['name', 'address', 'timezone']);
    const parsed = locationFields.safeParse(values);
    if (!parsed.success)
      return sendHtml(reply, locationFormPage({ session, mode: 'edit', location: loc, values, errors: zodErrors(parsed.error), timeZones: timeZoneList() }), 422);
    await updateLocation(loc.ref, parsed.data);
    setFlash(reply, 'success', `Location ${parsed.data.name} saved.`);
    return reply.redirect('/locations', 303);
  });

  // ── attendance ──
  app.get('/attendance', async (req, reply) => {
    const session = requireSession(req);
    const filter = {
      q: queryStr(req, 'q'),
      employee: queryStr(req, 'employee', 64),
      location: queryStr(req, 'location', 64),
      direction: queryStr(req, 'direction', 5),
      source: queryStr(req, 'source', 10),
      from: queryStr(req, 'from', 10),
      to: queryStr(req, 'to', 10)
    };
    const pageNo = queryPage(req);
    const [{ rows, total }, locations, stats] = await Promise.all([
      listAttendance({ ...filter, page: pageNo, pageSize: PAGE_SIZE }),
      listLocations(),
      attendanceStats()
    ]);
    return sendHtml(reply, attendancePage({ session, rows, total, page: pageNo, pageSize: PAGE_SIZE, filter, locations, stats }));
  });

  // ── imports ──
  app.get('/imports', async (req, reply) => {
    const session = requireSession(req);
    const pageNo = queryPage(req);
    const { rows, total } = await listImports(pageNo, PAGE_SIZE);
    return sendHtml(reply, importsPage({ session, flash: takeFlash(req, reply), rows, total, page: pageNo, pageSize: PAGE_SIZE }));
  });

  app.post('/imports', async (req, reply) => {
    requireSession(req);
    if (!req.isMultipart()) throw new CsrfError('Upload the file using the form on the Imports page.');
    let csrf = '';
    let upload: { fileName: string; mimeType: string; body: Buffer } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } })) {
      if (part.type === 'field') {
        if (part.fieldname === '_csrf' && typeof part.value === 'string') csrf = part.value;
        continue;
      }
      // The CSRF field precedes the file input in the form, so it is known before any file bytes are read.
      if (!verifyCsrf(req, csrf)) {
        part.file.resume();
        throw new CsrfError('The form has expired or is invalid. Reload the page and try again.');
      }
      const body = await part.toBuffer();
      if (part.fieldname === 'file' && part.filename) upload = { fileName: part.filename, mimeType: part.mimetype, body };
    }
    if (!verifyCsrf(req, csrf)) throw new CsrfError('The form has expired or is invalid. Reload the page and try again.');
    if (!upload || upload.body.length === 0) {
      setFlash(reply, 'error', 'Choose a non-empty .csv or .xlsx file to import.');
      return reply.redirect('/imports', 303);
    }
    const summary = await importAttendanceFile({ ...upload, channel: 'admin' });
    if (summary.fileError) setFlash(reply, 'error', `The file could not be imported: ${summary.fileError}`);
    else
      setFlash(
        reply,
        summary.rejected ? 'info' : 'success',
        `Imported ${summary.rows} row(s): ${summary.accepted} accepted, ${summary.duplicates} duplicate, ${summary.rejected} rejected.`
      );
    return reply.redirect(`/imports/${summary.id}`, 303);
  });

  app.get<{ Params: { id: string } }>('/imports/:id', async (req, reply) => {
    const session = requireSession(req);
    const id = Number(req.params.id);
    const row = Number.isSafeInteger(id) && id > 0 ? await getImport(id) : null;
    if (!row) return sendHtml(reply, errorPage(session, 404, 'Import not found', 'This import does not exist.'), 404);
    return sendHtml(reply, importDetailPage({ session, flash: takeFlash(req, reply), row }));
  });

  // ── API activity & integration ──
  app.get('/activity', async (req, reply) => {
    const session = requireSession(req);
    const filter = { outcome: queryStr(req, 'outcome', 5), path: queryStr(req, 'path') };
    const pageNo = queryPage(req);
    const { rows, total } = await listApiLog({ ...filter, page: pageNo, pageSize: PAGE_SIZE });
    return sendHtml(reply, activityPage({ session, rows, total, page: pageNo, pageSize: PAGE_SIZE, filter }));
  });

  app.get('/integration', async (req, reply) => {
    const session = requireSession(req);
    return sendHtml(reply, integrationPage({ session, summary: await apiLogSummary() }));
  });

  // Returns the API key to the signed-in administrator on explicit request (Reveal button), CSRF-protected.
  app.post('/integration/reveal-key', async (req, reply) => {
    req.log.info({ ip: req.ip }, 'API key revealed in admin UI');
    return reply.header('cache-control', 'no-store').send({ apiKey: config.API_KEY });
  });
};
