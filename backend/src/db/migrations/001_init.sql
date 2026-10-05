-- BAMP — Biometric Attendance Management Platform
-- Initial schema. Multi-tenant from the start (NFR-4.4): every business table carries organization_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────────── Tenancy ─────────────────────────────
CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            citext NOT NULL UNIQUE,
  timezone        text NOT NULL DEFAULT 'Africa/Lagos',
  setup_completed boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Key/value organisation settings (security, notifications, integration, device policy, retention …)
CREATE TABLE settings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  section         text NOT NULL,
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  PRIMARY KEY (organization_id, section)
);

-- ───────────────────────────── Locations ─────────────────────────────
CREATE TABLE locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL,
  code              text NOT NULL,
  address           text,
  timezone          text NOT NULL DEFAULT 'Africa/Lagos',
  work_start        time NOT NULL DEFAULT '08:00',
  work_end          time NOT NULL DEFAULT '17:00',
  grace_minutes     integer NOT NULL DEFAULT 15,
  workdays          smallint[] NOT NULL DEFAULT '{1,2,3,4,5}', -- ISO dow 1=Mon … 7=Sun
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

-- Web-software location reference → exactly one platform location (FR-1.2)
CREATE TABLE location_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_ref       text NOT NULL,
  external_name      text,
  location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'mapped' CHECK (status IN ('mapped','unmapped','ignored')),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  UNIQUE (organization_id, external_ref)
);

-- ───────────────────────────── Users / RBAC ─────────────────────────────
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email                 citext NOT NULL,
  full_name             text NOT NULL,
  job_title             text,
  role                  text NOT NULL CHECK (role IN ('administrator','manager','branch_supervisor')),
  status                text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  password_hash         text,
  password_changed_at   timestamptz,
  mfa_required          boolean NOT NULL DEFAULT false,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  last_login_ip         inet,
  supervisor_pin_hash   text,     -- on-device supervisor authorisation (FR-2.1)
  supervisor_employee_id uuid,    -- optional link to employee record whose fingerprint authorises
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);
CREATE UNIQUE INDEX users_email_global ON users (email);

CREATE TABLE user_locations (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('invite','password_reset','mfa_challenge')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  ip              inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ───────────────────────────── Employees (mirror of web software) ─────────────────────────────
CREATE TABLE employees (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  web_reference_id      text NOT NULL,
  staff_number          text NOT NULL,
  full_name             text NOT NULL,
  department            text,
  external_location_ref text,
  location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
  employment_status     text NOT NULL CHECK (employment_status IN ('active','inactive','suspended','terminated')),
  source_modified_at    timestamptz,
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, web_reference_id)
);
CREATE INDEX employees_location ON employees (organization_id, location_id);
CREATE INDEX employees_staff ON employees (organization_id, staff_number);
CREATE INDEX employees_name_trgm ON employees USING btree (organization_id, lower(full_name));

-- ───────────────────────────── Devices ─────────────────────────────
CREATE TABLE devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_uid            text NOT NULL UNIQUE,            -- identity burned in at manufacture (FR-1.8)
  name                  text NOT NULL,
  location_id           uuid REFERENCES locations(id) ON DELETE SET NULL,
  model                 text,
  serial_number         text,
  lifecycle_state       text NOT NULL DEFAULT 'pending'
                          CHECK (lifecycle_state IN ('pending','provisioned','connected','active','decommissioned')),
  connectivity          text NOT NULL DEFAULT 'offline' CHECK (connectivity IN ('online','offline')),
  health                text NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy','warning','critical','unknown')),
  secret_enc            text,                           -- HMAC request-signing secret, encrypted with KEK
  credential_issued_at  timestamptz,
  activation_code_hash  text,
  activation_expires_at timestamptz,
  mqtt_username         text UNIQUE,
  firmware_version      text,
  previous_firmware_version text,
  roster_version        bigint NOT NULL DEFAULT 0,
  template_version      bigint NOT NULL DEFAULT 0,
  pending_events        integer NOT NULL DEFAULT 0,
  storage_used_pct      numeric(5,2),
  storage_capacity_events integer,
  last_heartbeat_at     timestamptz,
  last_seen_ip          inet,
  last_sync_at          timestamptz,
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_org_loc ON devices (organization_id, location_id);

CREATE TABLE device_nonces (   -- persistent fallback for replay protection (primary store is Redis)
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce       text NOT NULL,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce)
);

CREATE TABLE device_heartbeats (
  id              bigserial PRIMARY KEY,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL
);
CREATE INDEX device_heartbeats_dev ON device_heartbeats (device_id, received_at DESC);

CREATE TABLE device_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command         text NOT NULL CHECK (command IN ('sync_roster','restart','refresh_status','send_config','update_firmware','rollback_firmware')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','acknowledged','completed','failed','expired')),
  result          jsonb,
  issued_by       uuid REFERENCES users(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  acknowledged_at timestamptz,
  completed_at    timestamptz
);
CREATE INDEX device_commands_dev ON device_commands (device_id, issued_at DESC);

CREATE TABLE device_logs (
  id              bigserial PRIMARY KEY,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  level           text NOT NULL,
  message         text NOT NULL,
  context         jsonb,
  logged_at       timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_logs_dev ON device_logs (device_id, logged_at DESC);

-- Roster membership per device, with a monotonically increasing version (delta sync)
CREATE TABLE roster_changes (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  change          text NOT NULL CHECK (change IN ('upsert','remove')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roster_changes_loc ON roster_changes (location_id, id);

-- ───────────────────────────── Biometric templates (escrow) ─────────────────────────────
CREATE TABLE biometric_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  finger_index      smallint NOT NULL CHECK (finger_index BETWEEN 1 AND 10),
  quality_score     smallint NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  template_format   text NOT NULL DEFAULT 'ISO19794-2',
  object_key        text NOT NULL,          -- ciphertext blob in S3
  wrapped_dek       text NOT NULL,          -- data key wrapped by KEK held outside the DB (NFR-3.1)
  kek_id            text NOT NULL,
  iv                text NOT NULL,
  auth_tag          text NOT NULL,
  sha256            text NOT NULL,
  enrolled_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  enrolled_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  authorised_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  authorisation_method text NOT NULL CHECK (authorisation_method IN ('fingerprint','pin')),
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, finger_index)
);

CREATE TABLE template_changes (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id     uuid REFERENCES locations(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL,
  finger_index    smallint NOT NULL,
  template_id     uuid,
  change          text NOT NULL CHECK (change IN ('upsert','remove')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX template_changes_loc ON template_changes (location_id, id);

CREATE TABLE enrolment_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id         uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  employee_id       uuid REFERENCES employees(id) ON DELETE SET NULL,
  supervisor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  authorisation_method text,
  status            text NOT NULL CHECK (status IN ('started','finger_captured','completed','failed_quality','employee_unavailable','unauthorised','aborted')),
  fingers_captured  smallint NOT NULL DEFAULT 0,
  detail            text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX enrolment_sessions_dev ON enrolment_sessions (organization_id, started_at DESC);

-- ───────────────────────────── Attendance ─────────────────────────────
CREATE TABLE attendance_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_uid         text NOT NULL,     -- generated on device; idempotency key (FR-3.2)
  employee_id       uuid NOT NULL REFERENCES employees(id),
  device_id         uuid NOT NULL REFERENCES devices(id),
  location_id       uuid NOT NULL REFERENCES locations(id),
  direction         text NOT NULL CHECK (direction IN ('in','out')),
  captured_at       timestamptz NOT NULL,
  tz_offset_minutes smallint NOT NULL,
  match_score       smallint NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  finger_index      smallint,
  channel           text NOT NULL CHECK (channel IN ('mqtt','https_batch')),
  was_buffered      boolean NOT NULL DEFAULT false,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, event_uid)
);
CREATE INDEX attendance_loc_time ON attendance_events (location_id, captured_at DESC);
CREATE INDEX attendance_emp_time ON attendance_events (employee_id, captured_at DESC);
CREATE INDEX attendance_dev_time ON attendance_events (device_id, captured_at DESC);
CREATE INDEX attendance_org_time ON attendance_events (organization_id, captured_at DESC);

-- One record per employee per location per local work-day (O-1); maintained on ingest for fast analytics (NFR-2.4)
CREATE TABLE attendance_daily (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  work_date       date NOT NULL,
  first_in        timestamptz,
  last_out        timestamptz,
  event_count     integer NOT NULL DEFAULT 0,
  is_late         boolean NOT NULL DEFAULT false,
  minutes_late    integer NOT NULL DEFAULT 0,
  worked_minutes  integer,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, location_id, work_date)
);
CREATE INDEX attendance_daily_loc ON attendance_daily (location_id, work_date);
CREATE INDEX attendance_daily_org ON attendance_daily (organization_id, work_date);

-- Outbound delivery to the web software (FR-1.4)
CREATE TABLE attendance_deliveries (
  event_id        uuid PRIMARY KEY REFERENCES attendance_events(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivering','delivered','retrying','dead_letter','exported')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_http_status integer,
  last_error      text,
  delivered_at    timestamptz,
  export_batch_id uuid,
  replayed_at     timestamptz,            -- last operator replay; retry budget restarts from here
  attempts_at_replay integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due ON attendance_deliveries (status, next_attempt_at);
CREATE INDEX deliveries_org_status ON attendance_deliveries (organization_id, status);

CREATE TABLE delivery_attempts (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES attendance_events(id) ON DELETE CASCADE,
  attempt_no      integer NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  http_status     integer,
  outcome         text NOT NULL CHECK (outcome IN ('success','retryable','rejected','dead_letter')),
  error           text,
  duration_ms     integer
);
CREATE INDEX delivery_attempts_event ON delivery_attempts (event_id, attempt_no);

-- Scheduled export fallback (FR-1.5)
CREATE TABLE export_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  format          text NOT NULL,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  record_count    integer NOT NULL,
  object_key      text NOT NULL,
  delivery_target text,
  status          text NOT NULL CHECK (status IN ('generated','delivered','failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

-- ───────────────────────────── Integration / sync ─────────────────────────────
CREATE TABLE sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('employees','locations','attendance_push','attendance_export')),
  mode              text NOT NULL CHECK (mode IN ('incremental','full','manual','retry')),
  status            text NOT NULL CHECK (status IN ('running','success','partial','failed')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  records_processed integer NOT NULL DEFAULT 0,
  records_added     integer NOT NULL DEFAULT 0,
  records_updated   integer NOT NULL DEFAULT 0,
  records_removed   integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,
  error_message     text,
  triggered_by      uuid REFERENCES users(id),
  cursor_from       timestamptz,
  cursor_to         timestamptz
);
CREATE INDEX sync_runs_org ON sync_runs (organization_id, kind, started_at DESC);

CREATE TABLE sync_errors (
  id              bigserial PRIMARY KEY,
  sync_run_id     uuid NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  record_ref      text,
  error           text NOT NULL,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── Alerts ─────────────────────────────
CREATE TABLE alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type               text NOT NULL CHECK (type IN ('device_offline','unmapped_location','sync_failed','storage_capacity',
                                                   'delivery_failure','firmware_failure','integration_failure','device_tamper')),
  category           text NOT NULL CHECK (category IN ('device','sync','integration')),
  severity           text NOT NULL CHECK (severity IN ('critical','warning','info')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  title              text NOT NULL,
  description        text NOT NULL,
  impact             text,
  recommended_action text,
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
  dedupe_key         text,
  context            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_occurred_at   timestamptz NOT NULL DEFAULT now(),
  acknowledged_at    timestamptz,
  acknowledged_by    uuid REFERENCES users(id),
  resolved_at        timestamptz,
  resolved_by        uuid REFERENCES users(id),
  resolution_note    text
);
CREATE INDEX alerts_org_status ON alerts (organization_id, status, created_at DESC);
CREATE UNIQUE INDEX alerts_open_dedupe ON alerts (organization_id, dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL;

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_id        uuid REFERENCES alerts(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('in_app','email')),
  title           text NOT NULL,
  body            text NOT NULL,
  read_at         timestamptz,
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- ───────────────────────────── Firmware / OTA ─────────────────────────────
CREATE TABLE firmware_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version         text NOT NULL,
  channel         text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta')),
  release_notes   text,
  object_key      text NOT NULL,
  file_name       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  uploaded_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version)
);

CREATE TABLE firmware_deployments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  firmware_id     uuid NOT NULL REFERENCES firmware_versions(id),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','completed_with_failures','cancelled')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE TABLE firmware_deployment_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id   uuid NOT NULL REFERENCES firmware_deployments(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  from_version    text,
  state           text NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','downloading','installing','restarting','verified','failed','rolled_back')),
  attempts        integer NOT NULL DEFAULT 0,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, device_id)
);

-- ───────────────────────────── Observability ─────────────────────────────
CREATE TABLE uptime_samples (
  sampled_at      timestamptz PRIMARY KEY,
  api_ok          boolean NOT NULL,
  db_ok           boolean NOT NULL,
  redis_ok        boolean NOT NULL,
  mqtt_ok         boolean NOT NULL,
  storage_ok      boolean NOT NULL
);

CREATE TABLE error_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL,
  message         text NOT NULL,
  stack           text,
  context         jsonb
);

CREATE TABLE backups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL CHECK (status IN ('running','success','failed')),
  object_key      text,
  size_bytes      bigint,
  error           text
);

CREATE TABLE ingest_latency (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  measured_at     timestamptz NOT NULL DEFAULT now(),
  capture_to_ingest_ms integer NOT NULL,
  capture_to_delivery_ms integer
);
CREATE INDEX ingest_latency_time ON ingest_latency (organization_id, measured_at DESC);

-- ───────────────────────────── Audit log (append-only, hash-chained) ─────────────────────────────
CREATE TABLE audit_log (
  seq             bigserial PRIMARY KEY,
  id              uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid REFERENCES organizations(id),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type      text NOT NULL CHECK (actor_type IN ('user','device','system','integration')),
  actor_id        text,
  actor_name      text,
  actor_role      text,
  action          text NOT NULL,
  object_type     text NOT NULL,
  object_id       text,
  object_label    text,
  before_state    jsonb,
  after_state     jsonb,
  ip              inet,
  user_agent      text,
  device_info     text,
  prev_hash       text NOT NULL,
  hash            text NOT NULL
);
CREATE INDEX audit_org_time ON audit_log (organization_id, occurred_at DESC);
CREATE INDEX audit_action ON audit_log (organization_id, action);
CREATE INDEX audit_object ON audit_log (organization_id, object_type, object_id);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- ───────────────────────────── Migrations bookkeeping ─────────────────────────────
-- (schema_migrations is created by the migration runner)
