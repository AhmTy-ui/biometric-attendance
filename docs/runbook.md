# Operations Runbook

## Local (Windows workstation)
```powershell
winget install OpenJS.NodeJS.22 EclipseFoundation.Mosquitto Git.Git
powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1   # PostgreSQL 16, Redis 7, SeaweedFS (per-user, no admin)
npm install                 # root tooling (node-forge)
npm run install:all         # backend, frontend, device-agent, reference web software
npm run setup -- --trust-ca # secrets, PKI, PostgreSQL cluster, broker config, .env files
npm run infra               # terminal 1: PostgreSQL :5432, Redis :6379, S3 :9000, MQTT/TLS :8883
npm --prefix frontend run build
npm run start               # terminal 2: web software :4100, backend + dashboard :4000
npm --prefix backend run bootstrap -- --org "Org Name" --slug org --email admin@org.com --name "Admin Name" `
     --web-url https://localhost:4100 --web-key <webSoftwareApiKey from secrets.json>
```
Open the printed first-time-setup link. Runtime state lives in `%LOCALAPPDATA%\bamp-runtime` (`secrets.json`, `keys/`,
`pki/`, `data/`, `logs/`).

Locally all services use certificates from the private CA created by `npm run setup`. `npm run start` sets
`NODE_EXTRA_CA_CERTS` so the backend trusts the web software's certificate; if you start a service by hand, set
`NODE_EXTRA_CA_CERTS=%LOCALAPPDATA%\bamp-runtime\pki\ca.crt` first. Browsers need the CA trusted once
(`npm run setup -- --trust-ca`) to open https://localhost:4000 without a warning.

## Production (single VPS)
See `infra/docker-compose.yml`. Steps: `./scripts/generate-secrets.sh` → `./scripts/init-letsencrypt.sh` →
`docker compose up -d` → bootstrap the organisation (command in compose header) → optional
`docker compose --profile monitoring up -d uptime-kuma` and add an HTTP monitor for `https://<domain>/health`.

**Keep an offline copy of `infra/generated/template-kek.b64`.** Without it, enrolled fingerprint templates cannot be
decrypted; it is deliberately not part of database backups.

## Routine checks
| What | Where | Healthy |
|---|---|---|
| Component health | `GET /health`, Settings → System status | all components true |
| Availability (S-6) | Settings → System status | ≥ 99.5 % per month |
| Delivery backlog / DLQ (S-1, S-2) | Attendance → Reconciliation & DLQ | 0 dead-letter, p95 delivery ≤ 10 s |
| Sync | Integration & Sync | Employee/Location sync Healthy |
| Devices | Device Registry | no Offline / Warning |
| Backups (NFR-3.3) | Settings → System status → Backups | nightly success, 30-day retention |
| Audit integrity | Audit Log → Verify chain | valid |

## Incident playbooks
**Device offline** — alert *Device offline — Branch · Device*. The terminal keeps recording locally. Check power/network at
the branch. When it reconnects, buffered events upload automatically (watch *device/reconcile* progress on the device page).
If storage approaches capacity an additional *Storage approaching capacity* alert fires.

**Sync failed twice** — Integration & Sync → Sync History → open the failed run → error message. Typical causes: web
software down, API key rotated, base URL changed. Fix, then *Retry Sync*. The alert auto-resolves on the next success.

**Unmapped location** — Integration & Sync → Unmapped Locations → map to an existing location or create one → sync re-runs
and the held employees are assigned and pushed to devices.

**Dead-letter events** — Attendance → Reconciliation & DLQ → inspect `http status / error` groups (e.g. 422 unknown
employee) → correct in the web software → *Replay*. Nothing is lost; events stay in the platform.

**Firmware failure** — Firmware → deployment → failed target → *Retry* or *Rollback*. The device keeps its previous firmware.

**Broker down** — devices fall back to HTTPS batches automatically; dashboards show "Broker disconnected". Restart
`mosquitto` (`docker compose restart mosquitto` / `npm run infra`).

**Workstation power loss (local Windows setup)** — PostgreSQL recovers automatically from its WAL. Files that were being
rewritten at the moment of the outage can be left zero-filled: re-run `npm run setup` (it detects and re-initialises a damaged
Mosquitto dynamic-security store — devices then need *Re-issue credentials* + re-activation), and if SeaweedFS refuses to start
with "Unsupported volume … version 0", restore `data\seaweedfs` from the nightly backup bucket copy or clear it (object
storage then rebuilds from new uploads; firmware artefacts must be re-uploaded). Production runs on Linux containers with
durable volumes and is not affected in the same way.

**Maintenance window** — `npm --prefix backend run maintenance -- on "Upgrade in progress until 02:00 UTC"`; devices keep
uploading; `… maintenance -- off` afterwards.

## Restore from backup
1. Download the dump from the `bamp-backups` bucket (`db/YYYY-MM-DD/…dump`).
2. `pg_restore --clean --if-exists --no-owner -d <DATABASE_URL> bamp-….dump`
3. Ensure the same `template-kek.b64` is mounted, start the backend, verify `GET /api/audit/verify`.

## Key rotation
- Device credential: Device → Actions → *Re-issue credentials*, then re-activate the terminal with the new code.
- Web software API key: update in Settings → Integration (stored encrypted).
- MQTT cloud password: update Mosquitto dynsec (`mosquitto_ctrl dynsec setClientPassword bamp-cloud …`) and `MQTT_PASSWORD`.
