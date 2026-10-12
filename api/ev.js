// /api/ev — anonymous product telemetry (Vercel function, Web-standard handler).
//   POST {v:1, events:[{k,...}]}  -> counts whitelisted events into per-KST-day aggregates
//   GET  ?day=YYYY-MM-DD          -> read-only aggregates (cached 30 s)
// Never stores IP, user agent, nickname, cookies, device or session ids. See docs/telemetry.md.
import { kstDay, isDay } from './_lib/day.js';
import { appIds } from './_lib/apps.js';
import { MAX_BODY_BYTES, parseBatch } from './_lib/schema.js';
import { createKvStore, createMemoryStore, kvConfig, StoreError, TOTAL_FIELD } from './_lib/store.js';
import { createLimiter } from './_lib/ratelimit.js';

const GET_CACHE_MS = 30_000;
const TOP_ERRORS = 20;

function json(status, body, storeKind, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ev-store': storeKind,
      ...extra,
    },
  });
}

/** Read the body as text, giving up once it exceeds `limit` bytes (returns null). */
async function readLimited(request, limit) {
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** "a|b|c" -> {a:{b:{c:n}}}; the running total field is reported separately. */
function nest(counts) {
  const out = {};
  for (const [field, n] of Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (field === TOTAL_FIELD) continue;
    const parts = field.split('|');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = n;
  }
  return out;
}

/**
 * Build a handler. Options exist for tests; production uses the defaults:
 * env = process.env (read per request), fetch = globalThis.fetch, now = Date.now.
 */
export function createHandler(opts = {}) {
  const getEnv = () => opts.env || process.env;
  const getFetch = () => opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const memory = opts.memoryStore || createMemoryStore();
  let limiter = opts.limiter || null;
  let limiterCap = null;
  let kv = null;
  let kvId = null;
  const getCache = new Map(); // `${store}|${day}` -> { at, body }

  function storeFor(env) {
    const cfg = kvConfig(env);
    if (!cfg) return memory;
    const id = `${cfg.url}\0${cfg.token}`;
    if (!kv || kvId !== id) {
      kv = createKvStore(cfg, (...a) => getFetch()(...a));
      kvId = id;
    }
    return kv;
  }

  function limiterFor(env) {
    if (opts.limiter) return opts.limiter;
    const cap = Number(env.EV_DAILY_CAP) > 0 ? Math.floor(Number(env.EV_DAILY_CAP)) : 20000;
    if (!limiter || limiterCap !== cap) {
      limiter = createLimiter({ dailyCap: cap });
      limiterCap = cap;
    }
    return limiter;
  }

  async function post(request, store, lim) {
    const t = now();
    const today = kstDay(t);
    if (lim.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const text = await readLimited(request, MAX_BODY_BYTES);
    if (text === null) return json(413, { ok: false, error: 'too_large' }, store.kind);
    const parsed = parseBatch(text);
    if (parsed.status !== 200) return json(parsed.status, { ok: false, error: parsed.error }, store.kind);
    if (lim.dailyCapReached(today)) return json(429, { ok: false, error: 'daily_cap' }, store.kind, { 'retry-after': '3600' });
    if (parsed.accepted > 0) {
      const total = await store.apply(today, parsed.incr, parsed.errs, parsed.accepted);
      lim.noteTotal(today, total);
    }
    return json(200, { ok: true, accepted: parsed.accepted, dropped: parsed.dropped }, store.kind);
  }

  async function get(request, store, lim) {
    const t = now();
    if (lim.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const q = new URL(request.url).searchParams.get('day');
    const day = q === null || q === '' ? kstDay(t) : q;
    if (!isDay(day)) return json(400, { ok: false, error: 'bad_day' }, store.kind);
    const cacheKey = `${store.kind}|${day}`;
    const hit = getCache.get(cacheKey);
    let body = hit && t - hit.at < GET_CACHE_MS ? hit.body : null;
    if (!body) {
      const { counts, errs } = await store.read(day);
      const top = Object.entries(errs)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_ERRORS)
        .map(([msg, count]) => ({ msg, count }));
      body = {
        ok: true,
        v: 1,
        day,
        store: store.kind,
        appsKnown: appIds().size,
        total: counts[TOTAL_FIELD] || 0,
        counters: nest(counts),
        errors: { distinct: Object.keys(errs).length, top },
      };
      if (getCache.size > 100) getCache.clear();
      getCache.set(cacheKey, { at: t, body });
    }
    return json(200, body, store.kind, { 'cache-control': 'public, max-age=30, s-maxage=30' });
  }

  return async function handler(request) {
    const env = getEnv();
    const store = storeFor(env);
    const lim = limiterFor(env);
    try {
      if (request.method === 'POST') return await post(request, store, lim);
      if (request.method === 'GET') return await get(request, store, lim);
      return json(405, { ok: false, error: 'method_not_allowed' }, store.kind, { allow: 'GET, POST' });
    } catch (e) {
      if (e instanceof StoreError) {
        console.error('[ev] store unavailable:', e.message); // message never contains request data
        return json(503, { ok: false, error: 'store_unavailable' }, store.kind, { 'retry-after': '30' });
      }
      throw e;
    }
  };
}

export const handler = createHandler();

export default { fetch: handler };
