-- Reference HR web software schema.
-- The database starts empty: HR staff create locations and employees through the admin UI.

-- Millisecond-precision "now" so that timestamps round-trip exactly through ISO-8601 (JavaScript Date) and
-- `modifiedSince` comparisons made by BAMP never miss or double-count on sub-millisecond differences.
CREATE FUNCTION ms_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT date_trunc('milliseconds', clock_timestamp()) $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    NEW.updated_at := ms_now();
  END IF;
  RETURN NEW;
END $$;

-- ───────────── locations ─────────────
CREATE TABLE locations (
  ref         text PRIMARY KEY CHECK (ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  address     text CHECK (address IS NULL OR length(address) <= 500),
  timezone    text CHECK (timezone IS NULL OR length(timezone) <= 64),
  created_at  timestamptz NOT NULL DEFAULT ms_now(),
  updated_at  timestamptz NOT NULL DEFAULT ms_now()
);
CREATE UNIQUE INDEX locations_ref_ci ON locations (lower(ref));
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ───────────── employees ─────────────
CREATE SEQUENCE employee_ref_seq START 1;

CREATE FUNCTION next_employee_ref() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE n bigint := nextval('employee_ref_seq');
BEGIN
  RETURN 'EMP-' || CASE WHEN n < 1000000 THEN lpad(n::text, 6, '0') ELSE n::text END;
END $$;

CREATE TABLE employees (
  web_reference_id   text PRIMARY KEY DEFAULT next_employee_ref(),
  staff_number       text NOT NULL UNIQUE CHECK (length(btrim(staff_number)) BETWEEN 1 AND 32),
  full_name          text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  department         text CHECK (department IS NULL OR length(department) <= 120),
  location_ref       text REFERENCES locations (ref) ON UPDATE CASCADE ON DELETE RESTRICT,
  employment_status  text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'inactive', 'suspended', 'terminated')),
  created_at         timestamptz NOT NULL DEFAULT ms_now(),
  updated_at         timestamptz NOT NULL DEFAULT ms_now()
);
CREATE UNIQUE INDEX employees_staff_number_ci ON employees (lower(staff_number));
CREATE INDEX employees_updated ON employees (updated_at, web_reference_id);
CREATE INDEX employees_location ON employees (location_ref);
CREATE INDEX employees_status ON employees (employment_status);
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Employment status timeline. Used to decide whether attendance captured at a given instant belongs to a
-- period in which the employee was terminated or inactive (e.g. a backdated termination, Journey D).
CREATE TABLE employee_status_history (
  id                bigserial PRIMARY KEY,
  web_reference_id  text NOT NULL REFERENCES employees (web_reference_id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('active', 'inactive', 'suspended', 'terminated')),
  effective_at      timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT ms_now(),
  note              text CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX employee_status_history_lookup ON employee_status_history (web_reference_id, effective_at DESC, id DESC);

-- ───────────── attendance received from BAMP ─────────────
CREATE TABLE attendance_records (
  id                       bigserial PRIMARY KEY,
  event_id                 text NOT NULL UNIQUE,
  idempotency_key          text UNIQUE,
  web_reference_id         text NOT NULL REFERENCES employees (web_reference_id) ON DELETE RESTRICT,
  staff_number             text NOT NULL,
  location_ref             text,
  direction                text NOT NULL CHECK (direction IN ('in', 'out')),
  captured_at              timestamptz NOT NULL,
  timezone_offset_minutes  smallint NOT NULL CHECK (timezone_offset_minutes BETWEEN -840 AND 840),
  match_score              smallint NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  device_id                text NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT ms_now(),
  source                   text NOT NULL CHECK (source IN ('api', 'import')),
  import_file_id           bigint
);
CREATE INDEX attendance_records_received ON attendance_records (received_at DESC, id DESC);
CREATE INDEX attendance_records_captured ON attendance_records (captured_at DESC);
CREATE INDEX attendance_records_employee ON attendance_records (web_reference_id, captured_at DESC);
CREATE INDEX attendance_records_location ON attendance_records (location_ref, captured_at DESC);

-- ───────────── scheduled-export imports (FR-1.5 fallback) ─────────────
CREATE TABLE import_files (
  id           bigserial PRIMARY KEY,
  file_name    text NOT NULL,
  format       text NOT NULL CHECK (format IN ('csv', 'xlsx', 'unknown')),
  size_bytes   integer NOT NULL DEFAULT 0,
  channel      text NOT NULL CHECK (channel IN ('api', 'admin')),
  received_at  timestamptz NOT NULL DEFAULT ms_now(),
  rows         integer NOT NULL DEFAULT 0,
  accepted     integer NOT NULL DEFAULT 0,
  duplicates   integer NOT NULL DEFAULT 0,
  rejected     integer NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX import_files_received ON import_files (received_at DESC);
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_import_file_fk
  FOREIGN KEY (import_file_id) REFERENCES import_files (id) ON DELETE SET NULL;

-- ───────────── HR admin sessions ─────────────
CREATE TABLE admin_sessions (
  token_hash    text PRIMARY KEY,
  email         text NOT NULL,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text
);
CREATE INDEX admin_sessions_expiry ON admin_sessions (expires_at);

-- ───────────── integration API activity ─────────────
CREATE TABLE api_request_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  method       text NOT NULL,
  path         text NOT NULL,
  status       integer NOT NULL,
  duration_ms  integer NOT NULL,
  remote_addr  text,
  detail       text
);
CREATE INDEX api_request_log_at ON api_request_log (at DESC, id DESC);
