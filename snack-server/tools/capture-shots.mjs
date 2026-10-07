// Visual+interaction capture: per template, screenshot the initial screen, then
// PLAY through with real touch taps on the controls actually on screen
// (window.__bite) and screenshot after each change. Produces <id>-1/-2/-3.png so
// a human (or me) can SEE whether it renders, lays out, and actually plays —
// not just an oracle number.
//   node snack-server/tools/capture-shots.mjs [all|id,id,…] [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SNACK_BASE || "http://localhost:4399";
const OUT = process.argv[3] || "/tmp/snack-shots";
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] && process.argv[2] !== "all" ? process.argv[2].split(",") : null;

const targets = () => {
  const v = globalThis.__bite;
  const out = [];
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    if (inst.tap) {
      const a = v.toClient(ax + inst.box.w / 2, ay + inst.box.h / 2);
      if (inst.box.w > 1 && a.y > 0 && a.y < innerHeight) out.push(a);
    }
    const off = v.scroll.get(inst.key) ?? { x: 0, y: 0 };
    inst.children.forEach((c) => walk(c, ax - off.x, ay - off.y));
  };
  walk(v.scene.root, 0, 0);
  return out;
};
const snap = () => globalThis.__bite.app.phase + "|" + JSON.stringify(globalThis.__bite.app.vars);

const ids = (await (await fetch(`${BASE}/api/templates`)).json()).templates.map((t) => t.id).filter((id) => !only || only.includes(id));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

for (const id of ids) {
  const p = await ctx.newPage();
  try {
    await p.goto(`${BASE}/p/tpl-${id}`, { waitUntil: "networkidle" });
    await p.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `${OUT}/${id}-1.png` });
    let shotN = 2;
    for (let step = 0; step < 4 && shotN <= 3; step++) {
      const ts = await p.evaluate(targets);
      if (!ts.length) break;
      let advanced = false;
      for (const t of ts) {
        const before = await p.evaluate(snap);
        await p.touchscreen.tap(Math.min(384, t.x), Math.min(836, t.y));
        await p.waitForTimeout(450);
        if ((await p.evaluate(snap)) !== before) {
          advanced = true;
          break;
        }
      }
      await p.screenshot({ path: `${OUT}/${id}-${shotN++}.png` });
      if (!advanced) break;
    }
    console.log(`${id}: captured ${shotN - 1} shots`);
  } catch (e) {
    console.log(`${id}: ERROR ${String(e).slice(0, 80)}`);
  }
  await p.close();
}
await b.close();
console.log(`\nshots → ${OUT}`);
