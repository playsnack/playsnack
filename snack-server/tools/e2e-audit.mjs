// E2E interaction ORACLE — the objective "does it actually work?" gate.
// For each template, in the REAL prod build (/p/tpl-<id>), it PLAYS through with
// real touch taps on the controls that are actually on screen (window.__bite
// exposes the laid-out scene, so taps land on exact node centers) and asserts:
//   1. every phase the user reaches has a TAPPABLE control that RESPONDS
//      (phase or vars change) — catches dead/hidden/overlapping buttons,
//   2. timed games (expressions read `now`) actually MOVE over wall-clock —
//      catches game loops that don't run.
// Emits PASS / FAIL(reason) per template. No coordinate guessing, no "looks ok".
//   Usage: node snack-server/tools/e2e-audit.mjs [id ...]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.SNACK_BASE || "http://localhost:4399";
const argv = process.argv.slice(2);

// In-page helpers (serialized into the page).
const PAGE = {
  // Visible tappable instances, in paint order, with client-space boxes.
  targets: () => {
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
  },
  phase: () => globalThis.__bite.app.phase,
  snap: () => globalThis.__bite.app.phase + "|" + JSON.stringify(globalThis.__bite.app.vars),
  // What the player sees: phase + every visible text.
  view: () => {
    const texts = [];
    const walk = (inst) => {
      if (inst.kind === "text") texts.push(inst.content);
      inst.children.forEach(walk);
    };
    walk(globalThis.__bite.scene.root);
    return globalThis.__bite.app.phase + "|" + texts.join("¦");
  },
};

const usesClock = (doc) => /(^|[^\w.])now([^\w]|$)/.test(JSON.stringify({ phases: doc.phases, view: doc.view, components: doc.components }));

async function open(page, id) {
  await page.goto(`${BASE}/p/tpl-${id}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => globalThis.__bite?.scene, null, { timeout: 15000 });
  await page.waitForTimeout(600);
}

async function audit(page, id, doc) {
  const issues = [];
  await open(page, id);
  const tap = async (t) => {
    await page.touchscreen.tap(Math.min(384, Math.max(6, t.x + t.w / 2)), Math.min(838, Math.max(6, t.y + t.h / 2)));
    await page.waitForTimeout(280);
  };

  const responded = new Set(); // phases that responded to a tap at least once
  for (let step = 0; step < 14; step++) {
    const phase = await page.evaluate(PAGE.phase);
    const targets = await page.evaluate(PAGE.targets);
    if (!targets.length) break; // terminal / no-interaction phase — fine
    let advanced = false;
    for (const t of targets) {
      const before = await page.evaluate(PAGE.snap);
      await tap(t);
      // Server-driven taps (multiplayer "start", votes) change state only when
      // the host answers — give the round trip up to 1.5s before calling it dead.
      for (let waited = 0; waited <= 1500; waited += 150) {
        if ((await page.evaluate(PAGE.snap)) !== before) {
          advanced = true;
          break;
        }
        await page.waitForTimeout(150);
      }
      if (advanced) break;
    }
    if (advanced) {
      responded.add(phase);
      continue;
    }
    // A phase that already responded once may legitimately ignore a re-tap
    // (re-selecting your own vote). One that NEVER responds is dead.
    if (responded.has(phase)) break;
    issues.push(`phase "${phase}": taps on ${targets.map((t) => t.name).join(",")} change nothing (dead)`);
    break;
  }

  // Game loop: in a clock-driven app, after the first tap the screen must move
  // on its own (a countdown, a moving piece, an automatic phase change) — unless
  // it is waiting for input (a reaction game's "tap now!").
  if (usesClock(doc)) {
    await open(page, id);
    const first = (await page.evaluate(PAGE.targets))[0];
    if (first) await tap(first);
    const v0 = await page.evaluate(PAGE.view);
    let alive = false;
    for (let i = 0; i < 8 && !alive; i++) {
      await page.waitForTimeout(500);
      if ((await page.evaluate(PAGE.view)) !== v0) alive = true;
    }
    const waiting = (await page.evaluate(PAGE.targets)).length > 0;
    if (!alive && !waiting) issues.push("game loop not running: the screen did not change over 4s and nothing is tappable");
  }

  return { id, verdict: issues.length ? "FAIL" : "PASS", reason: issues.join(" | ") };
}

// Templates merged into another (index.json `mergedInto`) only redirect old links.
const merged = new Set(JSON.parse(readFileSync(new URL("../data/bite/index.json", import.meta.url), "utf8")).filter((t) => t.mergedInto).map((t) => t.id));
const ids = argv.length ? argv : (await (await fetch(`${BASE}/api/templates`)).json()).templates.map((t) => t.id).filter((id) => !merged.has(id));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const results = [];
for (const id of ids) {
  const doc = (await (await fetch(`${BASE}/api/apps/tpl-${id}`)).json()).doc;
  const page = await ctx.newPage();
  try {
    results.push(await audit(page, id, doc));
  } catch (e) {
    results.push({ id, verdict: "ERROR", reason: String(e).slice(0, 120) });
  }
  await page.close();
}
await b.close();
for (const r of results) console.log(`${r.verdict === "PASS" ? "✅" : "❌"} ${r.id.padEnd(16)} ${r.verdict}${r.reason ? "  — " + r.reason : ""}`);
const pass = results.filter((r) => r.verdict === "PASS").length;
console.log(`\nORACLE: ${pass}/${results.length} PASS · ${results.length - pass} FAIL`);
process.exit(results.length - pass > 0 ? 1 : 0);
