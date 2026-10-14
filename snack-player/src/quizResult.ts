// "나 맞히기 퀴즈" result: turns the room's result vars (quizRecap, raceBoard,
// roster, quizInfo, iAmSubject) into one ready-to-draw view. The template's
// result phase (speed-trivia-score) reads it as the `resultView` var and the
// result image (resultImage.ts) draws the same object, so the screen and the
// picture never disagree. Pure, so it is unit-tested in Node
// (snack-player/test/quizResult.test.ts).
//
// Rules (product brief + owner's MVP decision 2026-10-13, review 2026-10-13):
//   · Players are keyed by the engine's `pid`, never by nickname: two friends
//     called "빠른감자" are two rows ("빠른감자", "빠른감자 (2)").
//   · The engine already leaves the subject out of picks and the board, so an
//     answerer whose name equals the subject's is still an answerer.
//   · Scores = the sum of each answerer's `picks[].points` (raceBoard is top-8
//     only); the board only says who left (MP-12).
//   · Equal scores share a rank ("공동 1위") — no tie-break is invented.
//   · Exactly one answerer → no ranking: "<friend>는 <subject>를 N/M 맞혔어요"
//     plus a light tier line by ratio.
//   · The finished quiz is described only by quizRecap (title / about /
//     subject) and the `iAmSubject` the caller latched when the result began,
//     so a new pack arriving during the result never relabels it. The live
//     quizInfo / iAmSubject only decide the next-game control.

export type QuizPick = { pid?: string; nick: string; option: number; ms?: number; correct: boolean; points?: number };
export type QuizRound = { q: string; options: string[]; answer: number; picks: QuizPick[] };
export type QuizRecap = { subject: string | null; rounds: QuizRound[]; title?: string; about?: string | null; packId?: string | null };
export type BoardEntry = { pid?: string; nick: string; score: number; left?: boolean };
export type QuizInfo = { title?: string; count?: number; custom?: boolean; about?: string | null; packId?: string | null; subjectHere?: boolean };

export type ResultInput = {
  quizRecap?: Partial<QuizRecap> | null;
  raceBoard?: BoardEntry[] | null;
  roster?: string[] | null;
  /** Live — used only for the next-game control. */
  quizInfo?: QuizInfo | null;
  /** Whether this device was the finished quiz's subject (latched at result entry). */
  iAmSubject?: boolean;
  /** Live "am I the subject of the quiz now loaded?" — next-game control only. Defaults to iAmSubject. */
  iAmSubjectNow?: boolean;
  /** This device's nickname (identity.getNick) — "me" only when it is unique among the answerers. */
  myNick?: string | null;
  /** This device's pid, when the engine tells it — preferred over the nickname. */
  myPid?: string | null;
  /** Whether "나도 만들기" is wired (decides which button is the lime one). */
  canMake?: boolean;
};

export type RankRow = { key: string; rank: number; rankLabel: string; nick: string; score: number; scoreLabel: string; correct: number; accuracyLabel: string; speedLabel: string; left: boolean; me: boolean; top: boolean };
export type Chip = { nick: string; pick: string; state: "ok" | "bad" | "none" };
export type QuestionRow = { n: number; q: string; answer: string; summary: string; correctCount: number; answered: number; chips: Chip[] };
export type Tier = { key: "cold" | "close" | "bestie" | "soulmate"; label: string };
/** "" none · startMine = I made the waiting quiz · waiting = someone else's quiz is waiting · again = default quiz, play again · make = 나도 만들기 */
export type NextStep = "" | "startMine" | "waiting" | "again" | "make";

export type ResultView = {
  /** "" = no result data yet · "rank" = 2+ answerers · "duo" = exactly one answerer · "empty" = nobody answered */
  mode: "" | "rank" | "duo" | "empty";
  /** Short line above the headline, e.g. "민수 맞히기 · 결과". */
  kicker: string;
  /** The quiz's title (for the image): quizRecap.title, else "<subject> 맞히기". */
  title: string;
  headline: string;
  /** This device's place, e.g. "내 순위 공동 1위 · 1,820점" ("" for the subject / a spectator / ambiguous). */
  mine: string;
  ranks: RankRow[];
  duo: { line: string; score: string; tier: string; tierKey: string; speed: string };
  emptyText: string;
  questions: QuestionRow[];
  subject: string | null;
  iAmSubject: boolean;
  total: number;
  next: NextStep;
  nextText: string;
  /** 결과 공유 is the lime button when no other lime control is shown. */
  sharePrimary: boolean;
};

/** The room's mark on a player who left (packages/snack-room/src/room.js LEFT_MARK). */
export const LEFT_MARK = "(나감)";

export const EMPTY_VIEW: ResultView = {
  mode: "", kicker: "", title: "", headline: "", mine: "", ranks: [],
  duo: { line: "", score: "", tier: "", tierKey: "", speed: "" }, emptyText: "", questions: [],
  subject: null, iAmSubject: false, total: 0, next: "", nextText: "", sharePrimary: true,
};

// ── Korean particles (을/를, 은/는) ──
// Decided by the last character: a Hangul syllable with a final consonant, or a
// digit read with one (0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔). Anything else (Latin,
// emoji, ")") gets the combined form, which is always correct.
function batchim(word: string): boolean | null {
  const chars = Array.from(word.trim());
  const last = chars[chars.length - 1];
  if (!last) return null;
  const cp = last.codePointAt(0)!;
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return "013678".includes(last);
  return null;
}
const particle = (word: string, withB: string, without: string) => {
  const b = batchim(word);
  return b === null ? `${withB}(${without})` : b ? withB : without;
};
export const eulReul = (w: string) => w + particle(w, "을", "를");
export const eunNeun = (w: string) => w + particle(w, "은", "는");

/** Thousands separators without Intl (identical in Node and every browser). */
export const fmtScore = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}점`;

/** Tier for one answerer: 0–40% 아직 서먹 · 41–70% 꽤 친함 · 71–99% 찐친 · 100% 소울메이트. */
export function tierFor(correct: number, total: number): Tier | null {
  if (!(total > 0)) return null;
  const pct = (Math.max(0, Math.min(correct, total)) / total) * 100;
  if (pct >= 100) return { key: "soulmate", label: "소울메이트 💞" };
  if (pct > 70) return { key: "bestie", label: "찐친 🔥" };
  if (pct > 40) return { key: "close", label: "꽤 친함 🙂" };
  return { key: "cold", label: "아직 서먹 🧊" };
}

const stripLeft = (nick: string) => {
  const s = String(nick ?? "");
  return s.endsWith(` ${LEFT_MARK}`) ? s.slice(0, -LEFT_MARK.length - 1) : s;
};
/** The player key: the engine's pid; a nick-based key only for an engine without pids. */
const keyOf = (row: { pid?: string; nick: string }) => (row.pid ? `p:${row.pid}` : `n:${stripLeft(row.nick)}`);

/** Average time of the right answers: "평균 2.3초" (one decimal). */
export function speedLabel(avgMs: number): string {
  return `평균 ${(Math.max(0, avgMs) / 1000).toFixed(1)}초`;
}

/** Whole-number percent, never 100 unless all (99.6 → 99). */
export function pctOf(n: number, of: number): number {
  if (of <= 0) return 0;
  return n >= of ? 100 : Math.floor((n / of) * 100);
}

/** Ranks with honest ties: rank = 1 + number of strictly higher scores. */
export function rankScores<T extends { score: number }>(rows: T[]): (T & { rank: number; tied: boolean })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score); // stable: equal scores keep their order
  return sorted.map((r) => ({
    ...r,
    rank: 1 + sorted.filter((o) => o.score > r.score).length,
    tied: sorted.filter((o) => o.score === r.score).length > 1,
  }));
}

/** The next-game control, from the live quizInfo vs the finished recap. */
export function nextStep(input: { quizRecap?: Partial<QuizRecap> | null; quizInfo?: QuizInfo | null; iAmSubjectNow?: boolean; roster?: string[] | null }): { next: NextStep; nextText: string } {
  const recap = input.quizRecap ?? {};
  const info = input.quizInfo ?? {};
  const finishedSubject = recap.about || recap.subject || null;
  // A waiting quiz whose maker has been gone 30 s (room: subjectHere false) no longer holds the room: 나도 만들기 again.
  const waiting = Boolean(info.custom && info.packId && info.packId !== (recap.packId ?? null) && (info.subjectHere !== false || input.iAmSubjectNow));
  if (waiting) {
    if (input.iAmSubjectNow) {
      return (input.roster?.length ?? 0) >= 2
        ? { next: "startMine", nextText: "" }
        : { next: "waiting", nextText: "친구가 들어오면 내 퀴즈를 시작할 수 있어요" };
    }
    const who = info.about ? `${info.about}님이` : "누군가";
    return { next: "waiting", nextText: `${who} 새 퀴즈를 만들었어요 · 곧 시작해요` };
  }
  if (!finishedSubject) return { next: "again", nextText: "" };
  return { next: "make", nextText: "" };
}

export function buildResultView(input: ResultInput): ResultView {
  const recap = input.quizRecap ?? {};
  const rounds = Array.isArray(recap.rounds) ? recap.rounds.filter((r) => r && typeof r.q === "string") : [];
  const subject = (typeof recap.about === "string" && recap.about) || (typeof recap.subject === "string" && recap.subject) || null;
  // A default quiz has no subject: nobody is "나" there, whatever the flag says.
  const iAmSubject = input.iAmSubject === true && subject !== null;
  const board = Array.isArray(input.raceBoard) ? input.raceBoard : [];
  const next = nextStep({ quizRecap: recap, quizInfo: input.quizInfo, iAmSubjectNow: input.iAmSubjectNow ?? input.iAmSubject === true, roster: input.roster });
  const sharePrimary = !(next.next === "startMine" || next.next === "again" || (next.next === "make" && input.canMake));

  // Answerers: everyone in any round's picks (the engine lists each answerer in
  // every round), plus board rows not in the picks (an engine without a recap).
  type P = { key: string; pid?: string; nick: string; score: number; fromPicks: boolean; correct: number; okMs: number; okN: number; left: boolean };
  const players = new Map<string, P>();
  const add = (row: { pid?: string; nick: string }) => {
    const key = keyOf(row);
    if (!players.has(key)) players.set(key, { key, pid: row.pid, nick: stripLeft(row.nick), score: 0, fromPicks: false, correct: 0, okMs: 0, okN: 0, left: false });
    return players.get(key)!;
  };
  for (const r of rounds) {
    for (const pk of r.picks ?? []) {
      if (!pk || typeof pk.nick !== "string") continue;
      const p = add(pk);
      if (Number.isFinite(pk.points)) {
        p.score += Number(pk.points);
        p.fromPicks = true;
      }
      if (pk.correct) {
        p.correct += 1;
        const ms = Number(pk.ms);
        if (Number.isFinite(ms) && ms >= 0) { p.okMs += ms; p.okN += 1; }
      }
    }
  }
  for (const e of board) {
    if (!e || typeof e.nick !== "string") continue;
    const p = add(e);
    if (!p.fromPicks && Number.isFinite(e.score)) p.score = e.score; // no per-pick points: the board's total
    if (e.left || e.nick !== stripLeft(e.nick)) p.left = true;
  }

  // Display names: a repeated nickname gets "(2)", "(3)" in order of appearance.
  const seen = new Map<string, number>();
  const display = new Map<string, string>();
  for (const p of players.values()) {
    const n = (seen.get(p.nick) ?? 0) + 1;
    seen.set(p.nick, n);
    display.set(p.key, n === 1 ? p.nick : `${p.nick} (${n})`);
  }
  const myNick = input.myNick ?? "";
  const isMe = (p: P) =>
    !iAmSubject && (input.myPid ? p.pid === input.myPid : !!myNick && p.nick === myNick && seen.get(myNick) === 1);

  const total = rounds.length;
  const title = (recap.title ?? "").trim() || (subject ? `${subject} 맞히기` : "스피드 퀴즈");
  const subjectWord = iAmSubject ? "나" : subject;

  const ranked = rankScores([...players.values()]);
  const ranks: RankRow[] = ranked.map((r) => ({
    key: r.key,
    rank: r.rank,
    rankLabel: r.tied ? `공동 ${r.rank}위` : `${r.rank}위`,
    nick: display.get(r.key)!,
    score: r.score,
    scoreLabel: fmtScore(r.score),
    correct: r.correct,
    accuracyLabel: total > 0 ? `${r.correct}/${total} · ${pctOf(r.correct, total)}%` + (r.okN ? ` · ${speedLabel(r.okMs / r.okN)}` : "") : "",
    speedLabel: r.okN ? speedLabel(r.okMs / r.okN) : "",
    left: r.left,
    me: isMe(r),
    top: r.rank === 1,
  }));

  const questions: QuestionRow[] = rounds.map((r, i) => {
    const chips: Chip[] = (r.picks ?? []).filter((p) => p && typeof p.nick === "string").map((p) => ({
      nick: display.get(keyOf(p)) ?? p.nick,
      pick: p.option >= 0 ? (r.options?.[p.option] ?? "?") : "무응답",
      state: p.option < 0 ? "none" : p.correct ? "ok" : "bad",
    }));
    const correctCount = chips.filter((c) => c.state === "ok").length;
    const answered = chips.filter((c) => c.state !== "none").length;
    const summary = answered === 0 ? "답한 친구가 없어요"
      : correctCount === 0 ? "아무도 못 맞혔어요"
      : correctCount === chips.length ? (chips.length === 1 ? "맞혔어요" : "모두 맞혔어요")
      : `${pctOf(correctCount, chips.length)}% 맞힘 (${correctCount}/${chips.length}명)`;
    return { n: i + 1, q: r.q, answer: r.options?.[r.answer] ?? "", summary, correctCount, answered, chips };
  });

  const base: ResultView = { ...EMPTY_VIEW, kicker: `${title} · 결과`, title, questions, subject, iAmSubject, total, ranks, ...next, sharePrimary };
  const nobodyAnswered = rounds.length > 0 && questions.every((q) => q.answered === 0) && ![...players.values()].some((p) => p.score > 0);

  if (players.size === 0 || nobodyAnswered) {
    if (rounds.length === 0 && board.length === 0) return { ...EMPTY_VIEW, subject, iAmSubject, title, ...next, sharePrimary };
    return { ...base, mode: "empty", ranks: [], headline: subjectWord ? `${eulReul(subjectWord)} 맞혀 볼 친구를 기다려요` : "결과", emptyText: "답한 친구가 없어요" };
  }

  if (players.size === 1) {
    const p = ranked[0];
    const name = display.get(p.key)!;
    const tier = subject ? tierFor(p.correct, total) : null;
    const line = total > 0
      ? (subjectWord ? `${eunNeun(name)} ${eulReul(subjectWord)} ${p.correct}/${total} 맞혔어요` : `${eunNeun(name)} ${p.correct}/${total} 맞혔어요`)
      : `${eunNeun(name)} ${fmtScore(p.score)}을 얻었어요`;
    return {
      ...base,
      mode: "duo",
      headline: subjectWord ? `${eulReul(subjectWord)} 얼마나 잘 알까?` : "결과",
      duo: { line: p.left ? `${line} · 나감` : line, score: total > 0 ? `${p.correct}/${total}` : fmtScore(p.score), tier: tier?.label ?? "", tierKey: tier?.key ?? "", speed: `${fmtScore(p.score)}` + (p.okN ? ` · 맞힌 문제 ${speedLabel(p.okMs / p.okN)}` : "") },
    };
  }

  const meRow = ranks.find((r) => r.me);
  return {
    ...base,
    mode: "rank",
    headline: subjectWord ? `${eulReul(subjectWord)} 제일 잘 아는 친구는?` : "누가 제일 잘 맞혔을까?",
    mine: meRow ? `내 순위 ${meRow.rankLabel} · ${meRow.scoreLabel}${meRow.accuracyLabel ? ` · ${meRow.accuracyLabel}` : ""}` : "",
  };
}

/** Questions worth putting on the image: the fewest right answers first (the
    surprising ones), at most `n`, shown in quiz order. */
export function highlightQuestions(view: ResultView, n = 3): QuestionRow[] {
  const ratio = (q: QuestionRow) => (q.chips.length ? q.correctCount / q.chips.length : 1);
  return [...view.questions]
    .sort((a, b) => ratio(a) - ratio(b) || a.n - b.n)
    .slice(0, n)
    .sort((a, b) => a.n - b.n);
}
