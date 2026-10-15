// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, handler as realHandler } from '../ev.js';
import defaultExport from '../ev.js';
import { sanitizeErr, timeBucket } from '../_lib/schema.js';
import { kstDay, isDay, daysAgo } from '../_lib/day.js';
import { createLimiter } from '../_lib/ratelimit.js';

const URL_EV = 'https://playsnack.test/api/ev';
const post = (body, headers = {}) =>
  new Request(URL_EV, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (q = '') => new Request(URL_EV + q);
const memEnv = {}; // no KV vars -> memory store

test('default export is a Vercel fetch handler wired to the real handler', () => {
  assert.equal(typeof defaultExport.fetch, 'function');
  assert.equal(defaultExport.fetch, realHandler);
});

test('valid batch is counted, invalid events dropped, unknown fields ignored', async () => {
  const h = createHandler({ env: memEnv });
  const res = await h(
    post({
      v: 1,
      events: [
        { k: 'open', route: 'app', app: 'quiz-ox', extra: 'ignored' },
        { k: 'open', route: 'home' },
        { k: 'open', route: 'nope' }, // bad value -> dropped
        { k: 'first_tap', ms: 730, app: 'quiz-ox' },
        { k: 'first_tap', ms: -5 }, // bad ms -> dropped
        { k: 'result', app: 'not-an-official-app' }, // -> app "other"
        { k: 'share', method: 'kakao', app: 'worldcup-food' },
        { k: 'share', method: 'fax' }, // dropped
        { k: 'room_join', ok: true, ms: 1500 },
        { k: 'room_join', ok: false },
        { k: 'room_join', ok: 'yes' }, // dropped
        { k: 'err', msg: 'TypeError: x is undefined', where: 'BitePlayer', build: 'a1b2c3d' },
        { k: 'telemetry_of_doom' }, // unknown kind -> dropped
        'not an object',
      ],
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ev-store'), 'memory');
  assert.deepEqual(await res.json(), { ok: true, accepted: 8, dropped: 6 });

  const g = await h(get());
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('x-ev-store'), 'memory');
  assert.match(g.headers.get('cache-control'), /max-age=30/);
  const a = await g.json();
  assert.equal(a.day, kstDay());
  assert.equal(a.total, 12, '8 accepted + 4 known-kind events dropped by validation');
  assert.equal(a.appsKnown, 44);
  // Stored as readable names (docs/telemetry.md §3), returned flat and sorted.
  assert.deepEqual(a.counters, {
    'errors_by_build:a1b2c3d': 1,
    'errors_by_where:BitePlayer': 1,
    errors_total: 1,
    'first_tap_ms_bucket:0-1s': 1,
    first_taps: 1,
    'first_taps_by_app:quiz-ox': 1,
    join_attempts: 2,
    'join_ms_bucket:1-2s': 1,
    joins_failed: 1,
    joins_ok: 1,
    page_opens: 2,
    'page_opens_by_app:quiz-ox': 1,
    'page_opens_by_route:app': 1,
    'page_opens_by_route:home': 1,
    'rejected_events:first_tap': 1,
    'rejected_events:open': 1,
    'rejected_events:room_join': 1,
    'rejected_events:share': 1,
    results_shown: 1,
    'results_shown_by_app:other': 1,
    shares: 1,
    'shares_by_app:worldcup-food': 1,
    'shares_by_method:kakao': 1,
  });
  assert.deepEqual(Object.keys(a.counters), Object.keys(a.counters).sort());
  assert.deepEqual(a.errors.top, [{ msg: 'TypeError: x is undefined', count: 1 }]);
  // Known kinds that failed validation are visible (unknown kinds and non-objects are not).
  assert.deepEqual(a.summary.bad, { first_tap: 1, open: 1, room_join: 1, share: 1 });
});

test('rejections: 413 oversized, 400 bad json / wrong v / >20 events, 405 method', async () => {
  const h = createHandler({ env: memEnv });
  const big = JSON.stringify({ v: 1, events: [{ k: 'err', msg: 'x'.repeat(5000) }] });
  assert.equal((await h(post(big))).status, 413);
  // Also enforced when the client lies about content-length (streamed body).
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(big));
      c.close();
    },
  });
  assert.equal((await h(new Request(URL_EV, { method: 'POST', body: stream, duplex: 'half' }))).status, 413);
  assert.equal((await h(post('{not json'))).status, 400);
  assert.equal((await h(post({ v: 2, events: [] }))).status, 400);
  assert.equal((await h(post({ v: 1 }))).status, 400);
  const many = Array.from({ length: 21 }, () => ({ k: 'result' }));
  const r = await h(post({ v: 1, events: many }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'too_many_events');
  assert.equal((await h(post({ v: 1, events: many.slice(0, 20) }))).status, 200);
  assert.equal((await h(new Request(URL_EV, { method: 'PUT', body: '{}' }))).status, 405);
  assert.equal((await h(get('?day=2026-13-40'))).status, 400);
  assert.equal((await h(get('?day=' + kstDay()))).status, 200);
});

test('GET day must be within retention: today-90 … today+1, else 400 day_out_of_range', async () => {
  const t = Date.parse('2026-10-12T03:00:00Z'); // KST 2026-10-12 12:00
  const h = createHandler({ env: memEnv, now: () => t });
  const status = async (day) => {
    const r = await h(get(`?day=${day}`));
    return r.status === 200 ? 200 : `${r.status} ${(await r.json()).error}`;
  };
  assert.equal(await status('2026-10-12'), 200); // today
  assert.equal(await status('2026-10-13'), 200); // tomorrow (client clock ahead)
  assert.equal(await status('2026-07-14'), 200); // today-90 = last day a key can still exist
  assert.equal(await status('2026-07-13'), '400 day_out_of_range');
  assert.equal(await status('2026-10-14'), '400 day_out_of_range');
  assert.equal(await status('1999-01-01'), '400 day_out_of_range');
  assert.equal(await status('2999-01-01'), '400 day_out_of_range');
  assert.equal(await status('2026-02-30'), '400 bad_day');
  assert.equal(await status(''), 200); // default = today
  // Each in-range day is cached on its own (second read within 30 s hits the cache).
  const r1 = await h(get('?day=2026-10-11'));
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).day, '2026-10-11');
  assert.equal(daysAgo('2026-10-11', t), 1);
  assert.equal(daysAgo('2026-10-13', t), -1);
});

test('missing env -> in-memory fallback through the real exported handler', async () => {
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
    delete process.env[k];
  }
  const res = await realHandler(post({ v: 1, events: [{ k: 'open', route: 'create' }] }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ev-store'), 'memory');
  const after = await realHandler(get('?day=' + kstDay()));
  assert.equal(after.headers.get('x-ev-store'), 'memory');
  const a = await after.json();
  assert.equal(a.store, 'memory');
  assert.ok(a.counters['page_opens_by_route:create'] >= 1);
});

test('rate limits: per-client bucket, per-instance minute cap, daily cap', async () => {
  let t = Date.parse('2026-10-12T03:00:00Z');
  const lim = createLimiter({ bucketSize: 3, refillPerSec: 0, minuteCap: 1000, dailyCap: 5 });
  const h = createHandler({ env: memEnv, limiter: lim, now: () => t });
  const a = { 'x-forwarded-for': '203.0.113.7' };
  const b = { 'x-forwarded-for': '198.51.100.9' };
  const one = { v: 1, events: [{ k: 'result' }, { k: 'result' }] };
  assert.equal((await h(post(one, a))).status, 200);
  assert.equal((await h(post(one, a))).status, 200);
  assert.equal((await h(post(one, a))).status, 200); // total now 6 >= cap 5
  const r = await h(post(one, a));
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'rate_limited');
  const d = await h(post(one, b)); // other client still has tokens, but daily cap is reached
  assert.equal(d.status, 429);
  assert.equal((await d.json()).error, 'daily_cap');

  const lim2 = createLimiter({ bucketSize: 100, minuteCap: 2 });
  const h2 = createHandler({ env: memEnv, limiter: lim2, now: () => t });
  assert.equal((await h2(post(one, a))).status, 200);
  assert.equal((await h2(post(one, b))).status, 200);
  assert.equal((await h2(post(one, b))).status, 429);
  t += 60_000;
  assert.equal((await h2(post(one, b))).status, 200);
});

test('EV_DAILY_CAP env is honoured', async () => {
  const h = createHandler({ env: { EV_DAILY_CAP: '3' } });
  const ev = { v: 1, events: [{ k: 'result' }, { k: 'result' }] };
  assert.equal((await h(post(ev))).status, 200);
  assert.equal((await h(post(ev))).status, 200);
  assert.equal((await h(post(ev))).status, 429);
});

test('KV failure -> 503 with x-ev-store: kv', async () => {
  const h = createHandler({
    env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' },
    fetch: async () => new Response('nope', { status: 500 }),
  });
  const r = await h(post({ v: 1, events: [{ k: 'result' }] }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-ev-store'), 'kv');
  const r2 = await h(get());
  assert.equal(r2.status, 503);
  const h3 = createHandler({
    env: { UPSTASH_REDIS_REST_URL: 'https://kv.test', UPSTASH_REDIS_REST_TOKEN: 't' },
    fetch: async () => {
      throw new TypeError('network down');
    },
  });
  assert.equal((await h3(post({ v: 1, events: [{ k: 'result' }] }))).status, 503);
});

test('helpers: sanitizer, buckets, KST day', () => {
  assert.equal(
    sanitizeErr('Cannot read "닉네임" of user 김철수 (id 123456, mail kim@example.com) at https://playsnack.vercel.app/p/abc?x=1'),
    'Cannot read <str> of user ? (id #, mail <email>) at <url>',
  );
  assert.equal(sanitizeErr("Unexpected token '<' in JSON at position 17"), 'Unexpected token <str> in JSON at position #');
  assert.equal(sanitizeErr('chunk deadbeefcafe12 failed'), 'chunk # failed');
  // Letter+digit handles (an ASCII nickname like scott123 / user_42) vanish; bare words stay.
  assert.equal(sanitizeErr('player scott123 left, user_42 too, scott stays'), 'player ? left, ? too, scott stays');
  assert.ok(sanitizeErr('a'.repeat(500)).length <= 100);
  assert.doesNotMatch(sanitizeErr('오류 발생 🎉 ok'), /[^\x00-\x7f]/);
  // Join-time buckets (upper bound inclusive): p75 <= 2 s means 75% land in 0-1s or 1-2s.
  const b = (ms) => timeBucket(ms);
  assert.deepEqual([0, 1000, 1001, 2000, 2001, 3000, 3001, 5000, 5001, 10000, 10001, 600000].map(b),
    ['0-1s', '0-1s', '1-2s', '1-2s', '2-3s', '2-3s', '3-5s', '3-5s', '5-10s', '5-10s', '10s+', '10s+']);
  assert.equal(kstDay(Date.parse('2026-10-12T14:59:59Z')), '2026-10-12');
  assert.equal(kstDay(Date.parse('2026-10-12T15:00:00Z')), '2026-10-13');
  assert.ok(isDay('2024-02-29'));
  assert.ok(!isDay('2026-02-29'));
});

test('room_join failure reasons from the live join tracker (subscribe, silence) are on the list; free text is not', async () => {
  const h = createHandler({ env: memEnv, limiter: createLimiter({ bucketSize: 100, dailyCap: 1e6 }) });
  await h(
    post({
      v: 1,
      events: [
        { k: 'room_join', ok: false, ms: 2385, reason: 'subscribe', room: 'friend', app: 'tap-battle' },
        { k: 'room_join', ok: false, ms: 15000, reason: 'silence', room: 'public' },
        { k: 'room_join', ok: false, ms: 900, reason: 'refused' },
        { k: 'room_join', ok: false, reason: 'K7MNP2QRS4 is my room' }, // off-list -> dropped, counted as bad
      ],
    }),
  );
  const a = await (await h(get())).json();
  const c = a.counters;
  assert.deepEqual(a.summary.joinFailReasons, { refused: 1, silence: 1, subscribe: 1 });
  assert.equal(c['join_failed_reason:subscribe'], 1);
  assert.equal(c.joins_failed, 3);
  assert.equal(c['rejected_events:room_join'], 1);
  assert.equal(c['join_attempts_by_app:tap-battle'], 1);
  // Failed attempts keep their own time buckets; only successful joins feed join_ms_bucket.
  assert.deepEqual(a.summary.joinMs, { '0-1s': 0, '1-2s': 0, '2-3s': 0, '3-5s': 0, '5-10s': 0, '10s+': 0 });
  assert.equal(c['join_failed_ms_bucket:2-3s'], 1);
  assert.equal(c['join_failed_ms_bucket:10s+'], 1);
  assert.equal(c['join_failed_ms_bucket:0-1s'], 1);
});

test('room_join tries (broker connect tries, 4 buckets) and slow (joined after the slow notice) are bounded', async () => {
  const h = createHandler({ env: memEnv, limiter: createLimiter({ bucketSize: 100, dailyCap: 1e6 }) });
  await h(
    post({
      v: 1,
      events: [
        { k: 'room_join', ok: true, ms: 900, room: 'friend', tries: 1 },
        { k: 'room_join', ok: true, ms: 23100, room: 'friend', tries: 3, slow: true },
        { k: 'room_join', ok: true, ms: 34000, tries: 4, slow: true },
        { k: 'room_join', ok: false, ms: 45000, reason: 'timeout', tries: 20 },
        { k: 'room_join', ok: true, ms: 800 }, // older clients: no tries -> no tries field
        { k: 'room_join', ok: true, tries: 21 }, // over the cap -> dropped
        { k: 'room_join', ok: true, tries: 2.5 }, // not a whole number -> dropped
        { k: 'room_join', ok: true, tries: '2' }, // not a number -> dropped
        { k: 'room_join', ok: false, reason: 'timeout', slow: true }, // slow only on success
        { k: 'room_join', ok: true, slow: false }, // slow is true or absent
      ],
    }),
  );
  const c = (await (await h(get())).json()).counters;
  assert.equal(c['rejected_events:room_join'], 5);
  assert.equal(c.joins_ok, 4);
  assert.equal(c['joins_ok_by_tries:1'], 1);
  assert.equal(c['joins_ok_by_tries:3'], 1);
  assert.equal(c['joins_ok_by_tries:4+'], 1);
  assert.equal(c['joins_failed_by_tries:4+'], 1);
  assert.equal(c.joins_ok_after_slow_start, 2);
  const tryFields = Object.keys(c).filter((f) => f.includes('_by_tries:'));
  assert.ok(tryFields.every((f) => /^joins_(ok|failed)_by_tries:(1|2|3|4\+)$/.test(f)), tryFields.join());
});

test('room_join via: an enum (edge · mesh · server; anything else ignored, never a reason to drop); edge joins get their own counters', async () => {
  const h = createHandler({ env: memEnv, limiter: createLimiter({ bucketSize: 100, dailyCap: 1e6 }) });
  const r = await (await h(
    post({
      v: 1,
      events: [
        { k: 'room_join', ok: true, ms: 700, room: 'friend', via: 'edge' },
        { k: 'room_join', ok: true, ms: 1500, room: 'public', via: 'edge' },
        { k: 'room_join', ok: false, ms: 15000, reason: 'timeout', via: 'edge' },
        { k: 'room_join', ok: false, via: 'edge' }, // a failure with no reason: still an edge failure
        { k: 'room_join', ok: true, via: 'edge' }, // no time: still an edge success (untimed)
        { k: 'room_join', ok: true, ms: 900, via: 'edge', tries: 3 }, // broker tries mean nothing to the room server: not counted
        { k: 'room_join', ok: true, ms: 3800, via: 'mesh', tries: 2 },
        { k: 'room_join', ok: false, reason: 'silence', via: 'server' },
        { k: 'room_join', ok: true, ms: 2600, via: 'carrier-pigeon' }, // off the list: via ignored, join counted
        { k: 'room_join', ok: true, ms: 2600, via: 5 },
        { k: 'room_join', ok: true, ms: 800, via: null }, // null = absent
        { k: 'room_join', ok: 'yes', via: 'edge' }, // still dropped for its other fields
      ],
    }),
  )).json();
  assert.deepEqual([r.accepted, r.dropped], [11, 1]);
  const a = await (await h(get())).json();
  const c = a.counters;
  // The combined keys still count every join, as before.
  assert.equal(c.joins_ok, 8);
  assert.equal(c.joins_failed, 3);
  assert.equal(c['join_ms_bucket:0-1s'], 3);
  // Room-server joins only.
  assert.equal(c['join_edge_ms_bucket:0-1s'], 2);
  assert.equal(c['join_edge_ms_bucket:1-2s'], 1);
  assert.equal(c.join_edge_ok_untimed, 1);
  assert.equal(c['join_edge_fail_reason:timeout'], 1, 'an edge failure is counted by its reason');
  assert.equal(c.join_edge_fail, 1, 'no reason: the plain edge-failure field');
  assert.equal(c['join_edge_fail_reason:silence'], undefined, 'a server join is not an edge one');
  assert.deepEqual([a.summary.joinEdgeOk, a.summary.joinEdgeFail], [4, 2]);
  assert.deepEqual(a.summary.joinEdgeFailReasons, { timeout: 1 });
  assert.deepEqual(a.summary.joinEdgeMs, { '0-1s': 2, '1-2s': 1, '2-3s': 0, '3-5s': 0, '5-10s': 0, '10s+': 0 });
  assert.equal(c['joins_ok_by_tries:3'], undefined, 'edge: tries not counted');
  assert.equal(c['joins_ok_by_tries:2'], 1, 'mesh: tries counted as before');
  assert.equal(c['rejected_events:room_join'], 1);
  // via values never become fields; only the fixed edge names (6 buckets + untimed + fail reasons + fail) exist.
  assert.ok(!Object.keys(c).some((f) => /mesh|server|pigeon|via/.test(f)), Object.keys(c).join());
  assert.ok(Object.keys(c).filter((f) => f.includes('edge')).every((f) => /^join_edge_(ms_bucket:(0-1s|1-2s|2-3s|3-5s|5-10s|10s\+)|ok_untimed|fail|fail_reason:[a-z_]+)$/.test(f)));
});
