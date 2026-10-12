// B2 gate: the Bite engine in a real browser.
//  1. layout parity — every instance box in the browser equals the Node layout
//  2. fonts — the shipped faces actually loaded (render metrics = layout metrics)
//  3. interaction — real pointer taps drive the runtime; drag scrolls
// Needs `pnpm player:dev` on :5290.  Usage: node snack-server/tools/bite-browser-check.mjs [outDir]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { initLayout, computeScene, absBoxes } from "../../packages/bite-layout/src/index.js";

const BASE = "http://localhost:5290";
const outDir = process.argv[2] ?? "/tmp/bite-check";
mkdirSync(outDir, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await initLayout();
const nodeBoxes = (name) => {
  const doc = JSON.parse(readFileSync(new URL(`../../snack-player/public/bite/${name}.bite.json`, import.meta.url), "utf8"));
  const app = createBite(doc, { now: () => 0, random: () => 0, warn: () => {} });
  app.start();
  return Object.fromEntries(absBoxes(computeScene(doc, app).root));
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const open = async (name) => {
  await page.goto(`${BASE}/?bite=${name}`);
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
};
const browserBoxes = () =>
  page.evaluate(() => {
    const out = {};
    const walk = (inst, ox, oy) => {
      const b = { x: ox + inst.box.x, y: oy + inst.box.y, w: inst.box.w, h: inst.box.h };
      out[inst.key] = b;
      const off = globalThis.__bite.scroll.get(inst.key) ?? { x: 0, y: 0 };
      inst.children.forEach((c) => walk(c, b.x - off.x, b.y - off.y));
    };
    walk(globalThis.__bite.scene.root, 0, 0);
    return out;
  });
// Tap the center of the first instance whose source node has this id (or a key).
const tapAt = async (pick) => {
  const p = await page.evaluate((pick) => {
    const v = globalThis.__bite;
    let found = null;
    const walk = (inst, ox, oy) => {
      const ax = ox + inst.box.x;
      const ay = oy + inst.box.y;
      if (!found && (inst.node?.id === pick || inst.key === pick)) found = { x: ax + inst.box.w / 2, y: ay + inst.box.h / 2 };
      const off = v.scroll.get(inst.key) ?? { x: 0, y: 0 };
      inst.children.forEach((c) => walk(c, ax - off.x, ay - off.y));
    };
    walk(v.scene.root, 0, 0);
    return found && v.toClient(found.x, found.y);
  }, pick);
  if (!p) throw new Error(`no instance ${pick}`);
  await page.mouse.click(p.x, p.y);
};
const vars = () => page.evaluate(() => ({ phase: globalThis.__bite.app.phase, ...globalThis.__bite.app.vars }));

const parity = async (name) => {
  const b = await browserBoxes();
  const n = nodeBoxes(name);
  const keys = new Set([...Object.keys(b), ...Object.keys(n)]);
  const diffs = [...keys].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(n[k]));
  check(`${name}: browser layout == Node layout (${keys.size} boxes)`, diffs.length === 0, diffs.slice(0, 3).map((k) => `${k} ${JSON.stringify(b[k])} vs ${JSON.stringify(n[k])}`).join("; "));
};

// ── reaction ────────────────────────────────────────────────────────────────
await open("reaction");
await parity("reaction");
check(
  "fonts loaded (Bite Body 500/800)",
  await page.evaluate(() => document.fonts.check('500 15px "Bite Body"') && document.fonts.check('800 28px "Bite Body"')),
);
await tapAt("pad");
check("reaction: tap → wait", (await vars()).phase === "wait");
await page.waitForFunction(() => globalThis.__bite.app.phase === "green", null, { timeout: 5000 });
await tapAt("pad");
const r = await vars();
check("reaction: green → tap → done with a time", r.phase === "done" && r.lastMs > 0 && r.bestMs === r.lastMs, `lastMs=${r.lastMs}`);
await page.waitForTimeout(100);
await page.screenshot({ path: `${outDir}/reaction-done.png` });

// ── showcase ────────────────────────────────────────────────────────────────
await open("showcase");
await page.waitForTimeout(300);
await parity("showcase");
await tapAt("view/3/0#1"); // grid tile 2 (라면)
let v = await vars();
check("showcase: tile tap sets picked + count", v.picked === "라면" && v.count === 1, `${v.picked}/${v.count}`);
await tapAt("view/3/0#5");
v = await vars();
check("showcase: second tile", v.picked === "도넛" && v.count === 2);
// drag the scroll list up by 200 css px
const list = await page.evaluate(() => {
  const v = globalThis.__bite;
  const inst = v.scene.root.children[4];
  let ox = 0;
  let oy = 0;
  ox += inst.box.x;
  oy += inst.box.y;
  return { key: inst.key, ...v.toClient(ox + inst.box.w / 2, oy + inst.box.h / 2) };
});
await page.mouse.move(list.x, list.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(list.x, list.y - i * 20);
await page.mouse.up();
const off = await page.evaluate((k) => globalThis.__bite.scroll.get(k)?.y ?? 0, list.key);
check("showcase: drag scrolls the list", off > 100, `offset=${Math.round(off)}`);
const v2 = await vars();
check("showcase: drag is not a tap", v2.count === 2);
await page.screenshot({ path: `${outDir}/showcase-after.png` });

// ── gradients ───────────────────────────────────────────────────────────────
await open("gradients");
await parity("gradients");
await page.screenshot({ path: `${outDir}/gradients.png` });

// ── every other dev example ─────────────────────────────────────────────────
// Each remaining public/bite/*.bite.json must open on the dev route, validate
// (the player refuses an invalid doc) and lay out identically in the browser.
const covered = new Set(["reaction", "showcase", "gradients"]);
const examples = readdirSync(new URL("../../snack-player/public/bite/", import.meta.url))
  .filter((f) => f.endsWith(".bite.json"))
  .map((f) => f.slice(0, -".bite.json".length))
  .filter((n) => !covered.has(n));
for (const name of examples) {
  const before = errors.length;
  try {
    await open(name);
    await parity(name);
  } catch (e) {
    check(`${name}: opens on ?bite=`, false, String(e.message).split("\n")[0]);
  }
  if (errors.length > before) check(`${name}: no page errors`, false, errors.slice(before).join(" | ").slice(0, 200));
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
