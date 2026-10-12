// Room-action payload contract (T-01) + literal ranges (T-02).
// The contract lives in @snack/room (HOST_ACTIONS); these tests import it and the
// real room engine by path so a change on either side that breaks the other —
// or a template that sends what the room drops — fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validate } from "../src/validate.js";
import { createBite } from "../src/runtime.js";
import { HOST_ACTIONS } from "../../snack-room/src/actions.js";
import { createRoom } from "../../snack-room/src/room.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.bite.json`, import.meta.url), "utf8"));
const withContract = (doc) => validate(doc, { hostActions: HOST_ACTIONS });
const lines = (issues) => issues.map((e) => `${e.path}: ${e.message}`);

// A tiny doc that emits one action (optionally with extra vars).
const emitDoc = (emit, vars = {}) => ({
  bite: 1,
  meta: { name: "t" },
  frame: [390, 844],
  vars: { n: 0, ...vars },
  start: "a",
  phases: { a: {} },
  view: { box: "column", children: [{ id: "b", text: "{n}", onTap: [emit] }] },
});
const errorsOf = (emit, vars) => lines(withContract(emitDoc(emit, vars)).errors);
const warningsOf = (emit, vars) => lines(withContract(emitDoc(emit, vars)).warnings);
const assertHas = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected ${re} in:\n${list.join("\n")}`);
const assertNone = (list) => assert.deepEqual(list, []);

// ── negative fixtures ──
test("T-01: race-tap style {score: \"score\"} fails — with or without the contract", () => {
  const doc = fixture("bad-score-literal");
  for (const r of [validate(doc), withContract(doc)]) {
    assert.equal(r.ok, false);
    assertHas(lines(r.errors), /payload\.score: sends the literal text "score".*did you mean "\{score\}"\?/);
  }
});

test("T-02: origin [50, 50] fails", () => {
  const r = validate(fixture("bad-origin"));
  assert.equal(r.ok, false);
  assertHas(lines(r.errors), /origin: origin is a fraction .*0–1.*\[50,50\]/);
});

test("opacity 3 fails; text weight outside 100–900 fails", () => {
  const r = validate(fixture("bad-opacity"));
  assert.equal(r.ok, false);
  assertHas(lines(r.errors), /opacity: opacity must be 0–1, got 3/);
  const heavy = emitDoc({ emit: "tap" });
  heavy.view.children[0].weight = 1000;
  assertHas(lines(validate(heavy).errors), /weight must be 100–900, got 1000/);
  heavy.view.children[0].weight = 50;
  assertHas(lines(validate(heavy).errors), /weight must be 100–900, got 50/);
  const neg = emitDoc({ emit: "tap" });
  neg.view.children[0].origin = [0.5, -0.1];
  assertHas(lines(validate(neg).errors), /origin is a fraction/);
});

// ── positive fixture ──
test("every room action sent the right way: no errors, no contract warnings", () => {
  const r = withContract(fixture("good-room"));
  assertNone(lines(r.errors));
  assertNone(lines(r.warnings));
});

// ── contract checks ──
test("missing required field / payload", () => {
  assertHas(errorsOf({ emit: "score" }), /'score' needs a payload \{ score \}/);
  assertHas(errorsOf({ emit: "score", payload: { points: "{n}" } }), /'score' needs 'score'/);
  assertHas(errorsOf({ emit: "vote", payload: {} }), /'vote' needs 'option'/);
  assertHas(errorsOf({ emit: "answer" }), /'answer' needs a payload \{ option \}/);
});

test("non-object payload", () => {
  assertHas(errorsOf({ emit: "vote", payload: "o0" }), /'vote' payload must be an object/);
  assertHas(errorsOf({ emit: "score", payload: 37 }), /'score' payload must be an object/);
  assertHas(errorsOf({ emit: "start", payload: [1] }), /'start' payload must be an object .* or a number/);
  assertNone(errorsOf({ emit: "start", payload: 12000 })); // bare number = duration
});

test("wrong literal type", () => {
  assertHas(errorsOf({ emit: "score", payload: { score: "high" } }), /'score' must be a number, got the text "high"/);
  assertHas(errorsOf({ emit: "answer", payload: { option: "B" } }), /'option' must be a number/);
  assertHas(errorsOf({ emit: "start", payload: { quiz: "true" } }), /'quiz' must be a boolean/);
  assertHas(errorsOf({ emit: "start", payload: { game: 3 } }), /'game' must be a string/);
  assertHas(errorsOf({ emit: "vote", payload: { option: true } }), /'option' must be a string \| number/);
});

test("{var} whose initial value has the wrong type", () => {
  assertHas(errorsOf({ emit: "score", payload: { score: "{name}" } }, { name: "" }), /'\{name\}' starts as a string but 'score' must be a number/);
  assertHas(errorsOf({ emit: "answer", payload: { option: "{picked}" } }, { picked: [] }), /'\{picked\}' starts as a array/);
  assertNone(errorsOf({ emit: "score", payload: { score: "{n}" } }));
  assertNone(errorsOf({ emit: "score", payload: { score: "{n * 10 + 1}" } })); // expression: type unknown → not flagged
});

test("unknown start.mode", () => {
  assertHas(errorsOf({ emit: "start", payload: { mode: "battle" } }), /unknown mode "battle" \(reaction \| nunchi \| guess\)/);
  for (const mode of ["reaction", "nunchi", "guess"]) assertNone(errorsOf({ emit: "start", payload: { mode } }));
});

test("warnings: unknown event, unknown key, text template into a number field, ignored payload", () => {
  assertHas(warningsOf({ emit: "cheer" }), /'cheer' is not a room action/);
  assertHas(warningsOf({ emit: "vote", payload: { option: "o0", weight: 2 } }), /'vote' does not read 'weight'/);
  assertHas(warningsOf({ emit: "score", payload: { score: "{n}점" } }), /text template always sends a string; 'score' needs a number/);
  assertHas(warningsOf({ emit: "tap", payload: { n: 1 } }), /'tap' takes no payload/);
  // without the contract none of these are reported
  for (const emit of [{ emit: "cheer" }, { emit: "vote", payload: { option: "o0", weight: 2 } }]) assertNone(lines(validate(emitDoc(emit)).warnings));
});

test("a variable name in a free-text field (start.game) only warns", () => {
  const vars = { trivia: 0 };
  const emit = { emit: "start", payload: { game: "trivia", quiz: true } };
  assertNone(errorsOf(emit, vars));
  assertHas(warningsOf(emit, vars), /game: sends the literal text "trivia".*"\{trivia\}"/);
});

test("legit literals are not flagged", () => {
  for (const emit of [
    { emit: "vote", payload: { option: "o0" } },
    { emit: "vote", payload: { option: 1 } },
    { emit: "answer", payload: { option: 0 } },
    { emit: "answer", payload: { option: "3" } }, // numeric string: Number("3") === 3
    { emit: "start", payload: { duration: "15000", rounds: "6" } },
    { emit: "tally", payload: { delta: 1 } },
    { emit: "tally" },
    { emit: "score", payload: { score: "{n}" } },
  ]) {
    assertNone(errorsOf(emit));
    assertNone(warningsOf(emit));
  }
  // "{index}" / "o{index}" inside an each box
  const doc = emitDoc({ emit: "tap" }, { list: ["a", "b"] });
  doc.view.children.push({ box: "row", each: "list", children: [{ text: "{item}", onTap: [{ emit: "answer", payload: { option: "{index}" } }, { emit: "vote", payload: { option: "o{index}" } }] }] });
  const r = withContract(doc);
  assertNone(lines(r.errors));
  assertNone(lines(r.warnings));
});

// ── every shipped template ──
// race-tap / race-trivia / race-reaction ship T-01 (being hidden/merged in Q0
// lane C); every other template must pass the contract. A new failure here is a
// real bug in that template, or a false positive in the validator.
const KNOWN_T01 = new Set(["race-tap", "race-trivia", "race-reaction"]);
test("all shipped templates pass the contract (except the known T-01 apps)", () => {
  const dir = new URL("../../../snack-server/data/bite/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".bite.json"));
  assert.ok(files.length >= 40, `expected the template set, found ${files.length}`);
  const bad = [];
  for (const f of files) {
    const id = f.replace(".bite.json", "");
    const r = withContract(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (KNOWN_T01.has(id)) {
      if (!r.ok) assert.ok(r.errors.every((e) => /literal text "score"/.test(e.message)), `${id}: unexpected errors\n${lines(r.errors).join("\n")}`);
      continue;
    }
    if (!r.ok) bad.push(`${id}:\n  ${lines(r.errors).join("\n  ")}`);
  }
  assert.deepEqual(bad, []);
});

// ── drift: contract ⇄ room.js ──
function roomHarness() {
  const out = [];
  const room = createRoom({
    broadcast: (type, d) => out.push({ to: "*", type, d }),
    send: (to, type, d) => out.push({ to, type, d }),
    setTimer: () => 0, // the session never advances — only acknowledgement matters
    clearTimer: () => {},
  });
  room.join("p1", { anonId: "a1", nick: "닉1" });
  let seq = 0;
  const act = (name, payload) => {
    const clientMsgId = `m${++seq}`;
    room.action("p1", payload === undefined ? { name, clientMsgId } : { name, payload, clientMsgId });
    return out.some((m) => m.to === "p1" && m.type === "actionAck" && m.d.clientMsgId === clientMsgId);
  };
  const v = (id) => [...out].reverse().find((m) => m.type === "setVar" && m.d.id === id)?.d.value;
  return { room, act, v, out };
}
const SAMPLE = { string: "o0", number: 1, boolean: true };
const samplePayload = (spec) => {
  if (spec.payload === "none") return undefined;
  const p = {};
  for (const [k, f] of Object.entries(spec.fields ?? {})) {
    if (!f.required && k !== "mode") continue;
    p[k] = f.enum ? f.enum[0] : SAMPLE[[].concat(f.type)[0]];
  }
  return p;
};

test("drift: every contract action is acknowledged by the real room", async () => {
  for (const [name, spec] of Object.entries(HOST_ACTIONS)) {
    const h = roomHarness();
    assert.equal(h.act(name, samplePayload(spec)), true, `room did not acknowledge '${name}' ${JSON.stringify(samplePayload(spec))}`);
    if (spec.number) assert.equal(roomHarness().act(name, 12000), true, `room did not acknowledge '${name}' with a bare number`);
    h.room.destroy();
  }
  await new Promise((r) => setImmediate(r)); // let the async start sessions settle
  // and the room ignores what is not in the contract
  assert.equal(roomHarness().act("cheer", {}), false);
});

test("drift: every action room.js handles is in the contract", () => {
  const src = readFileSync(new URL("../../snack-room/src/room.js", import.meta.url), "utf8");
  const handled = new Set([...src.matchAll(/name === "(\w+)"/g)].map((m) => m[1]));
  assert.ok(handled.size >= 7, `parsed ${[...handled]}`);
  assert.deepEqual([...handled].sort(), Object.keys(HOST_ACTIONS).sort());
});

test("drift: required fields really are required — the room drops the action without them", () => {
  for (const [name, spec] of Object.entries(HOST_ACTIONS)) {
    for (const [k, f] of Object.entries(spec.fields ?? {})) {
      if (!f.required || name === "answer") continue; // answer acks even when outside a quiz round
      const p = samplePayload(spec);
      delete p[k];
      assert.equal(roomHarness().act(name, p), false, `'${name}' without '${k}' was still acknowledged — not required?`);
    }
  }
});

// ── T-01 end to end: Bite runtime emit → room ──
const playToResult = (doc) => {
  let t = 0;
  const app = createBite(doc, { now: () => t });
  const emits = [];
  app.on("emit", (e) => emits.push(e));
  app.start();
  for (let i = 0; i < 37; i++) app.tap("pad");
  t = 20000;
  app.tick();
  return emits;
};

test("T-01: {score: \"score\"} is dropped by the room; {score: \"{score}\"} reaches the leaderboard", () => {
  const bad = fixture("bad-score-literal");
  const [sentBad] = playToResult(bad);
  assert.deepEqual(sentBad, { name: "score", payload: { score: "score" } });
  const h1 = roomHarness();
  assert.equal(h1.act(sentBad.name, sentBad.payload), false);
  assert.deepEqual(h1.room.sharedState().leaderboard, []);

  const good = structuredClone(bad);
  good.phases.play.tick[0].then[0].payload.score = "{score}";
  assert.equal(withContract(good).ok, true, lines(withContract(good).errors).join("\n"));
  const [sentGood] = playToResult(good);
  assert.deepEqual(sentGood, { name: "score", payload: { score: 37 } });
  const h2 = roomHarness();
  assert.equal(h2.act(sentGood.name, sentGood.payload), true);
  assert.deepEqual(h2.v("leaderboard"), [37]);
});
