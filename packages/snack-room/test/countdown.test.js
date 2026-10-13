import { test } from "node:test";
import assert from "node:assert/strict";
import { localCountdown } from "../src/countdown.js";

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

test("countdown: a reset from the host stops the local run; inactive → values pass through", () => {
  const h = harness();
  assert.equal(h.cd.intercept(3), false); // nothing running: delivered as usual
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
