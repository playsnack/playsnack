#!/usr/bin/env node
// Link-preview images (#106, docs/link-previews.md), drawn once and committed:
//   snack-player/public/og/default.png   1200×630  site card (og:image for / and unknown links)
//   snack-player/public/og/square.png     600×600  square fallback (second og:image)
//   snack-player/public/og/app/<id>.png  1200×630  one per catalog app (snack-server/data/bite/index.json)
//   snack-player/public/og/manifest.json           {default, square, apps:{id: v}} — v = hash of what the
//                                                   picture is drawn from, used as `?v=` so a changed
//                                                   picture gets a new URL (Kakao caches images by URL)
// and the <!-- og:begin --> … <!-- og:end --> block of snack-player/index.html (the site's own meta).
//
// Drawn by headless Chromium (Playwright, already a dev dependency) from HTML with the bundled
// fonts: Pretendard 700 for Korean, Galmuri11 bold only for the Latin "PlaySnack" mark / address
// (tokens.mjs #84 rule). Emoji come from the OS emoji font (Apple Color Emoji on macOS — draw on a
// Mac so the committed pictures match what iPhone users see).
//   node scripts/og-images.mjs            draw everything
//   node scripts/og-images.mjs --check    only check: every catalog app has a picture + manifest entry,
//                                         sizes are right, index.html block is current (exit 1 if not)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATEGORY_LABEL, DEFAULT_DESCRIPTION, DEFAULT_TITLE, SITE_NAME } from "../api/_lib/og.js";
import { TOKENS } from "../snack-server/src/tokens.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "snack-player/public/og");
const FONTS = path.join(ROOT, "snack-player/public/fonts");
const INDEX_HTML = path.join(ROOT, "snack-player/index.html");
const CATALOG = JSON.parse(readFileSync(path.join(ROOT, "snack-server/data/bite/index.json"), "utf8"));
export const SITE_ORIGIN = "https://playsnack.pages.dev";
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const C = TOKENS.color;

// Bump when the drawing below changes (it is part of every picture's `v`).
const DESIGN = "og-2";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hash = (...parts) => createHash("sha256").update(parts.map((p) => JSON.stringify(p)).join("\n")).digest("hex").slice(0, 8);

const DEFAULT_EMOJI = ["🍜", "🧠", "⚡", "🏁", "🎡"];

function page(w, h, body) {
  const f = (name) => pathToFileURL(path.join(FONTS, name)).href;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@font-face { font-family: "PT"; src: url("${f("pretendard-700-full.woff2")}") format("woff2"); font-weight: 700; }
@font-face { font-family: "PX"; src: url("${f("galmuri11-bold-full.woff2")}") format("woff2"); font-weight: 700; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: ${C.bg}; color: ${C.ink}; }
body { font-family: "PT", sans-serif; font-weight: 700; position: relative;
  background-image: linear-gradient(${C.surface} 2px, transparent 2px), linear-gradient(90deg, ${C.surface} 2px, transparent 2px);
  background-size: 42px 42px; background-position: -1px -1px; }
.emo { font-family: "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif; font-weight: 400; line-height: 1; }
.px { font-family: "PX", monospace; font-weight: 700; letter-spacing: 0; }
.mark { display: flex; align-items: center; gap: 14px; color: ${C.accent}; }
.mark i { display: block; background: ${C.accent}; box-shadow: inset -4px -4px 0 rgba(0,0,0,.35); }
.blk { background: ${C.surface}; border: 3px solid ${C.borderBlock};
  box-shadow: inset 3px 3px 0 rgba(255,255,255,.10), inset -3px -3px 0 rgba(0,0,0,.45), 0 8px 0 #000;
  display: flex; align-items: center; justify-content: center; }
.cta { background: ${C.accent}; color: ${C.accentInk}; box-shadow: inset -4px -4px 0 rgba(0,0,0,.25), 0 8px 0 #000; }
.muted { color: ${C.inkMuted}; }
</style></head><body>${body}</body></html>`;
}

function defaultCard() {
  const tiles = DEFAULT_EMOJI.map((e, i) => `<div class="blk" style="width:118px;height:118px;${i === 2 ? `border-color:${C.accent};` : ""}"><span class="emo" style="font-size:64px">${e}</span></div>`).join("");
  return page(1200, 630, `
<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;padding-top:6px">
  <div class="mark px" style="font-size:58px"><i style="width:40px;height:40px"></i>PlaySnack</div>
  <div style="font-size:92px;line-height:1.08;letter-spacing:-2px">친구랑 바로 한 판</div>
  <div style="display:flex;gap:26px">${tiles}</div>
  <div class="px muted" style="font-size:24px;margin-top:4px">playsnack.pages.dev</div>
</div>`);
}

function squareCard() {
  const tiles = DEFAULT_EMOJI.slice(0, 4).map((e, i) => `<div class="blk" style="width:112px;height:112px;${i === 0 ? `border-color:${C.accent};` : ""}"><span class="emo" style="font-size:60px">${e}</span></div>`).join("");
  return page(600, 600, `
<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px">
  <div class="mark px" style="font-size:44px"><i style="width:30px;height:30px"></i>PlaySnack</div>
  <div style="display:grid;grid-template-columns:112px 112px 112px 112px;gap:18px">${tiles}</div>
  <div style="font-size:60px;line-height:1.1;letter-spacing:-1.5px">친구랑 바로 한 판</div>
</div>`);
}

function appCard(e) {
  const multi = e.mode === "multi";
  const cat = CATEGORY_LABEL[e.category] ?? "스낵";
  return page(1200, 630, `
<div class="mark px" style="position:absolute;left:72px;top:58px;font-size:34px"><i style="width:24px;height:24px"></i>PlaySnack</div>
<div class="px muted" style="position:absolute;right:72px;top:64px;font-size:24px">playsnack.pages.dev</div>
<div class="blk" style="position:absolute;left:96px;top:160px;width:320px;height:320px"><span class="emo" style="font-size:190px">${esc(e.emoji || "🎮")}</span></div>
<div style="position:absolute;left:480px;right:72px;top:160px;height:320px;display:flex;flex-direction:column;justify-content:center;gap:26px">
  <div style="display:flex;gap:12px">
    <span style="background:${C.surface2};border:2px solid ${C.borderBlock};padding:8px 18px;font-size:28px" class="muted">${esc(cat)}</span>
    ${multi ? `<span style="background:${C.surface2};border:2px solid ${C.borderBlock};padding:8px 18px;font-size:28px;color:${C.roster4}">같이</span>` : ""}
  </div>
  <div id="t" style="font-size:96px;line-height:1.1;letter-spacing:-2px;word-break:keep-all">${esc(e.title)}</div>
  <div><span class="cta" style="display:inline-block;padding:16px 30px;font-size:34px">${multi ? "친구랑 같이 하기 ▶" : "링크 열고 바로 시작 ▶"}</span></div>
</div>`);
}

// Shrink the title until it fits in 2 lines of the text column.
const FIT = `(() => { const t = document.getElementById("t"); if (!t) return;
  let s = 96; const max = () => parseFloat(getComputedStyle(t).lineHeight) * 2 + 2;
  while (s > 48 && (t.scrollHeight > max() || t.scrollWidth > t.clientWidth)) { s -= 4; t.style.fontSize = s + "px"; } })()`;

function indexBlock(manifest) {
  const img = `${SITE_ORIGIN}/og/default.png?v=${manifest.default}`;
  const sq = `${SITE_ORIGIN}/og/square.png?v=${manifest.square}`;
  const alt = "PlaySnack — 친구랑 바로 한 판";
  return `<!-- og:begin — written by scripts/og-images.mjs; /p/* links get per-app values from functions/p/[[path]].js (docs/link-previews.md) -->
    <title>${esc(DEFAULT_TITLE)}</title>
    <meta name="description" content="${esc(DEFAULT_DESCRIPTION)}" />
    <link rel="canonical" href="${SITE_ORIGIN}/" />
    <meta name="theme-color" content="${C.bg}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:locale" content="ko_KR" />
    <meta property="og:title" content="${esc(DEFAULT_TITLE)}" />
    <meta property="og:description" content="${esc(DEFAULT_DESCRIPTION)}" />
    <meta property="og:url" content="${SITE_ORIGIN}/" />
    <meta property="og:image" content="${img}" />
    <meta property="og:image:secure_url" content="${img}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${esc(alt)}" />
    <meta property="og:image" data-og="square" content="${sq}" />
    <meta property="og:image:secure_url" data-og="square" content="${sq}" />
    <meta property="og:image:type" data-og="square" content="image/png" />
    <meta property="og:image:width" data-og="square" content="600" />
    <meta property="og:image:height" data-og="square" content="600" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(DEFAULT_TITLE)}" />
    <meta name="twitter:description" content="${esc(DEFAULT_DESCRIPTION)}" />
    <meta name="twitter:image" content="${img}" />
    <meta name="twitter:image:alt" content="${esc(alt)}" />
    <!-- og:end -->`;
}
const BLOCK_RE = /<!-- og:begin[\s\S]*?<!-- og:end -->/;

function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

function manifestFor() {
  const apps = {};
  for (const e of CATALOG) apps[e.id] = hash(DESIGN, e.title, e.emoji, e.category, e.mode);
  return { design: DESIGN, default: hash(DESIGN, "default"), square: hash(DESIGN, "square"), apps };
}

/** Problems with the committed pictures (empty = fine). */
export function check() {
  const bad = [];
  const mfile = path.join(OUT, "manifest.json");
  if (!existsSync(mfile)) return ["snack-player/public/og/manifest.json missing — run node scripts/og-images.mjs"];
  const m = JSON.parse(readFileSync(mfile, "utf8"));
  const want = manifestFor();
  let total = 0;
  const one = (rel, w, h, v, wantV) => {
    const f = path.join(OUT, rel);
    if (!existsSync(f)) return bad.push(`og/${rel} missing`);
    const s = pngSize(f);
    total += s.bytes;
    if (s.w !== w || s.h !== h) bad.push(`og/${rel} is ${s.w}×${s.h}, want ${w}×${h}`);
    if (v !== wantV) bad.push(`og/${rel} is out of date (catalog or drawing changed) — run node scripts/og-images.mjs`);
  };
  one("default.png", 1200, 630, m.default, want.default);
  one("square.png", 600, 600, m.square, want.square);
  for (const e of CATALOG) one(`app/${e.id}.png`, 1200, 630, m.apps?.[e.id], want.apps[e.id]);
  const extra = existsSync(path.join(OUT, "app")) ? readdirSync(path.join(OUT, "app")).filter((f) => !CATALOG.some((e) => `${e.id}.png` === f)) : [];
  for (const f of extra) bad.push(`og/app/${f} has no catalog entry`);
  if (total > MAX_TOTAL_BYTES) bad.push(`og/ pictures total ${total} bytes > ${MAX_TOTAL_BYTES}`);
  const html = readFileSync(INDEX_HTML, "utf8");
  const blk = BLOCK_RE.exec(html);
  if (!blk) bad.push("snack-player/index.html has no <!-- og:begin --> block");
  else if (blk[0] !== indexBlock(m)) bad.push("snack-player/index.html og block is out of date — run node scripts/og-images.mjs");
  return bad;
}

async function draw() {
  const { chromium } = await import("playwright");
  const manifest = manifestFor();
  rmSync(path.join(OUT, "app"), { recursive: true, force: true });
  mkdirSync(path.join(OUT, "app"), { recursive: true });
  const tmp = path.join(OUT, ".draw.html");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    const pg = await ctx.newPage();
    const shot = async (html, w, h, rel) => {
      writeFileSync(tmp, html);
      await pg.setViewportSize({ width: w, height: h });
      await pg.goto(pathToFileURL(tmp).href);
      await pg.evaluate(() => document.fonts.ready);
      await pg.evaluate(FIT);
      await pg.screenshot({ path: path.join(OUT, rel), type: "png", clip: { x: 0, y: 0, width: w, height: h } });
    };
    await shot(defaultCard(), 1200, 630, "default.png");
    await shot(squareCard(), 600, 600, "square.png");
    for (const e of CATALOG) await shot(appCard(e), 1200, 630, `app/${e.id}.png`);
  } finally {
    await browser.close();
    rmSync(tmp, { force: true });
  }
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const html = readFileSync(INDEX_HTML, "utf8");
  if (!BLOCK_RE.test(html)) throw new Error("index.html has no <!-- og:begin --> … <!-- og:end --> block");
  writeFileSync(INDEX_HTML, html.replace(BLOCK_RE, indexBlock(manifest)));
  let total = 0;
  for (const f of ["default.png", "square.png", ...CATALOG.map((e) => `app/${e.id}.png`)]) total += statSync(path.join(OUT, f)).size;
  console.log(`[og-images] ${CATALOG.length} apps + default + square → snack-player/public/og (${(total / 1024).toFixed(0)} KB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    const bad = check();
    for (const b of bad) console.error(`[og-images] ✗ ${b}`);
    if (bad.length) process.exit(1);
    console.log(`[og-images] ✓ ${CATALOG.length} catalog apps each have a 1200×630 picture; index.html block current`);
  } else {
    await draw();
    const bad = check();
    for (const b of bad) console.error(`[og-images] ✗ ${b}`);
    if (bad.length) process.exit(1);
  }
}
