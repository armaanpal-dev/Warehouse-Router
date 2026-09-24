import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp, createContext } from './app.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const ctx = createContext(config, { logger });
const app = createApp(ctx);

ctx.outbox.start(2000);
const sweeper = setInterval(() => ctx.webhooks.sweep().catch((e) => logger.error('sweep.failed', { error: e.message })), 5000);
const reconcile = setInterval(() => ctx.reconciler.run().catch((e) => logger.error('reconcile.failed', { error: e.message })), config.reconcileIntervalMs);
ctx.webhooks.sweep().catch(() => {}); // pick up anything accepted before a restart

const server = app.listen(config.port, () => {
  logger.info('server.listening', { port: config.port, shopifyMode: config.shopify.mode, shop: config.shopify.shop });
});

function shutdown(signal) {
  logger.info('server.shutdown', { signal });
  clearInterval(sweeper);
  clearInterval(reconcile);
  server.close(async () => {
    await ctx.outbox.stop();
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
