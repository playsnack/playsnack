// The released room features, checked on a REAL deployed site — only what a person's browser can
// see: the DOM, the canvas app's state (`globalThis.__bite`: vars + scene), page URLs, sheets and
// toasts. No hub internals, no local build. Each browser context = one device (its own storage,
// its own nickname), a phone is 390×844 with touch. Automated browsers are left out of telemetry,
// so the live stats stay clean; every page is closed at the end so the rooms empty.
//   1. room type: 🌐 공개방 ↔ 🤝 친구방 (chip, subtitle, ?room= 15-symbol code), alone → back to public
//   2. friends join: guest from the link, rosters 2, guest has no 시작하기, host starts → play → result
//   3. PIN (#217): 친구 초대하기 → 비밀번호 걸고 보내기 → 20-symbol link (share stubbed); guest: PIN
//      screen → wrong → right → in → reload → back in without the PIN
//   4. forged link → 링크가 만료됐어요, not in any room
//   5. answer change (#211, 스피드 퀴즈 public room): switch within 3 s, refused after, reveal agrees
//   6. 한 판 더 (#212): the result stays 15 s; one 한 판 더 → both in the lobby counting down
//   7. leave count (#213): 3 in a friends room; one closes → 2; one ← 홈 → 1 (each within 3 s)
//   8. scheduled start (#218): host schedules (test preset 12 s if the build has it, else 1분 뒤)
//      → guest sees "m:ss 뒤 시작!" → starts by itself with 2
//   9. desktop invite (#209): 1280×800, no touch → 친구 초대하기 copies the link, share not called
// Usage: node snack-server/tools/live-e2e.mjs --base https://develop.playsnack.pages.dev [--only 1,3] [--shots <dir>]
// Exit code 1 on any FAIL.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const BASE = (arg("--base", "https://develop.playsnack.pages.dev") ?? "").replace(/\/+$/, "");
const SHOTS = arg("--shots", join(tmpdir(), "snack-live-e2e-shots"));
const ONLY = arg("--only", "") ? new Set(arg("--only").split(",").map(Number)) : null;
const SITE = new URL(BASE).hostname.split(".")[0];
const TAP = "tpl-tap-battle";
const QUIZ = "tpl-speed-quiz";
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SCENARIO_MS = Number(process.env.LIVE_E2E_SCENARIO_MS || 150_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── what the page can tell us (run inside the page) ──
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
  if (v?.scene) walk(v.scene.root, 0, 0);
  return out.filter((t) => t.w > 1 && t.h > 1 && t.y < innerHeight && t.y + t.h > 0);
};
const texts = () => {
  const out = {};
  const walk = (inst) => {
    if (inst.kind === "text" && inst.node?.id) out[inst.node.id] = String(inst.content ?? "");
    inst.children.forEach(walk);
  };
  if (globalThis.__bite?.scene) walk(globalThis.__bite.scene.root);
  return out;
};
const allTexts = () => {
  const out = [];
  const walk = (inst) => {
    if (inst.kind === "text" && inst.content != null && String(inst.content).trim()) out.push(String(inst.content));
    inst.children.forEach(walk);
  };
  if (globalThis.__bite?.scene) walk(globalThis.__bite.scene.root);
  return out;
};
const vars = (page) => page.evaluate(() => ({ phase: globalThis.__bite?.app.phase, ...globalThis.__bite?.app.vars })).catch(() => ({}));
const hasTarget = async (page, id) => (await page.evaluate(targets).catch(() => [])).some((t) => t.name === id);
async function tapNode(page, id) {
  const t = (await page.evaluate(targets)).find((x) => x.name === id);
  if (!t) return false;
  await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  return true;
}
async function waitFor(fn, ms, what) {
  for (let t = 0; t < ms; t += 150) {
    if (await fn().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timeout (${ms} ms): ${what}`);
}
const codeOf = (url) => { try { return new URL(url).searchParams.get("room") ?? ""; } catch { return ""; } };
const chipText = async (page) => ((await page.getByTestId("room-type-chip").textContent({ timeout: 2000 }).catch(() => "")) ?? "").trim();
const peopleChip = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"]')].map((e) => e.textContent ?? "").find((t) => /\d+명/.test(t)) ?? "").catch(() => "");
const rosterN = async (page) => ((await vars(page)).roster ?? []).length;

// ── devices ──
const browsers = [];
let bi = 0;
const launch = () => chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const nextBrowser = () => browsers[bi++ % browsers.length];
let pages = []; // this scenario's pages (closed at its end)
let logs = [];
/** A phone (or a computer with `desktop`): its own context, `snack_nick` set; `share` stubs navigator.share. */
async function device(nick, { desktop = false, share = false, schedTestSec = 0 } = {}) {
  const ctx = desktop
    ? await nextBrowser().newContext({ viewport: { width: 1280, height: 800 }, locale: "ko-KR", timezoneId: "Asia/Seoul" })
    : await nextBrowser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  if (desktop) await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await ctx.addInitScript(([n, s, stub]) => {
    try {
      localStorage.setItem("snack_nick", n);
      if (s) localStorage.setItem("snack_sched_test_s", String(s));
    } catch {}
    if (stub) {
      globalThis.__shared = [];
      Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { globalThis.__shared.push(d?.url ?? ""); } });
    }
  }, [nick, schedTestSec, share]);
  const page = await ctx.newPage();
  page.nick = nick;
  page.sockets = [];
  page.on("websocket", (ws) => page.sockets.push(ws.url()));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${nick}] ${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`[${nick}] pageerror: ${e.message}`));
  pages.push(page);
  return page;
}
async function go(page, path, { scene = true } = {}) {
  page.sockets.length = 0;
  await page.goto(path.startsWith("http") ? path : `${BASE}${path}`, { waitUntil: "load" });
  if (scene) await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 20000 });
}
const closePage = async (page) => { pages = pages.filter((p) => p !== page); await page.context().close().catch(() => {}); };

/** A phone that made a friends room from the chip and hosts it (the chip on a public link). */
async function hostFriends(page, slug = TAP) {
  await go(page, `/p/${slug}`);
  await waitFor(async () => (await vars(page)).roomMode === "auto", 20000, `${page.nick} in the public room`);
  await page.getByTestId("room-type-chip").click();
  await waitFor(async () => codeOf(page.url()).length >= 15 && (await vars(page)).iAmHost === true && (await vars(page)).roomMode === "host", 20000, `${page.nick} hosts a friends room`);
}

// ── results ──
const results = [];
let scenario = "";
const shotDir = () => { mkdirSync(SHOTS, { recursive: true }); return SHOTS; };
async function step(id, ok, extra = {}, page = null) {
  const { ...detail } = extra;
  results.push({ scenario, id, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} [${scenario}] ${id}  ${JSON.stringify(detail)}`);
  if (!ok && page) {
    const f = join(shotDir(), `live-${SITE}-${scenario.split(" ")[0]}-${results.length}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    console.log(`        screenshot: ${f}`);
  }
}

async function run(n, name, fn) {
  if (ONLY && !ONLY.has(n)) return;
  scenario = `${n} ${name}`;
  pages = [];
  logs = [];
  console.log(`\n── ${scenario} (${BASE}) ──`);
  const t0 = Date.now();
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`scenario over ${SCENARIO_MS / 1000} s`)), SCENARIO_MS); })]);
  } catch (e) {
    const shots = [];
    for (const p of pages) {
      const f = join(shotDir(), `live-${SITE}-${n}-${p.nick}.png`);
      if (await p.screenshot({ path: f }).then(() => true).catch(() => false)) shots.push(f);
      shots.push(`${p.nick}: ${p.url()} vars=${JSON.stringify(await pick(p))}`);
    }
    await step("run", false, { error: String(e?.message ?? e), shots, logs: logs.slice(-15) });
  } finally {
    clearTimeout(timer);
    for (const p of pages) await p.context().close().catch(() => {});
    pages = [];
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
}
const pick = async (p) => { const v = await vars(p); return { phase: v.phase, sessionPhase: v.sessionPhase, roomMode: v.roomMode, iAmHost: v.iAmHost, roster: v.roster, autoStartIn: v.autoStartIn, startIn: v.startIn }; };

try {
  for (let i = 0; i < 3; i++) browsers.push(await launch());

  // ── 1. room type ──
  await run(1, "room-type", async () => {
    const A = await device("라이브앨리스");
    await go(A, `/p/${TAP}`);
    await waitFor(async () => (await vars(A)).roomMode === "auto", 20000, "A in the public room");
    await sleep(500);
    const pubChip = await chipText(A);
    const pubSub = (await A.evaluate(allTexts)).find((t) => /누구나 함께하는 방/.test(t)) ?? "";
    await step("public link: chip 🌐 공개방, subtitle '누구나 함께하는 방'", /🌐\s*공개방/.test(pubChip) && /누구나 함께하는 방/.test(pubSub), { url: A.url(), pubChip, pubSub }, A);
    await A.getByTestId("room-type-chip").click();
    await waitFor(async () => codeOf(A.url()).length === 15 && (await vars(A)).roomMode === "host", 20000, "A in a friends room");
    await sleep(500);
    const frChip = await chipText(A);
    const frSub = (await A.evaluate(allTexts)).find((t) => /초대받은 친구만/.test(t)) ?? "";
    const v = await vars(A);
    await step("chip → friends room: ?room= 15-symbol code, chip 🤝 친구방, subtitle '초대받은 친구만', A hosts",
      /🤝\s*친구방/.test(frChip) && /초대받은 친구만/.test(frSub) && v.iAmHost === true && [...codeOf(A.url())].every((c) => ALPHA.includes(c)),
      { url: A.url(), code: codeOf(A.url()), frChip, frSub, iAmHost: v.iAmHost }, A);
    await A.getByTestId("room-type-chip").click();
    await waitFor(async () => !/[?&]room=/.test(A.url()) && (await vars(A)).roomMode === "auto", 20000, "A back in the public room");
    await sleep(300);
    await step("alone: chip → back to the public room at once (no sheet), chip 🌐 공개방",
      (await A.getByTestId("leave-friends").count()) === 0 && new URL(A.url()).pathname === `/p/${TAP}` && /공개방/.test(await chipText(A)),
      { url: A.url(), chip: await chipText(A) }, A);
  });

  // ── 2. friends join ──
  await run(2, "friends-join", async () => {
    const A = await device("라이브호스트");
    await hostFriends(A);
    const B = await device("라이브게스트");
    await go(B, A.url());
    await waitFor(async () => (await rosterN(A)) === 2 && (await rosterN(B)) === 2, 20000, "both rosters 2");
    await sleep(600);
    const vb = await vars(B);
    const tb = await B.evaluate(texts);
    await step("guest from the link: both rosters 2, guest is not host, no 시작하기, '방장이 시작하길 기다리는 중'",
      vb.iAmHost === false && !(await hasTarget(B, "startBtn")) && tb.startWaitMain === "방장이 시작하길 기다리는 중" && (await hasTarget(A, "startBtn")),
      { rosters: [(await vars(A)).roster, vb.roster], wait: tb.startWaitMain, sub: tb.startWaitSub, people: [await peopleChip(A), await peopleChip(B)] }, B);
    await tapNode(A, "startBtn");
    await waitFor(async () => (await vars(A)).sessionPhase === "play" && (await vars(B)).sessionPhase === "play", 20000, "both play");
    await step("host taps 시작하기 → both play", true, { phases: [(await vars(A)).sessionPhase, (await vars(B)).sessionPhase] });
    // play a little: tap whatever the tap battle offers, so the result has scores
    const end = Date.now() + 40000;
    while (Date.now() < end && !((await vars(A)).sessionPhase === "result" && (await vars(B)).sessionPhase === "result")) {
      for (const p of [A, B]) {
        const t = (await p.evaluate(targets).catch(() => [])).find((x) => x.name === "tapArea");
        if (t && (await vars(p)).sessionPhase === "play") await p.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2).catch(() => {});
      }
      await sleep(250);
    }
    const [ra, rb] = [await vars(A), await vars(B)];
    await step("the game finishes → both on the result", ra.sessionPhase === "result" && rb.sessionPhase === "result", { phases: [ra.sessionPhase, rb.sessionPhase] }, A);
  });

  // ── 3. PIN ──
  await run(3, "pin", async () => {
    const H = await device("라이브핀호스트", { share: true });
    await hostFriends(H);
    const code15 = codeOf(H.url());
    await H.getByRole("button", { name: "친구 초대 링크 보내기" }).click();
    const ask = H.getByTestId("invite-ask");
    await ask.waitFor({ state: "visible", timeout: 8000 });
    const askText = (await ask.textContent()) ?? "";
    await ask.getByRole("button", { name: "비밀번호 걸고 보내기" }).click();
    await H.locator('[data-pin-mode="set"]').waitFor({ state: "visible", timeout: 8000 });
    await H.locator("#snack-pin").fill("4821");
    await H.locator('[data-pin-mode="set"]').getByRole("button", { name: "확인", exact: true }).click();
    await waitFor(async () => codeOf(H.url()).length === 20 && (await vars(H)).iAmHost === true, 20000, "H hosts a 20-symbol PIN room");
    const send = H.getByTestId("invite-send");
    await send.waitFor({ state: "visible", timeout: 8000 });
    const sendText = (await send.textContent()) ?? "";
    await send.getByRole("button", { name: /링크 보내기/ }).click();
    await waitFor(async () => (await H.evaluate(() => globalThis.__shared.length)) >= 1, 6000, "share called");
    const shared = await H.evaluate(() => globalThis.__shared[0]);
    await step("친구 초대하기 → '비밀번호를 걸까요?' → 비밀번호 걸고 보내기 → 4821 → 20-symbol link; '링크 보내기' shares it",
      /비밀번호를 걸까요/.test(askText) && codeOf(shared) === codeOf(H.url()) && /4821/.test(sendText) && code15.length === 15,
      { from: code15.length, to: codeOf(H.url()).length, sendText, shared: shared?.replace(/room=.*/, "room=…") }, H);
    const link = H.url();
    const G = await device("라이브핀게스트");
    await go(G, link, { scene: false });
    await G.locator('[data-pin-mode="enter"]').waitFor({ state: "visible", timeout: 15000 });
    const enterTitle = await G.locator('[data-pin-mode="enter"] h1').textContent();
    await step("guest opens the 20-symbol link → PIN screen before joining (no room socket yet)", /비밀번호를 입력/.test(enterTitle ?? "") && G.sockets.length === 0,
      { enterTitle, sockets: G.sockets.length, rosterH: (await vars(H)).roster }, G);
    const typePin = async (pin) => {
      const input = G.locator("#snack-pin");
      await input.waitFor({ state: "visible" });
      await waitFor(async () => !(await input.isDisabled()), 6000, "the PIN field is on");
      await input.fill(pin);
    };
    await typePin("1357");
    await G.getByText(/비밀번호가 달라요/).waitFor({ state: "visible", timeout: 10000 });
    const left = (await G.getByText(/번 더 틀리면/).textContent().catch(() => "")) ?? "";
    await step("wrong PIN → '비밀번호가 달라요' + tries left", /\d+번 더 틀리면/.test(left), { left }, G);
    await typePin("4821");
    await waitFor(async () => (await rosterN(G)) === 2 && (await rosterN(H)) === 2, 15000, "G in the PIN room");
    await step("right PIN → joined, rosters 2", (await G.locator('[data-pin-mode="enter"]').count()) === 0, { rosters: [(await vars(H)).roster, (await vars(G)).roster] }, G);
    await go(G, link, { scene: false });
    await waitFor(async () => (await rosterN(G)) === 2 || (await G.locator('[data-pin-mode="enter"]').count()) > 0, 20000, "G after reload");
    await sleep(500);
    await step("guest reload → back in without the PIN prompt", (await G.locator('[data-pin-mode="enter"]').count()) === 0 && (await rosterN(G)) === 2, { roster: (await vars(G)).roster }, G);
  });

  // ── 4. forged link ──
  await run(4, "forged-link", async () => {
    const X = await device("라이브위조");
    const forged = Array.from({ length: 15 }, () => ALPHA[Math.floor(Math.random() * 32)]).join("");
    await go(X, `/p/${TAP}?room=${forged}`, { scene: false });
    await X.locator('[data-reason="expired"]').waitFor({ state: "visible", timeout: 20000 });
    const sheet = (await X.locator('[data-reason="expired"]').textContent()) ?? "";
    await sleep(1500);
    const v = await vars(X);
    await step("forged 15-symbol code → '링크가 만료됐어요', no roster (not in any room)", /링크가 만료됐어요/.test(sheet) && !(v.roster?.length > 0), { forged, sheet: sheet.slice(0, 80), roster: v.roster, sockets: X.sockets.map((u) => u.replace(/[?].*/, "?…")) }, X);
  });

  // ── 5 + 6. answer change (#211) and 한 판 더 (#212), 스피드 퀴즈 public room ──
  await run(5, "answer-change+one-more", async () => {
    scenario = "5 answer-change";
    const A = await device("라이브퀴즈A");
    const B = await device("라이브퀴즈B");
    await go(A, `/p/${QUIZ}`);
    await waitFor(async () => (await vars(A)).roomMode === "auto", 20000, "A in the public quiz room");
    await go(B, `/p/${QUIZ}`);
    await waitFor(async () => (await rosterN(A)) === 2 && (await rosterN(B)) === 2, 20000, "A and B in the same public room");
    await waitFor(async () => (await vars(A)).sessionPhase === "play" && (await vars(B)).sessionPhase === "play", 30000, "auto-start → both play");
    const rv = (p) => p.evaluate(() => { const v = globalThis.__bite.app.vars; return { roundIdx: v.roundIdx, seenRound: v.seenRound, roundAnswer: v.roundAnswer, myAnswer: v.myAnswer, myAnswerRound: v.myAnswerRound, myPick: v.myPick, options: v.roundContent?.options, q: v.roundContent?.q, sessionPhase: v.sessionPhase }; });
    await waitFor(async () => { const [a, b] = [await rv(A), await rv(B)]; return a.roundIdx === 0 && a.seenRound === 0 && b.seenRound === 0 && b.roundAnswer < 0; }, 15000, "round 1 on both");
    // A does not answer round 1: an early reveal (everyone answered + windows closed) would end it before the late tap
    const n = (await rv(B)).options?.length ?? 2;
    const first = 0;
    const second = 1;
    const third = n > 2 ? 2 : 0;
    const t0 = Date.now();
    await tapNode(B, `tile${first}`);
    await sleep(700);
    await tapNode(B, `tile${second}`);
    const switchedAt = Date.now() - t0;
    await waitFor(async () => { const b = await rv(B); return b.myAnswer === second && b.myPick?.option === second && b.myPick?.round === 0; }, 3000, "B's pick moved (room agrees)").catch(() => {});
    const afterSwitch = await rv(B);
    const status1 = (await B.evaluate(texts)).statusText;
    await step(`round 1: B taps tile${first}, then tile${second} ${switchedAt} ms later → its pick moves (room's myPick agrees)`,
      afterSwitch.myAnswer === second && afterSwitch.myPick?.option === second, { myAnswer: afterSwitch.myAnswer, myPick: afterSwitch.myPick, status: status1 }, B);
    while (Date.now() - t0 < 3600) await sleep(100);
    const stillOpen = (await rv(B)).roundAnswer < 0;
    await tapNode(B, `tile${third}`);
    await sleep(1200);
    const afterLate = await rv(B);
    const status2 = (await B.evaluate(texts)).statusText ?? "";
    await step(`>3 s after the first pick: tile${third} refused — pick stays ${second}, '확정'`,
      afterLate.myAnswer === second && afterLate.myPick?.option === second && stillOpen && /확정/.test(status2),
      { at: Date.now() - t0, stillOpen, myAnswer: afterLate.myAnswer, myPick: afterLate.myPick, status: status2 }, B);
    await waitFor(async () => (await rv(B)).roundAnswer >= 0 || (await rv(B)).roundIdx > 0, 15000, "round 1 revealed");
    const rev = await rv(B);
    const status3 = (await B.evaluate(texts)).statusText ?? "";
    const expect = rev.roundAnswer === second ? /정답/ : /땡/;
    await step("reveal: B's status follows the final pick (정답 / 땡 against tile" + second + ")", rev.roundAnswer >= 0 && expect.test(status3), { roundAnswer: rev.roundAnswer, myAnswer: rev.myAnswer, status: status3 }, B);
    const q1 = { q: afterSwitch.q, pick: afterSwitch.options?.[second] };
    // the rest: both answer at once each round, to the result
    let lastRound = 0;
    await waitFor(async () => {
      const [a, b] = [await rv(A), await rv(B)];
      if (a.sessionPhase === "result" && b.sessionPhase === "result") return true;
      if (a.roundIdx > lastRound && a.roundAnswer < 0 && a.seenRound === a.roundIdx && a.myAnswerRound !== a.roundIdx) await tapNode(A, "tile0").catch(() => {});
      if (b.roundIdx > lastRound && b.roundAnswer < 0 && b.seenRound === b.roundIdx && b.myAnswerRound !== b.roundIdx) await tapNode(B, "tile1").catch(() => {});
      return false;
    }, 90000, "both on the result");
    const view = await B.evaluate(() => globalThis.__bite.app.vars.resultView);
    const row = view?.questions?.[0];
    const chip = row?.chips?.find((c) => c.nick === "라이브퀴즈B");
    await step("result: Q1's row shows B's FINAL pick", chip?.pick === q1.pick && row?.q === q1.q, { q1, row: row && { q: row.q, answer: row.answer, chips: row.chips } }, B);

    // ── 6. 한 판 더 ──
    scenario = "6 one-more";
    await sleep(15000);
    const [ra, rb] = [await vars(A), await vars(B)];
    await step("15 s after the result: still the result for both, no countdown", ra.sessionPhase === "result" && rb.sessionPhase === "result" && !(ra.autoStartIn > 0),
      { phases: [ra.sessionPhase, rb.sessionPhase], autoStartIn: [ra.autoStartIn, rb.autoStartIn] }, A);
    const hadBtn = (await hasTarget(A, "againBtn")) && (await hasTarget(B, "againBtn"));
    await tapNode(B, "againBtn");
    await waitFor(async () => (await vars(A)).sessionPhase === "lobby" && (await vars(B)).sessionPhase === "lobby" && (await vars(A)).autoStartIn > 0, 10000, "both in the lobby, counting").catch(() => {});
    const [la, lb] = [await vars(A), await vars(B)];
    const ta = await A.evaluate(texts);
    await step("B taps 한 판 더 → both back in the lobby with the 10 s countdown",
      hadBtn && la.sessionPhase === "lobby" && lb.sessionPhase === "lobby" && la.autoStartIn > 0 && la.autoStartIn <= 10 && lb.autoStartIn > 0,
      { hadBtn, phases: [la.sessionPhase, lb.sessionPhase], autoStartIn: [la.autoStartIn, lb.autoStartIn], text: ta.schedMain ?? ta.startWaitMain }, A);
  });

  // ── 7. leave count ──
  await run(7, "leave-count", async () => {
    const A = await device("라이브방장");
    await hostFriends(A);
    const B = await device("라이브친구1");
    const C = await device("라이브친구2");
    await go(B, A.url());
    await go(C, A.url());
    await waitFor(async () => (await rosterN(A)) === 3 && (await rosterN(B)) === 3 && (await rosterN(C)) === 3, 20000, "3 in the lobby");
    await sleep(800);
    await step("3 devices in the friends lobby", true, { roster: (await vars(A)).roster, people: await peopleChip(A) });
    let t0 = Date.now();
    await closePage(C);
    const twoOk = await waitFor(async () => (await rosterN(A)) === 2 && (await rosterN(B)) === 2, 3000, "2 after C closed").then(() => true, () => false);
    const t2 = Date.now() - t0;
    await sleep(300);
    await step("C closes its page → A and B show 2 within 3 s", twoOk && /2명/.test(await peopleChip(A)), { ms: t2, rosters: [(await vars(A)).roster, (await vars(B)).roster], people: [await peopleChip(A), await peopleChip(B)] }, A);
    t0 = Date.now();
    await B.getByRole("button", { name: "홈으로" }).click();
    const oneOk = await waitFor(async () => (await rosterN(A)) === 1, 3000, "1 after B went home").then(() => true, () => false);
    const t1 = Date.now() - t0;
    await sleep(300);
    await step("B taps ← 홈 → A shows 1 within 3 s", oneOk && /1명/.test(await peopleChip(A)), { ms: t1, roster: (await vars(A)).roster, people: await peopleChip(A), bUrl: B.url() }, A);
  });

  // ── 8. scheduled start ──
  await run(8, "scheduled-start", async () => {
    const A = await device("라이브예약", { schedTestSec: 12 });
    await hostFriends(A);
    const B = await device("라이브예약친구");
    await go(B, A.url());
    await waitFor(async () => (await rosterN(A)) === 2 && (await rosterN(B)) === 2, 20000, "both in");
    await sleep(500);
    await tapNode(A, "schedBtn");
    const sheet = A.getByTestId("schedule-sheet");
    await sheet.waitFor({ state: "visible", timeout: 8000 });
    const presets = await sheet.locator('[data-testid^="schedule-preset-"]').allTextContents();
    const test = sheet.getByTestId("schedule-preset-12000");
    const useTest = (await test.count()) === 1;
    const ms = useTest ? 12000 : 60000;
    const t0 = Date.now();
    await (useTest ? test : sheet.getByTestId("schedule-preset-60000")).click();
    await waitFor(async () => /^\d+:\d{2} 뒤 시작!$/.test((await B.evaluate(texts)).schedMain ?? ""), 8000, "B sees m:ss 뒤 시작!");
    const tb = await B.evaluate(texts);
    await step(`host picks ${useTest ? "the 12초 test preset" : "1분 뒤"} → guest sees 'm:ss 뒤 시작!'`, true, { presets, schedMain: tb.schedMain, schedSub: tb.schedSub, wait: tb.startWaitMain });
    await waitFor(async () => ["countdown", "play"].includes((await vars(A)).sessionPhase) && ["countdown", "play"].includes((await vars(B)).sessionPhase), ms + 10000, "the game starts by itself");
    const took = Date.now() - t0;
    await waitFor(async () => (await vars(A)).sessionPhase === "play" && (await vars(B)).sessionPhase === "play", 10000, "both play");
    await step("nobody presses anything → the game starts by itself, 2 players, not before the time", took >= ms - 1500 && (await rosterN(A)) === 2, { took, ms, roster: (await vars(A)).roster }, A);
  });

  // ── 9. desktop invite ──
  await run(9, "desktop-invite", async () => {
    const D = await device("라이브데스크톱", { desktop: true });
    await D.addInitScript(() => {
      globalThis.__shareCalls = 0;
      Object.defineProperty(navigator, "share", { configurable: true, value: async () => { globalThis.__shareCalls++; } });
    });
    await go(D, `/p/${TAP}`);
    await waitFor(async () => (await vars(D)).roomMode === "auto", 20000, "D in the public room");
    await D.getByTestId("room-type-chip").click();
    await waitFor(async () => codeOf(D.url()).length === 15 && (await vars(D)).iAmHost === true, 20000, "D hosts a friends room");
    await D.getByRole("button", { name: "친구 초대 링크 보내기" }).click();
    const ask = D.getByTestId("invite-ask");
    if (await ask.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) await ask.getByRole("button", { name: "그냥 보내기" }).click();
    const toast = D.getByTestId("invite-copied");
    await toast.waitFor({ state: "visible", timeout: 8000 });
    await sleep(450);
    const toastText = (await toast.textContent()) ?? "";
    const clip = await D.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e}`);
    const shareCalls = await D.evaluate(() => globalThis.__shareCalls);
    await step("desktop: 친구 초대하기 copies the room link, '링크를 복사했어요', navigator.share not called",
      shareCalls === 0 && clip.startsWith(BASE) && codeOf(clip) === codeOf(D.url()) && /링크를 복사했어요/.test(toastText),
      { shareCalls, clip: clip.replace(/room=.*/, `room=…(${codeOf(clip).length})`), toastText }, D);
  });
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
}

const fails = results.filter((r) => !r.ok);
console.log(`\n══ live-e2e ${BASE}: ${results.length - fails.length}/${results.length} ok ══`);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  [${r.scenario}] ${r.id}`);
process.exit(fails.length || !results.length ? 1 : 0);
