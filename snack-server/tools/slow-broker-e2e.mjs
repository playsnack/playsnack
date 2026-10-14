// Joining a friends room through a SLOW broker, end to end: the real serverless player
// (built against a local broker), real browsers, and a local broker that swallows CONNECTs
// (no CONNACK → the client's "connack timeout" — what the public broker did live on 2026-10-14).
//   1. healthy broker: two browsers meet ("👥 2명"), no slow notice (baseline time)
//   2. each browser's first 2 CONNECTs swallowed: both keep trying, the slow notice shows
//      after ~6 s with the seconds and "혼자 하기", no failed sheet, both reach "👥 2명"
//   3. broker never answers: still "connecting" (slow notice) at 40 s, the failed sheet only
//      at the deadline (~42–47 s); broker healthy again → "다시 시도" joins ("👥 1명")
// Usage: node snack-server/tools/slow-broker-e2e.mjs [--skip-build] [--shots <dir>] [--skip-never]
// Ports: SLOW_E2E_PORT (else ORACLE_PREVIEW_PORT, else 4542) for the page, SLOW_E2E_BROKER_PORT (else ORACLE_BROKER_PORT, else 4541).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startLocalBroker } from "../../packages/snack-room/tools/localBroker.js";
import { runGate } from "./_gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");
const SKIP_NEVER = argv.includes("--skip-never");
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PORT = Number(process.env.SLOW_E2E_PORT || process.env.ORACLE_PREVIEW_PORT || 4542);
const BROKER_PORT = Number(process.env.SLOW_E2E_BROKER_PORT || process.env.ORACLE_BROKER_PORT || 4541);
const OUT = join(tmpdir(), "snack-slow-broker-e2e-dist");
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "tpl-tap-battle";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const linkFor = (c) => `${BASE}/p/${SLUG}?room=${c}`;
const SLOW_RE = /연결이 느려요 · 계속 시도하는 중… (\d+)초/;
const FAILED = "같이 하는 방에 못 들어갔어요";

let broker = await startLocalBroker({ port: BROKER_PORT });
const brokerUrl = broker.url;
const restartBroker = async (opts) => {
  await broker.close();
  broker = await startLocalBroker({ port: BROKER_PORT, ...opts });
};
if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
  const env = { ...process.env, VITE_BROKER_URL: brokerUrl };
  delete env.VITE_SERVER_URL;
  const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
  if (b.status !== 0) {
    console.error(b.stdout, b.stderr);
    await broker.close();
    runGate("slow-broker-e2e", [{ id: "build", ok: false }], (r) => r.ok);
    process.exit(1);
  }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/room-result" && req.method === "GET") return res.writeHead(404).end();
    return res.writeHead(204).end(); // telemetry etc.: not part of this check
  }
  let file = join(OUT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(OUT) || !existsSync(file) || !extname(file)) file = join(OUT, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const launch = () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const browsers = [];

/** Opens the link and samples the shell once per 250 ms: when the slow notice / failed sheet / N명 first showed. */
async function open(nick, link) {
  const browser = await launch();
  browsers.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript((n) => localStorage.setItem("snack_nick", n), nick);
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(link, { waitUntil: "load" });
  const seen = { slowAt: null, slowText: null, slowSolo: null, failedAt: null, people: {} };
  let stop = false;
  const sample = async () => {
    while (!stop) {
      const at = Date.now() - t0;
      const body = await page.locator("body").innerText().catch(() => "");
      const m = body.match(SLOW_RE);
      if (m) {
        if (seen.slowAt === null) {
          seen.slowAt = at;
          seen.slowSolo = (await page.locator('[role="status"] button').allInnerTexts().catch(() => [])).join(" | ");
        }
        seen.slowText = m[0];
      }
      if (body.includes(FAILED) && seen.failedAt === null) seen.failedAt = at;
      const p = body.match(/👥 (\d+)명/);
      if (p && seen.people[p[1]] === undefined) seen.people[p[1]] = at;
      await sleep(250);
    }
  };
  const loop = sample();
  return { page, seen, t0, end: async () => ((stop = true), await loop) };
}
async function waitFor(fn, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  return fn();
}

const results = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${JSON.stringify(extra)}`);
};
try {
  // 1. Baseline: a healthy broker.
  {
    const c = code();
    const [A, B] = await Promise.all([open("빠른 앨리스", linkFor(c)), open("빠른 밥", linkFor(c))]);
    const ok = await waitFor(() => A.seen.people["2"] !== undefined && B.seen.people["2"] !== undefined, 20000);
    await A.end();
    await B.end();
    step("healthy broker: both see 2명, no slow notice", ok && A.seen.slowAt === null && B.seen.slowAt === null && A.seen.failedAt === null, {
      A_2명_ms: A.seen.people["2"], B_2명_ms: B.seen.people["2"], connects: broker.stats.connects,
    });
    await Promise.all(browsers.splice(0).map((b) => b.close()));
  }

  // 2. Each browser's first 2 CONNECTs get no CONNACK.
  {
    await restartBroker({ dropConnectsPerClient: 2 });
    const c = code();
    const [A, B] = await Promise.all([open("느린 앨리스", linkFor(c)), open("느린 밥", linkFor(c))]);
    let shot = false;
    const ok = await waitFor(async () => {
      if (SHOTS && !shot && A.seen.slowAt !== null && Date.now() - A.t0 > 12000) {
        shot = true;
        await A.page.screenshot({ path: join(SHOTS, "1-slow-notice.png") });
      }
      return A.seen.people["2"] !== undefined && B.seen.people["2"] !== undefined;
    }, 50000);
    if (SHOTS) await A.page.screenshot({ path: join(SHOTS, "2-joined.png") });
    await A.end();
    await B.end();
    const slowOk = [A, B].every((p) => p.seen.slowAt !== null && p.seen.slowAt >= 5500 && p.seen.slowAt < 9000 && /혼자/.test(p.seen.slowSolo ?? ""));
    step("2 swallowed CONNECTs each: slow notice after ~6 s (with 혼자 하기), no failed sheet, both see 2명", ok && slowOk && A.seen.failedAt === null && B.seen.failedAt === null && broker.stats.droppedConnects === 4, {
      A: { slowNoticeAt: A.seen.slowAt, lastSlowText: A.seen.slowText, solo: A.seen.slowSolo, "2명_ms": A.seen.people["2"] },
      B: { slowNoticeAt: B.seen.slowAt, lastSlowText: B.seen.slowText, "2명_ms": B.seen.people["2"] },
      droppedConnects: broker.stats.droppedConnects, connects: broker.stats.connects,
    });
    await Promise.all(browsers.splice(0).map((b) => b.close()));
  }

  // 3. The broker never answers: failed only at the deadline; then "다시 시도" joins.
  if (!SKIP_NEVER) {
    await restartBroker({ dropConnects: 1e9 });
    const A = await open("기다리는 앨리스", linkFor(code()));
    await waitFor(() => Date.now() - A.t0 > 40000, 41000);
    const at40 = { failed: A.seen.failedAt, slowAt: A.seen.slowAt, text: A.seen.slowText };
    const failed = await waitFor(() => A.seen.failedAt !== null, 15000);
    if (SHOTS) await A.page.screenshot({ path: join(SHOTS, "3-failed.png") });
    step("broker never answers: still trying at 40 s, failed sheet only at the deadline", at40.failed === null && at40.slowAt !== null && failed && A.seen.failedAt >= 42000 && A.seen.failedAt <= 50000, {
      at40s: at40, failedAt: A.seen.failedAt, tries: broker.stats.connects,
    });
    await restartBroker({});
    const before = Date.now() - A.t0;
    await A.page.getByRole("button", { name: "다시 시도" }).click();
    const joined = await waitFor(() => A.seen.people["1"] !== undefined && A.seen.people["1"] > before, 15000);
    await A.end();
    step("broker healthy again: 다시 시도 → joins (1명)", joined, { joinedMsAfterRetry: (A.seen.people["1"] ?? NaN) - before });
  }
} catch (e) {
  step("run", false, { error: String(e?.message ?? e) });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await broker.close();
}
runGate("slow-broker-e2e", results, (r) => r.ok);
process.exit(process.exitCode ?? 0);
