// "나 맞히기" quiz: the creator answers questions about themselves, invites
// friends, and the friends guess the creator's answers live. This file is the
// pure model (no DOM, no React), so the rules are unit-tested in Node
// (snack-player/test/quiz.test.ts):
//   - question templates `{ q, options }` (no answer) → a draft question whose
//     `answer` is set by the creator's tap
//   - validation with plain Korean messages (limits counted in graphemes)
//   - the `quizPack` room action payload (lane A's room engine stores it)
//   - per-device storage of the draft, of "which pack is mine in which room",
//     and of the last few quizzes made here (7-day expiry) — storage may throw
//     (private mode, blocked site data): an in-memory copy keeps the in-app
//     flow working for this page's lifetime.
//
// The questions never go into a link (the answers would leak in the URL): the
// creator's device sends them to the room as `quizPack` (see LiveApp).
import aboutMe from "./data/about-me.json";
import { capGraphemes, clampNick, NICK_MAX } from "./nick";

/** The together quiz app the maker feeds (its play link is /p/tpl-<id>). */
export const QUIZ_APP_ID = "speed-trivia-score";
export const QUIZ_SLUG = `tpl-${QUIZ_APP_ID}`;
/** `?make=1` on the quiz link opens the maker (in a room: for the next round). */
export { MAKE_PARAM } from "./links";
import { MAKE_PARAM as MAKE_PARAM_KEY, roomParamOf } from "./links";
/** Window event LiveApp listens for: open the maker over the current room. */
export const MAKE_EVENT = "snack:make-quiz";
/**
 * Host event a Bite template emits to open the maker (a template button can't
 * call JS): `{ "emit": "makeQuiz" }`. LiveApp handles it on the device and never
 * sends it to the room.
 */
export const MAKE_HOST_EVENT = "makeQuiz";
/**
 * "나도 만들기" (for the result screen): opens the maker over the room this
 * player is in. When done, the new quiz goes to the SAME room as `quizPack`,
 * so the next round is about this player. In the public room (no room code)
 * the maker opens on its own page and makes a new friends-only room instead.
 */
/**
 * The maker on its own page: the quiz link with ?make=1 and NO room param.
 * With a room code it opens over that room (LiveApp); with a cut/invalid code
 * the link is bad (LiveApp's bad-link screen), never the maker.
 */
export const opensMakerPage = (slug: string | undefined, params: URLSearchParams) =>
  slug === QUIZ_SLUG && params.has(MAKE_PARAM_KEY) && roomParamOf(params).kind === "none";

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

export type QuestionTemplate = { q: string; options: string[]; topic?: string };
/**
 * A question being made: `answer` is null until the creator taps their real answer.
 * `tpl` = the suggestion it came from (its question text); `custom` = written or
 * edited by the creator (then "다른 질문" asks before replacing it).
 */
export type DraftQuestion = { id: string; q: string; options: string[]; answer: number | null; custom?: boolean; tpl?: string };
export type Draft = {
  title: string;
  questions: DraftQuestion[];
  /** The name friends see ("<name> 맞히기"); starts as the device nickname. */
  name?: string;
  /** The nickname was auto-assigned: the creator must pick their name before 완료. */
  nameNeeded?: boolean;
  nameChosen?: boolean;
};
/** The `quizPack` room action payload (lane A: room engine). `about` = the subject's chosen name. */
export type QuizPack = {
  title: string;
  about?: string;
  questions: { q: string; options: string[]; answer: number }[];
  settings: { rounds: number; answerMs: number };
};
/** What the room publishes (no answers). `about` = the subject's name. */
export type QuizInfo = { title?: string; count?: number; custom?: boolean; answerMs?: number; about?: string | null; packId?: string | null };

export const ABOUT_ME: QuestionTemplate[] = (aboutMe as { questions: QuestionTemplate[] }).questions;

// ── text (one Korean syllable / one emoji = one grapheme) ──
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
/** One line: line breaks (typed or pasted) become a space — the game shows one-line text. */
export const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ");
/** Input helper: the text as typed on one line, cut at `max` graphemes. */
export const capText = (s: string, max: number) => capGraphemes(oneLine(s), max);

export const defaultTitle = (name: string | null | undefined) => `${clampNick(name ?? "") || "나"} 맞히기`;

// ── making questions ──
let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;
export const fromTemplate = (t: QuestionTemplate): DraftQuestion => ({ id: newId(), q: t.q, options: [...t.options], answer: null, tpl: t.q });
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
export function newDraft(
  nick: string | null | undefined,
  { random = Math.random, pool = ABOUT_ME, nickAuto = false }: { random?: () => number; pool?: QuestionTemplate[]; nickAuto?: boolean } = {},
): Draft {
  const name = clampNick(nick ?? "");
  return {
    title: defaultTitle(name),
    questions: pickTemplates(pool, SUGGEST_COUNT, random).map(fromTemplate),
    name,
    nameNeeded: nickAuto || !name,
    nameChosen: false,
  };
}

/** The creator picks their name; a title still on the old default follows it. */
export function setName(d: Draft, raw: string, { composing = false }: { composing?: boolean } = {}): Draft {
  // While an IME is composing a syllable the text is never cut (it would break the syllable).
  const name = composing ? oneLine(raw) : capText(raw, NICK_MAX);
  const title = d.title === defaultTitle(d.name) ? defaultTitle(name) : d.title;
  return { ...d, name, title, nameChosen: true };
}

/** A template not already in the draft (by suggestion or text), or null when the pool is used up. */
export function swapCandidate(draft: Draft, random: () => number = Math.random, pool: QuestionTemplate[] = ABOUT_ME): QuestionTemplate | null {
  const used = new Set(draft.questions.flatMap((x) => [x.q.trim(), x.tpl ?? ""]));
  const left = pool.filter((t) => !used.has(t.q.trim()));
  return left.length ? left[Math.floor(random() * left.length)] : null;
}
/** "다른 질문" on a question the creator wrote or edited asks first (never replaced silently). */
export const swapNeedsConfirm = (q: DraftQuestion) => q.custom === true;
/** "추천 질문 추가": one more suggestion at the end (none when full or the pool is used up). */
export function addSuggested(d: Draft, random: () => number = Math.random, pool: QuestionTemplate[] = ABOUT_ME): Draft {
  if (d.questions.length >= QUESTIONS_MAX) return d;
  const t = swapCandidate(d, random, pool);
  return t ? { ...d, questions: [...d.questions, fromTemplate(t)] } : d;
}

/** Tapping an option marks it as the creator's real answer (tap again: unmark). */
export const tapAnswer = (q: DraftQuestion, i: number): DraftQuestion => ({ ...q, answer: q.answer === i ? null : i });
/** Text edits (question or options) make a suggestion the creator's own. */
export const editQuestion = (q: DraftQuestion, text: string): DraftQuestion => ({ ...q, q: capText(text, Q_MAX), custom: true });
export const editOption = (q: DraftQuestion, k: number, text: string): DraftQuestion =>
  ({ ...q, options: q.options.map((v, j) => (j === k ? capText(text, OPTION_MAX) : v)), custom: true });

/** Remove option `i`, keeping the marked answer on the same option (or clearing it if removed). */
export function removeOption(q: DraftQuestion, i: number): DraftQuestion {
  if (q.options.length <= OPTIONS_MIN) return q;
  const options = q.options.filter((_, k) => k !== i);
  const answer = q.answer === null || q.answer === i ? null : q.answer > i ? q.answer - 1 : q.answer;
  return { ...q, options, answer, custom: true };
}
export const addOption = (q: DraftQuestion): DraftQuestion =>
  q.options.length >= OPTIONS_MAX ? q : { ...q, options: [...q.options, ""], custom: true };

// ── validation ──
export type QuestionProblem = { field: "q" | "options" | "answer"; message: string };
export function questionProblems(q: DraftQuestion): QuestionProblem[] {
  const out: QuestionProblem[] = [];
  const text = oneLine(q.q).trim();
  if (!text) out.push({ field: "q", message: "질문을 적어 주세요" });
  else if (graphemeLength(text) > Q_MAX) out.push({ field: "q", message: `질문은 ${Q_MAX}자까지 쓸 수 있어요` });
  const opts = q.options.map((o) => oneLine(o).trim());
  if (opts.length < OPTIONS_MIN || opts.length > OPTIONS_MAX) out.push({ field: "options", message: `보기는 ${OPTIONS_MIN}~${OPTIONS_MAX}개로 만들어 주세요` });
  else if (opts.some((o) => !o)) out.push({ field: "options", message: "빈 보기를 채우거나 지워 주세요" });
  else if (opts.some((o) => graphemeLength(o) > OPTION_MAX)) out.push({ field: "options", message: `보기는 ${OPTION_MAX}자까지 쓸 수 있어요` });
  else if (new Set(opts).size !== opts.length) out.push({ field: "options", message: "같은 보기가 두 번 있어요" });
  if (q.answer === null || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= opts.length) {
    out.push({ field: "answer", message: "내 진짜 답을 눌러 주세요" });
  }
  return out;
}

/** The name problem, if any (only asked when the nickname was auto-assigned or missing). */
export function nameProblem(d: Draft): string | null {
  if (!d.nameNeeded) return null;
  if (!clampNick(d.name ?? "")) return "친구들이 알아볼 내 이름을 적어 주세요";
  if (!d.nameChosen) return "친구들이 알아볼 내 이름을 정해 주세요";
  return null;
}

/** Everything that keeps "완료" disabled, in reading order (empty = ready). */
export function draftProblems(d: Draft): string[] {
  const out: string[] = [];
  const name = nameProblem(d);
  if (name) out.push(name);
  const title = oneLine(d.title).trim();
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
  const line = (s: string) => oneLine(s).trim();
  const questions = d.questions.map((q) => ({ q: line(q.q), options: q.options.map(line), answer: q.answer as number }));
  const about = clampNick(d.name ?? "");
  return { title: line(d.title), ...(about ? { about } : {}), questions, settings: { rounds: questions.length, answerMs: ANSWER_MS } };
}

/** A stored pack is well-formed (still sendable). */
export function isQuizPack(p: unknown): p is QuizPack {
  const x = p as QuizPack;
  if (!x || typeof x.title !== "string" || !Array.isArray(x.questions)) return false;
  const draft: Draft = { title: x.title, questions: x.questions.map((q) => ({ id: "", q: String(q?.q ?? ""), options: Array.isArray(q?.options) ? q.options.map(String) : [], answer: Number.isInteger(q?.answer) ? q.answer : null })) };
  return canFinish(draft);
}

/** "내 퀴즈로 다시 하기": a quiz made before, back in the editor (answers kept). */
export function draftFromPack(p: QuizPack, nick: string | null | undefined): Draft {
  const name = clampNick(p.about ?? nick ?? "");
  return {
    title: p.title,
    questions: p.questions.map((q) => ({ id: newId(), q: q.q, options: [...q.options], answer: q.answer, custom: true })),
    name,
    nameNeeded: false,
    nameChosen: true,
  };
}

// ── device storage ──
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const DRAFT_KEY = "snack.quiz.draft";
const ROOMS_KEY = "snack.quiz.rooms";
const RECENT_KEY = "snack.quiz.recent";
/** Rooms remembered per device (oldest dropped first). */
const ROOMS_KEEP = 10;
/** Quizzes made on this device, kept for "내 퀴즈로 다시 하기". */
export const RECENT_KEEP = 3;
/** Stored rooms and quizzes expire after this long. */
export const QUIZ_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const defaultKV = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw on the localStorage getter itself
  }
};

/** What this device knows about its pack in one room. */
export type RoomEntry = {
  pack: QuizPack;
  at: number;
  /** The room has made this device the subject (iAmSubject) at least once. */
  confirmed?: boolean;
  /** Sends since the last confirmation (packAction gives up at MAX_SENDS). */
  sends?: number;
  /** The room refused the pack ("invalid_pack" / not the current subject's). */
  refused?: string;
  /**
   * The room's quizInfo.packId when this pack was made here (null = no custom quiz then).
   * A subject remaking their quiz is already iAmSubject: only a NEW packId means the
   * room took this pack. Undefined (made on its own page, older entries): iAmSubject alone.
   */
  madeOver?: string | null;
};

/** Device storage with an in-memory copy: works (for this page) when storage fails. */
export function quizStore(kv: KV | null = defaultKV(), clock: () => number = Date.now) {
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
  const fresh = (at: unknown) => typeof at === "number" && clock() - at < QUIZ_TTL_MS;
  type Rooms = Record<string, RoomEntry>;
  const rooms = (): Rooms => {
    const all = parse<Rooms>(read(ROOMS_KEY));
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    return Object.fromEntries(Object.entries(all).filter(([, e]) => e && fresh(e.at) && isQuizPack(e.pack)));
  };
  const saveRooms = (all: Rooms) => {
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, ROOMS_KEEP);
    return write(ROOMS_KEY, JSON.stringify(Object.fromEntries(keep)));
  };
  const patchRoom = (roomId: string, f: (e: RoomEntry) => RoomEntry) => {
    const all = rooms();
    if (!all[roomId]) return false;
    all[roomId] = f(all[roomId]);
    return saveRooms(all);
  };
  type Recent = { pack: QuizPack; at: number }[];
  const recent = (): Recent => {
    const list = parse<Recent>(read(RECENT_KEY));
    return Array.isArray(list) ? list.filter((x) => x && fresh(x.at) && isQuizPack(x.pack)) : [];
  };
  const sameQuiz = (a: QuizPack, b: QuizPack) => JSON.stringify([a.title, a.questions]) === JSON.stringify([b.title, b.questions]);
  return {
    loadDraft(): Draft | null {
      const d = parse<Draft>(read(DRAFT_KEY));
      if (!d || typeof d.title !== "string" || !Array.isArray(d.questions)) return null;
      const questions = d.questions
        .filter((q) => q && typeof q.q === "string" && Array.isArray(q.options))
        .map((q) => ({
          id: typeof q.id === "string" && q.id ? q.id : newId(), q: q.q, options: q.options.map(String).slice(0, OPTIONS_MAX),
          answer: Number.isInteger(q.answer) ? q.answer : null,
          ...(q.custom ? { custom: true } : {}), ...(typeof q.tpl === "string" ? { tpl: q.tpl } : {}),
        }));
      const name = typeof d.name === "string" ? d.name : undefined;
      return { title: d.title, questions, ...(name !== undefined ? { name } : {}), nameNeeded: d.nameNeeded === true, nameChosen: d.nameChosen === true };
    },
    saveDraft: (d: Draft) => write(DRAFT_KEY, JSON.stringify(d)),
    clearDraft: () => write(DRAFT_KEY, null),
    /** This device made `pack` for the room `roomId` (the subject's device sends it); also kept in the recent list. */
    rememberRoomPack(roomId: string, pack: QuizPack, madeOver?: string | null) {
      const all = rooms();
      all[roomId] = { pack, at: clock(), ...(madeOver !== undefined ? { madeOver } : {}) };
      const list = [{ pack, at: clock() }, ...recent().filter((x) => !sameQuiz(x.pack, pack))].slice(0, RECENT_KEEP);
      const a = write(RECENT_KEY, JSON.stringify(list));
      return saveRooms(all) && a;
    },
    roomEntry: (roomId: string): RoomEntry | null => rooms()[roomId] ?? null,
    roomPack: (roomId: string): QuizPack | null => rooms()[roomId]?.pack ?? null,
    /** The room made this device the subject: confirmed, send count reset. */
    confirmRoomPack: (roomId: string) => patchRoom(roomId, (e) => ({ ...e, confirmed: true, sends: 0, refused: undefined })),
    countSend: (roomId: string) => patchRoom(roomId, (e) => ({ ...e, sends: (e.sends ?? 0) + 1 })),
    refuseRoomPack: (roomId: string, reason: string) => patchRoom(roomId, (e) => ({ ...e, refused: reason })),
    /** "다시 보내기" after giving up: count from zero again. */
    retryRoomPack: (roomId: string) => patchRoom(roomId, (e) => ({ ...e, sends: 0, refused: undefined })),
    /**
     * Someone else is the subject in this room now: stop sending this device's
     * pack there. The quiz itself stays in the recent list ("내 퀴즈로 다시 하기").
     */
    forgetRoomPack(roomId: string) {
      const all = rooms();
      if (!(roomId in all)) return true;
      delete all[roomId];
      return saveRooms(all);
    },
    /** Quizzes made on this device, newest first (at most RECENT_KEEP, none older than 7 days). */
    recentPacks: (): QuizPack[] => recent().map((x) => x.pack),
  };
}
export type QuizStore = ReturnType<typeof quizStore>;

/** One store per page, so the memory copy survives in-app navigation. */
let shared: QuizStore | null = null;
export const deviceQuizStore = () => (shared ??= quizStore());

// ── what the subject's device does in the room ──
/** Re-send gap: one quizPack per this long at most. */
export const RESEND_GAP_MS = 3000;
/** Unconfirmed sends before this device gives up and says so. */
export const MAX_SENDS = 5;
/** Ack reasons that mean "this pack will not be taken" (stop re-sending). */
export const PACK_REFUSALS = new Set(["invalid_pack", "not_subject", "pack_waiting"]);

export type PackState = {
  /** The room's sessionPhase ("lobby" until the room sets it). */
  phase: string;
  info: QuizInfo | null;
  /** The room's per-player flag (lane A): true = this device's pack is the room's quiz. Undefined until the room says. */
  iAmSubject: boolean | undefined;
  entry: Pick<RoomEntry, "confirmed" | "sends" | "refused" | "madeOver">;
  lastSentAt: number;
  now: number;
};
/**
 * What the device holding a pack for this room does now:
 *   "confirm" — the room made me the subject (remember it; the send count resets)
 *   "forget"  — I was the subject and the room now plays someone else's quiz:
 *               stop sending mine to this room (the quiz stays in the recent list)
 *   "send"    — the room takes a pack (lobby / result) and either has no custom
 *               quiz (first join, or it lost it on a reconnect / hand-over) or
 *               has not made me the subject yet (a new "나도 만들기" quiz).
 *               At most once per RESEND_GAP_MS.
 *   "failed"  — refused, or MAX_SENDS sends without the room making me the subject:
 *               stop and say so (the screen offers to retry / remake)
 *   "wait"    — nothing to do now (mid-game: the room refuses packs)
 */
/** The room plays this device's pack: I am its subject, under a packId newer than the one I made over. */
export function roomHasMyPack(s: PackState): boolean {
  if (s.iAmSubject !== true) return false;
  const made = s.entry.madeOver;
  return made === undefined || (s.info?.custom === true && (s.info.packId ?? null) !== made);
}
export function packAction(s: PackState): "confirm" | "forget" | "send" | "failed" | "wait" {
  const { confirmed = false, sends = 0, refused } = s.entry;
  if (roomHasMyPack(s)) return confirmed && !sends && !refused ? "wait" : "confirm";
  if (confirmed && s.iAmSubject === false && s.info?.custom === true) return "forget";
  if (refused) return "failed";
  const wantSend = !s.info?.custom || !confirmed; // (iAmSubject is not true here)
  if (!wantSend) return "wait";
  if (sends >= MAX_SENDS) return "failed";
  if (s.phase !== "lobby" && s.phase !== "result") return "wait";
  return s.now - s.lastSentAt >= RESEND_GAP_MS ? "send" : "wait";
}

/**
 * This device holds a pack the room has not taken yet and is still trying to hand it over
 * (not refused, not given up). Meanwhile the quiz template shows "<title> · 준비 중…" with no
 * start button (the shell sets its `packPending` var): the room's current quiz — usually the
 * cold default one — must not be started from here by mistake.
 */
export function packPending(s: PackState): boolean {
  const { confirmed = false, sends = 0, refused } = s.entry;
  if (roomHasMyPack(s) || refused || sends >= MAX_SENDS) return false;
  return !confirmed || s.info?.custom !== true; // = packAction's "want to send"
}

/** What the screen says when the pack did not reach the room (only what happened). */
export function packFailureMessage(refused: string | undefined): string {
  if (refused === "invalid_pack") return "퀴즈를 방에 넘기지 못했어요. 퀴즈를 다시 만들어 주세요.";
  if (refused === "not_subject") return "지금은 다른 친구의 퀴즈 차례라 내 퀴즈를 넘기지 못했어요. 이번 판이 끝나면 다시 해 주세요.";
  if (refused === "pack_waiting") return "다른 친구가 먼저 새 퀴즈를 만들었어요. 그 판이 끝나면 다시 보내 주세요.";
  return "퀴즈를 방에 넘기지 못했어요. 연결을 확인하고 다시 보내 주세요.";
}
