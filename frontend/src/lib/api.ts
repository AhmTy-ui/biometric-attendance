export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const globalListeners = new Set<Listener>();
/** Session-expired / maintenance / offline handling is wired once in <App/>. */
export function onGlobalApiError(l: Listener) {
  globalListeners.add(l);
  return () => {
    globalListeners.delete(l);
  };
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  try {
    res = await fetch(`${path}${qs(query)}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'x-bamp-csrf': '1',
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body)
    });
  } catch {
    const e = new ApiError(0, 'offline', 'Connection unavailable.');
    globalListeners.forEach((l) => l(e));
    throw e;
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details);
    globalListeners.forEach((l) => l(err));
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T = any>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  upload: <T = any>(path: string, form: FormData) => request<T>('POST', path, form)
};

/** Download a file produced by an export endpoint (CSV / Excel / PDF). */
export async function download(path: string, query?: Query) {
  const res = await fetch(`${path}${qs(query)}`, { credentials: 'same-origin', headers: { 'x-bamp-csrf': '1' } });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try {
      msg = (await res.json())?.error?.message ?? msg;
    } catch {
      /* body not JSON */
    }
    throw new ApiError(res.status, 'export_failed', msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'export';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
