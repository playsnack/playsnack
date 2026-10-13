// The one reaction question on the result screen: "다음에도 하고 싶나요?" 👍/👎,
// skippable, and on 👎 optional reason chips. Asked at most once per game (room
// + the engine's sessionNo) on this device, never during play, never covering
// the result buttons (the template lays the card out above them). No camera,
// mic or photos.
// Reports follow docs/telemetry.md §9.1: `ask_shown` once per game, and ONE
// `ask_answer` per game — on 👍, on a reason chip, on ✕, or (after 👎 with no
// reason) when the reasons are skipped or the result is left.
// Pure state machine + a storage wrapper that survives blocked storage, so it is
// unit-tested in Node (snack-player/test/reactionQuestion.test.ts).

/** Reason chips for 👎 — keys and labels fixed by the metrics lane. */
export const REACTION_REASONS = [
  { key: "boring", label: "재미없어요" },
  { key: "hard", label: "어려웠어요" },
  { key: "laggy", label: "끊기거나 느렸어요" },
  { key: "few", label: "사람이 적었어요" },
  { key: "other", label: "기타" },
] as const;
export type ReactionReason = (typeof REACTION_REASONS)[number]["key"];
export const isReactionReason = (k: unknown): k is ReactionReason => REACTION_REASONS.some((r) => r.key === k);

/** "" = not shown · ask = 👍/👎 · reasons = chips after 👎 · thanks = brief thank-you · done = finished for this game. */
export type ReactionStage = "" | "ask" | "reasons" | "thanks" | "done";

/** What the metrics lane will count (telemetry.md §9.1 `ask_shown` / `ask_answer`). */
export type ReactionReport =
  | { k: "ask_shown" }
  | { k: "ask_answer"; a: "yes" | "no" | "skip"; why?: ReactionReason };

export type ReactionInput =
  | { t: "resultShown" }
  | { t: "answer"; answer: "yes" | "no" | "skip" }
  | { t: "reason"; reason: string }
  | { t: "skipReasons" }
  | { t: "thanksDone" }
  | { t: "resultLeft" };

/** One step: the next stage and what to report (at most one answer per game). */
export function stepReaction(stage: ReactionStage, input: ReactionInput): { stage: ReactionStage; report: ReactionReport | null } {
  const stay = { stage, report: null };
  switch (input.t) {
    case "resultShown":
      return stage === "" ? { stage: "ask", report: { k: "ask_shown" } } : stay;
    case "answer":
      if (stage !== "ask") return stay;
      if (input.answer === "skip") return { stage: "done", report: { k: "ask_answer", a: "skip" } };
      if (input.answer === "yes") return { stage: "thanks", report: { k: "ask_answer", a: "yes" } };
      return { stage: "reasons", report: null }; // 👎: the answer goes out with the reason (or without one, below)
    case "reason":
      if (stage !== "reasons" || !isReactionReason(input.reason)) return stay;
      return { stage: "thanks", report: { k: "ask_answer", a: "no", why: input.reason } };
    case "skipReasons":
      return stage === "reasons" ? { stage: "done", report: { k: "ask_answer", a: "no" } } : stay;
    case "thanksDone":
      return stage === "thanks" ? { stage: "done", report: null } : stay;
    case "resultLeft":
      // Leaving the result closes the question for this game. After 👎 with no
      // reason the "no" still counts; an unanswered question stays unanswered.
      if (stage === "reasons") return { stage: "done", report: { k: "ask_answer", a: "no" } };
      if (stage === "ask" || stage === "thanks") return { stage: "done", report: null };
      return stay;
  }
}

/** The per-game key: the room and the engine's game number (never sent anywhere). */
export const gameKeyOf = (roomId: string, sessionNo: unknown) => `${roomId}#${Number.isFinite(Number(sessionNo)) ? Number(sessionNo) : 0}`;

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const memory = new Set<string>(); // fallback when storage throws (private mode, blocked site data)

/** "Already asked for this game on this device?" — sessionStorage, never throws. */
export function reactionStore(gameKey: string, storage: () => KV | null | undefined = () => globalThis.sessionStorage) {
  const key = `snack_reaction_v2:${gameKey}`;
  return {
    asked(): boolean {
      if (memory.has(key)) return true;
      try {
        return storage()?.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    markAsked(): void {
      memory.add(key);
      try {
        storage()?.setItem(key, "1");
      } catch {
        /* the in-memory mark still holds for this page */
      }
    },
  };
}
