// Link-preview meta (#106, docs/link-previews.md): api/_lib/og.js — what functions/p/[[path]].js
// writes into index.html for each /p/ link.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_DESCRIPTION, DEFAULT_TITLE, QUIZ_APP_ID, ROOM_LOOKUP_MS, SPEED_QUIZ_ID, _roomCache, cleanName, entryFor, isPinCode, isPreviewBot,
  lookupAbout, metaHandlers, ogMeta, roomCode,
} from '../_lib/og.js';

const catalog = JSON.parse(readFileSync(new URL('../../snack-server/data/bite/index.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../snack-player/public/og/manifest.json', import.meta.url), 'utf8'));
const indexHtml = readFileSync(new URL('../../snack-player/index.html', import.meta.url), 'utf8');
const O = 'https://playsnack.pages.dev';
const CODE = 'K7MNP2QRS4';

beforeEach(() => _roomCache.clear());

test('a catalog slug → its title, tagline, own image, canonical url', () => {
  const m = ogMeta({ url: `${O}/p/tpl-worldcup-food?utm=x`, catalog, manifest });
  assert.equal(m.title, '야식 월드컵 — 친구랑 같이 골라 봐요');
  assert.match(m.description, /링크만 열면/);
  assert.equal(m.image, `${O}/og/app/worldcup-food.png?v=${manifest.apps['worldcup-food']}`);
  assert.equal(m.url, `${O}/p/tpl-worldcup-food`);
  assert.equal(m.square, null, 'the square site card only goes with the site image');
  assert.equal(m.app, 'worldcup-food');
});

test('every catalog app gets its own image and a non-default title', () => {
  for (const e of catalog) {
    const m = ogMeta({ url: `${O}/p/tpl-${e.id}`, catalog, manifest });
    // A bare 나 맞히기 link (no code) opens 스피드 퀴즈 (#210), so it previews that.
    const shown = e.mergedInto ?? (e.id === QUIZ_APP_ID ? SPEED_QUIZ_ID : e.id);
    assert.equal(m.app, shown, e.id);
    assert.ok(m.image.startsWith(`${O}/og/app/${shown}.png?v=`), e.id);
    assert.notEqual(m.title, DEFAULT_TITLE, e.id);
  }
});

test('나 맞히기 and 스피드 퀴즈 (one template, #210): each link its own title and picture', () => {
  const quiz = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}?room=${CODE}`, catalog, manifest });
  assert.equal(quiz.title, '나 맞히기 퀴즈 — 나를 얼마나 알까?');
  assert.equal(quiz.app, QUIZ_APP_ID);
  assert.equal(quiz.image, `${O}/og/app/${QUIZ_APP_ID}.png?v=${manifest.apps[QUIZ_APP_ID]}`);
  const speed = ogMeta({ url: `${O}/p/tpl-${SPEED_QUIZ_ID}`, catalog, manifest });
  assert.equal(speed.title, '스피드 퀴즈 — 한 판 붙어 볼래?');
  assert.equal(speed.app, SPEED_QUIZ_ID);
  assert.equal(speed.image, `${O}/og/app/${SPEED_QUIZ_ID}.png?v=${manifest.apps[SPEED_QUIZ_ID]}`);
  assert.notEqual(manifest.apps[SPEED_QUIZ_ID], manifest.apps[QUIZ_APP_ID], 'the two cards share a picture');
  // A bare quiz link (old "스피드 퀴즈로 같이 하기") opens 스피드 퀴즈 — and says so.
  const bare = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}`, catalog, manifest });
  assert.equal(bare.title, speed.title);
  assert.equal(bare.url, `${O}/p/tpl-${QUIZ_APP_ID}`);
  // The merged trivia race now lives in 스피드 퀴즈, not in 나 맞히기.
  assert.equal(entryFor('tpl-race-trivia', catalog).id, SPEED_QUIZ_ID);
});

test('a merged app shows the app it now lives in', () => {
  assert.equal(entryFor('tpl-race-tap', catalog).id, 'tap-battle');
  assert.match(ogMeta({ url: `${O}/p/tpl-race-tap`, catalog, manifest }).title, /^탭 배틀 — /);
});

test('unknown slugs, made apps and the home page → the site defaults', () => {
  for (const u of [`${O}/p/tpl-nope`, `${O}/p/app-abc123`, `${O}/p/%E0%A4`, `${O}/`, `${O}/p/TPL-WORLDCUP-FOOD`]) {
    const m = ogMeta({ url: u, catalog, manifest });
    assert.equal(m.title, DEFAULT_TITLE, u);
    assert.equal(m.description, DEFAULT_DESCRIPTION, u);
    assert.equal(m.image, `${O}/og/default.png?v=${manifest.default}`, u);
    assert.equal(m.square, `${O}/og/square.png?v=${manifest.square}`, u);
    assert.equal(m.app, null);
  }
});

test('the origin comes from the request (preview deployments link to themselves)', () => {
  const m = ogMeta({ url: 'https://test.playsnack.pages.dev/p/tpl-quiz-ox', catalog, manifest });
  assert.ok(m.image.startsWith('https://test.playsnack.pages.dev/og/app/quiz-ox.png'));
  assert.equal(m.url, 'https://test.playsnack.pages.dev/p/tpl-quiz-ox');
});

test('a friends room: invite description, og:url keeps the code; legacy ?room= values do not', () => {
  const m = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${CODE}&x=1`, catalog, manifest });
  assert.match(m.description, /친구가 방에 초대했어요/);
  assert.equal(m.url, `${O}/p/tpl-tap-battle?room=${CODE}`);
  const legacy = ogMeta({ url: `${O}/p/tpl-tap-battle?room=1`, catalog, manifest });
  assert.equal(legacy.url, `${O}/p/tpl-tap-battle`);
  assert.doesNotMatch(legacy.description, /초대/);
});

test('quiz room with a known subject → "<name> 맞히기 · 나를 얼마나 알까?"; other apps ignore `about`', () => {
  const q = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}?room=${CODE}`, catalog, manifest, about: '민수' });
  assert.equal(q.title, '민수 맞히기 · 나를 얼마나 알까?');
  assert.match(q.description, /민수님/);
  const other = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${CODE}`, catalog, manifest, about: '민수' });
  assert.doesNotMatch(other.title, /민수/);
  const noRoom = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}`, catalog, manifest, about: '민수' });
  assert.doesNotMatch(noRoom.title, /민수/);
});

test('names are one clean line, capped; markup stays text (escaped by the rewriter)', () => {
  assert.equal(cleanName('  민\u0000수\n‮씨  '), '민수 씨');
  assert.equal([...cleanName('가'.repeat(50))].length, 20);
  assert.equal(cleanName(42), '');
  const m = ogMeta({ url: `${O}/p/tpl-${QUIZ_APP_ID}?room=${CODE}`, catalog, manifest, about: '<b>"민수"&</b>' });
  const out = applyFake(indexHtml, metaHandlers(m));
  assert.ok(out.includes('<title>&lt;b&gt;"민수"&amp;&lt;/b&gt; 맞히기 · 나를 얼마나 알까?</title>'), 'title text escaped');
  assert.ok(out.includes('property="og:title" content="&lt;b&gt;&quot;민수&quot;&amp;&lt;/b&gt; 맞히기'), 'attribute escaped');
  assert.ok(!out.includes('<b>"민수"'));
});

// ── room lookup ──

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('lookupAbout reads only `about` and caches it (hits and misses)', async () => {
  let calls = 0;
  let asked = '';
  const fetchImpl = async (u) => {
    calls += 1;
    asked = u;
    return json(200, { ok: true, result: { about: ' 민수 ', title: 't', quizRecap: { rounds: [{ q: 'Q', options: ['A'], answer: 0 }] } } });
  };
  const a = await lookupAbout({ roomBase: 'https://room.example/', code: CODE, fetchImpl, now: 1000 });
  assert.equal(a, '민수');
  assert.equal(asked, `https://room.example/room/tpl-${QUIZ_APP_ID}~${CODE}/result`);
  await lookupAbout({ roomBase: 'https://room.example', code: CODE, fetchImpl, now: 2000 });
  assert.equal(calls, 1, 'cached');
  await lookupAbout({ roomBase: 'https://room.example', code: CODE, fetchImpl, now: 1000 + 61_000 });
  assert.equal(calls, 2, 'cache expires');
  const miss = async () => json(404, { ok: false });
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: 'ABCDEFGH23', fetchImpl: miss }), null);
});

test('lookupAbout: timeout, network error, odd bodies and bad codes → null, never throws', async () => {
  const slow = (u, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(json(200, { result: { about: '늦음' } })), 2000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: CODE, fetchImpl: slow }), null);
  assert.ok(Date.now() - t0 < ROOM_LOOKUP_MS + 150, `gave up after ${Date.now() - t0} ms`);
  assert.equal(_roomCache.size, 0, 'a timeout is not cached');
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: 'BBBBBBBB22', fetchImpl: async () => { throw new Error('net'); } }), null);
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: 'CCCCCCCC22', fetchImpl: async () => json(200, 'nope') }), null);
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: 'DDDDDDDD22', fetchImpl: async () => json(200, { result: { about: 7 } }) }), null);
  let called = false;
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: 'bad', fetchImpl: async () => { called = true; } }), null);
  assert.equal(called, false);
});

// #157: signed room codes — 15 symbols (no PIN), 20 (a PIN room); old 10-symbol codes still read.
const OPEN15 = 'K7MNP2QRS4ABCDE';
const PIN20 = 'K7MNP2QRS4ABCDEFGH23';
test('CODE_RE: 15- and 20-symbol codes are room codes (and the old 10); others are not', () => {
  for (const c of [OPEN15, PIN20, CODE]) assert.equal(roomCode(`${O}/p/tpl-tap-battle?room=${c}`), c, c);
  for (const c of ['K7MNP2QRS4ABCD0', 'K7MNP2QRS4ABCDEFGH2I', 'SHORT', 'A'.repeat(33)]) assert.equal(roomCode(`${O}/p/tpl-tap-battle?room=${c}`), null, c);
  assert.equal(isPinCode(PIN20), true);
  assert.equal(isPinCode(OPEN15), false);
  assert.equal(isPinCode(CODE), false);
  const m = ogMeta({ url: `${O}/p/tpl-tap-battle?room=${PIN20}`, catalog, manifest });
  assert.equal(m.url, `${O}/p/tpl-tap-battle?room=${PIN20}`, 'a PIN room link previews like any friends link');
});
test('lookupAbout: a 15-symbol code is looked up; a PIN room (20) never is (its result needs a pass)', async () => {
  let asked = null;
  const fetchImpl = async (u) => ((asked = u), new Response(JSON.stringify({ ok: true, result: { about: '민수' } }), { status: 200 }));
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: OPEN15, fetchImpl }), '민수');
  assert.equal(asked, `https://r/room/tpl-${QUIZ_APP_ID}~${OPEN15}/result`);
  asked = null;
  assert.equal(await lookupAbout({ roomBase: 'https://r', code: PIN20, fetchImpl }), null);
  assert.equal(asked, null, 'no request for a PIN room');
});

test('preview crawlers are told apart from browsers', () => {
  for (const ua of ['facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'TelegramBot (like TwitterBot)', 'WhatsApp/2.23'])
    assert.ok(isPreviewBot(ua), ua);
  for (const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 KAKAOTALK 10.4.5', '', undefined])
    assert.ok(!isPreviewBot(ua), String(ua));
});

// ── the handlers against index.html ──

test('index.html carries every tag the handlers set; app links drop the square card', () => {
  const m = ogMeta({ url: `${O}/p/tpl-quiz-ox`, catalog, manifest });
  const out = applyFake(indexHtml, metaHandlers(m));
  for (const [prop, v] of [['og:title', m.title], ['og:description', m.description], ['og:url', m.url], ['og:image', m.image]])
    assert.ok(out.includes(`property="${prop}" content="${esc(v)}"`), prop);
  assert.ok(out.includes(`name="twitter:image" content="${esc(m.image)}"`));
  assert.ok(out.includes(`<title>${m.title}</title>`));
  assert.ok(!out.includes('data-og="square"'), 'square tags removed');
  const home = applyFake(indexHtml, metaHandlers(ogMeta({ url: `${O}/p/x`, catalog, manifest })));
  assert.equal((home.match(/data-og="square"/g) ?? []).length, 5);
  assert.ok(home.includes('name="twitter:card" content="summary_large_image"'));
});

// A tiny stand-in for HTMLRewriter over index.html's head: selectors of the forms the handlers use
// (`title`, `tag[a="v"]`, `…:not([a])`), setAttribute / setInnerContent with HTMLRewriter's escaping
// as observed in workerd (wrangler pages dev): setAttribute escapes only `"`; setInnerContent
// (text) escapes `&`, `<`, `>`.
function esc(s, attr = true) {
  const r = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attr ? r.replace(/"/g, '&quot;') : r;
}
function applyFake(html, pairs) {
  const parse = (sel) => {
    const tag = /^[a-z]+/.exec(sel)[0];
    const has = [...sel.matchAll(/(?<!:not\()\[([a-z-]+)(?:="([^"]*)")?\]/g)].map((m) => [m[1], m[2]]);
    const not = [...sel.matchAll(/:not\(\[([a-z-]+)\]\)/g)].map((m) => m[1]);
    return { tag, has, not };
  };
  let out = html;
  for (const [sel, h] of pairs) {
    const s = parse(sel);
    if (s.tag === 'title') {
      out = out.replace(/<title>[\s\S]*?<\/title>/, () => {
        let text = null;
        h.element({ setInnerContent: (t) => (text = esc(t, false)) });
        return `<title>${text}</title>`;
      });
      continue;
    }
    out = out.replace(new RegExp(`<${s.tag}\\b[^>]*>`, 'g'), (el) => {
      const attrs = Object.fromEntries([...el.matchAll(/([a-z:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      if (!s.has.every(([a, v]) => (v === undefined ? a in attrs : attrs[a] === v))) return el;
      if (s.not.some((a) => a in attrs)) return el;
      let res = el;
      h.element({
        setAttribute: (a, v) => (res = res.replace(new RegExp(`${a}="[^"]*"`), () => `${a}="${String(v).replace(/"/g, '&quot;')}"`)),
        remove: () => (res = ''),
      });
      return res;
    });
  }
  return out;
}
