// A deployed Cloudflare Pages build, end to end (docs/cloudflare-pages.md §verify):
//   1. the routes: /, /p/<slug>, /p/<slug>?room=<code>, /create, /stats → the app;
//      /data/bite/index.json → JSON; /api/ev GET → ok (+ which store); /api/room-result 404
//   2. ×N: two real browsers join a new friends room through the edge room server
//      (the WebSocket must go to the VITE_ROOM_URL host) — time from opening the link to
//      being in the room, per browser
//   3. a 1:1 default quiz with real taps to the result screen on both; a direct valid
//      POST /api/room-result answered 200 by the Pages Function (edge rooms do not post one)
// Automated: Playwright sets navigator.webdriver, so the player sends no telemetry (checked:
// no POST /api/ev leaves either browser) — these runs never reach the stats.
// Usage: node snack-server/tools/pages-e2e.mjs [https://test.playsnack.pages.dev] [--joins 5] [--room-host snack-room.playsnack.workers.dev]
import { chromium } from "playwright";
import { runGate } from "./_gate.mjs";

const argv = process.argv.slice(2);
const flag = (name, d) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : d);
const BASE = (argv.find((a) => /^https?:\/\//.test(a)) || "https://test.playsnack.pages.dev").replace(/\/$/, "");
const JOINS = Number(flag("--joins", 5));
const ROOM_HOST = flag("--room-host", "snack-room.playsnack.workers.dev");
const SLUG = "tpl-speed-trivia-score";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${JSON.stringify(extra)}`);
};

// 1. routes
const get = async (path) => {
  const r = await fetch(BASE + path);
  return { status: r.status, type: r.headers.get("content-type") || "", body: await r.text() };
};
for (const p of ["/", "/p/tpl-tap-battle", "/p/tpl-tap-battle?room=K7MNP2QRS4", "/create", "/stats"]) {
  const r = await get(p);
  step(`GET ${p} → app`, r.status === 200 && r.type.startsWith("text/html") && r.body.includes('<div id="root"'), { status: r.status });
}
{
  const r = await get("/data/bite/index.json");
  let n = 0;
  try {
    n = JSON.parse(r.body).length;
  } catch {}
  step("GET /data/bite/index.json → template list", r.status === 200 && n > 40, { status: r.status, templates: n });
}
{
  const r = await get("/api/ev");
  let j = {};
  try {
    j = JSON.parse(r.body);
  } catch {}
  step("GET /api/ev → Pages Function", r.status === 200 && j.ok === true && j.appsKnown > 40, { status: r.status, store: j.store, appsKnown: j.appsKnown, devicesCounting: j.devices?.counting });
}
{
  const r = await get(`/api/room-result?room=${encodeURIComponent(`${SLUG}~${code()}`)}`);
  step("GET /api/room-result (unknown room) → 404 from the Function", r.status === 404 && r.body.includes("not_found"), { status: r.status });
}

{
  // A valid save (the shape the mesh host sends) → 200 from the Function's POST path.
  const room = `${SLUG}~${code()}`;
  const sid = `PagesE2e${code()}${code()}`.slice(0, 20);
  const result = {
    v: 1, sid, endedAt: 1, title: "pages-e2e", about: "pages-e2e",
    board: [{ pid: "p1", nick: "앨리스", score: 880 }, { pid: "p2", nick: "밥", score: 0 }],
  };
  const r = await fetch(`${BASE}/api/room-result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room, sid, result }) });
  step("POST /api/room-result (valid save) → 200 from the Function", r.status === 200, { status: r.status, body: (await r.text()).slice(0, 120) });
}

// 2–3. browsers
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
const vars = (page) => page.evaluate(() => ({ phase: globalThis.__bite?.app.phase, ...globalThis.__bite?.app.vars }));
async function tapNode(page, re) {
  const t = (await page.evaluate(targets)).find((x) => re.test(String(x.name)));
  if (!t) return false;
  await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  return true;
}
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}
const net = { ws: new Set(), evPosts: 0, rrPosts: [] };
async function open(browser, nick, link, logs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript((n) => localStorage.setItem("snack_nick", n), nick);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && logs.push(`${nick}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${nick} pageerror: ${e.message}`));
  page.on("websocket", (ws) => net.ws.add(new URL(ws.url()).host));
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/ev")) net.evPosts++;
  });
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().includes("/api/room-result")) net.rrPosts.push(r.status());
  });
  const t0 = Date.now();
  await page.goto(link, { waitUntil: "load" });
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 20000 });
  return { page, t0, scene: Date.now() };
}
const inRoom = async (p, n) => ((await vars(p)).roster || []).length >= n;

const launch = () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const logs = [];
const joins = [];
const [bA, bB] = [await launch(), await launch()];
try {
  for (let i = 0; i < JOINS; i++) {
    const link = `${BASE}/p/${SLUG}?room=${code()}`;
    const A = await open(bA, "앨리스", link, logs);
    await waitFor(() => inRoom(A.page, 1), 20000, `A in room (${i + 1})`);
    const aMs = Date.now() - A.t0;
    const B = await open(bB, "밥", link, logs);
    await waitFor(async () => (await inRoom(B.page, 2)) && (await inRoom(A.page, 2)), 20000, `B joined (${i + 1})`);
    const bMs = Date.now() - B.t0;
    const bAfterLoad = Date.now() - B.scene;
    joins.push({ run: i + 1, hostOpenToRoomMs: aMs, guestOpenToRoomMs: bMs, guestAfterPageReadyMs: bAfterLoad });
    console.error(`  join ${i + 1}: host ${aMs} ms · guest ${bMs} ms (${bAfterLoad} ms after page ready)`);

    if (i === JOINS - 1) {
      // 1:1 default quiz to the result, real taps.
      if (!(await tapNode(A.page, /^startBtn$/))) throw new Error("no start button");
      const pick = { A: /^tile0$/, B: /^tile1$/ };
      await waitFor(async () => {
        for (const [name, p] of [["A", A.page], ["B", B.page]]) {
          const v = await vars(p);
          if (v.sessionPhase === "play" && v.roundAnswer < 0 && v.seenRound === v.roundIdx && v.myAnswerRound !== v.roundIdx) await tapNode(p, pick[name]);
        }
        return (await Promise.all([A.page, B.page].map(vars))).every((v) => v.sessionPhase === "result");
      }, 120000, "both reach the result");
      await sleep(2500);
      const board = (await vars(A.page)).raceBoard;
      step("1:1 quiz played to the result screen on both", Array.isArray(board) && board.length === 2, { board: (board || []).map((r) => [r.name ?? r.nick, r.score]) });
      // Edge rooms run the engine on the room server, which has no result hook (docs/edge-rooms.md
      // "엣지 방에는 결과 저장·통계 비콘이 원래 없음"): no browser posts the result. Checked as-is so
      // a change shows up; the POST path of the Function is checked directly below.
      step("edge room: no browser POSTs /api/room-result (known gap, docs/cloudflare-pages.md)", net.rrPosts.length === 0, { posts: net.rrPosts });
    }
    await Promise.all([A.page.context().close(), B.page.context().close()]);
  }
  step(`friend-room joins ×${JOINS} through the edge room server`, joins.length === JOINS, { joins });
  step(`rooms used only ${ROOM_HOST}`, net.ws.size > 0 && [...net.ws].every((h) => h === ROOM_HOST), { wsHosts: [...net.ws] });
  step("automated run: no telemetry POST left the browsers", net.evPosts === 0, { evPosts: net.evPosts });
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-20), joins });
} finally {
  await Promise.all([bA.close(), bB.close()].map((p) => p.catch(() => {})));
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
if (joins.length) console.error(`median: host ${med(joins.map((j) => j.hostOpenToRoomMs))} ms · guest ${med(joins.map((j) => j.guestOpenToRoomMs))} ms · guest after page ready ${med(joins.map((j) => j.guestAfterPageReadyMs))} ms`);
runGate("pages-e2e", results, (r) => r.ok);
process.exit(process.exitCode ?? 0);
