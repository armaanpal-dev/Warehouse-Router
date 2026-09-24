import { ShopifyError } from '../errors.js';

const MAX_ATTEMPTS = 8;
const backoffMs = (attempts) => Math.min(1000 * 2 ** attempts, 5 * 60_000);

/**
 * Transactional outbox for writes to Shopify.
 *
 * Allocation commits the ledger change and the outbox row in the same SQLite transaction, so either
 * both happen or neither does. The worker then pushes each job to Shopify with retry + backoff. A job
 * that keeps failing goes 'dead' (visible at /api/admin/outbox) instead of blocking the queue.
 *
 * `enqueue` is synchronous so it can be called inside transaction().
 */
export function createOutbox({ db, logger, now = Date.now }) {
  const handlers = new Map();
  const q = {
    insert: db.prepare(`INSERT INTO outbox (type, payload, dedupe_key, status, attempts, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`),
    pin: db.prepare('INSERT OR IGNORE INTO pending_items (outbox_id, inventory_item_id) VALUES (?, ?)'),
    unpin: db.prepare('DELETE FROM pending_items WHERE outbox_id = ?'),
    due: db.prepare(`SELECT * FROM outbox WHERE status = 'pending' AND next_run_at <= ? ORDER BY id LIMIT 20`),
    done: db.prepare(`UPDATE outbox SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?`),
    retry: db.prepare(`UPDATE outbox SET attempts = attempts + 1, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`),
    dead: db.prepare(`UPDATE outbox SET status = 'dead', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`),
    cancelByKey: db.prepare(`UPDATE outbox SET status = 'dead', last_error = ?, updated_at = ? WHERE dedupe_key = ? AND status = 'pending'`),
    idByKey: db.prepare('SELECT id FROM outbox WHERE dedupe_key = ?'),
    list: db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY id DESC LIMIT 100'),
    requeue: db.prepare(`UPDATE outbox SET status = 'pending', next_run_at = ?, updated_at = ? WHERE id = ? AND status = 'dead'`),
  };
  let running = null;
  let timer = null;

  function enqueue(type, payload, { dedupeKey = null, itemIds = [] } = {}) {
    const t = now();
    const r = q.insert.run(type, JSON.stringify(payload), dedupeKey, t, t, t);
    const id = r.changes ? Number(r.lastInsertRowid) : q.idByKey.get(dedupeKey)?.id;
    if (r.changes) for (const item of itemIds) q.pin.run(id, item);
    return id;
  }

  /** Abandon a pending job (e.g. routing for an order that has since been cancelled). */
  function cancel(dedupeKey, reason) {
    const row = q.idByKey.get(dedupeKey);
    if (!row) return;
    q.cancelByKey.run(reason, now(), dedupeKey);
    q.unpin.run(row.id);
  }

  async function runJob(job) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new ShopifyError(`No handler for ${job.type}`);
      await handler(JSON.parse(job.payload), job);
      q.done.run(now(), job.id);
      q.unpin.run(job.id);
      logger?.info('outbox.done', { id: job.id, type: job.type });
    } catch (err) {
      const retryable = err instanceof ShopifyError ? err.retryable : false;
      if (!retryable || job.attempts + 1 >= MAX_ATTEMPTS) {
        q.dead.run(err.message, now(), job.id);
        // Stop holding the ledger ahead of Shopify; the next sync makes Shopify authoritative again.
        q.unpin.run(job.id);
        logger?.error('outbox.dead', { id: job.id, type: job.type, error: err.message });
      } else {
        q.retry.run(now() + backoffMs(job.attempts + 1), err.message, now(), job.id);
        logger?.warn('outbox.retry', { id: job.id, type: job.type, attempt: job.attempts + 1, error: err.message });
      }
    }
  }

  /** Process everything currently due. Serialised: overlapping calls share the same run. */
  function drain() {
    if (running) return running;
    // Clear `running` in a .finally() chained after assignment: an async IIFE with nothing due
    // completes synchronously, so clearing it inside would happen *before* the assignment and
    // leave a settled promise in `running` forever — every later drain() would be a no-op.
    running = (async () => {
      for (;;) {
        const jobs = q.due.all(now());
        if (!jobs.length) break;
        for (const job of jobs) await runJob(job);
      }
    })().finally(() => { running = null; });
    return running;
  }

  return {
    register: (type, fn) => handlers.set(type, fn),
    enqueue,
    cancel,
    drain,
    kick: () => { drain().catch((e) => logger?.error('outbox.drain_failed', { error: e.message })); },
    start(intervalMs = 2000) { timer = setInterval(() => this.kick(), intervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); return running || Promise.resolve(); },
    list: (status = 'dead') => q.list.all(status),
    requeue: (id) => q.requeue.run(now(), now(), id).changes > 0,
  };
}
