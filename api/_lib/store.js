// Aggregate store: Upstash Redis REST (free KV) when configured, else in-memory per
// function instance. Only counters are stored — never a raw event log.
//   ev:<day>      hash  field -> count   (e.g. "open|app|quiz-ox", "room_join_ms|ok|le2000", "_total")
//   ev:<day>:err  hash  sanitized error sample -> count
// Both keys expire 90 days after the last write of the instance that set them.

export const TTL_SECONDS = 90 * 24 * 60 * 60;
export const TOTAL_FIELD = '_total';

export const dayKey = (day) => `ev:${day}`;
export const errKey = (day) => `ev:${day}:err`;

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

  return {
    kind: 'kv',
    /** Apply increments; returns the day's running event total after this write. */
    async apply(day, incr, errs, accepted) {
      const k = dayKey(day);
      const ek = errKey(day);
      const cmds = [['HINCRBY', k, TOTAL_FIELD, accepted]];
      for (const [f, n] of incr) cmds.push(['HINCRBY', k, f, n]);
      for (const [m, n] of errs) cmds.push(['HINCRBY', ek, m, n]);
      const ttl = [];
      if (!expired.has(k)) ttl.push(k);
      if (errs.size && !expired.has(ek)) ttl.push(ek);
      for (const key of ttl) cmds.push(['EXPIRE', key, TTL_SECONDS]);
      const out = await pipeline(cmds);
      for (const key of ttl) expired.add(key);
      return Number(out[0]) || 0;
    },
    async read(day) {
      const [counts, errSamples] = await pipeline([
        ['HGETALL', dayKey(day)],
        ['HGETALL', errKey(day)],
      ]);
      return { counts: pairsToObject(counts), errs: pairsToObject(errSamples) };
    },
  };
}

export function createMemoryStore() {
  const data = new Map(); // key -> Map(field -> count)
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
    async apply(day, incr, errs, accepted) {
      const h = hash(dayKey(day));
      const total = bump(h, TOTAL_FIELD, accepted);
      for (const [f, n] of incr) bump(h, f, n);
      if (errs.size) {
        const e = hash(errKey(day));
        for (const [m, n] of errs) bump(e, m, n);
      }
      return total;
    },
    async read(day) {
      return {
        counts: Object.fromEntries(data.get(dayKey(day)) || []),
        errs: Object.fromEntries(data.get(errKey(day)) || []),
      };
    },
  };
}
