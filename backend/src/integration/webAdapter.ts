import { openSecret } from '../lib/crypto.js';
import { getSettings, type Settings } from '../services/settings.js';

/**
 * Web software integration adapter.
 *
 * The company web software is the source of truth for employees, assignments and employment status.
 * The adapter speaks the REST contract documented in docs/integration-guide.md:
 *
 *   GET  {employeesPath}?modifiedSince=ISO8601&page=N&pageSize=M
 *        → { data: WebEmployee[], page, pageSize, total, hasMore }
 *   GET  {locationsPath}
 *        → { data: WebLocation[] }
 *   POST {attendancePath}           (Idempotency-Key header = eventUid)
 *        ← WebAttendance            → 2xx accepted | 409 already recorded | 4xx rejected | 5xx retry
 *
 * Authentication: `Authorization: Bearer <apiKey>`.
 */

export interface WebEmployee {
  webReferenceId: string;
  staffNumber: string;
  fullName: string;
  department?: string | null;
  locationRef: string | null;
  employmentStatus: 'active' | 'inactive' | 'suspended' | 'terminated';
  lastModified: string;
}

export interface WebLocation {
  ref: string;
  name: string;
  address?: string | null;
  timezone?: string | null;
}

export interface WebAttendance {
  eventId: string;
  webReferenceId: string;
  staffNumber: string;
  locationRef: string | null;
  direction: 'in' | 'out';
  capturedAt: string;
  timezoneOffsetMinutes: number;
  matchScore: number;
  deviceId: string;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public retryable: boolean
  ) {
    super(message);
  }
}

export function sealedKey(s: Settings<'integration'>) {
  if (!s.apiKey) return '';
  return s.apiKey.startsWith('sealed:') ? openSecret(s.apiKey.slice(7)) : s.apiKey;
}

async function request(orgId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const s = await getSettings(orgId, 'integration');
  if (!s.baseUrl) throw new IntegrationError('Web software base URL is not configured (Settings → Integration).', null, false);
  const url = new URL(path, s.baseUrl.endsWith('/') ? s.baseUrl : `${s.baseUrl}/`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(s.apiKey ? { authorization: `Bearer ${sealedKey(s)}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (err: any) {
    throw new IntegrationError(err?.name === 'AbortError' ? `Timed out after ${s.timeoutMs} ms` : `Network error: ${err?.message}`, null, true);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

export async function fetchEmployees(orgId: string, modifiedSince: Date | null): Promise<WebEmployee[]> {
  const s = await getSettings(orgId, 'integration');
  const out: WebEmployee[] = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page), pageSize: '500' });
    if (modifiedSince) qs.set('modifiedSince', modifiedSince.toISOString());
    const r = await request(orgId, 'GET', `${s.employeesPath.replace(/^\//, '')}?${qs}`);
    if (!r.ok) throw new IntegrationError(`Employee fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`, r.status, r.status >= 500);
    if (!r.json || !Array.isArray(r.json.data)) throw new IntegrationError('Employee fetch returned an unexpected payload', r.status, false);
    out.push(...r.json.data);
    if (!r.json.hasMore) break;
    page++;
  }
  return out;
}

export async function fetchLocations(orgId: string): Promise<WebLocation[]> {
  const s = await getSettings(orgId, 'integration');
  const r = await request(orgId, 'GET', s.locationsPath.replace(/^\//, ''));
  if (!r.ok) throw new IntegrationError(`Location fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`, r.status, r.status >= 500);
  if (!r.json || !Array.isArray(r.json.data)) throw new IntegrationError('Location fetch returned an unexpected payload', r.status, false);
  return r.json.data;
}

export async function pushAttendance(orgId: string, ev: WebAttendance): Promise<{ status: number }> {
  const s = await getSettings(orgId, 'integration');
  const r = await request(orgId, 'POST', s.attendancePath.replace(/^\//, ''), ev, { 'idempotency-key': ev.eventId });
  if (r.ok || r.status === 409) return { status: r.status };
  const msg = r.json?.error ?? r.json?.message ?? r.text.slice(0, 300) ?? `HTTP ${r.status}`;
  const retryable = r.status >= 500 || r.status === 429 || r.status === 408;
  throw new IntegrationError(typeof msg === 'string' ? msg : JSON.stringify(msg), r.status, retryable);
}

export async function uploadExport(orgId: string, fileName: string, body: Buffer, contentType: string) {
  const s = await getSettings(orgId, 'integration');
  if (!s.exportEndpointUrl) throw new IntegrationError('Export endpoint URL is not configured', null, false);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(body)], { type: contentType }), fileName);
  const headers: Record<string, string> = {};
  if (s.exportEndpointAuthHeader) {
    // Stored as "Header-Name: value" (sealed at rest).
    const raw = s.exportEndpointAuthHeader.startsWith('sealed:') ? openSecret(s.exportEndpointAuthHeader.slice(7)) : s.exportEndpointAuthHeader;
    const i = raw.indexOf(':');
    if (i > 0) headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  const res = await fetch(s.exportEndpointUrl, { method: 'POST', body: form, headers });
  if (!res.ok) throw new IntegrationError(`Export upload failed: HTTP ${res.status}`, res.status, res.status >= 500);
}

export async function probe(orgId: string) {
  const s = await getSettings(orgId, 'integration');
  const started = Date.now();
  try {
    const r = await request(orgId, 'GET', `${s.locationsPath.replace(/^\//, '')}`);
    return { reachable: true, status: r.status, ok: r.ok, latencyMs: Date.now() - started };
  } catch (err: any) {
    return { reachable: false, status: null, ok: false, latencyMs: Date.now() - started, error: err.message };
  }
}
