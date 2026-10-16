// Signed room links and the optional PIN (#157, docs/room-admission.md), end to end: the real
// player built for edge rooms (VITE_ROOM_URL), real browsers (Playwright Chromium, 390×844), the
// Node edge hub (the same admit.js / game.js / core.js the Worker and the Durable Object run) and a
// tiny static server.
//   1. 친구 방 (no PIN): A presses 🤝 친구끼리 → the room server makes a 15-symbol code, A hosts;
//      B opens the invite link → in with one tap (no PIN screen), timed.
//   2. PIN: H makes a friends room, alone opens QR → "비밀번호 걸기" → 4821 → a 20-symbol link, H
//      still hosts (never typed the PIN; the invite sheet shows "비밀번호 4821"). F opens the link
//      → the PIN screen before any socket opens; 1111 → "비밀번호가 달라요" with tries left; 4821 →
//      in (timed); a reload → back in without the PIN (pass).
//   3. G (same address) gets it wrong until locked → the countdown; H hears about it (notice).
//   4. a forged code → "링크가 만료됐어요" (no 다시 시도); 5. the public room joins as before.
// Usage: node snack-server/tools/pin-room-e2e.mjs [--skip-build] [--shots <dir>]
// Ports: PIN_E2E_PORT (page, default 4931) · PIN_E2E_HUB_PORT (edge hub, default 4930).
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
const PORT = Number(process.env.PIN_E2E_PORT || 4931);
const HUB_PORT = Number(process.env.PIN_E2E_HUB_PORT || 4930);
const OUT = join(tmpdir(), "snack-pin-room-e2e-dist");
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = "tpl-tap-battle";
const PUBLIC_SLUG = "tpl-coop-tap-goal";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
    runGate("pin-room-e2e", [{ id: "build", ok: false }], (r) => r.ok);
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

const vars = (page) => page.evaluate(() => ({ phase: globalThis.__bite?.app.phase, ...globalThis.__bite?.app.vars }));
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 100) {
    if (await fn().catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}
const launch = () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
/** A phone: its own storage; `sockets` = room sockets this page opened (URL, ms since goto). */
async function phone(browser, nick, logs) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript((n) => localStorage.setItem("snack_nick", n), nick);
  const page = await ctx.newPage();
  page.sockets = [];
  page.on("websocket", (ws) => page.sockets.push({ url: ws.url(), at: Date.now() }));
  page.on("console", (m) => logs.push(`${nick} ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${nick} pageerror: ${e.message}`));
  return page;
}
const go = async (page, url) => {
  page.sockets.length = 0;
  await page.goto(url, { waitUntil: "load" });
};
const scene = (page) => page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
const codeOf = (url) => new URL(url).searchParams.get("room") ?? "";
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `pin-${name}.png`) });
};
const pinScreen = (page) => page.locator('[data-pin-mode="enter"]');
const typePin = async (page, pin) => {
  const input = page.locator("#snack-pin");
  await input.waitFor({ state: "visible" });
  await waitFor(async () => !(await input.isDisabled()), 5000, "the PIN field is on");
  await input.fill(pin);
};

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

  // ── 1. friends room without a PIN: the server makes a 15-symbol code; one tap to join ──
  const A = await phone(b1, "앨리스", logs);
  await go(A, `${BASE}/p/${SLUG}`);
  await scene(A);
  await A.getByRole("button", { name: "친구끼리 하는 방 만들기" }).click();
  await waitFor(async () => codeOf(A.url()).length === 15 && (await vars(A)).iAmHost === true, 15000, "A made a 15-symbol room and hosts it");
  step("no PIN: 🤝 친구끼리 → a 15-symbol signed code, the maker hosts", true, { code: codeOf(A.url()).length });
  const B = await phone(b2, "밥", logs);
  const t0 = Date.now();
  await go(B, A.url());
  await waitFor(async () => (await vars(B)).roster?.length === 2, 15000, "B in A's room");
  const joinMs = Date.now() - t0;
  step("no PIN: the friend gets in with one tap — no PIN screen, ≤ 3 s from opening the link (local)", (await pinScreen(B).count()) === 0 && (await vars(B)).iAmHost === false && joinMs <= 3000, { joinMs });
  await A.context().close();
  await B.context().close();

  // ── 2. the host sets a PIN while alone → a 20-symbol link ──
  const H = await phone(b1, "호스트", logs);
  await go(H, `${BASE}/p/${SLUG}`);
  await scene(H);
  await H.getByRole("button", { name: "친구끼리 하는 방 만들기" }).click();
  await waitFor(async () => codeOf(H.url()).length === 15 && (await vars(H)).iAmHost === true, 15000, "H hosts a friends room");
  await H.getByRole("button", { name: "QR 코드로 초대하기" }).click();
  await H.getByTestId("pin-row").click();
  await H.locator("#snack-pin").fill("4821");
  await shot(H, "set");
  const setTitle = await H.locator('[data-pin-mode="set"] h1').textContent();
  await H.getByRole("button", { name: "확인" }).click();
  await waitFor(async () => codeOf(H.url()).length === 20 && (await vars(H)).iAmHost === true, 15000, "H moved to a 20-symbol PIN room and hosts it");
  await H.getByTestId("pin-chip").waitFor({ state: "visible", timeout: 5000 });
  const chip = await H.getByTestId("pin-chip").textContent();
  const hostAsked = H.sockets.some((s) => s.url.includes("pin="));
  step("PIN: set while alone → a 20-symbol link; the host hosts it on its pass (never typed the PIN); the invite sheet says the PIN",
    setTitle === "비밀번호 4자리를 정해 주세요" && !hostAsked && /비밀번호\s*4821/.test(chip ?? "") && H.sockets.some((s) => s.url.includes("k=")),
    { setTitle, chip, sockets: H.sockets.map((s) => s.url.replace(/k=[^&]+/, "k=…")) });
  await shot(H, "host-chip");
  await H.getByRole("button", { name: "닫기" }).last().click();
  const pinLink = H.url();

  // ── friend: the PIN screen comes before any socket ──
  const F = await phone(b2, "프렌드", logs);
  await go(F, pinLink);
  await pinScreen(F).waitFor({ state: "visible", timeout: 10000 });
  await sleep(800); // the app loads behind it; still no socket
  const enterTitle = await F.locator('[data-pin-mode="enter"] h1').textContent();
  const inputAttrs = await F.locator("#snack-pin").evaluate((el) => ({ mode: el.inputMode, ac: el.autocomplete, size: parseFloat(getComputedStyle(el).fontSize), font: getComputedStyle(el).fontFamily }));
  step("PIN: the friend sees the PIN screen first — no room socket before the PIN; numeric keypad, one-time-code, ≥ 16 px, no pixel face",
    enterTitle === "비밀번호를 입력해 주세요" && F.sockets.length === 0 && inputAttrs.mode === "numeric" && inputAttrs.ac === "one-time-code" && inputAttrs.size >= 16 && !/galmuri/i.test(inputAttrs.font),
    { enterTitle, sockets: F.sockets.length, inputAttrs });
  await shot(F, "enter");
  await typePin(F, "1111");
  await F.getByText("비밀번호가 달라요. 다시 입력해 주세요").waitFor({ state: "visible", timeout: 8000 });
  const leftLine = await F.getByText(/번 더 틀리면 잠시 입력이 막혀요/).textContent().catch(() => "");
  step("PIN: a wrong PIN → '비밀번호가 달라요' with the tries left, the field cleared, still on the PIN screen",
    (await pinScreen(F).count()) === 1 && /^4번 더 틀리면/.test(leftLine ?? "") && (await F.locator("#snack-pin").inputValue()) === "",
    { leftLine });
  await shot(F, "wrong");
  const p0 = Date.now();
  await typePin(F, "4821");
  await waitFor(async () => (await vars(F)).roster?.length === 2, 10000, "F in the PIN room");
  const pinMs = Date.now() - p0;
  const fUrls = F.sockets.map((s) => s.url);
  step("PIN: the right PIN → in the room (≤ 1.5 s from the 4th digit, local); the PIN rode only in the socket URL",
    pinMs <= 1500 && (await pinScreen(F).count()) === 0 && (await vars(F)).iAmHost === false && fUrls.some((u) => u.includes("pin=4821")),
    { pinMs, sockets: fUrls.length });
  const passKept = await F.evaluate(() => localStorage.getItem("snk-room-pass") ?? "");
  step("PIN: the friend's device keeps a pass, never the PIN", passKept.includes("\"t\"") && !passKept.includes("4821"));
  await go(F, pinLink);
  await waitFor(async () => (await vars(F)).roster?.length === 2, 15000, "F back in after a reload");
  step("PIN: a reload → back in without the PIN screen (the pass, ?k=)",
    (await pinScreen(F).count()) === 0 && F.sockets.every((s) => !s.url.includes("pin=")) && F.sockets.some((s) => s.url.includes("k=")));

  // ── 3. wrong until locked (same address) → the countdown; the host hears about it ──
  const G = await phone(b1, "지니", logs);
  await go(G, pinLink);
  await pinScreen(G).waitFor({ state: "visible", timeout: 10000 });
  let locked = false;
  for (let i = 0; i < 7 && !locked; i++) {
    await typePin(G, "9999");
    await waitFor(async () => (await G.getByText("비밀번호가 달라요. 다시 입력해 주세요").count()) > 0 || (await G.getByText("잠시 후 다시 입력해 주세요").count()) > 0, 8000, "an answer");
    locked = (await G.getByText("잠시 후 다시 입력해 주세요").count()) > 0;
    if (!locked) await sleep(300);
  }
  const lockLine1 = (await G.getByText(/뒤에 다시 할 수 있어요/).textContent().catch(() => "")) ?? "";
  await sleep(2100);
  const lockLine2 = (await G.getByText(/뒤에 다시 할 수 있어요/).textContent().catch(() => "")) ?? "";
  step("locked: '잠시 후 다시 입력해 주세요' with a live countdown, the field off",
    locked && /\d+초 뒤에 다시 할 수 있어요/.test(lockLine1) && lockLine1 !== lockLine2 && (await G.locator("#snack-pin").isDisabled()),
    { lockLine1, lockLine2 });
  await shot(G, "locked");
  await H.locator('[data-host-pin="alert"]').waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  const alert = await H.locator('[data-host-pin="alert"]').count();
  step("host: '누군가 비밀번호를 계속 틀리고 있어요' with one tap '새 링크로 옮기기'", alert === 1 && (await H.getByRole("button", { name: "새 링크로 옮기기" }).count()) === 1);
  await shot(H, "host-alert");
  step("the friend already in is not affected by the lock (still 2 in the room)", (await vars(F)).roster?.length === 2 && (await vars(H)).roster?.length === 2);

  // ── 4. a forged code: refused at the door, the expired copy ──
  const X = await phone(b2, "엑스", logs);
  const forged = Array.from({ length: 15 }, (_, i) => ALPHA[(i * 7 + 3) % 32]).join("");
  const before = hub.rooms.size;
  await go(X, `${BASE}/p/${SLUG}?room=${forged}`);
  await X.locator('[data-reason="expired"]').waitFor({ state: "visible", timeout: 15000 });
  const sheet = await X.locator('[data-reason="expired"]').textContent();
  step("a forged code → '링크가 만료됐어요' (no 다시 시도, 혼자 하기 / 홈으로), no room made",
    /링크가 만료됐어요/.test(sheet ?? "") && /친구에게 새 링크를 받아 주세요/.test(sheet ?? "") && (await X.getByRole("button", { name: "다시 시도" }).count()) === 0 && (await X.getByRole("button", { name: "홈으로" }).count()) >= 1 && hub.rooms.size === before,
    { rooms: [before, hub.rooms.size] });
  await shot(X, "expired");

  // ── 5. the public room: unchanged ──
  const P = await phone(b2, "퍼블릭", logs);
  await go(P, `${BASE}/p/${PUBLIC_SLUG}`);
  await waitFor(async () => (await vars(P)).roster?.includes("퍼블릭"), 15000, "P in the public room");
  step("public room: joins as before (no PIN, no code, no token in the URL)", (await pinScreen(P).count()) === 0 && P.sockets.every((s) => !/[?&](k|pin)=/.test(s.url)));
} catch (e) {
  step("run", false, { error: String(e?.message ?? e), logs: logs.slice(-40) });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  server.close();
  await hub.close();
}
runGate("pin-room-e2e", results, (r) => r.ok);
