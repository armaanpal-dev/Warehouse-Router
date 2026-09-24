import crypto from 'node:crypto';
import { AppError, ShopifyError, unauthorized } from './errors.js';

export function requestId(req, res, next) {
  req.id = req.get('X-Request-Id')?.slice(0, 64) || crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

export function securityHeaders(req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  next();
}

/** CORS for browser calls from the storefront (allow-list only), including Chrome's private-network preflight. */
export function cors(origins) {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && origins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      if (req.method === 'OPTIONS') {
        res.set({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
        if (req.get('Access-Control-Request-Private-Network')) res.set('Access-Control-Allow-Private-Network', 'true');
        return res.status(204).end();
      }
    } else if (req.method === 'OPTIONS') {
      return res.status(204).end(); // no CORS headers: the browser blocks it
    }
    next();
  };
}

/** Fixed-window rate limit per client IP. In-memory: fine for one instance; use Redis when scaled out. */
export function rateLimit({ perMinute, now = Date.now }) {
  const hits = new Map();
  setInterval(() => { const t = now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, 60_000).unref();
  return (req, res, next) => {
    const t = now();
    const key = req.ip;
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { count: 0, reset: t + 60_000 }; hits.set(key, h); }
    h.count++;
    res.set({ 'RateLimit-Limit': String(perMinute), 'RateLimit-Remaining': String(Math.max(0, perMinute - h.count)) });
    if (h.count > perMinute) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.'));
    }
    next();
  };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function requireApiKey(key) {
  return (req, res, next) => {
    if (!key) return next(new AppError(503, 'ADMIN_DISABLED', 'Admin API is disabled: ADMIN_API_KEY is not set.'));
    if (!safeEqual(req.get('X-Api-Key') || '', key)) return next(unauthorized());
    next();
  };
}

/**
 * Shopify App Proxy signature: hex HMAC-SHA256 of the query params (minus `signature`), sorted,
 * joined as `key=value` with array values comma-joined, and no separator between pairs.
 */
export function verifyAppProxy(secret) {
  return (req, res, next) => {
    const { signature, ...params } = req.query;
    if (!signature || !secret) return next(unauthorized('Invalid app proxy signature'));
    const message = Object.keys(params).sort()
      .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`).join('');
    const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
    if (!safeEqual(signature, expected)) return next(unauthorized('Invalid app proxy signature'));
    next();
  };
}

/** One error shape for every failure: { error: { code, message, details? }, request_id }. */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'Something went wrong.', details;
    if (err instanceof AppError) ({ status, code, message, details } = err);
    else if (err instanceof ShopifyError) {
      status = err.retryable ? 503 : 502;
      code = err.retryable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR';
      message = err.retryable ? 'Shopify is temporarily unavailable. Please retry.' : 'Shopify rejected the request.';
    } else if (err.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Request body is not valid JSON.'; }
    else if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large.'; }

    const log = status >= 500 ? 'error' : 'warn';
    logger?.[log]('request.error', { requestId: req.id, path: req.path, status, code, error: err.message, ...(status >= 500 && { stack: err.stack }) });
    res.status(status).json({ error: { code, message, ...(details && { details }) }, request_id: req.id });
  };
}
