// Aggregate store: Upstash Redis REST (free KV) when configured, else in-memory per
// function instance. Only counters are stored — never a raw event log.
// Key names are readable English, `:` namespaces, `_` between words (docs/telemetry.md §3):
//   stats:daily:<YYYY-MM-DD KST>   hash  field -> count (e.g. "games_finished_by_app:quiz-ox",
//                                        "join_ms_bucket:1-2s", "events_total")
//   stats:errors:<YYYY-MM-DD KST>  hash  sanitized error message -> count
// Both expire 90 days after the last write of the instance that set them.
//   stats:all_time                 hash  all-time counters for a fixed field list (no expiry; §9)
//   stats:dedupe:<hash>            string, 6 h — "this game was already counted" (hash of kind + game id)
//   stats:budget:<YYYY-MM KST>     integer, ~40 days — Upstash commands this deployment sent that month
// Other features keep their own top-level namespace in the same style — e.g. room results
// use roomResultKey() = results:room:<hash>. Old `ev:*` keys are no longer read
// (api/_tools/cleanup-old-keys.mjs deletes them when run by hand).
//
// Free-plan guard: EVERY KV pipeline (apply, claim, release, read, readDays) starts with
// INCRBY stats:budget:<month> <n>, n = the exact number of commands in that pipeline (the
// INCRBY and the once-per-instance EXPIRE included). The reply is the month's running
// count; the handler stops talking to KV once it reaches EV_MONTHLY_BUDGET (api/ev.js).

export const TTL_SECONDS = 90 * 24 * 60 * 60;
export const ONCE_TTL_SECONDS = 6 * 60 * 60;
export const BUDGET_TTL_SECONDS = 40 * 24 * 60 * 60;
/** Events received that day (accepted + rejected) — the daily cap reads it back. */
export const TOTAL_FIELD = 'events_total';

export const dayKey = (day) => `stats:daily:${day}`;
export const errKey = (day) => `stats:errors:${day}`;
export const ALL_KEY = 'stats:all_time';
export const onceKey = (id) => `stats:dedupe:${id}`;
export const budgetKey = (month) => `stats:budget:${month}`;
/** Room results (the room-result lane): one key per room, `<hash>` = a hash, never a room code. */
export const roomResultKey = (hash) => `results:room:${hash}`;
/** Keys written before the readable scheme (2026-10-13/14 testing); nothing reads them. */
export const OLD_KEY_PATTERN = 'ev:*';

export class StoreError extends Error {}

/** Resolve Upstash REST credentials from env (Upstash names first, Vercel KV names second). */
export function kvConfig(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? { url: String(url).replace(/\/+$/, ''), token: String(token) } : null;
}

function pairsToObject(arr) {
  const out = {};
  if (Array.isArray(arr)) {
    for (let i = 0; i + 1 < arr.length; i += 2) out[arr[i]] = Number(arr[i + 1]) || 0;
  } else if (arr && typeof arr === 'object') {
    for (const [f, v] of Object.entries(arr)) out[f] = Number(v) || 0;
  }
  return out;
}

export function createKvStore({ url, token }, fetchImpl = globalThis.fetch) {
  const expired = new Set(); // keys this instance already set a TTL on (saves commands)
  let seen = { month: null, used: 0 }; // last budget count this instance got back

  async function pipeline(commands) {
    let res;
    try {
      res = await fetchImpl(`${url}/pipeline`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(commands),
      });
    } catch (e) {
      throw new StoreError(`kv fetch failed: ${e && e.name}`);
    }
    if (!res.ok) throw new StoreError(`kv http ${res.status}`);
    let out;
    try {
      out = await res.json();
    } catch {
      throw new StoreError('kv bad response');
    }
    if (!Array.isArray(out) || out.length !== commands.length) throw new StoreError('kv bad response');
    for (const r of out) if (!r || r.error) throw new StoreError('kv command error');
    return out.map((r) => r.result);
  }

  /** Send `cmds` behind the month's budget INCRBY (+ EXPIRE once per instance); returns their results. */
  async function metered(month, cmds) {
    const bk = budgetKey(month);
    const ttl = !expired.has(bk);
    const n = cmds.length + 1 + (ttl ? 1 : 0); // exactly what this pipeline sends
    const head = [['INCRBY', bk, n]];
    if (ttl) head.push(['EXPIRE', bk, BUDGET_TTL_SECONDS]);
    const out = await pipeline([...head, ...cmds]);
    if (ttl) expired.add(bk);
    const used = Number(out[0]) || 0;
    if (seen.month !== month) seen = { month, used };
    else if (used > seen.used) seen.used = used;
    return out.slice(head.length);
  }

  return {
    kind: 'kv',
    /** The month's command count from the last KV reply this instance saw (null if none yet). */
    budgetUsed(month) {
      return seen.month === month ? seen.used : null;
    },
    /** Apply increments; returns the day's running event total after this write. */
    async apply(day, incr, errs, accepted, all = new Map(), month) {
      const k = dayKey(day);
      const ek = errKey(day);
      const cmds = [['HINCRBY', k, TOTAL_FIELD, accepted]];
      for (const [f, n] of incr) cmds.push(['HINCRBY', k, f, n]);
      for (const [m, n] of errs) cmds.push(['HINCRBY', ek, m, n]);
      for (const [f, n] of all) cmds.push(['HINCRBY', ALL_KEY, f, n]);
      const ttl = [];
      if (!expired.has(k)) ttl.push(k);
      if (errs.size && !expired.has(ek)) ttl.push(ek);
      for (const key of ttl) cmds.push(['EXPIRE', key, TTL_SECONDS]);
      const out = await metered(month, cmds);
      for (const key of ttl) expired.add(key);
      return Number(out[0]) || 0;
    },
    /** Claim de-dup ids; returns one boolean per id: true = first time seen (within the TTL). */
    async claim(ids, month, ttl = ONCE_TTL_SECONDS) {
      if (!ids.length) return [];
      const out = await metered(month, ids.map((id) => ['SET', onceKey(id), '1', 'NX', 'EX', ttl]));
      return out.map((r) => r === 'OK');
    },
    /** Undo claims whose counts could not be written (so another host's report still counts). */
    async release(ids, month) {
      if (ids.length) await metered(month, ids.map((id) => ['DEL', onceKey(id)]));
    },
    async read(day, month) {
      const [counts, errSamples, all] = await metered(month, [
        ['HGETALL', dayKey(day)],
        ['HGETALL', errKey(day)],
        ['HGETALL', ALL_KEY],
      ]);
      return { counts: pairsToObject(counts), errs: pairsToObject(errSamples), all: pairsToObject(all) };
    },
    /** Day counters for several days (one request) + the all-time counters. */
    async readDays(days, month) {
      const out = await metered(month, [...days.map((d) => ['HGETALL', dayKey(d)]), ['HGETALL', ALL_KEY]]);
      return { days: out.slice(0, days.length).map(pairsToObject), all: pairsToObject(out[days.length]) };
    },
  };
}

export function createMemoryStore({ now = Date.now } = {}) {
  const data = new Map(); // key -> Map(field -> count)
  const once = new Map(); // onceKey -> expiry (ms)
  const hash = (key) => {
    if (!data.has(key)) data.set(key, new Map());
    return data.get(key);
  };
  const bump = (h, f, n) => {
    const v = (h.get(f) || 0) + n;
    h.set(f, v);
    return v;
  };
  return {
    kind: 'memory',
    data, // exposed for tests (privacy assertions)
    once, // exposed for tests (privacy assertions)
    budgetUsed: () => null, // no KV commands are spent
    async apply(day, incr, errs, accepted, all = new Map()) {
      const h = hash(dayKey(day));
      const total = bump(h, TOTAL_FIELD, accepted);
      for (const [f, n] of incr) bump(h, f, n);
      if (errs.size) {
        const e = hash(errKey(day));
        for (const [m, n] of errs) bump(e, m, n);
      }
      if (all.size) {
        const a = hash(ALL_KEY);
        for (const [f, n] of all) bump(a, f, n);
      }
      return total;
    },
    async claim(ids, _month, ttl = ONCE_TTL_SECONDS) {
      const t = now();
      if (once.size > 10000) for (const [k, exp] of once) if (exp <= t) once.delete(k);
      return ids.map((id) => {
        const k = onceKey(id);
        if ((once.get(k) || 0) > t) return false;
        once.set(k, t + ttl * 1000);
        return true;
      });
    },
    async release(ids) {
      for (const id of ids) once.delete(onceKey(id));
    },
    async read(day) {
      return {
        counts: Object.fromEntries(data.get(dayKey(day)) || []),
        errs: Object.fromEntries(data.get(errKey(day)) || []),
        all: Object.fromEntries(data.get(ALL_KEY) || []),
      };
    },
    async readDays(days) {
      return {
        days: days.map((d) => Object.fromEntries(data.get(dayKey(d)) || [])),
        all: Object.fromEntries(data.get(ALL_KEY) || []),
      };
    },
  };
}
