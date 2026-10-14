// The free-beta metrics, wired (docs/telemetry.md §9.5): the room engine's hooks →
// telemetry.ts (engineMetrics) → the real /api/ev handler, and the result screen's
// reports (trackResultEvent, behind ResultExtras.tsx reportResultEvent).
// Runs snack-player/src/telemetry.ts in Node (type stripping: Node >= 22.18 / 23.6).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../ev.js';
import { WIRED } from '../_lib/schema.js';
import { connectMesh } from '../../packages/snack-room/src/meshClient.js';

const TS = new URL('../../snack-player/src/telemetry.ts', import.meta.url).href;
let n = 0;
const page = () => import(`${TS}?wiring=${++n}`); // new module instance = one device's page

let beacons;
beforeEach(() => {
  beacons = [];
  const nav = { sendBeacon: (url, body) => (beacons.push({ url, body }), true) };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener: () => {} };
  globalThis.addEventListener = () => {};
});
const sent = () => beacons.flatMap((b) => JSON.parse(b.body).events);
const post = (body) => new Request('https://playsnack.test/api/ev', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body });
async function deliver(h) {
  for (const b of beacons) assert.equal((await h(post(b.body))).status, 200);
  return (await h(new Request('https://playsnack.test/api/ev'))).json();
}

test('WIRED: the GET answer says the app sends the free-beta kinds', async () => {
  assert.equal(WIRED, true);
  const a = await (await createHandler({ env: {} })(new Request('https://playsnack.test/api/ev'))).json();
  assert.equal(a.wired, true);
});

test('reportResultEvent mapping: ask_shown / ask_answer once per game, why only with no, result share; room code never sent', async () => {
  const t = await page();
  const room = 'speed-trivia-score~QWERTYZ23456';
  t.trackResultEvent({ k: 'ask_shown' }, room, `${room}#1`);
  t.trackResultEvent({ k: 'ask_shown' }, room, `${room}#1`); // same game: once
  t.trackResultEvent({ k: 'ask_answer', a: 'no', why: 'few' }, room, `${room}#1`);
  t.trackResultEvent({ k: 'ask_answer', a: 'yes' }, room, `${room}#1`); // second answer, same game: dropped
  t.trackResultEvent({ k: 'ask_shown' }, room, `${room}#2`); // the next game asks again
  t.trackResultEvent({ k: 'ask_answer', a: 'yes', why: 'boring' }, room, `${room}#2`); // a reason only goes with no
  t.trackResultEvent({ k: 'share', method: 'web', what: 'result' }, room, `${room}#2`);
  t.flush();
  assert.deepEqual(sent(), [
    { k: 'ask_shown', app: 'speed-trivia-score' },
    { k: 'ask_answer', app: 'speed-trivia-score', a: 'no', why: 'few' },
    { k: 'ask_shown', app: 'speed-trivia-score' },
    { k: 'ask_answer', app: 'speed-trivia-score', a: 'yes' },
    { k: 'share', method: 'web', what: 'result', app: 'speed-trivia-score' },
  ]);
  assert.ok(!beacons.some((b) => b.body.includes('QWERTYZ') || b.body.includes('#')), 'no room code, no game key');
  const a = await deliver(createHandler({ env: {} }));
  assert.deepEqual([a.summary.askShown, a.summary.askYes, a.summary.askNo, a.summary.share], [2, 1, 1, 1]);
  assert.deepEqual(a.summary.bad, {});
});

test('engineMetrics mapping: rematch only when again, quiz fields only for a quiz, nobody took part = nothing', async () => {
  const t = await page();
  const m = t.engineMetrics('tap-battle~QWERTYZ23456');
  m.onSessionStart({ sid: 'sidFirst0000000000000001', players: 3, again: false });
  m.onSessionStart({ sid: 'sidAgain0000000000000002', players: 4, again: true });
  m.onSessionEnd({ sid: 'sidAgain0000000000000002', players: 3, quiz: false });
  m.onSessionEnd({ sid: 'sidEmpty0000000000000003', players: 0, quiz: false });
  m.onSessionEnd({ sid: 'sidQuiz00000000000000004', players: 2, quiz: true, about: true, answerers: 1 });
  m.onGameCreated({ gid: 'gidPack00000000000000005', source: 'remake' });
  t.flush();
  assert.deepEqual(sent(), [
    { k: 'rematch', app: 'tap-battle', p: 4, sid: 'sidAgain0000000000000002' },
    { k: 'session_done', app: 'tap-battle', p: 3, sid: 'sidAgain0000000000000002' },
    { k: 'session_done', app: 'tap-battle', p: 2, sid: 'sidQuiz00000000000000004', about: true, ans: 1 },
    { k: 'game_created', app: 'tap-battle', source: 'remake', gid: 'gidPack00000000000000005' },
  ]);
});

// ── end to end: real mesh rooms (in-memory bus), real engine, real handler ──
function hub(latency = 5) {
  const subs = new Map();
  return {
    createBus: (id) => ({
      publish: (m) => setTimeout(() => { for (const fn of subs.values()) fn(structuredClone(m)); }, latency),
      onMessage: (fn) => subs.set(id, fn),
      close: () => subs.delete(id),
    }),
  };
}
const FAST = { discoveryMs: 120, beatMs: 60, silenceMs: 250, snapshotMs: 20 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUIZ = { title: '나', questions: [{ q: '내 MBTI는?', options: ['INFP', 'ESTJ'], answer: 0 }] };
const START = { quiz: true, game: 'quiz', rounds: 1, answerMs: 3000, revealMs: 1500 };
const ROOM = 'speed-trivia-score~QWERTYZ23456';

async function device(h, num) {
  const t = await page(); // each device has its own telemetry page
  const shared = {};
  let seq = 0;
  const conn = connectMesh({
    createBus: h.createBus,
    me: { slug: ROOM, anonId: `a${num}`, nick: `닉${num}` },
    timing: FAST,
    engine: t.engineMetrics(ROOM), // as roomTransport.ts MeshTransport passes it
    onMessage: (m) => {
      if (m.t === 'state') Object.assign(shared, m.d.sharedState);
      else if (m.t === 'setVar') shared[m.d.id] = m.d.value;
    },
  });
  const act = (name, payload) => conn.sendAction(name, payload, crypto.randomUUID());
  return { t, conn, shared, act, num, seq };
}
const until = async (fn, ms = 15000) => {
  for (let w = 0; w < ms && !fn(); w += 50) await sleep(50);
  assert.ok(fn(), 'condition not reached');
};

test('e2e: a 1:1 quiz on a mesh room → exactly one session_done (+ game_created, rematch) through the handler', async () => {
  const h = hub();
  const ds = [await device(h, 1), await device(h, 2)];
  await until(() => ds.every((d) => d.shared.roster?.length === 2));
  const [subject, friend] = ds;
  subject.act('quizPack', QUIZ);
  await until(() => friend.shared.quizInfo?.custom === true);
  subject.act('start', START);
  await until(() => friend.shared.sessionPhase === 'play');
  friend.act('answer', { option: 0, ms: 400, round: 0, sessionNo: friend.shared.sessionNo });
  await until(() => ds.every((d) => d.shared.sessionPhase === 'result'));
  await sleep(1000); // staying in the result reports nothing more
  subject.act('start', START); // 다시 하기
  await until(() => friend.shared.sessionPhase === 'countdown');
  ds.forEach((d) => d.conn.close());
  ds.forEach((d) => d.t.flush());

  const evs = sent();
  assert.deepEqual(evs.map((e) => e.k).sort(), ['game_created', 'rematch', 'session_done']);
  const done = evs.find((e) => e.k === 'session_done');
  assert.deepEqual({ ...done, sid: '' }, { k: 'session_done', app: 'speed-trivia-score', p: 2, sid: '', about: true, ans: 1 });
  assert.equal(evs.find((e) => e.k === 'game_created').source, 'editor');
  assert.notEqual(evs.find((e) => e.k === 'rematch').sid, done.sid);
  const a = await deliver(createHandler({ env: {} }));
  assert.equal(a.summary.sessionsDone, 1);
  assert.equal(a.summary.sessionsDone3, 0, '1:1 is not the 3+ headline');
  assert.equal(a.summary.sessionsAbout, 1);
  assert.equal(a.summary.rematch, 1);
  assert.equal(a.summary.gamesCreated, 1);
  assert.equal(a.counters['games_finished_by_answerers:1'], 1);
  assert.deepEqual(a.summary.bad, {});
});

test('e2e: the host leaves mid-game → the new host reports the game; still exactly one session_done counted', async () => {
  const h = hub();
  const ds = [await device(h, 1)];
  await sleep(200); // device 1 hosts
  ds.push(await device(h, 2), await device(h, 3));
  await until(() => ds.every((d) => d.shared.roster?.length === 3));
  const host = ds.find((d) => d.conn.isHost);
  const rest = ds.filter((d) => d !== host);
  rest[0].act('quizPack', QUIZ); // the subject is not the host
  await until(() => rest[1].shared.quizInfo?.custom === true);
  rest[0].act('start', START);
  await until(() => rest[1].shared.sessionPhase === 'play');
  rest[1].act('answer', { option: 1, ms: 300, round: 0, sessionNo: rest[1].shared.sessionNo });
  host.act('answer', { option: 0, ms: 300, round: 0, sessionNo: host.shared.sessionNo });
  await sleep(300);
  host.conn.close(); // the host vanishes before the result
  await until(() => rest.every((d) => d.shared.sessionPhase === 'result'));
  await sleep(800);
  rest.forEach((d) => d.conn.close());
  ds.forEach((d) => d.t.flush());

  const done = sent().filter((e) => e.k === 'session_done');
  assert.equal(done.length, 1, 'one report, from the new host');
  assert.deepEqual({ ...done[0], sid: '' }, { k: 'session_done', app: 'speed-trivia-score', p: 3, sid: '', about: true, ans: 2 });
  // The race (§9.3): had the old host reported too, it would carry the same sid → counted once.
  beacons.push({ url: '/api/ev', body: JSON.stringify({ v: 1, events: [done[0]] }) });
  const a = await deliver(createHandler({ env: {} }));
  assert.equal(a.summary.sessionsDone, 1);
  assert.equal(a.summary.sessionsDup, 1);
  assert.equal(a.summary.sessionsDone3, 1, '3 took part (the subject counts) and someone answered');
});
