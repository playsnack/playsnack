// The renderer's input geometry and fling physics (#105). Pure — no Pixi, no DOM.
//   node --test packages/bite-pixi/test/   (pnpm bite:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { clampScroll, clientToFrame, fitFrame, flings, releaseVelocity, stepFling } from "../src/gesture.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("fitFrame: contain, centred", () => {
  assert.deepEqual(fitFrame(390, 844, 390, 844), { scale: 1, x: 0, y: 0 });
  const f = fitFrame(360, 640, 390, 844); // a short phone: height-bound
  close(f.scale, 640 / 844);
  close(f.x, (360 - 390 * f.scale) / 2);
  assert.equal(f.y, 0);
  const g = fitFrame(390, 1000, 390, 844); // a tall area: width-bound
  assert.equal(g.scale, 1);
  assert.equal(g.y, 78);
});

test("clientToFrame inverts the renderer's frame → client mapping, wherever the canvas sits", () => {
  // 360×640 with the canvas dropped 14px below a 47px notch (canvasFit) — the
  // shape the result list is dragged on (#105).
  for (const [w, h, top] of [[390, 844, 0], [360, 640, 61], [375, 667, 47], [390, 664, 0]]) {
    const fit = fitFrame(w, h - top, 390, 844);
    const rect = { left: 0, top };
    for (const [fx, fy] of [[0, 0], [195, 422], [389, 843], [32.5, 600.25]]) {
      const cx = rect.left + fit.x + fx * fit.scale;
      const cy = rect.top + fit.y + fy * fit.scale;
      const p = clientToFrame(cx, cy, rect, fit);
      close(p.x, fx, 1e-9);
      close(p.y, fy, 1e-9);
    }
  }
});

test("clampScroll keeps the offset inside the content", () => {
  assert.equal(clampScroll(-5, 100), 0);
  assert.equal(clampScroll(50, 100), 50);
  assert.equal(clampScroll(150, 100), 100);
  assert.equal(clampScroll(10, -20), 0); // content shorter than the box
});

test("releaseVelocity: a flick carries on, a stop-then-lift does not", () => {
  // finger moves up 60 units in 48ms and lifts right away → content moves down the list
  const flick = [{ t: 0, y: 500 }, { t: 16, y: 480 }, { t: 32, y: 460 }, { t: 48, y: 440 }];
  const v = releaseVelocity(flick, 50);
  close(v, 60 / 48);
  assert.ok(flings(v));
  // the same flick, then the finger rests 80ms before lifting
  assert.equal(releaseVelocity(flick, 128), 0);
  // a slow drag long ago, then a short recent movement: only the recent window counts
  const slowThenFast = [{ t: 0, y: 800 }, { t: 400, y: 700 }, { t: 450, y: 700 }, { t: 466, y: 670 }];
  close(releaseVelocity(slowThenFast, 470), 30 / 66);
  assert.equal(releaseVelocity([{ t: 0, y: 10 }], 5), 0);
  assert.ok(!flings(0.01));
});

test("stepFling decays to a stop and never leaves the content", () => {
  let y = 100;
  let v = 2; // frame units / ms
  let frames = 0;
  let done = false;
  while (!done && frames < 1000) {
    ({ y, v, done } = stepFling(y, v, 16, 10_000));
    frames++;
  }
  assert.ok(done, "stops");
  assert.ok(frames < 200, `stops within ~3s (${frames} frames)`);
  // total travel ≈ v0 / −ln(friction) = 2 / 0.005 ≈ 400 units, minus the tail below the stop threshold
  assert.ok(y > 100 + 350 && y < 100 + 400, `travelled ${y - 100}`);
  // frame-rate independent: one 32ms step ≈ two 16ms steps
  const a = stepFling(0, 1, 32, 1e6);
  const b1 = stepFling(0, 1, 16, 1e6);
  const b2 = stepFling(b1.y, b1.v, 16, 1e6);
  close(a.y, b2.y, 1e-9);
  // hits the end → clamped and done
  const end = stepFling(990, 3, 16, 1000);
  assert.equal(end.y, 1000);
  assert.ok(end.done);
  const top = stepFling(5, -3, 16, 1000);
  assert.equal(top.y, 0);
  assert.ok(top.done);
});
