# BAMP — Architecture

Biometric Attendance Management Platform: cloud platform, web dashboard, web-software integration layer and
embedded terminal services.

```
          ┌──────────────────────── Branch ────────────────────────┐
          │  Biometric terminal (device-agent)                     │
          │   fingerprint sensor ─ local SQLite (roster, templates, │
          │   event buffer, logs) ─ offline-first capture          │
          └──────┬───────────────────────────────┬────────────────┘
       HTTPS (durable, signed)             MQTT/TLS 8883 (real-time)
   roster · templates · batched          single event on capture · heartbeat
   attendance · activation · logs        presence(LWT) · commands · roster nudge
          │                                      │
┌─────────▼──────────────────────────────────────▼──────────── Cloud (single VPS, containers) ─┐
│ nginx (TLS 1.2+, HSTS, rate limit) → backend (Node 22 / TypeScript / Fastify)                 │
│   • Device API (HMAC-signed, nonce+timestamp window)      • Dashboard REST API (RBAC, scoped) │
│   • Ingestion (idempotent)  • Rules engine (alerts)       • Reporting API / exports           │
│   • Web integration adapter (sync, delivery outbox, DLQ, scheduled export)                    │
│   • MQTT bridge ─► WebSocket gateway (live dashboard)     • Scheduler (BullMQ)               │
│ PostgreSQL 16 · Redis (cache, queues, rate-limit, nonces) · Mosquitto (dynsec per-device ACL) │
│ S3-compatible object storage (SeaweedFS): firmware artefacts, encrypted template blobs,       │
│   attendance exports, database backups                                                        │
└───────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                 │ HTTPS (Bearer API key)
                                     Company web software (source of truth)
```

## Two channels (firm decision)
| Channel | Protocol | Carries |
|---|---|---|
| Durable | HTTPS | roster sync, template upload/download, batched attendance upload, activation, log upload, firmware download |
| Real-time | MQTT (TLS 8883) | single attendance event on capture, presence + heartbeat, roster-changed nudge, remote commands + acks, OTA progress, alert fan-out to dashboards |

Topic design (`backend/src/services/mqtt.ts`): `bamp/{org}/devices/{uid}/{presence|heartbeat|attendance|attendance/ack|enrolment|firmware|commands|commands/ack|roster-changed}` and `bamp/{org}/dashboard/{kind}`.
Each device gets its own Mosquitto dynamic-security client and role restricted to `bamp/{org}/devices/{uid}/#`.
The backend publishes every dashboard event to `bamp/{org}/dashboard/…`; the WebSocket gateway subscribes to the
broker and forwards frames to connected dashboard sessions, filtered by role and location scope.

## Data model highlights (`backend/src/db/migrations/001_init.sql`)
- Multi-tenant from day one: every business table has `organization_id` (NFR-4.4).
- `employees` mirror the web software (`web_reference_id`, staff number, name, location ref, status, last-modified).
- `location_mappings` map every web location reference to exactly one platform location; unknown refs are stored as
  `unmapped` and raise an alert — employees are never discarded (FR-1.2).
- `attendance_events` — unique `(organization_id, event_uid)` makes ingestion idempotent (FR-3.2).
- `attendance_daily` — one record per employee per location per local work-day, maintained on ingest (O-1, NFR-2.4).
- `attendance_deliveries` + `delivery_attempts` — transactional outbox for pushing to the web software with exponential
  backoff and a dead-letter queue (FR-1.4).
- `roster_changes` / `template_changes` — monotonically versioned per location for device delta sync.
- `biometric_templates` — metadata only; ciphertext lives in object storage (see Security).
- `audit_log` — append-only (UPDATE/DELETE/TRUNCATE rejected by triggers) and SHA-256 hash-chained (FR-5.4/5.5).

## Offline-first terminals (FR-4.x, O-3, NFR-4.2)
The device holds a complete local roster + templates, authenticates and records with no network dependency, writes each
event to its durable local store **before** any network send, publishes it over MQTT when connected (acknowledged by the
cloud), and otherwise uploads buffered events over HTTPS in batches, oldest first, as soon as connectivity returns.
Storage near capacity raises an alarm (default policy: keep capturing, alert loudly).

## Security
- TLS 1.2+ everywhere (NFR-1.1), MQTT only on TLS 8883 with server certificate validation by the device (NFR-1.2).
- Unique per-device credential: HMAC request-signing secret + MQTT identity issued at activation (NFR-1.3, FR-1.8).
- Replay protection: every device request carries timestamp (±300 s) + single-use nonce stored in Redis (NFR-1.4).
- Rate limiting at nginx and in the app (Redis-backed) (NFR-1.5).
- Biometric templates: AES-256-GCM with a per-template data key, wrapped by a key-encryption key held in a key file
  outside the database and outside database backups (NFR-3.1). Templates are purged from the platform and from devices
  within one sync cycle when an employee becomes inactive (NFR-3.2).
- Dashboard auth: email + password (Argon2id, configurable complexity), session expiry (idle + absolute), account lockout,
  TOTP MFA enforceable per role with recovery codes (FR-5.1/5.2); RBAC + location scope enforced server-side on every
  request (FR-5.3); CSRF header + SameSite=Strict cookies.

## Observability
Structured JSON logs (pino), `/health` for uptime monitoring (Uptime Kuma profile included), Prometheus `/metrics`
(internal), error tracking (`error_events` table + optional webhook), availability sampling every minute (S-6 report),
ingest/delivery latency sampling (S-1, NFR-2.2), nightly `pg_dump` backups to object storage retained 30 days (NFR-3.3).
