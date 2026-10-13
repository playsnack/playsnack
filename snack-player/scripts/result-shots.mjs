// Screenshots (390×844) of the 나 맞히기 퀴즈 result screen with fixture data,
// for a human to look at, plus the result PNG. Two browsers join one friends
// room on a dev player (`pnpm player:dev`, VITE_BROKER_URL → a local broker);
// the result vars are fed through the dev-only runtime hook (LiveApp,
// import.meta.env.DEV), and the template's result vars from the engine lane are
// declared on the fly in case this branch's template does not have them yet.
//   node --import tsx snack-player/scripts/result-shots.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { LONG_NICK, duo, group } from "../test/fixtures/quizResult.ts";

const BASE = (process.argv[2] || "http://localhost:5323/").replace(/\/?$/, "/");
const OUT = process.argv[3] || "/tmp/snack-result-shots";
mkdirSync(OUT, { recursive: true });
const ROOM = "QZRESXLT" + String(Date.now() % 100).padStart(2, "2").replace(/[01]/g, "2"); // room code alphabet: no 0/1/I/O
const ENGINE_VARS = { quizRecap: { subject: null, about: null, title: "", packId: null, rounds: [] }, quizInfo: { title: "", count: 0, custom: false, about: null, answerMs: 9000, packId: null }, iAmSubject: false, myPid: "", sessionNo: 0 };

const browser = await chromium.launch();
async function device(nick) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript((n) => {
    try { localStorage.setItem("snack_nick", n); } catch {}
  }, nick);
  await ctx.route("**/data/bite/speed-trivia-score.bite.json", async (route) => {
    const res = await route.fetch();
    const doc = await res.json();
    doc.vars = { ...ENGINE_VARS, ...doc.vars };
    await route.fulfill({ response: res, json: doc });
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`[${nick}] console error:`, m.text()); });
  await page.goto(`${BASE}p/tpl-speed-trivia-score?room=${ROOM}`);
  await page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 15000 });
  return { ctx, page, nick };
}
const feed = (d, vars) => d.page.evaluate((v) => {
  const rt = globalThis.__snackRuntime;
  for (const [k, x] of Object.entries(v)) rt.setVar(k, x);
}, vars);
const shot = (d, name) => d.page.screenshot({ path: `${OUT}/${name}.png` });
const tap = (d, x, y) => d.page.touchscreen.tap(x, y);
const result = (input, extra = {}) => ({
  sessionPhase: "result", quizRecap: input.quizRecap, raceBoard: input.raceBoard, roster: input.roster, quizInfo: input.quizInfo, ...extra,
});

const a = await device("지은");
const b = await device("민수");
await a.page.waitForTimeout(4000); // both in the room → the 💬 button shows

// 1:1 — 지은 (the one answerer) and 민수 (the subject)
await feed(a, result(duo, { iAmSubject: false, myPid: "pid-지은", sessionNo: 1 }));
await feed(b, result(duo, { iAmSubject: true, sessionNo: 1 }));
await a.page.waitForTimeout(400);
await shot(a, "1-duo-friend-before-question");
await a.page.waitForTimeout(1800); // the question appears after the result lands
await shot(a, "2-duo-friend-question");
await shot(b, "3-duo-subject-question");
// the 💬 button sits under the people chip and opens downward
await a.page.getByLabel("반응 보내기").click();
await a.page.waitForTimeout(200);
await shot(a, "4-duo-reaction-open");
await a.page.getByLabel("반응 보내기").click();
// 👍 on 지은's device → thanks → gone
await tap(a, 236, 712);
await a.page.waitForTimeout(300);
await shot(a, "5-duo-thanks");
await a.page.waitForTimeout(1800);
await shot(a, "6-duo-after-answer");
// 결과 공유: headless Chromium cannot share files → the preview to save
await tap(a, 104, 784);
await a.page.waitForSelector('img[alt="결과 이미지"]', { timeout: 15000 });
await a.page.waitForTimeout(300);
await shot(a, "7-duo-share-preview");
const png = await a.page.evaluate(async () => {
  const img = document.querySelector('img[alt="결과 이미지"]');
  const blob = await (await fetch(img.src)).blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (const x of buf) s += String.fromCharCode(x);
  return btoa(s);
});
writeFileSync(`${OUT}/result-duo.png`, Buffer.from(png, "base64"));
await a.ctx.close();

// Group — a fresh device for the long nick (its question has not been asked yet)
const c = await device(LONG_NICK);
await c.page.waitForTimeout(3000);
await feed(c, result(group, { iAmSubject: false, myPid: `pid-${LONG_NICK}`, sessionNo: 1 }));
await feed(b, result(group, { iAmSubject: true, sessionNo: 1 }));
await c.page.waitForTimeout(2200);
await shot(c, "8-group-me-long-nick-question");
await shot(b, "9-group-subject-same-session-question");
// 👎 → reason chips; pick 끊기거나 느렸어요
await tap(c, 288, 712);
await c.page.waitForTimeout(300);
await shot(c, "10-group-reasons");
await tap(c, 110, 666);
await c.page.waitForTimeout(300);
await shot(c, "11-group-reason-thanks");
// drag the body to the per-question reveal (the canvas scrolls by drag)
await c.page.mouse.move(195, 640);
await c.page.mouse.down();
for (let i = 1; i <= 10; i++) await c.page.mouse.move(195, 640 - i * 45);
await c.page.mouse.up();
await c.page.waitForTimeout(500);
await shot(c, "12-group-reveal-scrolled");
// Next game: this device sends a new quiz during the result → its subject sees
// 내 퀴즈 시작하기 (the finished results keep their labels), others the banner.
const NEW_QUIZ = { title: `${LONG_NICK} 맞히기`, count: 6, custom: true, about: LONG_NICK, answerMs: 9000, packId: "pack-new-0000000000000000000000000" };
await feed(c, { iAmSubject: true, quizInfo: NEW_QUIZ });
await feed(b, { iAmSubject: false, quizInfo: NEW_QUIZ });
await c.page.waitForTimeout(400);
await shot(c, "13-next-start-mine");
await shot(b, "14-next-waiting-banner");
await tap(c, 104, 784);
await c.page.waitForSelector('img[alt="결과 이미지"]', { timeout: 15000 });
const png2 = await c.page.evaluate(async () => {
  const img = document.querySelector('img[alt="결과 이미지"]');
  const blob = await (await fetch(img.src)).blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (const x of buf) s += String.fromCharCode(x);
  return btoa(s);
});
writeFileSync(`${OUT}/result-group.png`, Buffer.from(png2, "base64"));

// A default quiz (no subject) finished: anyone plays again.
const cold = { ...group, quizRecap: { ...group.quizRecap, subject: null, about: null, title: "", packId: null }, quizInfo: { title: "상식", count: 6, custom: false, about: null, answerMs: 9000, packId: null } };
await feed(b, result(cold, { iAmSubject: false }));
await b.page.waitForTimeout(400);
await shot(b, "15-next-again-default-quiz");

await browser.close();
console.log(`shots → ${OUT}`);
