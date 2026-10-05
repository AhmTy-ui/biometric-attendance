/**
 * Fingerprint sensor abstraction. The module keeps its own template library ("slots"/pages) so identification
 * runs on the sensor itself; the agent keeps the authoritative copy of every template in the local store and
 * maps (employee, finger) ↔ slot.
 */

export interface CaptureResult {
  /** Template generated locally by the sensor (raw bytes as uploaded to the platform). */
  template: Buffer;
  /** 0–100 quality score on the platform's scale. */
  quality: number;
}

export interface IdentifyResult {
  slot: number;
  /** 0–100 match score on the platform's scale. */
  score: number;
}

export interface CaptureOptions {
  timeoutMs: number;
  /** Operator guidance ("Place finger", "Lift finger", "Place the same finger again"). */
  prompt?: (message: string) => void;
  /** Who/which finger is being enrolled — used only by the bench (console) driver. */
  hint?: { employeeId: string; fingerIndex: number; label: string };
}

export interface IdentifyOptions {
  timeoutMs: number;
  prompt?: (message: string) => void;
}

export interface FingerprintSensor {
  readonly name: string;
  /** false for bench/commissioning drivers that must never be used for real attendance. */
  readonly production: boolean;
  /** Template format label stored with templates (only templates of this format can be loaded). */
  readonly templateFormat: string;
  /** true when identify() waits for a finger by itself (continuous kiosk scanning); false when operator-triggered. */
  readonly autoScan: boolean;
  /** Number of library slots. Valid only after open(). */
  capacity: number;

  open(): Promise<void>;
  close(): Promise<void>;
  /** Enrolment capture: two presses of the same finger merged into one template. */
  capture(opts: CaptureOptions): Promise<CaptureResult>;
  /** 1:N identification against the sensor library; null when no enrolled finger matches. Throws NoFingerError on timeout. */
  identify(opts: IdentifyOptions): Promise<IdentifyResult | null>;
  store(slot: number, template: Buffer): Promise<void>;
  remove(slot: number): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

export class SensorError extends Error {
  constructor(
    message: string,
    readonly code: number | string = 'sensor_error'
  ) {
    super(message);
    this.name = 'SensorError';
  }
}

/** No finger was presented before the timeout. */
export class NoFingerError extends SensorError {
  constructor() {
    super('No finger detected', 'no_finger');
    this.name = 'NoFingerError';
  }
}

/** Image captured but unusable (too dry/wet/partial, too few features). */
export class PoorImageError extends SensorError {
  constructor(message: string, code: number | string) {
    super(message, code);
    this.name = 'PoorImageError';
  }
}

export class CancelledError extends Error {
  constructor(message = 'Cancelled by operator') {
    super(message);
    this.name = 'CancelledError';
  }
}
