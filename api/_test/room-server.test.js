// The edge room server's game events (edge/room results.js StatsSender → POST /api/ev,
// docs/telemetry.md §9.7): its User-Agent is not taken for a bot, the X-Room-Server secret
// gives it its own rate bucket, a wrong secret is refused before any KV command, and the
// usual once-per-game de-dup still holds.
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATED_UA, createHandler, roomServer } from '../ev.js';
import { createMemoryStore } from '../_lib/store.js';
import { STATS_UA } from '../../edge/room/src/results.js';

const URL_EV = 'https://playsnack.test/api/ev';
const SECRET = 'room-server-test-secret-0123456789';
const T0 = Date.parse('2026-10-13T03:00:00Z');
const SID = 'sidRRRRRRRRRRRRRRRR1';

function setup(env = { ROOM_SERVER_SECRET: SECRET }) {
  const memoryStore = createMemoryStore({ now: () => T0 });
  const h = createHandler({ env, memoryStore, now: () => T0 });
  return { h, memoryStore };
}
const post = (events, headers = {}) =>
  new Request(URL_EV, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': STATS_UA, 'x-forwarded-for': '172.70.1.1', ...headers }, body: JSON.stringify({ v: 1, events }) });
const done = (sid = SID) => ({ k: 'session_done', app: 'speed-trivia-score', p: 3, sid, about: false, ans: 2 });
const counters = async (h) => (await (await h(new Request(URL_EV))).json()).counters;

test('the room server User-Agent is not a bot', () => {
  assert.equal(STATS_UA, 'PlaySnack-RoomServer/1');
  assert.equal(AUTOMATED_UA.test(STATS_UA), false);
});

test('with the right secret: counted, de-duplicated by sid, and not held to one client bucket', async () => {
  const { h } = setup();
  const r = await h(post([done()], { 'x-room-server': SECRET }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, accepted: 1, dropped: 0 });
  await h(post([done()], { 'x-room-server': SECRET })); // the same game again (a reconnect, a retry)
  const c = await counters(h);
  assert.equal(c.games_finished, 1);
  assert.equal(c.games_finished_duplicates, 1);
  // Every room posts from the same few Cloudflare addresses: 40 posts in a row pass
  // (an ordinary client gets 20, then 429).
  for (let i = 0; i < 40; i++) {
    const x = await h(post([done(`sidSERVER${String(i).padStart(11, '0')}`)], { 'x-room-server': SECRET }));
    assert.equal(x.status, 200, `post ${i}`);
  }
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await h(post([{ k: 'room_create' }]))).status === 429) limited++;
  assert.ok(limited >= 5, 'an ordinary client from that address is still limited');
});

test('a wrong secret is 403 and touches nothing; no secret configured = an ordinary client', async () => {
  const { h, memoryStore } = setup();
  const r = await h(post([done()], { 'x-room-server': 'not-the-secret-at-all' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'bad_room_server');
  assert.equal(memoryStore.data.size, 0);
  const open = setup({});
  const r2 = await open.h(post([done()], { 'x-room-server': SECRET }));
  assert.equal(r2.status, 200);
  assert.equal((await counters(open.h)).games_finished, 1);
});

test('roomServer(): trusted / bad / null', () => {
  const req = (v) => new Request(URL_EV, { method: 'POST', headers: v === undefined ? {} : { 'x-room-server': v } });
  assert.equal(roomServer(req(SECRET), { ROOM_SERVER_SECRET: SECRET }), 'trusted');
  assert.equal(roomServer(req('x'), { ROOM_SERVER_SECRET: SECRET }), 'bad');
  assert.equal(roomServer(req(undefined), { ROOM_SERVER_SECRET: SECRET }), null);
  assert.equal(roomServer(req(SECRET), { ROOM_SERVER_SECRET: 'short' }), null, 'a too-short secret is not configured');
});
