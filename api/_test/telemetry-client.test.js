// Client round-trip: runs snack-player/src/telemetry.ts in Node with stubbed browser
// globals and feeds what it sends into the real /api/ev handler.
// Needs a Node that runs .ts directly (type stripping: Node >= 22.18 / 23.6; tested on 26).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../ev.js';
import { JOIN_FAIL_REASONS, normalizeEvent } from '../_lib/schema.js';

const TS = new URL('../../snack-player/src/telemetry.ts', import.meta.url).href;
let n = 0;
const fresh = () => import(`${TS}?case=${++n}`); // new module instance = new page load

let beacons, fetches, docListeners, winListeners, beaconOk;
function stubBrowser(navExtra = {}) {
  beacons = [];
  fetches = [];
  docListeners = {};
  winListeners = {};
  beaconOk = true;
  const nav = {
    sendBeacon: (url, body) => {
      if (!beaconOk) return false;
      beacons.push({ url, body });
      return true;
    },
    ...navExtra,
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (t, f) => ((docListeners[t] ||= []).push(f)),
  };
  globalThis.addEventListener = (t, f) => ((winListeners[t] ||= []).push(f));
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init });
    return new Response('{}');
  };
}
beforeEach(() => stubBrowser());

const toRequest = (body) =>
  new Request('https://playsnack.test/api/ev', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body,
  });

test('round trip: tracked events arrive in the aggregates', async () => {
  const t = await fresh();
  t.configureTelemetry({ build: 'a1b2c3d' });
  t.track({ k: 'open', route: 'app', app: 'quiz-ox' });
  t.track({ k: 'first_tap', ms: 420, app: 'quiz-ox' });
  t.track({ k: 'result', app: 'quiz-ox' });
  t.track({ k: 'share', method: 'copy', app: 'quiz-ox' });
  t.track({ k: 'room_join', ok: true, ms: 1800 });
  t.trackError('TypeError: "김철수" is not a function', 'BitePlayer');
  assert.equal(beacons.length, 0, 'batched, not sent per event');
  t.flush();
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, '/api/ev');
  assert.equal(typeof beacons[0].body, 'string');

  const h = createHandler({ env: {} });
  const res = await h(toRequest(beacons[0].body));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accepted: 6, dropped: 0 });
  const a = await (await h(new Request('https://playsnack.test/api/ev'))).json();
  assert.equal(a.total, 6);
  assert.equal(a.counters['page_opens_by_app:quiz-ox'], 1);
  assert.equal(a.counters['first_tap_ms_bucket:0-1s'], 1);
  assert.equal(a.summary.joinMs['1-2s'], 1);
  assert.equal(a.counters['errors_by_build:a1b2c3d'], 1);
  assert.deepEqual(a.errors.top, [{ msg: 'TypeError: <str> is not a function', count: 1 }]);
});

test('batches: 20 events flush immediately, rest on timer and on page hide', async () => {
  const t = await fresh();
  t.configureTelemetry({ flushMs: 20 });
  for (let i = 0; i < 25; i++) t.track({ k: 'result' });
  assert.equal(beacons.length, 1);
  assert.equal(JSON.parse(beacons[0].body).events.length, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(beacons.length, 2);
  assert.equal(JSON.parse(beacons[1].body).events.length, 5);

  t.track({ k: 'open', route: 'home' });
  document.visibilityState = 'hidden';
  for (const f of docListeners.visibilitychange) f();
  assert.equal(beacons.length, 3);
  t.track({ k: 'open', route: 'home' });
  for (const f of winListeners.pagehide) f();
  assert.equal(beacons.length, 4);
});

test('batches are split under 4 KB and all accepted by the server', async () => {
  const t = await fresh();
  for (let i = 0; i < 20; i++) t.track({ k: 'share', method: 'web', app: 'x'.repeat(400) });
  assert.ok(beacons.length >= 3, `expected split, got ${beacons.length}`);
  const h = createHandler({ env: {} });
  let accepted = 0;
  for (const b of beacons) {
    assert.ok(new TextEncoder().encode(b.body).length <= 4000);
    const r = await h(toRequest(b.body));
    assert.equal(r.status, 200);
    accepted += (await r.json()).accepted;
  }
  assert.equal(accepted, 20);
});

test('errors: deduped, at most 10 per page; window error + unhandledrejection hooked', async () => {
  const t = await fresh();
  t.installErrorBeacon('b1');
  for (const f of winListeners.error) f({ error: new TypeError('boom'), message: 'boom' });
  for (const f of winListeners.error) f({ error: new TypeError('boom'), message: 'boom' });
  for (const f of winListeners.unhandledrejection) f({ reason: new Error('nope') });
  for (let i = 0; i < 20; i++) t.trackError(`distinct ${i}`, 'x');
  t.flush();
  const evs = beacons.flatMap((b) => JSON.parse(b.body).events);
  assert.equal(evs.length, 10);
  assert.deepEqual(evs[0], { k: 'err', msg: 'TypeError: boom', where: 'window.error', build: 'b1' });
  assert.deepEqual(evs[1], { k: 'err', msg: 'Error: nope', where: 'unhandledrejection', build: 'b1' });
});

test('at most 200 events per page load', async () => {
  const t = await fresh();
  for (let i = 0; i < 250; i++) t.track({ k: 'result' });
  t.flush();
  assert.equal(beacons.flatMap((b) => JSON.parse(b.body).events).length, 200);
});

test('Do Not Track and Global Privacy Control disable collection (even if forced on)', async () => {
  for (const extra of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
    stubBrowser(extra);
    const t = await fresh();
    t.configureTelemetry({ enabled: true });
    assert.equal(t.telemetryEnabled(), false);
    t.track({ k: 'open', route: 'home' });
    t.trackError('x');
    t.flush();
    assert.equal(beacons.length + fetches.length, 0);
  }
  const t = await fresh();
  t.configureTelemetry({ enabled: false });
  t.track({ k: 'open', route: 'home' });
  t.flush();
  assert.equal(beacons.length, 0);
});

test('fetch keepalive fallback without credentials when sendBeacon refuses', async () => {
  const t = await fresh();
  beaconOk = false;
  t.track({ k: 'open', route: 'room' });
  t.flush();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].init.keepalive, true);
  assert.equal(fetches[0].init.credentials, 'omit');
  assert.equal(JSON.parse(fetches[0].init.body).events[0].route, 'room');
});

test('client sends only event fields: no person/device/browser-session ids, cookies, storage or UA', async () => {
  const touched = [];
  const trap = new Proxy({}, { get: (_, p) => (touched.push(String(p)), undefined) });
  globalThis.localStorage = trap;
  globalThis.sessionStorage = trap;
  document.cookie = 'sid=secret';
  navigator.userAgent = 'SecretUA/1.0';
  const t = await fresh();
  t.track({ k: 'open', route: 'home' });
  t.flush();
  assert.deepEqual(JSON.parse(beacons[0].body), { v: 1, events: [{ k: 'open', route: 'home' }] });
  assert.deepEqual(touched, []);
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

test('free-beta helpers: typed events, room code / sid kept off the wire for ask_*, once per game', async () => {
  const t = await fresh();
  const SID = 'gameSid000000000001';
  t.trackSessionDone('speed-trivia-score~QWERTYZ23456', 4, SID, { about: true, answerers: 3 });
  t.trackSessionDone('speed-trivia-score~QWERTYZ23456', 4, SID); // same game again on this page: ignored
  t.trackRematch('tpl-tap-battle', 3, 'gameSid000000000002');
  t.trackRoomCreate('tap-battle');
  t.trackGameCreated('speed-trivia-score~QWERTYZ23456', 'remake', 'packGid0000000000001');
  t.trackGameCreated('speed-trivia-score~QWERTYZ23456', 'remake', 'packGid0000000000001'); // same pack: once
  t.trackJoin('tap-battle~QWERTYZ23456', true, { ms: 812.6, room: 'friend' });
  t.trackJoin('tap-battle', false, { room: 'public', reason: t.joinFailReason('refused: bad user') });
  t.trackShare('copy', 'invite', 'tap-battle~QWERTYZ23456');
  t.trackAskShown('app-9f8e7d', SID);
  t.trackAskShown('app-9f8e7d', SID);
  t.trackAskAnswer('app-9f8e7d', SID, 'no', 'laggy');
  t.trackAskAnswer('app-9f8e7d', SID, 'yes');
  t.flush();
  const evs = beacons.flatMap((b) => JSON.parse(b.body).events);
  assert.deepEqual(evs, [
    { k: 'session_done', app: 'speed-trivia-score', p: 4, sid: SID, about: true, ans: 3 },
    { k: 'rematch', app: 'tap-battle', p: 3, sid: 'gameSid000000000002' },
    { k: 'room_create', app: 'tap-battle' },
    { k: 'game_created', app: 'speed-trivia-score', source: 'remake', gid: 'packGid0000000000001' },
    { k: 'room_join', ok: true, app: 'tap-battle', ms: 813, room: 'friend' },
    { k: 'room_join', ok: false, app: 'tap-battle', room: 'public', reason: 'refused' },
    { k: 'share', method: 'copy', what: 'invite', app: 'tap-battle' },
    { k: 'ask_shown', app: 'custom' },
    { k: 'ask_answer', app: 'custom', a: 'no', why: 'laggy' },
  ]);
  assert.ok(!beacons.some((b) => b.body.includes('QWERTYZ23456')), 'room code never sent');

  const h = createHandler({ env: {} });
  let accepted = 0;
  for (const b of beacons) accepted += (await (await h(toRequest(b.body))).json()).accepted;
  assert.equal(accepted, evs.length, 'the server accepts every helper event');
  const a = await (await h(new Request('https://playsnack.test/api/ev'))).json();
  assert.equal(a.summary.sessionsDone3, 1);
  assert.equal(a.summary.gamesCreated, 1);
  assert.equal(a.summary.gamesRemade, 1);
  assert.equal(a.summary.sessionsAbout, 1);
  assert.deepEqual(a.summary.joinFailReasons, { refused: 1 });
});

test('room_join carries via (the transport used) and the server keeps room-server joins apart', async () => {
  const t = await fresh();
  t.trackJoin('tap-battle~QWERTYZ23456', true, { ms: 640, room: 'friend', via: 'edge' });
  t.trackJoin('tap-battle', false, { room: 'public', reason: 'timeout', via: 'edge' });
  t.trackJoin('tap-battle', true, { ms: 3800, room: 'public', tries: 2, via: 'mesh' });
  t.trackJoin('tap-battle', true, { ms: 900 }); // no via (a caller that does not know): none sent
  t.flush();
  const evs = beacons.flatMap((b) => JSON.parse(b.body).events);
  assert.deepEqual(evs.map((e) => e.via), ['edge', 'edge', 'mesh', undefined]);
  assert.deepEqual(evs[0], { k: 'room_join', ok: true, app: 'tap-battle', ms: 640, room: 'friend', via: 'edge' });
  const h = createHandler({ env: {} });
  for (const b of beacons) assert.equal((await (await h(toRequest(b.body))).json()).accepted, 4);
  const a = await (await h(new Request('https://playsnack.test/api/ev'))).json();
  assert.deepEqual([a.summary.joinOk, a.summary.joinFail], [3, 1], 'the combined numbers still count every join');
  assert.deepEqual([a.summary.joinEdgeOk, a.summary.joinEdgeFail], [1, 1]);
  assert.equal(a.summary.joinEdgeMs['0-1s'], 1);
  assert.equal(a.counters['join_edge_ms_bucket:0-1s'], 1);
});

test('joinFailReason maps transport reasons onto the reported set', async () => {
  const t = await fresh();
  const cases = { timeout: 'timeout', unreachable: 'unreachable', disconnected: 'disconnected', broker: 'unreachable',
    subscribe: 'subscribe', silence: 'silence', load: 'network', 'refused: Not authorized': 'refused', whatever: 'other', '': 'other',
    // #157 room server refusals: the reason only ('pin-required' counts as 'pin')
    pin: 'pin', 'pin-required': 'pin', locked: 'locked', closed: 'closed', expired: 'expired', slow: 'slow', seat_taken: 'seat_taken', full: 'full',
    room_full_today: 'other', replaced: 'other' };
  for (const [raw, want] of Object.entries(cases)) assert.equal(t.joinFailReason(raw), want, raw);
  assert.equal(t.joinFailReason(undefined), 'other');
  assert.equal(t.appOf('quiz-ox~ABCDEFGH'), 'quiz-ox');
  assert.equal(t.appOf('app-abc123'), 'custom');
});

test('game helpers DO send the random per-game id (sid / gid) — and nothing else that identifies', async () => {
  const t = await fresh();
  t.trackSessionDone('speed-trivia-score', 3, 'gameSid00000000000A');
  t.trackRematch('speed-trivia-score', 3, 'gameSid00000000000B');
  t.trackGameCreated('speed-trivia-score', 'editor', 'packGid00000000000C');
  t.trackSessionDone('speed-trivia-score', 0, 'gameSid00000000000Z'); // nobody took part: not sent
  t.flush();
  const evs = beacons.flatMap((b) => JSON.parse(b.body).events);
  assert.deepEqual(evs.map((e) => e.sid ?? e.gid), ['gameSid00000000000A', 'gameSid00000000000B', 'packGid00000000000C']);
  for (const e of evs) assert.deepEqual(Object.keys(e).filter((f) => !['k', 'app', 'p', 'sid', 'gid', 'source'].includes(f)), []);
});

test('automatedBrowser: webdriver or a headless/bot user agent stops collection; phones do not', async () => {
  const { automatedBrowser } = await import('../../snack-player/src/telemetry.ts');
  assert.equal(automatedBrowser({ webdriver: true, userAgent: 'Mozilla/5.0 (iPhone)' }), true);
  assert.equal(automatedBrowser({ webdriver: false, userAgent: 'Mozilla/5.0 HeadlessChrome/131.0' }), true);
  assert.equal(automatedBrowser({ webdriver: false, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36' }), false);
  assert.equal(automatedBrowser({ webdriver: false, userAgent: 'Mozilla/5.0 (iPhone) KAKAOTALK 10.8.0' }), false);
  assert.equal(automatedBrowser(undefined), false);
});

test('#157: every reason joinFailReason reports is one the ingest keeps (room server refusals included)', async () => {
  const t = await fresh();
  for (const raw of ['pin', 'pin-required', 'locked', 'closed', 'expired', 'slow', 'seat_taken', 'full', 'timeout', 'silence', 'nonsense']) {
    const reason = t.joinFailReason(raw);
    assert.ok(JOIN_FAIL_REASONS.has(reason), `${raw} → ${reason}`);
    const n = normalizeEvent({ k: 'room_join', ok: false, ms: 900, room: 'friend', reason, via: 'edge' });
    assert.ok(n && n.fields.includes(`join_failed_reason:${reason}`), raw);
  }
  assert.equal(normalizeEvent({ k: 'room_join', ok: false, reason: 'pin-required' }), null, 'raw server words never pass');
});
