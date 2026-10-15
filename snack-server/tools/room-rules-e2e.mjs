// Who starts a game, end to end (#135 / #136): the real player built for edge rooms
// (VITE_ROOM_URL), three real browsers, the Node edge hub (the same game.js / core.js the
// Durable Object runs) and a tiny static server.
//   1. 친구 방: A opens a public link and presses 🤝 친구끼리 → A is the host (방장). B opens the
//      invite link → no 시작하기, "방장이 시작하길 기다리는 중 · 방장 · A". A starts → both play.
//   2. 공개 방: C opens /p/<slug> → "10초 뒤 시작 · 1명"; D comes 2 s later → same room
//      ("· 2명"); nobody presses anything → the game starts by itself for both.
//   3. 늦게 온 사람: E opens the same link mid-game → moved to `<slug>.g2` (not a spectator),
//      its own countdown there → E plays.
// Usage: node snack-server/tools/room-rules-e2e.mjs [--skip-build] [--shots <dir>]
// Ports: RULES_E2E_PORT (page, default 4713) · RULES_E2E_HUB_PORT (edge hub, default 4712).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startEdgeHub } from "../../packages/snack-room/tools/edgeHub.js";
import { runGate } from "./_gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const PORT = Number(process.env.RULES_E2E_PORT || 4713);
const HUB_PORT = Number(process.env.RULES_E2E_HUB_PORT || 4712);
const OUT = join(tmpdir(), "snack-room-rules-e2e-dist");
const BASE = `http://127.0.0.1:${PORT}`;
const FRIENDS_SLUG = "tpl-tap-battle";
const PUBLIC_SLUG = "tpl-coop-tap-goal";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = await startEdgeHub({ port: HUB_PORT });
if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
  const env = { ...process.env, VITE_ROOM_URL: hub.url };
  delete env.VITE_SERVER_URL;
  delete env.VITE_ROOM_MODE;
  const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
  if (b.status !== 0) {
    console.error(b.stdout, b.stderr);
    await hub.close();
    runGate("room-rules-e2e", [{ id: "build", ok: false }], (r) => r.ok);
    process.exit(1);
  }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname.startsWith("/api/")) return void res.writeHead(204).end(); // telemetry: not checked here
  let file = join(OUT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(OUT) || !existsSync(file) || !extname(file)) file = join(OUT, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// Tappable nodes on screen now (the renderer's scene, in page coordinates).
const targets = () => {
  const v = globalThis.__bite;
  const out = [];
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    if (inst.tap) {
      const a = v.toClient(ax, ay);
      const b = v.toClient(ax + inst.box.w, ay + inst.box.h);
      out.push({ name: inst.tap.node.id ?? inst.key, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
    }
    const off = v.scroll.get(inst.key) ?? { x: 0, y: 0 };
    inst.children.forEach((c) => walk(c, ax - off.x, ay - off.y));
  };
  walk(v.scene.root, 0, 0);
  return out.filter((t) => t.w > 1 && t.h > 1 && t.y < innerHeight && t.y + t.h > 0);
};
// Text nodes on screen now, by id.
const texts = () => {
  const out = {};
  const walk = (inst) => {
    if (inst.kind === "text" && inst.node?.id) out[inst.node.id] = String(inst.content ?? "");
    inst.children.forEach(walk);
  };
  walk(globalThis.__bite.scene.root);
  return out;
};
const vars = (page) => page.evaluate(() => ({ phase: globalThis.__bite?.app.phase, ...globalThis.__bite?.app.vars }));
const hasTarget = async (page, id) => (await page.evaluate(targets)).some((t) => t.name === id);
async function tapNode(page, id) {
  const t = (await page.evaluate(targets)).find((x) => x.name === id);
  if (!t) return false;
  await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  return true;
}
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 150) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${what}`);
}
const launch = () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
async function open(browser, nick, url, logs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript((n) => localStorage.setItem("snack_nick", n), nick);
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`${nick} ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${nick} pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
  return page;
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `rooms-${name}.png`) });
};

const results = [];
const logs = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${extra.error ?? ""}`);
};
const browsers = [];
try {
  const [b1, b2, b3] = [await launch(), await launch(), await launch()];
  browsers.push(b1, b2, b3);

  // ── 1. friends room: the creator hosts ──
  const A = await open(b1, "앨리스", `${BASE}/p/${FRIENDS_SLUG}`, logs);
  await A.getByRole("button", { name: "친구끼리 하는 방 만들기" }).click();
  await waitFor(async () => /[?&]room=/.test(A.url()) && (await vars(A)).iAmHost === true, 15000, "A made a friends room and hosts it");
  const invite = A.url();
  const B = await open(b2, "밥", invite, logs);
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => (v.roster || []).length === 2), 15000, "both in the friends room");
  await sleep(500);
  const vb = await vars(B);
  const tb = await B.evaluate(texts);
  step("friends room: B (not the host) has no 시작하기, sees the waiting label", vb.roomMode === "host" && vb.iAmHost === false && vb.hostNick === "앨리스" && !(await hasTarget(B, "startBtn")) && tb.startWaitMain === "방장이 시작하길 기다리는 중" && tb.startWaitSub === "방장 · 앨리스", { vb: { roomMode: vb.roomMode, iAmHost: vb.iAmHost, hostNick: vb.hostNick }, tb: { main: tb.startWaitMain, sub: tb.startWaitSub } });
  step("friends room: A (the host) has 시작하기", await hasTarget(A, "startBtn"));
  await shot(B, "friends-guest-waiting");
  await shot(A, "friends-host");
  // B forging a start (the button is gone, but the room must refuse it too)
  await B.evaluate(() => globalThis.__bite.app.tap?.("startBtn"));
  await sleep(1500);
  step("friends room: nothing started without the host", (await vars(A)).sessionPhase !== "countdown" && (await vars(A)).sessionPhase !== "play");
  await tapNode(A, "startBtn");
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.sessionPhase === "play"), 15000, "both play after the host started");
  step("friends room: the host started → both play", true);
  await A.context().close();
  await B.context().close();

  // ── 2. public room: auto-start ──
  const C = await open(b1, "캐럴", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => (await vars(C)).autoStartIn > 0, 15000, "C sees the countdown");
  const vc = await vars(C);
  const tc = await C.evaluate(texts);
  step("public room: '<n>초 뒤 시작 · 1명' and no 시작하기", vc.roomMode === "auto" && /^\d+초 뒤 시작 · 1명$/.test(tc.startWaitMain ?? "") && !(await hasTarget(C, "startBtn")), { text: tc.startWaitMain, autoStartIn: vc.autoStartIn });
  await shot(C, "public-countdown");
  await sleep(2000);
  const D = await open(b2, "데이브", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => ((await D.evaluate(texts)).startWaitMain ?? "").endsWith("· 2명"), 10000, "D in the same lobby, '· 2명'");
  const left = (await vars(D)).autoStartIn;
  step("public room: D joined during the countdown, sees the same countdown", left > 0 && left <= 8, { autoStartIn: left });
  await shot(D, "public-countdown-2");
  await waitFor(async () => (await Promise.all([C, D].map(vars))).every((v) => v.sessionPhase === "play"), 20000, "the game started by itself");
  const spectating = (await Promise.all([C, D].map(vars))).some((v) => v.iAmSpectator === true);
  step("public room: started by itself — both play, nobody pressed start", !spectating);

  // ── 3. a late arrival: moved to the next room, which starts on its own ──
  const E = await open(b3, "에린", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => (await vars(E)).autoStartIn > 0, 15000, "E sees a countdown (in the next room)");
  const ve = await vars(E);
  const g2 = hub.room(`${PUBLIC_SLUG}.g2`);
  step("late arrival: moved to the next room (its own lobby + countdown), not a spectator", ve.iAmSpectator !== true && (ve.roster || []).join() === "에린" && Boolean(g2?.sockets.size) && (hub.history().get(`room:${PUBLIC_SLUG}`)?.moved ?? 0) >= 1, { roster: ve.roster, autoStartIn: ve.autoStartIn, g2Sockets: g2?.sockets.size });
  await shot(E, "late-moved-countdown");
  step("public room: C / D unaffected (still 2, still playing)", (await vars(C)).roster?.length === 2);
  await waitFor(async () => (await vars(E)).sessionPhase === "play", 20000, "E plays in the next room");
  step("late arrival: the next room started by itself → E plays", (await vars(E)).iAmSpectator !== true);
  await shot(E, "late-moved-play");
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-40) });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await hub.close();
}
runGate("room-rules-e2e", results, (r) => r.ok);
