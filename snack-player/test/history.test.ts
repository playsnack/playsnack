// Undo/redo history (history.ts) + the quiz maker's per-question and list history (quizHistory.ts) + the ↶/↷ buttons.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HISTORY_CAP, canRedo, canUndo, createHistory, record, redo, seal, undo } from "../src/history.ts";
import {
  canRedoList, canRedoSlot, canUndoList, canUndoSlot, editSlot, emptyQuizHist, listAction, redoList, redoSlot, sealSlot, undoList, undoSlot,
  type MakerState,
} from "../src/quizHistory.ts";
import { addSuggested, editQuestion, fromTemplate, newDraft, tapAnswer, type QuestionTemplate } from "../src/quiz.ts";
import { UndoRedo } from "../src/QuizMaker.tsx";

// ── generic history ──
test("history: push / undo / redo walk the versions", () => {
  let h = createHistory("a");
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  h = record(h, "b", { now: 0 });
  h = record(h, "c", { now: 1 });
  assert.deepEqual([h.past, h.present, h.future], [["a", "b"], "c", []]);
  h = undo(h);
  assert.equal(h.present, "b");
  assert.equal(canRedo(h), true);
  h = undo(h);
  assert.equal(h.present, "a");
  assert.equal(canUndo(h), false);
  assert.equal(undo(h), h, "undo with nothing to undo is a no-op");
  h = redo(redo(h));
  assert.equal(h.present, "c");
  assert.equal(redo(h), h, "redo with nothing to redo is a no-op");
});

test("history: recording after an undo drops the redo branch", () => {
  let h = record(record(createHistory(1), 2, { now: 0 }), 3, { now: 1 });
  h = undo(h); // present 2, future [3]
  h = record(h, 9, { now: 2 });
  assert.deepEqual([h.past, h.present, h.future], [[1, 2], 9, []]);
  assert.equal(canRedo(h), false);
});

test("history: an equal version is not a new step", () => {
  const h = record(createHistory({ x: 1 }), { x: 1 }, { now: 0 });
  assert.equal(canUndo(h), false);
});

test("history: keeps at most 30 undo steps (oldest fall off)", () => {
  let h = createHistory(0);
  for (let i = 1; i <= 50; i++) h = record(h, i, { now: i * 1000 });
  assert.equal(HISTORY_CAP, 30);
  assert.equal(h.past.length, 30);
  assert.equal(h.past[0], 20);
  for (let i = 0; i < 30; i++) h = undo(h);
  assert.equal(h.present, 20);
  assert.equal(canUndo(h), false);
});

test("history: typing in one group within 800 ms idle is one step; idle gap, other group or seal start a new one", () => {
  let h = createHistory("");
  h = record(h, "a", { group: "q", now: 0 });
  h = record(h, "ab", { group: "q", now: 500 });
  h = record(h, "abc", { group: "q", now: 1200 }); // 700 ms after the last key: same step
  assert.deepEqual(h.past, [""]);
  h = record(h, "abcd", { group: "q", now: 2100 }); // 900 ms idle: new step
  assert.deepEqual(h.past, ["", "abc"]);
  h = record(h, "abcd!", { group: "o0", now: 2200 }); // another field: new step
  assert.deepEqual(h.past, ["", "abc", "abcd"]);
  h = seal(h);
  h = record(h, "abcd!?", { group: "o0", now: 2300 }); // after blur: new step
  assert.deepEqual(h.past, ["", "abc", "abcd", "abcd!"]);
  h = record(h, "X", { now: 2350 }); // ungrouped (a tap) never merges
  h = record(h, "Y", { now: 2360 });
  assert.equal(h.past.length, 6);
  assert.equal(undo(undo(h)).present, "abcd!?");
});

// ── quiz maker ──
const T = (q: string): QuestionTemplate => ({ q, options: ["가", "나", "다", "라"] });
const start = (): MakerState => {
  const d = newDraft("라임", { random: () => 0 });
  return { draft: { ...d, questions: [T("Q-A"), T("Q-B"), T("Q-C")].map(fromTemplate) }, hist: emptyQuizHist() };
};
const swapTo = (s: MakerState, id: string, t: QuestionTemplate) => editSlot(s, id, () => ({ ...fromTemplate(t), id }), { now: 0 });
const qOf = (s: MakerState, i: number) => s.draft.questions[i];

test("quiz: '다른 질문' swaps can be undone and redone on that card", () => {
  let s = start();
  const id = qOf(s, 0).id;
  assert.equal(canUndoSlot(s, id), false);
  s = swapTo(s, id, T("Q-X"));
  s = swapTo(s, id, T("Q-Y"));
  assert.equal(qOf(s, 0).q, "Q-Y");
  assert.equal(qOf(s, 0).id, id, "the slot keeps its id");
  s = undoSlot(s, id);
  assert.equal(qOf(s, 0).q, "Q-X");
  s = undoSlot(s, id);
  assert.equal(qOf(s, 0).q, "Q-A");
  assert.equal(canUndoSlot(s, id), false);
  assert.equal(canRedoSlot(s, id), true);
  s = redoSlot(s, id);
  assert.equal(qOf(s, 0).q, "Q-X");
  assert.equal(qOf(s, 1).q, "Q-B", "other cards untouched");
  assert.equal(canUndoSlot(s, qOf(s, 1).id), false, "each card has its own history");
});

test("quiz: typing is coalesced into one step per field; taps are steps", () => {
  let s = start();
  const id = qOf(s, 0).id;
  s = editSlot(s, id, (q) => tapAnswer(q, 2), { now: 0 });
  for (const [i, text] of ["나", "나의", "나의 꿈"].entries()) s = editSlot(s, id, (q) => editQuestion(q, text), { group: "q", now: 100 + i * 200 });
  s = sealSlot(s, id);
  s = editSlot(s, id, (q) => editQuestion(q, "나의 꿈은?"), { group: "q", now: 700 });
  assert.equal(qOf(s, 0).q, "나의 꿈은?");
  s = undoSlot(s, id);
  assert.equal(qOf(s, 0).q, "나의 꿈");
  s = undoSlot(s, id);
  assert.equal(qOf(s, 0).q, "Q-A");
  assert.equal(qOf(s, 0).answer, 2);
  s = undoSlot(s, id);
  assert.equal(qOf(s, 0).answer, null);
});

test("quiz: an undo that would bring back a question another card now shows waits", () => {
  let s = start();
  const [a, b] = [qOf(s, 0).id, qOf(s, 1).id];
  s = swapTo(s, a, T("Q-X")); // Q-A freed…
  s = swapTo(s, b, T("Q-A")); // …and picked by card 2
  assert.equal(canUndoSlot(s, a), false);
  assert.equal(undoSlot(s, a), s);
  s = undoSlot(s, b); // card 2 back to Q-B: card 1 can undo again
  assert.equal(canUndoSlot(s, a), true);
});

test("quiz: removing / adding questions is undone on the list, keeping each card's latest version and history", () => {
  let s = start();
  const [a, b] = [qOf(s, 0).id, qOf(s, 1).id];
  s = swapTo(s, b, T("Q-X"));
  s = listAction(s, (d) => ({ ...d, questions: d.questions.filter((q) => q.id !== b) }), 0);
  assert.equal(s.draft.questions.length, 2);
  s = editSlot(s, a, (q) => tapAnswer(q, 1), { now: 1 }); // a later edit on another card
  assert.equal(canUndoList(s), true);
  s = undoList(s);
  assert.deepEqual(s.draft.questions.map((q) => q.q), ["Q-A", "Q-X", "Q-C"], "removed card back in place, swapped version");
  assert.equal(qOf(s, 0).answer, 1, "the later edit on card 1 is kept");
  assert.equal(canUndoSlot(s, b), true, "the card's own history came back with it");
  assert.equal(canRedoList(s), true);
  s = redoList(s);
  assert.equal(s.draft.questions.length, 2);
  s = undoList(s);
  s = listAction(s, (d) => addSuggested(d, () => 0, [T("Q-N")]), 2);
  assert.equal(s.draft.questions.length, 4);
  assert.equal(canRedoList(s), false, "a new list action drops the list redo");
  s = undoList(s);
  assert.equal(s.draft.questions.length, 3);
});

test("quiz: 새로 뽑기 (whole list + title) can be undone", () => {
  let s = start();
  s = { ...s, draft: { ...s.draft, title: "내 퀴즈" } };
  const before = s.draft.questions.map((q) => q.q);
  s = listAction(s, () => ({ ...newDraft("라임", { random: () => 0.5 }) }), 0);
  assert.notEqual(s.draft.title, "내 퀴즈");
  s = undoList(s);
  assert.equal(s.draft.title, "내 퀴즈");
  assert.deepEqual(s.draft.questions.map((q) => q.q), before);
});

test("quiz: a no-op list action is not recorded", () => {
  const s = start();
  assert.equal(listAction(s, (d) => d, 0), s);
  const full = listAction(s, (d) => addSuggested(d, () => 0, []), 0); // pool used up → same draft
  assert.equal(canUndoList(full), false);
});

// ── buttons ──
test("UndoRedo: labelled 되돌리기 / 다시 하기, disabled when nothing to undo/redo, 44 px", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(UndoRedo, { canUndo: true, canRedo: false, onUndo: noop, onRedo: noop }));
  assert.match(html, /aria-label="되돌리기"[^>]*><svg[^>]*data-icon="undo"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="다시 하기"[^>]*><svg[^>]*data-icon="redo"/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*aria-label="되돌리기"/);
  assert.equal((html.match(/width:44px;height:44px/g) ?? []).length, 2);
  const none = renderToStaticMarkup(createElement(UndoRedo, { canUndo: false, canRedo: false, onUndo: noop, onRedo: noop, what: "질문 목록" }));
  assert.equal((none.match(/disabled=""/g) ?? []).length, 2);
  assert.match(none, /title="질문 목록 되돌리기"/);
});
