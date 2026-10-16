// 시작 시간 예약 end to end (#218): the real player built for edge rooms (VITE_ROOM_URL), two real
// browsers, the Node edge hub (the same game.js / core.js the Durable Object runs; its schedule
// minimum lowered to 1 s for this run only) and a tiny static server.
//   1. A makes a friends room (the room-type chip) and hosts it; B opens the invite link.
//   2. A taps "⏰ 시작 시간 정하기" → the shell's sheet (1/3/5/10분 뒤 + a clock time) → "1분 뒤":
//      both lobbies say "0:5x 뒤 시작!" (the last minute: lime), B "시간이 되면 저절로 시작해요";
//      the room server's preview read says the time (startAt). Screenshots 390×844.
//   3. A taps "예약 취소" → the countdown leaves both screens.
//   4. A schedules again with the test-only short preset (5초 뒤, localStorage snack_sched_test_s):
//      nobody presses anything → the game starts by itself for both (3·2·1 → play).
// Usage: node snack-server/tools/schedule-e2e.mjs [--skip-build] [--shots <dir>]
// Ports: SCHEDULE_E2E_PORT (page, default 4715) · SCHEDULE_E2E_HUB_PORT (edge hub, default 4714).
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
const PORT = Number(process.env.SCHEDULE_E2E_PORT || 4715);
const HUB_PORT = Number(process.env.SCHEDULE_E2E_HUB_PORT || 4714);
const OUT = join(tmpdir(), "snack-schedule-e2e-dist");
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "tpl-tap-battle";
const TEST_SEC = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = await startEdgeHub({ port: HUB_PORT, limits: { scheduleMinMs: 1000 } });
const HUB_HTTP = hub.url.replace(/^ws/, "http");
if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
  const env = { ...process.env, VITE_ROOM_URL: hub.url };
  delete env.VITE_SERVER_URL;
  delete env.VITE_ROOM_MODE;
  const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
  if (b.status !== 0) {
    console.error(b.stdout, b.stderr);
    await hub.close();
    runGate("schedule-e2e", [{ id: "build", ok: false }], (r) => r.ok);
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
async function open(browser, nick, url, logs, init = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  await ctx.addInitScript(([n, s]) => {
    localStorage.setItem("snack_nick", n);
    if (s) localStorage.setItem("snack_sched_test_s", String(s));
  }, [nick, init.testSec ?? 0]);
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`${nick} ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${nick} pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
  return page;
}
const shotAs = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
const roomOf = (url) => `${SLUG}~${new URL(url).searchParams.get("room")}`;

const results = [];
const logs = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${extra.error ?? ""}`);
};
const browsers = [];
try {
  const [b1, b2] = [await launch(), await launch()];
  browsers.push(b1, b2);

  // ── 1. a friends room: A makes it (the room-type chip) and hosts; B joins from the link ──
  const A = await open(b1, "앨리스", `${BASE}/p/${SLUG}`, logs, { testSec: TEST_SEC });
  await waitFor(async () => (await vars(A)).roomMode === "auto", 15000, "A in the public room");
  step("public room: no 시작 시간 정하기 (friends rooms only)", !(await hasTarget(A, "schedBtn")));
  await A.getByTestId("room-type-chip").click();
  await waitFor(async () => /[?&]room=/.test(A.url()) && (await vars(A)).iAmHost === true && (await vars(A)).roomMode === "host", 15000, "A made a friends room and hosts it");
  const invite = A.url();
  const B = await open(b2, "밥", invite, logs);
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => (v.roster || []).length === 2), 15000, "both in the friends room");
  await sleep(400);
  step("friends room: the host has ⏰ 시작 시간 정하기, the guest does not", (await hasTarget(A, "schedBtn")) && !(await hasTarget(B, "schedBtn")));

  // ── 2. "1분 뒤" from the sheet: both count down ──
  await tapNode(A, "schedBtn");
  const sheet = A.getByTestId("schedule-sheet");
  await sheet.waitFor({ state: "visible", timeout: 5000 });
  const presets = await sheet.locator('[data-testid^="schedule-preset-"]').allTextContents();
  const hasClock = (await sheet.getByTestId("schedule-clock").count()) === 1;
  step("the sheet: presets 1/3/5/10분 뒤 (+ the test preset) and a clock time", ["1분 뒤", "3분 뒤", "5분 뒤", "10분 뒤"].every((p) => presets.includes(p)) && hasClock, { presets });
  await sheet.getByTestId("schedule-preset-60000").click();
  await sheet.waitFor({ state: "detached", timeout: 5000 });
  await waitFor(async () => (await Promise.all([A, B].map((p) => p.evaluate(texts)))).every((t) => /^0:5\d 뒤 시작!$/.test(t.schedMain ?? "")), 8000, "both see 0:5x 뒤 시작!");
  const [ta, tb] = await Promise.all([A, B].map((p) => p.evaluate(texts)));
  const [va, vb] = await Promise.all([A, B].map(vars));
  step("1분 뒤: both lobbies say '0:5x 뒤 시작!' + '<time> 시작 · 지금 2명'; B: '시간이 되면 저절로 시작해요'; A: 예약 취소 · 지금 시작",
    /^(오전|오후) \d{1,2}:\d{2} 시작 · 지금 2명$/.test(tb.schedSub ?? "") && tb.startWaitMain === "시간이 되면 저절로 시작해요" && /^0:5\d 뒤 시작!$/.test(ta.schedMain ?? "") && (await hasTarget(A, "startBtn")) && Math.abs(va.startIn - vb.startIn) <= 1,
    { a: ta.schedMain, b: tb.schedMain, sub: tb.schedSub, wait: tb.startWaitMain, startIn: [va.startIn, vb.startIn] });
  const res = await (await fetch(`${HUB_HTTP}/room/${roomOf(invite)}/result`)).json().catch(() => ({}));
  step("the room server says the time for the link preview (startAt ≈ now + 1 min)", Math.abs((res.startAt ?? 0) - (Date.now() + 57_000)) < 5000, { startAt: res.startAt });
  await sleep(300);
  await shotAs(A, "schedule-host");
  await shotAs(B, "schedule-guest");

  // ── 3. 예약 취소 ──
  await tapNode(A, "schedBtn");
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.startAt === 0), 8000, "the countdown left both screens");
  const tb2 = await B.evaluate(texts);
  step("예약 취소: the countdown leaves both screens; B waits for the host again", !("schedMain" in tb2) && tb2.startWaitMain === "방장이 시작하길 기다리는 중", { wait: tb2.startWaitMain });

  // ── 4. the short preset: the game starts by itself at the time ──
  await tapNode(A, "schedBtn");
  await sheet.waitFor({ state: "visible", timeout: 5000 });
  const t0 = Date.now();
  await sheet.getByTestId(`schedule-preset-${TEST_SEC * 1000}`).click();
  await waitFor(async () => (await vars(B)).startIn > 0, 5000, "B counts down");
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.sessionPhase === "countdown" || v.sessionPhase === "play"), TEST_SEC * 1000 + 6000, "the game starts by itself");
  const took = Date.now() - t0;
  step(`${TEST_SEC}초 뒤: nobody presses anything → the 3·2·1 starts by itself for both (at the time, not before)`, took >= TEST_SEC * 1000 - 600, { took });
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.sessionPhase === "play"), 8000, "both play");
  step("both play", true);
  const vb3 = await vars(B);
  step("the schedule is gone once it started", vb3.startAt === 0 && vb3.startIn === 0, { startAt: vb3.startAt });
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-40) });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await hub.close();
}
runGate("schedule-e2e", results, (r) => r.ok);
