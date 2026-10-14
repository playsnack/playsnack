// Free-plan guard: the monthly Upstash command budget kept in KV (stats:budget:<KST month>).
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, DEFAULT_DAILY_CAP, DEFAULT_MONTHLY_BUDGET } from '../ev.js';
import { DEFAULTS } from '../_lib/ratelimit.js';
import { createLimiter } from '../_lib/ratelimit.js';
import { BUDGET_TTL_SECONDS } from '../_lib/store.js';

const URL_EV = 'https://playsnack.test/api/ev';
const post = (events) =>
  new Request(URL_EV, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ v: 1, events }) });
const get = (q = '') => new Request(URL_EV + q);
const KV = { UPSTASH_REDIS_REST_URL: 'https://fake-upstash.test', UPSTASH_REDIS_REST_TOKEN: 't' };

/** Fake Upstash /pipeline that counts every command it executes. */
function fakeUpstash(seed = {}) {
  const db = new Map(Object.entries(seed));
  const calls = []; // one entry per HTTP request: the command list
  const ttl = new Map();
  const fetch = async (_url, init) => {
    const cmds = JSON.parse(init.body);
    calls.push(cmds);
    const out = cmds.map(([cmd, key, ...args]) => {
      if (cmd === 'INCRBY') {
        db.set(key, (db.get(key) || 0) + Number(args[0]));
        return { result: db.get(key) };
      }
      if (cmd === 'HINCRBY') {
        const h = db.get(key) || new Map();
        db.set(key, h);
        h.set(args[0], (h.get(args[0]) || 0) + Number(args[1]));
        return { result: h.get(args[0]) };
      }
      if (cmd === 'SET') {
        if (db.has(key)) return { result: null };
        db.set(key, args[0]);
        return { result: 'OK' };
      }
      if (cmd === 'DEL') return { result: db.delete(key) ? 1 : 0 };
      if (cmd === 'EXPIRE') {
        ttl.set(key, args[0]);
        return { result: 1 };
      }
      if (cmd === 'HGETALL') return { result: [...(db.get(key) || [])].flatMap(([f, v]) => [f, String(v)]) };
      return { error: `ERR unknown ${cmd}` };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const sent = () => calls.reduce((n, c) => n + c.length, 0);
  return { db, calls, ttl, fetch, sent };
}

const roomy = () => createLimiter({ bucketSize: 1e6, minuteCap: 1e6, dailyCap: 1e9 });

test('defaults: daily cap 1500 events, monthly budget 400000 commands (80% of 500K)', () => {
  assert.equal(DEFAULTS.dailyCap, 1500);
  assert.equal(DEFAULT_DAILY_CAP, 1500);
  assert.equal(DEFAULT_MONTHLY_BUDGET, 400_000);
  assert.ok(BUDGET_TTL_SECONDS >= 35 * 86_400 && BUDGET_TTL_SECONDS <= 45 * 86_400);
});

test('every KV request counts its own commands exactly (INCRBY and EXPIRE included)', async () => {
  const t = Date.parse('2026-10-13T03:00:00Z'); // KST 2026-10-13
  const up = fakeUpstash();
  const h = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy() });
  const B = 'stats:budget:2026-10';
  const check = (label) => assert.equal(up.db.get(B), up.sent(), `${label}: counter ${up.db.get(B)} vs sent ${up.sent()}`);

  // 1st POST: INCRBY + EXPIRE(budget) + HINCRBY events_total + HINCRBY results_shown + EXPIRE(day) = 5.
  assert.equal((await h(post([{ k: 'result' }]))).status, 200);
  assert.equal(up.calls.length, 1);
  assert.deepEqual(up.calls[0][0], ['INCRBY', B, 5]);
  assert.deepEqual(up.calls[0][1], ['EXPIRE', B, BUDGET_TTL_SECONDS]);
  assert.equal(up.calls[0].length, 5);
  check('first post');
  // 2nd POST, same instance: TTLs already set -> INCRBY + 2 HINCRBY = 3.
  await h(post([{ k: 'result' }]));
  assert.equal(up.calls[1].length, 3);
  assert.deepEqual(up.calls[1][0], ['INCRBY', B, 3]);
  check('second post');
  // An error event adds its sample + the err key's one-time EXPIRE.
  await h(post([{ k: 'err', msg: 'TypeError: x', where: 'window.error' }]));
  assert.equal(up.calls[2].length, 6); // INCRBY, events_total, errors_total, errors_by_where, message, EXPIRE errors key
  check('err post');
  // A batch with nothing valid never talks to KV.
  assert.equal((await h(post([{ k: 'nope' }]))).status, 200);
  assert.equal(up.calls.length, 3);
  // GET: INCRBY + 3 HGETALL (day, day errors, all-time) = 4 (budget TTL already set); cached repeat = 0.
  const g = await h(get());
  assert.equal(up.calls.length, 4);
  assert.equal(up.calls[3].length, 4);
  check('get');
  const body = await g.json();
  assert.deepEqual(body.budget, { month: '2026-10', used: up.sent(), limit: DEFAULT_MONTHLY_BUDGET });
  await h(get());
  assert.equal(up.calls.length, 4);
  // A fresh instance (cold start) pays the budget EXPIRE once again: still exact.
  const h2 = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy() });
  await h2(get('?day=2026-10-12'));
  assert.equal(up.calls[4].length, 5);
  check('cold get');
  // ?week=: INCRBY + one HGETALL per readable day (2026-W42: Oct 12, 13 and tomorrow 14) + all-time.
  await h2(get('?week=2026-W42'));
  assert.equal(up.calls[5].length, 1 + 3 + 1);
  assert.deepEqual(up.calls[5][0], ['INCRBY', B, 5]);
  check('week get');
  // A host-engine game: the de-dup claim pipeline (INCRBY + SET NX) and the apply pipeline are both metered.
  const before = up.calls.length;
  await h2(post([{ k: 'session_done', app: 'quiz-ox', p: 3, sid: 'abcdefghijklmnop1234' }]));
  assert.equal(up.calls.length, before + 2);
  assert.deepEqual(up.calls[before].map((c) => c[0]), ['INCRBY', 'SET']);
  check('claim + apply');
});

test('stops at the cap: POST -> 204 and GET -> budget_reached, with no further KV calls', async () => {
  let t = Date.parse('2026-10-13T03:00:00Z');
  const up = fakeUpstash();
  const h = createHandler({ env: { ...KV, EV_MONTHLY_BUDGET: '20' }, fetch: up.fetch, now: () => t, limiter: roomy() });
  const ev = [{ k: 'open', route: 'app', app: 'quiz-ox' }]; // 1st: 1+1+1+3+1 = 7, later: 5
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await h(post(ev))).status);
  // 7 -> 12 -> 17 -> 22 (>= 20: reached) -> 204, 204
  assert.deepEqual(statuses, [200, 200, 200, 200, 204, 204]);
  assert.equal(up.db.get('stats:budget:2026-10'), 22);
  const callsAtCap = up.calls.length;
  assert.equal(callsAtCap, 4);

  const r = await h(post(ev));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('x-ev-budget'), 'reached');
  assert.equal(await r.text(), '');
  // GET of a day this instance never read: a budget_reached body, no KV.
  const g = await h(get());
  assert.equal(g.status, 200);
  assert.deepEqual(await g.json(), {
    ok: false, error: 'budget_reached', v: 1, day: '2026-10-13', store: 'kv',
    budget: { month: '2026-10', used: 22, limit: 20 },
  });
  // Many more requests later in the month: still nothing sent.
  t += 5 * 86_400_000;
  for (let i = 0; i < 20; i++) await h(post(ev));
  await h(get('?day=2026-10-14'));
  assert.equal(up.calls.length, callsAtCap);
});

test('GET past the budget serves the cached aggregate (stale) without KV', async () => {
  let t = Date.parse('2026-10-13T03:00:00Z');
  const up = fakeUpstash();
  const h = createHandler({ env: { ...KV, EV_MONTHLY_BUDGET: '9' }, fetch: up.fetch, now: () => t, limiter: roomy() });
  await h(post([{ k: 'result' }])); // 5
  const first = await (await h(get())).json(); // 5 + 4 = 9 -> reached
  assert.equal(first.ok, true);
  assert.deepEqual(first.budget, { month: '2026-10', used: 9, limit: 9 });
  const calls = up.calls.length;
  t += 60_000; // cache expired
  const r = await h(get());
  assert.equal(r.headers.get('x-ev-budget'), 'reached');
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.stale, true);
  assert.equal(body.total, 1);
  assert.equal(up.calls.length, calls);
});

test('another instance already spent the budget: one pipeline to learn it, then silence', async () => {
  const t = Date.parse('2026-10-13T03:00:00Z');
  const up = fakeUpstash({ 'stats:budget:2026-10': DEFAULT_MONTHLY_BUDGET });
  const h = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy() });
  assert.equal((await h(post([{ k: 'result' }]))).status, 200); // a cold instance cannot know before its first reply
  assert.equal((await h(post([{ k: 'result' }]))).status, 204);
  await h(get());
  assert.equal(up.calls.length, 1);
});

test('month rollover is by KST: a new month starts a new counter and writing resumes', async () => {
  let t = Date.parse('2026-10-31T14:59:00Z'); // KST 2026-10-31 23:59
  const up = fakeUpstash();
  const h = createHandler({ env: { ...KV, EV_MONTHLY_BUDGET: '5' }, fetch: up.fetch, now: () => t, limiter: roomy() });
  assert.equal((await h(post([{ k: 'result' }]))).status, 200); // 5 -> reached
  assert.equal((await h(post([{ k: 'result' }]))).status, 204);
  t = Date.parse('2026-10-31T15:00:00Z'); // KST 2026-11-01 00:00 (still October in UTC)
  assert.equal((await h(post([{ k: 'result' }]))).status, 200);
  assert.equal(up.db.get('stats:budget:2026-10'), 5);
  assert.equal(up.db.get('stats:budget:2026-11'), 5); // new key, its own EXPIRE again
  assert.equal(up.ttl.get('stats:budget:2026-11'), BUDGET_TTL_SECONDS);
  assert.ok(up.db.has('stats:daily:2026-11-01'));
  assert.equal((await h(post([{ k: 'result' }]))).status, 204); // November's budget (5) is now spent too
});

test('a failed apply releases its claims through a metered pipeline too', async () => {
  const t = Date.parse('2026-10-13T03:00:00Z');
  const up = fakeUpstash();
  let failApply = true;
  const fetch = async (url, init) => {
    if (failApply && JSON.parse(init.body).some(([c]) => c === 'HINCRBY')) {
      up.calls.push(JSON.parse(init.body)); // sent (and counted by Upstash) even though it failed
      return new Response('down', { status: 500 });
    }
    return up.fetch(url, init);
  };
  const h = createHandler({ env: KV, fetch, now: () => t, limiter: roomy() });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await h(post([{ k: 'session_done', app: 'quiz-ox', p: 3, sid: 'abcdefghijklmnop1234' }]))).status, 503);
  } finally {
    console.error = orig;
  }
  const kinds = up.calls.map((c) => c.map((x) => x[0]).join(','));
  assert.deepEqual(kinds[0], 'INCRBY,EXPIRE,SET');
  assert.match(kinds[1], /^INCRBY,HINCRBY/);
  assert.deepEqual(kinds[2], 'INCRBY,DEL');
  failApply = false;
  // The failed pipeline's INCRBY never reached the fake, so the counter covers claim + release only.
  assert.equal(up.db.get('stats:budget:2026-10'), up.calls[0].length + up.calls[2].length);
});

test('accepted error events are logged as one sanitized line each (Vercel Logs), nothing else', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const h = createHandler({ env: {}, limiter: roomy() });
    await h(post([
      { k: 'err', msg: 'TypeError: cannot read "김철수" of undefined at https://x.test/p?room=ABCDEFGH23', where: 'window.error', build: 'g1a2b3c4' },
      { k: 'err', msg: 'boom', where: 'nick 김철수' },
      { k: 'result' },
    ]));
  } finally {
    console.error = orig;
  }
  assert.deepEqual(lines, [
    '[ev] err where=window.error build=g1a2b3c4: TypeError: cannot read <str> of undefined at <url>',
    '[ev] err where=other build=-: boom',
  ]);
});

test('worst-case counts (docs/telemetry.md §5a): 20 different games in one POST ≤ 92, a /stats page view ≤ 25', async () => {
  const t = Date.parse('2026-10-14T03:00:00Z'); // KST Wed 2026-10-14 (2026-W42)
  const up = fakeUpstash();
  const h = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy() });
  const { appIds } = await import('../_lib/apps.js');
  const apps = [...appIds()].slice(0, 20);
  // Every game a different app, player count and answerer count: the most distinct fields one batch can make.
  const games = apps.map((app, i) => ({ k: 'session_done', app, p: 3 + i, sid: `sid${String(i).padStart(17, '0')}`, about: i % 2 === 0, ans: 1 + (i % 9) }));
  assert.equal((await h(post(games))).status, 200);
  const [claim, apply] = up.calls.map((c) => c.length);
  assert.ok(claim <= 22, `claim ${claim}`); // INCRBY + EXPIRE(budget) + SET × 20
  // INCRBY + events_total + HINCRBY ≤ 60 + EXPIRE day + monthly (3 fields × total & day) = 6
  assert.ok(apply <= 70, `apply ${apply}`);
  assert.ok(claim + apply <= 92, `post ${claim + apply}`);
  // The /stats page: ?week= this week + last week, ?day= today (cold instance, nothing cached).
  const h2 = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy() });
  const before = up.sent();
  for (const q of ['?week=2026-W42', '?week=2026-W41', '?day=2026-10-14']) assert.equal((await h2(get(q))).status, 200);
  const view = up.sent() - before;
  assert.ok(view <= 25, `page view ${view}`);
  assert.equal(view, up.calls.slice(2).reduce((n, c) => n + c.length, 0), 'counter = commands sent');
  assert.equal(up.db.get('stats:budget:2026-10'), up.sent());
});
