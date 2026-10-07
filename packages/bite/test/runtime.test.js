import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../src/runtime.js";

const reaction = JSON.parse(readFileSync(new URL("./fixtures/reaction.bite.json", import.meta.url), "utf8"));

// Headless harness: a controllable clock and a fixed random.
function harness(doc, { random = () => 0 } = {}) {
  let t = 0;
  const warnings = [];
  const app = createBite(doc, { now: () => t, random, warn: (m) => warnings.push(m) });
  return {
    app,
    warnings,
    advance(ms) {
      t += ms;
      return app.tick();
    },
  };
}

const doc = (over) => ({
  bite: 1,
  meta: { name: "t" },
  frame: [390, 844],
  vars: { n: 0, log: [] },
  start: "a",
  phases: { a: {}, b: {} },
  view: { box: "free", children: [] },
  ...over,
});

test("reaction test plays end to end (spec §9 example)", () => {
  const h = harness(reaction); // random 0 → delayMs = 1200
  const { app } = h;
  app.start();
  assert.equal(app.phase, "ready");

  assert.equal(app.tap("pad"), true);
  assert.equal(app.phase, "wait");
  assert.equal(app.vars.delayMs, 1200);
  assert.equal(app.vars.greenAt, 1200);

  h.advance(1000);
  assert.equal(app.phase, "wait");
  h.advance(200);
  assert.equal(app.phase, "green");

  h.advance(234);
  app.tap("pad");
  assert.equal(app.phase, "done");
  assert.equal(app.vars.lastMs, 234);
  assert.equal(app.vars.bestMs, 234);
  assert.equal(app.value("{phase == 'done' ? lastMs + 'ms' : ''}"), "234ms");

  // Tapping too early fails; bestMs keeps the earlier record.
  app.tap("pad");
  assert.equal(app.phase, "wait");
  app.tap("pad");
  assert.equal(app.phase, "fail");
  assert.equal(app.vars.bestMs, 234);
  assert.deepEqual(h.warnings, []);
});

test("go is applied after the remaining actions, last go wins", () => {
  const { app } = harness(
    doc({
      phases: { a: {}, b: { enter: [{ set: "n", to: "n + 100" }] }, c: {} },
      view: {
        box: "free",
        children: [{ id: "btn", onTap: [{ go: "c" }, { set: "n", to: "phase == 'a' ? 1 : 2" }, { go: "b" }] }],
      },
    }),
  );
  app.start();
  app.tap("btn");
  assert.equal(app.phase, "b");
  assert.equal(app.vars.n, 101); // set ran while still in 'a', then b.enter
});

test("go to the current phase does not re-run enter", () => {
  const { app } = harness(doc({ phases: { a: { enter: [{ set: "n", to: "n + 1" }], tick: [{ go: "a" }] } } }));
  app.start();
  app.tick();
  app.tick();
  assert.equal(app.vars.n, 1);
});

test("tick routing follows host-set variables (multiplayer pattern)", () => {
  const h = harness(
    doc({
      vars: { session: "lobby" },
      start: "lobby",
      phases: {
        lobby: { tick: [{ if: "session == 'play'", then: [{ go: "play" }] }] },
        play: { tick: [{ if: "session == 'result'", then: [{ go: "result" }] }] },
        result: {},
      },
    }),
  );
  h.app.start();
  h.advance(16);
  assert.equal(h.app.phase, "lobby");
  h.app.setVar("session", "play");
  h.advance(16);
  assert.equal(h.app.phase, "play");
  h.app.setVars({ session: "result", stranger: 1 });
  h.advance(16);
  assert.equal(h.app.phase, "result");
});

test("enter chains are followed but loops are stopped", () => {
  const { app, warnings } = harness(doc({ phases: { a: { enter: [{ go: "b" }] }, b: { enter: [{ go: "a" }] } } }));
  app.start();
  assert.ok(["a", "b"].includes(app.phase));
  assert.ok(warnings.some((w) => /loop/.test(w)));
});

test("change reports changed variables, phase and now once per tick", () => {
  const { app } = harness(doc({ phases: { a: {}, b: {} }, view: { box: "free", children: [{ id: "x", onTap: [{ set: "n", to: "1" }, { go: "b" }] }] } }));
  const seen = [];
  app.on("change", (c) => seen.push(c.sort()));
  app.start();
  app.tick();
  app.tap("x");
  app.setVar("n", 1); // same value → not a change
  app.tick();
  app.tick();
  assert.deepEqual(seen, [["now", "phase"], ["n", "now", "phase"], ["now"]]);
});

test("tap respects onTap presence and hidden nodes/ancestors", () => {
  const { app } = harness(
    doc({
      vars: { open: false, n: 0 },
      view: {
        box: "free",
        children: [
          { id: "panel", show: "open", children: [{ id: "inner", onTap: [{ set: "n", to: "n + 1" }] }] },
          { id: "plain" },
        ],
      },
    }),
  );
  app.start();
  assert.equal(app.tap("plain"), false);
  assert.equal(app.tap("inner"), false);
  app.setVar("open", true);
  assert.equal(app.tap("inner"), true);
  assert.equal(app.vars.n, 1);
});

test("tap inside each receives item and index", () => {
  const row = { id: "row", onTap: [{ set: "picked", to: "item.name + index" }] };
  const { app } = harness(
    doc({ vars: { picked: "", list: [{ name: "a" }, { name: "b" }] }, view: { box: "column", each: "list", children: [row] } }),
  );
  app.start();
  app.tap("row", { item: { name: "b" }, index: 1 });
  assert.equal(app.vars.picked, "b1");
});

test("emit resolves payload templates", () => {
  const { app } = harness(
    doc({ vars: { choice: 2 }, view: { box: "free", children: [{ id: "v", onTap: [{ emit: "vote", payload: { option: "{choice}", label: "옵션 {choice}", fixed: 1 } }] }] } }),
  );
  const events = [];
  app.on("emit", (e) => events.push(e));
  app.start();
  app.tap("v");
  assert.deepEqual(events, [{ name: "vote", payload: { option: 2, label: "옵션 2", fixed: 1 } }]);
});

test("set value is a deep copy; undeclared set/host vars are ignored with a warning", () => {
  const initial = { a: [1] };
  const d = doc({ vars: { n: 0, o: null }, view: { box: "free", children: [{ id: "s", onTap: [{ set: "o", value: initial }, { set: "ghost", to: "1" }] }] } });
  const { app, warnings } = harness(d);
  app.start();
  app.tap("s");
  initial.a.push(2);
  assert.deepEqual(app.vars.o, { a: [1] });
  app.setVar("nope", 1);
  assert.equal(Object.hasOwn(app.vars, "ghost"), false);
  assert.equal(warnings.length, 2);
  assert.equal(d.vars.n, 0); // the document itself is never mutated
});

test("same doc + same clock/random → same trajectory", () => {
  const play = () => {
    let r = 0.1;
    const h = harness(reaction, { random: () => (r = (r * 9301 + 49297) % 233280 / 233280) });
    h.app.start();
    const trace = [];
    for (let i = 0; i < 3; i++) {
      h.app.tap("pad");
      for (let f = 0; f < 300 && h.app.phase === "wait"; f++) h.advance(16);
      h.advance(180 + i * 40);
      h.app.tap("pad");
      trace.push([h.app.phase, h.app.vars.lastMs, h.app.vars.bestMs]);
    }
    return trace;
  };
  assert.deepEqual(play(), play());
});
