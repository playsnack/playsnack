// #213 end to end: someone leaves a room — does everyone else's count go down? Real browsers
// (Playwright Chromium) + the player (vite dev) + an in-process edge hub (the same room code the
// Durable Object runs). Three devices per case (A watches, B stays, C leaves) in a fresh friends room:
//   close      C's tab is closed
//   hibclose   the room was idle long enough to hibernate (the DO evicted, as on Cloudflare), then C's
//              tab is closed — before the fix the woken room never told anyone (the count stayed)
//   home       C taps ← 홈
//   reload     C reloads (stays in the room: no leave, or only a short blip)
//   hidden     C's page goes to the background and is frozen (as iOS does) and never comes back
//   offline    C's network is cut while on screen (context.setOffline) and never comes back —
//              reported only: nothing reaches the room until the socket closes (needs #142's ping)
// For each: how long until A sees 👥 2명 (the chip) and 참가자 2명 (the roster), and the room's
// own roster. --report prints the timings only (no pass/fail): the reproduction for the issue.
// Ports 4992 (hub) / 4993 (vite) — not shared with other gates (HUB_PORT / VITE_PORT override).
//   node snack-player/scripts/room-leave-e2e.mjs [--report] [--only close,home]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startEdgeHub } from "../../packages/snack-room/tools/edgeHub.js";

const HUB_PORT = Number(process.env.HUB_PORT || 4992);
const VITE_PORT = Number(process.env.VITE_PORT || 4993);
const REPORT = process.argv.includes("--report");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const PLAYER = fileURLToPath(new URL("..", import.meta.url));
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : REPORT ? "--  " : "FAIL"} ${what}`);
  if (!ok && !REPORT) fails.push(what);
};
const until = async (fn, ms = 8000, step = 100) => {
  for (let t = 0; t < ms; t += step) {
    if (await fn()) return true;
    await sleep(step);
  }
  return Boolean(await fn());
};

const hub = await startEdgeHub({ port: HUB_PORT });
await new Promise((res, rej) => spawn("node", ["scripts/sync-data.mjs"], { cwd: PLAYER, stdio: "ignore" }).on("exit", (c) => (c ? rej(new Error("sync-data")) : res())));
const vite = spawn("pnpm", ["exec", "vite", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: PLAYER,
  env: { ...process.env, VITE_ROOM_URL: hub.url },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteOut = "";
vite.stdout.on("data", (d) => (viteOut += d));
vite.stderr.on("data", (d) => (viteOut += d));
const BASE = `http://127.0.0.1:${VITE_PORT}/`;
if (!(await until(async () => (await fetch(BASE).catch(() => null))?.ok, 30000))) {
  console.error(viteOut);
  throw new Error("vite did not start");
}

const browser = await chromium.launch();
// A hidden/visible switch (document.visibilityState is read-only in a test browser).
const INIT = () => {
  let hidden = false;
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => hidden });
  globalThis.__setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event("visibilitychange"));
  };
};
async function device(path, nick) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((n) => {
    try {
      localStorage.setItem("snack_nick", n);
    } catch {}
  }, nick);
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  await page.goto(BASE + path);
  await page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 20000 });
  return { ctx, page };
}
const roster = (p) => p.evaluate(() => globalThis.__snackRuntime?.vars?.roster ?? null);
const chipN = async (p) => Number(/👥\s*(\d+)/.exec((await p.locator("[aria-live=polite]").first().textContent().catch(() => "")) ?? "")?.[1] ?? NaN);
const roomRoster = (room) => hub.room(room)?.core.engine?._state.roster.size ?? 0;
const inMessages = (room) => hub.history().get(`room:${room}`)?.in ?? 0;

/** A, B, C in a fresh friends room; `leave(C)` is the case; → timings as A sees them. */
async function scenario(name, leave, { waitMs = 8000, expectLeave = true, before = null } = {}) {
  const room = `tpl-tap-battle~${code()}`;
  const path = `p/tpl-tap-battle?room=${room.split("~")[1]}`;
  const A = await device(path, "에이");
  const B = await device(path, "비");
  const C = await device(path, "씨");
  if (!(await until(async () => (await roster(A.page))?.length === 3 && (await chipN(A.page)) === 3, 15000))) {
    check(false, `${name}: three in the room first`);
    return;
  }
  await sleep(300);
  if (before) await before(room);
  const msgs0 = inMessages(room);
  const t0 = Date.now();
  let chipAt = null;
  let rosterAt = null;
  let serverAt = null;
  let minRoster = 3;
  let backAt = null; // reload: back to 3 after the blip
  const watch = (async () => {
    while (Date.now() - t0 < waitMs) {
      const [r, c] = [(await roster(A.page))?.length ?? 0, await chipN(A.page)];
      minRoster = Math.min(minRoster, r);
      if (chipAt == null && c === 2) chipAt = Date.now() - t0;
      if (rosterAt == null && r === 2) rosterAt = Date.now() - t0;
      if (serverAt == null && roomRoster(room) === 2) serverAt = Date.now() - t0;
      if (rosterAt != null && backAt == null && r === 3) backAt = Date.now() - t0;
      if (expectLeave && chipAt != null && rosterAt != null && serverAt != null) break;
      await sleep(50);
    }
  })();
  await leave(C);
  await watch;
  const msgs = inMessages(room) - msgs0;
  const ms = (x) => (x == null ? "never" : `${x} ms`);
  console.log(`  ${name}: A's chip → 2명 ${ms(chipAt)} · A's roster → 2 ${ms(rosterAt)} · room roster → 2 ${ms(serverAt)} · messages into the room ${msgs}`);
  if (!expectLeave) console.log(`  ${name}: A's roster min ${minRoster}${rosterAt != null ? `, back to 3 after ${backAt == null ? "never" : `${backAt - rosterAt} ms`}` : ""} · A's chip at the end ${await chipN(A.page)}명`);
  const out = { chipAt, rosterAt, serverAt, minRoster, backAt, msgs, A, B, C, room, endChip: await chipN(A.page), endRoster: (await roster(A.page))?.length };
  for (const d of [A, B]) await d.ctx.close().catch(() => {});
  await C.ctx.close().catch(() => {});
  return out;
}

const cases = {
  // (offline is slow — 45 s — and only reported)
  async close() {
    const r = await scenario("close", (C) => C.page.close({ runBeforeUnload: true }));
    check(r && r.chipAt != null && r.chipAt <= 2000 && r.rosterAt != null && r.rosterAt <= 2000, "close: everyone's count goes down within 2 s");
  },
  async hibclose() {
    const r = await scenario("hibclose", (C) => C.page.close({ runBeforeUnload: true }), {
      before: async (room) => {
        await sleep(1500); // idle: the snapshot is written
        hub.room(room).core.forget(); // the Durable Object hibernates (memory gone, sockets kept)
      },
    });
    check(r && r.chipAt != null && r.chipAt <= 2000 && r.rosterAt != null && r.rosterAt <= 2000, "close after a hibernation: everyone's count goes down within 2 s");
  },
  async home() {
    const r = await scenario("home", (C) => C.page.getByRole("button", { name: "홈으로" }).first().click());
    check(r && r.chipAt != null && r.chipAt <= 2000 && r.rosterAt != null && r.rosterAt <= 2000, "← 홈: everyone's count goes down within 2 s");
  },
  async reload() {
    const r = await scenario("reload", (C) => C.page.reload(), { waitMs: 6000, expectLeave: false });
    check(r && r.endRoster === 3 && r.endChip === 3, `reload: still 3 afterwards (roster ${r?.endRoster}, chip ${r?.endChip})`);
    check(r && (r.rosterAt == null || (r.backAt != null && r.backAt - r.rosterAt <= 1500)), `reload: no leave, or a blip of at most 1.5 s (${r?.rosterAt == null ? "none" : `${r.backAt - r.rosterAt} ms`})`);
  },
  async hidden() {
    // To the background (the share sheet, another app), frozen like iOS, and never back.
    const r = await scenario(
      "hidden",
      async (C) => {
        await C.page.evaluate(() => globalThis.__setHidden(true));
        await sleep(200);
        const cdp = await C.ctx.newCDPSession(C.page);
        await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      },
      { waitMs: 45000 },
    );
    check(r && r.rosterAt != null && r.rosterAt >= 3000 && r.rosterAt <= 40000, `hidden & frozen: gone within the grace (${r?.rosterAt} ms), not at once`);
  },
  async offline() {
    const r = await scenario("offline", (C) => C.ctx.setOffline(true), { waitMs: 45000 });
    console.log(`info offline on screen: ${r?.rosterAt == null ? "not seen as gone (known gap — needs a keepalive, #142)" : `gone after ${r.rosterAt} ms`}`);
  },
};
try {
  for (const [k, fn] of Object.entries(cases)) if (!ONLY || ONLY.includes(k)) await fn();
} finally {
  await browser.close();
  vite.kill();
  await hub.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall ok");
process.exit(fails.length ? 1 : 0);
