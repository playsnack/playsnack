import { test } from "node:test";
import assert from "node:assert/strict";
import { compileExpr, run, runTemplate, template } from "../src/expr.js";

const ctx = (vars = {}, extra = {}) => ({ vars, phase: "play", now: 1000, random: () => 0.5, ...extra });
const ev = (src, vars, extra) => run(compileExpr(src), ctx(vars, extra), null);

test("arithmetic, comparison, logic, ternary", () => {
  assert.equal(ev("1 + 2 * 3"), 7);
  assert.equal(ev("score % 3", { score: 10 }), 1);
  assert.equal(ev("a > 2 && b || c", { a: 3, b: 0, c: "x" }), "x");
  assert.equal(ev("!done ? 'go' : 'stop'", { done: false }), "go");
  assert.equal(ev("-x", { x: 4 }), -4);
});

test("== is strict", () => {
  assert.equal(ev("a == '1'", { a: 1 }), false);
  assert.equal(ev("a != '1'", { a: 1 }), true);
  assert.equal(ev("a == 1", { a: 1 }), true);
});

test("specials: phase, now, item, index, props", () => {
  assert.equal(ev("phase == 'play'"), true);
  assert.equal(ev("now - t", { t: 400 }), 600);
  assert.equal(ev("item.name + index", {}, { item: { name: "a" }, index: 2 }), "a2");
  assert.equal(ev("props.title", {}, { props: { title: "hi" } }), "hi");
});

test("member access: arrays, strings, objects", () => {
  assert.equal(ev("xs[1]", { xs: [5, 6] }), 6);
  assert.equal(ev("xs.length", { xs: [5, 6] }), 2);
  assert.equal(ev("s.length", { s: "abc" }), 3);
  assert.equal(ev("o.a.b", { o: { a: { b: 9 } } }), 9);
  assert.equal(ev("o.missing", { o: {} }), undefined);
});

test("bare functions", () => {
  assert.equal(ev("round(3.456, 1)"), 3.5);
  assert.equal(ev("round(2.5)"), 3);
  assert.equal(ev("clamp(15, 0, 10)"), 10);
  assert.equal(ev("lerp(0, 10, 0.25)"), 2.5);
  assert.equal(ev("remap(5, 0, 10, 0, 100)"), 50);
  assert.equal(ev("min(3, 1, 2)"), 1);
  assert.equal(ev("max(xs)", { xs: [3, 9, 2] }), 9);
  assert.equal(ev("randint(1, 6)"), 4); // random = 0.5
  assert.equal(ev("pick(xs)", { xs: ["a", "b", "c"] }), "b");
  assert.deepEqual(ev("range(3)"), [0, 1, 2]);
  assert.equal(ev("sum(xs)", { xs: [1, 2, 3] }), 6);
  assert.deepEqual(ev("with(xs, 1, 9)", { xs: [1, 2, 3] }), [1, 9, 3]);
  assert.equal(ev("len(xs)", { xs: [1, 2] }), 2);
  assert.equal(ev("fmt(1234567)"), "1,234,567");
  assert.equal(ev("pad(7, 2)"), "07");
  assert.equal(ev("elapsed(t)", { t: 250 }), 750);
});

test("hash is a stable unsigned 32-bit number", () => {
  const a = ev("hash('장원영')");
  assert.equal(a, ev("hash('장원영')"));
  assert.notEqual(a, ev("hash('윈터')"));
  assert.ok(Number.isInteger(a) && a >= 0 && a < 2 ** 32);
  assert.equal(ev("hash('')"), 0x811c9dc5);
});

test("shuffle is deterministic with injected random and does not mutate", () => {
  const xs = [1, 2, 3, 4];
  const a = ev("shuffle(xs)", { xs });
  const b = ev("shuffle(xs)", { xs });
  assert.deepEqual(a, b);
  assert.deepEqual(xs, [1, 2, 3, 4]);
  assert.deepEqual([...a].sort(), [1, 2, 3, 4]);
});

test("Math. prefix works as an alias and is flagged", () => {
  assert.equal(ev("Math.round(2.4) + Math.max(1, 5)"), 7);
  assert.equal(ev("Math.floor(Math.random() * 10)"), 5);
  assert.equal(compileExpr("Math.round(x)").mathPrefix, true);
  assert.equal(compileExpr("round(x)").mathPrefix, false);
});

test("whitelisted methods, arrows, copy-on-sort", () => {
  assert.deepEqual(ev("xs.filter(s => s > 2).map(s => s * 10)", { xs: [1, 2, 3, 4] }), [30, 40]);
  assert.equal(ev("xs.some(s => s.ok)", { xs: [{ ok: false }, { ok: true }] }), true);
  assert.equal(ev("xs.join(', ')", { xs: ["a", "b"] }), "a, b");
  assert.deepEqual(ev("xs.concat([3])", { xs: [1, 2] }), [1, 2, 3]);
  const xs = [3, 1, 2];
  assert.deepEqual(ev("xs.sort((a, b) => a - b)", { xs }), [1, 2, 3]);
  assert.deepEqual(xs, [3, 1, 2]);
  assert.equal(ev("name.toUpperCase()", { name: "ab" }), "AB");
  assert.equal(ev("n.toFixed(1)", { n: 1.25 }), "1.3");
});

test("sandbox: rejects anything outside the whitelist", () => {
  for (const src of [
    "xs.push(1)",
    "o.constructor",
    "o['__proto__']",
    "alert(1)",
    "window",
    "Math.sin(1)",
    "a = 1",
    "a; b",
    "s => s",
    "a | b",
    "this",
  ]) {
    const c = compileExpr(src);
    const value = c.error ? undefined : run(c, ctx({ xs: [], o: {}, a: 1, b: 2, window: undefined }), null);
    assert.ok(c.error || value === undefined, `should reject: ${src}`);
  }
  assert.ok(compileExpr("xs.push(1)").error);
  assert.ok(compileExpr("alert(1)").error);
});

test("errors yield undefined and warn once per expression", () => {
  const msgs = [];
  const warn = (m) => msgs.push(m);
  const c = compileExpr("missing + 1");
  assert.equal(run(c, ctx(), warn), undefined);
  assert.equal(run(c, ctx(), warn), undefined);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /unknown variable 'missing'/);
  assert.equal(run(compileExpr("o.a.b"), ctx({ o: {} }), warn), undefined);
  assert.equal(msgs.length, 2);
});

test("deps lists variables and specials, not arrow params", () => {
  const c = compileExpr("xs.filter(s => s > limit).length + now + (phase == 'a' ? 1 : 0)");
  assert.deepEqual([...c.deps].sort(), ["limit", "now", "phase", "xs"]);
  assert.deepEqual([...c.vars].sort(), ["limit", "xs"]);
});

test("templates: literal, single (keeps type), parts, escapes, quotes", () => {
  const c = ctx({ score: 12, done: true });
  assert.equal(template("#ffffff").kind, "literal");
  assert.equal(runTemplate("plain", c), "plain");
  assert.equal(runTemplate("{score}", c), 12);
  assert.equal(runTemplate("{done}", c), true);
  assert.equal(runTemplate("{score}점", c), "12점");
  assert.equal(runTemplate("{{score}}", c), "{score}}");
  assert.equal(runTemplate("{done ? '}' : '{'}!", c), "}!");
  assert.equal(runTemplate("값: {missing}", c, () => {}), "값: ");
  assert.ok(template("{oops").error);
});
