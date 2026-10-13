// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultView, eulReul, eunNeun, fmtScore, highlightQuestions, rankScores, tierFor } from "../src/quizResult.ts";
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
  // A friend who happens to share the subject's nick is not the subject when the room says so.
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
test("group: answerers ranked by score, the subject never ranked", () => {
  const v = buildResultView({ ...group, myNick: LONG_NICK });
  assert.equal(v.mode, "rank");
  assert.equal(v.headline, "민수를 제일 잘 아는 친구는?");
  assert.deepEqual(v.ranks.map((r) => r.nick), ["하늘", "도윤", LONG_NICK, "서준"]);
  assert.ok(!v.ranks.some((r) => r.nick === "민수"));
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

test("left is also inferred from a complete roster", () => {
  const v = buildResultView({ ...group, raceBoard: group.raceBoard!.map((e) => ({ ...e, nick: e.nick.replace(" (나감)", ""), left: undefined })) });
  assert.equal(v.ranks.find((r) => r.nick === "서준")!.left, true);
});

test("a 0-correct answerer missing from the board is still ranked at 0", () => {
  const v = buildResultView({ ...group, raceBoard: group.raceBoard!.slice(0, 2) });
  const long = v.ranks.find((r) => r.nick === LONG_NICK)!;
  assert.equal(long.score, 0);
  assert.equal(v.ranks.length, 4);
});

test("subject's device in a group: headline '나를…', no 'my rank' line", () => {
  const v = buildResultView({ ...group, iAmSubject: true, myNick: "민수" });
  assert.equal(v.headline, "나를 제일 잘 아는 친구는?");
  assert.equal(v.mine, "");
  assert.ok(!v.ranks.some((r) => r.me));
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

test("reveal: picks by the subject (if any) are left out; summaries for none / all", () => {
  const recap = { subject: "민수", rounds: [
    { q: "a", options: ["x", "y"], answer: 0, picks: [{ nick: "민수", option: 0, correct: true }, { nick: "지은", option: 1, correct: false }] },
    { q: "b", options: ["x", "y"], answer: 1, picks: [{ nick: "지은", option: 1, correct: true }] },
    { q: "c", options: ["x", "y"], answer: 1, picks: [] },
  ] };
  const v = buildResultView({ quizRecap: recap, raceBoard: [], myNick: "지은" });
  assert.deepEqual(v.questions[0].chips.map((c) => c.nick), ["지은"]);
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

// ── no data / no subject ──
test("no result data yet → empty view (mode '')", () => {
  assert.equal(buildResultView({}).mode, "");
  assert.equal(buildResultView({ quizRecap: { subject: null, rounds: [] }, raceBoard: [] }).mode, "");
});

test("nobody answered → 'empty', honest text", () => {
  const v = buildResultView({ quizRecap: { subject: "민수", rounds: [{ q: "a", options: ["x"], answer: 0, picks: [] }] }, raceBoard: [] });
  assert.equal(v.mode, "empty");
  assert.match(v.emptyText, /답한 친구가 없어요/);
});

test("default quiz (no subject): generic headline, no tier", () => {
  const v = buildResultView({ ...duo, quizRecap: { ...duo.quizRecap!, subject: null }, quizInfo: { title: "", count: 6 } });
  assert.equal(v.title, "스피드 퀴즈");
  assert.equal(v.duo.line, "지은은 4/6 맞혔어요");
  assert.equal(v.duo.tier, "");
});

// ── particles ──
test("을/를 · 은/는 by the final consonant; combined form for Latin/emoji", () => {
  assert.equal(eulReul("민수"), "민수를");
  assert.equal(eulReul("지은"), "지은을");
  assert.equal(eunNeun("지은"), "지은은");
  assert.equal(eunNeun("하늘"), "하늘은");
  assert.equal(eunNeun("도윤"), "도윤은");
  assert.equal(eunNeun("나"), "나는");
  assert.equal(eulReul("Alex"), "Alex을(를)");
  assert.equal(eulReul("민수3"), "민수3을");
  assert.equal(eulReul("민수2"), "민수2를");
});
