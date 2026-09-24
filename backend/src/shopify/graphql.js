import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ShopifyError } from '../errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Access token via the client credentials grant (Dev Dashboard apps installed on a store in the same
 * organisation). Tokens expire (~24h), so we cache and refresh a few minutes early. Concurrent callers
 * share one in-flight request.
 */
export function clientCredentialsToken({ shop, clientId, clientSecret, timeoutMs = 8000, now = Date.now }) {
  let cached = null; // { token, expiresAt }
  let inflight = null;
  async function fetchToken() {
    let res;
    try {
      res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ShopifyError(`Network error fetching access token: ${err.message}`, { retryable: true, code: 'NETWORK' });
    }
    const text = await res.text();
    if (!res.ok) {
      const reason = text.match(/Oauth error ([a-z_]+)/i)?.[1] || `HTTP ${res.status}`;
      throw new ShopifyError(`Could not get an access token (${reason})`, { retryable: res.status >= 500, status: res.status, code: 'ACCESS_DENIED' });
    }
    const body = JSON.parse(text);
    cached = { token: body.access_token, expiresAt: now() + ((body.expires_in ?? 86_400) - 300) * 1000 };
    return cached.token;
  }
  const get = async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    inflight ??= fetchToken().finally(() => { inflight = null; });
    return inflight;
  };
  get.invalidate = () => { cached = null; };
  return get;
}

/**
 * Transport: Admin GraphQL over HTTPS. This is the production path. Uses SHOPIFY_ADMIN_TOKEN when set,
 * otherwise fetches one with the client credentials grant. Classifies failures so the retry loop knows
 * what is worth retrying.
 */
export function tokenTransport({ shop, apiVersion, adminToken, clientId, apiSecret, timeoutMs = 8000 }) {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const getToken = adminToken ? async () => adminToken : clientCredentialsToken({ shop, clientId, clientSecret: apiSecret, timeoutMs });
  const send = async (query, variables, retriedAuth = false) => {
    const token = await getToken();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ShopifyError(`Network error calling Shopify: ${err.message}`, { retryable: true, code: 'NETWORK' });
    }
    // A fetched token can be revoked or expire early: drop it and retry once with a fresh one.
    if (res.status === 401 && !adminToken && !retriedAuth) {
      getToken.invalidate();
      return send(query, variables, true);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 1;
      throw Object.assign(new ShopifyError('Shopify rate limit (429)', { retryable: true, status: 429, code: 'THROTTLED' }), { retryAfterMs: retryAfter * 1000 });
    }
    if (res.status >= 500) throw new ShopifyError(`Shopify ${res.status}`, { retryable: true, status: res.status, code: 'UPSTREAM_5XX' });
    if (res.status === 401 || res.status === 403) throw new ShopifyError(`Shopify rejected credentials (${res.status})`, { status: res.status, code: 'ACCESS_DENIED' });
    if (!res.ok) throw new ShopifyError(`Shopify ${res.status}`, { status: res.status });
    return res.json();
  };
  return (query, variables) => send(query, variables);
}

/**
 * Transport: dev-only. Shells out to `shopify store execute` so the API can run against a store you
 * are logged into with the Shopify CLI, without creating an app. Slow (~2s/call); never use in prod.
 */
export function cliTransport({ shop, cliEntry }) {
  const entry = cliEntry || path.join(process.env.APPDATA || path.join(os.homedir(), '.npm-global'), 'npm', 'node_modules', '@shopify', 'cli', 'bin', 'run.js');
  return (query, variables) => new Promise((resolve, reject) => {
    const args = [entry, 'store', 'execute', '--store', shop, '--query', query, '--json'];
    if (variables) args.push('--variables', JSON.stringify(variables));
    if (/^\s*mutation\b/.test(query)) args.push('--allow-mutations');
    execFile(process.execPath, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      const text = String(stdout);
      const start = text.indexOf('{');
      if (start < 0) {
        return reject(new ShopifyError(`Shopify CLI failed: ${(stderr || err?.message || '').toString().slice(0, 300)}`, { retryable: true, code: 'CLI' }));
      }
      try {
        // `store execute` prints the `data` object unwrapped; re-wrap it to match the HTTPS shape.
        resolve({ data: JSON.parse(extractJsonObject(text.slice(start))) });
      } catch (e) {
        reject(new ShopifyError(`Could not parse Shopify CLI output: ${e.message}`, { code: 'CLI' }));
      }
    });
  });
}

/** The CLI may print upgrade notices after the JSON, so walk braces instead of reading to EOF. */
function extractJsonObject(text) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  throw new Error('unterminated JSON');
}

/**
 * GraphQL client with retry: exponential backoff + jitter on network errors, 5xx, HTTP 429 and
 * GraphQL THROTTLED (for which Shopify tells us how long the cost bucket needs to refill).
 */
export function createGraphqlClient(transport, { maxAttempts = 4, baseDelayMs = 300, logger } = {}) {
  return async function request(query, variables) {
    for (let attempt = 1; ; attempt++) {
      try {
        const body = await transport(query, variables);
        const throttled = body.errors?.find((e) => e.extensions?.code === 'THROTTLED');
        if (throttled) {
          const cost = body.extensions?.cost;
          const wait = cost
            ? Math.ceil(((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) / cost.throttleStatus.restoreRate) * 1000)
            : 1000;
          throw Object.assign(new ShopifyError('Shopify GraphQL THROTTLED', { retryable: true, code: 'THROTTLED' }), { retryAfterMs: Math.max(wait, 250) });
        }
        if (body.errors?.length) {
          const msg = body.errors.map((e) => e.message).join('; ');
          const denied = body.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED');
          throw new ShopifyError(`Shopify GraphQL error: ${msg}`, { code: denied ? 'ACCESS_DENIED' : 'GRAPHQL' });
        }
        return body.data;
      } catch (err) {
        const shopifyErr = err instanceof ShopifyError ? err : new ShopifyError(err.message, { retryable: false });
        if (!shopifyErr.retryable || attempt >= maxAttempts) throw shopifyErr;
        const delay = err.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
        logger?.warn('shopify.retry', { attempt, delayMs: Math.round(delay), code: shopifyErr.code });
        await sleep(delay);
      }
    }
  };
}
