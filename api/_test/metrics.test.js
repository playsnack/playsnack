// Free-beta metrics (docs/telemetry.md §9): new kinds, strict validation, bounded
// keys, once-per-game de-dup across hosts, all-time counters, weekly read.
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../ev.js';
import { createMemoryStore, ONCE_TTL_SECONDS } from '../_lib/store.js';
import { appIds } from '../_lib/apps.js';
import { normalizeEvent, playerBucket } from '../_lib/schema.js';
import { isoWeek, weekDays } from '../_lib/day.js';

const URL_EV = 'https://playsnack.test/api/ev';
const post = (events) =>
  new Request(URL_EV, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ v: 1, events }) });
const get = (q = '') => new Request(URL_EV + q);
const T0 = Date.parse('2026-10-13T03:00:00Z'); // KST Tue 2026-10-13 12:00 (ISO week 2026-W42)
const SID_A = 'sidAAAAAAAAAAAAAAAA1';
const SID_B = 'sidBBBBBBBBBBBBBBBB2';

function setup(t0 = T0) {
  let t = t0;
  const memoryStore = createMemoryStore({ now: () => t });
  const h = createHandler({ env: {}, memoryStore, now: () => t });
  return { h, memoryStore, advance: (ms) => (t += ms), at: (ms) => (t = ms) };
}
const json = async (r) => [r.status, await r.json()];

test('each new kind is accepted and aggregated (day counters, summary, all-time)', async () => {
  const { h } = setup();
  const [s, b] = await json(
    await h(
      post([
        { k: 'session_done', app: 'speed-trivia-score', p: 4, sid: SID_A, about: true, ans: 3 },
        { k: 'session_done', app: 'quiz-ox', p: 2, sid: SID_B, about: false, ans: 1 },
        { k: 'rematch', app: 'tap-battle', p: 4, sid: 'sidCCCCCCCCCCCCCCCC3' },
        { k: 'room_create', app: 'tap-battle' },
        { k: 'game_created', app: 'speed-trivia-score~QWERTYZ23456', source: 'editor', gid: 'gidAAAAAAAAAAAAAAAA1' },
        { k: 'game_created', app: 'speed-trivia-score', source: 'remake', gid: 'gidBBBBBBBBBBBBBBBB2' },
        { k: 'room_join', ok: true, ms: 900, room: 'friend', app: 'tap-battle' },
        { k: 'room_join', ok: false, reason: 'timeout', room: 'public' },
        { k: 'room_join', ok: false, reason: 'bad_link' },
        { k: 'share', method: 'copy', what: 'invite', app: 'tap-battle' },
        { k: 'share', method: 'web' }, // `what` stays optional (the original kind)
        { k: 'ask_shown', app: 'tap-battle' },
        { k: 'ask_answer', app: 'tap-battle', a: 'yes' },
        { k: 'ask_answer', app: 'tap-battle', a: 'no', why: 'laggy' },
        { k: 'ask_answer', app: 'app-1a2b3c', a: 'skip' },
      ]),
    ),
  );
  assert.equal(s, 200);
  assert.deepEqual(b, { ok: true, accepted: 15, dropped: 0 });

  const [gs, a] = await json(await h(get()));
  assert.equal(gs, 200);
  assert.equal(a.day, '2026-10-13');
  const c = a.counters;
  assert.equal(c.session_done.n, 2);
  assert.deepEqual(c.session_done.p, { 2: 1, '4-5': 1 });
  assert.equal(c.session_done.p3, 1);
  assert.deepEqual(c.session_done.app3, { 'speed-trivia-score': 1 });
  assert.deepEqual(c.session_done.app, { 'quiz-ox': 1, 'speed-trivia-score': 1 });
  assert.deepEqual(c.session_done.about, { true: 1, false: 1 });
  assert.deepEqual(c.session_done.ans, { 1: 1, 3: 1 });
  assert.equal(c.rematch.n, 1);
  assert.deepEqual(c.room_create, { n: 1, app: { 'tap-battle': 1 } });
  assert.deepEqual(c.game_created, { n: 2, source: { editor: 1, remake: 1 }, app: { 'speed-trivia-score': 2 } });
  assert.equal(c.room_join.ok, 1);
  assert.equal(c.room_join.fail, 2);
  assert.deepEqual(c.room_join.reason, { timeout: 1, bad_link: 1 });
  assert.deepEqual(c.room_join.room, { friend: { ok: 1 }, public: { fail: 1 } });
  assert.deepEqual(c.share.what, { invite: 1 });
  assert.deepEqual(c.ask_shown, { n: 1, app: { 'tap-battle': 1 } });
  assert.deepEqual(c.ask_answer.a, { yes: 1, no: 1, skip: 1 });
  assert.deepEqual(c.ask_answer.why, { laggy: 1 });
  assert.deepEqual(c.ask_answer.app, { 'tap-battle': { yes: 1, no: 1 }, custom: { skip: 1 } });
  assert.deepEqual(a.summary, {
    sessionsDone: 2, sessionsDone3: 1, sessionsDup: 0, sessionsAbout: 1, rematch: 1, roomsCreated: 1,
    gamesCreated: 2, gamesRemade: 1, joinOk: 1, joinFail: 2, share: 2, askShown: 1, askYes: 1, askNo: 1, askSkip: 1,
    bad: {},
  });
  assert.equal(a.wired, false, 'nothing sends these yet: zeros are not measurements');
  assert.deepEqual(a.cumulative, {
    session_done: { n: 2, p3: 1 }, rematch: { n: 1 }, room_create: { n: 1 },
    game_created: { n: 2, source: { editor: 1, remake: 1 } },
  });
});

test('strict validation: unknown fields and bad values drop the event', async () => {
  const { h, memoryStore } = setup();
  const bad = [
    { k: 'session_done', app: 'quiz-ox', p: 3, sid: SID_A, nick: 'x' }, // unknown field
    { k: 'session_done', p: 0, sid: SID_A },
    { k: 'session_done', p: 2.5, sid: SID_A },
    { k: 'session_done', p: 1001, sid: SID_A },
    { k: 'session_done', p: '3', sid: SID_A },
    { k: 'session_done', p: 3 }, // no sid
    { k: 'session_done', p: 3, sid: 'short' },
    { k: 'session_done', p: 3, sid: 'has/slash/aaaaaaaaaaaa' },
    { k: 'session_done', p: 3, sid: 'x'.repeat(33) },
    { k: 'rematch', p: 3, sid: SID_A, round: 2 },
    { k: 'room_create', app: 'quiz-ox', code: 'ABCDEFGH' },
    { k: 'session_done', p: 3, sid: SID_A, about: 'yes' },
    { k: 'session_done', p: 3, sid: SID_A, ans: -1 },
    { k: 'session_done', p: 3, sid: SID_A, ans: 4 }, // more answerers than players
    { k: 'session_done', p: 3, sid: SID_A, about: true, ans: 3 }, // the subject is a player, never an answerer
    { k: 'game_created', source: 'magic', gid: 'gidAAAAAAAAAAAAAAAA1' },
    { k: 'game_created', source: 'editor' }, // no gid
    { k: 'game_created', source: 'editor', gid: 'gidAAAAAAAAAAAAAAAA1', pack: '{}' }, // the pack never travels
    { k: 'ask_shown', app: 'quiz-ox', sid: SID_A }, // the sid stays on the device for ask_*
    { k: 'ask_answer', a: 'maybe' },
    { k: 'ask_answer', a: 'yes', why: 'boring' }, // a reason only with "no"
    { k: 'ask_answer', a: 'no', why: 'free text here' },
    { k: 'ask_answer', a: 'no', text: '재미없어요' },
    { k: 'room_join', ok: true, reason: 'timeout' }, // a reason only on failure
    { k: 'room_join', ok: false, reason: 'cosmic-rays' },
    { k: 'room_join', ok: true, room: 'secret' },
    { k: 'share', method: 'copy', what: 'everything' },
  ];
  for (const part of [bad.slice(0, 14), bad.slice(14)]) {
    const [s, b] = await json(await h(post(part)));
    assert.equal(s, 200);
    assert.deepEqual(b, { ok: true, accepted: 0, dropped: part.length });
  }
  // Only the per-kind `bad` counters (and the cap total) are written — never a value from the events.
  const day = memoryStore.data.get('ev:2026-10-13');
  for (const f of day.keys()) assert.ok(f === '_total' || f.endsWith('|bad'), f);
  assert.equal(memoryStore.once.size, 0, 'no de-dup id claimed');
  const a = await (await h(get())).json();
  assert.deepEqual(a.summary.bad, {
    ask_answer: 4, ask_shown: 1, game_created: 3, rematch: 1, room_create: 1, room_join: 3, session_done: 13, share: 1,
  });
  assert.equal(a.summary.sessionsDone, 0);
});

test('a game is counted once per sid: two hosts across a hand-over, resends, same batch', async () => {
  const { h, memoryStore, advance } = setup();
  const done = { k: 'session_done', app: 'tap-battle', p: 3, sid: SID_A };
  // Old host reports, then the new host (resumed from an older snapshot) reports the same game.
  assert.equal((await h(post([done]))).status, 200);
  advance(2000);
  assert.equal((await h(post([{ ...done, p: 4 }]))).status, 200);
  // The same game twice in one batch + a rematch with the same sid (another kind: its own count).
  const [, b] = await json(await h(post([done, done, { k: 'rematch', p: 3, sid: SID_A }])));
  assert.deepEqual(b, { ok: true, accepted: 3, dropped: 0 });
  // A quiz pack replayed to a new host after a hand-over: one game created.
  const made = { k: 'game_created', app: 'speed-trivia-score', source: 'remake', gid: SID_B };
  await h(post([made]));
  await h(post([made]));
  advance(31_000); // past the GET cache
  const a = await (await h(get())).json();
  assert.equal(a.summary.sessionsDone, 1);
  assert.equal(a.summary.sessionsDone3, 1);
  assert.equal(a.summary.sessionsDup, 3);
  assert.deepEqual(a.counters.session_done.p, { 3: 1 }, 'the first report wins');
  assert.equal(a.summary.rematch, 1);
  assert.equal(a.cumulative.session_done.n, 1);
  assert.equal(a.summary.gamesCreated, 1);
  assert.equal(a.summary.gamesRemade, 1);
  assert.equal(a.counters.game_created.dup, 1);
  assert.equal(a.total, 7, 'duplicates still count toward the daily event cap');
  assert.equal(memoryStore.once.size, 3);
  // The de-dup claim lapses after ONCE_TTL_SECONDS (a later report then counts again — documented limit).
  advance(ONCE_TTL_SECONDS * 1000 + 1);
  await h(post([done]));
  assert.equal((await (await h(get('?day=2026-10-13'))).json()).summary.sessionsDone, 2);
});

test('bounded keys: arbitrary app strings, sids and counts never widen the field set', async () => {
  const { h, memoryStore } = setup();
  const known = appIds();
  for (let i = 0; i < 10; i++) {
    const events = Array.from({ length: 20 }, (_, j) => {
      const n = i * 20 + j;
      const app = ['quiz-ox~ROOMCODE' + n, 'tpl-tap-battle', `app-${n.toString(16)}`, `evil-${n}`, `${n}`][n % 5];
      return [
        { k: 'session_done', app, p: (n % 30) + 1, sid: `sid${String(n).padStart(17, '0')}` },
        { k: 'room_create', app },
        { k: 'ask_answer', app, a: ['yes', 'no', 'skip'][n % 3] },
        { k: 'game_created', app, source: ['editor', 'remake'][n % 2], gid: `gid${String(n).padStart(17, '0')}` },
      ][n % 4];
    });
    assert.equal((await h(post(events))).status, 200);
  }
  const fields = [...memoryStore.data.get('ev:2026-10-13').keys()];
  const appOk = (v) => known.has(v) || v === 'other' || v === 'custom';
  for (const f of fields) {
    assert.doesNotMatch(f, /ROOMCODE|evil|sid0|gid0/, f);
    const p = f.split('|');
    if (p[1] === 'app' || p[1] === 'app3') assert.ok(appOk(p[2]), f);
    if (p[1] === 'p') assert.ok(['1', '2', '3', '4-5', '6-8', '9+'].includes(p[2]), f);
  }
  // 200 events with ~200 distinct app strings and ids land in a fixed set of fields.
  // game_created is n % 4 === 3, always an odd n, so its source is always "remake".
  // 4 app values (quiz-ox, tap-battle, custom, other) → session_done 1+6+1+4+4,
  // room_create 1+4, ask_answer 1+3+4×3, game_created 1+1+4.
  assert.equal(fields.length, 43, fields.join(' '));
  assert.deepEqual([...memoryStore.data.get('ev:all').keys()].sort(), [
    'game_created|n', 'game_created|source|remake', 'room_create|n', 'session_done|n', 'session_done|p3',
  ]);
  assert.equal(playerBucket(1), '1');
  assert.equal(playerBucket(5), '4-5');
  assert.equal(playerBucket(8), '6-8');
  assert.equal(playerBucket(9), '9+');
  assert.equal(normalizeEvent({ k: 'room_create', app: 'quiz-ox~ABC' }).fields[1], 'room_create|app|quiz-ox');
});

test('GET ?week= sums the ISO week (KST) and stays bounded', async () => {
  const { h, at } = setup();
  const monday = Date.parse('2026-10-12T03:00:00Z');
  const day = 86_400_000;
  at(monday);
  await h(post([{ k: 'session_done', app: 'quiz-ox', p: 3, sid: SID_A }, { k: 'room_create' }]));
  at(monday + 2 * day);
  await h(post([{ k: 'session_done', app: 'quiz-ox', p: 5, sid: SID_B }, { k: 'session_done', p: 2, sid: 'sidDDDDDDDDDDDDDDDD4' }]));
  at(monday + 7 * day); // next Monday: the previous week is complete
  await h(post([{ k: 'session_done', p: 3, sid: 'sidEEEEEEEEEEEEEEEE5' }]));
  const [s, w] = await json(await h(get('?week=2026-W42')));
  assert.equal(s, 200);
  assert.equal(w.week, '2026-W42');
  assert.deepEqual(w.days, weekDays('2026-W42'));
  assert.equal(w.summary.sessionsDone, 3);
  assert.equal(w.summary.sessionsDone3, 2);
  assert.equal(w.summary.roomsCreated, 1);
  assert.equal(w.total, 4);
  assert.deepEqual(w.counters.session_done.app3, { 'quiz-ox': 2 });
  assert.deepEqual(w.cumulative.session_done, { n: 4, p3: 3 });
  // Default = this week; bad / unreal / out-of-retention weeks are 400.
  assert.equal((await (await h(get('?week='))).json()).week, isoWeek('2026-10-19'));
  const err = async (q) => {
    const r = await h(get(q));
    return `${r.status} ${(await r.json()).error}`;
  };
  assert.equal(await err('?week=2026-42'), '400 bad_week');
  assert.equal(await err('?week=2025-W53'), '400 bad_week'); // 2025 has 52 ISO weeks
  assert.equal(await err('?week=2026-W00'), '400 bad_week');
  assert.equal(await err('?week=1999-W01'), '400 week_out_of_range');
  assert.equal(await err('?week=2027-W10'), '400 week_out_of_range');
  // A week at the retention edge reads only its in-range days.
  const edge = await (await h(get('?week=2026-W30'))).json();
  assert.ok(edge.days.length >= 1 && edge.days.length < 7, JSON.stringify(edge.days));
  assert.ok(weekDays('2026-W53'), '2026 has 53 ISO weeks');
});

test('KV: de-dup uses SET NX EX on a hashed key; the all-time hash never expires', async () => {
  const db = new Map();
  const cmds = [];
  const fetch = async (url, init) => {
    const out = JSON.parse(init.body).map(([cmd, key, ...args]) => {
      cmds.push([cmd, key, ...args]);
      if (cmd === 'SET') {
        if (db.has(key)) return { result: null };
        db.set(key, args[0]);
        return { result: 'OK' };
      }
      if (cmd === 'HINCRBY') {
        const m = db.get(key) || new Map();
        db.set(key, m);
        m.set(args[0], (m.get(args[0]) || 0) + Number(args[1]));
        return { result: m.get(args[0]) };
      }
      if (cmd === 'INCRBY') { db.set(key, (db.get(key) || 0) + Number(args[0])); return { result: db.get(key) }; } // budget counter (store.js metered)
      if (cmd === 'EXPIRE') return { result: 1 };
      if (cmd === 'HGETALL') return { result: [...(db.get(key) || [])].flatMap(([f, v]) => [f, String(v)]) };
      return { error: 'ERR' };
    });
    return new Response(JSON.stringify(out));
  };
  const h = createHandler({ env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' }, fetch, now: () => T0 });
  const done = { k: 'session_done', app: 'quiz-ox', p: 3, sid: SID_A };
  await h(post([done]));
  await h(post([done]));
  const sets = cmds.filter((c) => c[0] === 'SET');
  assert.equal(sets.length, 2);
  for (const c of sets) {
    assert.match(c[1], /^ev:once:[0-9a-f]{32}$/);
    assert.deepEqual(c.slice(2), ['1', 'NX', 'EX', ONCE_TTL_SECONDS]);
  }
  assert.ok(!JSON.stringify(cmds).includes(SID_A), 'raw sid never sent to the KV');
  assert.ok(!cmds.some((c) => c[0] === 'EXPIRE' && c[1] === 'ev:all'));
  const a = await (await h(get())).json();
  assert.equal(a.store, 'kv');
  assert.equal(a.summary.sessionsDone, 1);
  assert.equal(a.summary.sessionsDup, 1);
  assert.deepEqual(a.cumulative.session_done, { n: 1, p3: 1 });
  const w = await (await h(get('?week=2026-W42'))).json();
  assert.equal(w.summary.sessionsDone, 1);
});

test('p = players who took part: the 3+ headline needs p >= 3 and, for a quiz, an answer', async () => {
  const { h } = setup();
  await h(post([
    { k: 'session_done', app: 'speed-trivia-score', p: 3, sid: 'sid10000000000000001', about: true, ans: 2 }, // subject + 2
    { k: 'session_done', app: 'speed-trivia-score', p: 3, sid: 'sid10000000000000002', about: false, ans: 0 }, // nobody answered
    { k: 'session_done', app: 'tap-battle', p: 3, sid: 'sid10000000000000003' }, // not a quiz: no ans
    { k: 'session_done', app: 'speed-trivia-score', p: 2, sid: 'sid10000000000000004', about: true, ans: 1 }, // 1:1
  ]));
  const a = await (await h(get())).json();
  assert.equal(a.summary.sessionsDone, 4);
  assert.equal(a.summary.sessionsDone3, 2);
  assert.deepEqual(a.counters.session_done.ans, { 0: 1, 1: 1, 2: 1 });
  assert.deepEqual(a.cumulative.session_done, { n: 4, p3: 2 });
});

test('null optional fields are treated as absent', async () => {
  const { h } = setup();
  const [, b] = await json(await h(post([
    { k: 'session_done', app: null, p: 3, sid: SID_A, about: null, ans: null },
    { k: 'share', method: 'copy', what: null, app: null },
    { k: 'room_join', ok: false, reason: null, room: null, ms: null },
    { k: 'ask_answer', app: 'quiz-ox', a: 'no', why: null },
    { k: 'game_created', source: 'editor', gid: null }, // a required field null = missing -> bad
  ])));
  assert.deepEqual(b, { ok: true, accepted: 4, dropped: 1 });
  const a = await (await h(get())).json();
  assert.equal(a.summary.sessionsDone3, 1);
  assert.equal(a.counters.session_done.about, undefined);
  assert.deepEqual(a.summary.bad, { game_created: 1 });
});

test('normApp edges: tpl-app-x -> custom, ~quiz-ox -> other', async () => {
  const { normApp } = await import('../_lib/apps.js');
  assert.equal(normApp('tpl-app-x'), 'custom');
  assert.equal(normApp('~quiz-ox'), 'other');
  assert.equal(normApp('tpl-quiz-ox~CODE~MORE'), 'quiz-ox');
  assert.equal(normApp('custom'), 'custom');
  assert.equal(normApp(''), undefined);
  assert.equal(normApp(42), 'other');
});

test('KST midnight: 14:59:59Z counts on that KST day, 15:00Z on the next', async () => {
  const { h, at } = setup();
  at(Date.parse('2026-10-13T14:59:59Z'));
  await h(post([{ k: 'session_done', p: 3, sid: 'sid20000000000000001' }]));
  at(Date.parse('2026-10-13T15:00:00Z')); // UTC still the 13th, KST already the 14th
  await h(post([{ k: 'session_done', p: 3, sid: 'sid20000000000000002' }, { k: 'room_create' }]));
  const d13 = await (await h(get('?day=2026-10-13'))).json();
  const d14 = await (await h(get('?day=2026-10-14'))).json();
  assert.equal(d13.summary.sessionsDone, 1);
  assert.equal(d14.summary.sessionsDone, 1);
  assert.equal(d14.summary.roomsCreated, 1);
});

test('?week= across the year boundary: 2026-W53 = Mon 2026-12-28 … Sun 2027-01-03', async () => {
  const { h, at } = setup();
  at(Date.parse('2026-12-31T03:00:00Z'));
  await h(post([{ k: 'session_done', p: 3, sid: 'sid30000000000000001' }]));
  at(Date.parse('2027-01-02T03:00:00Z'));
  await h(post([{ k: 'session_done', p: 4, sid: 'sid30000000000000002' }]));
  at(Date.parse('2027-01-04T03:00:00Z')); // Monday of 2027-W01
  await h(post([{ k: 'session_done', p: 5, sid: 'sid30000000000000003' }]));
  const w = await (await h(get('?week=2026-W53'))).json();
  assert.equal(w.week, '2026-W53');
  assert.deepEqual([w.days[0], w.days[6]], ['2026-12-28', '2027-01-03']);
  assert.equal(w.summary.sessionsDone, 2);
  const w1 = await (await h(get('?week='))).json();
  assert.equal(w1.week, '2027-W01');
  assert.equal(w1.summary.sessionsDone, 1);
});

test('GET cache holds every readable day and week (> 100 keys) without thrashing', async () => {
  let t = T0;
  const memoryStore = createMemoryStore({ now: () => t });
  let reads = 0;
  const store = { ...memoryStore, kind: 'memory' };
  store.read = async (d) => (reads++, memoryStore.read(d));
  store.readDays = async (d) => (reads++, memoryStore.readDays(d));
  const lim = { check: () => null, dailyCapReached: () => false, noteTotal: () => {} };
  const h = createHandler({ env: {}, memoryStore: store, limiter: lim, now: () => t });
  const keys = [];
  for (let i = -1; i <= 90; i++) keys.push(`?day=${new Date(T0 + 9 * 3600e3 - i * 86_400_000).toISOString().slice(0, 10)}`);
  for (let w = 29; w <= 42; w++) keys.push(`?week=2026-W${w}`);
  assert.ok(keys.length > 100, String(keys.length));
  for (const q of keys) assert.equal((await h(get(q))).status, 200, q);
  const first = reads;
  assert.equal(first, keys.length);
  t += 10_000; // still inside the 30 s cache
  for (const q of keys) await h(get(q));
  assert.equal(reads, first, 'second pass served from the cache');
});

test('apply fails after the claim: claims are released, so the next report of that game counts', async () => {
  const db = new Map();
  let failApply = true;
  const cmds = [];
  const fetch = async (url, init) => {
    const batch = JSON.parse(init.body);
    if (failApply && batch.some(([c]) => c === 'HINCRBY')) return new Response('down', { status: 500 });
    const out = batch.map(([cmd, key, ...args]) => {
      cmds.push(cmd);
      if (cmd === 'SET') {
        if (db.has(key)) return { result: null };
        db.set(key, args[0]);
        return { result: 'OK' };
      }
      if (cmd === 'DEL') return { result: db.delete(key) ? 1 : 0 };
      if (cmd === 'HINCRBY') {
        const m = db.get(key) || new Map();
        db.set(key, m);
        m.set(args[0], (m.get(args[0]) || 0) + Number(args[1]));
        return { result: m.get(args[0]) };
      }
      if (cmd === 'INCRBY') { db.set(key, (db.get(key) || 0) + Number(args[0])); return { result: db.get(key) }; } // budget counter (store.js metered)
      if (cmd === 'EXPIRE') return { result: 1 };
      if (cmd === 'HGETALL') return { result: [...(db.get(key) || [])].flatMap(([f, v]) => [f, String(v)]) };
      return { error: 'ERR' };
    });
    return new Response(JSON.stringify(out));
  };
  const h = createHandler({ env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 't' }, fetch, now: () => T0 });
  const done = { k: 'session_done', app: 'quiz-ox', p: 3, sid: SID_A };
  const errLog = console.error;
  console.error = () => {};
  let r;
  try {
    r = await h(post([done]));
  } finally {
    console.error = errLog;
  }
  assert.equal(r.status, 503);
  assert.ok(cmds.includes('DEL'), 'the claim was released');
  assert.equal([...db.keys()].filter((k) => k.startsWith('ev:once:')).length, 0);
  failApply = false;
  assert.equal((await h(post([done]))).status, 200); // e.g. the other host's report
  const a = await (await h(get())).json();
  assert.equal(a.summary.sessionsDone, 1);
  assert.equal(a.summary.sessionsDup, 0);
});

test('Sec-GPC: 1 or DNT: 1 -> 204, nothing counted', async () => {
  const { h, memoryStore } = setup();
  for (const hdr of [{ 'sec-gpc': '1' }, { dnt: '1' }]) {
    const r = await h(new Request(URL_EV, { method: 'POST', headers: hdr, body: JSON.stringify({ v: 1, events: [{ k: 'room_create' }] }) }));
    assert.equal(r.status, 204);
  }
  assert.equal(memoryStore.data.size, 0);
  assert.equal((await h(post([{ k: 'room_create' }]))).status, 200);
});
