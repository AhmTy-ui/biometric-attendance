import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export interface Column {
  key: string;
  header: string;
  width?: number;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function toCsv(columns: Column[], rows: Record<string, unknown>[]): Buffer {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  // Neutralise spreadsheet formula injection.
  const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
  const lines = [columns.map((c) => esc(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(safe(cell(r[c.key])))).join(','));
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

export async function toXlsx(title: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BAMP';
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const c of columns) {
      const v = r[c.key];
      out[c.key] = v instanceof Date ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    ws.addRow(out);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdf(title: string, subtitle: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: columns.length > 6 ? 'landscape' : 'portrait', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).font('Helvetica-Bold').text(title);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(subtitle).moveDown(0.8).fillColor('#000');
    const usable = doc.page.width - 72;
    const totalW = columns.reduce((a, c) => a + (c.width ?? 14), 0);
    const widths = columns.map((c) => ((c.width ?? 14) / totalW) * usable);
    const drawHeader = () => {
      let x = 36;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8);
      columns.forEach((c, i) => {
        doc.text(c.header, x, y, { width: widths[i] - 4, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(36, doc.y + 2).lineTo(36 + usable, doc.y + 2).strokeColor('#999').stroke();
      doc.moveDown(0.4);
    };
    drawHeader();
    doc.font('Helvetica').fontSize(7.5);
    for (const r of rows) {
      if (doc.y > doc.page.height - 60) {
        doc.addPage();
        drawHeader();
        doc.font('Helvetica').fontSize(7.5);
      }
      let x = 36;
      const y = doc.y;
      let maxH = 0;
      columns.forEach((c, i) => {
        const text = cell(r[c.key]);
        const h = doc.heightOfString(text, { width: widths[i] - 4 });
        doc.text(text, x, y, { width: widths[i] - 4, height: 30, ellipsis: true });
        maxH = Math.max(maxH, Math.min(h, 30));
        x += widths[i];
      });
      doc.y = y + maxH + 3;
    }
    doc.moveDown().fontSize(7).fillColor('#777').text(`Generated ${new Date().toISOString()} · ${rows.length} row(s) · BAMP`, 36);
    doc.end();
  });
}

export async function renderExport(format: 'csv' | 'xlsx' | 'pdf', title: string, subtitle: string, columns: Column[], rows: Record<string, unknown>[]) {
  if (format === 'csv') return { body: toCsv(columns, rows), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  if (format === 'xlsx')
    return { body: await toXlsx(title, columns, rows), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  return { body: await toPdf(title, subtitle, columns, rows), contentType: 'application/pdf', ext: 'pdf' };
}
