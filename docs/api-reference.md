# API Reference

Base URL: `https://<host>` (local: `https://localhost:4000`). JSON everywhere. Errors:
`{ "error": { "code": "…", "message": "…", "details": … } }`.

## Dashboard API (`/api/*`)
Authentication: session cookie `bamp_session` (HttpOnly, Secure, SameSite=Strict) from `/api/auth/login`.
Every mutating request must send header `x-bamp-csrf: 1`. Authorisation is role-based and location-scoped; the required
permission is listed per endpoint (see `backend/src/auth/rbac.ts`).

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/login | `{email,password}` → `{ok}` \| `{mfaRequired,challengeToken}` \| `{mfaSetupRequired,challengeToken}`; 401 invalid, 423 locked |
| POST | /api/auth/mfa/verify | `{challengeToken, code \| recoveryCode}` |
| POST | /api/auth/mfa/setup/start | `{challengeToken?}` → `{secret, otpauthUrl, qrDataUrl}` |
| POST | /api/auth/mfa/setup/confirm | `{code, challengeToken?}` → `{recoveryCodes, session}` |
| POST | /api/auth/mfa/recovery-codes · /api/auth/mfa/disable | authenticated |
| POST | /api/auth/logout | |
| GET | /api/auth/me | user, organisation, permissions, location scope, session |
| GET | /api/auth/permissions-matrix | |
| POST | /api/auth/change-password | |
| POST | /api/auth/forgot-password · GET/POST /api/auth/reset-password[/:token] | |
| GET | /api/auth/invite/:token · POST /api/auth/invite/accept | first-time account setup |

### Dashboard, attendance, reports
| Method | Path | Permission |
|---|---|---|
| GET | /api/dashboard | dashboard.view |
| GET | /api/attendance/events?locationId&deviceId&employeeId&direction&status&channel&from&to&date&q&minScore&maxScore&limit&offset | attendance.view |
| GET | /api/attendance/events/export?…&format=csv\|xlsx\|pdf | attendance.export |
| GET | /api/attendance/events/:id | attendance.view |
| POST | /api/attendance/events/:id/retry | attendance.redeliver |
| GET | /api/attendance/delivery/summary | attendance.view |
| POST | /api/attendance/delivery/replay `{eventIds}|{allDeadLetter:true}` | attendance.redeliver |
| POST | /api/attendance/export-now | attendance.redeliver |
| GET | /api/attendance/today?locationId | attendance.view |
| GET | /api/reports/analytics?from&to&locationId&employeeId&department | reports.view |
| GET | /api/reports/export?view=daily\|weekly\|monthly\|employees\|locations\|late\|absences\|trend&format | attendance.export |

### Employees & locations
| Method | Path | Permission |
|---|---|---|
| GET | /api/employees?q&locationId&unassigned&status&biometric&department&today | employees.view |
| GET | /api/employees/departments · /api/employees/:id · /api/employees/:id/attendance | employees.view / attendance.view |
| POST | /api/employees/sync | employees.sync |
| GET/POST | /api/locations · GET/PATCH /api/locations/:id | locations.view / locations.manage |
| GET | /api/location-mappings?status | integration.view |
| POST | /api/location-mappings/:id/resolve · /:id/ignore · /import-all | integration.manage |

### Devices, enrolment, firmware
| Method | Path | Permission |
|---|---|---|
| GET | /api/devices?status&locationId&q&firmware · /api/devices/:id · /:id/roster · /:id/logs | devices.view |
| GET | /api/devices/:id/biometrics · /api/enrolment-sessions | enrolment.view |
| POST | /api/devices · /:id/credentials · /:id/activate · /:id/decommission · PATCH /:id | devices.provision |
| POST | /api/devices/:id/commands `{command}` | devices.command.basic (sync_roster, refresh_status) / .advanced |
| GET | /api/firmware/versions · /deployments · /deployments/:id | firmware.view |
| POST | /api/firmware/versions (multipart) · /deployments · /targets/:id/retry\|rollback · /deployments/:id/cancel | firmware.manage |

### Alerts, integration, users, audit, settings, system
| Method | Path | Permission |
|---|---|---|
| GET | /api/alerts · /api/alerts/:id | alerts.view |
| POST | /api/alerts/:id/acknowledge · /resolve | alerts.manage |
| GET/POST | /api/notifications · /api/notifications/read | authenticated |
| GET | /api/integration/status · /runs · /runs/:id · /exports · /exports/:id/download | integration.view |
| POST | /api/integration/sync `{kind,mode}` · /test-connection | integration.manage |
| GET | /api/users · /api/users/:id | users.view |
| POST/PATCH/PUT | /api/users, /:id, /:id/resend-invite, /password-reset-link, /unlock, /reset-mfa, /revoke-sessions, /supervisor-credentials | users.manage |
| GET | /api/audit · /facets · /verify · /export · /:seq | audit.view |
| GET / PUT | /api/settings · /api/settings/:section | settings.view / settings.manage |
| GET/POST | /api/setup/checklist · /organization · /complete | dashboard.view / settings.manage |
| GET/POST | /api/system/status · /api/system/backup | settings.view / settings.manage |
| GET | /health (public) · /metrics (localhost only) · /ws (WebSocket, session cookie) | |

## Device API (`/device/v1/*`)
All endpoints except `activate` require these headers:
`X-Device-Id`, `X-Timestamp` (unix seconds, ±300 s), `X-Nonce` (16–128 chars, single use), and
`X-Signature = hex(HMAC_SHA256(secret, METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(body))))`.

| Method | Path | Purpose |
|---|---|---|
| POST | /device/v1/activate `{deviceUid, activationCode, model?, serialNumber?, firmwareVersion?}` | returns `{deviceId, organizationId, secret, mqtt:{url,username,password,caCertificate,topicPrefix}, apiBaseUrl}` |
| GET | /device/v1/config | device, location, policies, enrolmentAllowed |
| POST | /device/v1/heartbeat | HTTPS fallback when MQTT is unavailable |
| GET | /device/v1/roster?since=N | `{version, full, employees[], removed[], supervisors[]}` |
| GET | /device/v1/templates?since=N | `{version, full, upserts[{templateId, employeeId, fingerIndex, format, quality, sha256, data(base64)}], removals[]}` |
| POST | /device/v1/templates | enrolment upload `{sessionId, employeeId, fingerIndex, quality, format, template, sha256, supervisorUserId, authorisationMethod}` |
| POST | /device/v1/enrolment-sessions | session status report |
| POST | /device/v1/attendance/batch `{events[], remaining}` | idempotent; per-event `accepted|duplicate|rejected` |
| POST | /device/v1/logs `{entries[]}` | |
| GET | /device/v1/firmware/:targetId · /blob | firmware metadata / binary |

Attendance event: `{eventUid, employeeId, direction: in|out, capturedAt (ISO with offset), tzOffsetMinutes, matchScore 0–100, fingerIndex?, buffered?}`.
