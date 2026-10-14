// /api/ev — anonymous product telemetry (Vercel function, Web-standard handler).
//   POST {v:1, events:[{k,...}]}  -> counts whitelisted events into per-KST-day aggregates
//   GET  ?day=YYYY-MM-DD          -> read-only aggregates (cached 30 s; today-90 … today+1 only)
//   GET  ?week=YYYY-Www           -> the same, summed over an ISO week's readable days (KST)
// Never stores IP, user agent, nickname, cookies, device or browser-session ids; a random
// per-game id (`sid` / `gid`) is sent and kept only as a 6 h de-dup hash. A request with
// a privacy signal (Sec-GPC: 1 or DNT: 1) is not counted. See docs/telemetry.md.
// Free-plan guard: every KV pipeline is metered into ev:budget:<KST month> (store.js); once
// the month's count reaches EV_MONTHLY_BUDGET (default 400000 = 80% of Upstash Free's 500K
// commands/month) this instance sends no more KV commands that month (docs/telemetry.md §5a).
import { kstDay, kstMonth, isDay, daysAgo, isoWeek, weekDays } from './_lib/day.js';
import { appIds } from './_lib/apps.js';
import { MAX_BODY_BYTES, parseBatch, settleOnce, summarize, WIRED } from './_lib/schema.js';
import { createKvStore, createMemoryStore, kvConfig, StoreError, TOTAL_FIELD, TTL_SECONDS } from './_lib/store.js';
import { createLimiter, DEFAULTS } from './_lib/ratelimit.js';

/** The browser asked not to be tracked (the client already stays silent; this covers any other sender). */
const privacySignal = (request) => request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1';

const GET_CACHE_MS = 30_000;
// Readable days (≤ 92) + readable ISO weeks (≤ 15) all fit, so the cache never thrashes.
const GET_CACHE_MAX = 128;
const TOP_ERRORS = 20;
export const DEFAULT_DAILY_CAP = DEFAULTS.dailyCap;
export const DEFAULT_MONTHLY_BUDGET = 400_000;
const MAX_ERR_LOG_LINES = 5; // per request, to Vercel's runtime log (console.error)
// Readable days: the retention window (keys expire after TTL_SECONDS) plus tomorrow
// (a client clock ahead of KST). Anything else is 400 — so an attacker cannot
// bypass the 30 s per-day cache with an unbounded stream of distinct days.
const RETENTION_DAYS = TTL_SECONDS / 86_400;
const FUTURE_DAYS = 1;

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
  const memory = opts.memoryStore || createMemoryStore({ now });
  let limiter = opts.limiter || null;
  let limiterCap = null;
  let kv = null;
  let kvId = null;
  const getCache = new Map(); // `${store}|${day}` or `${store}|${week}` -> { at, body }

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
    const cap = Number(env.EV_DAILY_CAP) > 0 ? Math.floor(Number(env.EV_DAILY_CAP)) : DEFAULTS.dailyCap;
    if (!limiter || limiterCap !== cap) {
      limiter = createLimiter({ dailyCap: cap });
      limiterCap = cap;
    }
    return limiter;
  }

  function budgetLimit(env) {
    return Number(env.EV_MONTHLY_BUDGET) > 0 ? Math.floor(Number(env.EV_MONTHLY_BUDGET)) : DEFAULT_MONTHLY_BUDGET;
  }

  /** True once a KV reply showed the month's command count at or past the budget. */
  function budgetReached(store, month, limit) {
    const used = store.budgetUsed(month);
    return used !== null && used >= limit;
  }

  async function post(request, store, lim, limit) {
    const t = now();
    const today = kstDay(t);
    const month = kstMonth(t);
    if (privacySignal(request)) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-ev-store': store.kind } });
    if (lim.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const text = await readLimited(request, MAX_BODY_BYTES);
    if (text === null) return json(413, { ok: false, error: 'too_large' }, store.kind);
    const parsed = parseBatch(text);
    if (parsed.status !== 200) return json(parsed.status, { ok: false, error: parsed.error }, store.kind);
    // Live error lines for Vercel's Logs tab: sanitized message, where, build — nothing else
    // from the request. Free (no KV), so they keep flowing past the caps below.
    for (const e of parsed.errLines.slice(0, MAX_ERR_LOG_LINES)) {
      console.error(`[ev] err where=${e.where || '-'} build=${e.build || '-'}: ${e.msg}`);
    }
    if (lim.dailyCapReached(today)) return json(429, { ok: false, error: 'daily_cap' }, store.kind, { 'retry-after': '3600' });
    const received = parsed.accepted + parsed.badCount; // both use KV commands → both count toward the cap
    if (received > 0) {
      if (budgetReached(store, month, limit)) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'x-ev-store': store.kind, 'x-ev-budget': 'reached' } });
      // Host-engine events (a finished game, a rematch, a made quiz) count once per id,
      // even when two hosts report the same game across a hand-over. Upstash cannot
      // increment conditionally inside one pipeline, so: claim → apply, and if the apply
      // fails, release the claims (best effort) so the other host's report still counts.
      const ids = parsed.once.map((o) => o.id);
      const fresh = ids.length ? await store.claim(ids, month) : [];
      settleOnce(parsed, fresh);
      let total;
      try {
        total = await store.apply(today, parsed.incr, parsed.errs, received, parsed.all, month);
      } catch (e) {
        const mine = ids.filter((_, i) => fresh[i]);
        if (mine.length) await store.release(mine, month).catch(() => {});
        throw e;
      }
      lim.noteTotal(today, total);
    }
    return json(200, { ok: true, accepted: parsed.accepted, dropped: parsed.dropped }, store.kind);
  }

  const readable = (day, t) => {
    const age = daysAgo(day, t);
    return age <= RETENTION_DAYS && age >= -FUTURE_DAYS;
  };
  const cached = (key, t) => {
    const hit = getCache.get(key);
    return hit && t - hit.at < GET_CACHE_MS ? hit.body : null;
  };
  const remember = (key, t, body) => {
    if (getCache.size >= GET_CACHE_MAX) getCache.clear();
    getCache.set(key, { at: t, body });
  };
  // Past the month's budget: no KV command. The last body this instance read (stale), or say so.
  const pastBudget = (key, store, month, limit, extra) => {
    const budget = { month, used: store.budgetUsed(month), limit };
    const hit = getCache.get(key);
    const headers = { 'x-ev-budget': 'reached' };
    if (hit) return json(200, { ...hit.body, stale: true, budget }, store.kind, headers);
    return json(200, { ok: false, error: 'budget_reached', v: 1, ...extra, store: store.kind, budget }, store.kind, headers);
  };
  const ok = (body, store) => json(200, body, store.kind, { 'cache-control': 'public, max-age=30, s-maxage=30' });

  async function get(request, store, lim, limit) {
    const t = now();
    const month = kstMonth(t);
    if (lim.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const params = new URL(request.url).searchParams;
    if (params.has('week')) return getWeek(params.get('week'), store, t, month, limit);
    const q = params.get('day');
    const day = q === null || q === '' ? kstDay(t) : q;
    if (!isDay(day)) return json(400, { ok: false, error: 'bad_day' }, store.kind);
    if (!readable(day, t)) return json(400, { ok: false, error: 'day_out_of_range' }, store.kind);
    const cacheKey = `${store.kind}|${day}`;
    let body = cached(cacheKey, t);
    if (!body && budgetReached(store, month, limit)) return pastBudget(cacheKey, store, month, limit, { day });
    if (!body) {
      const { counts, errs, all } = await store.read(day, month);
      const top = Object.entries(errs)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_ERRORS)
        .map(([msg, count]) => ({ msg, count }));
      body = {
        ok: true,
        v: 1,
        day,
        store: store.kind,
        wired: WIRED,
        appsKnown: appIds().size,
        total: counts[TOTAL_FIELD] || 0,
        summary: summarize(counts),
        counters: nest(counts),
        cumulative: nest(all),
        errors: { distinct: Object.keys(errs).length, top },
        budget: { month, used: store.budgetUsed(month), limit },
      };
      remember(cacheKey, t, body);
    }
    return ok(body, store);
  }

  // A week = its days inside the readable window only (so ≤ 15 weeks are accepted and
  // each read is one request of ≤ 8 HGETALLs); error samples stay per day (?day=).
  async function getWeek(q, store, t, month, limit) {
    const week = q === '' ? isoWeek(kstDay(t)) : q;
    const all7 = weekDays(week);
    if (!all7) return json(400, { ok: false, error: 'bad_week' }, store.kind);
    const days = all7.filter((d) => readable(d, t));
    if (!days.length) return json(400, { ok: false, error: 'week_out_of_range' }, store.kind);
    const cacheKey = `${store.kind}|${week}`;
    let body = cached(cacheKey, t);
    if (!body && budgetReached(store, month, limit)) return pastBudget(cacheKey, store, month, limit, { week });
    if (!body) {
      const read = await store.readDays(days, month);
      const sum = {};
      for (const c of read.days) for (const [f, n] of Object.entries(c)) sum[f] = (sum[f] || 0) + n;
      body = {
        ok: true,
        v: 1,
        week,
        days,
        store: store.kind,
        wired: WIRED,
        appsKnown: appIds().size,
        total: sum[TOTAL_FIELD] || 0,
        summary: summarize(sum),
        counters: nest(sum),
        cumulative: nest(read.all),
        budget: { month, used: store.budgetUsed(month), limit },
      };
      remember(cacheKey, t, body);
    }
    return ok(body, store);
  }

  return async function handler(request) {
    const env = getEnv();
    const store = storeFor(env);
    const lim = limiterFor(env);
    const limit = budgetLimit(env);
    try {
      if (request.method === 'POST') return await post(request, store, lim, limit);
      if (request.method === 'GET') return await get(request, store, lim, limit);
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
