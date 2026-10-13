// "나 맞히기" quiz: the creator answers questions about themselves, invites
// friends, and the friends guess the creator's answers live. This file is the
// pure model (no DOM, no React), so the rules are unit-tested in Node
// (snack-player/test/quiz.test.ts):
//   - question templates `{ q, options }` (no answer) → a draft question whose
//     `answer` is set by the creator's tap
//   - validation with plain Korean messages (limits counted in graphemes)
//   - the `quizPack` room action payload (lane A's room engine stores it)
//   - per-device storage of the draft and of "which pack is mine in which room"
//     — storage may throw (private mode, blocked site data): an in-memory copy
//     keeps the in-app flow working for this page's lifetime.
//
// The questions never go into a link (the answers would leak in the URL): the
// creator's device sends them to the room as `quizPack` (see LiveApp).
import aboutMe from "./data/about-me.json";
import { capGraphemes, clampNick } from "./nick";

/** The together quiz app the maker feeds (its play link is /p/tpl-<id>). */
export const QUIZ_APP_ID = "speed-trivia-score";
export const QUIZ_SLUG = `tpl-${QUIZ_APP_ID}`;
/** `?make=1` on the quiz link opens the maker (in a room: for the next round). */
export const MAKE_PARAM = "make";
/** Window event LiveApp listens for: open the maker over the current room. */
export const MAKE_EVENT = "snack:make-quiz";
/**
 * "나도 만들기" (for the result screen): opens the maker over the room this
 * player is in. When done, the new quiz goes to the SAME room as `quizPack`,
 * so the next round is about this player. In the public room (no room code)
 * the maker opens on its own page and makes a new friends-only room instead.
 */
export function openQuizMaker(): void {
  if (typeof dispatchEvent === "function") dispatchEvent(new Event(MAKE_EVENT));
}

export const TITLE_MAX = 40;
export const Q_MAX = 80;
export const OPTION_MAX = 30;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
/** A "나 맞히기" round: 5–10 questions (the engine itself accepts 1–20). */
export const QUESTIONS_MIN = 5;
export const QUESTIONS_MAX = 10;
/** Suggested cards on the first screen. */
export const SUGGEST_COUNT = 10;
/** Time to answer each question (fixed for now). */
export const ANSWER_MS = 10_000;

export type QuestionTemplate = { q: string; options: string[] };
/** A question being made: `answer` is null until the creator taps their real answer. */
export type DraftQuestion = { id: string; q: string; options: string[]; answer: number | null; custom?: boolean };
export type Draft = { title: string; questions: DraftQuestion[] };
/** The `quizPack` room action payload (lane A: room engine). */
export type QuizPack = {
  title: string;
  questions: { q: string; options: string[]; answer: number }[];
  settings: { rounds: number; answerMs: number };
};
/** What the room publishes (no answers). `about` = the subject's nickname. */
export type QuizInfo = { title?: string; count?: number; custom?: boolean; answerMs?: number; about?: string };

export const ABOUT_ME: QuestionTemplate[] = (aboutMe as { questions: QuestionTemplate[] }).questions;

// ── graphemes (one Korean syllable / one emoji = one) ──
type Segmenter = { segment(s: string): Iterable<unknown> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: "grapheme" }) => Segmenter }).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor("ko", { granularity: "grapheme" }) : null;
export function graphemeLength(s: string): number {
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}
/** Input helper: the text as typed, cut at `max` graphemes. */
export const capText = (s: string, max: number) => capGraphemes(s, max);

export const defaultTitle = (nick: string | null | undefined) => `${clampNick(nick ?? "") || "나"} 맞히기`;

// ── making questions ──
let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;
export const fromTemplate = (t: QuestionTemplate): DraftQuestion => ({ id: newId(), q: t.q, options: [...t.options], answer: null });
export const blankQuestion = (): DraftQuestion => ({ id: newId(), q: "", options: ["", ""], answer: null, custom: true });

/** `n` different templates, in random order. */
export function pickTemplates(pool: QuestionTemplate[], n: number, random: () => number = Math.random): QuestionTemplate[] {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** A fresh first screen: SUGGEST_COUNT suggested questions, none answered yet. */
export function newDraft(nick: string | null | undefined, random: () => number = Math.random, pool: QuestionTemplate[] = ABOUT_ME): Draft {
  return { title: defaultTitle(nick), questions: pickTemplates(pool, SUGGEST_COUNT, random).map(fromTemplate) };
}

/** "다른 질문": a template not already in the draft, or null when the pool is used up. */
export function swapCandidate(draft: Draft, random: () => number = Math.random, pool: QuestionTemplate[] = ABOUT_ME): QuestionTemplate | null {
  const used = new Set(draft.questions.map((x) => x.q.trim()));
  const left = pool.filter((t) => !used.has(t.q.trim()));
  return left.length ? left[Math.floor(random() * left.length)] : null;
}

/** Tapping an option marks it as the creator's real answer (tap again: unmark). */
export const tapAnswer = (q: DraftQuestion, i: number): DraftQuestion => ({ ...q, answer: q.answer === i ? null : i });

/** Remove option `i`, keeping the marked answer on the same option (or clearing it if removed). */
export function removeOption(q: DraftQuestion, i: number): DraftQuestion {
  if (q.options.length <= OPTIONS_MIN) return q;
  const options = q.options.filter((_, k) => k !== i);
  const answer = q.answer === null || q.answer === i ? null : q.answer > i ? q.answer - 1 : q.answer;
  return { ...q, options, answer };
}
export const addOption = (q: DraftQuestion): DraftQuestion =>
  q.options.length >= OPTIONS_MAX ? q : { ...q, options: [...q.options, ""] };

// ── validation ──
export type QuestionProblem = { field: "q" | "options" | "answer"; message: string };
export function questionProblems(q: DraftQuestion): QuestionProblem[] {
  const out: QuestionProblem[] = [];
  const text = q.q.trim();
  if (!text) out.push({ field: "q", message: "질문을 적어 주세요" });
  else if (graphemeLength(text) > Q_MAX) out.push({ field: "q", message: `질문은 ${Q_MAX}자까지 쓸 수 있어요` });
  const opts = q.options.map((o) => o.trim());
  if (opts.length < OPTIONS_MIN || opts.length > OPTIONS_MAX) out.push({ field: "options", message: `보기는 ${OPTIONS_MIN}~${OPTIONS_MAX}개로 만들어 주세요` });
  else if (opts.some((o) => !o)) out.push({ field: "options", message: "빈 보기를 채우거나 지워 주세요" });
  else if (opts.some((o) => graphemeLength(o) > OPTION_MAX)) out.push({ field: "options", message: `보기는 ${OPTION_MAX}자까지 쓸 수 있어요` });
  else if (new Set(opts).size !== opts.length) out.push({ field: "options", message: "같은 보기가 두 번 있어요" });
  if (q.answer === null || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= opts.length) {
    out.push({ field: "answer", message: "내 진짜 답을 눌러 주세요" });
  }
  return out;
}

/** Everything that keeps "완료" disabled, in reading order (empty = ready). */
export function draftProblems(d: Draft): string[] {
  const out: string[] = [];
  const title = d.title.trim();
  if (!title) out.push("퀴즈 제목을 적어 주세요");
  else if (graphemeLength(title) > TITLE_MAX) out.push(`제목은 ${TITLE_MAX}자까지 쓸 수 있어요`);
  const n = d.questions.length;
  if (n < QUESTIONS_MIN) out.push(`질문을 ${QUESTIONS_MIN}개 이상 남겨 주세요 (지금 ${n}개)`);
  if (n > QUESTIONS_MAX) out.push(`질문은 ${QUESTIONS_MAX}개까지예요 (지금 ${n}개)`);
  const unanswered = d.questions.filter((q) => questionProblems(q).some((p) => p.field === "answer")).length;
  if (unanswered) out.push(`아직 답을 고르지 않은 질문이 ${unanswered}개 있어요`);
  const broken = d.questions.filter((q) => questionProblems(q).some((p) => p.field !== "answer")).length;
  if (broken) out.push(`고쳐야 할 질문이 ${broken}개 있어요`);
  return out;
}
export const canFinish = (d: Draft) => draftProblems(d).length === 0;

/** The `quizPack` payload for a finished draft (throws if it is not finished). */
export function buildQuizPack(d: Draft): QuizPack {
  const problems = draftProblems(d);
  if (problems.length) throw new Error(problems[0]);
  const questions = d.questions.map((q) => ({ q: q.q.trim(), options: q.options.map((o) => o.trim()), answer: q.answer as number }));
  return { title: d.title.trim(), questions, settings: { rounds: questions.length, answerMs: ANSWER_MS } };
}

/** A received pack is well-formed (what this device stored is still sendable). */
export function isQuizPack(p: unknown): p is QuizPack {
  const x = p as QuizPack;
  if (!x || typeof x.title !== "string" || !Array.isArray(x.questions)) return false;
  const draft: Draft = { title: x.title, questions: x.questions.map((q) => ({ id: "", q: String(q?.q ?? ""), options: Array.isArray(q?.options) ? q.options.map(String) : [], answer: Number.isInteger(q?.answer) ? q.answer : null })) };
  return canFinish(draft);
}

// ── device storage ──
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const DRAFT_KEY = "snack.quiz.draft";
const ROOMS_KEY = "snack.quiz.rooms";
/** Rooms remembered per device (oldest dropped first). */
const ROOMS_KEEP = 10;

const defaultKV = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw on the localStorage getter itself
  }
};

/** Device storage with an in-memory copy: works (for this page) when storage fails. */
export function quizStore(kv: KV | null = defaultKV()) {
  const mem = new Map<string, string>();
  const read = (k: string): string | null => {
    try {
      const v = kv?.getItem(k);
      if (v != null) return v;
    } catch { /* blocked storage: the memory copy below */ }
    return mem.get(k) ?? null;
  };
  /** True when the value reached device storage (false: kept in memory only). */
  const write = (k: string, v: string | null): boolean => {
    if (v === null) mem.delete(k);
    else mem.set(k, v);
    try {
      if (!kv) return false;
      if (v === null) kv.removeItem(k);
      else kv.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  };
  const parse = <T>(s: string | null): T | null => {
    try {
      return s ? (JSON.parse(s) as T) : null;
    } catch {
      return null;
    }
  };
  type Rooms = Record<string, { pack: QuizPack; at: number; confirmed?: boolean }>;
  const rooms = () => parse<Rooms>(read(ROOMS_KEY)) ?? {};
  return {
    loadDraft(): Draft | null {
      const d = parse<Draft>(read(DRAFT_KEY));
      if (!d || typeof d.title !== "string" || !Array.isArray(d.questions)) return null;
      const questions = d.questions
        .filter((q) => q && typeof q.q === "string" && Array.isArray(q.options))
        .map((q) => ({ id: typeof q.id === "string" && q.id ? q.id : newId(), q: q.q, options: q.options.map(String).slice(0, OPTIONS_MAX), answer: Number.isInteger(q.answer) ? q.answer : null, ...(q.custom ? { custom: true } : {}) }));
      return { title: d.title, questions };
    },
    saveDraft: (d: Draft) => write(DRAFT_KEY, JSON.stringify(d)),
    clearDraft: () => write(DRAFT_KEY, null),
    /** This device made `pack` for the room `roomId` (the subject's device re-sends it). */
    rememberRoomPack(roomId: string, pack: QuizPack, now = Date.now()) {
      const all = rooms();
      all[roomId] = { pack, at: now };
      const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, ROOMS_KEEP);
      return write(ROOMS_KEY, JSON.stringify(Object.fromEntries(keep)));
    },
    roomPack(roomId: string): QuizPack | null {
      const p = rooms()[roomId]?.pack;
      return isQuizPack(p) ? p : null;
    },
    /** The room has played this device's pack (see packAction). */
    roomPackConfirmed: (roomId: string) => rooms()[roomId]?.confirmed === true,
    confirmRoomPack(roomId: string) {
      const all = rooms();
      if (!all[roomId]) return false;
      all[roomId].confirmed = true;
      return write(ROOMS_KEY, JSON.stringify(all));
    },
    /** Someone else became the subject in this room: stop re-sending this device's pack. */
    forgetRoomPack(roomId: string) {
      const all = rooms();
      if (!(roomId in all)) return true;
      delete all[roomId];
      return write(ROOMS_KEY, JSON.stringify(all));
    },
  };
}
export type QuizStore = ReturnType<typeof quizStore>;

/** One store per page, so the memory copy survives in-app navigation. */
let shared: QuizStore | null = null;
export const deviceQuizStore = () => (shared ??= quizStore());

// ── what the subject's device does in the room ──
/** Re-send gap: one quizPack per this long at most (the room acks or publishes quizInfo). */
export const RESEND_GAP_MS = 3000;
/** The room is playing this device's pack (lane A publishes quizInfo.about = the sender's nick). */
export const roomHasMyPack = (info: QuizInfo | null, myNick: string, packTitle: string) =>
  info?.custom === true && info.about === clampNick(myNick) && info.title === packTitle;

export type PackState = {
  /** The room's sessionPhase ("" before the first state). */
  phase: string;
  info: QuizInfo | null;
  myNick: string;
  packTitle: string;
  /** The room has played this device's pack before (stored per room). */
  confirmed: boolean;
  lastSentAt: number;
  now: number;
};
/**
 * What the device holding a pack for this room does now:
 *   "confirm" — the room plays my pack (remember that, so a later replacement is recognised)
 *   "forget"  — my pack WAS confirmed and the room now plays someone else's
 *               ("나도 만들기" in the same room): stop re-sending mine
 *   "send"    — the room takes a pack (lobby / result) and does not play mine:
 *               first join, a new "나도 만들기" pack replacing the previous
 *               subject's, or the room lost it (reconnect / hand-over →
 *               quizInfo.custom false). At most once per RESEND_GAP_MS.
 *   "wait"    — nothing to do now (mid-game: the room refuses packs)
 */
export function packAction(s: PackState): "confirm" | "forget" | "send" | "wait" {
  if (roomHasMyPack(s.info, s.myNick, s.packTitle)) return s.confirmed ? "wait" : "confirm";
  if (s.confirmed && s.info?.custom === true) return "forget";
  if (s.phase !== "lobby" && s.phase !== "result") return "wait";
  return s.now - s.lastSentAt >= RESEND_GAP_MS ? "send" : "wait";
}

/** Lobby copy (shell card). */
export function lobbyCopy(info: QuizInfo | null, isSubject: boolean, people: number): { title: string; body: string } {
  if (isSubject) {
    return {
      title: "친구를 초대해서 나를 얼마나 아는지 보자!",
      body: people > 1 ? `준비 완료 · ${people}명이 모였어요. 아래에서 시작해요` : "친구에게 초대 링크를 보내면 이 방으로 들어와요",
    };
  }
  const about = info?.custom && info.about ? `${info.about} 맞히기` : info?.title || "퀴즈";
  const count = info?.count ? ` · ${info.count}문제` : "";
  return { title: `${about}${count} · 곧 시작해요`, body: info?.custom ? "친구가 직접 만든 퀴즈예요" : "퀴즈를 만든 친구가 들어오면 그 퀴즈로 바뀌어요" };
}
