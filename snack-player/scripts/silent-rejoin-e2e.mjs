// #115 end to end: a player in a friends room goes to the share sheet / KakaoTalk (the page
// is hidden) and comes back. Real browser (Playwright Chromium) + the player (vite dev) + an
// in-process edge hub (the same room code the Durable Object runs). Checked:
//   A  the socket is cut while the page is hidden (as iOS does) → back on screen: no failure
//      sheet, the player is in the friend's roster exactly once, the room chip says 2명
//   B  a socket still "open" after a long background (iOS froze it, no close) is replaced on
//      return — the room takes the same seat over (still once in the roster, not a spectator)
//   C  reconnect tries that keep failing on screen for > 1.5 s show "다시 연결 중…" in the room
//      chip (not the failure sheet), and it goes back to 👥 N명 once in
// What this cannot show: real iOS backgrounding (timer freezing, socket teardown timing) —
// Chromium's hidden state is emulated by overriding document.visibilityState.
// Ports 4641 (hub) / 4642 (vite) — not shared with other gates.
//   node snack-player/scripts/silent-rejoin-e2e.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startEdgeHub } from "../../packages/snack-room/tools/edgeHub.js";

const HUB_PORT = Number(process.env.HUB_PORT || 4641);
const VITE_PORT = Number(process.env.VITE_PORT || 4642);
const PLAYER = fileURLToPath(new URL("..", import.meta.url));
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};
const until = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await sleep(100);
  }
  return Boolean(await fn());
};

const hub = await startEdgeHub({ port: HUB_PORT });
// The dev server serves the templates from public/data (the "dev" script syncs them first).
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
// Every page: a hidden/visible switch (document.visibilityState is read-only), and a watch
// that remembers whether the failure sheet was ever on screen, even for a moment.
const INIT = () => {
  let hidden = false;
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => hidden });
  globalThis.__setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  // __blockWs: new sockets go nowhere (a dead network) — the room is not touched.
  const RealWS = WebSocket;
  globalThis.__blocked = 0;
  globalThis.WebSocket = class extends RealWS {
    constructor(url, p) {
      super(globalThis.__blockWs ? (globalThis.__blocked++, "ws://127.0.0.1:9/") : url, p);
    }
  };
  globalThis.__failedSeen = 0;
  globalThis.__chipTexts = new Set();
  new MutationObserver(() => {
    if (document.body?.textContent?.includes("같이 하는 방에 못 들어갔어요")) globalThis.__failedSeen++;
    for (const el of document.querySelectorAll("[aria-live=polite]")) globalThis.__chipTexts.add(el.textContent.trim());
  }).observe(document, { subtree: true, childList: true, characterData: true });
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
  page.on("pageerror", (e) => check(false, `${nick}: page error ${e.message}`));
  await page.goto(BASE + path);
  await page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 20000 });
  return { ctx, page };
}
const roster = (p) => p.evaluate(() => globalThis.__snackRuntime?.vars?.roster ?? null);
const failedSeen = (p) => p.evaluate(() => globalThis.__failedSeen);
const chip = (p) => p.locator("[aria-live=polite]").first().textContent();
const mySockets = (room, anonId) => [...(hub.room(room)?.sockets ?? [])].filter((s) => s.state?.joined && s.state.anonId === anonId);

const room = `tpl-tap-battle~${code()}`;
const path = `p/tpl-tap-battle?room=${room.split("~")[1]}`;
const friend = await device(path, "친구");
const me = await device(path, "나");
check(await until(async () => (await roster(friend.page))?.length === 2), "both in the room");
const anon = await me.page.evaluate(() => localStorage.getItem("snack_anon"));
check(mySockets(room, anon).length === 1, `my seat in the room (anonId ${anon})`);

// A: the socket dies while the page is in the background
await me.page.evaluate(() => globalThis.__setHidden(true));
for (const s of mySockets(room, anon)) s.ws.terminate(); // iOS tears it down
await sleep(4000); // "in KakaoTalk"
check(await until(async () => (await roster(friend.page))?.length === 1, 3000), "A: meanwhile the room saw me go (the socket really closed)");
await me.page.evaluate(() => globalThis.__setHidden(false));
check(await until(async () => (await roster(friend.page))?.filter((n) => n === "나").length === 1), `A: back → in the friend's roster exactly once (${JSON.stringify(await roster(friend.page))})`);
check(await until(async () => (await chip(me.page))?.includes("2명")), `A: my room chip says 2명 (${await chip(me.page)})`);
check((await failedSeen(me.page)) === 0, "A: the failure sheet never showed");
check(mySockets(room, anon).length === 1, "A: one seat for this device");

// B: the socket survives the background (frozen, no close) → replaced on return, same seat
const before = mySockets(room, anon)[0];
await me.page.evaluate(() => globalThis.__setHidden(true));
await sleep(4000);
await me.page.evaluate(() => globalThis.__setHidden(false));
check(await until(async () => mySockets(room, anon).length === 1 && mySockets(room, anon)[0] !== before), "B: a fresh socket took the seat over");
const rosterB = [];
for (let i = 0; i < 10; i++) {
  rosterB.push((await roster(friend.page))?.length);
  await sleep(100);
}
check(rosterB.every((n) => n === 2), `B: the friend's roster stayed at 2 throughout (${rosterB})`);
check((await me.page.evaluate(() => globalThis.__snackRuntime?.vars?.iAmSpectator)) !== true, "B: not a spectator");
check((await failedSeen(me.page)) === 0, "B: the failure sheet never showed");

// C: on screen, the reconnect keeps failing for a few seconds → the quiet chip, then back in
await me.page.evaluate(() => (globalThis.__blockWs = true)); // every new socket fails (no network)
for (const s of mySockets(room, anon)) s.ws.terminate();
check(await until(async () => (await chip(me.page))?.includes("다시 연결 중"), 4000), `C: after 1.5 s the chip says "다시 연결 중…" (${await chip(me.page)}; ${await me.page.evaluate(() => globalThis.__blocked)} tries refused)`);
await me.page.screenshot({ path: process.env.SHOT || "/tmp/snack-silent-rejoin-reconnecting.png" });
await me.page.evaluate(() => (globalThis.__blockWs = false));
check(await until(async () => (await chip(me.page))?.includes("2명"), 10000), `C: back in → 👥 2명 (${await chip(me.page)})`);
check(await until(async () => (await roster(friend.page))?.filter((n) => n === "나").length === 1), "C: in the roster once");
check((await failedSeen(me.page)) === 0, "C: the failure sheet never showed");

await browser.close();
vite.kill();
await hub.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall ok");
process.exit(fails.length ? 1 : 0);
