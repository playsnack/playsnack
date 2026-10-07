import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../src/validate.js";

const reaction = JSON.parse(readFileSync(new URL("./fixtures/reaction.bite.json", import.meta.url), "utf8"));

const base = (over = {}) => ({
  bite: 1,
  meta: { name: "t" },
  frame: [390, 844],
  vars: { n: 0 },
  start: "a",
  phases: { a: { enter: [{ set: "n", to: "0" }] } },
  view: { box: "column", children: [{ text: "{n}" }] },
  ...over,
});
const messages = (doc) => validate(doc).errors.map((e) => `${e.path}: ${e.message}`);
const expectError = (doc, re) => {
  const errs = messages(doc);
  assert.ok(errs.some((m) => re.test(m)), `expected ${re} in:\n${errs.join("\n")}`);
};

test("spec example is valid with no warnings", () => {
  const r = validate(reaction);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("minimal doc is valid", () => {
  assert.equal(validate(base()).ok, true);
});

test("structure errors", () => {
  expectError({ ...base(), bite: 2 }, /^bite: must be 1/);
  expectError({ ...base(), extra: 1 }, /unknown top-level key 'extra'/);
  expectError(base({ start: "zz" }), /^start:/);
  expectError(base({ frame: "9:16" }), /^frame:/);
  expectError(base({ vars: { phase: 1 } }), /'phase' is reserved/);
  expectError(base({ vars: { n: 0, min: 1 } }), /'min' is a built-in function name/);
  expectError(base({ phases: { a: { onEnter: [] } } }), /unknown phase key 'onEnter'/);
});

test("expression scope errors", () => {
  expectError(base({ view: { text: "{score}" } }), /unknown variable 'score'/);
  expectError(base({ view: { text: "{props.title}" } }), /'props' is only available inside a component/);
  expectError(base({ view: { text: "{item}" } }), /'item' is only available inside an 'each' box/);
  expectError(base({ view: { box: "column", show: "xs.push(1)" } }), /method 'push' is not allowed/);
  expectError(base({ view: { text: "{oops" } }), /unclosed/);
});

test("action errors", () => {
  expectError(base({ phases: { a: { enter: [{ go: "nowhere" }] } } }), /unknown phase 'nowhere'/);
  expectError(base({ phases: { a: { enter: [{ set: "ghost", to: "1" }] } } }), /unknown variable 'ghost'/);
  expectError(base({ phases: { a: { enter: [{ set: "n" }] } } }), /exactly one of 'to'/);
  expectError(base({ phases: { a: { enter: [{ set: "n", to: "1", go: "a" }] } } }), /exactly one of set/);
  expectError(base({ phases: { a: { enter: [{ setVar: "n" }] } } }), /exactly one of set/);
});

test("node errors", () => {
  expectError(base({ view: { box: "column", children: [{ text: "a", image: "b" }] } }), /more than one kind/);
  expectError(base({ view: { box: "column", children: [{ text: "a", fontSize: 12 }] } }), /unknown key 'fontSize'/);
  expectError(base({ view: { box: "column", children: [{ text: "a", x: 4 }] } }), /x \/ y only apply inside a 'free' box/);
  expectError(base({ view: { box: "grid", children: [] } }), /needs 'columns'/);
  expectError(base({ view: { box: "column", fill: "red" } }), /invalid color/);
  expectError(base({ view: { box: "column", width: "100%" } }), /invalid width/);
  expectError(base({ view: { box: "column", children: [{ id: "a" }, { id: "a" }] } }), /duplicate id 'a'/);
  expectError(base({ view: { use: "Nope" } }), /unknown component 'Nope'/);
});

test("template values are accepted for numeric/color properties", () => {
  const r = validate(base({ vars: { n: 0, c: "#fff" }, view: { box: "column", width: "{n * 2}", fill: "{c}", children: [] } }));
  assert.deepEqual(r.errors, []);
});

test("components: props scope, unknown prop, self-use", () => {
  const card = { props: { label: "" }, view: { text: "{props.label}" } };
  assert.equal(validate(base({ components: { Card: card }, view: { use: "Card", props: { label: "{n}" } } })).ok, true);
  expectError(base({ components: { Card: card }, view: { use: "Card", props: { title: "x" } } }), /has no prop 'title'/);
  expectError(base({ components: { Loop: { view: { use: "Loop" } } } }), /uses itself/);
});

test("each grants item/index to its children", () => {
  const r = validate(base({ vars: { n: 0, list: [] }, view: { box: "column", each: "list", children: [{ text: "{index}: {item.name}" }] } }));
  assert.deepEqual(r.errors, []);
});

test("warnings: Math. prefix and unused variables", () => {
  const r = validate(base({ vars: { n: 0, spare: 1 }, view: { text: "{Math.round(n)}" } }));
  assert.equal(r.ok, true);
  const w = r.warnings.map((x) => x.message).join("\n");
  assert.match(w, /drop the 'Math\.' prefix/);
  assert.match(w, /'spare' is never used/);
});
