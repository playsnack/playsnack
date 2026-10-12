// Screenshots (390×844) of the shell states around the play canvas, for a
// human to look at: home, a solo app, a together app joining / failing to
// join its room, a bad link, a merged (redirected) link, a network error.
//   node snack-player/scripts/shell-shots.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = (process.argv[2] || "http://localhost:4178/").replace(/\/?$/, "/");
const OUT = process.argv[3] || "/tmp/snack-shell-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const shot = async (name, hash, { before, wait = 2500, after } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("snack_nick", "스냅봇");
    } catch {}
  });
  const p = await ctx.newPage();
  const sockets = [];
  p.on("websocket", (ws) => sockets.push(ws.url()));
  const chunks = [];
  p.on("request", (r) => chunks.push(r.url()));
  if (before) await before(p);
  await p.goto(BASE + hash);
  await p.waitForTimeout(wait);
  const info = after ? await after(p) : "";
  await p.screenshot({ path: `${OUT}/${name}.png` });
  const mqtt = chunks.some((u) => /mqttBus|meshClient/.test(u));
  console.log(`${name.padEnd(18)} url=${p.url().replace(BASE, "")}  mqttChunk=${mqtt}  sockets=${sockets.length} ${info}`);
  await ctx.close();
};

await shot("home", "");
await shot("solo-quiz-ox", "#/p/tpl-quiz-ox", { wait: 4000 });
await shot("multi-connecting", "#/p/tpl-tap-battle", { wait: 1200 });
await shot("multi-connected", "#/p/tpl-tap-battle", { wait: 9000 });
// The room's broker is unreachable → after the silence timeout the sheet shows.
await shot("multi-failed", "#/p/tpl-tap-battle", {
  before: (p) => p.routeWebSocket(/.*/, (ws) => ws.close()),
  wait: 17000,
});
await shot("bad-link", "#/p/nope-123");
await shot("merged-redirect", "#/p/tpl-race-tap", { wait: 4000 });
await shot("network-error", "#/p/tpl-quiz-ox", {
  before: (p) => p.route(/\.bite\.json/, (r) => r.abort("internetdisconnected")),
});
await browser.close();
console.log("→", OUT);
