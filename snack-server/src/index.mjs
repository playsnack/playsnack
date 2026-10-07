// snack-server (alpha) — single-origin Express + WebSocket realtime room.
// Flow (the moat): client Bite `emit` ("vote") -> WS action -> server
// aggregates authoritatively (one vote per anonId, re-vote allowed) ->
// broadcasts setVar{votesByOption} to the room -> every client's runtime
// re-renders the live %. In-memory for the alpha; SQLite persistence is next.
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildApp } from "./builder.mjs";
import { listTemplates, getTemplateDoc, rateTemplate, markUsed, allTemplateDocs, templateMeta } from "./templates.mjs";
import { getContent } from "./content.mjs";
import { validate as validateBite } from "@snack/bite";
import { createRoom, cleanNick } from "@snack/room";
import { attachRelay } from "./relay.mjs";

// Each starter template is also a canonical LIVE shared room at /p/tpl-<id> —
// so the dashboard's "지금 N명 / leaderboard / votes" are real & shared. (Defined
// after `apps`/`entryFromDoc` below.)
const TPL_PREFIX = "tpl-";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOT = resolve(__dirname, "../..");

// App registry. slug -> { doc, defaults } (Bite documents). User
// apps (POST /api/apps) persist to data/apps/<slug>.json (survives restart;
// votes themselves stay in-memory for the alpha — PLAN accepts vote loss).
const DATA = resolve(__dirname, "../data/apps"); // snack-server/data/apps
mkdirSync(DATA, { recursive: true });

const entryFromDoc = (doc) => ({ doc, defaults: doc?.vars?.votesByOption ?? {} });

const apps = {};
for (const f of readdirSync(DATA).filter((f) => f.endsWith(".json"))) {
  try {
    const saved = JSON.parse(readFileSync(resolve(DATA, f), "utf8"));
    if (saved?.doc?.bite) apps[f.replace(/\.json$/, "")] = entryFromDoc(saved.doc);
  } catch { /* skip corrupt */ }
}
// Register every starter template as a canonical live room (slug = tpl-<id>).
for (const { id, doc } of allTemplateDocs()) apps[`${TPL_PREFIX}${id}`] = entryFromDoc(doc);

const newSlug = () => Math.random().toString(36).slice(2, 8);

// Builder cost guard: bounds OpenAI spend when the server is exposed (tunnel).
// Each /api/builder/chat call = one gpt-5.5 build. Caps per-IP and globally per
// hour so a leaked public URL can't drain the key. Override via env.
const envNum = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) ? n : d; };
const BUILD_PER_IP_HR = envNum("BUILD_PER_IP_HR", 8);
const BUILD_GLOBAL_HR = envNum("BUILD_GLOBAL_HR", 40);
const buildHits = { global: [], byIp: new Map() };
const clientIp = (req) => (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) || req.socket.remoteAddress || "?";
function builderAllowed(req) {
  const now = Date.now(), HR = 3600_000, ip = clientIp(req);
  buildHits.global = buildHits.global.filter((t) => now - t < HR);
  const ipArr = (buildHits.byIp.get(ip) || []).filter((t) => now - t < HR);
  if (buildHits.global.length >= BUILD_GLOBAL_HR) return { ok: false, scope: "global" };
  if (ipArr.length >= BUILD_PER_IP_HR) return { ok: false, scope: "ip" };
  buildHits.global.push(now); ipArr.push(now); buildHits.byIp.set(ip, ipArr);
  return { ok: true };
}

// Rooms. slug -> { voters:Map<anonId,option>, sockets:Set<ws> }. Votes persist
// to data/votes/<slug>.json so a shared poll survives a server restart (alpha:
// JSON files; SQLite is the documented production upgrade).
const VOTES = resolve(__dirname, "../data/votes");
mkdirSync(VOTES, { recursive: true });
const loadVoters = (slug) => {
  try { return new Map(Object.entries(JSON.parse(readFileSync(resolve(VOTES, `${slug}.json`), "utf8")))); }
  catch { return new Map(); }
};
// Per-player selfie (set at the nickname onboarding step). Stored by anonId on
// disk; photo apps (얼굴 지목판 등) use rosterPhotos[i] aligned with roster[i].
const PHOTOS = resolve(__dirname, "../data/photos");
mkdirSync(PHOTOS, { recursive: true });
const photoPath = (id) => resolve(PHOTOS, String(id).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) + ".jpg");
const hasPhoto = (id) => { try { return existsSync(photoPath(id)); } catch { return false; } };
const saveVoters = (slug, voters) => {
  try { writeFileSync(resolve(VOTES, `${slug}.json`), JSON.stringify(Object.fromEntries(voters))); }
  catch { /* best-effort */ }
};
// ── Live rooms: one @snack/room engine per slug (roster, tallies, game session).
// The server only wires it up — persistence, content, photos, points, transport.
const rooms = new Map(); // slug → { engine, sockets: Map<peerId, ws> }
let peerSeq = 0;
const room = (slug) => {
  let entry = rooms.get(slug);
  if (entry) return entry;
  const sockets = new Map();
  const voters = loadVoters(slug);
  const engine = createRoom({
    defaults: () => apps[slug]?.defaults ?? {},
    voters,
    onVotersChanged: () => saveVoters(slug, voters),
    getPack: (game, opts) => dynamicPack(game, opts),
    photoUrl: (id) => (hasPhoto(id) ? `/api/photo/${id}` : ""),
    onPoints: (anonId, nick, pts) => bumpUser(anonId, nick, pts),
    onActivity: (kind, label) => logActivity(slug, kind, label),
    broadcast: (t, d) => { for (const ws of sockets.values()) send(ws, t, d); },
    send: (peerId, t, d) => { const ws = sockets.get(peerId); if (ws) send(ws, t, d); },
  });
  entry = { engine, sockets };
  rooms.set(slug, entry);
  return entry;
};
// Cold-load view of a room nobody is in yet (no engine created).
const coldShared = (slug) => {
  const votesByOption = { ...(apps[slug]?.defaults ?? {}) };
  for (const opt of loadVoters(slug).values()) votesByOption[opt] = (votesByOption[opt] ?? 0) + 1;
  return { votesByOption, coopTotal: 0, leaderboard: [] };
};

// Round-based games (vote/quiz/bracket) draw synced content from server packs in
// data/multi-content/<game>.json. The server is the single source of truth so every
// client sees the SAME question/matchup in a round. Packs cached after first read.
const MULTI_CONTENT = resolve(__dirname, "../data/multi-content");
const packCache = new Map();
const loadPack = (game) => {
  if (!game) return null;
  if (packCache.has(game)) return packCache.get(game);
  let arr = null;
  try { arr = JSON.parse(readFileSync(resolve(MULTI_CONTENT, `${game}.json`), "utf8")); } catch { arr = null; }
  packCache.set(game, Array.isArray(arr) ? arr : null);
  return packCache.get(game);
};

// "Thaw" a multiplayer pack: pull FRESH content from the LLM (getContent) each
// session instead of the frozen static JSON. Maps game → content kind, extracts
// the array each session mode expects, and falls back to the static pack on any
// error / no key ("되는 척" 없이 항상 콘텐츠). Content is confirmed ONCE per session
// here and broadcast to all clients, so multiplayer sync is preserved.
const GAME_CONTENT = {
  balance:       { kind: "balance",    pick: (j) => j.dilemmas },
  majority:      { kind: "majority",   pick: (j) => j.splits },
  "most-likely": { kind: "mostlikely", pick: (j) => j.prompts },
  trivia:        { kind: "quiz", theme: "K-컬처/신조어", pick: (j) =>
    (j.questions || []).filter((x) => Array.isArray(x.choices) && x.choices.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4)
      .map((x) => ({ q: x.q, options: x.choices, answer: x.answer })) },
  worldcup:      { kind: "worldcup", theme: "야식", pick: (j) =>
    (j.current || []).map((x) => ({ name: x.name, emoji: x.emoji || "🍽️" })) },
};
const dynamicPack = async (game, opts = {}) => {
  const m = GAME_CONTENT[game];
  if (!m) return loadPack(game); // reaction/nunchi/unmapped → static (or null), no LLM
  try {
    const j = await getContent(m.kind, opts.theme || m.theme || "");
    if (j && !j.error) {
      const arr = m.pick(j);
      if (Array.isArray(arr) && arr.length >= 2) return arr;
    }
  } catch { /* fall through to static */ }
  return loadPack(game);
};
// ── Global USER leaderboard (cross-room, by nickname). Each browser is one
// player (anonId); they earn "snack points" from real activity: +1 per play
// (score/vote/tally), +2 bonus for a new room-best (a record). Persisted to
// data/users.json so the ranking survives restarts. Real data only — no seeds.
const USERS_FILE = resolve(__dirname, "../data/users.json");
const userStore = new Map(); // anonId -> { nick, points, plays, updated }
try {
  for (const [id, u] of Object.entries(JSON.parse(readFileSync(USERS_FILE, "utf8")))) userStore.set(id, u);
} catch { /* first run */ }
let usersDirty = false;
const saveUsers = () => { if (!usersDirty) return; usersDirty = false;
  try { writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(userStore))); } catch { /* best-effort */ }
};
setInterval(saveUsers, 4000).unref?.();
const bumpUser = (anonId, nick, pts) => {
  if (!anonId) return;
  const u = userStore.get(anonId) || { nick: "", points: 0, plays: 0, updated: 0 };
  const nn = cleanNick(nick);
  if (nn) u.nick = nn;
  if (pts > 0) { u.points += pts; u.plays += 1; }
  u.updated = Date.now();
  userStore.set(anonId, u);
  usersDirty = true;
};
// Top-N users with a real nickname, ranked by points (ties: more plays).
const leaderboard = (n = 10) =>
  [...userStore.values()]
    .filter((u) => u.nick)
    .sort((a, b) => b.points - a.points || b.plays - a.plays)
    .slice(0, n)
    .map((u, i) => ({ rank: i + 1, nick: u.nick, points: u.points, plays: u.plays }));

// ── Live platform pulse (ephemeral now-ness for the dashboard) ──
const ACTIVITY = [];          // recent events ring buffer {slug, kind, label, t}
const ACTIVITY_CAP = 60;
const TREND_WINDOW = 15 * 60 * 1000; // 15 min recency window for trending
function logActivity(slug, kind, label) {
  ACTIVITY.push({ slug, kind, label, t: Date.now() });
  if (ACTIVITY.length > ACTIVITY_CAP) ACTIVITY.shift();
}
const globalOnline = () => {
  let n = 0;
  for (const r of rooms.values()) n += r.engine.size;
  for (const r of relay.rooms.values()) n += r.peers.size;
  return n;
};
const playingIn = (slug) => (rooms.get(slug)?.engine.size ?? 0) + relay.size(slug);
const recentActivityCount = (slug, now) => ACTIVITY.reduce((n, a) => n + (a.slug === slug && now - a.t < TREND_WINDOW ? 1 : 0), 0);

const app = express();
app.use(express.json({ limit: "1mb" })); // room for a downscaled selfie data-URL
app.use((req, res, next) => { // dev CORS (player dev-server is a different origin)
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204); // preflight (POST + JSON)
  next();
});

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", rooms: rooms.size, apps: Object.keys(apps) }));

// Keyless keyword-photo proxy. Same-origin so Pixi/WebGL textures load without
// CORS taint and it works through the tunnel. A deterministic lock per keyword
// → every client sees the SAME photo (stable across reloads/voters).
const imgCache = new Map(); // key -> {buf, type}
// Retry fetch with a fresh timeout per attempt. Transient upstream throttles
// (Wikipedia/Wikimedia 429/5xx during a worldcup's rapid image burst) were
// causing strict-mode requests to fail with no retry → gray placeholder boxes.
async function fetchR(url, { headers, timeoutMs = 7000 } = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return r;
      last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 300 * (i + 1))); // backoff
  }
  throw last || new Error("fetch failed");
}
// Unsplash (keyed): uses the ACCESS KEY as `Client-ID` (Secret Key is only for
// OAuth, not needed). Resolves a keyword to a relevant, high-quality photo URL.
async function unsplashUrl(q, w, h) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return null;
  const orient = h > w * 1.2 ? "portrait" : w > h * 1.2 ? "landscape" : "squarish";
  try {
    const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=1&orientation=${orient}`,
      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const u = (await r.json())?.results?.[0]?.urls;
    return u ? `${u.raw}&w=${w}&h=${h}&fit=crop` : null; // raw + sizing params
  } catch { return null; }
}
// Wikipedia (keyless): the MOST relevant source for NAMED entities (foods,
// people, places, characters) — stock search (Unsplash/Pexels) badly mismatches
// niche terms (e.g. "tteokbokki" → unrelated photo). Uses the REST page summary
// thumbnail; only returns when the query resolves to a real article.
async function wikipediaUrl(q) {
  const UA = { "User-Agent": "snackapp/0.1 (alpha)" };
  // Use the NATIVE thumbnail size wikimedia returns. Forcing /640px- 400s when the
  // source image is narrower than 640 (e.g. idol portraits) → we'd lose the photo.
  const fix = (u) => (typeof u === "string" ? u.replace(/^\/\//, "https://") : null);
  const summaryThumb = async (lang, title) => {
    try {
      const r = await fetchR(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: UA });
      const j = await r.json();
      return j.thumbnail?.source ? fix(j.thumbnail.source) : null;
    } catch { return null; }
  };
  // Language order by q's SCRIPT: an English title ("Jun Ji-hyun", "Yoo Jae-suk")
  // targets the en article — whose infobox is a clean name-portrait — so try en
  // FIRST. Korean q (fresh idols "태연", foods "떡볶이") → ko first (they often have
  // a ko article but an empty/404 en one). Wrong order was the bug: an English
  // name resolved via ko SEARCH → a drama still / group photo / movie poster
  // (talent 유재석→걸그룹, 강호동→"브로커" 포스터, 전지현→드라마 스틸).
  const hasCJK = /[가-힣぀-ヿ一-鿿㐀-䶿]/.test(q);
  const langs = hasCJK ? ["ko", "en"] : ["en", "ko"];
  // EXACT-title summaries first, BOTH langs — highest precision (the article whose
  // title IS the name). Only if no exact hit do we fall to search (lower precision,
  // where mismatches creep in). ("Jokbal"/"Tteokbokki" resolve here directly.)
  for (const lang of langs) { const exact = await summaryThumb(lang, q); if (exact) return exact; }
  // SEARCH → best-matching article → its summary thumbnail. Makes fuzzy q resolve:
  // "Jang Wonyoung IVE" → "Jang Won-young", "Karina aespa" → "Karina (singer)" —
  // instead of falling through to a mismatched stock photo (the "고양이 사진" bug).
  for (const lang of langs) {
    try {
      // Scan the top few (not just #1) for the first with a usable photo — #1
      // sometimes lacks a thumbnail while #2/#3 (the real article) has one.
      const s = await fetchR(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=5`, { headers: UA });
      const pages = (await s.json())?.pages || [];
      for (const p of pages) {
        const viaTitle = await summaryThumb(lang, p.key || p.title);
        if (viaTitle) return viaTitle;
        if (p.thumbnail?.url) return fix(p.thumbnail.url); // small but valid, last resort
      }
    } catch { /* try next lang */ }
  }
  return null;
}
// Person-disambiguation convention: a candidate q of the form "이름|가수" means
// "this is a person — resolve their photo". We try the disambiguated title FIRST
// ("이름 (가수)", which pins the right person when names collide) then the bare
// name ("이름", whose article often holds the photo when the (가수) title 404s).
// Plain q (no "|") resolves as-is, so foods/anime are unaffected.
const wikiVariants = (q) => {
  const i = q.indexOf("|");
  if (i < 0) return [q];
  const base = q.slice(0, i), hint = q.slice(i + 1);
  return [`${base} (${hint})`, base];
};
const resolveStrictWiki = async (q) => {
  for (const v of wikiVariants(q)) { const u = await wikipediaUrl(v); if (u) return u; }
  return null;
};
// Pexels (keyed): relevant, high-quality. Resolves a keyword to a real photo URL.
async function pexelsUrl(q, w, h) {
  const key = process.env.PEXELS_API_KEY || process.env.PEXELS;
  if (!key) return null;
  const orient = h > w * 1.2 ? "portrait" : w > h * 1.2 ? "landscape" : "square";
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=1&orientation=${orient}`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const ph = (await r.json())?.photos?.[0];
    return ph?.src?.large || ph?.src?.medium || ph?.src?.original || null;
  } catch { return null; }
}
app.get("/api/img", async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 60) || "abstract";
  const w = Math.min(1200, Math.max(40, Number(req.query.w) || 600));
  const h = Math.min(1200, Math.max(40, Number(req.query.h) || 600));
  // STRICT: named entities (idol/actor/food worldcups) must show the RIGHT
  // image or NOTHING — never a loremflickr random photo (the cause of "name
  // says 카리나 but the face is someone else"). On no exact resolution → 404,
  // and the client shows a name placeholder instead of a wrong picture.
  const strict = req.query.strict === "1" || req.query.strict === "true";
  let lock = 0; for (const c of q) lock = (lock * 31 + c.charCodeAt(0)) % 100000; // stable seed
  const key = `${strict ? "s|" : ""}${q}|${w}x${h}`;
  if (imgCache.has(key)) { const c = imgCache.get(key); res.setHeader("Content-Type", c.type); res.setHeader("Cache-Control", "public, max-age=86400"); return res.end(c.buf); }
  // loremflickr wants comma-separated tags (a literal space → 403).
  const tag = q.split(/\s+/).filter(Boolean).map(encodeURIComponent).join(",");
  const sources = [];
  // STRICT (named people, e.g. idols): Wikipedia ONLY — never stock/random, which
  // would show the WRONG face. NON-strict (generic things like foods): Wikipedia →
  // keyword stock → loremflickr keyword, so when one source fails we fall back to
  // ANOTHER RELEVANT image (a "hamburger" tag still yields a hamburger) instead of
  // a gray box. Multiple sources are queued so a single fetch failure isn't fatal.
  const wiki = await resolveStrictWiki(q);
  if (wiki) sources.push(wiki);
  if (!strict) {
    const us = await unsplashUrl(q, w, h); if (us) sources.push(us);
    const px = await pexelsUrl(q, w, h); if (px) sources.push(px);
    sources.push(`https://loremflickr.com/${w}/${h}/${tag}?lock=${lock}`); // keyword-relevant
    sources.push(`https://loremflickr.com/${w}/${h}?lock=${lock}`);        // last resort: stable
  }
  if (strict && sources.length === 0) return res.status(404).end(); // no trustworthy image → client placeholder
  for (const src of sources) {
    try {
      const r = await fetchR(src, { headers: { "User-Agent": "snackapp/0.1 (alpha)" }, timeoutMs: 8000 });
      const buf = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get("content-type") || "image/jpeg";
      if (imgCache.size < 200) imgCache.set(key, { buf, type });
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.end(buf);
    } catch { /* try next source */ }
  }
  res.status(502).end();
});

// Prewarm a strict worldcup image into imgCache so the PLAY screen shows it
// instantly instead of a long dim slot. Fire-and-forget; same cache key + 600x600
// default as /api/img?strict=1&q=<q>. ko-first wikipediaUrl keeps it fresh-KR-friendly.
async function prewarmImage(q) {
  if (process.env.SNACK_NO_PREWARM) return; // off-switch: prewarm competes with image loads under heavy fan-out (gate/oracle); a normal server leaves it ON
  const qq = String(q ?? "").trim().slice(0, 60);
  if (!qq) return;
  const key = `s|${qq}|600x600`;
  if (imgCache.has(key)) return;
  try {
    const wiki = await resolveStrictWiki(qq);
    if (!wiki) return;
    const r = await fetchR(wiki, { headers: { "User-Agent": "snackapp/0.1 (alpha)" }, timeoutMs: 8000 });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get("content-type") || "image/jpeg";
    if (imgCache.size < 200) imgCache.set(key, { buf, type });
  } catch { /* best-effort prewarm */ }
}

// Boot + periodic warm-up for every dynamic-content template so the FIRST viewer
// gets an instant play screen instead of staring at blank cards while OpenAI +
// Wikipedia round-trip (that cold-open looked like a bug). Two phases, because
// content and images have very different weights:
//   Phase 1 (CONTENT) — the multi-second LLM generation is the real wait, so warm
//     it for ALL templates first, with bounded concurrency (independent LLM calls
//     finish together instead of stacking to minutes). This is what the user sees.
//   Phase 2 (IMAGES) — best-effort, AFTER content: strict cards already show the
//     name while the face loads, so images backfill sequentially (no fetch burst).
// getContent caches per KST bucket → re-running within the hour is a cheap cache
// hit; only a rotation boundary regenerates.
let prewarmingAll = false;
async function prewarmAll() {
  if (process.env.SNACK_NO_PREWARM || prewarmingAll) return;
  prewarmingAll = true;
  try {
    const specs = [];
    for (const { doc } of allTemplateDocs()) {
      const url = doc?.data?.url;
      if (!url) continue;
      try { const u = new URL(url, "http://x"); const kind = u.searchParams.get("kind") || ""; if (kind) specs.push({ kind, theme: u.searchParams.get("theme") || "" }); }
      catch { /* skip unparseable */ }
    }
    // Phase 1: content, bounded-concurrent (don't block a slow one behind another).
    const contents = [];
    const CONC = 6;
    for (let i = 0; i < specs.length; i += CONC) {
      const batch = await Promise.all(specs.slice(i, i + CONC).map((s) => getContent(s.kind, s.theme).catch(() => null)));
      contents.push(...batch);
    }
    // Phase 2: warm ONLY the OPENING matchup (current[0],[1]) of every worldcup —
    // the two faces on the first screen, so whichever cup opens is ready instantly.
    // Deliberately NOT the whole 16: warming ~200 Wikipedia images/cycle risks a 429
    // (their REST API rate-limits) that would blank cards for everyone; later-round
    // faces load on-demand as the user taps through (naturally spaced, then cached).
    // Sequential + best-effort: a strict miss just shows the name placeholder.
    const cups = contents.filter((d) => Array.isArray(d?.current) && d.current.length);
    for (const d of cups) { await prewarmImage(d.current[0]?.q); await prewarmImage(d.current[1]?.q); }
  } finally { prewarmingAll = false; }
}

// Selfie upload (nickname onboarding). Client downscales to ~256px JPEG and POSTs
// a data-URL keyed by anonId; stored on disk, served at /api/photo/<anonId>, and
// surfaced in rosterPhotos so photo apps render real faces.
app.post("/api/photo", (req, res) => {
  const anonId = String(req.body?.anonId ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const m = String(req.body?.dataUrl ?? "").match(/^data:image\/\w+;base64,(.+)$/);
  if (!anonId || !m) return res.status(400).json({ ok: false });
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 64 || buf.length > 700_000) return res.status(413).json({ ok: false }); // expect a downscaled selfie
  try { writeFileSync(photoPath(anonId), buf); return res.json({ ok: true, url: `/api/photo/${anonId}` }); }
  catch { return res.status(500).json({ ok: false }); }
});
app.get("/api/photo/:id", (req, res) => {
  try {
    const buf = readFileSync(photoPath(req.params.id));
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.end(buf);
  } catch { return res.status(404).end(); }
});

// Chat builder: idea -> Bite document (gpt-5.5 + validate + repair). Returns the doc
// for the player to render immediately. Persistence/slug is a later step.
app.post("/api/builder/chat", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  const gate = builderAllowed(req);
  if (!gate.ok) {
    return res.status(429).json({ valid: false, error:
      gate.scope === "global"
        ? "지금 빌드 요청이 많아요. 잠시 후 다시 시도해주세요."
        : "잠깐의 시간당 생성 한도를 넘었어요. 잠시 후 다시 시도해주세요." });
  }
  const current = req.body?.current && typeof req.body.current === "object" ? req.body.current : undefined;
  const mode = ["single", "multi", "auto", "coop", "race"].includes(req.body?.mode) ? req.body.mode : "auto"; // default: AI decides
  const rebuild = req.body?.rebuild === true; // mode conversion → full rebuild (not patch)
  try {
    const r = await buildApp(prompt, current, mode, { rebuild });
    res.json(r);
  } catch (e) {
    res.status(500).json({ valid: false, error: String(e?.message ?? e) });
  }
});

// Persist a (generated) Bite document and issue a share slug -> /p/:slug.
app.post("/api/apps", (req, res) => {
  const doc = req.body?.doc;
  const v = validateBite(doc);
  if (!v.ok) return res.status(400).json({ error: "invalid Bite document", issues: v.errors.slice(0, 10) });
  let slug; do { slug = newSlug(); } while (apps[slug]);
  apps[slug] = entryFromDoc(doc);
  try {
    writeFileSync(resolve(DATA, `${slug}.json`),
      JSON.stringify({ doc, manifest: req.body?.manifest ?? null, createdAt: Date.now() }));
  } catch (e) { return res.status(500).json({ error: String(e?.message ?? e) }); }
  res.json({ slug, url: `/p/${slug}` });
});

app.get("/api/apps/:slug", (req, res) => {
  const a = apps[req.params.slug];
  if (!a) return res.status(404).json({ error: "not found" });
  const slug = req.params.slug;
  const live = rooms.get(slug)?.engine.sharedState();
  res.json({ doc: a.doc, sharedState: live ? { votesByOption: live.votesByOption, coopTotal: live.coopTotal, leaderboard: live.leaderboard } : coldShared(slug) });
});

// Round content for a host-mode room (the host's device asks; same packs the
// server-run rooms use, LLM-fresh when available, curated otherwise).
app.get("/api/pack", async (req, res) => {
  const game = String(req.query.game || "");
  const pack = game ? await dynamicPack(game, { theme: String(req.query.theme || "") || undefined }) : null;
  res.set("Cache-Control", "no-store");
  res.json({ pack });
});

// Host-mode rooms report player points and activity here (the room runs on a
// player's device). Validated and capped like the server-run rooms' own events.
const EVENT_KINDS = new Set(["join", "vote", "tally", "score", "start"]);
const eventHits = new Map(); // ip → timestamps (last minute)
app.post("/api/events", (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (eventHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= 60) return res.status(429).json({ ok: false });
  hits.push(now);
  eventHits.set(ip, hits);
  const slug = String(req.body?.slug ?? "").slice(0, 64);
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
  let applied = 0;
  for (const e of events) {
    if (e?.k === "pts" && typeof e.anonId === "string" && e.anonId.length <= 64) {
      bumpUser(e.anonId, String(e.nick ?? ""), Math.max(0, Math.min(2, Math.floor(Number(e.pts) || 0))));
      applied++;
    } else if (e?.k === "act" && EVENT_KINDS.has(e.kind) && slug) {
      logActivity(slug, e.kind, String(e.label ?? "").slice(0, 20));
      applied++;
    }
  }
  res.json({ ok: true, applied });
});

// ── Templates: starter gallery on the Create landing ──
app.get("/api/templates", (req, res) => {
  res.json(listTemplates({ sort: req.query.sort, category: req.query.category }));
});
app.get("/api/templates/:id", (req, res) => {
  const doc = getTemplateDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: "not found" });
  markUsed(req.params.id); // opening a template to build on = a "use"
  res.json({ doc });
});
app.post("/api/templates/:id/rate", (req, res) => {
  const v = rateTemplate(req.params.id, req.body?.stars);
  if (!v) return res.status(400).json({ error: "invalid id or stars (1-5)" });
  res.json(v);
});

// Dynamic content for "fresh every (KST) hour" templates. A template's
// data.url points here; the player fetches it on mount → setVars the JSON
// keys into matching variables → `each` lists and templates re-render live.
app.get("/api/content", async (req, res) => {
  const kind = String(req.query.kind || "");
  const data = await getContent(kind, String(req.query.theme || ""));
  res.set("Cache-Control", "no-store"); // freshness is owned by the server-side KST-hour cache
  res.json(data);
  // After responding, warm the worldcup images SEQUENTIALLY in the background so the
  // play screen renders faces fast — without a 16-way concurrent fetch burst that
  // spikes server load (that burst made gate taps flaky). One at a time is plenty:
  // early matchups warm first, later ones warm while the user plays.
  if ((kind === "worldcup" || kind === "songcup" || kind === "idolcup" || kind === "singercup") && Array.isArray(data?.current)) {
    void (async () => { for (const c of data.current) await prewarmImage(c?.q); })();
  }
});

// Live platform pulse for the dashboard: per-snack playing/trend + global online
// + a recent-activity ticker. Polled by the dashboard (~every few seconds).
let trendOrderCache = { at: 0, ids: [] }; // X6: 30s-windowed trend rank order
app.get("/api/live", (_req, res) => {
  const now = Date.now();
  const { templates: tpls } = listTemplates({ sort: "rank" });
  const snacks = tpls.map((t) => {
    const slug = `${TPL_PREFIX}${t.id}`;
    const playing = playingIn(slug);
    const recent = recentActivityCount(slug, now);
    return { id: t.id, slug, playing, recent, trendScore: playing * 4 + recent };
  });
  // X6: freeze the trend RANK order in 30s windows so the board doesn't churn
  // every poll (too real-time felt jittery). Live counts still update; only the
  // ordering re-snapshots every 30s.
  if (now - trendOrderCache.at > 30_000) {
    const ranked = [...snacks].sort((a, b) => b.trendScore - a.trendScore);
    trendOrderCache = { at: now, ids: ranked.map((s) => s.id) };
  }
  const orderIdx = new Map(trendOrderCache.ids.map((id, i) => [id, i]));
  snacks.sort((a, b) => (orderIdx.get(a.id) ?? 999) - (orderIdx.get(b.id) ?? 999));
  snacks.forEach((s, i) => { s.trendRank = i + 1; });
  const ticker = ACTIVITY.slice(-10).reverse().map((a) => {
    const id = a.slug.startsWith(TPL_PREFIX) ? a.slug.slice(TPL_PREFIX.length) : a.slug;
    const m = templateMeta(id);
    return { emoji: m?.emoji || "✨", title: m?.title || id, label: a.label, t: a.t };
  });
  res.set("Cache-Control", "no-store");
  res.json({ globalOnline: globalOnline(), now, top: snacks[0] || null, snacks, ticker, leaderboard: leaderboard(8) });
});

// Global user leaderboard (cross-room, by nickname). Real activity only.
app.get("/api/leaderboard", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ leaderboard: leaderboard(Number(_req.query?.n) || 20) });
});

// Optionally serve a built player at the same origin (single-origin alpha).
const PLAYER_DIST = resolve(ROOT, "snack-player/dist");
if (existsSync(PLAYER_DIST)) {
  app.use(express.static(PLAYER_DIST));
  app.get("*", (_req, res) => res.sendFile(resolve(PLAYER_DIST, "index.html")));
}

const server = createServer(app);
// Two realtime paths on one port: /ws = rooms run by this server, /relay = host
// mode (a player's device runs the room; the relay only routes). Upgrades are
// dispatched by path — a `server`-bound WebSocketServer would reject /relay.
const wss = new WebSocketServer({ noServer: true });
const relay = attachRelay(server, { path: "/relay" });
server.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  else if (p !== "/relay") socket.destroy();
});

const send = (ws, t, d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t, d })); };
const broadcast = (slug, t, d) => { for (const ws of room(slug).sockets) send(ws, t, d); };

wss.on("connection", (ws) => {
  let slug = null;
  const peerId = `peer${++peerSeq}`;
  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const { t, d } = msg;
    if (t === "hello") {
      if (slug) return; // one room per socket
      slug = String(d?.slug ?? "");
      const r = room(slug);
      r.sockets.set(peerId, ws);
      r.engine.join(peerId, { anonId: d?.anonId, nick: d?.nick });
    } else if ((t === "action" || t === "react") && slug) {
      // Light abuse guard: cap messages per socket (anon dedup already caps a
      // voter to one tallied vote).
      const now = Date.now();
      ws.actionTimes = (ws.actionTimes || []).filter((x) => now - x < 1000);
      ws.actionTimes.push(now);
      if (ws.actionTimes.length > 15) {
        return send(ws, "actionAck", { clientMsgId: d?.clientMsgId, accepted: false, reason: "rate_limited" });
      }
      const r = rooms.get(slug);
      if (!r) return;
      if (t === "react") r.engine.react(d?.emoji);
      else r.engine.action(peerId, d);
    }
  });
  ws.on("close", () => {
    const r = slug && rooms.get(slug);
    if (!r) return;
    r.sockets.delete(peerId);
    // Empty rooms are evicted — votes are on disk and reload on the next join.
    if (r.engine.leave(peerId)) rooms.delete(slug);
  });
});

// No host arg → Node binds :: dual-stack (IPv6 ::1 + IPv4 127.0.0.1 + LAN),
// so `localhost` works whether the browser resolves it to ::1 or 127.0.0.1.
server.listen(PORT, () => {
  console.log(`[snack-server] http+ws on :${PORT} (dual-stack)  apps=${Object.keys(apps).join(",")}`);
  // Warm content + worldcup images at boot so the first viewer opens instantly,
  // then keep them warm across KST cache rotations (~10min tracks hourly/daily).
  void prewarmAll();
  setInterval(() => void prewarmAll(), 600_000).unref?.();
});
