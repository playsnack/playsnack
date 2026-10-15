// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ECHO_WINDOW_MS, EchoFilter, OWN_BURST, REACTION_CAP, ReactionQueue, keyframesFor, planBurst } from "../src/reactionFx.ts";

// A deterministic stand-in for Math.random.
const seq = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test("cap: never more than REACTION_CAP on screen; the oldest leaves first", () => {
  assert.equal(REACTION_CAP, 24);
  const q = new ReactionQueue<number>();
  const evicted: number[] = [];
  for (let i = 0; i < 200; i++) evicted.push(...q.add(i)); // a 200-player room all tapping at once
  assert.equal(q.size, REACTION_CAP);
  assert.deepEqual(evicted, Array.from({ length: 200 - REACTION_CAP }, (_, i) => i));
  q.remove(199);
  q.remove(12345); // unknown id: no-op
  assert.equal(q.size, REACTION_CAP - 1);
  assert.deepEqual(q.add(500), []);
});

test("burst: my own tap is OWN_BURST particles at once-ish, anyone else's is one", () => {
  const mine = planBurst("🔥", true, seq(3));
  assert.equal(mine.length, OWN_BURST);
  assert.equal(mine[0].delay, 0); // the lead one shows immediately (no round trip)
  assert.ok(mine.every((p) => p.emoji === "🔥" && p.x >= 4 && p.x <= 88));
  assert.ok(mine[0].size >= 50, "the lead one is big"); // was 34px before #121
  assert.ok(mine.slice(1).every((p) => p.delay > 0 && p.delay < 400 && p.size < mine[0].size));
  const theirs = planBurst("❤️", false, seq(7));
  assert.equal(theirs.length, 1);
  assert.equal(planBurst("", true).length, 0);
});

test("stack and scatter: many reactions land in different spots, linger 2.5–3.5 s", () => {
  const rnd = seq(11);
  const ps = Array.from({ length: 12 }, () => planBurst("😂", false, rnd)[0]);
  const xs = new Set(ps.map((p) => Math.round(p.x / 5)));
  assert.ok(xs.size >= 5, `spread across the width (${xs.size} buckets)`);
  for (const p of ps) {
    assert.ok(p.duration >= 2500 && p.duration <= 3500, `duration ${p.duration}`);
    assert.ok(p.rise >= 300, "floats well up the screen");
    assert.ok(Math.abs(p.sway) >= 14, "sways");
  }
});

test("motion: pops in with an overshoot, stays opaque most of the way, fades at the end — transform/opacity only", () => {
  const p = planBurst("👍", false, seq(5))[0];
  const f = keyframesFor(p, false);
  for (const k of f) assert.deepEqual(Object.keys(k).sort(), ["offset", "opacity", "transform"]);
  const scale = (t: string) => Number(/scale\(([\d.]+)\)/.exec(t)![1]);
  assert.ok(Math.max(...f.map((k) => scale(k.transform))) > 1.3, "overshoot");
  assert.equal(f[0].opacity, 0);
  assert.equal(f.at(-1)!.opacity, 0);
  const opaqueUntil = Math.max(...f.filter((k) => k.opacity === 1).map((k) => k.offset!));
  assert.ok(opaqueUntil >= 0.7, "lingers fully visible");
  const offs = f.map((k) => k.offset!);
  assert.deepEqual(offs, [...offs].sort((a, b) => a - b));
});

test("reduced motion: a plain fade in place (no movement, no scale)", () => {
  const f = keyframesFor(planBurst("😮", true, seq(9))[0], true);
  assert.ok(f.every((k) => k.transform === "none"));
  assert.deepEqual(f.map((k) => k.opacity), [0, 1, 1, 0]);
});

test("local echo: my tap shows at once, the room's echo of it is skipped exactly once", () => {
  const e = new EchoFilter();
  e.sent("🔥", 1000);
  e.sent("🔥", 1100);
  assert.equal(e.incoming("❤️", 1200), true); // someone else's
  assert.equal(e.incoming("🔥", 1300), false); // echo of tap 1
  assert.equal(e.incoming("🔥", 1400), false); // echo of tap 2
  assert.equal(e.incoming("🔥", 1500), true); // a third 🔥 is someone else's
});

test("local echo: an echo that never came back expires (others' same emoji still show)", () => {
  const e = new EchoFilter();
  e.sent("👍", 0);
  assert.equal(e.incoming("👍", ECHO_WINDOW_MS + 1), true);
});
