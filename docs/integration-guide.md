# Web Software Integration Guide

The company web software is the **source of truth** for employees, their assigned locations and employment status.
BAMP never creates employees. The integration adapter (`backend/src/integration/`) pulls employees and locations and
pushes attendance back.

## 1. Endpoints the web software must expose
All requests carry `Authorization: Bearer <API key>` and expect JSON. Paths are configurable in
**Settings → Integration** (defaults shown).

### `GET /api/v1/locations`
```json
{ "data": [ { "ref": "LAG-HQ", "name": "Lagos Head Office", "address": "…", "timezone": "Africa/Lagos" } ] }
```

### `GET /api/v1/employees?modifiedSince=2026-09-28T10:00:00Z&page=1&pageSize=500`
`modifiedSince` is omitted for full reconciliation runs.
```json
{
  "data": [
    { "webReferenceId": "EMP-000123", "staffNumber": "LAG-0457", "fullName": "Ada Obi", "department": "Finance",
      "locationRef": "LAG-HQ", "employmentStatus": "active", "lastModified": "2026-09-28T09:58:12Z" }
  ],
  "page": 1, "pageSize": 500, "total": 1, "hasMore": false
}
```
`employmentStatus`: `active | inactive | suspended | terminated`. Anything other than `active` removes the employee from
all device rosters and purges their biometric templates within one sync cycle; historical attendance is retained.

### `POST /api/v1/attendance` (header `Idempotency-Key: <eventId>`)
```json
{ "eventId": "T-LAG-04-01J…", "webReferenceId": "EMP-000123", "staffNumber": "LAG-0457", "locationRef": "LAG-HQ",
  "direction": "in", "capturedAt": "2026-09-28T07:58:03.412Z", "timezoneOffsetMinutes": 60, "matchScore": 87,
  "deviceId": "T-LAG-04" }
```
Responses: `2xx` accepted · `409` already recorded (treated as success) · other `4xx` rejected (retried up to 3 times, then
dead-letter queue + admin alert) · `5xx`/timeouts retried with exponential backoff up to the configured maximum.

## 2. Scheduled export fallback (FR-1.5)
If the web software cannot accept programmatic attendance, set **Delivery mode = Scheduled export**. Every N minutes the
platform generates a CSV or XLSX file with columns
`EventId, WebReferenceId, StaffNumber, FullName, LocationRef, Direction, CapturedAt (ISO with offset), TzOffsetMinutes, MatchScore, DeviceId`,
stores it in object storage (downloadable from Integration & Sync) and, when an export endpoint URL is configured, POSTs
it as `multipart/form-data` field `file` (optional auth header `Header-Name: value`).

## 3. Sync schedule and guarantees (S-3)
- Incremental sync every *N* minutes (default 5) using `modifiedSince` → changes reach devices well within 15 minutes.
- Full reconciliation daily (default 02:00 UTC) → guaranteed within 24 hours; employees missing from the web software are
  deactivated.
- A failed run is retried automatically after one minute; **two consecutive failures raise a critical alert** (FR-1.6/1.7).
- Unknown location references create an *Unmapped location* alert; resolve it in Integration & Sync → Unmapped Locations.

## 4. Configuration steps
1. Settings → Integration: base URL, API key, paths, delivery mode.
2. Integration & Sync → *Test connection*.
3. *Run location sync*, map or import locations.
4. *Run employee sync*; verify counts in Employees.

A runnable reference implementation of this contract ships in `reference-web-software/`.
