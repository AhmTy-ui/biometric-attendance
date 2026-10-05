import { log } from './logs.js';
import type { LockedSensor } from './sensors/index.js';
import type { Runtime } from './state.js';
import type { Store, TemplateRow } from './store.js';
import { Mutex, errMsg } from './util.js';

export type PutOutcome = 'stored' | 'unchanged' | 'unsupported_format' | 'deferred' | 'library_full';

/**
 * Keeps the sensor's on-module template library consistent with the authoritative local copy in the store
 * (employee + finger ↔ sensor slot/page id).
 */
export class TemplateLibrary {
  private mutex = new Mutex();

  constructor(
    private store: Store,
    private sensor: LockedSensor,
    private runtime: Runtime
  ) {}

  private allocSlot(): number | null {
    const used = this.store.usedSlots();
    for (let i = 0; i < this.sensor.capacity; i++) if (!used.has(i)) return i;
    return null;
  }

  /** Verify the module holds exactly our slotted templates; otherwise wipe and reload it from the store. */
  reconcile(force = false): Promise<void> {
    return this.mutex.run(async () => {
      if (!this.runtime.sensorReady) return;
      const all = this.store.listTemplates();
      const loadable = all.filter((t) => t.format === this.sensor.templateFormat);
      const unsupported = all.length - loadable.length;
      if (unsupported) log.warn({ unsupported, sensorFormat: this.sensor.templateFormat }, 'templates in a format this sensor cannot load were kept in the store but not loaded');
      const onSensor = await this.sensor.count();
      const slotted = this.store.slottedTemplateCount();
      const allSlotted = loadable.every((t) => t.slot !== null && t.slot < this.sensor.capacity);
      if (!force && onSensor === slotted && allSlotted && all.every((t) => t.format === this.sensor.templateFormat || t.slot === null)) return;
      log.warn({ onSensor, expected: loadable.length }, 'sensor template library out of sync; reloading from local store');
      await this.sensor.clear();
      this.store.clearAllSlots();
      let loaded = 0;
      for (const t of loadable) {
        const slot = this.allocSlot();
        if (slot === null) {
          log.error({ capacity: this.sensor.capacity, remaining: loadable.length - loaded }, 'sensor library is full; some templates could not be loaded');
          break;
        }
        try {
          await this.sensor.store(slot, t.blob);
          this.store.setTemplateSlot(t.employeeId, t.fingerIndex, slot);
          loaded++;
        } catch (err) {
          log.error({ err: errMsg(err), employeeId: t.employeeId, finger: t.fingerIndex }, 'failed to load template into sensor');
        }
      }
      log.info({ loaded }, 'sensor template library reloaded');
    });
  }

  /** Insert or replace a template locally and in the sensor library. */
  put(row: Omit<TemplateRow, 'slot'>): Promise<PutOutcome> {
    return this.mutex.run(async () => {
      const existing = this.store.getTemplate(row.employeeId, row.fingerIndex);
      if (existing && existing.sha256 === row.sha256 && existing.format === row.format && (existing.slot !== null || row.format !== this.sensor.templateFormat)) {
        if (existing.templateId !== row.templateId || existing.quality !== row.quality) this.store.upsertTemplate({ ...row, slot: existing.slot });
        return 'unchanged';
      }
      if (row.format !== this.sensor.templateFormat) {
        if (existing?.slot != null && this.runtime.sensorReady) await this.sensor.remove(existing.slot).catch(() => undefined);
        this.store.upsertTemplate({ ...row, slot: null });
        return 'unsupported_format';
      }
      if (!this.runtime.sensorReady) {
        // Persist now; the library is reconciled (reloaded) when the sensor comes back.
        this.store.upsertTemplate({ ...row, slot: null });
        return 'deferred';
      }
      const slot = existing?.slot ?? this.allocSlot();
      if (slot === null) {
        this.store.upsertTemplate({ ...row, slot: null });
        log.error({ employeeId: row.employeeId, capacity: this.sensor.capacity }, 'sensor library full; template stored locally only');
        return 'library_full';
      }
      await this.sensor.store(slot, row.blob);
      this.store.upsertTemplate({ ...row, slot });
      return 'stored';
    });
  }

  remove(employeeId: string, fingerIndex: number): Promise<boolean> {
    return this.mutex.run(async () => {
      const t = this.store.deleteTemplate(employeeId, fingerIndex);
      if (!t) return false;
      if (t.slot !== null && this.runtime.sensorReady) {
        await this.sensor.remove(t.slot).catch((err) => log.warn({ err: errMsg(err), slot: t.slot }, 'could not delete template from sensor; will reconcile'));
      }
      return true;
    });
  }

  async removeEmployee(employeeId: string): Promise<number> {
    let n = 0;
    for (const t of this.store.templatesForEmployee(employeeId)) if (await this.remove(t.employeeId, t.fingerIndex)) n++;
    return n;
  }
}
