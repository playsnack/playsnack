// Growth (docs/telemetry.md §3, §9): never-expiring monthly headline totals (+ per day),
// the ?growth=1 read, and the unique-device estimate (salted hash → HyperLogLog).
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, deviceHash, monthsBetween, STATS_START_MONTH } from '../ev.js';
import { createMemoryStore, DEVICES_DAY_TTL_SECONDS } from '../_lib/store.js';
import { MONTHLY_FIELDS } from '../_lib/schema.js';

const URL_EV = 'https://playsnack.test/api/ev';
const post = (events) => new Request(URL_EV, { method: 'POST', body: JSON.stringify({ v: 1, events }) });
const get = (q = '') => new Request(URL_EV + q);
const roomy = { check: () => null, dailyCapReached: () => false, noteTotal: () => {} };
const SALT = 'salt-for-tests-0123456789';
const ID = (n) => `browserIdForTest_${String(n).padStart(5, '0')}`; // 22 chars

function fakeUpstash() {
  const db = new Map();
  const ttl = new Map();
  const calls = [];
  const fetch = async (_u, init) => {
    const cmds = JSON.parse(init.body);
    calls.push(cmds);
    const out = cmds.map(([cmd, key, ...a]) => {
      if (cmd === 'INCRBY') { db.set(key, (db.get(key) || 0) + Number(a[0])); return { result: db.get(key) }; }
      if (cmd === 'HINCRBY') {
        const h = db.get(key) || new Map();
        db.set(key, h);
        h.set(a[0], (h.get(a[0]) || 0) + Number(a[1]));
        return { result: h.get(a[0]) };
      }
      if (cmd === 'SET') { if (db.has(key)) return { result: null }; db.set(key, a[0]); return { result: 'OK' }; }
      if (cmd === 'EXPIRE') { ttl.set(key, a[0]); return { result: 1 }; }
      if (cmd === 'HGETALL') return { result: [...(db.get(key) || [])].flatMap(([f, v]) => [f, String(v)]) };
      if (cmd === 'PFADD') { const s = db.get(key) || new Set(); db.set(key, s); a.forEach((x) => s.add(x)); return { result: 1 }; }
      if (cmd === 'PFCOUNT') return { result: (db.get(key) || new Set()).size };
      return { error: 'ERR' };
    });
    return new Response(JSON.stringify(out));
  };
  return { db, ttl, calls, fetch, sent: () => calls.reduce((n, c) => n + c.length, 0) };
}
const KV = { UPSTASH_REDIS_REST_URL: 'https://fake-upstash.test', UPSTASH_REDIS_REST_TOKEN: 't' };

test('monthsBetween: from the start month to now, inclusive, across a year', () => {
  assert.equal(STATS_START_MONTH, '2026-10');
  assert.deepEqual(monthsBetween('2026-10', '2026-10'), ['2026-10']);
  assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(monthsBetween('2026-10', '2040-01').length, 120, 'bounded');
});

test('monthly totals (+ per day) count alongside the daily ones and never expire', async () => {
  let t = Date.parse('2026-10-31T03:00:00Z'); // KST 10-31
  const up = fakeUpstash();
  const h = createHandler({ env: KV, fetch: up.fetch, now: () => t, limiter: roomy });
  await h(post([
    { k: 'session_done', app: 'quiz-ox', p: 4, sid: 'sid00000000000000001' },
    { k: 'session_done', p: 2, sid: 'sid00000000000000002' },
    { k: 'game_created', source: 'remake', gid: 'gid00000000000000001' },
    { k: 'room_create' },
    { k: 'room_join', ok: true, ms: 800 },
    { k: 'room_join', ok: false, reason: 'timeout' },
    { k: 'open', route: 'home' }, // not a headline number
  ]));
  t = Date.parse('2026-10-31T15:30:00Z'); // KST 11-01 00:30: a new month
  await h(post([{ k: 'session_done', p: 3, sid: 'sid00000000000000003' }]));
  const oct = Object.fromEntries(up.db.get('stats:monthly:2026-10'));
  assert.deepEqual(oct, {
    games_finished: 2, 'games_finished:day_31': 2,
    games_finished_3plus: 1, 'games_finished_3plus:day_31': 1,
    players_in_finished_games: 6, 'players_in_finished_games:day_31': 6,
    quizzes_created: 1, 'quizzes_created:day_31': 1,
    quizzes_created_remake: 1, 'quizzes_created_remake:day_31': 1,
    rooms_created: 1, 'rooms_created:day_31': 1,
    joins_ok: 1, 'joins_ok:day_31': 1,
  });
  assert.deepEqual(Object.fromEntries(up.db.get('stats:monthly:2026-11')), {
    games_finished: 1, 'games_finished:day_01': 1, games_finished_3plus: 1, 'games_finished_3plus:day_01': 1,
    players_in_finished_games: 3, 'players_in_finished_games:day_01': 3,
  });
  for (const k of up.ttl.keys()) assert.ok(!k.startsWith('stats:monthly:'), `${k} must not expire`);
  for (const f of Object.keys(oct)) assert.ok(MONTHLY_FIELDS.includes(f.replace(/:day_\d\d$/, '')), f);
  // A duplicate game report (host hand-over) adds nothing to the month either.
  await h(post([{ k: 'session_done', p: 3, sid: 'sid00000000000000003' }]));
  assert.equal(up.db.get('stats:monthly:2026-11').get('games_finished'), 1);
});

test('GET ?growth=1: every month since the start + all-time + devices, one pipeline, cached 30 s', async () => {
  let t = Date.parse('2026-12-05T03:00:00Z'); // KST 2026-12-05: months 2026-10, -11, -12
  const up = fakeUpstash();
  const h = createHandler({ env: { ...KV, EV_DEVICE_SALT: SALT }, fetch: up.fetch, now: () => t, limiter: roomy });
  await h(post([{ k: 'session_done', p: 3, sid: 'sid00000000000000001' }, { k: 'seen', d: ID(1) }, { k: 'seen', d: ID(2) }]));
  const before = up.calls.length;
  const r = await h(get('?growth=1'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=30/);
  const g = await r.json();
  assert.equal(up.calls.length, before + 1, 'one request');
  const cmds = up.calls[before].map((c) => c[0]);
  // INCRBY + HGETALL all_time + 3 monthly HGETALL + PFCOUNT all_time + 3 monthly PFCOUNT = 9.
  assert.deepEqual(cmds, ['INCRBY', 'HGETALL', 'HGETALL', 'HGETALL', 'HGETALL', 'PFCOUNT', 'PFCOUNT', 'PFCOUNT', 'PFCOUNT']);
  assert.equal(up.calls[before][0][2], cmds.length, 'metered exactly');
  assert.deepEqual(g.months.map((m) => m.month), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(g.months[2].totals, {
    games_finished: 1, games_finished_3plus: 1, quizzes_created: 0, quizzes_created_remake: 0, rooms_created: 0,
    players_in_finished_games: 3, joins_ok: 0,
  });
  assert.deepEqual(g.months[2].days, { '05': { games_finished: 1, games_finished_3plus: 1, players_in_finished_games: 3 } });
  assert.deepEqual(g.months.map((m) => m.devices), [0, 0, 2]);
  assert.deepEqual(g.devices, { counting: true, allTime: 2 });
  assert.equal(g.allTime.games_finished, 1);
  assert.equal(g.today, '2026-12-05');
  t += 10_000;
  await h(get('?growth=1'));
  assert.equal(up.calls.length, before + 1, 'cached');
  t += 31_000;
  await h(get('?growth=1'));
  assert.equal(up.calls.length, before + 2, 'read again after 30 s');
  assert.equal(up.db.get('stats:budget:2026-12'), up.sent());
});

test('devices: salted hash into 3 HyperLogLogs (one PFADD each per request); raw id never sent', async () => {
  const t = Date.parse('2026-10-14T03:00:00Z');
  const up = fakeUpstash();
  const h = createHandler({ env: { ...KV, EV_DEVICE_SALT: SALT }, fetch: up.fetch, now: () => t, limiter: roomy });
  await h(post([{ k: 'seen', d: ID(1) }, { k: 'seen', d: ID(2) }, { k: 'seen', d: ID(1) }]));
  const cmds = up.calls[0];
  const pf = cmds.filter((c) => c[0] === 'PFADD');
  assert.deepEqual(pf.map((c) => c[1]), ['stats:devices:all_time', 'stats:devices:2026-10', 'stats:devices:daily:2026-10-14']);
  for (const c of pf) assert.deepEqual(c.slice(2), [deviceHash(SALT, ID(1)), deviceHash(SALT, ID(2))]);
  assert.ok(cmds.some((c) => c[0] === 'EXPIRE' && c[1] === 'stats:devices:daily:2026-10-14' && c[2] === DEVICES_DAY_TTL_SECONDS));
  assert.ok(!cmds.some((c) => c[0] === 'EXPIRE' && /devices:(all_time|\d{4}-\d{2})$/.test(c[1])));
  assert.equal(cmds[0][2], cmds.length, 'budget counts the PFADDs');
  assert.ok(!JSON.stringify(up.calls).includes('browserIdForTest'), 'raw id never leaves the function');
  assert.equal(up.db.get('stats:daily:2026-10-14').get('device_checkins'), 3);
  // Same salt + id = same hash (so a returning device is not counted twice); another salt differs.
  assert.equal(deviceHash(SALT, ID(1)), deviceHash(SALT, ID(1)));
  assert.notEqual(deviceHash(SALT, ID(1)), deviceHash('another-salt-0123456789', ID(1)));
  // Bad ids are rejected, never counted or stored.
  const r = await h(post([{ k: 'seen', d: 'short' }, { k: 'seen', d: ID(3), app: 'x' }]));
  assert.deepEqual(await r.json(), { ok: true, accepted: 0, dropped: 2 });
});

test('devices without EV_DEVICE_SALT: not counted, and GET says so', async () => {
  const memoryStore = createMemoryStore();
  const h = createHandler({ env: {}, memoryStore, limiter: roomy });
  await h(post([{ k: 'seen', d: ID(1) }]));
  assert.equal(memoryStore.sketches.size, 0);
  const g = await (await h(get('?growth=1'))).json();
  assert.deepEqual(g.devices, { counting: false, allTime: 0 });
  const day = await (await h(get())).json();
  assert.equal(day.counters['devices_not_counted:no_salt'], 1);
  assert.ok(!JSON.stringify([...memoryStore.data]).includes('browserIdForTest'));
});
