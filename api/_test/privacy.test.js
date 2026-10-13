// Privacy: identifying request data must never reach storage, limiter keys,
// KV commands or logs. node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler } from '../ev.js';
import { createMemoryStore } from '../_lib/store.js';
import { createLimiter } from '../_lib/ratelimit.js';

const IP = '203.0.113.77';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) SnackSecretUA/9.9';
const NICK = '김철수닉네임';
const COOKIE = 'sid=cookie-secret-123';
const DEVICE = 'device-id-abcdef0123456789';
const EMAIL = 'kim.chulsoo@example.com';
const SECRETS = [IP, UA, 'SnackSecretUA', NICK, '김철수', COOKIE, 'cookie-secret', DEVICE, EMAIL, 'example.com'];

const headers = {
  'content-type': 'text/plain;charset=UTF-8',
  'x-forwarded-for': `${IP}, 10.0.0.1`,
  'x-real-ip': IP,
  'x-vercel-forwarded-for': IP,
  'user-agent': UA,
  cookie: COOKIE,
  'x-device-id': DEVICE,
};
const events = [
  { k: 'open', route: 'room', app: NICK, nickname: NICK, deviceId: DEVICE, sessionId: DEVICE, ua: UA, ip: IP },
  { k: 'result', app: 'quiz-ox', nick: NICK },
  { k: 'share', method: 'copy', app: DEVICE },
  { k: 'room_join', ok: true, ms: 900, player: NICK },
  { k: 'err', msg: `"${NICK}" left room ${IP} (${EMAIL}) ua=${UA} cookie ${COOKIE}`, where: NICK, build: DEVICE },
  { k: 'err', msg: `${NICK} 님이 입장했습니다`, where: 'room' },
  { k: NICK },
];
const post = () =>
  new Request('https://playsnack.test/api/ev', { method: 'POST', headers, body: JSON.stringify({ v: 1, events }) });
const get = () => new Request('https://playsnack.test/api/ev', { headers });

function assertClean(label, text) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${label} leaked ${JSON.stringify(s)}: ${text.slice(0, 400)}`);
}

/** Minimal fake of the Upstash REST /pipeline endpoint that records everything it receives. */
function fakeUpstash() {
  const db = new Map();
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: JSON.stringify(init.headers), body: String(init.body) });
    assert.equal(String(url), 'https://fake-upstash.test/pipeline');
    assert.equal(init.headers.authorization, 'Bearer fake-token');
    const out = JSON.parse(init.body).map(([cmd, key, ...args]) => {
      if (cmd === 'HINCRBY') {
        const h = db.get(key) || new Map();
        db.set(key, h);
        h.set(args[0], (h.get(args[0]) || 0) + Number(args[1]));
        return { result: h.get(args[0]) };
      }
      if (cmd === 'INCRBY') {
        db.set(key, (db.get(key) || 0) + Number(args[0]));
        return { result: db.get(key) };
      }
      if (cmd === 'EXPIRE') return { result: 1 };
      if (cmd === 'HGETALL') return { result: [...(db.get(key) || [])].flatMap(([f, v]) => [f, String(v)]) };
      return { error: `ERR unknown ${cmd}` };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { db, seen, fetch };
}

function captureConsole() {
  const lines = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...a) => lines.push(a.map(String).join(' '));
  }
  return { lines, restore: () => Object.assign(console, orig) };
}

test('fake IP/UA/nickname/cookie/device id never reach the fake Upstash, limiter keys or logs', async () => {
  const up = fakeUpstash();
  const limiter = createLimiter();
  const h = createHandler({
    env: { UPSTASH_REDIS_REST_URL: 'https://fake-upstash.test/', UPSTASH_REDIS_REST_TOKEN: 'fake-token' },
    fetch: up.fetch,
    limiter,
  });
  const con = captureConsole();
  let res, agg;
  try {
    res = await h(post());
    agg = await h(get());
  } finally {
    con.restore();
  }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ev-store'), 'kv');
  assert.deepEqual(await res.json(), { ok: true, accepted: 6, dropped: 1 });

  // Every command/URL/header sent to the KV.
  assert.ok(up.seen.length >= 2);
  for (const s of up.seen) assertClean('kv request', s.url + s.headers + s.body);
  // Everything stored.
  const stored = JSON.stringify([...up.db].map(([k, h]) => [k, typeof h === 'number' ? h : [...h]]));
  assertClean('kv storage', stored);
  for (const k of up.db.keys()) assert.match(k, /^ev:(\d{4}-\d{2}-\d{2}(:err)?|budget:\d{4}-\d{2})$/);
  // Off-list app ids collapse to "other"; nicknames in errors are gone.
  const body = await agg.json();
  assert.deepEqual(body.counters.open.app, { other: 1 });
  assert.deepEqual(body.counters.share.app, { other: 1 });
  assert.deepEqual(body.counters.err.where, { other: 1, room: 1 });
  for (const e of body.errors.top) assert.doesNotMatch(e.msg, /[^\x00-\x7f]/);
  assertClean('GET response', JSON.stringify(body));

  // Limiter keys are salted daily hashes, not the address or its plain hash.
  const keys = [...limiter.buckets.keys()];
  assert.equal(keys.length, 1);
  assertClean('limiter keys', keys.join(','));
  assert.match(keys[0], /^[0-9a-f]{24}$/);
  assert.ok(!createHash('sha256').update(IP).digest('hex').startsWith(keys[0]));
  // Logs: the live error lines (Vercel Logs tab) are there, and clean.
  assert.equal(con.lines.filter((l) => l.startsWith('[ev] err ')).length, 2);
  assertClean('console', con.lines.join('\n'));
});

test('memory fallback stores nothing identifying either', async () => {
  const memoryStore = createMemoryStore();
  const h = createHandler({ env: {}, memoryStore });
  const res = await h(post());
  assert.equal(res.headers.get('x-ev-store'), 'memory');
  const dump = JSON.stringify([...memoryStore.data].map(([k, m]) => [k, [...m]]));
  assertClean('memory storage', dump);
  assert.match(dump, /room_join\|ok/);
});

test('limiter salt rotates with the KST day', () => {
  const lim = createLimiter();
  const k1 = lim.keyFor(IP, '2026-10-12');
  assert.equal(lim.keyFor(IP, '2026-10-12'), k1);
  assert.notEqual(lim.keyFor(IP, '2026-10-13'), k1);
  // A different instance (different random salt) yields a different key for the same address/day.
  assert.notEqual(createLimiter().keyFor(IP, '2026-10-12'), k1);
});
