// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { REACTION_REASONS, gameKeyOf, reactionStore, stepReaction, type ReactionInput, type ReactionStage } from "../src/reactionQuestion.ts";

const run = (inputs: ReactionInput[], from: ReactionStage = "") => {
  let stage = from;
  const reports: unknown[] = [];
  for (const i of inputs) {
    const r = stepReaction(stage, i);
    stage = r.stage;
    if (r.report) reports.push(r.report);
  }
  return { stage, reports, answers: reports.filter((r) => (r as { k: string }).k === "ask_answer") };
};

test("reason chips: exactly the metrics lane's keys and labels", () => {
  assert.deepEqual(REACTION_REASONS.map((r) => [r.key, r.label]), [
    ["boring", "재미없어요"], ["hard", "어려웠어요"], ["laggy", "끊기거나 느렸어요"], ["few", "사람이 적었어요"], ["other", "기타"],
  ]);
});

test("👍: ask_shown, then one ask_answer yes", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "yes" }, { t: "thanksDone" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.reports, [{ k: "ask_shown" }, { k: "ask_answer", a: "yes" }]);
});

test("👎 then a reason: one ask_answer no + why (nothing sent at 👎 itself)", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "no" }]);
  assert.equal(r.stage, "reasons");
  assert.equal(r.answers.length, 0);
  const r2 = run([{ t: "resultShown" }, { t: "answer", answer: "no" }, { t: "reason", reason: "laggy" }]);
  assert.deepEqual(r2.answers, [{ k: "ask_answer", a: "no", why: "laggy" }]);
});

test("👎 then ✕ on the reasons: one ask_answer no, no why", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "no" }, { t: "skipReasons" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.answers, [{ k: "ask_answer", a: "no" }]);
});

test("👎 then the result is left without a reason: still one ask_answer no", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "no" }, { t: "resultLeft" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.answers, [{ k: "ask_answer", a: "no" }]);
});

test("✕ on the question: one ask_answer skip", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "skip" }]);
  assert.deepEqual(r.reports, [{ k: "ask_shown" }, { k: "ask_answer", a: "skip" }]);
});

test("unanswered and left: shown, no answer (무응답 = shown − answers)", () => {
  const r = run([{ t: "resultShown" }, { t: "resultLeft" }]);
  assert.deepEqual(r.reports, [{ k: "ask_shown" }]);
});

test("at most one answer per game whatever is tapped", () => {
  const r = run([
    { t: "resultShown" }, { t: "answer", answer: "no" }, { t: "reason", reason: "hard" }, { t: "reason", reason: "few" },
    { t: "answer", answer: "yes" }, { t: "skipReasons" }, { t: "resultLeft" }, { t: "resultShown" },
  ]);
  assert.equal(r.answers.length, 1);
  assert.equal(r.reports.filter((x) => (x as { k: string }).k === "ask_shown").length, 1);
});

test("out-of-order input is ignored (unknown reason, answer before shown)", () => {
  assert.equal(stepReaction("", { t: "answer", answer: "yes" }).stage, "");
  assert.equal(stepReaction("thanks", { t: "answer", answer: "no" }).stage, "thanks");
  assert.equal(stepReaction("reasons", { t: "reason", reason: "too_hard" }).report, null);
  assert.equal(stepReaction("ask", { t: "reason", reason: "hard" }).stage, "ask");
});

test("game key: room + sessionNo", () => {
  assert.equal(gameKeyOf("tpl-x~ABCDEFGH23", 3), "tpl-x~ABCDEFGH23#3");
  assert.equal(gameKeyOf("tpl-x", undefined), "tpl-x#0");
  assert.notEqual(gameKeyOf("r", 1), gameKeyOf("r", 2));
});

test("store: remembers per game, survives throwing storage", () => {
  const data = new Map<string, string>();
  const kv = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const s = reactionStore("t-ok#1", () => kv);
  assert.equal(s.asked(), false);
  s.markAsked();
  assert.equal(s.asked(), true);
  assert.equal(reactionStore("t-ok#2", () => kv).asked(), false, "the next game asks again");
  const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  const b = reactionStore("t-broken#1", () => broken);
  assert.equal(b.asked(), false);
  assert.doesNotThrow(() => b.markAsked());
  assert.equal(b.asked(), true, "remembered in memory for this page");
  assert.equal(reactionStore("t-none#1", () => undefined).asked(), false);
});
