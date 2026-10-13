// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultView, eulReul, eunNeun, fmtScore, highlightQuestions, nextStep, rankScores, tierFor, type QuizRecap } from "../src/quizResult.ts";
import { LONG_NICK, duo, group } from "./fixtures/quizResult.ts";

// ── 1:1 ──
test("1:1 (one answerer): N/M line + tier, no ranking", () => {
  const v = buildResultView({ ...duo, myNick: "지은" });
  assert.equal(v.mode, "duo");
  assert.equal(v.duo.score, "4/6");
  assert.equal(v.duo.line, "지은은 민수를 4/6 맞혔어요");
  assert.equal(v.duo.tier, "꽤 친함 🙂");
  assert.equal(v.headline, "민수를 얼마나 잘 알까?");
  assert.equal(v.mine, "", "no 'my rank' line for one person");
});

test("1:1 on the subject's device: '나를' (iAmSubject, not a nick match)", () => {
  const v = buildResultView({ ...duo, iAmSubject: true, myNick: "민수" });
  assert.equal(v.duo.line, "지은은 나를 4/6 맞혔어요");
  assert.equal(v.headline, "나를 얼마나 잘 알까?");
  const w = buildResultView({ ...duo, iAmSubject: false, myNick: "민수" });
  assert.equal(w.duo.line, "지은은 민수를 4/6 맞혔어요");
});

test("tier boundaries: 0–40 서먹 · 41–70 꽤 친함 · 71–99 찐친 · 100 소울메이트", () => {
  const k = (c: number, t: number) => tierFor(c, t)?.key;
  assert.equal(k(0, 6), "cold");
  assert.equal(k(2, 5), "cold"); // 40%
  assert.equal(k(4, 10), "cold"); // 40%
  assert.equal(k(41, 100), "close");
  assert.equal(k(70, 100), "close");
  assert.equal(k(4, 6), "close"); // 66.7%
  assert.equal(k(71, 100), "bestie");
  assert.equal(k(5, 6), "bestie"); // 83%
  assert.equal(k(99, 100), "bestie");
  assert.equal(k(6, 6), "soulmate");
  assert.equal(tierFor(0, 0), null, "no questions → no tier");
});

// ── group ──
test("group: answerers ranked by score (summed from picks), the subject never ranked", () => {
  const v = buildResultView({ ...group, myNick: LONG_NICK });
  assert.equal(v.mode, "rank");
  assert.equal(v.headline, "민수를 제일 잘 아는 친구는?");
  assert.deepEqual(v.ranks.map((r) => r.nick), ["하늘", "도윤", LONG_NICK, "서준"]);
  for (const r of v.ranks) assert.equal(r.score, group.raceBoard!.find((e) => e.pid === r.key.slice(2))!.score);
});

test("group: equal scores share the rank (공동 1위) and the next rank skips", () => {
  const v = buildResultView({ ...group, myNick: "도윤" });
  const [a, b, c] = v.ranks;
  assert.equal(a.score, b.score);
  assert.equal(a.rankLabel, "공동 1위");
  assert.equal(b.rankLabel, "공동 1위");
  assert.ok(a.top && b.top);
  assert.equal(c.rankLabel, "3위");
  assert.equal(v.mine, `내 순위 공동 1위 · ${fmtScore(b.score)}`);
});

test("group: a player who left stays ranked, marked (board mark stripped from the name)", () => {
  const v = buildResultView({ ...group, myNick: "하늘" });
  const seo = v.ranks.find((r) => r.nick === "서준")!;
  assert.equal(seo.left, true);
  assert.ok(!v.ranks.some((r) => r.nick.includes("(나감)")));
  assert.ok(!v.ranks.find((r) => r.nick === "하늘")!.left);
});

test("a 0-point answerer missing from the board is still ranked at 0", () => {
  const recap = { ...group.quizRecap!, rounds: group.quizRecap!.rounds!.map((r) => ({ ...r, picks: [...r.picks, { pid: "pid-zero", nick: "영점", option: 3 - r.answer, correct: false, points: 0 }] })) };
  const v = buildResultView({ ...group, quizRecap: recap });
  assert.equal(v.ranks.find((r) => r.nick === "영점")!.score, 0);
  assert.equal(v.ranks.length, 5);
});

test("two friends with the same nickname are two rows: '빠른감자' and '빠른감자 (2)'", () => {
  const recap: QuizRecap = { subject: "민수", about: "민수", rounds: [
    { q: "a", options: ["x", "y"], answer: 0, picks: [
      { pid: "A", nick: "빠른감자", option: 0, correct: true, points: 900 },
      { pid: "B", nick: "빠른감자", option: 1, correct: false, points: 0 },
    ] },
  ] };
  const v = buildResultView({ quizRecap: recap, raceBoard: [{ pid: "A", nick: "빠른감자", score: 900 }, { pid: "B", nick: "빠른감자", score: 0 }], myNick: "빠른감자" });
  assert.equal(v.mode, "rank");
  assert.deepEqual(v.ranks.map((r) => [r.nick, r.score]), [["빠른감자", 900], ["빠른감자 (2)", 0]]);
  assert.deepEqual(v.questions[0].chips.map((c) => c.nick), ["빠른감자", "빠른감자 (2)"]);
  assert.equal(v.mine, "", "an ambiguous nickname marks nobody as me");
  assert.ok(!v.ranks.some((r) => r.me));
  const mine = buildResultView({ quizRecap: recap, raceBoard: [], myNick: "빠른감자", myPid: "B" });
  assert.equal(mine.mine, "내 순위 2위 · 0점", "the pid identifies me");
});

test("an answerer whose name equals the subject's is still an answerer", () => {
  const recap: QuizRecap = { subject: "민수", about: "민수", rounds: [
    { q: "a", options: ["x", "y"], answer: 0, picks: [
      { pid: "P1", nick: "민수", option: 0, correct: true, points: 800 }, // another 민수, answering
      { pid: "P2", nick: "지은", option: 1, correct: false, points: 0 },
    ] },
  ] };
  const v = buildResultView({ quizRecap: recap, raceBoard: [] });
  assert.deepEqual(v.ranks.map((r) => r.nick), ["민수", "지은"]);
  assert.deepEqual(v.questions[0].chips.map((c) => c.nick), ["민수", "지은"]);
});

test("more than 8 answerers: scores come from picks, not the top-8 board", () => {
  const nicks = Array.from({ length: 11 }, (_, i) => `친구${i + 1}`);
  const recap: QuizRecap = { subject: "민수", about: "민수", rounds: [0, 1].map((r) => ({
    q: `q${r}`, options: ["x", "y"], answer: 0,
    picks: nicks.map((nick, i) => ({ pid: `p${i}`, nick, option: i % 2, correct: i % 2 === 0, points: i % 2 === 0 ? 1000 - i * 10 : 0 })),
  })) };
  const board = nicks.slice(0, 8).map((nick, i) => ({ pid: `p${i}`, nick, score: 1 })); // top-8, stale numbers
  const v = buildResultView({ quizRecap: recap, raceBoard: board });
  assert.equal(v.ranks.length, 11);
  assert.equal(v.ranks.find((r) => r.nick === "친구11")!.score, 2 * (1000 - 100));
  assert.equal(v.ranks.find((r) => r.nick === "친구1")!.score, 2000);
  assert.equal(v.ranks[0].nick, "친구1");
});

// ── the finished quiz is latched ──
test("a new pack arriving during the result does not relabel the finished results", () => {
  const before = buildResultView({ ...group, iAmSubject: false, myNick: "하늘" });
  // 하늘 sends a new quiz: live quizInfo and iAmSubject now describe 하늘's quiz.
  const after = buildResultView({
    ...group, iAmSubject: false, iAmSubjectNow: true, myNick: "하늘",
    quizInfo: { title: "하늘 맞히기", count: 5, custom: true, about: "하늘", packId: "pack-haneul" },
  });
  for (const k of ["title", "kicker", "headline", "mine", "subject"] as const) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(after.ranks, before.ranks);
  assert.equal(after.next, "startMine");
});

// ── next-game control ──
test("next: own new quiz waiting → 내 퀴즈 시작하기 (with a friend in the room)", () => {
  const info = { custom: true, about: "하늘", packId: "pack-haneul" };
  assert.deepEqual(nextStep({ quizRecap: group.quizRecap, quizInfo: info, iAmSubjectNow: true, roster: ["하늘", "도윤"] }), { next: "startMine", nextText: "" });
  assert.equal(nextStep({ quizRecap: group.quizRecap, quizInfo: info, iAmSubjectNow: true, roster: ["하늘"] }).next, "waiting", "alone: nothing to start yet");
});

test("next: someone else's new quiz waiting → banner with their name", () => {
  const s = nextStep({ quizRecap: group.quizRecap, quizInfo: { custom: true, about: "하늘", packId: "pack-haneul" }, iAmSubjectNow: false, roster: ["하늘", "도윤"] });
  assert.deepEqual(s, { next: "waiting", nextText: "하늘님이 새 퀴즈를 만들었어요 · 곧 시작해요" });
});

test("next: the waiting quiz's maker left for good (subjectHere false) → 나도 만들기 again, not a banner forever", () => {
  const s = nextStep({ quizRecap: group.quizRecap, quizInfo: { custom: true, about: "하늘", packId: "pack-haneul", subjectHere: false }, iAmSubjectNow: false, roster: ["도윤"] });
  assert.equal(s.next, "make");
});

test("next: default quiz (no subject) → 다시 하기; finished custom quiz → 나도 만들기", () => {
  const cold = { subject: null, rounds: group.quizRecap!.rounds };
  assert.equal(nextStep({ quizRecap: cold, quizInfo: { custom: false, about: null } }).next, "again");
  assert.equal(nextStep({ quizRecap: group.quizRecap, quizInfo: group.quizInfo }).next, "make");
  // same pack still loaded (packId equal) → not "waiting"
  assert.equal(nextStep({ quizRecap: group.quizRecap, quizInfo: { ...group.quizInfo, packId: "pack-minsu-1" }, iAmSubjectNow: true }).next, "make");
});

test("sharePrimary: 결과 공유 is lime only when no other lime control shows", () => {
  assert.equal(buildResultView({ ...group, canMake: true }).sharePrimary, false);
  assert.equal(buildResultView({ ...group, canMake: false }).sharePrimary, true);
  assert.equal(buildResultView({ ...group, quizRecap: { ...group.quizRecap!, subject: null, about: null } }).sharePrimary, false, "다시 하기 is lime");
  assert.equal(buildResultView({ ...group, quizInfo: { custom: true, about: "도윤", packId: "x" } }).sharePrimary, true, "waiting banner: share stays lime");
});

test("rankScores: three-way tie and all-zero", () => {
  const r = rankScores([{ score: 5 }, { score: 9 }, { score: 9 }, { score: 9 }]);
  assert.deepEqual(r.map((x) => [x.score, x.rank, x.tied]), [[9, 1, true], [9, 1, true], [9, 1, true], [5, 4, false]]);
  assert.deepEqual(rankScores([{ score: 0 }, { score: 0 }]).map((x) => x.rank), [1, 1]);
});

// ── per-question reveal ──
test("reveal: the subject's real answer and who picked what", () => {
  const v = buildResultView({ ...group, myNick: "하늘" });
  assert.equal(v.questions.length, 6);
  const q1 = v.questions[0];
  assert.equal(q1.q, "민수가 제일 좋아하는 음식은?");
  assert.equal(q1.answer, "떡볶이");
  assert.deepEqual(q1.chips.map((c) => [c.nick, c.pick, c.state]), [
    ["하늘", "떡볶이", "ok"], ["도윤", "떡볶이", "ok"], [LONG_NICK, "초밥", "bad"], ["서준", "떡볶이", "ok"],
  ]);
  assert.equal(q1.summary, "4명 중 3명 맞힘");
  const q3 = v.questions[2];
  assert.equal(q3.chips.find((c) => c.nick === "서준")!.pick, "무응답");
  assert.equal(q3.chips.find((c) => c.nick === "서준")!.state, "none");
});

test("reveal summaries: nobody right / all right / nobody answered", () => {
  const recap: QuizRecap = { subject: "민수", rounds: [
    { q: "a", options: ["x", "y"], answer: 0, picks: [{ pid: "J", nick: "지은", option: 1, correct: false, points: 0 }] },
    { q: "b", options: ["x", "y"], answer: 1, picks: [{ pid: "J", nick: "지은", option: 1, correct: true, points: 700 }] },
    { q: "c", options: ["x", "y"], answer: 1, picks: [{ pid: "J", nick: "지은", option: -1, correct: false, points: 0 }] },
  ] };
  const v = buildResultView({ quizRecap: recap, raceBoard: [], myNick: "지은" });
  assert.equal(v.questions[0].summary, "아무도 못 맞혔어요");
  assert.equal(v.questions[1].summary, "맞혔어요");
  assert.equal(v.questions[2].summary, "답한 친구가 없어요");
});

test("highlights: fewest right answers first, at most 3, shown in quiz order", () => {
  const v = buildResultView({ ...group });
  const h = highlightQuestions(v, 3);
  assert.equal(h.length, 3);
  assert.deepEqual(h.map((q) => q.n), [...h.map((q) => q.n)].sort((a, b) => a - b));
  const worst = Math.min(...v.questions.map((q) => q.correctCount / q.chips.length));
  assert.ok(h.some((q) => q.correctCount / q.chips.length === worst));
});

// ── no data / nobody answered / no subject ──
test("no result data yet → empty view (mode '')", () => {
  assert.equal(buildResultView({}).mode, "");
  assert.equal(buildResultView({ quizRecap: { subject: null, rounds: [] }, raceBoard: [] }).mode, "");
});

test("nobody answered → 'empty' with 답한 친구가 없어요 (also when the friends are listed with no answers)", () => {
  const v = buildResultView({ quizRecap: { subject: "민수", rounds: [{ q: "a", options: ["x"], answer: 0, picks: [] }] }, raceBoard: [] });
  assert.equal(v.mode, "empty");
  assert.equal(v.emptyText, "답한 친구가 없어요");
  const silent = buildResultView({ quizRecap: { subject: "민수", rounds: [{ q: "a", options: ["x"], answer: 0, picks: [{ pid: "J", nick: "지은", option: -1, correct: false, points: 0 }] }] }, raceBoard: [{ pid: "J", nick: "지은", score: 0 }] });
  assert.equal(silent.mode, "empty");
});

test("default quiz (no subject): generic headline, no tier, 다시 하기", () => {
  const v = buildResultView({ ...duo, quizRecap: { ...duo.quizRecap!, subject: null, about: null, title: "" }, quizInfo: { title: "상식", count: 6, custom: false } });
  assert.equal(v.title, "스피드 퀴즈");
  assert.equal(v.duo.line, "지은은 4/6 맞혔어요");
  assert.equal(v.duo.tier, "");
  assert.equal(v.next, "again");
});

test("default quiz on a device that was the previous quiz's subject: no '나' (no subject this time)", () => {
  const cold = { ...group.quizRecap!, subject: null, about: null, title: "" };
  const v = buildResultView({ ...group, quizRecap: cold, iAmSubject: true, quizInfo: { custom: false } });
  assert.equal(v.headline, "누가 제일 잘 맞혔을까?");
  assert.equal(v.next, "again");
});

// ── particles ──
test("을/를 · 은/는 by the final consonant; combined form for Latin/emoji", () => {
  assert.equal(eulReul("민수"), "민수를");
  assert.equal(eulReul("지은"), "지은을");
  assert.equal(eunNeun("지은"), "지은은");
  assert.equal(eunNeun("하늘"), "하늘은");
  assert.equal(eunNeun("나"), "나는");
  assert.equal(eulReul("Alex"), "Alex을(를)");
  assert.equal(eulReul("민수3"), "민수3을");
  assert.equal(eulReul("민수2"), "민수2를");
  assert.equal(eunNeun("빠른감자 (2)"), "빠른감자 (2)은(는)");
});
