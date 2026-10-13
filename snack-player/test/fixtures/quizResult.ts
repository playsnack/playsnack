// Result-phase fixtures in the shape lane A's engine sends (quizRecap /
// raceBoard / roster / quizInfo). Used by the unit tests and the screenshot
// harness (snack-player/scripts/result-shots.mjs).
import type { QuizRecap, ResultInput } from "../../src/quizResult.ts";

const Q = [
  { q: "민수가 제일 좋아하는 음식은?", options: ["떡볶이", "초밥", "삼겹살", "마라탕"], answer: 0 },
  { q: "민수의 MBTI는?", options: ["ENFP", "ISTJ", "INFP", "ESTP"], answer: 2 },
  { q: "민수가 주말에 제일 많이 하는 일은?", options: ["잠자기", "게임", "운동", "카페 가기"], answer: 1 },
  { q: "민수의 첫 해외여행지는?", options: ["일본", "베트남", "태국", "미국"], answer: 3 },
  { q: "민수가 무서워하는 것은?", options: ["벌레", "높은 곳", "귀신", "치과"], answer: 3 },
  { q: "민수가 노래방에서 꼭 부르는 노래는?", options: ["좋니", "밤양갱", "Hype Boy", "응급실"], answer: 1 },
];

type Ans = [nick: string, option: number, ms: number];
const round = (i: number, answers: Ans[]) => {
  const { answer } = Q[i];
  return {
    ...Q[i],
    picks: answers.map(([nick, option, ms]) => ({
      pid: `pid-${nick}`, nick, option, ms, correct: option === answer,
      points: option === answer ? Math.max(100, 1000 - Math.round((ms / 9000) * 800)) : 0,
    })),
  };
};
const recapOf = (subject: string | null, rows: Ans[][]): QuizRecap => ({
  subject, about: subject, title: subject ? `${subject} 맞히기` : "", packId: subject ? "pack-minsu-1" : null,
  rounds: rows.map((answers, i) => round(i, answers)),
});
export const scoreOf = (recap: QuizRecap, nick: string) =>
  recap.rounds.reduce((s, r) => s + (r.picks.find((p) => p.nick === nick)?.points ?? 0), 0);

/** 1:1 — 지은 answers 민수's quiz: 4 of 6 right (66.7% → 꽤 친함). */
export const duoRecap = recapOf("민수", [
  [["지은", 0, 1800]],
  [["지은", 2, 2500]],
  [["지은", 0, 4000]],
  [["지은", 3, 3100]],
  [["지은", 3, 5200]],
  [["지은", -1, -1]],
]);
export const duo: ResultInput = {
  quizRecap: duoRecap,
  raceBoard: [{ pid: "pid-지은", nick: "지은", score: scoreOf(duoRecap, "지은") }],
  roster: ["민수", "지은"],
  quizInfo: { title: "민수 맞히기", count: 6, custom: true, about: "민수", packId: "pack-minsu-1" },
};

/** Group — 4 answerers + the subject: 하늘 and 도윤 tie for 1st, 서준 left
    mid-game, and one 10-grapheme nickname. */
export const LONG_NICK = "가나다라마바사아자차";
export const groupRecap = recapOf("민수", [
  [["하늘", 0, 1500], ["도윤", 0, 1500], [LONG_NICK, 1, 2000], ["서준", 0, 3000]],
  [["하늘", 2, 2000], ["도윤", 2, 2000], [LONG_NICK, 2, 4000], ["서준", 0, 2500]],
  [["하늘", 1, 3000], ["도윤", 1, 3000], [LONG_NICK, 0, 3500], ["서준", -1, -1]],
  [["하늘", 0, 2000], ["도윤", 0, 2000], [LONG_NICK, 3, 6000], ["서준", -1, -1]],
  [["하늘", 3, 2500], ["도윤", 3, 2500], [LONG_NICK, 3, 7000], ["서준", -1, -1]],
  [["하늘", 1, 1000], ["도윤", 1, 1000], [LONG_NICK, 0, 3000], ["서준", -1, -1]],
]);
export const group: ResultInput = {
  quizRecap: groupRecap,
  raceBoard: [
    { pid: "pid-하늘", nick: "하늘", score: scoreOf(groupRecap, "하늘") },
    { pid: "pid-도윤", nick: "도윤", score: scoreOf(groupRecap, "도윤") },
    { pid: `pid-${LONG_NICK}`, nick: LONG_NICK, score: scoreOf(groupRecap, LONG_NICK) },
    { pid: "pid-서준", nick: "서준 (나감)", score: scoreOf(groupRecap, "서준"), left: true },
  ],
  roster: ["민수", "하늘", "도윤", LONG_NICK],
  quizInfo: { title: "민수 맞히기", count: 6, custom: true, about: "민수", packId: "pack-minsu-1" },
};
