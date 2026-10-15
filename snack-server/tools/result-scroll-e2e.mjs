// The quiz result's per-question list ("문제별 정답", resBody) scrolls under a
// real finger (#105) — in the built player, on the shapes real phones have.
// The result vars of a 10-question game are set through the debug handle on the
// player's ?bite= path (BitePlayer, so the shell's canvasFit drop applies; no
// room or broker needed), then:
//   Chromium (Android, 390×844 and 360×640) — real touch input over CDP:
//     1. a slow drag moves the list with the finger
//     2. the browser claims the pan (the canvas's touch-action ignored — what a
//        real iOS / in-app web view can do): the list must still follow the
//        finger, no pointercancel. Before the fix it moved ~15% of the finger.
//     3. a quick flick keeps going after the finger lifts (momentum) and settles
//   WebKit (iPhone 13, 390×844 and 360×640) — Playwright cannot drive real
//   touches there, so pointer events with pointerType "touch" (what iOS sends):
//     4. slow drag, 5. flick momentum, 6. the canvas cancels touchmove (the iOS
//        guard that keeps the browser from claiming the pan).
//   Chromium desktop (1280×800, mouse — #117): 7. the wheel scrolls the list
//     and the page wheel is cancelled, 8. it stops at the end, 9. wheel up at
//     the top is left to the page, 10. click-and-drag moves the list, 11. a
//     wheel stops a coasting list.
// Usage: node --import tsx snack-server/tools/result-scroll-e2e.mjs [--skip-build] [--base <url>]
//   --base: check an already running player (dev server or a deploy) instead of a build.
// Port: RS_E2E_PORT (else 4530) for the static build.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";
import { runGate } from "./_gate.mjs";
import { buildResultView } from "../../snack-player/src/quizResult.ts"; // needs --import tsx

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");
const GIVEN = argv.includes("--base") ? argv[argv.indexOf("--base") + 1].replace(/\/?$/, "") : null;
const PORT = Number(process.env.RS_E2E_PORT || 4530);
const OUT = join(tmpdir(), "snack-result-scroll-e2e-dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the player ────────────────────────────────────────────────────────────
let server = null;
let BASE = GIVEN;
if (!BASE) {
  if (!SKIP_BUILD || !existsSync(join(OUT, "index.html"))) {
    const env = { ...process.env };
    delete env.VITE_SERVER_URL;
    const b = spawnSync("pnpm", ["-s", "--filter", "@snack/player", "build", "--outDir", OUT, "--emptyOutDir"], { cwd: ROOT, env, encoding: "utf8" });
    if (b.status !== 0) {
      console.error(b.stdout, b.stderr);
      runGate("result-scroll-e2e", [{ id: "build", ok: false }], (r) => r.ok);
      process.exit(1);
    }
  }
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) return void res.writeHead(204).end();
    let file = join(OUT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(OUT) || !existsSync(file) || !extname(file)) file = join(OUT, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${PORT}`;
}

// ── a 10-question result (3 answerers) ────────────────────────────────────
const NICKS = ["하늘", "도윤", "지은"];
const input = {
  quizRecap: {
    subject: "민수", about: "민수", title: "민수 맞히기", packId: "p",
    rounds: Array.from({ length: 10 }, (_, i) => ({
      q: `${i + 1}번 문제: 민수가 제일 좋아하는 것은?`, options: ["가", "나", "다", "라"], answer: i % 4,
      picks: NICKS.map((nick, k) => ({ pid: `pid-${nick}`, nick, option: (i + k) % 4, ms: 2000, correct: (i + k) % 4 === i % 4, points: (i + k) % 4 === i % 4 ? 800 : 0 })),
    })),
  },
  raceBoard: NICKS.map((nick) => ({ pid: `pid-${nick}`, nick, score: 1000 })),
  roster: ["민수", ...NICKS],
  quizInfo: { title: "민수 맞히기", count: 10, custom: true, about: "민수", packId: "p" },
  myNick: "지은",
};
const VARS = { sessionPhase: "result", resultView: buildResultView(input), raceBoard: input.raceBoard, roster: input.roster, reactionStage: "ask" };

// ── helpers ───────────────────────────────────────────────────────────────
async function open(browser, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?bite=/data/bite/speed-trivia-score.bite.json`);
  await page.waitForFunction(() => Boolean(globalThis.__bite?.app), null, { timeout: 30000 });
  await page.evaluate((v) => {
    globalThis.__bite.app.setVars(v);
    globalThis.__bite.refresh();
    globalThis.__events = [];
    globalThis.__wheels = []; // defaultPrevented of each wheel, as the page sees it
    addEventListener("wheel", (e) => globalThis.__wheels.push(e.defaultPrevented));
    for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) addEventListener(t, () => globalThis.__events.push(t), true);
  }, VARS);
  await sleep(300);
  const info = await page.evaluate(() => {
    const v = globalThis.__bite;
    let found = null, ox = 0, oy = 0;
    const walk = (inst, x, y) => {
      const ax = x + inst.box.x, ay = y + inst.box.y;
      if (inst.node?.id === "resBody") { found = inst; ox = ax; oy = ay; }
      for (const c of inst.children) walk(c, ax, ay);
    };
    walk(v.scene.root, -v.scene.root.box.x, -v.scene.root.box.y);
    if (!found) return null;
    const tl = v.toClient(ox, oy), br = v.toClient(ox + found.box.w, oy + found.box.h);
    const canvasTop = document.querySelector("canvas").getBoundingClientRect().top;
    return { key: found.key, max: (found.contentSize?.h ?? 0) - found.box.h, x: (tl.x + br.x) / 2, top: tl.y, h: br.y - tl.y, scale: v.scale, canvasTop };
  });
  return { ctx, page, info, errors };
}
const state = (page, key) => page.evaluate((k) => ({ y: globalThis.__bite.scroll.get(k)?.y ?? 0, flinging: Boolean(globalThis.__bite.flinging), events: [...globalThis.__events] }), key);
const reset = (page, key) => page.evaluate((k) => { globalThis.__bite.scroll.delete(k); globalThis.__bite.refresh(); globalThis.__events.length = 0; }, key);
async function settle(page, key) {
  for (let t = 0; t < 4000; t += 100) {
    if (!(await state(page, key)).flinging) break;
    await sleep(100);
  }
  return state(page, key);
}
/** Chromium: a finger over CDP — the browser's own touch → pointer path. */
async function touchDrag(page, x, y0, y1, steps, stepMs) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (y) => [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  // Headless Chromium acks each CDP touch only after a frame (~150 ms apart), so
  // the events carry the finger's own timing (a phone sends one per 8–16 ms).
  const t0 = Date.now() / 1000;
  const at = (ms) => t0 + ms / 1000;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(y0), timestamp: at(0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(y0 + ((y1 - y0) * i) / steps), timestamp: at(i * stepMs) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: at(steps * stepMs + 4) });
  await cdp.detach();
}
/** WebKit: pointer events as iOS sends them for a finger (pointerType touch), one per frame. */
async function pointerDrag(page, x, y0, y1, steps, stepMs) {
  await page.evaluate(async ({ x, y0, y1, steps, stepMs }) => {
    const target = document.elementFromPoint(x, y0);
    const ev = (type, y) => new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === "pointerup" ? 0 : 1 });
    target.dispatchEvent(ev("pointerdown", y0));
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, stepMs));
      target.dispatchEvent(ev("pointermove", y0 + ((y1 - y0) * i) / steps));
    }
    target.dispatchEvent(ev("pointerup", y1));
  }, { x, y0, y1, steps, stepMs });
}

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${id}  (${detail})`);
};

const CONFIGS = [
  { name: "Android 390×844", type: chromium, opts: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  { name: "Android 360×640", type: chromium, opts: { ...devices["Pixel 7"], viewport: { width: 360, height: 640 } } },
  { name: "iPhone 13 390×844", type: webkit, opts: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } } },
  { name: "iPhone 13 360×640", type: webkit, opts: { ...devices["iPhone 13"], viewport: { width: 360, height: 640 } } },
  { name: "Desktop Chrome 1280×800", type: chromium, desktop: true, opts: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
];

const browsers = new Map();
try {
  for (const c of CONFIGS) {
    let browser = browsers.get(c.type);
    if (!browser) {
      try {
        browser = await c.type.launch();
      } catch (e) {
        check(`${c.name}: browser`, false, `${c.type.name()} not installed — npx playwright install ${c.type.name()} (${String(e.message).split("\n")[0]})`);
        continue;
      }
      browsers.set(c.type, browser);
    }
    const { ctx, page, info, errors } = await open(browser, c.opts);
    try {
      if (!info) { check(`${c.name}: list shown`, false, "resBody not on screen"); continue; }
      check(`${c.name}: 10 questions overflow the list`, info.max > 400, `can scroll ${Math.round(info.max)} units, scale ${info.scale.toFixed(3)}, canvas top ${info.canvasTop}px`);
      const x = info.x, y0 = info.top + info.h * 0.85, y1 = info.top + info.h * 0.25;
      const finger = (y0 - y1) / info.scale; // frame units the finger travels
      const isChromium = c.type === chromium;
      const drag = isChromium ? touchDrag : pointerDrag;

      if (c.desktop) {
        // 7–11. a PC browser (#117): wheel / trackpad and click-and-drag
        const mid = info.top + info.h / 2;
        await page.mouse.move(x, mid);
        await page.mouse.wheel(0, 300);
        await sleep(200);
        let s = await state(page, info.key);
        let w = await page.evaluate(() => globalThis.__wheels.splice(0));
        check(`${c.name}: mouse wheel scrolls the list`, Math.abs(s.y - 300 / info.scale) < 2 && w.length > 0 && w.every(Boolean), `wheel 300px → ${Math.round(s.y)} of ${Math.round(300 / info.scale)} units; page wheel cancelled ${w.join(",")}`);
        await page.mouse.wheel(0, 100000);
        await sleep(200);
        s = await state(page, info.key);
        check(`${c.name}: wheel stops at the end of the list`, Math.abs(s.y - info.max) < 0.5, `${Math.round(s.y)} / max ${Math.round(info.max)}`);
        await reset(page, info.key);
        await page.evaluate(() => globalThis.__wheels.splice(0));
        await page.mouse.wheel(0, -200);
        await sleep(200);
        s = await state(page, info.key);
        w = await page.evaluate(() => globalThis.__wheels.splice(0));
        check(`${c.name}: wheel up at the top is left to the page`, s.y === 0 && w.length > 0 && !w.some(Boolean), `y ${s.y}; cancelled ${w.join(",")}`);

        // click-and-drag with the mouse
        await reset(page, info.key);
        await page.mouse.move(x, y0);
        await page.mouse.down();
        for (let i = 1; i <= 15; i++) { await page.mouse.move(x, y0 + ((y1 - y0) * i) / 15); await sleep(16); }
        await sleep(120); // rest before release: no fling
        await page.mouse.up();
        s = await settle(page, info.key);
        check(`${c.name}: click-and-drag moves the list`, s.y >= finger * 0.85 && !s.events.includes("pointercancel"), `moved ${Math.round(s.y)} of ${Math.round(finger)} units`);

        // a wheel catches a coasting list
        await reset(page, info.key);
        await page.mouse.move(x, info.top + info.h * 0.7);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) { await page.mouse.move(x, info.top + info.h * 0.7 - 16 * i); await sleep(10); }
        await page.mouse.up();
        const coasting = (await state(page, info.key)).flinging;
        await page.mouse.wheel(0, 10);
        await sleep(50);
        const caught = await state(page, info.key);
        await sleep(300);
        const after = await state(page, info.key);
        check(`${c.name}: the wheel stops a coasting list`, coasting && !caught.flinging && Math.abs(after.y - caught.y) < 0.5, `coasting ${coasting} → flinging ${caught.flinging}, ${Math.round(caught.y)} → ${Math.round(after.y)}`);
        if (errors.length) check(`${c.name}: no page errors`, false, errors.join(" | "));
        continue;
      }

      // 1/4. slow drag: the list follows the finger
      await drag(page, x, y0, y1, 15, 16);
      let s = await settle(page, info.key);
      check(`${c.name}: slow drag moves the list with the finger`, s.y >= finger * 0.85 && !s.events.includes("pointercancel"), `moved ${Math.round(s.y)} of ${Math.round(finger)} units; ${s.events.includes("pointercancel") ? "pointercancel" : "no cancel"}`);

      if (isChromium) {
        // 2. the browser claims the pan (touch-action not honoured)
        await reset(page, info.key);
        await page.evaluate(() => { document.querySelector("canvas").style.touchAction = "auto"; });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(x), y: Math.round(y0), yDistance: -Math.round(y0 - y1), speed: 600, gestureSourceType: "touch" });
        await cdp.detach();
        s = await settle(page, info.key);
        check(`${c.name}: list still follows when the browser would take the pan`, s.y >= finger * 0.85 && !s.events.includes("pointercancel"), `moved ${Math.round(s.y)} of ${Math.round(finger)} units; ${s.events.includes("pointercancel") ? "browser sent pointercancel" : "no cancel"}`);
        await page.evaluate(() => { document.querySelector("canvas").style.touchAction = "none"; });
      } else {
        // 6. the iOS guard: touchmove on the canvas is cancelled
        const prevented = await page.evaluate(() => {
          const e = new Event("touchmove", { bubbles: true, cancelable: true });
          document.querySelector("canvas").dispatchEvent(e);
          return e.defaultPrevented;
        });
        check(`${c.name}: canvas cancels touchmove (browser cannot take the pan)`, prevented, `defaultPrevented=${prevented}`);
      }

      // 3/5. flick: 80px in ~50ms, lift at speed → the list keeps going, then stops
      await reset(page, info.key);
      const fy0 = info.top + info.h * 0.7;
      await drag(page, x, fy0, fy0 - 80, 5, 10);
      const right = await state(page, info.key);
      s = await settle(page, info.key);
      const flickFinger = 80 / info.scale;
      check(`${c.name}: a flick keeps scrolling after the finger lifts`, s.y > flickFinger * 1.5 && !s.flinging, `finger ${Math.round(flickFinger)} units → ${Math.round(right.y)} at lift, ${Math.round(s.y)} settled`);
      if (errors.length) check(`${c.name}: no page errors`, false, errors.join(" | "));
    } finally {
      await ctx.close();
    }
  }
} finally {
  for (const b of browsers.values()) await b.close();
  server?.close();
}

runGate("result-scroll-e2e", results, (r) => r.ok);
