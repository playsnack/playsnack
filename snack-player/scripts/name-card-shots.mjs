// "이름 정하기" card (#104), end to end against a room server (edge hub): a guest who opens a
// room link gets an auto name and the card in the lobby; 바꾸기 renames them for everyone in
// the room at once; 이 이름 그대로 keeps it; either way the card never comes back. Screenshots at
// 390×844 and 360×640. Needs a dev player with VITE_ROOM_URL → an edge hub:
//   node -e 'import("./packages/snack-room/tools/edgeHub.js").then(m => m.startEdgeHub({ port: 4615 }))'
//   VITE_ROOM_URL=ws://127.0.0.1:4615 pnpm --filter @snack/player exec vite --port 4614
//   node snack-player/scripts/name-card-shots.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = (process.argv[2] || "http://127.0.0.1:4614/").replace(/\/?$/, "/");
const OUT = process.argv[3] || "/tmp/snack-name-card-shots";
mkdirSync(OUT, { recursive: true });
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const browser = await chromium.launch();
async function device(path, { w = 390, h = 844, nick = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (nick) await ctx.addInitScript((n) => { try { if (!localStorage.getItem("snack_nick")) localStorage.setItem("snack_nick", n); } catch {} }, nick);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(false, `page error: ${e.message}`));
  await page.goto(BASE + path);
  await page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 15000 });
  return { ctx, page };
}
const card = (p) => p.getByRole("group", { name: "이름 정하기" });
const roster = (p) => p.evaluate(() => globalThis.__snackRuntime?.vars?.roster ?? null);
const until = async (fn, ms = 5000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return Boolean(await fn());
};

for (const [w, h] of [[390, 844], [360, 640]]) {
  const path = `p/tpl-tap-battle?room=${code()}`;
  const friend = await device(path, { w, h, nick: "하늘" });
  const guest = await device(path, { w, h }); // a link opened on a fresh device: auto name
  await card(guest.page).waitFor({ timeout: 10000 });
  const auto = await guest.page.evaluate(() => [localStorage.getItem("snack_nick"), localStorage.getItem("snack_nick_auto")]);
  check(auto[1] === "1" && Boolean(auto[0]), `${w}×${h}: guest entered at once with an auto name (${auto[0]})`);
  check(await guest.page.locator("#snack-name-card").inputValue() === auto[0], `${w}×${h}: the card is prefilled with it`);
  check(!(await card(friend.page).isVisible()), `${w}×${h}: no card for a chosen name`);
  check(await until(async () => (await roster(friend.page))?.includes(auto[0])), `${w}×${h}: the room shows the auto name first`);
  const box = await card(guest.page).boundingBox();
  check(box && box.y >= 58 && box.x + box.width <= w - 96, `${w}×${h}: card under the top row, left of 🪲/💬 (${JSON.stringify(box)})`);
  await guest.page.waitForTimeout(300);
  await guest.page.screenshot({ path: `${OUT}/lobby-card-${w}x${h}.png` });
  if (w === 390) {
    // 바꾸기: the room renames at once, the card goes and stays gone
    await guest.page.locator("#snack-name-card").fill("민지");
    await guest.page.getByRole("button", { name: "바꾸기" }).click();
    check(await until(async () => !(await card(guest.page).isVisible())), "바꾸기: the card hides");
    check(await until(async () => {
      const r = await roster(friend.page);
      return r?.includes("민지") && !r.includes(auto[0]);
    }), `바꾸기: the friend's roster shows 민지 at once (${JSON.stringify(await roster(friend.page))})`);
    const stored = await guest.page.evaluate(() => [localStorage.getItem("snack_nick"), localStorage.getItem("snack_nick_auto")]);
    check(stored[0] === "민지" && stored[1] === null, `바꾸기: the device name is 민지, no longer auto (${stored})`);
    await guest.page.screenshot({ path: `${OUT}/lobby-after-rename-${w}x${h}.png` });
    await guest.page.reload();
    await guest.page.waitForFunction(() => Boolean(globalThis.__snackRuntime), null, { timeout: 15000 });
    await guest.page.waitForTimeout(1500);
    check(!(await card(guest.page).isVisible()), "reload: no card any more");
    check(await until(async () => (await roster(friend.page))?.filter((n) => n === "민지").length === 1), "reload: rejoins as 민지 (hello carries the new name)");
  } else {
    // 이 이름 그대로: kept, chosen, the room unchanged
    await guest.page.getByRole("button", { name: "이 이름 그대로" }).click();
    check(await until(async () => !(await card(guest.page).isVisible())), "그대로: the card hides");
    const stored = await guest.page.evaluate(() => [localStorage.getItem("snack_nick"), localStorage.getItem("snack_nick_auto")]);
    check(stored[0] === auto[0] && stored[1] === null, `그대로: same name, no longer auto (${stored})`);
    check((await roster(friend.page))?.includes(auto[0]), "그대로: the room keeps the name");
  }
  await friend.ctx.close();
  await guest.ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} failed` : "\nall ok", OUT);
process.exit(fails.length ? 1 : 0);
