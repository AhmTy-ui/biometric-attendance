import { ApiError, type DeviceHttp } from './http.js';
import { log } from './logs.js';
import { getPolicies, type Runtime } from './state.js';
import type { Store } from './store.js';
import { errMsg, every } from './util.js';

/**
 * Buffered attendance upload (FR-4.2): every 5 s, oldest first, in HTTPS batches of `uploadBatchSize`:
 * events never sent in real time (captured offline) and real-time sends not acknowledged within 30 s.
 * Ingestion is idempotent on eventUid (FR-3.2), so re-sending is always safe.
 */

interface BatchResult {
  accepted: number;
  duplicate: number;
  results: { eventUid: string; status: 'accepted' | 'duplicate' | 'rejected' | 'error'; error?: string }[];
}

const ACK_GRACE_MS = 30_000;

export class Uploader {
  private loop: ReturnType<typeof every> | null = null;
  private requeueLoop: ReturnType<typeof every> | null = null;
  private reconcileStartedAt = 0;
  private reconcileUploaded = 0;
  private reconcileTotal = 0;

  constructor(
    private store: Store,
    private http: DeviceHttp,
    private runtime: Runtime
  ) {}

  start() {
    this.loop = every(() => 5000, () => this.tick(), { immediate: true, onError: (err) => log.warn({ err: errMsg(err) }, 'upload tick failed') });
    // Rejected events (e.g. device had no location at the time) get periodic further chances.
    this.requeueLoop = every(
      () => 60 * 60_000,
      async () => {
        const n = this.store.requeueRejected();
        if (n) log.warn({ events: n }, 'requeued previously rejected events for another delivery attempt');
      }
    );
  }

  stop() {
    this.loop?.stop();
    this.requeueLoop?.stop();
  }

  /** Run an upload pass immediately (e.g. on reconnection). */
  kick() {
    void this.loop?.now();
  }

  private async tick() {
    if (this.runtime.shuttingDown) return;
    const batchSize = getPolicies(this.store).uploadBatchSize;
    for (;;) {
      const batch = this.store.nextBatch(batchSize, Date.now() - ACK_GRACE_MS);
      if (!batch.length) {
        if (this.runtime.reconciling) this.finishReconciliation();
        return;
      }
      const undelivered = this.store.undeliveredCount();
      if (!this.runtime.reconciling && (undelivered > batch.length || batch.some((e) => e.status === 'pending' && e.attempts > 0) || undelivered >= 20)) {
        this.runtime.reconciling = true;
        this.reconcileStartedAt = Date.now();
        this.reconcileUploaded = 0;
        this.reconcileTotal = undelivered;
        log.info({ backlog: undelivered }, 'reconciliation started: uploading buffered attendance events (oldest first)');
        this.runtime.emit('status');
      }
      const remaining = Math.max(0, undelivered - batch.length);
      let res: BatchResult;
      try {
        res = await this.http.request<BatchResult>('POST', '/device/v1/attendance/batch', {
          body: { events: batch.map((e) => ({ ...e.payload, buffered: true })), remaining },
          retries: 1,
          timeoutMs: 60_000
        });
      } catch (err) {
        const uids = batch.map((e) => e.eventUid);
        if (err instanceof ApiError && !err.transient && err.status === 400) {
          // A malformed event in the batch: isolate it by retrying one by one on the next passes.
          log.error({ err: err.message, details: err.details }, 'batch rejected as invalid; retrying events individually');
          await this.uploadIndividually(batch.map((e) => e.eventUid));
          continue;
        }
        this.store.markFailedAttempt(uids, errMsg(err));
        log.debug({ err: errMsg(err), events: uids.length }, 'batch upload deferred');
        return;
      }
      const delivered: string[] = [];
      let errors = 0;
      for (const r of res.results ?? []) {
        if (r.status === 'accepted' || r.status === 'duplicate') delivered.push(r.eventUid);
        else if (r.status === 'rejected') {
          this.store.markRejected(r.eventUid, r.error ?? 'rejected');
          log.error({ eventUid: r.eventUid, error: r.error }, 'attendance event rejected by the platform; kept locally');
        } else {
          errors++;
          this.store.markFailedAttempt([r.eventUid], r.error ?? 'temporary server error');
        }
      }
      this.store.markDelivered(delivered);
      this.runtime.emit('event-acked');
      if (this.runtime.reconciling) {
        this.reconcileUploaded += delivered.length;
        log.info(
          { uploaded: this.reconcileUploaded, of: this.reconcileTotal, accepted: res.accepted, duplicate: res.duplicate, remaining: this.store.undeliveredCount() },
          'reconciliation progress'
        );
      }
      if (errors) return; // server-side trouble: back off until the next tick
    }
  }

  private async uploadIndividually(uids: string[]) {
    for (const uid of uids) {
      const ev = this.store.nextBatch(5000, Date.now() - ACK_GRACE_MS).find((e) => e.eventUid === uid);
      if (!ev) continue;
      try {
        const res = await this.http.request<BatchResult>('POST', '/device/v1/attendance/batch', { body: { events: [{ ...ev.payload, buffered: true }] }, retries: 1 });
        const r = res.results?.[0];
        if (r?.status === 'accepted' || r?.status === 'duplicate') this.store.markDelivered([uid]);
        else if (r?.status === 'rejected') this.store.markRejected(uid, r.error ?? 'rejected');
        else this.store.markFailedAttempt([uid], r?.error ?? 'temporary server error');
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) {
          this.store.markRejected(uid, `Invalid event: ${err.message}`);
          log.error({ eventUid: uid, err: err.message, details: err.details }, 'event rejected as invalid; kept locally');
        } else {
          this.store.markFailedAttempt([uid], errMsg(err));
          return;
        }
      }
    }
  }

  private finishReconciliation() {
    this.runtime.reconciling = false;
    log.info({ uploaded: this.reconcileUploaded, seconds: Math.round((Date.now() - this.reconcileStartedAt) / 1000) }, 'reconciliation complete: all buffered events delivered');
    this.runtime.emit('status');
  }
}
