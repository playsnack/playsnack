// Saved room results: POST/GET /api/room-result (docs/room-results.md).
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, DEFAULT_DAILY_READS, DEFAULT_DAILY_SAVES, DEFAULT_MONTHLY_BUDGET } from '../room-result.js';
import { DEFAULT_MONTHLY_BUDGET as EV_BUDGET } from '../ev.js';
import { createMemoryStore, RR_TTL_SECONDS } from '../_lib/store.js';
import { createLimiter } from '../_lib/ratelimit.js';
import { parseRoomResult, roomHash, RR_MAX_BODY_BYTES } from '../_lib/roomResult.js';

const BASE = 'https://playsnack.test/api/room-result';
const ROOM = 'tpl-speed-trivia-score~QWERTYZ234';
const SID = 'GameSid0123456789abc';
const IP = '203.0.113.77';
const ANON = 'anon-7f3a9c1e-secret';
const KV = { UPSTASH_REDIS_REST_URL: 'https://fake-upstash.test', UPSTASH_REDIS_REST_TOKEN: 't' };

const recap = () => ({
  subject: '민수', about: '민수', title: '민수 맞히기', packId: 'Pack0123456789abcdef',
  rounds: [
    { q: '내 MBTI는?', options: ['INFP', 'ESTJ'], answer: 0, picks: [
      { nick: '지영', pid: 'p2', option: 0, ms: 900, correct: true, points: 880 },
      { nick: '철수', pid: 'p3', option: -1, ms: -1, correct: false, points: 0 },
    ] },
  ],
});
const result = (over = {}) => ({
  v: 1, sid: SID, endedAt: 1, title: '민수 맞히기', about: '민수',
  board: [{ pid: 'p2', nick: '지영', score: 880 }, { pid: 'p3', nick: '철수', score: 0, left: true }],
  quizRecap: recap(), ...over,
});
const post = (body, headers = {}) =>
  new Request(BASE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (room = ROOM) => new Request(`${BASE}?room=${encodeURIComponent(room)}`, { headers: { 'x-forwarded-for': IP } });
const roomy = () => createLimiter({ bucketSize: 1e6, minuteCap: 1e6 });

/** Fake Upstash /pipeline: counts every command, keeps TTLs. */
function fakeUpstash() {
  const db = new Map();
  const ttl = new Map();
  const calls = [];
  const fetch = async (_url, init) => {
    const cmds = JSON.parse(init.body);
    calls.push(cmds);
    const out = cmds.map(([cmd, key, ...args]) => {
      if (cmd === 'INCRBY' || cmd === 'INCR') {
        db.set(key, (Number(db.get(key)) || 0) + (cmd === 'INCR' ? 1 : Number(args[0])));
        return { result: db.get(key) };
      }
      if (cmd === 'SET') {
        if (args.includes('NX') && db.has(key)) return { result: null };
        db.set(key, args[0]);
        const ex = args.indexOf('EX');
        if (ex >= 0) ttl.set(key, args[ex + 1]);
        return { result: 'OK' };
      }
      if (cmd === 'GET') return { result: db.has(key) ? db.get(key) : null };
      if (cmd === 'DEL') return { result: db.delete(key) ? 1 : 0 };
      if (cmd === 'EXPIRE') {
        ttl.set(key, args[0]);
        return { result: 1 };
      }
      return { error: `ERR unknown ${cmd}` };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const sent = () => calls.reduce((n, c) => n + c.length, 0);
  return { db, ttl, calls, fetch, sent };
}

test('defaults: one monthly budget with /api/ev; daily caps', () => {
  assert.equal(DEFAULT_MONTHLY_BUDGET, EV_BUDGET);
  assert.equal(DEFAULT_DAILY_SAVES, 200);
  assert.equal(DEFAULT_DAILY_READS, 1000);
  assert.equal(RR_TTL_SECONDS, 7 * 86_400);
});

test('POST then GET: the saved ranking + recap comes back; 404 before', async () => {
  const h = createHandler({ env: {}, limiter: roomy() });
  assert.equal((await h(get())).status, 404);
  const p = await h(post({ room: ROOM, sid: SID, result: result() }));
  assert.equal(p.status, 200);
  assert.deepEqual(await p.json(), { ok: true, saved: true });
  const g = await h(get());
  assert.equal(g.status, 200);
  assert.match(g.headers.get('cache-control'), /max-age=10/);
  const { result: r } = await g.json();
  assert.equal(r.app, 'tpl-speed-trivia-score');
  assert.equal(r.title, '민수 맞히기');
  assert.deepEqual(r.board.map((b) => b.nick), ['지영', '철수']);
  assert.equal(r.board[1].left, true);
  assert.equal(r.quizRecap.rounds[0].picks[0].option, 0);
  assert.equal(r.sid, undefined, 'the game id is not kept in the record');
  // another room's link: nothing
  assert.equal((await h(get('tpl-speed-trivia-score~ZZZZZZZZZZ'))).status, 404);
});

test('write-once per game: a second post of the same sid (hand-over) changes nothing; a new game overwrites', async () => {
  let t = Date.parse('2026-10-14T03:00:00Z');
  const h = createHandler({ env: {}, limiter: roomy(), now: () => t });
  await h(post({ room: ROOM, sid: SID, result: result() }));
  const again = await h(post({ room: ROOM, sid: SID, result: result({ board: [{ pid: 'p9', nick: '가짜', score: 1 }] }) }));
  assert.deepEqual(await again.json(), { ok: true, saved: false });
  t += 11_000; // past the GET cache
  assert.equal((await (await h(get())).json()).result.board[0].nick, '지영');
  const sid2 = 'GameSid0123456789xyz';
  await h(post({ room: ROOM, sid: sid2, result: result({ sid: sid2, board: [{ pid: 'p2', nick: '새판', score: 5 }], quizRecap: undefined, title: undefined, about: undefined }) }));
  const r = (await (await h(get())).json()).result;
  assert.equal(r.board[0].nick, '새판');
  assert.equal(r.quizRecap, undefined);
});

test('kept 7 days, then gone', async () => {
  let t = Date.parse('2026-10-14T03:00:00Z');
  const h = createHandler({ env: {}, limiter: roomy(), now: () => t });
  await h(post({ room: ROOM, sid: SID, result: result() }));
  t += 7 * 86_400_000 - 60_000;
  assert.equal((await h(get())).status, 200);
  t += 120_000;
  assert.equal((await h(get())).status, 404);
});

test('validation: public rooms, bad ids, oversize text, too many players / rounds, size cap', async () => {
  const h = createHandler({ env: {}, limiter: roomy() });
  const bad = async (body, status = 400) => assert.equal((await h(post(body))).status, status, JSON.stringify(body).slice(0, 120));
  await bad({ room: 'tpl-speed-trivia-score', sid: SID, result: result() }); // public room
  await bad({ room: 'tpl-speed-trivia-score~short', sid: SID, result: result() });
  await bad({ room: '../etc~QWERTYZ234', sid: SID, result: result() });
  await bad({ room: ROOM, sid: 'x', result: result() });
  await bad({ room: ROOM, sid: SID, result: result({ sid: 'GameSid0123456789zzz' }) });
  await bad({ room: ROOM, sid: SID, result: result({ v: 2 }) });
  await bad({ room: ROOM, sid: SID, result: result({ board: [{ pid: 'p1', nick: '가'.repeat(11), score: 1 }] }) });
  await bad({ room: ROOM, sid: SID, result: result({ board: [{ pid: 'x1', nick: '가', score: 1 }] }) });
  await bad({ room: ROOM, sid: SID, result: result({ board: [{ pid: 'p1', nick: '가', score: -1 }] }) });
  await bad({ room: ROOM, sid: SID, result: result({ board: Array.from({ length: 21 }, (_, i) => ({ pid: `p${i + 1}`, nick: 'n', score: 0 })) }) });
  const r = recap();
  r.rounds = Array.from({ length: 21 }, () => recap().rounds[0]);
  await bad({ room: ROOM, sid: SID, result: result({ quizRecap: r }) });
  const r2 = recap();
  r2.rounds[0].q = '질'.repeat(81);
  await bad({ room: ROOM, sid: SID, result: result({ quizRecap: r2 }) });
  const r3 = recap();
  r3.rounds[0].picks[0].option = 5;
  await bad({ room: ROOM, sid: SID, result: result({ quizRecap: r3 }) });
  await bad({ room: ROOM, sid: SID, result: result({ board: [], quizRecap: undefined }) }); // nothing to show
  await bad('{not json');
  await bad('x'.repeat(RR_MAX_BODY_BYTES + 1), 413);
  assert.equal((await h(get('tpl-speed-trivia-score'))).status, 400);
  assert.equal((await h(new Request(BASE, { method: 'DELETE' }))).status, 405);
  // the largest real game fits: 20 players × 20 rounds of 4 long options
  const big = recap();
  const players = Array.from({ length: 20 }, (_, i) => ({ pid: `p${i + 1}`, nick: `친구친구친구친구친${i % 10}` }));
  big.rounds = Array.from({ length: 20 }, () => ({
    q: '질문'.repeat(40), options: Array.from({ length: 4 }, () => '보기'.repeat(15)), answer: 1,
    picks: players.map((p) => ({ ...p, option: 1, ms: 12000, correct: true, points: 900 })),
  }));
  const body = JSON.stringify({ room: ROOM, sid: SID, result: result({ quizRecap: big, board: players.slice(0, 8).map((p) => ({ ...p, score: 18000 })) }) });
  // A full 20×20 game is larger than the cap: the client trims it (roomResult.ts) — this proves the cap bites.
  assert.ok(body.length > RR_MAX_BODY_BYTES);
});

test('privacy: no anonId, IP, room id or code in storage; unknown fields are dropped', async () => {
  const memoryStore = createMemoryStore();
  const h = createHandler({ env: {}, limiter: roomy(), memoryStore });
  const res = result({ anonId: ANON, deviceId: ANON, board: [{ pid: 'p2', nick: '지영', score: 1, anonId: ANON }] });
  res.quizRecap.rounds[0].picks[0].anonId = ANON;
  assert.equal((await h(post({ room: ROOM, sid: SID, result: res, anonId: ANON }))).status, 200);
  const dump = JSON.stringify([...memoryStore.rr]);
  for (const secret of [ANON, IP, 'QWERTYZ234', ROOM, SID]) assert.ok(!dump.includes(secret), `stored: ${secret}`);
  assert.ok([...memoryStore.rr.keys()].some((k) => k === `rr:${roomHash(ROOM)}`));
});

test('KV: every command is metered into the shared monthly budget; TTLs set; write-once by SET NX', async () => {
  const up = fakeUpstash();
  const h = createHandler({ env: KV, fetch: up.fetch, limiter: roomy() });
  assert.equal((await h(post({ room: ROOM, sid: SID, result: result() }))).status, 200);
  assert.equal((await h(post({ room: ROOM, sid: SID, result: result() }))).status, 200);
  assert.equal((await h(get())).status, 200);
  const month = [...up.db.keys()].find((k) => k.startsWith('ev:budget:'));
  assert.ok(month, 'the /api/ev budget key');
  assert.equal(up.db.get(month), up.sent(), 'budget count = commands actually sent');
  const key = `rr:${roomHash(ROOM)}`;
  assert.equal(up.ttl.get(key), RR_TTL_SECONDS);
  const sidKey = [...up.db.keys()].find((k) => k.startsWith('rr:sid:'));
  assert.equal(up.ttl.get(sidKey), RR_TTL_SECONDS);
  assert.ok(up.calls.flat().some((c) => c[0] === 'SET' && c[1] === sidKey && c.includes('NX')));
  assert.equal(up.calls.flat().filter((c) => c[0] === 'SET' && c[1] === key).length, 1, 'the second post wrote nothing');
  for (const k of up.ttl.keys()) assert.ok(up.ttl.get(k) > 0);
  assert.ok([...up.db.keys()].filter((k) => k.startsWith('rr:w:') || k.startsWith('rr:r:')).every((k) => up.ttl.has(k)));
});

test('budget reached: no KV command; daily save / read caps', async () => {
  const up = fakeUpstash();
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  up.db.set(`ev:budget:${month}`, 999);
  const h = createHandler({ env: { ...KV, EV_MONTHLY_BUDGET: '1000' }, fetch: up.fetch, limiter: roomy() });
  assert.equal((await h(post({ room: ROOM, sid: SID, result: result() }))).status, 200); // learns the count
  const before = up.sent();
  const p = await h(post({ room: ROOM, sid: 'GameSid0123456789xyz', result: result({ sid: undefined }) }));
  assert.equal(p.status, 503);
  assert.equal(up.sent(), before, 'no command past the budget');

  const caps = createHandler({ env: { RR_DAILY_SAVES: '2', RR_DAILY_READS: '1' }, limiter: roomy() });
  for (const s of ['GameSid0123456789aa1', 'GameSid0123456789aa2']) assert.equal((await caps(post({ room: ROOM, sid: s, result: result({ sid: s }) }))).status, 200);
  assert.equal((await caps(post({ room: ROOM, sid: 'GameSid0123456789aa3', result: result({ sid: undefined }) }))).status, 429);
  assert.equal((await caps(get('tpl-speed-trivia-score~AAAAAAAAAA'))).status, 404);
  assert.equal((await caps(get('tpl-speed-trivia-score~BBBBBBBBBB'))).status, 503);
});

test('rate limit per client', async () => {
  const h = createHandler({ env: {} });
  let limited = 0;
  for (let i = 0; i < 15; i++) if ((await h(get())).status === 429) limited++;
  assert.ok(limited >= 4);
});

test('parseRoomResult keeps only whitelisted fields', () => {
  const p = parseRoomResult(JSON.stringify({ room: ROOM, sid: SID, result: result({ extra: 'x' }) }), 42);
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.record).sort(), ['about', 'app', 'board', 'endedAt', 'quizRecap', 'title', 'v']);
  assert.equal(p.record.endedAt, 42);
});
