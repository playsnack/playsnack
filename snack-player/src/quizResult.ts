// "나 맞히기 퀴즈" result: turns the room's result vars (quizRecap, raceBoard,
// roster, quizInfo, iAmSubject) into one ready-to-draw view. The template's
// result phase (speed-trivia-score) reads it as the `resultView` var and the
// result image (resultImage.ts) draws the same object, so the screen and the
// picture never disagree. Pure, so it is unit-tested in Node
// (snack-player/test/quizResult.test.ts).
//
// Rules (product brief + owner's MVP decision 2026-10-13):
//   · The subject (the pack's sender) does not answer; they are never ranked.
//   · Ranking = answerers by score. Equal scores share a rank ("공동 1위") — no
//     tie-break is invented.
//   · Exactly one answerer → no ranking: "<friend>는 <subject>를 N/M 맞혔어요"
//     plus a light tier line by ratio.
//   · A player who left stays in the ranking, marked (room MP-12).
// Assumption: nicknames identify players (the room sends nicks, not ids), so
// two answerers with the same nick are merged. The subject is identified by
// `iAmSubject` on their own device, never by comparing nicks.

export type QuizPick = { nick: string; option: number; ms?: number; correct: boolean; points?: number };
export type QuizRound = { q: string; options: string[]; answer: number; picks: QuizPick[] };
export type QuizRecap = { subject: string | null; rounds: QuizRound[] };
export type BoardEntry = { nick: string; score: number; left?: boolean };
export type QuizInfo = { title?: string; count?: number; custom?: boolean; about?: string | null };

export type ResultInput = {
  quizRecap?: Partial<QuizRecap> | null;
  raceBoard?: BoardEntry[] | null;
  roster?: string[] | null;
  quizInfo?: QuizInfo | null;
  /** Set by the room on the subject's device only. */
  iAmSubject?: boolean;
  /** This device's nickname (identity.getNick). */
  myNick?: string | null;
};

export type RankRow = { rank: number; rankLabel: string; nick: string; score: number; scoreLabel: string; correct: number; left: boolean; me: boolean; top: boolean };
export type Chip = { nick: string; pick: string; state: "ok" | "bad" | "none" };
export type QuestionRow = { n: number; q: string; answer: string; summary: string; correctCount: number; answered: number; chips: Chip[] };
export type Tier = { key: "cold" | "close" | "bestie" | "soulmate"; label: string };

export type ResultView = {
  /** "" = no result data yet · "rank" = 2+ answerers · "duo" = exactly one answerer · "empty" = nobody answered */
  mode: "" | "rank" | "duo" | "empty";
  /** Short line above the headline, e.g. "민수 맞히기 · 결과". */
  kicker: string;
  /** The quiz's title (for the image): quizInfo.title, else "<subject> 맞히기". */
  title: string;
  headline: string;
  /** This device's place, e.g. "내 순위 공동 1위 · 1,820점" ("" for the subject / a spectator). */
  mine: string;
  ranks: RankRow[];
  duo: { line: string; score: string; tier: string; tierKey: string };
  emptyText: string;
  questions: QuestionRow[];
  subject: string | null;
  iAmSubject: boolean;
  total: number;
};

/** The room's mark on a player who left (packages/snack-room/src/room.js LEFT_MARK). */
export const LEFT_MARK = "(나감)";

export const EMPTY_VIEW: ResultView = {
  mode: "", kicker: "", title: "", headline: "", mine: "", ranks: [],
  duo: { line: "", score: "", tier: "", tierKey: "" }, emptyText: "", questions: [],
  subject: null, iAmSubject: false, total: 0,
};

// ── Korean particles (을/를, 은/는, 이/가) ──
// Decided by the last character: a Hangul syllable with a final consonant, or a
// digit read with one (0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔). Anything else (Latin,
// emoji) gets the combined form, which is always correct.
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

/** Ranks with honest ties: rank = 1 + number of strictly higher scores. */
export function rankScores<T extends { score: number }>(rows: T[]): (T & { rank: number; tied: boolean })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score); // stable: equal scores keep their order
  return sorted.map((r) => ({
    ...r,
    rank: 1 + sorted.filter((o) => o.score > r.score).length,
    tied: sorted.filter((o) => o.score === r.score).length > 1,
  }));
}

export function buildResultView(input: ResultInput): ResultView {
  const recap = input.quizRecap ?? {};
  const rounds = Array.isArray(recap.rounds) ? recap.rounds.filter((r) => r && typeof r.q === "string") : [];
  const info = input.quizInfo ?? {};
  const subject = (typeof recap.subject === "string" && recap.subject) || (typeof info.about === "string" && info.about) || null;
  const myNick = input.myNick ?? "";
  // On the subject's own device the room says so; a nick match is only a
  // fallback for an engine that does not send iAmSubject.
  const iAmSubject = input.iAmSubject === true || (input.iAmSubject === undefined && !!subject && subject === myNick);
  const board = Array.isArray(input.raceBoard) ? input.raceBoard : [];
  const roster = Array.isArray(input.roster) ? input.roster : [];

  // Answerers: everyone on the board or in any round's picks, minus the subject.
  type P = { nick: string; score: number; correct: number; left: boolean };
  const players = new Map<string, P>();
  const add = (nick: string) => {
    if (!players.has(nick)) players.set(nick, { nick, score: 0, correct: 0, left: false });
    return players.get(nick)!;
  };
  for (const e of board) {
    if (!e || typeof e.nick !== "string") continue;
    const nick = stripLeft(e.nick);
    if (subject && nick === subject) continue;
    const p = add(nick);
    p.score = Number.isFinite(e.score) ? e.score : 0;
    if (e.left || e.nick !== nick) p.left = true;
  }
  for (const r of rounds) {
    for (const pk of r.picks ?? []) {
      if (!pk || typeof pk.nick !== "string" || (subject && pk.nick === subject)) continue;
      const p = add(pk.nick);
      if (pk.correct) p.correct += 1;
    }
  }
  // The roster lists who is here now (capped at 8 by the room). When it is
  // complete, someone missing from it has left even if the board did not say so.
  if (roster.length > 0 && roster.length < 8) for (const p of players.values()) if (!roster.includes(p.nick)) p.left = true;

  const total = rounds.length || (Number.isFinite(info.count) ? Number(info.count) : 0);
  const title = (info.title ?? "").trim() || (subject ? `${subject} 맞히기` : "스피드 퀴즈");
  const subjectWord = iAmSubject ? "나" : subject;

  const ranked = rankScores([...players.values()]);
  const ranks: RankRow[] = ranked.map((r) => ({
    rank: r.rank,
    rankLabel: r.tied ? `공동 ${r.rank}위` : `${r.rank}위`,
    nick: r.nick,
    score: r.score,
    scoreLabel: fmtScore(r.score),
    correct: r.correct,
    left: r.left,
    me: !iAmSubject && !!myNick && r.nick === myNick,
    top: r.rank === 1,
  }));

  const questions: QuestionRow[] = rounds.map((r, i) => {
    const picks = (r.picks ?? []).filter((p) => p && typeof p.nick === "string" && !(subject && p.nick === subject));
    const chips: Chip[] = picks.map((p) => ({
      nick: p.nick,
      pick: p.option >= 0 ? (r.options?.[p.option] ?? "?") : "무응답",
      state: p.option < 0 ? "none" : p.correct ? "ok" : "bad",
    }));
    const correctCount = chips.filter((c) => c.state === "ok").length;
    const summary = chips.length === 0 ? "답한 친구가 없어요"
      : correctCount === 0 ? "아무도 못 맞혔어요"
      : correctCount === chips.length ? (chips.length === 1 ? "맞혔어요" : "모두 맞혔어요")
      : `${chips.length}명 중 ${correctCount}명 맞힘`;
    return { n: i + 1, q: r.q, answer: r.options?.[r.answer] ?? "", summary, correctCount, answered: chips.filter((c) => c.state !== "none").length, chips };
  });

  const kicker = `${title} · 결과`;
  const base = { ...EMPTY_VIEW, kicker, title, questions, subject, iAmSubject, total, ranks };

  if (players.size === 0) {
    if (rounds.length === 0 && board.length === 0) return { ...EMPTY_VIEW, subject, iAmSubject, title };
    return { ...base, mode: "empty", headline: subjectWord ? `${eulReul(subjectWord)} 맞혀 볼 친구를 기다려요` : "결과", emptyText: "이번 판에는 답한 친구가 없어요" };
  }

  if (players.size === 1) {
    const p = ranked[0];
    const tier = subject ? tierFor(p.correct, total) : null;
    const line = total > 0
      ? (subjectWord ? `${eunNeun(p.nick)} ${eulReul(subjectWord)} ${p.correct}/${total} 맞혔어요` : `${eunNeun(p.nick)} ${p.correct}/${total} 맞혔어요`)
      : `${eunNeun(p.nick)} ${fmtScore(p.score)}을 얻었어요`;
    return {
      ...base,
      mode: "duo",
      headline: subjectWord ? `${eulReul(subjectWord)} 얼마나 잘 알까?` : "결과",
      mine: "",
      duo: { line: p.left ? `${line} · 나감` : line, score: total > 0 ? `${p.correct}/${total}` : fmtScore(p.score), tier: tier?.label ?? "", tierKey: tier?.key ?? "" },
    };
  }

  const meRow = ranks.find((r) => r.me);
  return {
    ...base,
    mode: "rank",
    headline: subjectWord ? `${eulReul(subjectWord)} 제일 잘 아는 친구는?` : "누가 제일 잘 맞혔을까?",
    mine: meRow ? `내 순위 ${meRow.rankLabel} · ${meRow.scoreLabel}` : "",
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
