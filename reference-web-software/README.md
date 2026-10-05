# Reference HR web software

A runnable stand-in for the company's existing HR web software. Per the BAMP PRD this system is the
**source of truth** for employee records, location assignments and employment status, and it **receives
attendance back** from the BAMP platform. The real company system is not available locally, so this service
implements the exact integration contract BAMP's adapter (`backend/src/integration/webAdapter.ts`) speaks,
allowing the platform to be run and tested end to end.

- HR staff create locations and employees in its admin UI (Journey B) and terminate them there (Journey D).
- BAMP pulls employees and locations over the REST API, and pushes attendance events back to it — or, in the
  scheduled-export fallback (FR-1.5), uploads CSV/XLSX export files to its import endpoint.
- The database starts empty. There is no seed data.

Stack: Node.js 22, TypeScript (ESM, strict), Fastify 5, PostgreSQL 16 (own `websoft` database), HTTPS only (TLS 1.2+).

## Running

`node scripts/setup-local.mjs` (repository root) creates the `websoft` database and role, a TLS certificate
from the local development CA, and writes `reference-web-software/.env`. Then:

```bash
npm install
npm run dev        # tsx watch, https://localhost:4100
# or
npm run build && npm start
```

Migrations (`src/db/migrations/*.sql`) are applied automatically on startup; `npm run migrate` applies them
without starting the server.

### Environment (`.env`)

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | – | HTTPS port (default `4100`) |
| `HOST` | – | Bind address (default `0.0.0.0`) |
| `PUBLIC_URL` | – | External base URL shown in the UI (default `https://localhost:4100`) |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | yes | PEM certificate and key for the HTTPS listener |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `API_KEY` | yes | Bearer key BAMP must present (≥ 16 characters) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | yes | HR administrator sign-in (password hashed with argon2id at startup) |
| `LOG_LEVEL` | – | pino level (default `info`) |
| `API_RATE_LIMIT_PER_MINUTE` | – | Integration API requests per client IP per minute (default `1200`) |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | – | Admin session lifetime (default 30 min / 12 h) |
| `API_LOG_RETENTION_DAYS` | – | Days to keep the API activity log (default 30) |

## Connecting BAMP

In BAMP open **Settings → Integration**:

| BAMP setting | Value |
| --- | --- |
| Base URL | `https://localhost:4100` |
| API key | `API_KEY` from `reference-web-software/.env` (also revealable on the admin UI's Integration page) |
| Employees path | `/api/v1/employees` (default) |
| Locations path | `/api/v1/locations` (default) |
| Attendance path | `/api/v1/attendance` (default) |
| Delivery mode | `api` — or `scheduled_export` with the two settings below |
| Export endpoint URL | `https://localhost:4100/api/v1/attendance/import` |
| Export endpoint auth header | `Authorization: Bearer <API_KEY>` |

Then use **Test connection** and **Sync now**, and map each location reference to a BAMP branch.

The certificate is issued by the local development CA (`<runtime>/pki/ca.crt`). BAMP's backend process must
trust that CA for its outbound `fetch` calls, e.g. start it with `NODE_EXTRA_CA_CERTS=<runtime>/pki/ca.crt`.

## Integration API contract

Base path `/api/v1`. Every call except `/health` requires `Authorization: Bearer <API_KEY>` (compared in
constant time); otherwise **401** with `WWW-Authenticate: Bearer`. Requests are rate-limited per client IP
(**429** when exceeded; BAMP retries 429). Error bodies are JSON `{ "error": "<message>", ... }` — BAMP's
adapter surfaces the `error` field. Every call is recorded in the API activity log.

### `GET /api/v1/employees?modifiedSince=ISO-8601&page=N&pageSize=M`

- `modifiedSince` (optional): only employees whose record changed at or after this instant. Every change to an
  employee (details, location, status) bumps its `lastModified`.
- `page` ≥ 1 (default 1); `pageSize` 1–1000 (default 100). Ordered by `lastModified`, then `webReferenceId`.

```json
{
  "data": [
    {
      "webReferenceId": "EMP-000001",
      "staffNumber": "004512",
      "fullName": "Adaeze Okafor",
      "department": "Operations",
      "locationRef": "LAG-HQ",
      "employmentStatus": "active",
      "lastModified": "2026-09-28T08:15:02.117Z"
    }
  ],
  "page": 1,
  "pageSize": 500,
  "total": 1,
  "hasMore": false
}
```

`employmentStatus` is one of `active | inactive | suspended | terminated`. `department` and `locationRef` may be
`null`. Invalid parameters → **400**. (The values above only illustrate the format; the database starts empty.)

### `GET /api/v1/locations`

```json
{ "data": [{ "ref": "LAG-HQ", "name": "Lagos Head Office", "address": "…", "timezone": "Africa/Lagos" }] }
```

`address` and `timezone` may be `null`. Location references are permanent once created.

### `POST /api/v1/attendance`

Headers: `Content-Type: application/json`, `Idempotency-Key: <eventId>` (BAMP sends the event UID).

```json
{
  "eventId": "01J8Z3K4X2V9…",
  "webReferenceId": "EMP-000001",
  "staffNumber": "004512",
  "locationRef": "LAG-HQ",
  "direction": "in",
  "capturedAt": "2026-09-28T07:58:41.000Z",
  "timezoneOffsetMinutes": 60,
  "matchScore": 87,
  "deviceId": "DEV-7F3A21"
}
```

| Field | Rule |
| --- | --- |
| `eventId` | string, 1–128 chars, unique |
| `webReferenceId` | string, must be a known employee |
| `staffNumber` | string, stored as sent (`webReferenceId` is authoritative) |
| `locationRef` | string or `null`; when a string it must be a known location |
| `direction` | `in` \| `out` |
| `capturedAt` | ISO-8601 timestamp with `Z` or offset; not more than 24 h in the future |
| `timezoneOffsetMinutes` | integer −840…840 |
| `matchScore` | integer 0…100 |
| `deviceId` | string, 1–128 chars |

| Response | Meaning (BAMP adapter behaviour) |
| --- | --- |
| **201** `{ "data": { "id", "eventId", "receivedAt" } }` | Recorded (delivered) |
| **409** `{ "error", "code": "duplicate", "recordId" }` | `eventId` or `Idempotency-Key` already recorded (treated as delivered) |
| **422** `{ "error", "code" }` | Refused: `unknown_employee`, `employee_not_active` (terminated or inactive at `capturedAt`), `unknown_location`, `captured_in_future` (not retried) |
| **400** `{ "error", "details" }` | Malformed payload (not retried) |
| **401 / 429 / 5xx** | Auth failure / throttled (retried) / server error (retried) |

Employment status is evaluated **at `capturedAt`** using the employee's status history: punches captured
offline before a termination are still accepted when delivered later, while punches on or after the
termination's effective time are refused with 422. HR can backdate a status change on the employee page.

### `POST /api/v1/attendance/import` (scheduled-export fallback, FR-1.5)

`multipart/form-data` with the file in a field named **`file`** (≤ 25 MB), CSV (UTF-8, optional BOM) or XLSX
(first worksheet, header in row 1) in BAMP's export layout (`backend/src/integration/scheduledExport.ts`):

| Column | Maps to |
| --- | --- |
| `EventId` | `eventId` |
| `WebReferenceId` | `webReferenceId` |
| `StaffNumber` | `staffNumber` |
| `FullName` | informational, optional |
| `LocationRef` | `locationRef` (empty → `null`) |
| `Direction` | `direction` |
| `CapturedAt` | `capturedAt` (local time with offset, e.g. `2026-09-28T08:58:41+01:00`) |
| `TzOffsetMinutes` | `timezoneOffsetMinutes` |
| `MatchScore` | `matchScore` |
| `DeviceId` | `deviceId` |

Header names are case-insensitive. The apostrophe BAMP's CSV writer prefixes to values beginning with
`= + - @` (formula-injection guard, e.g. `'-60`) is removed. Each row is validated and recorded exactly like
`POST /attendance`; duplicates are skipped. The response is **200** with a summary even when some rows are
rejected (so BAMP does not resend the whole file), or **422** when the file itself is unreadable or lacks
required columns:

```json
{ "data": { "importId": 7, "fileName": "attendance-….csv", "format": "csv", "rows": 120, "accepted": 118,
            "duplicates": 1, "rejected": 1, "errors": [{ "row": 57, "eventId": "…", "error": "Unknown employee EMP-000999" }],
            "errorsTruncated": false } }
```

Every file is recorded on the admin **Imports** page with per-row errors. HR can also upload an export file
manually there.

### `GET /api/v1/health` (and `GET /health`)

No authentication. `200 { "status": "ok", "database": "ok" }` or `503` when the database is unreachable.

## Admin UI

`https://localhost:4100/` — sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

- **Employees** — search, filter by location/status, paginate; create (web reference `EMP-######` is assigned
  automatically); edit details and assignment; change employment status with an effective time and note
  (terminate, suspend, reactivate); status history and recent attendance per employee.
- **Locations** — list, create, edit (reference is immutable).
- **Attendance received** — records delivered by BAMP, filterable by employee, location, direction, channel
  and local capture date.
- **Imports** — scheduled-export files received, with per-row results; manual upload.
- **API activity** — every integration call with status, duration and detail.
- **Integration** — base URL, endpoints, masked API key with a reveal button, BAMP configuration steps.

Security: HTTPS only; argon2id-hashed admin password; httpOnly, `Secure`, `SameSite=Strict` session cookie
stored server-side as a SHA-256 hash with idle and absolute expiry; per-session CSRF token on every form;
sign-in rate-limited; strict Content-Security-Policy (no inline scripts or external resources).

## Project layout

```
src/
  index.ts              startup: migrations, admin credential hashing, HTTPS listener, housekeeping
  server.ts             Fastify instance, plugins, security headers, static assets
  config.ts             environment validation
  db/                   pg pool, migration runner, SQL migrations
  routes/api.ts         integration API (/api/v1)
  routes/admin.ts       HR admin UI
  services/             employees, locations, attendance rules, imports, list queries
  auth/session.ts       admin sessions, CSRF
  ui/                   HTML templates (auto-escaping)
  static/               app.css, app.js
```
