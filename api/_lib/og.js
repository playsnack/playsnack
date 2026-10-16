// Link previews (#106): the Open Graph / Twitter meta a crawler (KakaoTalk, iMessage, Slack, …)
// reads from a play link. Pure — no platform APIs — so Node tests it (api/_test/og.test.js); the
// Pages Function functions/p/[[path]].js feeds it the request and applies the result to the
// static index.html with HTMLRewriter (docs/link-previews.md).
//
//   /p/tpl-<id>                    → the catalog entry: "<title> — <tagline>", its own image
//   /p/tpl-<id>?room=<code>        → same, "친구가 방에 초대했어요" description
//   /p/tpl-speed-trivia-score?room=<code>, crawler only → "<about> 맞히기 · 나를 얼마나 알까?"
//                                    when the room server already has that room's last result
//                                    (only `about` is read — never questions, answers or picks);
//                                    never for a PIN room (20-symbol code): its name stays private
//   anything else (made apps, unknown slugs) → the site defaults (index.html's own tags)

export const SITE_NAME = 'PlaySnack';
export const DEFAULT_TITLE = 'PlaySnack · 친구랑 바로 한 판';
export const DEFAULT_DESCRIPTION = '설치·가입 없이 링크만 열면 바로 시작하는 월드컵·퀴즈·게임. 친구한테 링크 하나 보내고 같이 한 판!';
export const QUIZ_APP_ID = 'speed-trivia-score'; // = snack-player/src/quiz.ts QUIZ_APP_ID
export const ROOM_LOOKUP_MS = 300;
const ROOM_CACHE_MS = 60_000;
const ROOM_CACHE_MAX = 200;
const NAME_MAX = 20;

// The friends-room code (snack-player/src/links.ts; edge/room/src/results.js CODE): signed codes
// are 15 symbols (no PIN) or 20 (a PIN room, docs/room-admission.md); 8–32 keeps the device-made
// 10-symbol codes from before signing working while the room server still takes them.
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,32}$/;
/** A PIN room's code: its result is readable only with a pass, so a preview never looks it up. */
export const PIN_CODE_LENGTH = 20;
export const isPinCode = (code) => typeof code === 'string' && code.length === PIN_CODE_LENGTH;
const SLUG_RE = /^tpl-([a-z0-9][a-z0-9-]{0,63})$/;

// One line per category (Discover.tsx CAT), said the way a friend would.
const TAGLINE = {
  worldcup: '친구랑 같이 골라 봐요',
  quiz: '몇 개나 맞힐 수 있을까?',
  psych: '나는 어떤 타입일까?',
  game: '한 판 붙어 볼래?',
  random: '운에 맡겨 봐요',
  counter: '다 같이 눌러 봐요',
  social: '우리끼리 한 판',
  vote: '친구랑 같이 골라 봐요',
  reaction: '한 판 붙어 볼래?',
};
export const CATEGORY_LABEL = {
  worldcup: '월드컵', vote: '투표', quiz: '퀴즈', psych: '테스트', game: '게임',
  random: '랜덤', reaction: '반응', counter: '카운터', social: '파티',
};

/** A crawler that renders link previews (not a person's browser). Only these trigger the room lookup. */
export const PREVIEW_BOT_RE =
  /facebookexternalhit|facebookcatalog|kakaotalk-scrap|kakaostory|Slackbot|Slack-ImgProxy|Twitterbot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|Applebot|Pinterest|Embedly|SkypeUriPreview|redditbot|Mastodon|Line\/|naver|Yeti|Daum|Googlebot|bingbot|vkShare|Iframely/i;
export const isPreviewBot = (ua) => PREVIEW_BOT_RE.test(String(ua ?? ''));

/** A display name from someone else's input: one line, no control/bidi characters, capped. */
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  const one = s.replace(/[\t\n\r\f\v]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return [...one].slice(0, NAME_MAX).join('').trim();
}

/** The friends-room code of a URL, or null (legacy non-code `?room=` values only force a room). */
export function roomCode(url) {
  const c = new URL(url).searchParams.get('room');
  return c && CODE_RE.test(c) ? c : null;
}

/** The catalog entry a slug shows (a merged app shows the app it now lives in), or null. */
export function entryFor(slug, catalog) {
  const m = SLUG_RE.exec(String(slug ?? ''));
  if (!m || !Array.isArray(catalog)) return null;
  const e = catalog.find((t) => t && t.id === m[1]);
  if (!e) return null;
  return (e.mergedInto && catalog.find((t) => t && t.id === e.mergedInto)) || e;
}

/** The slug of a /p/ path ("/p/tpl-x" → "tpl-x"), or null. */
export function slugOf(pathname) {
  const m = /^\/p\/([^/?#]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

const imageUrl = (origin, path, v) => `${origin}${path}${v ? `?v=${v}` : ''}`;

/**
 * The meta for one request.
 * @param {{url: string, catalog: object[], manifest: {default?: string, square?: string, apps?: Record<string,string>}, about?: string|null}} o
 *   about = the quiz subject's name from the room's saved result (already looked up), if any.
 * @returns {{title: string, description: string, image: string, imageAlt: string, imageWidth: number, imageHeight: number,
 *   square: string|null, url: string, app: string|null}}
 */
export function ogMeta({ url, catalog, manifest = {}, about = null }) {
  const u = new URL(url);
  const origin = u.origin;
  const slug = slugOf(u.pathname);
  const code = slug ? roomCode(url) : null;
  const canonical = `${origin}${slug ? `/p/${encodeURIComponent(slug)}` : '/'}${code ? `?room=${code}` : ''}`;
  const base = {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    image: imageUrl(origin, '/og/default.png', manifest.default),
    imageAlt: 'PlaySnack — 친구랑 바로 한 판',
    imageWidth: 1200,
    imageHeight: 630,
    square: imageUrl(origin, '/og/square.png', manifest.square),
    url: canonical,
    app: null,
  };
  const e = slug ? entryFor(slug, catalog) : null;
  if (!e) return base;
  const name = cleanName(e.title) || SITE_NAME;
  const multi = e.mode === 'multi';
  const tagline = TAGLINE[e.category] ?? '친구랑 바로 한 판';
  const v = manifest.apps?.[e.id];
  const meta = {
    ...base,
    title: `${name} — ${tagline}`,
    description: multi
      ? `링크를 받은 친구들과 같은 방에서 바로 시작해요. 설치·가입 없이 PlaySnack에서.`
      : `설치·가입 없이 링크만 열면 바로 시작해요. 결과는 친구랑 나눠 봐요. PlaySnack`,
    image: v ? imageUrl(origin, `/og/app/${e.id}.png`, v) : base.image,
    imageAlt: `${name} — PlaySnack`,
    square: v ? null : base.square,
    app: e.id,
  };
  if (code) {
    meta.description = '친구가 방에 초대했어요. 링크를 열면 같은 방으로 바로 들어가요.';
    const who = e.id === QUIZ_APP_ID ? cleanName(about) : '';
    if (who) {
      meta.title = `${who} 맞히기 · 나를 얼마나 알까?`;
      meta.description = `${who}님에 대한 퀴즈예요. 링크를 열면 같은 방으로 들어가요.`;
    }
  }
  return meta;
}

// ── the quiz room's subject, from the room server (crawlers only, never blocking) ──

const roomCache = new Map(); // roomId → {at, about}

/** Test hook. */
export const _roomCache = roomCache;

/**
 * The `about` (quiz subject's name) of a friends quiz room's last saved result, or null.
 * GET <roomBase>/room/tpl-speed-trivia-score~<CODE>/result, at most `timeoutMs`; any error,
 * 404, timeout or odd body → null. Answers (quizRecap) are never read out of the body.
 * Results (also misses) are kept `ROOM_CACHE_MS` in the isolate.
 */
export async function lookupAbout({ roomBase, code, fetchImpl = fetch, timeoutMs = ROOM_LOOKUP_MS, now = Date.now() }) {
  if (!roomBase || !code || !CODE_RE.test(code) || isPinCode(code)) return null;
  const roomId = `tpl-${QUIZ_APP_ID}~${code}`;
  const hit = roomCache.get(roomId);
  if (hit && now - hit.at < ROOM_CACHE_MS) return hit.about;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const get = (async () => {
    const res = await fetchImpl(`${roomBase.replace(/\/+$/, '')}/room/${roomId}/result`, { signal: ctl?.signal, headers: { accept: 'application/json' } });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const r = body && body.result;
    return cleanName(r && typeof r.about === 'string' ? r.about : '') || null;
  })().catch(() => null);
  const about = await Promise.race([get, timeout]);
  clearTimeout(timer);
  if (about === undefined) return null; // timed out: not cached, the next crawler may get it
  if (roomCache.size >= ROOM_CACHE_MAX) roomCache.delete(roomCache.keys().next().value);
  roomCache.set(roomId, { at: now, about });
  return about;
}

// ── applying the meta to index.html (HTMLRewriter element handlers) ──

/**
 * An attribute value for HTMLRewriter's setAttribute, which escapes only `"` (checked in workerd:
 * `<b>"x"&` came out as `<b>&quot;x&quot;&`) — so `&`, `<`, `>` are escaped here, `"` is left to it.
 */
export const attrValue = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * [selector, handler] pairs for HTMLRewriter.on(). Attribute values go through attrValue();
 * setInnerContent (text mode) escapes `&`, `<`, `>` itself.
 */
export function metaHandlers(m) {
  const set = (v) => ({ element: (el) => el.setAttribute('content', attrValue(v)) });
  const pairs = [
    ['title', { element: (el) => el.setInnerContent(m.title) }],
    ['meta[name="description"]', set(m.description)],
    ['meta[property="og:title"]', set(m.title)],
    ['meta[property="og:description"]', set(m.description)],
    ['meta[property="og:url"]', set(m.url)],
    ['meta[property="og:image"]:not([data-og])', set(m.image)],
    ['meta[property="og:image:secure_url"]:not([data-og])', set(m.image)],
    ['meta[property="og:image:alt"]', set(m.imageAlt)],
    ['meta[name="twitter:title"]', set(m.title)],
    ['meta[name="twitter:description"]', set(m.description)],
    ['meta[name="twitter:image"]', set(m.image)],
    ['meta[name="twitter:image:alt"]', set(m.imageAlt)],
    ['link[rel="canonical"]', { element: (el) => el.setAttribute('href', attrValue(m.url)) }],
  ];
  // The square fallback (data-og="square") only goes with the site image.
  if (!m.square) pairs.push(['meta[data-og="square"]', { element: (el) => el.remove() }]);
  else {
    pairs.push(['meta[property="og:image"][data-og="square"]', set(m.square)]);
    pairs.push(['meta[property="og:image:secure_url"][data-og="square"]', set(m.square)]);
  }
  return pairs;
}
