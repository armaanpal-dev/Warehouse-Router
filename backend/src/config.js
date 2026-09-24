import fs from 'node:fs';

/** Loads .env (if present) and validates configuration. Fails fast at boot, not at first request. */
export function loadConfig(env = process.env, { envFile = '.env', requireLocations = true } = {}) {
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const num = (key, def) => {
    const v = env[key] === undefined || env[key] === '' ? def : Number(env[key]);
    if (!Number.isFinite(v)) throw new Error(`Config ${key} must be a number`);
    return v;
  };

  const config = {
    port: num('PORT', 3000),
    env: env.NODE_ENV || 'development',
    logLevel: env.LOG_LEVEL || 'info',
    shopify: {
      mode: env.SHOPIFY_MODE || 'mock',
      shop: env.SHOPIFY_SHOP || 'mock-shop.myshopify.com',
      apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
      adminToken: env.SHOPIFY_ADMIN_TOKEN || '',
      clientId: env.SHOPIFY_CLIENT_ID || '',
      apiSecret: env.SHOPIFY_API_SECRET || '',
    },
    warehouseLocations: {
      DEL: env.WAREHOUSE_DEL_LOCATION_ID || '',
      BLR: env.WAREHOUSE_BLR_LOCATION_ID || '',
      BOM: env.WAREHOUSE_BOM_LOCATION_ID || '',
    },
    adminApiKey: env.ADMIN_API_KEY || '',
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    databasePath: env.DATABASE_PATH || './data/app.db',
    inventoryCacheMs: num('INVENTORY_CACHE_MS', 10_000),
    staleMaxMs: num('STALE_MAX_MS', 300_000),
    reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 300_000),
    rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 60),
  };

  const problems = [];
  if (!['mock', 'token', 'cli'].includes(config.shopify.mode)) problems.push('SHOPIFY_MODE must be mock, token or cli');
  if (config.shopify.mode === 'token' && !config.shopify.adminToken && !(config.shopify.clientId && config.shopify.apiSecret)) {
    problems.push('token mode needs SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_API_SECRET');
  }
  if (config.shopify.mode !== 'mock' && requireLocations) {
    for (const [code, id] of Object.entries(config.warehouseLocations)) {
      if (!/^gid:\/\/shopify\/Location\/\d+$/.test(id)) problems.push(`WAREHOUSE_${code}_LOCATION_ID must be a Location GID`);
    }
  }
  if (config.env === 'production') {
    if (config.shopify.apiSecret.length < 16) problems.push('SHOPIFY_API_SECRET is required in production');
    if (config.adminApiKey.length < 16) problems.push('ADMIN_API_KEY must be at least 16 characters in production');
  }
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
  return config;
}
