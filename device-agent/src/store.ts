import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Durable local store (FR-4.1, O-3).
 *
 * SQLite in WAL mode with synchronous=FULL: a committed attendance event is fsync'ed to the WAL before the
 * capture is confirmed on screen and before any network send is attempted, so power loss cannot lose it.
 */

export type Direction = 'in' | 'out';
export type EventStatus = 'pending' | 'sent' | 'delivered' | 'rejected';
export type StorageFullPolicy = 'continue_capturing_alert' | 'preserve_oldest';

export interface Identity {
  deviceUid: string;
  deviceId: string;
  organizationId: string;
  secret: string;
  apiBaseUrl: string;
  serverPublicUrl?: string;
  mqtt: { url: string; username: string; password: string; topicPrefix: string };
  caCertificate: string;
  activatedAt: string;
}

export interface Employee {
  id: string;
  staffNumber: string;
  fullName: string;
  department: string | null;
}

export interface Supervisor {
  userId: string;
  fullName: string;
  role: string;
  pinHash: string | null;
  employeeId: string | null;
}

export interface TemplateRow {
  employeeId: string;
  fingerIndex: number;
  templateId: string | null;
  format: string;
  quality: number;
  sha256: string;
  blob: Buffer;
  slot: number | null;
}

/** Event payload exactly as the platform's attendanceEventSchema (minus `buffered`, which is set per channel at send time). */
export interface AttendancePayload {
  eventUid: string;
  employeeId: string;
  direction: Direction;
  capturedAt: string;
  tzOffsetMinutes: number;
  matchScore: number;
  fingerIndex?: number;
}

export interface BufferedEvent {
  eventUid: string;
  employeeId: string;
  direction: Direction;
  localDate: string;
  capturedAtMs: number;
  payload: AttendancePayload;
  status: EventStatus;
  attempts: number;
  lastError: string | null;
}

export interface LogEntry {
  id?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: unknown;
  loggedAt: string;
}

export interface FirmwareReport {
  targetId: string;
  state: 'downloading' | 'installing' | 'restarting' | 'verified' | 'failed' | 'rolled_back';
  version?: string;
  error?: string;
}

export interface PendingFirmware {
  kind: 'update' | 'rollback' | 'auto_rollback';
  targetId: string;
  commandId: string | null;
  version: string;
  fromVersion: string;
  bootAttempts: number;
  error?: string;
}

export interface FirmwareState {
  activeVersion: string | null;
  activePath: string | null;
  previousVersion: string | null;
  previousPath: string | null;
  pending: PendingFirmware | null;
  outbox: FirmwareReport[];
}

export class StorageFullError extends Error {
  constructor(public readonly undelivered: number, public readonly capacity: number) {
    super(`Local event storage is full (${undelivered} undelivered events, capacity ${capacity}); policy preserve_oldest refuses new captures`);
  }
}

const SCHEMA_VERSION = 1;

export class Store {
  readonly db: Database.Database;
  readonly path: string;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    restrictPermissions(dataDir, true);
    this.path = join(dataDir, 'device.db');
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    restrictPermissions(this.path, false);
  }

  private migrate() {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        staff_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        department TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS employees_staff_number ON employees(staff_number);
      CREATE TABLE IF NOT EXISTS supervisors (
        user_id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL,
        pin_hash TEXT,
        employee_id TEXT
      );
      CREATE TABLE IF NOT EXISTS templates (
        employee_id TEXT NOT NULL,
        finger_index INTEGER NOT NULL CHECK (finger_index BETWEEN 1 AND 10),
        template_id TEXT,
        format TEXT NOT NULL,
        quality INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        blob BLOB NOT NULL,
        sensor_slot INTEGER UNIQUE,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (employee_id, finger_index)
      );
      CREATE TABLE IF NOT EXISTS attendance_buffer (
        event_uid TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        local_date TEXT NOT NULL,
        payload TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','delivered','rejected')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS attendance_buffer_status ON attendance_buffer(status, captured_at);
      CREATE INDEX IF NOT EXISTS attendance_buffer_employee ON attendance_buffer(employee_id, captured_at);
      CREATE TABLE IF NOT EXISTS log_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        logged_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS firmware_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_version TEXT,
        active_path TEXT,
        previous_version TEXT,
        previous_path TEXT,
        pending TEXT,
        outbox TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO firmware_state (id, updated_at) VALUES (1, ${Date.now()});
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  close() {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* another process may hold the database; the WAL is replayed on next open */
    }
    this.db.close();
  }

  // ───────────── key/value ─────────────
  get<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  set(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(key);
  }

  getIdentity(): Identity | null {
    return this.get<Identity>('identity') ?? null;
  }

  setIdentity(identity: Identity) {
    this.set('identity', identity);
  }

  // ───────────── roster ─────────────
  replaceEmployees(list: Employee[]) {
    const t = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM employees').run();
      const ins = this.db.prepare('INSERT INTO employees (id, staff_number, full_name, department, updated_at) VALUES (?,?,?,?,?)');
      for (const e of list) ins.run(e.id, e.staffNumber, e.fullName, e.department, t);
    })();
  }

  upsertEmployees(list: Employee[]) {
    const t = Date.now();
    const up = this.db.prepare(
      `INSERT INTO employees (id, staff_number, full_name, department, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET staff_number=excluded.staff_number, full_name=excluded.full_name, department=excluded.department, updated_at=excluded.updated_at`
    );
    this.db.transaction(() => {
      for (const e of list) up.run(e.id, e.staffNumber, e.fullName, e.department, t);
    })();
  }

  removeEmployees(ids: string[]) {
    const del = this.db.prepare('DELETE FROM employees WHERE id=?');
    this.db.transaction(() => {
      for (const id of ids) del.run(id);
    })();
  }

  private static toEmployee(r: any): Employee {
    return { id: r.id, staffNumber: r.staff_number, fullName: r.full_name, department: r.department ?? null };
  }

  getEmployee(id: string): Employee | null {
    const r = this.db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    return r ? Store.toEmployee(r) : null;
  }

  getEmployeeByStaffNumber(staffNumber: string): Employee | null {
    const r = this.db.prepare('SELECT * FROM employees WHERE lower(staff_number)=lower(?)').get(staffNumber.trim());
    return r ? Store.toEmployee(r) : null;
  }

  /** Staff number (exact or prefix) or name (substring) search, exact staff-number match first. */
  searchEmployees(term: string, limit = 9): Employee[] {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT *, CASE WHEN lower(staff_number)=? THEN 0 WHEN lower(staff_number) LIKE ? THEN 1 ELSE 2 END AS rank
           FROM employees WHERE lower(staff_number)=? OR lower(staff_number) LIKE ? OR lower(full_name) LIKE ?
          ORDER BY rank, full_name LIMIT ?`
      )
      .all(q, `${q}%`, q, `${q}%`, `%${q}%`, limit);
    return rows.map(Store.toEmployee);
  }

  employeeCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM employees').get() as { n: number }).n;
  }

  replaceSupervisors(list: Supervisor[]) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM supervisors').run();
      const ins = this.db.prepare('INSERT INTO supervisors (user_id, full_name, role, pin_hash, employee_id) VALUES (?,?,?,?,?)');
      for (const s of list) ins.run(s.userId, s.fullName, s.role, s.pinHash, s.employeeId);
    })();
  }

  listSupervisors(): Supervisor[] {
    return (this.db.prepare('SELECT * FROM supervisors ORDER BY full_name').all() as any[]).map((r) => ({
      userId: r.user_id,
      fullName: r.full_name,
      role: r.role,
      pinHash: r.pin_hash ?? null,
      employeeId: r.employee_id ?? null
    }));
  }

  supervisorEmployeeIds(): Set<string> {
    return new Set((this.db.prepare('SELECT employee_id FROM supervisors WHERE employee_id IS NOT NULL').all() as any[]).map((r) => r.employee_id as string));
  }

  // ───────────── templates ─────────────
  private static toTemplate(r: any): TemplateRow {
    return {
      employeeId: r.employee_id,
      fingerIndex: r.finger_index,
      templateId: r.template_id ?? null,
      format: r.format,
      quality: r.quality,
      sha256: r.sha256,
      blob: r.blob as Buffer,
      slot: r.sensor_slot ?? null
    };
  }

  getTemplate(employeeId: string, fingerIndex: number): TemplateRow | null {
    const r = this.db.prepare('SELECT * FROM templates WHERE employee_id=? AND finger_index=?').get(employeeId, fingerIndex);
    return r ? Store.toTemplate(r) : null;
  }

  templateBySlot(slot: number): TemplateRow | null {
    const r = this.db.prepare('SELECT * FROM templates WHERE sensor_slot=?').get(slot);
    return r ? Store.toTemplate(r) : null;
  }

  listTemplates(): TemplateRow[] {
    return (this.db.prepare('SELECT * FROM templates ORDER BY employee_id, finger_index').all() as any[]).map(Store.toTemplate);
  }

  templatesForEmployee(employeeId: string): TemplateRow[] {
    return (this.db.prepare('SELECT * FROM templates WHERE employee_id=? ORDER BY finger_index').all(employeeId) as any[]).map(Store.toTemplate);
  }

  templateKeys(): { employeeId: string; fingerIndex: number }[] {
    return (this.db.prepare('SELECT employee_id, finger_index FROM templates').all() as any[]).map((r) => ({ employeeId: r.employee_id, fingerIndex: r.finger_index }));
  }

  upsertTemplate(t: TemplateRow) {
    this.db
      .prepare(
        `INSERT INTO templates (employee_id, finger_index, template_id, format, quality, sha256, blob, sensor_slot, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(employee_id, finger_index) DO UPDATE SET template_id=excluded.template_id, format=excluded.format, quality=excluded.quality,
           sha256=excluded.sha256, blob=excluded.blob, sensor_slot=excluded.sensor_slot, updated_at=excluded.updated_at`
      )
      .run(t.employeeId, t.fingerIndex, t.templateId, t.format, t.quality, t.sha256, t.blob, t.slot, Date.now());
  }

  setTemplateSlot(employeeId: string, fingerIndex: number, slot: number | null) {
    this.db.prepare('UPDATE templates SET sensor_slot=? WHERE employee_id=? AND finger_index=?').run(slot, employeeId, fingerIndex);
  }

  clearAllSlots() {
    this.db.prepare('UPDATE templates SET sensor_slot=NULL').run();
  }

  deleteTemplate(employeeId: string, fingerIndex: number): TemplateRow | null {
    const t = this.getTemplate(employeeId, fingerIndex);
    if (t) this.db.prepare('DELETE FROM templates WHERE employee_id=? AND finger_index=?').run(employeeId, fingerIndex);
    return t;
  }

  usedSlots(): Set<number> {
    return new Set((this.db.prepare('SELECT sensor_slot FROM templates WHERE sensor_slot IS NOT NULL').all() as any[]).map((r) => r.sensor_slot as number));
  }

  templateCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM templates').get() as { n: number }).n;
  }

  slottedTemplateCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM templates WHERE sensor_slot IS NOT NULL').get() as { n: number }).n;
  }

  // ───────────── attendance buffer ─────────────
  /**
   * Durably record an event. Capacity handling (FR-4.3): when the buffer is at capacity the oldest *delivered*
   * events are recycled first. If it is still full of undelivered events, `preserve_oldest` refuses the capture;
   * the default policy keeps capturing (nothing undelivered is ever discarded) and the caller alerts loudly.
   */
  insertEvent(ev: { payload: AttendancePayload; localDate: string; capturedAtMs: number }, capacity: number, policy: StorageFullPolicy) {
    const tx = this.db.transaction(() => {
      const total = (this.db.prepare('SELECT count(*) AS n FROM attendance_buffer').get() as { n: number }).n;
      if (total >= capacity) {
        const excess = total - capacity + 1 + Math.max(1, Math.floor(capacity * 0.01));
        this.db
          .prepare(
            `DELETE FROM attendance_buffer WHERE event_uid IN (
               SELECT event_uid FROM attendance_buffer WHERE status='delivered' ORDER BY captured_at ASC LIMIT ?)`
          )
          .run(excess);
        const undelivered = (this.db.prepare(`SELECT count(*) AS n FROM attendance_buffer WHERE status <> 'delivered'`).get() as { n: number }).n;
        if (undelivered >= capacity && policy === 'preserve_oldest') throw new StorageFullError(undelivered, capacity);
      }
      this.db
        .prepare(
          `INSERT INTO attendance_buffer (event_uid, employee_id, direction, local_date, payload, captured_at, status, attempts, created_at)
           VALUES (?,?,?,?,?,?,'pending',0,?)`
        )
        .run(ev.payload.eventUid, ev.payload.employeeId, ev.payload.direction, ev.localDate, JSON.stringify(ev.payload), ev.capturedAtMs, Date.now());
    });
    tx();
  }

  /** Would a new capture be refused right now? (preserve_oldest with a buffer full of undelivered events) */
  wouldRefuseCapture(capacity: number, policy: StorageFullPolicy): boolean {
    if (policy !== 'preserve_oldest') return false;
    const undelivered = (this.db.prepare(`SELECT count(*) AS n FROM attendance_buffer WHERE status <> 'delivered'`).get() as { n: number }).n;
    return undelivered >= capacity;
  }

  markSent(eventUid: string) {
    this.db.prepare(`UPDATE attendance_buffer SET status='sent', sent_at=?, attempts=attempts+1 WHERE event_uid=? AND status='pending'`).run(Date.now(), eventUid);
  }

  markDelivered(eventUids: string[]) {
    const st = this.db.prepare(`UPDATE attendance_buffer SET status='delivered', delivered_at=?, last_error=NULL WHERE event_uid=? AND status <> 'delivered'`);
    const t = Date.now();
    this.db.transaction(() => {
      for (const uid of eventUids) st.run(t, uid);
    })();
  }

  markRejected(eventUid: string, error: string) {
    this.db.prepare(`UPDATE attendance_buffer SET status='rejected', last_error=?, attempts=attempts+1 WHERE event_uid=? AND status <> 'delivered'`).run(error.slice(0, 1000), eventUid);
  }

  markFailedAttempt(eventUids: string[], error: string) {
    const st = this.db.prepare(`UPDATE attendance_buffer SET status='pending', attempts=attempts+1, last_error=? WHERE event_uid=? AND status IN ('pending','sent')`);
    this.db.transaction(() => {
      for (const uid of eventUids) st.run(error.slice(0, 1000), uid);
    })();
  }

  /** Oldest first: never-sent events and real-time sends that were not acknowledged within the grace period. */
  nextBatch(limit: number, sentBeforeMs: number): BufferedEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM attendance_buffer WHERE status='pending' OR (status='sent' AND sent_at < ?)
            ORDER BY captured_at ASC, event_uid ASC LIMIT ?`
        )
        .all(sentBeforeMs, limit) as any[]
    ).map(Store.toEvent);
  }

  private static toEvent(r: any): BufferedEvent {
    return {
      eventUid: r.event_uid,
      employeeId: r.employee_id,
      direction: r.direction,
      localDate: r.local_date,
      capturedAtMs: r.captured_at,
      payload: JSON.parse(r.payload),
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error ?? null
    };
  }

  lastEventForEmployee(employeeId: string): BufferedEvent | null {
    const r = this.db.prepare('SELECT * FROM attendance_buffer WHERE employee_id=? ORDER BY captured_at DESC LIMIT 1').get(employeeId);
    return r ? Store.toEvent(r) : null;
  }

  lastEventForEmployeeOn(employeeId: string, localDate: string): BufferedEvent | null {
    const r = this.db.prepare('SELECT * FROM attendance_buffer WHERE employee_id=? AND local_date=? ORDER BY captured_at DESC LIMIT 1').get(employeeId, localDate);
    return r ? Store.toEvent(r) : null;
  }

  recentEvents(limit = 20): BufferedEvent[] {
    return (this.db.prepare('SELECT * FROM attendance_buffer ORDER BY captured_at DESC LIMIT ?').all(limit) as any[]).map(Store.toEvent);
  }

  eventCounts(): { total: number; pending: number; sent: number; delivered: number; rejected: number } {
    const rows = this.db.prepare('SELECT status, count(*) AS n FROM attendance_buffer GROUP BY status').all() as { status: EventStatus; n: number }[];
    const c = { total: 0, pending: 0, sent: 0, delivered: 0, rejected: 0 };
    for (const r of rows) {
      c[r.status] = r.n;
      c.total += r.n;
    }
    return c;
  }

  /** Events not yet confirmed by the platform (pending + sent-but-unacknowledged). */
  undeliveredCount(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM attendance_buffer WHERE status IN ('pending','sent')`).get() as { n: number }).n;
  }

  storageUsedPct(capacity: number): number {
    const total = (this.db.prepare('SELECT count(*) AS n FROM attendance_buffer').get() as { n: number }).n;
    return Math.min(100, Math.round((total * 1000) / Math.max(1, capacity)) / 10);
  }

  /** Give rejected events another chance (e.g. after the device was assigned to a location). */
  requeueRejected(maxAttempts = 20): number {
    return this.db.prepare(`UPDATE attendance_buffer SET status='pending' WHERE status='rejected' AND attempts < ?`).run(maxAttempts).changes;
  }

  /** Recycle delivered history older than the retention window (keeps today's punches for AUTO direction). */
  purgeDelivered(olderThanMs: number): number {
    return this.db.prepare(`DELETE FROM attendance_buffer WHERE status='delivered' AND captured_at < ?`).run(olderThanMs).changes;
  }

  // ───────────── log buffer ─────────────
  appendLogs(entries: LogEntry[], maxRows = 20_000) {
    if (!entries.length) return;
    const ins = this.db.prepare('INSERT INTO log_buffer (level, message, context, logged_at) VALUES (?,?,?,?)');
    this.db.transaction(() => {
      for (const e of entries) ins.run(e.level, e.message, e.context === undefined ? null : JSON.stringify(e.context), e.loggedAt);
      const n = (this.db.prepare('SELECT count(*) AS n FROM log_buffer').get() as { n: number }).n;
      if (n > maxRows) this.db.prepare('DELETE FROM log_buffer WHERE id IN (SELECT id FROM log_buffer ORDER BY id ASC LIMIT ?)').run(n - maxRows);
    })();
  }

  peekLogs(limit: number): LogEntry[] {
    return (this.db.prepare('SELECT * FROM log_buffer ORDER BY id ASC LIMIT ?').all(limit) as any[]).map((r) => ({
      id: r.id,
      level: r.level,
      message: r.message,
      context: r.context === null ? undefined : JSON.parse(r.context),
      loggedAt: r.logged_at
    }));
  }

  deleteLogsUpTo(id: number) {
    this.db.prepare('DELETE FROM log_buffer WHERE id <= ?').run(id);
  }

  // ───────────── firmware ─────────────
  getFirmwareState(): FirmwareState {
    const r = this.db.prepare('SELECT * FROM firmware_state WHERE id=1').get() as any;
    return {
      activeVersion: r?.active_version ?? null,
      activePath: r?.active_path ?? null,
      previousVersion: r?.previous_version ?? null,
      previousPath: r?.previous_path ?? null,
      pending: r?.pending ? (JSON.parse(r.pending) as PendingFirmware) : null,
      outbox: r?.outbox ? (JSON.parse(r.outbox) as FirmwareReport[]) : []
    };
  }

  setFirmwareState(patch: Partial<FirmwareState>) {
    const s = { ...this.getFirmwareState(), ...patch };
    this.db
      .prepare(
        `UPDATE firmware_state SET active_version=?, active_path=?, previous_version=?, previous_path=?, pending=?, outbox=?, updated_at=? WHERE id=1`
      )
      .run(s.activeVersion, s.activePath, s.previousVersion, s.previousPath, s.pending ? JSON.stringify(s.pending) : null, JSON.stringify(s.outbox), Date.now());
  }
}

/** Restrict a file/directory to the service account (credentials and biometric templates live here). */
export function restrictPermissions(path: string, isDir: boolean) {
  if (!existsSync(path)) return;
  if (process.platform === 'win32') return; // ACLs are applied once by `activate` (see restrictWindowsAcl)
  try {
    chmodSync(path, isDir ? 0o700 : 0o600);
  } catch {
    /* not owner — leave as is */
  }
}

export function deleteStoreFiles(dataDir: string) {
  for (const f of ['device.db', 'device.db-wal', 'device.db-shm']) rmSync(join(dataDir, f), { force: true });
}
