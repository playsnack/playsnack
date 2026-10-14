// The invite QR, end to end at 390×844: screenshots of the QR buttons (quiz lobby
// band, the top-row pill, the quiz result screen) and of the open sheet, and the
// sheet's SCREENSHOT read back with a QR reader (jsQR) — it must say exactly the
// link the invite hands out (no make= / debug=). Needs a dev player
// (`pnpm player:dev`, VITE_BROKER_URL → a local broker). Exits 1 on any failure.
//   node snack-player/scripts/qr-shots.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import jsQR from "jsqr";

const BASE = (process.argv[2] || "http://localhost:5290/").replace(/\/?$/, "/");
const OUT = process.argv[3] || "/tmp/snack-qr-shots";
mkdirSync(OUT, { recursive: true });
const ORIGIN = new URL(BASE).origin;
const CODE = "QRSHTABCDE";
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const browser = await chromium.launch();
async function device(path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(() => { try { localStorage.setItem("snack_nick", "스냅봇"); } catch {} });
  const page = await ctx.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("pageerror", (e) => check(false, `page error: ${e.message}`));
  await page.goto(BASE + path);
  await page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 15000 });
  return { ctx, page, requests };
}
const qrLoaded = (reqs) => reqs.some((u) => /InviteQrSheet|qrcode-generator|\/src\/qr\.ts/.test(u));
/** The page's screenshot, decoded by jsQR (pixels via the page's own canvas). */
async function readScreenshot(page, file) {
  const png = await page.screenshot({ path: file });
  const { w, h, data } = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
  }, png.toString("base64"));
  return jsQR(new Uint8ClampedArray(data), w, h)?.data ?? null;
}
async function openSheetAndRead(d, name, expected) {
  check(!qrLoaded(d.requests), `${name}: QR code not downloaded before the button is tapped`);
  await d.page.getByLabel("QR 코드로 초대하기").first().click();
  await d.page.getByRole("img", { name: "초대 링크 QR 코드" }).waitFor({ timeout: 10000 });
  await d.page.waitForTimeout(200);
  const read = await readScreenshot(d.page, `${OUT}/${name}-sheet.png`);
  check(read === expected, `${name}: screenshot scans to ${read} (want ${expected})`);
  check(read !== null && !/[?&#](make|debug)=/.test(read), `${name}: no make= / debug= in the QR`);
  const shown = await d.page.getByTestId("qr-link").textContent();
  check(shown === expected, `${name}: link text under the QR is the same link`);
  const btns = await d.page.locator('[role="dialog"] button').evaluateAll((bs) => bs.map((b) => [b.textContent, b.getBoundingClientRect().height]));
  check(btns.length === 2 && btns.every(([, h]) => h >= 44), `${name}: 링크 복사 / 닫기 are 44 px+ (${JSON.stringify(btns)})`);
  await d.page.getByRole("button", { name: "링크 복사" }).click();
  await d.page.getByText("링크를 복사했어요").waitFor({ timeout: 3000 });
  const clip = await d.page.evaluate(() => navigator.clipboard.readText());
  check(clip === expected, `${name}: 링크 복사 put the same link on the clipboard`);
  await d.page.getByRole("button", { name: "닫기" }).click();
  check(await d.page.getByRole("dialog").count() === 0, `${name}: 닫기 closes the sheet`);
}

// 1) Quiz lobby, friends room — the band: 친구 초대하기 + QR. Arrived with ?debug=1
//    (the on-device log): it must not reach the QR.
{
  const d = await device(`p/tpl-speed-trivia-score?room=${CODE}&debug=1`);
  await d.page.getByText("🔗 친구 초대하기").waitFor({ timeout: 15000 }); // connected: the band replaced the top-row pill
  await d.page.waitForTimeout(500);
  await d.page.screenshot({ path: `${OUT}/1-quiz-lobby-band.png` });
  check(await d.page.getByLabel("QR 코드로 초대하기").count() === 1, "quiz lobby: one QR button (the band's)");
  const band = await d.page.getByLabel("QR 코드로 초대하기").boundingBox();
  check(band && band.height >= 44 && band.width >= 44 && band.y > 700, `quiz band QR is a 44 px+ target in the band (${JSON.stringify(band)})`);
  await openSheetAndRead(d, "1-quiz-lobby", `${ORIGIN}/p/tpl-speed-trivia-score?room=${CODE}`);
  await d.ctx.close();
}
// 2) A together app's friends room — the top-row pill: 🔗 친구 초대 + QR.
{
  const d = await device(`p/tpl-tap-battle?room=${CODE}`);
  await d.page.getByLabel("QR 코드로 초대하기").waitFor({ timeout: 15000 });
  await d.page.waitForTimeout(500);
  await d.page.screenshot({ path: `${OUT}/2-top-row.png` });
  const row = await d.page.evaluate(() => {
    const a = document.querySelector('[aria-label="친구 초대 링크 보내기"]').getBoundingClientRect();
    const b = document.querySelector('[aria-label="QR 코드로 초대하기"]').getBoundingClientRect();
    return { x: a.left, right: b.right, y: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
  });
  console.log(`     top row (pill + QR): x ${row.x.toFixed(1)}–${row.right.toFixed(1)}, y ${row.y.toFixed(1)}–${row.bottom.toFixed(1)}`);
  check(row.right <= 84 + 210 && row.bottom <= 54, "top row stays inside shellDocks' invitePill zone (x 84–294, y 10–54)");
  // Narrow phones: the QR never runs into the people chip.
  for (const w of [360, 320]) {
    await d.page.setViewportSize({ width: w, height: 780 });
    await d.page.waitForTimeout(200);
    const gap = await d.page.evaluate(() => {
      const qr = document.querySelector('[aria-label="QR 코드로 초대하기"]').getBoundingClientRect();
      const chip = document.querySelector('[aria-live="polite"]').getBoundingClientRect();
      return chip.left - qr.right;
    });
    check(gap >= 4, `${w} px wide: QR ends ${gap.toFixed(1)} px before the people chip`);
  }
  await d.page.setViewportSize({ width: 390, height: 844 });
  await openSheetAndRead(d, "2-top-row", `${ORIGIN}/p/tpl-tap-battle?room=${CODE}`);
  await d.ctx.close();
}
// 3) The quiz result screen, reached by really playing a game (one player, the default
//    quiz: 시작하기, then the first answer each round): the template's own 친구 초대
//    button + the shell's QR in the top row.
{
  const d = await device(`p/tpl-speed-trivia-score?room=QRRESABCDE`);
  await d.page.getByText("🔗 친구 초대하기").waitFor({ timeout: 15000 });
  await d.page.waitForTimeout(500);
  await d.page.touchscreen.tap(195, 720); // 시작하기
  const inResult = () => d.page.evaluate(() =>
    !document.querySelector('[aria-label="친구 초대 링크 보내기"]') && Boolean(document.querySelector('[aria-label="QR 코드로 초대하기"]')));
  const until = Date.now() + 90_000;
  while (!(await inResult()) && Date.now() < until) {
    await d.page.touchscreen.tap(195, 267); // the first answer
    await d.page.waitForTimeout(700);
  }
  check(await inResult(), "result screen: only the QR button in the shell (the template has 친구 초대)");
  await d.page.waitForTimeout(2500); // the result-screen question settles
  await d.page.screenshot({ path: `${OUT}/3-result.png` });
  const qr = await d.page.getByLabel("QR 코드로 초대하기").boundingBox();
  check(qr && qr.y < 60 && qr.x >= 84 && qr.x + qr.width <= 294, `result QR sits in the top row (${JSON.stringify(qr)})`);
  await openSheetAndRead(d, "3-result", `${ORIGIN}/p/tpl-speed-trivia-score?room=QRRESABCDE`);
  await d.ctx.close();
}
// 4) A solo play link never shows QR nor downloads it.
{
  const d = await device("p/tpl-quiz-ox");
  await d.page.waitForTimeout(1500);
  check(await d.page.getByLabel("QR 코드로 초대하기").count() === 0, "solo play: no QR button");
  check(!qrLoaded(d.requests), "solo play: QR code never downloaded");
  await d.ctx.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : `\nall ok — shots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
