import express from 'express';
import { openDatabase } from './db.js';
import { AppError, badRequest, notFound, unauthorized } from './errors.js';
import { cors, errorHandler, rateLimit, requestId, requireApiKey, securityHeaders, verifyAppProxy } from './middleware.js';
import { createGraphqlClient, tokenTransport, cliTransport } from './shopify/graphql.js';
import { createShopifyService } from './shopify/service.js';
import { createMockShopify, MOCK_LOCATIONS } from './shopify/mock.js';
import { createInventoryService } from './services/inventory.js';
import { createAvailabilityService } from './services/availability.js';
import { createOutbox } from './services/outbox.js';
import { createOrderService } from './services/orders.js';
import { registerJobs, createReconciler } from './services/jobs.js';
import { createWebhookProcessor, verifyWebhookHmac } from './services/webhooks.js';
import { toGid } from './shopify/ids.js';

/** Wire services together. Everything is injectable so tests can pass a mock Shopify and an in-memory DB. */
export function createContext(config, { logger, shopify, db } = {}) {
  db ??= openDatabase(config.databasePath);
  if (!shopify) {
    if (config.shopify.mode === 'mock') shopify = createMockShopify();
    else {
      const transport = config.shopify.mode === 'token' ? tokenTransport(config.shopify) : cliTransport(config.shopify);
      shopify = createShopifyService(createGraphqlClient(transport, { logger }));
    }
  }
  const warehouseLocations = config.shopify.mode === 'mock' || shopify.mode === 'mock' ? MOCK_LOCATIONS : config.warehouseLocations;

  const inventory = createInventoryService({ db, shopify, warehouseLocations, cacheMs: config.inventoryCacheMs, staleMaxMs: config.staleMaxMs, logger });
  const outbox = createOutbox({ db, logger });
  registerJobs({ outbox, shopify, inventory, logger });
  const orders = createOrderService({ db, inventory, outbox, shopify, logger });
  const webhooks = createWebhookProcessor({ db, orders, logger });
  const reconciler = createReconciler({ inventory, logger });
  const checkAvailability = createAvailabilityService({ inventory });
  return { config, db, shopify, inventory, outbox, orders, webhooks, reconciler, checkAvailability, logger };
}

export function createApp(ctx) {
  const { config, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId, securityHeaders);

  app.get('/health', (req, res) => {
    let db = 'ok';
    try { ctx.db.prepare('SELECT 1').get(); } catch { db = 'down'; }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', shopify_mode: config.shopify.mode, db, uptime_s: Math.round(process.uptime()) });
  });

  /* ---------- Webhooks: raw body is required for the HMAC, so this goes before express.json() ---------- */
  // One endpoint for all topics; the topic comes from the signed X-Shopify-Topic header, not the URL.
  app.post(['/webhooks', '/webhooks/*path'], express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) => {
    if (!verifyWebhookHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), config.shopify.apiSecret)) return next(unauthorized('Invalid webhook signature'));
    const shop = req.get('X-Shopify-Shop-Domain');
    if (shop !== config.shopify.shop) return next(new AppError(403, 'UNKNOWN_SHOP', 'Webhook is for a different shop.'));
    const topic = req.get('X-Shopify-Topic');
    const webhookId = req.get('X-Shopify-Webhook-Id') || req.get('X-Shopify-Event-Id');
    if (!topic || !webhookId) return next(badRequest('Missing X-Shopify-Topic or X-Shopify-Webhook-Id'));
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return next(badRequest('Webhook body is not JSON')); }

    const r = ctx.webhooks.accept({ webhookId, topic, shop, payload });
    res.status(200).json({ received: true, duplicate: r.duplicate, status: r.status });
    // Process after responding. Failures are persisted and retried by the sweeper.
    if (!r.duplicate && r.status === 'received') setImmediate(() => ctx.webhooks.processEvent(webhookId).catch(() => {}));
  });

  app.use(express.json({ limit: '16kb' }));

  /* ---------- Public: express availability ---------- */
  const limiter = rateLimit({ perMinute: config.rateLimitPerMinute });
  app.options('/api/express-availability', cors(config.corsOrigins));
  app.post('/api/express-availability', cors(config.corsOrigins), limiter, async (req, res) => {
    res.json(await ctx.checkAvailability(req.body));
  });
  // Same endpoint behind a Shopify App Proxy (storefront calls /apps/<subpath>/express-availability).
  app.post('/proxy/express-availability', verifyAppProxy(config.shopify.apiSecret), limiter, async (req, res) => {
    res.json(await ctx.checkAvailability(req.body));
  });

  /* ---------- Admin (X-Api-Key) ---------- */
  const admin = express.Router();
  admin.use(requireApiKey(config.adminApiKey));
  admin.get('/orders/:id', (req, res) => {
    const o = ctx.orders.get(req.params.id);
    if (!o) throw notFound('ORDER_NOT_FOUND', 'No allocation recorded for this order.');
    res.json(o);
  });
  admin.get('/stock/:variantId', async (req, res) => {
    const gid = toGid('ProductVariant', req.params.variantId);
    if (!gid) throw badRequest('Invalid variant id');
    const v = await ctx.inventory.getVariant(gid);
    if (!v) throw notFound('VARIANT_NOT_FOUND', 'Variant not found');
    res.json({ variant: v, ledger: v.tracked ? ctx.inventory.ledger(v.inventoryItemId) : null, in_flight: ctx.inventory.hasPending(v.inventoryItemId) });
  });
  admin.post('/reconcile', async (req, res) => res.json(await ctx.reconciler.run()));
  admin.get('/discrepancies', (req, res) => res.json(ctx.db.prepare('SELECT * FROM discrepancies ORDER BY id DESC LIMIT 100').all()));
  admin.get('/outbox', (req, res) => res.json(ctx.outbox.list(req.query.status || 'dead')));
  admin.post('/outbox/:id/retry', (req, res) => {
    if (!ctx.outbox.requeue(Number(req.params.id))) throw notFound('JOB_NOT_FOUND', 'No dead job with that id.');
    ctx.outbox.kick();
    res.json({ requeued: true });
  });
  admin.get('/webhooks', (req, res) => res.json(ctx.webhooks.recent()));
  app.use('/api/admin', admin);

  /* ---------- Mock-only helpers: act as the shopper/merchant in the fake Shopify ---------- */
  if (ctx.shopify.mode === 'mock') {
    app.post('/__mock/orders', (req, res) => res.status(201).json(ctx.shopify.createOrder(req.body)));
    app.post('/__mock/orders/cancel', (req, res) => res.json(ctx.shopify.cancelOrder(req.body)));
  }

  app.use((req, res, next) => next(notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  app.use(errorHandler(logger));
  return app;
}
