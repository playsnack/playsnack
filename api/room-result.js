// /api/room-result — a friends room's last finished game (docs/room-results.md).
//   POST {room, sid, result}  -> saved for 7 days under rr:<sha256(room id)>, write-once per game
//                                (the host device sends it when a game reaches its result)
//   GET  ?room=<id>            -> {ok, result} or 404 (opened by a device alone in that room)
// Only friends rooms (`<slug>~<code>`). Stored: the app slug, the server's save time, the
// ranking (nicknames + scores + per-room player keys p1, p2…) and, for the quiz, the
// questions with each player's pick. Never stored: the room id or code (only its hash),
// anonIds, IPs, user agents. Unlisted, not private: anyone with the link can read it.
// Free-plan guard: every KV pipeline is metered into the same ev:budget:<KST month> as
// /api/ev (store.js); past EV_MONTHLY_BUDGET no KV command is sent. Daily caps:
// RR_DAILY_SAVES (default 200) and RR_DAILY_READS (default 1000), docs/telemetry.md §5a.
import { kstDay, kstMonth } from './_lib/day.js';
import { createKvStore, createMemoryStore, kvConfig, StoreError } from './_lib/store.js';
import { createLimiter } from './_lib/ratelimit.js';
import { parseRoomResult, roomHash, RR_MAX_BODY_BYTES, sidHash, validRoomQuery } from './_lib/roomResult.js';

/** The same monthly budget as /api/ev (api/ev.js DEFAULT_MONTHLY_BUDGET — one counter for both). */
export const DEFAULT_MONTHLY_BUDGET = 400_000;
export const DEFAULT_DAILY_SAVES = 200;
export const DEFAULT_DAILY_READS = 1000;
const GET_CACHE_MS = 10_000;
const GET_CACHE_MAX = 500;
const CACHE_HEADER = 'public, max-age=10, s-maxage=10';

function json(status, body, storeKind, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-rr-store': storeKind, ...extra },
  });
}

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

const positive = (v, d) => (Number(v) > 0 ? Math.floor(Number(v)) : d);

/** Options exist for tests (env, fetch, now, memoryStore, limiter); production uses the defaults. */
export function createHandler(opts = {}) {
  const getEnv = () => opts.env || process.env;
  const getFetch = () => opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const memory = opts.memoryStore || createMemoryStore({ now });
  // Per client: a burst of 10, then one request every 6 s (a device posts once per game
  // and reads once per lonely visit). The daily caps are kept below (counted in KV).
  const limiter = opts.limiter || createLimiter({ bucketSize: 10, refillPerSec: 1 / 6, minuteCap: 300 });
  let kv = null;
  let kvId = null;
  const days = { saves: new Map(), reads: new Map() }; // day -> last count seen
  const getCache = new Map(); // roomHash -> { at, status, body }

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
  const over = (kind, day, cap) => (days[kind].get(day) || 0) >= cap;
  const note = (kind, day, n) => {
    const m = days[kind];
    if (!m.has(day)) m.clear(); // keep only today
    if (n > (m.get(day) || 0)) m.set(day, n);
  };
  const budgetReached = (store, month, env) => {
    const used = store.budgetUsed(month);
    return used !== null && used >= positive(env.EV_MONTHLY_BUDGET, DEFAULT_MONTHLY_BUDGET);
  };

  async function post(request, store, env) {
    const t = now();
    const day = kstDay(t);
    const month = kstMonth(t);
    if (limiter.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const text = await readLimited(request, RR_MAX_BODY_BYTES);
    if (text === null) return json(413, { ok: false, error: 'too_large' }, store.kind);
    const parsed = parseRoomResult(text, t);
    if (parsed.status !== 200) return json(parsed.status, { ok: false, error: parsed.error }, store.kind);
    if (over('saves', day, positive(env.RR_DAILY_SAVES, DEFAULT_DAILY_SAVES))) return json(429, { ok: false, error: 'daily_cap' }, store.kind, { 'retry-after': '3600' });
    if (budgetReached(store, month, env)) return json(503, { ok: false, error: 'budget_reached' }, store.kind, { 'x-ev-budget': 'reached' });
    const sh = sidHash(parsed.room, parsed.sid);
    // Write-once per game: a second host reporting the same game (hand-over) changes nothing.
    if (!(await store.rrClaim(sh, month))) return json(200, { ok: true, saved: false }, store.kind);
    let n;
    try {
      n = await store.rrPut(roomHash(parsed.room), JSON.stringify(parsed.record), day, month);
    } catch (e) {
      await store.rrRelease(sh, month).catch(() => {});
      throw e;
    }
    note('saves', day, n);
    getCache.delete(roomHash(parsed.room));
    return json(200, { ok: true, saved: true }, store.kind);
  }

  async function get(request, store, env) {
    const t = now();
    const day = kstDay(t);
    const month = kstMonth(t);
    if (limiter.check(request, t)) return json(429, { ok: false, error: 'rate_limited' }, store.kind, { 'retry-after': '60' });
    const room = new URL(request.url).searchParams.get('room');
    if (!validRoomQuery(room)) return json(400, { ok: false, error: 'bad_room' }, store.kind);
    const h = roomHash(room);
    const hit = getCache.get(h);
    if (!hit || t - hit.at >= GET_CACHE_MS) {
      if (over('reads', day, positive(env.RR_DAILY_READS, DEFAULT_DAILY_READS))) return json(503, { ok: false, error: 'daily_cap' }, store.kind, { 'retry-after': '3600' });
      if (budgetReached(store, month, env)) return json(503, { ok: false, error: 'budget_reached' }, store.kind, { 'x-ev-budget': 'reached' });
      const { json: stored, reads } = await store.rrGet(h, day, month);
      note('reads', day, reads);
      let result = null;
      try {
        result = stored ? JSON.parse(stored) : null;
      } catch {
        result = null;
      }
      if (getCache.size >= GET_CACHE_MAX) getCache.clear();
      getCache.set(h, { at: t, status: result ? 200 : 404, body: result ? { ok: true, result } : { ok: false, error: 'not_found' } });
    }
    const c = getCache.get(h);
    return json(c.status, c.body, store.kind, { 'cache-control': CACHE_HEADER });
  }

  return async function handler(request) {
    const env = getEnv();
    const store = storeFor(env);
    try {
      if (request.method === 'POST') return await post(request, store, env);
      if (request.method === 'GET') return await get(request, store, env);
      return json(405, { ok: false, error: 'method_not_allowed' }, store.kind, { allow: 'GET, POST' });
    } catch (e) {
      if (e instanceof StoreError) {
        console.error('[room-result] store unavailable:', e.message); // never contains request data
        return json(503, { ok: false, error: 'store_unavailable' }, store.kind, { 'retry-after': '30' });
      }
      throw e;
    }
  };
}

export const handler = createHandler();

export default { fetch: handler };
