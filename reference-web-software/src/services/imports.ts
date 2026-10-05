import { pool } from '../db/pool.js';
import { detectFormat, normaliseHeader, parseTable, TableFormatError, unescapeFormulaGuard } from '../lib/tabular.js';
import { recordAttendance, webAttendanceSchema } from './attendance.js';

/**
 * Column layout of BAMP's scheduled export (backend/src/integration/scheduledExport.ts, EXPORT_COLUMNS).
 * FullName is informational only; every other column is required.
 */
const COLUMN_MAP = [
  ['EventId', 'eventId'],
  ['WebReferenceId', 'webReferenceId'],
  ['StaffNumber', 'staffNumber'],
  ['LocationRef', 'locationRef'],
  ['Direction', 'direction'],
  ['CapturedAt', 'capturedAt'],
  ['TzOffsetMinutes', 'timezoneOffsetMinutes'],
  ['MatchScore', 'matchScore'],
  ['DeviceId', 'deviceId']
] as const;
export const IMPORT_COLUMNS = ['EventId', 'WebReferenceId', 'StaffNumber', 'FullName', 'LocationRef', 'Direction', 'CapturedAt', 'TzOffsetMinutes', 'MatchScore', 'DeviceId'];

const MAX_STORED_ERRORS = 500;

export interface ImportError {
  row: number;
  eventId?: string;
  error: string;
}

export interface ImportSummary {
  id: number;
  fileName: string;
  format: 'csv' | 'xlsx' | 'unknown';
  rows: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  errors: ImportError[];
  errorsTruncated: boolean;
  fileError: string | null;
}

function toNumber(v: string): number | string {
  const t = v.trim();
  if (t === '' || !/^[+-]?\d+(\.0+)?$/.test(t)) return t;
  return Number(t);
}

function normaliseTimestamp(v: string): string {
  const t = v.trim();
  // Accept "YYYY-MM-DD HH:mm:ss±hh:mm" as well as the ISO "T" separator.
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t) ? t.replace(' ', 'T') : t;
}

/**
 * Imports one attendance file (CSV or XLSX in the BAMP export layout). Every row is validated and stored
 * independently, so one bad row never blocks the rest. A summary row is always written to import_files.
 */
export async function importAttendanceFile(input: {
  fileName: string;
  mimeType: string;
  body: Buffer;
  channel: 'api' | 'admin';
}): Promise<ImportSummary> {
  const fileName = input.fileName.slice(0, 255) || 'upload';
  const format = detectFormat(input.body, fileName, input.mimeType);
  const fileRow = (
    await pool.query<{ id: number }>(
      `INSERT INTO import_files (file_name, format, size_bytes, channel) VALUES ($1,$2,$3,$4) RETURNING id`,
      [fileName, format ?? 'unknown', input.body.length, input.channel]
    )
  ).rows[0]!;

  const summary: ImportSummary = {
    id: fileRow.id,
    fileName,
    format: format ?? 'unknown',
    rows: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    errors: [],
    errorsTruncated: false,
    fileError: null
  };
  const addError = (e: ImportError) => {
    if (summary.errors.length < MAX_STORED_ERRORS) summary.errors.push(e);
    else summary.errorsTruncated = true;
  };

  try {
    if (!format) throw new TableFormatError('Unsupported file type: upload a .csv or .xlsx file in the BAMP export layout');
    const table = await parseTable(input.body, format);
    const present = new Set(table.headers.map(normaliseHeader));
    const missing = COLUMN_MAP.map(([h]) => h).filter((h) => !present.has(h.toLowerCase()));
    if (missing.length) throw new TableFormatError(`Missing required column(s): ${missing.join(', ')}`);

    const client = await pool.connect();
    try {
      for (const { line, values } of table.rows) {
        summary.rows++;
        const raw: Record<string, unknown> = {};
        for (const [header, field] of COLUMN_MAP) {
          const v = unescapeFormulaGuard(values[header.toLowerCase()] ?? '');
          if (field === 'timezoneOffsetMinutes' || field === 'matchScore') raw[field] = toNumber(v);
          else if (field === 'locationRef') raw[field] = v.trim() === '' ? null : v.trim();
          else if (field === 'direction') raw[field] = v.trim().toLowerCase();
          else if (field === 'capturedAt') raw[field] = normaliseTimestamp(v);
          else raw[field] = v.trim();
        }
        const eventId = typeof raw.eventId === 'string' && raw.eventId ? raw.eventId : undefined;
        const parsed = webAttendanceSchema.safeParse(raw);
        if (!parsed.success) {
          summary.rejected++;
          addError({
            row: line,
            eventId,
            error: parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ')
          });
          continue;
        }
        try {
          const out = await recordAttendance(client, parsed.data, { source: 'import', importFileId: summary.id });
          if (out.kind === 'created') summary.accepted++;
          else if (out.kind === 'duplicate') summary.duplicates++;
          else {
            summary.rejected++;
            addError({ row: line, eventId, error: out.message });
          }
        } catch (err) {
          summary.rejected++;
          addError({ row: line, eventId, error: `Could not store row: ${(err as Error).message}` });
        }
      }
    } finally {
      client.release();
    }
  } catch (err) {
    if (!(err instanceof TableFormatError)) throw err;
    summary.fileError = err.message;
    addError({ row: 0, error: err.message });
  } finally {
    const stored = summary.errorsTruncated ? [...summary.errors, { row: 0, error: 'Further errors were not stored (limit reached)' }] : summary.errors;
    await pool.query(`UPDATE import_files SET rows=$2, accepted=$3, duplicates=$4, rejected=$5, errors=$6 WHERE id=$1`, [
      summary.id,
      summary.rows,
      summary.accepted,
      summary.duplicates,
      summary.rejected,
      JSON.stringify(stored)
    ]);
  }
  return summary;
}
