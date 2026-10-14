// Saved room results, end to end (docs/room-results.md): the real serverless player,
// three real browsers, a local broker and the real /api/room-result handler (memory store
// = the fake KV) behind a tiny static server.
//   1. A opens a friends-room link alone → nothing saved yet → no "지난 판 결과"
//   2. B joins; a 1:1 default quiz is played to the result with real taps
//   3. the host saved exactly one result for the room (write-once per game)
//   4. both leave; C opens the link → alone in the lobby → sees the saved ranking
//      (both nicknames, 문제별로 보기, the 7-day note), "이 방에서 한 판 더" → lobby
//   5. D opens while C is there → not alone → no result screen
// Usage: node snack-server/tools/room-result-e2e.mjs [--skip-build] [--shots <dir>]
// Ports: RR_E2E_PORT (else ORACLE_PREVIEW_PORT, else 4512) for the page + API, RR_E2E_BROKER_PORT (else ORACLE_BROKER_PORT, else 4511).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startLocalBroker } from "../../packages/snack-room/tools/localBroker.js";
import { createHandler } from "../../api/room-result.js";
import { createMemoryStore } from "../../api/_lib/store.js";
import { roomHash } from "../../api/_lib/roomResult.js";
import { runGate } from "./_gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const PORT = Number(process.env.RR_E2E_PORT || process.env.ORACLE_PREVIEW_PORT || 4512);
const BROKER_PORT = Number(process.env.RR_E2E_BROKER_PORT || process.env.ORACLE_BROKER_PORT || 4511);
const OUT = join(tmpdir(), "snack-room-result-e2e-dist");
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "tpl-speed-trivia-score";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE = Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const ROOM = `${SLUG}~${CODE}`;
const LINK = `${BASE}/p/${SLUG}?room=${CODE}`;

const broker = await startLocalBroker({ port: BROKER_PORT });
if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
  const env = { ...process.env, VITE_BROKER_URL: broker.url };
  delete env.VITE_SERVER_URL;
  const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
  if (b.status !== 0) {
    console.error(b.stdout, b.stderr);
    await broker.close();
    runGate("room-result-e2e", [{ id: "build", ok: false }], (r) => r.ok);
    process.exit(1);
  }
}

// Static player (SPA fallback for /p/*) + the real API function on a memory store.
const store = createMemoryStore();
const api = createHandler({ env: {}, memoryStore: store });
const apiLog = [];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname === "/api/room-result") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await api(new Request(url, { method: req.method, headers: { ...req.headers, "x-forwarded-for": "127.0.0.1" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
    apiLog.push({ method: req.method, status: r.status });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(204).end(); // /api/ev telemetry: not part of this check
    return;
  }
  let file = join(OUT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(OUT) || !existsSync(file) || !extname(file)) file = join(OUT, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const targets = () => {
  const v = globalThis.__bite;
  const out = [];
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    if (inst.tap) {
      const a = v.toClient(ax, ay);
      const b = v.toClient(ax + inst.box.w, ay + inst.box.h);
      out.push({ name: inst.tap.node.id ?? inst.key, key: inst.key, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
    }
    const off = v.scroll.get(inst.key) ?? { x: 0, y: 0 };
    inst.children.forEach((c) => walk(c, ax - off.x, ay - off.y));
  };
  walk(v.scene.root, 0, 0);
  return out.filter((t) => t.w > 1 && t.h > 1 && t.y < innerHeight && t.y + t.h > 0);
};
const vars = (page) => page.evaluate(() => ({ phase: globalThis.__bite?.app.phase, ...globalThis.__bite?.app.vars }));
async function tapNode(page, re) {
  const all = await page.evaluate(targets);
  const t = all.find((x) => re.test(String(x.name)));
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
const lastResultShown = (page) => page.locator('[role="dialog"][aria-label="지난 판 결과"]').count().then((n) => n > 0);

async function open(browser, nick, logs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript((n) => localStorage.setItem("snack_nick", n), nick);
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`${nick} ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${nick} pageerror: ${e.message}`));
  await page.goto(LINK, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
  return page;
}

const results = [];
const logs = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${extra.error ?? ""}`);
};
const browsers = [];
try {
  const [bA, bB] = [await launch(), await launch()];
  browsers.push(bA, bB);
  // 1. A alone in a new room: looks up, nothing there.
  const A = await open(bA, "앨리스", logs);
  await waitFor(async () => (await vars(A)).sessionPhase === "lobby" || (await vars(A)).roster?.length === 1, 10000, "A in the lobby");
  await sleep(2500);
  step("A alone: looked up, nothing saved → no result screen", !(await lastResultShown(A)) && apiLog.some((l) => l.method === "GET" && l.status === 404), { api: [...apiLog] });

  // 2. B joins; 1:1 default quiz with real taps.
  const B = await open(bB, "밥", logs);
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => (v.roster || []).length === 2), 15000, "both in the room");
  step("B joined: not alone → no result screen on B", !(await lastResultShown(B)));
  if (!(await tapNode(A, /^startBtn$/))) throw new Error("no start button");
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.phase === "play" || v.sessionPhase === "play"), 15000, "both in play");
  const pick = { A: /^tile0$/, B: /^tile1$/ };
  await waitFor(async () => {
    for (const [name, p] of [["A", A], ["B", B]]) {
      const v = await vars(p);
      if (v.sessionPhase === "play" && v.roundAnswer < 0 && v.seenRound === v.roundIdx && v.myAnswerRound !== v.roundIdx) await tapNode(p, pick[name]);
    }
    return (await Promise.all([A, B].map(vars))).every((v) => v.sessionPhase === "result");
  }, 90000, "both reach the result");
  await sleep(1500);
  const board = (await vars(A)).raceBoard;
  const posts = apiLog.filter((l) => l.method === "POST");
  const savedRaw = store.rr.get(`rr:${roomHash(ROOM)}`)?.value;
  const saved = savedRaw ? JSON.parse(savedRaw) : null;
  step("host saved one result for the room", posts.length >= 1 && posts.filter((p) => p.status === 200).length === posts.length && saved?.board?.length === 2 && saved?.quizRecap?.rounds?.length === 6, { posts, board, savedBoard: saved?.board });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await A.screenshot({ path: join(SHOTS, "1-live-result.png") });
  }

  // 3. Both leave; C opens the link later.
  await Promise.all([bA.close(), bB.close()]);
  browsers.length = 0;
  await sleep(4000);
  const bC = await launch();
  browsers.push(bC);
  const getsBefore = apiLog.filter((l) => l.method === "GET").length;
  const C = await open(bC, "캐럴", logs);
  await waitFor(() => lastResultShown(C), 15000, "C sees the last result");
  const text = await C.locator('[role="dialog"][aria-label="지난 판 결과"]').innerText();
  const ranking = await C.locator('ol[aria-label="순위"] li').allInnerTexts().catch(() => []);
  const nicksShown = ["앨리스", "밥"].every((n) => text.includes(n));
  step("C (alone, later) sees the saved ranking + per-question reveal + 7-day note", nicksShown && text.includes("문제별로 보기") && text.includes("이 결과는 7일 동안 링크로 볼 수 있어요") && text.includes("이 방에서 한 판 더") && text.includes("결과 공유"), { ranking, gets: apiLog.filter((l) => l.method === "GET").length - getsBefore });
  if (SHOTS) await C.screenshot({ path: join(SHOTS, "2-last-result.png"), fullPage: true });

  // 4. D opens while C is there: not alone → no lookup screen.
  const bD = await launch();
  browsers.push(bD);
  const D = await open(bD, "데이브", logs);
  await waitFor(async () => (await vars(D)).roster?.length === 2, 15000, "D in the room with C");
  await sleep(2000);
  step("D (C is there) → no result screen", !(await lastResultShown(D)));

  // 5. "이 방에서 한 판 더" → back to the lobby.
  await C.getByRole("button", { name: "이 방에서 한 판 더" }).click();
  await sleep(300);
  const v = await vars(C);
  step("이 방에서 한 판 더 → lobby", !(await lastResultShown(C)) && (v.sessionPhase ?? "lobby") === "lobby");
  if (SHOTS) await C.screenshot({ path: join(SHOTS, "3-lobby.png") });
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-40), api: apiLog });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await broker.close();
}
runGate("room-result-e2e", results, (r) => r.ok);
process.exit(process.exitCode ?? 0);
