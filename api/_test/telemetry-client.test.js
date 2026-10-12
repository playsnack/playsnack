// Client round-trip: runs snack-player/src/telemetry.ts in Node with stubbed browser
// globals and feeds what it sends into the real /api/ev handler.
// Needs a Node that runs .ts directly (type stripping: Node >= 22.18 / 23.6; tested on 26).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../ev.js';

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
  assert.deepEqual(a.counters.open.app, { 'quiz-ox': 1 });
  assert.deepEqual(a.counters.first_tap_ms, { le500: 1 });
  assert.deepEqual(a.counters.room_join_ms, { ok: { le2000: 1 } });
  assert.deepEqual(a.counters.err.build, { a1b2c3d: 1 });
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

test('client sends only event fields: no ids, cookies, storage or UA', async () => {
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
