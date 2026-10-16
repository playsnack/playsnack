// Who starts a game, end to end (#135 / #136): the real player built for edge rooms
// (VITE_ROOM_URL), three real browsers, the Node edge hub (the same game.js / core.js the
// Durable Object runs) and a tiny static server.
//   1. 친구 방: A opens a public link (chip "🌐 공개방", subtitle "🌐 누구나 함께하는 방 …", no 방장 #143)
//      and taps the chip → a friends room ("🤝 친구방"), A is the host (방장); the top row fits at 360 / 390.
//      B opens the
//      invite link → A’s chip asks "친구방에서 나갈까요?" (stays); B has no 시작하기, "방장이 시작하길
//      기다리는 중 · 방장 · A". A starts → both play; the chip is hidden in countdown / play, back on the result.
//   1b. alone in a friends room the chip goes straight back to the public room (no sheet).
//   2. 공개 방 (#141: 2명부터): C opens /p/<slug> alone → "한 명 더 오면 시작해요" · "링크를 친구에게
//      보내도 돼요", nothing counts down; D comes → same room, both "<n>초 뒤 시작 · 2명"; nobody
//      presses anything → the game starts by itself for both.
//   3. 늦게 온 사람: E opens the same link mid-game → moved to `<slug>.g2` (not a spectator), alone
//      there it waits; F comes mid-game too → moved to the same `.g2` → its countdown → E and F play.
//   4. 혼자 옮겨진 사람: G is moved to `.g2` and stays alone; the link's room's game ends; H opens the
//      link → the link's room (not moved); G's client goes back there (LONE_RETURN_MS) → G and H play.
//   5. (#212) E and F's game ends: the result stays (10 s, no countdown); F taps 한 판 더 → both count down and play.
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
// Every text line on the canvas now (the renderer's scene).
const allTexts = () => {
  const out = [];
  const walk = (inst) => {
    if (inst.kind === "text" && inst.content != null && String(inst.content).trim()) out.push(String(inst.content));
    inst.children.forEach(walk);
  };
  walk(globalThis.__bite.scene.root);
  return out;
};
const chipText = async (page) => ((await page.getByTestId("room-type-chip").textContent().catch(() => "")) ?? "").trim();
// The top row's boxes (CSS px): 홈, the room-type chip, 🔗 초대, QR, the people chip.
const topRow = () => {
  const r = (el) => (el ? (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(el.getBoundingClientRect()) : null);
  const people = [...document.querySelectorAll('[aria-live="polite"]')].find((e) => /명|방에|연결/.test(e.textContent ?? ""));
  return {
    home: r(document.querySelector('[aria-label="홈으로"]')),
    chip: r(document.querySelector('[data-testid="room-type-chip"]')),
    invite: r(document.querySelector('[aria-label="친구 초대 링크 보내기"]')),
    qr: r(document.querySelector('[aria-label="QR 코드로 초대하기"]')),
    people: r(people),
  };
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
/** A screenshot under its own name (no "rooms-" prefix). */
const shotAs = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const results = [];
const logs = [];
const step = (id, ok, extra = {}) => {
  results.push({ id, ok, ...extra });
  console.error(`${ok ? "✅" : "❌"} ${id} ${extra.error ?? ""}`);
};
const browsers = [];
try {
  const [b1, b2, b3] = [await launch(), await launch(), await launch()]; // (b1 also hosts C, then F)
  browsers.push(b1, b2, b3);

  // ── 1. friends room: the creator hosts (#143: made from the room-type chip) ──
  const A = await open(b1, "앨리스", `${BASE}/p/${FRIENDS_SLUG}`, logs);
  await waitFor(async () => (await vars(A)).roomMode === "auto", 15000, "A in the public room");
  await sleep(400);
  const pubChip = await chipText(A);
  const pubSub = (await A.evaluate(allTexts)).find((t) => /누구나 함께하는 방/.test(t));
  step("#143 public room: the top-row chip says 🌐 공개방; the lobby subtitle '🌐 누구나 함께하는 방 · 2명 모이면 시작'; no 방장 anywhere",
    /🌐\s*공개방/.test(pubChip) && pubSub === "🌐 누구나 함께하는 방 · 2명 모이면 시작" && !(await A.evaluate(allTexts)).some((t) => /방장/.test(t)) && !/방장/.test(await A.evaluate(() => document.body.innerText)),
    { pubChip, pubSub });
  await shotAs(A, "chip-public");
  await A.getByTestId("room-type-chip").click();
  await waitFor(async () => /[?&]room=/.test(A.url()) && (await vars(A)).iAmHost === true, 15000, "A made a friends room and hosts it");
  await waitFor(async () => (await vars(A)).roomMode === "host", 10000, "A's friends room says host");
  await sleep(400);
  const frChip = await chipText(A);
  const frSub = (await A.evaluate(allTexts)).find((t) => /초대받은 친구만/.test(t));
  step("#143 chip tap in the public room → a new friends room (host); chip 🤝 친구방; subtitle '🤝 초대받은 친구만 들어오는 방 · 방장이 시작'",
    /🤝\s*친구방/.test(frChip) && frSub === "🤝 초대받은 친구만 들어오는 방 · 방장이 시작", { frChip, frSub });
  await shotAs(A, "chip-friends");
  // the top row fits beside the people chip at 360 and 390 px (chip · 🔗 초대 · QR | 👥 n명)
  const rows = [];
  for (const [w, h] of [[360, 640], [390, 844]]) {
    await A.setViewportSize({ width: w, height: h });
    await sleep(300);
    rows.push({ w, ...(await A.evaluate(topRow)) });
  }
  await A.setViewportSize({ width: 390, height: 844 });
  step("#143 friends lobby top row: 홈 · 🤝 친구방 · 🔗 초대 · QR · 👥 — no overlaps at 360 / 390 px",
    rows.every((r) => r.home && r.chip && r.invite && r.qr && r.people && r.home.right <= r.chip.left && r.chip.right <= r.invite.left && r.invite.right <= r.qr.left && r.qr.right + 4 <= r.people.left),
    { rows });
  const invite = A.url();
  const B = await open(b2, "밥", invite, logs);
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => (v.roster || []).length === 2), 15000, "both in the friends room");
  await sleep(500);
  // with a friend in: the chip asks first; "친구방에 있기" keeps everything as it was
  await A.getByTestId("room-type-chip").click();
  const sheet = A.getByTestId("leave-friends");
  await sheet.waitFor({ state: "visible", timeout: 5000 });
  const sheetText = (await sheet.textContent()) ?? "";
  await shotAs(A, "chip-confirm");
  await sheet.getByRole("button", { name: "친구방에 있기" }).click();
  await sheet.waitFor({ state: "detached", timeout: 5000 });
  step("#143 friends room with a friend: chip → '친구방에서 나갈까요?' first; '친구방에 있기' stays (same link, still 2)",
    /친구방에서 나갈까요/.test(sheetText) && /공개방으로 가기/.test(sheetText) && A.url() === invite && (await vars(A)).roster?.length === 2, { sheetText });
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
  await waitFor(async () => (await vars(A)).sessionPhase === "countdown" || (await vars(A)).sessionPhase === "play", 15000, "the countdown");
  const chipInCountdown = await A.getByTestId("room-type-chip").count();
  await waitFor(async () => (await Promise.all([A, B].map(vars))).every((v) => v.sessionPhase === "play"), 15000, "both play after the host started");
  step("friends room: the host started → both play", true);
  await sleep(300);
  const chipInPlay = (await A.getByTestId("room-type-chip").count()) + (await B.getByTestId("room-type-chip").count());
  step("#143 the room-type chip is hidden during the 3·2·1 countdown and play", chipInCountdown === 0 && chipInPlay === 0, { chipInCountdown, chipInPlay });
  await shotAs(A, "chip-hidden-play");
  await waitFor(async () => ["result", "lobby"].includes((await vars(A)).sessionPhase), 25000, "the result");
  await A.getByTestId("room-type-chip").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  step("#143 the chip is back on the result screen", (await A.getByTestId("room-type-chip").count()) === 1 && /친구방/.test(await chipText(A)));
  await A.context().close();
  await B.context().close();

  // ── 1b. #143 friends room alone → the chip goes straight back to the public room (no sheet) ──
  const Z = await open(b3, "제트", `${BASE}/p/${FRIENDS_SLUG}`, logs);
  await waitFor(async () => (await vars(Z)).roomMode === "auto", 15000, "Z in the public room");
  await Z.getByTestId("room-type-chip").click();
  await waitFor(async () => /[?&]room=/.test(Z.url()) && (await vars(Z)).iAmHost === true, 15000, "Z hosts a friends room");
  await Z.getByTestId("room-type-chip").click();
  await waitFor(async () => !/[?&]room=/.test(Z.url()), 5000, "Z back on the public link");
  await waitFor(async () => (await vars(Z)).roomMode === "auto", 15000, "Z in the public room again");
  step("#143 friends room alone: chip → back to the public room at once (no sheet), chip 🌐 공개방 again",
    (await Z.getByTestId("leave-friends").count()) === 0 && new URL(Z.url()).pathname === `/p/${FRIENDS_SLUG}` && /공개방/.test(await chipText(Z)));
  await Z.context().close();

  // ── 2. public room: auto-start, only with 2+ (#141) ──
  const C = await open(b1, "캐럴", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => (await vars(C)).roomMode === "auto" && (await C.evaluate(texts)).startWaitMain === "한 명 더 오면 시작해요", 15000, "C alone sees the waiting note");
  await sleep(3000); // alone a while: nothing counts down
  const vc = await vars(C);
  const tc = await C.evaluate(texts);
  step("public room alone: '한 명 더 오면 시작해요' · '링크를 친구에게 보내도 돼요', no countdown, no 시작하기", vc.autoStartIn === 0 && vc.sessionPhase !== "countdown" && tc.startWaitMain === "한 명 더 오면 시작해요" && tc.startWaitSub === "링크를 친구에게 보내도 돼요" && !(await hasTarget(C, "startBtn")), { main: tc.startWaitMain, sub: tc.startWaitSub, autoStartIn: vc.autoStartIn, phase: vc.sessionPhase });
  await shot(C, "public-alone-waiting");
  const D = await open(b2, "데이브", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => (await Promise.all([C, D].map((p) => p.evaluate(texts)))).every((t) => /^\d+초 뒤 시작 · 2명$/.test(t.startWaitMain ?? "")), 10000, "C and D see '<n>초 뒤 시작 · 2명'");
  const [lc, ld] = (await Promise.all([C, D].map(vars))).map((v) => v.autoStartIn);
  step("public room: the 2nd person (D) starts the countdown for both — '<n>초 뒤 시작 · 2명', no 시작하기", lc > 0 && ld > 0 && Math.abs(lc - ld) <= 1 && !(await hasTarget(C, "startBtn")) && !(await hasTarget(D, "startBtn")), { autoStartIn: [lc, ld], text: (await D.evaluate(texts)).startWaitMain });
  await shot(D, "public-countdown-2");
  await shot(C, "public-countdown");
  await waitFor(async () => (await Promise.all([C, D].map(vars))).every((v) => v.sessionPhase === "play"), 20000, "the game started by itself");
  const spectating = (await Promise.all([C, D].map(vars))).some((v) => v.iAmSpectator === true);
  step("public room: started by itself — both play, nobody pressed start", !spectating);

  // ── 3. late arrivals: moved to the next room; the first waits there, the second starts it ──
  const E = await open(b3, "에린", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  const g2id = `${PUBLIC_SLUG}.g2`;
  await waitFor(async () => (await vars(E)).roomMode === "auto" && (await vars(E)).roster?.join() === "에린", 15000, "E in the next room's lobby");
  await sleep(2000);
  const ve = await vars(E);
  const te = await E.evaluate(texts);
  step("late arrival: moved to the next room, alone there it waits ('한 명 더 오면 시작해요'), not a spectator", ve.iAmSpectator !== true && ve.autoStartIn === 0 && ve.sessionPhase !== "countdown" && te.startWaitMain === "한 명 더 오면 시작해요" && Boolean(hub.room(g2id)?.sockets.size) && (hub.history().get(`room:${PUBLIC_SLUG}`)?.moved ?? 0) >= 1, { roster: ve.roster, autoStartIn: ve.autoStartIn, text: te.startWaitMain, g2Sockets: hub.room(g2id)?.sockets.size });
  await shot(E, "late-moved-waiting");
  step("public room: C / D unaffected (still 2, still playing)", (await vars(C)).roster?.length === 2 && (await vars(C)).sessionPhase === "play");
  const F = await open(b1, "프랭크", `${BASE}/p/${PUBLIC_SLUG}`, logs);
  await waitFor(async () => (await Promise.all([E, F].map(vars))).every((v) => (v.roster || []).length === 2 && v.autoStartIn > 0), 15000, "F moved to the same next room → countdown for both");
  const tf = await F.evaluate(texts);
  step("late arrival 2: moved to the same next room — the 2nd mover starts its countdown ('· 2명')", (hub.history().get(`room:${PUBLIC_SLUG}`)?.moved ?? 0) >= 2 && /^\d+초 뒤 시작 · 2명$/.test(tf.startWaitMain ?? ""), { text: tf.startWaitMain, moved: hub.history().get(`room:${PUBLIC_SLUG}`)?.moved });
  await shot(F, "late-moved-countdown");
  await waitFor(async () => (await Promise.all([E, F].map(vars))).every((v) => v.sessionPhase === "play"), 20000, "E and F play in the next room");
  step("late arrivals: the next room started by itself → E and F play", (await Promise.all([E, F].map(vars))).every((v) => v.iAmSpectator !== true));
  await shot(E, "late-moved-play");

  // ── 3b. #212: after the game the result stays — no automatic next game; anyone's 한 판 더 → lobby + countdown ──
  await waitFor(async () => (await Promise.all([E, F].map(vars))).every((v) => v.sessionPhase === "result"), 30000, "E and F see the result");
  await sleep(10000); // past the old 8 s hold
  const [re, rf] = await Promise.all([E, F].map(vars));
  step("result stays (#212): 10 s later still the result for both, no countdown", re.sessionPhase === "result" && rf.sessionPhase === "result" && re.autoStartIn === 0 && hub.room(g2id).core.engine._state.session.timers.length === 0, { phases: [re.sessionPhase, rf.sessionPhase], timers: hub.room(g2id).core.engine._state.session.timers.length });
  step("result: everyone in a public room has 한 판 더", (await hasTarget(E, "againBtn")) && (await hasTarget(F, "againBtn")) && (await E.evaluate(texts)).againWaitMain === undefined);
  await shot(F, "result-one-more");
  await tapNode(F, "againBtn");
  await waitFor(async () => (await Promise.all([E, F].map(vars))).every((v) => v.sessionPhase === "lobby" && v.autoStartIn > 0), 8000, "한 판 더 → both in the lobby, counting");
  step("한 판 더 (F): both back in the lobby, '<n>초 뒤 시작 · 2명'", /^\d+초 뒤 시작 · 2명$/.test((await E.evaluate(texts)).startWaitMain ?? ""), { text: (await E.evaluate(texts)).startWaitMain });
  await waitFor(async () => (await Promise.all([E, F].map(vars))).every((v) => v.sessionPhase === "play"), 20000, "the next game starts");
  step("한 판 더: the next game started for both", true);

  // ── 4. moved alone, the link's room frees up (#141 review): a friend opening the link lands in
  //       the link's room — the one alone in `.g2` goes back there (LONE_RETURN_MS) and they play ──
  const S = FRIENDS_SLUG; // its public room (the friends room above had its own ?room= id)
  const P = await open(b1, "폴", `${BASE}/p/${S}`, logs);
  const Q = await open(b2, "퀸", `${BASE}/p/${S}`, logs);
  await waitFor(async () => (await Promise.all([P, Q].map(vars))).every((v) => v.sessionPhase === "play"), 25000, "P and Q play in the link's room");
  const G = await open(b3, "그레이스", `${BASE}/p/${S}`, logs);
  await waitFor(async () => (await vars(G)).roster?.join() === "그레이스" && Boolean(hub.room(`${S}.g2`)?.sockets.size), 15000, "G moved to .g2, alone");
  const movedBefore = hub.history().get(`room:${S}`)?.moved ?? 0;
  await waitFor(async () => ["result", "lobby"].includes((await vars(P)).sessionPhase), 25000, "the link's room's game ended");
  await P.context().close();
  await Q.context().close();
  const H = await open(b2, "해리", `${BASE}/p/${S}`, logs);
  await waitFor(async () => (await vars(H)).roster?.includes("해리"), 15000, "H in a lobby");
  const vh = await vars(H);
  step("moved alone: a friend opening the link lands in the link's room (not moved to .g2)", (hub.history().get(`room:${S}`)?.moved ?? 0) === movedBefore && vh.sessionPhase !== "countdown" && vh.sessionPhase !== "play", { moved: [movedBefore, hub.history().get(`room:${S}`)?.moved], roster: vh.roster });
  await waitFor(async () => (await Promise.all([G, H].map(vars))).every((v) => [...(v.roster || [])].sort().join() === "그레이스,해리"), 45000, "G back in the link's room with H");
  const tg = await G.evaluate(texts);
  step("moved alone: back in the link's room after a while — G and H together, no one left in .g2", !hub.room(`${S}.g2`)?.sockets.size, { g2Sockets: hub.room(`${S}.g2`)?.sockets.size, text: tg.startWaitMain });
  await waitFor(async () => (await Promise.all([G, H].map(vars))).every((v) => v.sessionPhase === "play"), 25000, "G and H play");
  step("moved alone: the two started by themselves → G and H play", (await Promise.all([G, H].map(vars))).every((v) => v.iAmSpectator !== true));
  await shot(G, "moved-back-play");
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-40) });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await hub.close();
}
runGate("room-rules-e2e", results, (r) => r.ok);
