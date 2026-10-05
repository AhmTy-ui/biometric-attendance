/** Interaction surface of the terminal (kiosk console) used by enrolment and the bench sensor. */
export interface Operator {
  ask(question: string, opts?: { mask?: boolean }): Promise<string>;
  say(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** ISO/IEC 19794-2 finger positions as used by the platform (1–10). */
export const FINGER_NAMES: Record<number, string> = {
  1: 'right thumb',
  2: 'right index finger',
  3: 'right middle finger',
  4: 'right ring finger',
  5: 'right little finger',
  6: 'left thumb',
  7: 'left index finger',
  8: 'left middle finger',
  9: 'left ring finger',
  10: 'left little finger'
};
