import ExcelJS from 'exceljs';

/** A parsed sheet: header names (as written) and rows keyed by normalised (lower-case) header. */
export interface Table {
  headers: string[];
  rows: { line: number; values: Record<string, string> }[];
}

export class TableFormatError extends Error {}

export const normaliseHeader = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase();

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, optional UTF-8 BOM). */
export function parseCsv(buf: Buffer): Table {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: { line: number; fields: string[] }[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
      sawAny = true;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      fields.push(field);
      if (sawAny || fields.some((f) => f !== '')) records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      sawAny = false;
      line++;
      recordLine = line;
    } else {
      field += c;
      sawAny = true;
    }
  }
  if (inQuotes) throw new TableFormatError(`Unterminated quoted field starting on line ${recordLine}`);
  if (sawAny || field !== '') {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  if (!records.length) throw new TableFormatError('The file is empty');
  const headers = records[0]!.fields.map((h) => h.trim());
  const keys = headers.map(normaliseHeader);
  const rows = records.slice(1).map((r) => {
    const values: Record<string, string> = {};
    keys.forEach((k, idx) => {
      if (k) values[k] = r.fields[idx] ?? '';
    });
    return { line: r.line, values };
  });
  return { headers, rows };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
    if ('error' in v) return '';
  }
  return String(v);
}

/** Reads the first worksheet of an XLSX workbook; row 1 is the header row. */
export async function parseXlsx(buf: Buffer): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new TableFormatError(`Not a readable XLSX workbook: ${(err as Error).message}`);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new TableFormatError('The workbook has no worksheets');
  const headerRow = ws.getRow(1);
  const width = headerRow.cellCount;
  if (!width) throw new TableFormatError('The first worksheet has no header row');
  const headers: string[] = [];
  for (let c = 1; c <= width; c++) headers.push(cellText(headerRow.getCell(c).value).trim());
  const keys = headers.map(normaliseHeader);
  const rows: Table['rows'] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    let any = false;
    keys.forEach((k, idx) => {
      if (!k) return;
      const t = cellText(row.getCell(idx + 1).value);
      if (t !== '') any = true;
      values[k] = t;
    });
    if (any) rows.push({ line: rowNumber, values });
  });
  return { headers, rows };
}

export type TableFormat = 'csv' | 'xlsx';

/** Detects the format from the ZIP magic number first, then the file name / MIME type. */
export function detectFormat(buf: Buffer, fileName: string, mimeType: string): TableFormat | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  const name = fileName.toLowerCase();
  if (name.endsWith('.xlsx') || mimeType.includes('spreadsheetml')) return null; // claims XLSX but is not a ZIP container
  if (name.endsWith('.csv') || mimeType.startsWith('text/') || mimeType === 'application/csv' || mimeType === 'application/vnd.ms-excel')
    return 'csv';
  // Unlabelled upload: accept it as CSV when the first line looks like the export header row.
  const firstLine = buf.subarray(0, 4096).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  if (/(^|,|")\s*eventid\s*("|,|$)/i.test(firstLine.replace(/^﻿/, ''))) return 'csv';
  return null;
}

export async function parseTable(buf: Buffer, format: TableFormat): Promise<Table> {
  return format === 'xlsx' ? parseXlsx(buf) : parseCsv(buf);
}

/**
 * BAMP's CSV writer prefixes values beginning with = + - @ TAB CR with an apostrophe to neutralise spreadsheet
 * formula injection (backend/src/lib/tabular.ts). Undo that so e.g. "'-60" reads back as -60.
 */
export function unescapeFormulaGuard(v: string): string {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}
