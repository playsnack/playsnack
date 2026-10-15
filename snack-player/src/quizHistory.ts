// Undo/redo for the "나 맞히기" maker (QuizMaker.tsx) — pure, in memory only.
// Each question slot (by id) keeps its own History: "다른 질문" swaps, answer
// taps, option add/remove and typed edits (typing coalesced per field, sealed
// on blur or after an idle gap). List actions (add / remove a question, 새로
// 뽑기, loading an old quiz) go on one list History; undoing one restores the
// list's order and membership while keeping each question's latest version.
import { canRedo, canUndo, createHistory, record, redo, seal, undo, type History } from "./history";
import type { Draft, DraftQuestion } from "./quiz";

type ListSnap = { title: string; questions: DraftQuestion[] };
export type QuizHist = { slots: Record<string, History<DraftQuestion>>; list: History<ListSnap> | null };
export type MakerState = { draft: Draft; hist: QuizHist };

export const emptyQuizHist = (): QuizHist => ({ slots: {}, list: null });

const replaceQ = (d: Draft, q: DraftQuestion): Draft => ({ ...d, questions: d.questions.map((x) => (x.id === q.id ? q : x)) });

/** Change question `id` with `f`, recording the new version on its slot. */
export function editSlot(s: MakerState, id: string, f: (q: DraftQuestion) => DraftQuestion, opts: { group?: string; now?: number } = {}): MakerState {
  const q = s.draft.questions.find((x) => x.id === id);
  if (!q) return s;
  const next = f(q);
  const slot = s.hist.slots[id] ?? createHistory(q);
  const h = record(slot, next, opts);
  if (h === slot && next === q) return s;
  return { draft: replaceQ(s.draft, next), hist: { ...s.hist, slots: { ...s.hist.slots, [id]: h } } };
}

/** End the typing step on question `id` (blur). */
export function sealSlot(s: MakerState, id: string): MakerState {
  const slot = s.hist.slots[id];
  if (!slot || slot.group === null) return s;
  return { ...s, hist: { ...s.hist, slots: { ...s.hist.slots, [id]: seal(slot) } } };
}

/** A version would duplicate another question in the draft (e.g. the swapped-out
    suggestion was since picked by another slot) — that undo/redo step waits. */
function clashes(d: Draft, id: string, v: DraftQuestion | undefined): boolean {
  if (!v) return true;
  const keys = new Set([v.q.trim(), v.tpl ?? ""].filter(Boolean));
  return d.questions.some((x) => x.id !== id && (keys.has(x.q.trim()) || (x.tpl !== undefined && keys.has(x.tpl))));
}

export const canUndoSlot = (s: MakerState, id: string) => {
  const h = s.hist.slots[id];
  return canUndo(h) && !clashes(s.draft, id, h.past[h.past.length - 1]);
};
export const canRedoSlot = (s: MakerState, id: string) => {
  const h = s.hist.slots[id];
  return canRedo(h) && !clashes(s.draft, id, h.future[0]);
};

function moveSlot(s: MakerState, id: string, dir: "undo" | "redo"): MakerState {
  if (!(dir === "undo" ? canUndoSlot(s, id) : canRedoSlot(s, id))) return s;
  if (!s.draft.questions.some((x) => x.id === id)) return s;
  const h = (dir === "undo" ? undo : redo)(s.hist.slots[id]);
  return { draft: replaceQ(s.draft, h.present), hist: { ...s.hist, slots: { ...s.hist.slots, [id]: h } } };
}
export const undoSlot = (s: MakerState, id: string) => moveSlot(s, id, "undo");
export const redoSlot = (s: MakerState, id: string) => moveSlot(s, id, "redo");

const snap = (d: Draft): ListSnap => ({ title: d.title, questions: d.questions });
// Compare lists by membership/order only (question edits live on the slots).
const sameList = (a: unknown, b: unknown) => {
  const x = a as ListSnap, y = b as ListSnap;
  return x.title === y.title && x.questions.length === y.questions.length && x.questions.every((q, i) => q.id === y.questions[i].id);
};

/** Apply a whole-list action (add / remove / 새로 뽑기 / load) and record it. */
export function listAction(s: MakerState, f: (d: Draft) => Draft, now = Date.now()): MakerState {
  const next = f(s.draft);
  if (next === s.draft) return s;
  const list = record(s.hist.list ?? createHistory(snap(s.draft)), snap(next), { now, equal: sameList });
  return { draft: next, hist: { ...s.hist, list } };
}

export const canUndoList = (s: MakerState) => canUndo(s.hist.list ?? undefined);
export const canRedoList = (s: MakerState) => canRedo(s.hist.list ?? undefined);

function moveList(s: MakerState, dir: "undo" | "redo"): MakerState {
  const cur = s.hist.list;
  if (!cur || !(dir === "undo" ? canUndo(cur) : canRedo(cur))) return s;
  const h = (dir === "undo" ? undo : redo)(cur);
  const live = new Map(s.draft.questions.map((q) => [q.id, q]));
  // Each question comes back in its latest version (its slot's present).
  const questions = h.present.questions.map((q) => live.get(q.id) ?? s.hist.slots[q.id]?.present ?? q);
  // The title follows the list only if it was not edited since that action.
  const title = s.draft.title === cur.present.title ? h.present.title : s.draft.title;
  return { draft: { ...s.draft, title, questions }, hist: { ...s.hist, list: h } };
}
export const undoList = (s: MakerState) => moveList(s, "undo");
export const redoList = (s: MakerState) => moveList(s, "redo");
