import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, tx } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { renderExport, type Column } from '../lib/tabular.js';
import { parse } from '../lib/validate.js';
import { assertLocation, scopeSql, type Principal } from '../auth/rbac.js';
import { actorFromRequest, requirePerm } from '../auth/session.js';
import { audit } from '../services/audit.js';

const reportSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  department: z.string().max(100).optional()
});
type ReportFilter = z.infer<typeof reportSchema>;

/** Builds the expected-vs-actual fact CTE: one row per (active employee, scheduled workday). */
function factsCte(p: Principal, f: ReportFilter, params: unknown[]) {
  params.push(p.organizationId, f.from, f.to);
  let locWhere = `l.organization_id = $1`;
  locWhere += scopeSql(p, 'l.id', params);
  if (f.locationId) {
    params.push(f.locationId);
    locWhere += ` AND l.id = $${params.length}`;
  }
  let empWhere = `e.employment_status = 'active'`;
  if (f.employeeId) {
    params.push(f.employeeId);
    empWhere += ` AND e.id = $${params.length}`;
  }
  if (f.department) {
    params.push(f.department);
    empWhere += ` AND e.department = $${params.length}`;
  }
  return `
    WITH locs AS (SELECT l.id, l.name, l.code, l.timezone, l.workdays FROM locations l WHERE ${locWhere}),
    days AS (
      SELECT l.id AS location_id, d::date AS work_date
        FROM locs l, generate_series($2::date, LEAST($3::date, (now() AT TIME ZONE l.timezone)::date), interval '1 day') d
       WHERE EXTRACT(isodow FROM d)::int = ANY(l.workdays)),
    roster AS (
      SELECT e.id AS employee_id, e.location_id, e.full_name, e.staff_number, e.department
        FROM employees e JOIN locs ON locs.id = e.location_id WHERE ${empWhere}),
    facts AS (
      SELECT r.employee_id, r.location_id, r.full_name, r.staff_number, r.department, d.work_date,
             ad.first_in, ad.last_out, coalesce(ad.is_late,false) AS is_late, coalesce(ad.minutes_late,0) AS minutes_late,
             ad.worked_minutes, (ad.employee_id IS NOT NULL) AS present
        FROM roster r JOIN days d ON d.location_id = r.location_id
        LEFT JOIN attendance_daily ad ON ad.employee_id = r.employee_id AND ad.location_id = r.location_id AND ad.work_date = d.work_date)`;
}

async function buildReport(p: Principal, f: ReportFilter) {
  if (f.from > f.to) throw badRequest('"from" must be before "to"');
  const days = (Date.parse(f.to) - Date.parse(f.from)) / 86400000;
  if (days > 400) throw badRequest('Date range is limited to 13 months');
  if (f.locationId) assertLocation(p, f.locationId);
  const run = async (select: string) => {
    const params: unknown[] = [];
    const cte = factsCte(p, f, params);
    return many(`${cte} ${select}`, params);
  };
  const [daily, weekly, monthly, employees, locations, late, absences, summary] = await Promise.all([
    run(`SELECT work_date AS period, count(*)::int AS expected, count(*) FILTER (WHERE present)::int AS present,
                count(*) FILTER (WHERE is_late)::int AS late, count(*) FILTER (WHERE NOT present)::int AS absent,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate
           FROM facts GROUP BY work_date ORDER BY work_date`),
    run(`SELECT to_char(date_trunc('week', work_date), 'YYYY-MM-DD') AS period, count(*)::int AS expected,
                count(*) FILTER (WHERE present)::int AS present, count(*) FILTER (WHERE is_late)::int AS late,
                count(*) FILTER (WHERE NOT present)::int AS absent,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate
           FROM facts GROUP BY 1 ORDER BY 1`),
    run(`SELECT to_char(date_trunc('month', work_date), 'YYYY-MM') AS period, count(*)::int AS expected,
                count(*) FILTER (WHERE present)::int AS present, count(*) FILTER (WHERE is_late)::int AS late,
                count(*) FILTER (WHERE NOT present)::int AS absent,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate
           FROM facts GROUP BY 1 ORDER BY 1`),
    run(`SELECT f.employee_id, f.full_name, f.staff_number, f.department, l.name AS location_name,
                count(*)::int AS scheduled_days, count(*) FILTER (WHERE present)::int AS days_present,
                count(*) FILTER (WHERE NOT present)::int AS days_absent, count(*) FILTER (WHERE is_late)::int AS late_days,
                coalesce(sum(minutes_late),0)::int AS total_minutes_late,
                round(coalesce(sum(worked_minutes),0) / 60.0, 1) AS hours_worked,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate
           FROM facts f JOIN locs l ON l.id=f.location_id
          GROUP BY f.employee_id, f.full_name, f.staff_number, f.department, l.name ORDER BY attendance_rate ASC, f.full_name`),
    run(`SELECT l.id AS location_id, l.name AS location_name, l.code, count(DISTINCT f.employee_id)::int AS employees,
                count(*)::int AS expected, count(*) FILTER (WHERE present)::int AS present,
                count(*) FILTER (WHERE is_late)::int AS late, count(*) FILTER (WHERE NOT present)::int AS absent,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate,
                round(100.0 * count(*) FILTER (WHERE is_late) / NULLIF(count(*) FILTER (WHERE present),0), 1) AS late_rate
           FROM facts f JOIN locs l ON l.id=f.location_id GROUP BY l.id, l.name, l.code ORDER BY l.name`),
    run(`SELECT f.work_date, f.employee_id, f.full_name, f.staff_number, f.department, f.location_id, l.name AS location_name, l.timezone AS location_timezone,
                f.first_in, to_char(f.first_in AT TIME ZONE l.timezone, 'HH24:MI:SS') AS first_in_local, f.minutes_late
           FROM facts f JOIN locs l ON l.id=f.location_id WHERE f.is_late ORDER BY f.work_date DESC, f.minutes_late DESC LIMIT 5000`),
    run(`SELECT f.work_date, f.employee_id, f.full_name, f.staff_number, f.department, f.location_id, l.name AS location_name
           FROM facts f JOIN locs l ON l.id=f.location_id WHERE NOT f.present ORDER BY f.work_date DESC, f.full_name LIMIT 5000`),
    run(`SELECT count(*)::int AS expected, count(*) FILTER (WHERE present)::int AS present, count(*) FILTER (WHERE is_late)::int AS late,
                count(*) FILTER (WHERE NOT present)::int AS absent, count(DISTINCT employee_id)::int AS employees,
                round(100.0 * count(*) FILTER (WHERE present) / NULLIF(count(*),0), 1) AS attendance_rate,
                round(avg(minutes_late) FILTER (WHERE is_late), 1) AS avg_minutes_late
           FROM facts`)
  ]);
  // Trend: 7-day moving average of the attendance rate.
  const trend = daily.map((d, i) => {
    const win = daily.slice(Math.max(0, i - 6), i + 1);
    const exp = win.reduce((a, x) => a + x.expected, 0);
    const pres = win.reduce((a, x) => a + x.present, 0);
    return { period: d.period, attendance_rate: d.attendance_rate, moving_avg_7d: exp ? Math.round((1000 * pres) / exp) / 10 : null };
  });
  const departments = (
    await many(
      `SELECT DISTINCT department FROM employees WHERE organization_id=$1 AND department IS NOT NULL ORDER BY department`,
      [p.organizationId]
    )
  ).map((d) => d.department);
  return { filters: f, summary: summary[0], daily, weekly, monthly, employees, locations, late, absences, trend, departments };
}

const VIEW_COLUMNS: Record<string, Column[]> = {
  daily: [
    { key: 'period', header: 'Date', width: 12 },
    { key: 'expected', header: 'Expected', width: 9 },
    { key: 'present', header: 'Present', width: 9 },
    { key: 'late', header: 'Late', width: 9 },
    { key: 'absent', header: 'Absent', width: 9 },
    { key: 'attendance_rate', header: 'Attendance %', width: 10 }
  ],
  employees: [
    { key: 'full_name', header: 'Employee', width: 22 },
    { key: 'staff_number', header: 'Staff number', width: 12 },
    { key: 'department', header: 'Department', width: 14 },
    { key: 'location_name', header: 'Location', width: 16 },
    { key: 'scheduled_days', header: 'Scheduled', width: 9 },
    { key: 'days_present', header: 'Present', width: 8 },
    { key: 'days_absent', header: 'Absent', width: 8 },
    { key: 'late_days', header: 'Late', width: 7 },
    { key: 'hours_worked', header: 'Hours', width: 8 },
    { key: 'attendance_rate', header: 'Attendance %', width: 10 }
  ],
  locations: [
    { key: 'location_name', header: 'Location', width: 20 },
    { key: 'employees', header: 'Employees', width: 9 },
    { key: 'expected', header: 'Expected', width: 9 },
    { key: 'present', header: 'Present', width: 9 },
    { key: 'late', header: 'Late', width: 8 },
    { key: 'absent', header: 'Absent', width: 8 },
    { key: 'attendance_rate', header: 'Attendance %', width: 10 },
    { key: 'late_rate', header: 'Late %', width: 8 }
  ],
  late: [
    { key: 'work_date', header: 'Date', width: 12 },
    { key: 'full_name', header: 'Employee', width: 22 },
    { key: 'staff_number', header: 'Staff number', width: 12 },
    { key: 'location_name', header: 'Location', width: 16 },
    { key: 'first_in_local', header: 'First in (local)', width: 12 },
    { key: 'minutes_late', header: 'Minutes late', width: 9 }
  ],
  absences: [
    { key: 'work_date', header: 'Date', width: 12 },
    { key: 'full_name', header: 'Employee', width: 22 },
    { key: 'staff_number', header: 'Staff number', width: 12 },
    { key: 'department', header: 'Department', width: 14 },
    { key: 'location_name', header: 'Location', width: 16 }
  ]
};
VIEW_COLUMNS.weekly = [{ key: 'period', header: 'Week starting', width: 12 }, ...VIEW_COLUMNS.daily.slice(1)];
VIEW_COLUMNS.monthly = [{ key: 'period', header: 'Month', width: 12 }, ...VIEW_COLUMNS.daily.slice(1)];
VIEW_COLUMNS.trend = [
  { key: 'period', header: 'Date', width: 12 },
  { key: 'attendance_rate', header: 'Attendance %', width: 10 },
  { key: 'moving_avg_7d', header: '7-day avg %', width: 10 }
];

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports/analytics', { preHandler: requirePerm('reports.view') }, async (req) => {
    const f = parse(reportSchema, req.query);
    return buildReport(req.principal!, f);
  });

  app.get('/api/reports/export', { preHandler: requirePerm('attendance.export') }, async (req, reply) => {
    const q = req.query as any;
    const f = parse(reportSchema, q);
    const view = parse(z.enum(['daily', 'weekly', 'monthly', 'employees', 'locations', 'late', 'absences', 'trend']), q.view);
    const format = parse(z.enum(['csv', 'xlsx', 'pdf']), q.format ?? 'csv');
    const report: any = await buildReport(req.principal!, f);
    const titles: Record<string, string> = {
      daily: 'Daily attendance',
      weekly: 'Weekly attendance',
      monthly: 'Monthly attendance',
      employees: 'Employee attendance',
      locations: 'Location attendance',
      late: 'Late arrivals',
      absences: 'Absences',
      trend: 'Attendance trend'
    };
    const out = await renderExport(format, titles[view], `Period ${f.from} → ${f.to}`, VIEW_COLUMNS[view], report[view]);
    await tx((db) => audit(db, actorFromRequest(req), { action: 'report.exported', objectType: 'report', objectLabel: titles[view], after: { view, format, filters: f } }));
    reply.header('content-type', out.contentType).header('content-disposition', `attachment; filename="${view}-${f.from}-${f.to}.${out.ext}"`);
    return out.body;
  });
}
