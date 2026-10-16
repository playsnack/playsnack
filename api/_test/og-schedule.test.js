// Link previews of a scheduled start (#218, api/_lib/og.js): a friends room whose host set the start
// says "오후 8:30 시작" (Korea time) — read with the same one room lookup (300 ms budget, crawlers
// only, cached), never for a PIN room or a public link.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUIZ_APP_ID, ROOM_LOOKUP_MS, _roomCache, lookupAbout, lookupRoom, ogMeta, startText } from '../_lib/og.js';

const catalog = JSON.parse(readFileSync(new URL('../../snack-server/data/bite/index.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../snack-player/public/og/manifest.json', import.meta.url), 'utf8'));
const O = 'https://playsnack.pages.dev';
const CODE = 'K7MNP2QRS4';
const OPEN15 = 'K7MNP2QRS4ABCDE';
const PIN20 = 'K7MNP2QRS4ABCDEFGH23';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
beforeEach(() => _roomCache.clear());

// 2026-10-16 20:10 KST = 11:10 UTC
const KST_2010 = Date.UTC(2026, 9, 16, 11, 10);

test('startText: Korea time; 내일 when not today there; nothing for a past / far / odd time', () => {
  assert.equal(startText(Date.UTC(2026, 9, 16, 11, 30), KST_2010), '오후 8:30');
  assert.equal(startText(Date.UTC(2026, 9, 17, 0, 0), KST_2010), '내일 오전 9:00');
  assert.equal(startText(Date.UTC(2026, 9, 16, 14, 59), KST_2010), '오후 11:59');
  assert.equal(startText(Date.UTC(2026, 9, 16, 15, 0), KST_2010), '내일 오전 12:00', 'midnight KST is tomorrow');
  assert.equal(startText(KST_2010 - 1000, KST_2010), '', 'past');
  assert.equal(startText(KST_2010 + 26 * 3600_000, KST_2010), '', 'more than a day away');
  for (const bad of [null, undefined, 'x', NaN, 0]) assert.equal(startText(bad, KST_2010), '', String(bad));
});

test('ogMeta: a friends link with a scheduled start says it in the title and description; never a PIN room / a public link', () => {
  const at = Date.UTC(2026, 9, 16, 11, 30);
  const m = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${OPEN15}`, catalog, manifest, startAt: at, now: KST_2010 });
  assert.equal(m.title, '탭 배틀 · 오후 8:30 시작');
  assert.match(m.description, /^오후 8:30 시작! 친구가 방에 초대했어요/);
  const q = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}?room=${OPEN15}`, catalog, manifest, about: '민수', startAt: at, now: KST_2010 });
  assert.equal(q.title, '민수 맞히기 · 나를 얼마나 알까? · 오후 8:30 시작');
  assert.match(q.description, /^오후 8:30 시작! 민수님에 대한 퀴즈예요/);
  const pin = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${PIN20}`, catalog, manifest, startAt: at, now: KST_2010 });
  assert.ok(!/시작!|8:30/.test(pin.title + pin.description), 'a PIN room says nothing of it');
  const pub = ogMeta({ url: `${O}/p/tpl-tap-battle`, catalog, manifest, startAt: at, now: KST_2010 });
  assert.ok(!/8:30/.test(pub.title + pub.description), 'a public link has no schedule');
  const plain = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${OPEN15}`, catalog, manifest });
  const past = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${OPEN15}`, catalog, manifest, startAt: KST_2010 - 1, now: KST_2010 });
  assert.deepEqual([past.title, past.description], [plain.title, plain.description], 'the time came: the usual preview');
});

test("lookupRoom: one request for any app's friends room — startAt even on a 404 (no saved game), about only for the quiz; cached", async () => {
  let calls = 0;
  let asked = '';
  const at = Date.now() + 600_000;
  const fetchImpl = async (u) => ((calls += 1), (asked = u), json(404, { ok: false, error: 'not_found', startAt: at }));
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r/', app: 'tap-battle', code: OPEN15, fetchImpl, now: 1000 }), { about: null, startAt: at });
  assert.equal(asked, `https://r/room/tpl-tap-battle~${OPEN15}/result`);
  await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: OPEN15, fetchImpl, now: 2000 });
  assert.equal(calls, 1, 'cached');
  const both = async () => json(200, { ok: true, result: { about: '민수' }, startAt: at });
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: QUIZ_APP_ID, code: CODE, fetchImpl: both }), { about: '민수', startAt: at });
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: CODE, fetchImpl: both }), '민수', 'lookupAbout = the quiz room’s about (cached)');
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: 'BBBBBBBB22', fetchImpl: both }), { about: null, startAt: at }, 'about only for the quiz');
  for (const body of [{ startAt: 'soon' }, { startAt: -5 }, 'nope', null]) {
    _roomCache.clear();
    assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: CODE, fetchImpl: async () => json(404, body) }), { about: null, startAt: null }, JSON.stringify(body));
  }
  _roomCache.clear();
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: CODE, fetchImpl: async () => json(500, { startAt: at }) }), { about: null, startAt: null }, 'a server error');
  let called = false;
  const spy = async () => ((called = true), json(200, {}));
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: PIN20, fetchImpl: spy }), { about: null, startAt: null });
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: '../x', code: CODE, fetchImpl: spy }), { about: null, startAt: null });
  assert.equal(called, false, 'a PIN room / an odd app is never asked');
});

test('lookupRoom: the 300 ms budget holds (a slow room → the usual preview, not cached)', async () => {
  const slow = (u, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(json(200, { startAt: Date.now() + 60_000 })), 2000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  assert.deepEqual(await lookupRoom({ roomBase: 'https://r', app: 'tap-battle', code: CODE, fetchImpl: slow }), { about: null, startAt: null });
  assert.ok(Date.now() - t0 < ROOM_LOOKUP_MS + 150, `gave up after ${Date.now() - t0} ms`);
  assert.equal(_roomCache.size, 0);
});
