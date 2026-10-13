// The one reaction question on the result screen: "다음에도 하고 싶나요?" 👍/👎,
// skippable, and on 👎 optional reason chips. Asked at most once per browser
// session per game, never during play, never covering the result buttons (the
// template lays the card out above them). No camera, mic or photos.
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

/** "" = not shown · ask = 👍/👎 · reasons = chips after 👎 · thanks = brief thank-you · done = finished for this session. */
export type ReactionStage = "" | "ask" | "reasons" | "thanks" | "done";

/** What the metrics lane will count. Exposure is reported once, answers once each. */
export type ReactionReport =
  | { k: "reaction_shown" }
  | { k: "reaction_answer"; answer: "yes" | "no" }
  | { k: "reaction_reason"; reason: ReactionReason }
  | { k: "reaction_skip"; at: "ask" | "reasons" };

export type ReactionInput =
  | { t: "resultShown" }
  | { t: "answer"; answer: "yes" | "no" | "skip" }
  | { t: "reason"; reason: string }
  | { t: "skipReasons" }
  | { t: "thanksDone" }
  | { t: "resultLeft" };

/** One step: the next stage, what to report, and whether the session is now "answered". */
export function stepReaction(stage: ReactionStage, input: ReactionInput): { stage: ReactionStage; report: ReactionReport | null; settled: boolean } {
  const stay = { stage, report: null, settled: false };
  switch (input.t) {
    case "resultShown":
      return stage === "" ? { stage: "ask", report: { k: "reaction_shown" }, settled: false } : stay;
    case "answer":
      if (stage !== "ask") return stay;
      if (input.answer === "skip") return { stage: "done", report: { k: "reaction_skip", at: "ask" }, settled: true };
      if (input.answer === "yes") return { stage: "thanks", report: { k: "reaction_answer", answer: "yes" }, settled: true };
      return { stage: "reasons", report: { k: "reaction_answer", answer: "no" }, settled: true };
    case "reason":
      if (stage !== "reasons" || !isReactionReason(input.reason)) return stay;
      return { stage: "thanks", report: { k: "reaction_reason", reason: input.reason }, settled: true };
    case "skipReasons":
      return stage === "reasons" ? { stage: "done", report: { k: "reaction_skip", at: "reasons" }, settled: true } : stay;
    case "thanksDone":
      return stage === "thanks" ? { stage: "done", report: null, settled: true } : stay;
    case "resultLeft":
      // Leaving the result (a new game starts) closes an unanswered question for
      // good: it was shown once, it is not asked again this session.
      if (stage === "ask" || stage === "reasons") return { stage: "done", report: null, settled: true };
      if (stage === "thanks") return { stage: "done", report: null, settled: true };
      return stay;
  }
}

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const memory = new Set<string>(); // fallback when storage throws (private mode, blocked site data)

/** "Already asked in this browser session for this game?" — sessionStorage, never throws. */
export function reactionStore(game: string, storage: () => KV | null | undefined = () => globalThis.sessionStorage) {
  const key = `snack_reaction_v1:${game}`;
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
