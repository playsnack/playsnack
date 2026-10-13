// Rate limiting that persists nothing.
//  1. Per-client token bucket, per function instance, keyed by
//     SHA-256(random per-instance salt + KST day + client address), truncated.
//     The address is only hashed in memory; it is never stored, logged or sent anywhere.
//     The salt is regenerated (and all buckets dropped) when the KST day changes.
//  2. Per-instance cap on requests per minute.
//  3. Daily event cap (EV_DAILY_CAP, default 5000), checked against the running
//     total that every store write returns.
import { createHash, randomBytes } from 'node:crypto';
import { kstDay } from './day.js';

export const DEFAULTS = {
  bucketSize: 20, // burst of requests per client
  refillPerSec: 0.5, // 30 requests/minute sustained per client
  minuteCap: 600, // requests per instance per minute
  dailyCap: 5000, // events per KST day (all instances) — sized for the Upstash free tier (docs/telemetry.md §8)
  maxClients: 10000, // bucket map size bound
};

/** First client address from proxy headers ("unknown" if none). Only ever hashed. */
export function clientAddress(request) {
  const h = request.headers;
  const raw = h.get('x-vercel-forwarded-for') || h.get('x-forwarded-for') || h.get('x-real-ip') || '';
  return raw.split(',')[0].trim() || 'unknown';
}

export function createLimiter(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let day = null;
  let salt = null;
  const buckets = new Map(); // hashed key -> { tokens, at }
  let minute = -1;
  let minuteCount = 0;
  const totals = new Map(); // day -> last known running total

  function rotate(today) {
    if (today === day) return;
    day = today;
    salt = randomBytes(16);
    buckets.clear();
    for (const d of totals.keys()) if (d !== today) totals.delete(d);
  }

  function keyFor(address, today) {
    rotate(today);
    return createHash('sha256').update(salt).update(today).update('\0').update(address).digest('hex').slice(0, 24);
  }

  return {
    cfg,
    buckets, // exposed for tests (privacy assertions)
    keyFor,
    /** Returns null when allowed, or a reason string when the request must be rejected. */
    check(request, now = Date.now()) {
      const today = kstDay(now);
      const key = keyFor(clientAddress(request), today);

      const m = Math.floor(now / 60000);
      if (m !== minute) {
        minute = m;
        minuteCount = 0;
      }
      if (minuteCount >= cfg.minuteCap) return 'instance_minute_cap';

      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= cfg.maxClients) buckets.delete(buckets.keys().next().value);
        b = { tokens: cfg.bucketSize, at: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(cfg.bucketSize, b.tokens + ((now - b.at) / 1000) * cfg.refillPerSec);
      b.at = now;
      if (b.tokens < 1) return 'client_rate';
      b.tokens -= 1;
      minuteCount++;
      return null;
    },
    dailyCapReached(today) {
      return (totals.get(today) || 0) >= cfg.dailyCap;
    },
    noteTotal(today, total) {
      if (total > (totals.get(today) || 0)) totals.set(today, total);
    },
  };
}
