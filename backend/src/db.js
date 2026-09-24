import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite via Node's built-in driver (no native addon to compile). The API is synchronous, which is
 * exactly what we want for allocation: a transaction that contains no `await` cannot be interleaved
 * with another request in this process, and BEGIN IMMEDIATE takes the write lock up front so a second
 * process on the same file waits instead of reading stale stock.
 */
export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    -- Our view of sellable stock per inventory item per warehouse. Shopify is the source of truth for
    -- physical stock; this ledger additionally reflects allocations we made that Shopify has not caught
    -- up with yet (see services/inventory.js).
    CREATE TABLE IF NOT EXISTS stock (
      inventory_item_id TEXT NOT NULL,
      warehouse         TEXT NOT NULL,
      available         INTEGER NOT NULL,
      synced_at         INTEGER NOT NULL,
      PRIMARY KEY (inventory_item_id, warehouse)
    );

    -- variant -> inventory item, cached so allocation can resolve items without a network call.
    CREATE TABLE IF NOT EXISTS variants (
      variant_id        TEXT PRIMARY KEY,
      inventory_item_id TEXT NOT NULL,
      sku               TEXT,
      title             TEXT,
      tracked           INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id     TEXT PRIMARY KEY,
      order_name   TEXT,
      pincode      TEXT,
      status       TEXT NOT NULL,   -- allocated | partially_allocated | needs_review | cancelled
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id          TEXT NOT NULL REFERENCES orders(order_id),
      line_item_id      TEXT NOT NULL,
      variant_id        TEXT NOT NULL,
      inventory_item_id TEXT,
      warehouse         TEXT,          -- NULL for the unallocated remainder of a line
      quantity          INTEGER NOT NULL CHECK (quantity > 0),
      status            TEXT NOT NULL, -- allocated | unallocated | released
      created_at        INTEGER NOT NULL,
      UNIQUE (order_id, line_item_id, warehouse)
    );

    -- Every webhook we accept, keyed by Shopify's X-Shopify-Webhook-Id. The primary key is the
    -- duplicate-delivery guard; the row doubles as a durable job so nothing is lost on a crash.
    CREATE TABLE IF NOT EXISTS webhook_events (
      webhook_id  TEXT PRIMARY KEY,
      topic       TEXT NOT NULL,
      shop        TEXT NOT NULL,
      resource_id TEXT,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL,   -- received | processed | failed | skipped
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    );

    -- Writes back to Shopify, retried with backoff until they succeed or go dead.
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      dedupe_key  TEXT UNIQUE,
      status      TEXT NOT NULL,   -- pending | done | dead
      attempts    INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL,
      last_error  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_run_at);

    -- Items with Shopify writes still in flight. The ledger is ahead of Shopify for these, so
    -- inventory syncs must not overwrite them.
    CREATE TABLE IF NOT EXISTS pending_items (
      outbox_id         INTEGER NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      inventory_item_id TEXT NOT NULL,
      PRIMARY KEY (outbox_id, inventory_item_id)
    );

    CREATE TABLE IF NOT EXISTS discrepancies (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id TEXT NOT NULL,
      warehouse         TEXT NOT NULL,
      ledger_qty        INTEGER NOT NULL,
      shopify_qty       INTEGER NOT NULL,
      source            TEXT NOT NULL,
      detected_at       INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Run `fn` inside BEGIN IMMEDIATE ... COMMIT, rolling back on any throw.
 * `fn` must be synchronous: an await inside would release the event loop mid-transaction.
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('transaction() callback must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
