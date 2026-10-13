import { test } from "node:test";
import assert from "node:assert/strict";
import { localCountdown, countdownState } from "../src/countdown.js";

// Deterministic clock + timer queue.
function harness() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const shown = []; // [value, at]
  const cd = localCountdown({
    deliver: (type, d) => shown.push([d.value, t]),
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advanceTo = (end) => {
    for (;;) {
      const next = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { cd, shown, advanceTo, timers };
}

test("countdown: one 'ends in N ms' message drives 3·2·1·0 on the local clock", () => {
  const h = harness();
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 });
  h.advanceTo(5000);
  assert.deepEqual(h.shown, [[3, 0], [2, 1000], [1, 2000], [0, 3000]]);
  assert.equal(h.cd.active, false);
  assert.equal(h.timers.size, 0);
});

test("countdown: a host number that arrives late is swallowed, never shown out of order", () => {
  const h = harness();
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 });
  h.advanceTo(1300);
  assert.equal(h.cd.intercept(2), true); // the host's "2", 300 ms late: implies the end at 3300 — later than known
  h.advanceTo(2050);
  assert.equal(h.cd.intercept(1), true);
  h.advanceTo(3000);
  assert.equal(h.cd.intercept(0), true); // play: the driver already showed 0 → the host's own 0 is a duplicate
  assert.equal(h.cd.active, false);
  assert.deepEqual(h.shown, [[3, 0], [2, 1000], [1, 2000], [0, 3000]]);
});

test("countdown: a later message that arrived faster pulls the deadline earlier (minimum filter)", () => {
  // The "countdown" message was 300 ms late (the true end is at 2700 in local time); the
  // host's "2" came 50 ms late → it says the end is at 2750 → closer to the truth.
  const h = harness();
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 });
  h.advanceTo(750);
  assert.equal(h.cd.intercept(2), true); // "2 s left" → shown now, and the end moves to 2750
  h.advanceTo(4000);
  assert.deepEqual(h.shown, [[3, 0], [2, 750], [1, 1750], [0, 2750]]);
});

test("countdown: the 'countdown' message was lost — the host's first number starts the driver", () => {
  const h = harness();
  assert.equal(h.cd.intercept(0), false); // nothing running: a 0 is delivered as usual
  h.advanceTo(100);
  assert.equal(h.cd.intercept(3), true); // "3 steps left" → the driver starts and shows it
  assert.equal(h.cd.active, true);
  h.advanceTo(5000); // the host's 2 and 1 are lost too
  assert.deepEqual(h.shown, [[3, 100], [2, 1100], [1, 2100], [0, 3100]]);
});

test("countdown: three devices converge on the deadline within the smallest delay each one saw", () => {
  // The host sends: countdown(3000) at 0, "2" at 1000, "1" at 2000, resyncs ("2") at 1300, 1700.
  // Each device sees every message with its own delay; the end it shows must be within
  // min(delays) of the truth (3000) — not the delay of the first message.
  const sends = [
    ["start", 0, 3000],
    ["num", 1000, 2],
    ["num", 1300, 2],
    ["num", 1700, 2],
    ["num", 2000, 1],
  ];
  const devices = [
    [300, 50, 250, 120, 280], // the countdown message came late, a resync came fast
    [80, 290, 200, 260, 30],
    [150, 150, 150, 150, 150],
  ];
  const ends = devices.map((delays) => {
    const h = harness();
    const events = sends.map(([kind, at, v], i) => ({ kind, at: at + delays[i], v })).sort((a, b) => a.at - b.at);
    for (const e of events) {
      h.advanceTo(e.at);
      if (e.kind === "start") h.cd.start({ n: 3, stepMs: 1000, endsIn: e.v });
      else h.cd.intercept(e.v);
    }
    h.advanceTo(6000);
    assert.deepEqual(h.shown.map(([v]) => v), [3, 2, 1, 0]); // in order, nothing skipped
    return [h.shown.at(-1)[1], Math.min(...delays)];
  });
  for (const [end, minDelay] of ends) assert.ok(end - 3000 <= minDelay && end >= 3000, `end ${end}, min delay ${minDelay}`);
  // Devices differ by at most the difference of their best delays (50 / 30 / 150 → 120 ms),
  // not by the delay of whichever message happened to come first (up to 300 − 30 = 270).
  const spread = Math.max(...ends.map(([e]) => e)) - Math.min(...ends.map(([e]) => e));
  const bestDelays = ends.map(([, d]) => d);
  assert.ok(spread <= Math.max(...bestDelays) - Math.min(...bestDelays), `spread ${spread} ms`);
  assert.deepEqual(ends.map(([e]) => e), [3050, 3030, 3150]);
});

test("countdown: a resent room state mid-count feeds the driver instead of showing a stale number", () => {
  const h = harness();
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 });
  h.advanceTo(1500); // showing 2
  const d = countdownState({ sharedState: { sessionCountdown: 3, sessionPhase: "countdown" }, participants: 3 }, h.cd);
  assert.deepEqual(d, { sharedState: { sessionPhase: "countdown" }, participants: 3 }); // the stale 3 is stripped …
  h.advanceTo(4000);
  assert.deepEqual(h.shown, [[3, 0], [2, 1000], [1, 2000], [0, 3000]]); // … and the count is unchanged
  const lobby = { sharedState: { sessionCountdown: 0, sessionPhase: "lobby" }, participants: 3 };
  assert.deepEqual(countdownState(lobby, h.cd), { sharedState: { sessionPhase: "lobby" }, participants: 3 }); // the driver just showed 0: a repeat
  assert.deepEqual(countdownState(lobby, h.cd), lobby); // nothing running any more: passes as is
  assert.deepEqual(countdownState({ participants: 1 }, h.cd), { participants: 1 });
});

test("countdown: a reset from the host stops the local run; inactive → a 0 passes through", () => {
  const h = harness();
  assert.equal(h.cd.intercept(0), false);
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 });
  h.advanceTo(500);
  assert.equal(h.cd.intercept(0), false); // back to the lobby
  assert.equal(h.cd.active, false);
  h.advanceTo(5000);
  assert.deepEqual(h.shown, [[3, 0]]);
  h.cd.start({ n: 3, stepMs: 1000, endsIn: 3000 }); // the next game counts again
  h.advanceTo(9000);
  assert.deepEqual(h.shown.slice(1), [[3, 5000], [2, 6000], [1, 7000], [0, 8000]]);
  assert.equal(h.cd.intercept(0), true); // the host's 0 for this game is a repeat …
  assert.equal(h.cd.intercept(0), false); // … a later one (lobby) is not
});
