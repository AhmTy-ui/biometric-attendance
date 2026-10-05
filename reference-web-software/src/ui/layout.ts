import type { AdminSession } from '../auth/session.js';
import { html, qs, raw, type Renderable, SafeHtml } from './html.js';

export const APP_NAME = 'Websoft HR';

const NAV = [
  { key: 'employees', href: '/employees', label: 'Employees' },
  { key: 'locations', href: '/locations', label: 'Locations' },
  { key: 'attendance', href: '/attendance', label: 'Attendance received' },
  { key: 'imports', href: '/imports', label: 'Imports' },
  { key: 'activity', href: '/activity', label: 'API activity' },
  { key: 'integration', href: '/integration', label: 'Integration' }
] as const;

export type NavKey = (typeof NAV)[number]['key'];

export interface Flash {
  kind: 'success' | 'error' | 'info';
  text: string;
}

export function page(opts: {
  title: string;
  active?: NavKey;
  session: AdminSession | null;
  flash?: Flash | null;
  body: SafeHtml;
}): string {
  const s = opts.session;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${opts.title} · ${APP_NAME}</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${s ? 'app' : 'auth'}">
${
  s
    ? html`<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/employees"><span class="brand-mark" aria-hidden="true">W</span><span>${APP_NAME}</span></a>
    <button class="nav-toggle" type="button" aria-controls="mainnav" aria-expanded="false" data-nav-toggle>Menu</button>
    <nav id="mainnav" class="mainnav" aria-label="Main">
      ${NAV.map((n) => html`<a href="${n.href}"${opts.active === n.key ? raw(' aria-current="page" class="active"') : ''}>${n.label}</a>`)}
    </nav>
    <div class="user">
      <span class="user-email" title="Signed in">${s.email}</span>
      <form method="post" action="/logout">${csrfField(s)}<button type="submit" class="btn btn-ghost btn-sm">Sign out</button></form>
    </div>
  </div>
</header>`
      : ''
}
<main class="${s ? 'container' : 'auth-container'}">
${opts.flash ? html`<div class="flash flash-${opts.flash.kind}" role="${opts.flash.kind === 'error' ? 'alert' : 'status'}">${opts.flash.text}</div>` : ''}
${opts.body}
</main>
</body>
</html>`;
  return doc.value;
}

export const csrfField = (s: AdminSession | null) => (s ? html`<input type="hidden" name="_csrf" value="${s.csrfToken}">` : '');

export function pageHeader(title: string, subtitle?: Renderable, actions?: Renderable) {
  return html`<div class="page-header">
  <div><h1>${title}</h1>${subtitle ? html`<p class="subtitle">${subtitle}</p>` : ''}</div>
  ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
</div>`;
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
  terminated: 'Terminated'
};

export const statusBadge = (status: string) => html`<span class="badge badge-${status}">${STATUS_LABEL[status] ?? status}</span>`;

/** Timestamp rendered in UTC on the server; app.js re-renders it in the viewer's local time zone. */
export function ts(d: Date | null | undefined, empty = '—') {
  if (!d) return html`<span class="muted">${empty}</span>`;
  const iso = d.toISOString();
  return html`<time datetime="${iso}" data-local>${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC</time>`;
}

export function pager(pageNo: number, pageSize: number, total: number, base: string, params: Record<string, string | undefined>) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return html``;
  const from = (pageNo - 1) * pageSize + 1;
  const to = Math.min(total, pageNo * pageSize);
  const link = (p: number, label: string, disabled: boolean) =>
    disabled
      ? html`<span class="btn btn-sm btn-ghost" aria-disabled="true">${label}</span>`
      : html`<a class="btn btn-sm btn-ghost" href="${base}${qs({ ...params, page: p })}">${label}</a>`;
  return html`<nav class="pager" aria-label="Pagination">
  <span class="muted">${from.toLocaleString('en')}–${to.toLocaleString('en')} of ${total.toLocaleString('en')}</span>
  <span class="pager-links">${link(pageNo - 1, '← Previous', pageNo <= 1)}<span class="pager-page">Page ${pageNo} of ${pages}</span>${link(pageNo + 1, 'Next →', pageNo >= pages)}</span>
</nav>`;
}

export function fieldError(errors: Record<string, string>, field: string) {
  return errors[field] ? html`<p class="field-error" id="${field}-error">${errors[field]}</p>` : '';
}

export function emptyState(title: string, text: Renderable, action?: Renderable) {
  return html`<div class="empty"><h2>${title}</h2><p>${text}</p>${action ?? ''}</div>`;
}
