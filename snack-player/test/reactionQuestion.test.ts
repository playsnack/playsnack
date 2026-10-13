// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { REACTION_REASONS, reactionStore, stepReaction, type ReactionInput, type ReactionStage } from "../src/reactionQuestion.ts";

const run = (inputs: ReactionInput[], from: ReactionStage = "") => {
  let stage = from;
  const reports: unknown[] = [];
  let settled = false;
  for (const i of inputs) {
    const r = stepReaction(stage, i);
    stage = r.stage;
    if (r.report) reports.push(r.report);
    settled ||= r.settled;
  }
  return { stage, reports, settled };
};

test("reason chips: exactly the metrics lane's keys and labels", () => {
  assert.deepEqual(REACTION_REASONS.map((r) => [r.key, r.label]), [
    ["boring", "재미없어요"], ["hard", "어려웠어요"], ["laggy", "끊기거나 느렸어요"], ["few", "사람이 적었어요"], ["other", "기타"],
  ]);
});

test("👍: shown → yes → thanks → done; exposure and answer reported once", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "yes" }, { t: "thanksDone" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.reports, [{ k: "reaction_shown" }, { k: "reaction_answer", answer: "yes" }]);
});

test("👎 then a reason", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "no" }, { t: "reason", reason: "laggy" }]);
  assert.equal(r.stage, "thanks");
  assert.deepEqual(r.reports.slice(1), [{ k: "reaction_answer", answer: "no" }, { k: "reaction_reason", reason: "laggy" }]);
});

test("👎 then skip the reasons (optional) — the 'no' still counts", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "no" }, { t: "skipReasons" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.reports.slice(1), [{ k: "reaction_answer", answer: "no" }, { k: "reaction_skip", at: "reasons" }]);
});

test("skip the question: done, no answer reported", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "skip" }]);
  assert.equal(r.stage, "done");
  assert.deepEqual(r.reports, [{ k: "reaction_shown" }, { k: "reaction_skip", at: "ask" }]);
});

test("once: a second result in the same session does not ask again", () => {
  const r = run([{ t: "resultShown" }, { t: "answer", answer: "yes" }, { t: "thanksDone" }, { t: "resultShown" }]);
  assert.equal(r.stage, "done");
  // and leaving the result unanswered closes it too
  const left = run([{ t: "resultShown" }, { t: "resultLeft" }, { t: "resultShown" }]);
  assert.equal(left.stage, "done");
  assert.equal(left.reports.length, 1);
});

test("out-of-order input is ignored (no double answers, unknown reason)", () => {
  assert.equal(stepReaction("", { t: "answer", answer: "yes" }).stage, "");
  assert.equal(stepReaction("thanks", { t: "answer", answer: "no" }).stage, "thanks");
  assert.equal(stepReaction("reasons", { t: "reason", reason: "too_hard" }).report, null);
  assert.equal(stepReaction("ask", { t: "reason", reason: "hard" }).stage, "ask");
});

test("store: remembers per game, survives throwing storage", () => {
  const data = new Map<string, string>();
  const kv = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const s = reactionStore("t-ok", () => kv);
  assert.equal(s.asked(), false);
  s.markAsked();
  assert.equal(s.asked(), true);
  assert.equal(reactionStore("t-other", () => kv).asked(), false);
  const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  const b = reactionStore("t-broken", () => broken);
  assert.equal(b.asked(), false);
  assert.doesNotThrow(() => b.markAsked());
  assert.equal(b.asked(), true, "remembered in memory for this page");
  assert.equal(reactionStore("t-none", () => undefined).asked(), false);
});
