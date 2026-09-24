import crypto from 'node:crypto';

/** Constant-time check of Shopify's X-Shopify-Hmac-Sha256 over the raw request body. */
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(String(hmacHeader), 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Durable webhook intake.
 *
 * accept(): record the event (INSERT OR IGNORE on the webhook id = duplicate guard) and return fast;
 * Shopify expects a 2xx within 5 seconds and retries otherwise, which would itself create duplicates.
 * process(): run the handler; failures are retried by sweep() with backoff, up to MAX_ATTEMPTS.
 */
const MAX_ATTEMPTS = 6;
const HANDLED = new Set(['orders/create', 'orders/cancelled']);

export function createWebhookProcessor({ db, orders, logger, now = Date.now }) {
  const q = {
    insert: db.prepare(`INSERT INTO webhook_events (webhook_id, topic, shop, resource_id, payload, status, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(webhook_id) DO NOTHING`),
    get: db.prepare('SELECT * FROM webhook_events WHERE webhook_id = ?'),
    mark: db.prepare('UPDATE webhook_events SET status = ?, attempts = attempts + 1, last_error = ?, processed_at = ? WHERE webhook_id = ?'),
    retryable: db.prepare(`SELECT webhook_id, attempts, processed_at, received_at FROM webhook_events
      WHERE status IN ('received', 'failed') AND attempts < ? ORDER BY received_at LIMIT 50`),
    recent: db.prepare('SELECT webhook_id, topic, resource_id, status, attempts, last_error, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 50'),
  };
  const inFlight = new Set();

  function accept({ webhookId, topic, shop, payload }) {
    const status = HANDLED.has(topic) ? 'received' : 'skipped';
    const r = q.insert.run(webhookId, topic, shop, String(payload?.id ?? ''), JSON.stringify(payload), status, now());
    if (!r.changes) {
      logger?.info('webhook.duplicate', { webhookId, topic });
      return { duplicate: true, status: q.get.get(webhookId).status };
    }
    return { duplicate: false, status };
  }

  async function processEvent(webhookId) {
    if (inFlight.has(webhookId)) return;
    const ev = q.get.get(webhookId);
    if (!ev || !['received', 'failed'].includes(ev.status)) return;
    inFlight.add(webhookId);
    try {
      const payload = JSON.parse(ev.payload);
      const result = ev.topic === 'orders/create' ? await orders.allocate(payload) : orders.cancel(payload);
      q.mark.run('processed', null, now(), webhookId);
      logger?.info('webhook.processed', { webhookId, topic: ev.topic, orderId: payload.id, duplicateOrder: !!result?.duplicate });
      return result;
    } catch (err) {
      q.mark.run('failed', err.message, now(), webhookId);
      logger?.error('webhook.failed', { webhookId, topic: ev.topic, attempt: ev.attempts + 1, error: err.message });
      throw err;
    } finally {
      inFlight.delete(webhookId);
    }
  }

  /** Retry events that failed (or were accepted just before a crash). Exponential backoff per event. */
  async function sweep() {
    for (const ev of q.retryable.all(MAX_ATTEMPTS)) {
      const last = ev.processed_at ?? ev.received_at;
      if (ev.attempts > 0 && now() - last < 1000 * 2 ** ev.attempts) continue;
      await processEvent(ev.webhook_id).catch(() => {});
    }
  }

  return { accept, processEvent, sweep, recent: () => q.recent.all() };
}
