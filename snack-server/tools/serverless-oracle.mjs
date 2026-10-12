// Serverless ORACLE — the real static player, two real browsers, one tap-battle room.
// No snack-server, no public broker: the player is built with VITE_BROKER_URL
// pointing at a LOCAL broker (lossy by default), served by `vite preview` on :4176.
//   1. both browsers open #/p/tpl-tap-battle and see each other (roster 2)
//   2. browser A taps 시작하기 → both reach play
//   3. each browser taps the tap area 4× (real touch taps on laid-out nodes)
//   4. both reach result with the SAME board: every player exactly 4
//   ✗ any page opening a WebSocket to a non-local host fails the gate.
// Usage: node snack-server/tools/serverless-oracle.mjs [--runs N] [--skip-build] [--no-lossy]
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startLocalBroker, isLocalBroker } from "../../packages/snack-room/tools/localBroker.js";
import { runGate } from "./_gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const RUNS = Number(argv[argv.indexOf("--runs") + 1]) || 1;
const SKIP_BUILD = argv.includes("--skip-build");
const LOSSY = !argv.includes("--no-lossy");
const PREVIEW_PORT = 4176;
const BROKER_PORT = Number(process.env.ORACLE_BROKER_PORT || 4177); // baked into the build
const OUT = join(tmpdir(), "snack-serverless-oracle-dist");
const BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const TAPS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ORACLE_DROP / ORACLE_MAX_DELAY: harsher lossy mode for stress runs (default 5% / 300 ms).
const lossy = LOSSY && { ...(process.env.ORACLE_DROP ? { drop: Number(process.env.ORACLE_DROP) } : {}), ...(process.env.ORACLE_MAX_DELAY ? { maxDelay: Number(process.env.ORACLE_MAX_DELAY) } : {}) };
const broker = await startLocalBroker({ port: BROKER_PORT, lossy });
if (!isLocalBroker(broker.url)) throw new Error(`not a local broker: ${broker.url}`);

if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
  const env = { ...process.env, VITE_BROKER_URL: broker.url };
  delete env.VITE_SERVER_URL; // serverless build
  const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
  if (b.status !== 0) {
    console.error(b.stdout, b.stderr);
    await broker.close();
    runGate("serverless-oracle", [{ id: "build", ok: false, error: "player build failed" }], (r) => r.ok);
    process.exit(1);
  }
}

const preview = spawn("pnpm", ["-s", "--filter", "@snack/player", "exec", "vite", "preview", "--outDir", OUT, "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let previewLog = "";
preview.stdout.on("data", (d) => (previewLog += d));
preview.stderr.on("data", (d) => (previewLog += d));
const stopPreview = () => {
  try {
    process.kill(-preview.pid, "SIGTERM");
  } catch {
    /* gone */
  }
};
for (let i = 0; i < 100; i++) {
  if (await fetch(BASE).then((r) => r.ok, () => false)) break;
  await sleep(150);
}

// In-page helpers (same approach as e2e-audit: window.__bite exposes the laid-out scene).
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
  const t = all.find((x) => re.test(String(x.name)) || re.test(String(x.key)));
  if (!t) throw new Error(`no tappable ${re} (have: ${all.map((x) => x.name).join(", ")})`);
  await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
}
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: "chrome" }); // bundled chromium missing → system Chrome
  }
}

async function runOnce(run) {
  const foreign = [];
  const browsers = [await launch(), await launch()];
  const pages = [];
  const logs = [[], []];
  try {
    for (const [i, b] of browsers.entries()) {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await ctx.addInitScript((nick) => localStorage.setItem("snack_nick", nick), `오라클${run}${"AB"[i]}`);
      const page = await ctx.newPage();
      page.on("websocket", (ws) => {
        if (!isLocalBroker(ws.url()) && !/^wss?:\/\/127\.0\.0\.1:4176\b/.test(ws.url())) foreign.push(ws.url());
      });
      page.on("console", (m) => logs[i].push(`${m.type()}: ${m.text()}`));
      page.on("pageerror", (e) => logs[i].push(`pageerror: ${e.message}`));
      await page.goto(`${BASE}/#/p/tpl-tap-battle`, { waitUntil: "load" });
      await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
      pages.push(page);
    }
    const [A, B] = pages;
    await waitFor(async () => (await Promise.all(pages.map(vars))).every((v) => (v.roster || []).length === 2), 15000, "both players in the room");
    await tapNode(A, /startBtn/);
    await waitFor(async () => (await Promise.all(pages.map(vars))).every((v) => v.phase === "play"), 10000, "both in play");
    for (let k = 0; k < TAPS; k++) {
      await tapNode(A, /tapArea/);
      await tapNode(B, /tapArea/);
      await sleep(120);
    }
    const local = await Promise.all(pages.map(vars));
    await waitFor(async () => (await Promise.all(pages.map(vars))).every((v) => v.phase === "result"), 20000, "both reach result");
    await sleep(1500); // a resync beat or two
    const end = await Promise.all(pages.map(vars));
    const nicks = await Promise.all(pages.map((p) => p.evaluate(() => localStorage.getItem("snack_nick"))));
    const boards = end.map((v) => JSON.stringify(v.raceBoard));
    const scoreOf = (v, nick) => (v.raceBoard || []).find((e) => e.nick === nick)?.score ?? 0;
    const ok =
      foreign.length === 0 &&
      boards[0] === boards[1] &&
      nicks.every((n) => scoreOf(end[0], n) === TAPS) &&
      local.every((v) => v.myTaps === TAPS);
    return { id: `run ${run}`, ok, foreignWebSockets: foreign, myTaps: local.map((v) => v.myTaps), boards: end.map((v) => v.raceBoard), ...(ok ? {} : { logs: logs.map((l) => l.slice(-40)) }) };
  } catch (e) {
    return { id: `run ${run}`, ok: false, error: String(e?.message ?? e), foreignWebSockets: foreign, logs: logs.map((l) => l.slice(-40)) };
  } finally {
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  }
}

const results = [];
try {
  for (let r = 1; r <= RUNS; r++) {
    const res = await runOnce(r);
    results.push(res);
    console.error(`${res.ok ? "✅" : "❌"} ${res.id} ${res.error ?? ""} ${JSON.stringify(res.boards ?? "")}`);
    await sleep(500);
  }
} finally {
  stopPreview();
  await broker.close();
}
if (!results.length) console.error(previewLog);
runGate("serverless-oracle", results, (r) => r.ok, ({ passed, total }) => `serverless-oracle (tap-battle, 2 browsers, local broker${LOSSY ? " lossy" : ""}): ${passed}/${total} pass`);
process.exit(process.exitCode ?? 0);
