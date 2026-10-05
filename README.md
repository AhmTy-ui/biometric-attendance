# BAMP — Biometric Attendance Management Platform

Centralised, offline-first biometric attendance across branches, integrated with the company web software
(source of truth for employees).

| Folder | What |
|---|---|
| `backend/` | Node.js 22 + TypeScript cloud backend: device API (HTTPS, signed), MQTT bridge, WebSocket gateway, web integration adapter (sync, delivery outbox + DLQ, scheduled export), rules engine (alerts), reporting API, RBAC, append-only audit log, scheduler, backups. PostgreSQL 16 schema in `src/db/migrations`. |
| `frontend/` | React + Vite + TailwindCSS dashboard built from `Template design/`. |
| `device-agent/` | Terminal services running on each biometric terminal: offline store, fingerprint sensor driver, capture, enrolment, HTTPS sync, MQTT, OTA. |
| `reference-web-software/` | Runnable implementation of the web-software integration contract (HR admin + REST API) for environments where the company system is not connected yet. |
| `infra/` | Production docker-compose (PostgreSQL 16, Redis, SeaweedFS S3, Mosquitto TLS, backend, nginx TLS, certbot, Uptime Kuma). |
| `scripts/` | Local Windows/Linux setup (`npm run setup`), infrastructure runner (`npm run infra`), launcher (`npm run start`). |
| `docs/` | Architecture, API reference, integration guide, user guide, runbook. |

## Technology stack (PRD)
Node.js 22 LTS + TypeScript · PostgreSQL 16 · Redis · Mosquitto with TLS · S3-compatible object storage (SeaweedFS) ·
React + Vite + TailwindCSS · WebSocket gateway bridged from the broker · containerised single-VPS hosting behind a TLS
reverse proxy · structured logging, uptime monitoring, error tracking, database backups.

## Quick start (this workstation)
```powershell
winget install OpenJS.NodeJS.22 EclipseFoundation.Mosquitto Git.Git
powershell -ExecutionPolicy Bypass -File scripts\install-runtime.ps1
npm install
npm run install:all
npm run setup -- --trust-ca
npm run infra                       # keep running
npm --prefix frontend run build
npm run start                       # second terminal
npm --prefix backend run bootstrap -- --org "Your Org" --slug your-org --email you@org.com --name "Your Name" --web-url https://localhost:4100 --web-key <webSoftwareApiKey>
```
Then open the printed setup link, finish First-Time Setup, and follow `docs/runbook.md`.
