// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ABOUT_ME, ANSWER_MS, MAKE_PARAM, OPTION_MAX, OPTIONS_MAX, Q_MAX, QUESTIONS_MAX, QUESTIONS_MIN, QUIZ_SLUG, SUGGEST_COUNT, TITLE_MAX,
  addOption, blankQuestion, buildQuizPack, canFinish, defaultTitle, draftProblems, fromTemplate, graphemeLength, isQuizPack,
  lobbyCopy, newDraft, questionProblems, quizStore, packAction, removeOption, swapCandidate, tapAnswer,
  type Draft, type KV,
} from "../src/quiz.ts";
import { friendLink, newRoomCode, roomIdFor } from "../src/links.ts";

// Deterministic random for picks.
const rng = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const answered = (d: Draft, n = d.questions.length): Draft => ({ ...d, questions: d.questions.slice(0, n).map((q) => tapAnswer(q, 0)) });

// ── question templates file ──
test("about-me templates: 30+ questions, 4 non-empty unique options each, no answers, no duplicate questions, within limits", () => {
  const raw = JSON.parse(readFileSync(new URL("../src/data/about-me.json", import.meta.url), "utf8"));
  assert.ok(raw.questions.length >= 30, `${raw.questions.length} questions`);
  assert.equal(ABOUT_ME.length, raw.questions.length);
  const qs = new Set<string>();
  for (const t of raw.questions) {
    assert.equal(t.answer, undefined, `template has an answer: ${t.q}`);
    assert.ok(t.q.trim() && graphemeLength(t.q) <= Q_MAX, t.q);
    assert.ok(!qs.has(t.q.trim()), `duplicate question: ${t.q}`);
    qs.add(t.q.trim());
    assert.equal(t.options.length, 4, t.q);
    assert.equal(new Set(t.options).size, 4, `duplicate option in: ${t.q}`);
    for (const o of t.options) assert.ok(o.trim() && graphemeLength(o) <= OPTION_MAX, `${t.q} / ${o}`);
    // A template is a valid question as soon as the creator taps an answer.
    assert.deepEqual(questionProblems(tapAnswer(fromTemplate(t), 3)), []);
  }
});

// ── the tap-to-answer model ──
test("a template becomes a draft question with no answer; a tap sets it, a second tap clears it", () => {
  const q = fromTemplate(ABOUT_ME[0]);
  assert.equal(q.answer, null);
  assert.deepEqual(questionProblems(q).map((p) => p.field), ["answer"]);
  const a = tapAnswer(q, 2);
  assert.equal(a.answer, 2);
  assert.equal(tapAnswer(a, 1).answer, 1);
  assert.equal(tapAnswer(a, 2).answer, null);
});

test("removing an option keeps the marked answer on the same option text", () => {
  const q = { ...fromTemplate(ABOUT_ME[0]), answer: 3 };
  const r = removeOption(q, 1);
  assert.equal(r.options.length, 3);
  assert.equal(r.options[r.answer!], q.options[3]);
  assert.equal(removeOption(q, 3).answer, null, "removing the answer clears it");
  const two = { ...q, options: ["a", "b"], answer: 0 };
  assert.equal(removeOption(two, 0), two, "never below 2 options");
  assert.equal(addOption(q), q, "never above 4 options");
  assert.equal(addOption(two).options.length, 3);
});

test("first screen: 10 different suggested questions, title = '<nick> 맞히기'; swap never repeats a question", () => {
  const d = newDraft("라임 감자", rng(7));
  assert.equal(d.questions.length, SUGGEST_COUNT);
  assert.equal(new Set(d.questions.map((q) => q.q)).size, SUGGEST_COUNT);
  assert.equal(d.title, "라임 감자 맞히기");
  assert.equal(defaultTitle(""), "나 맞히기");
  for (let i = 0; i < 50; i++) {
    const t = swapCandidate(d, rng(i + 1));
    assert.ok(t && !d.questions.some((q) => q.q === t.q));
  }
  const full: Draft = { title: "x", questions: ABOUT_ME.map(fromTemplate) };
  assert.equal(swapCandidate(full), null, "pool used up → null");
});

// ── done-button rule / validation ──
test("완료 stays disabled until every kept question has an answer and there are 5–10 questions", () => {
  const d = newDraft("나", rng(3));
  assert.equal(canFinish(d), false);
  assert.match(draftProblems(d).join(), /답을 고르지 않은 질문이 10개/);
  assert.equal(canFinish(answered(d)), true);
  const nine = answered(d);
  nine.questions[8] = { ...nine.questions[8], answer: null };
  assert.equal(canFinish(nine), false);
  // Dropping cards: 5 is the floor.
  assert.equal(canFinish(answered(d, QUESTIONS_MIN)), true);
  assert.equal(canFinish(answered(d, QUESTIONS_MIN - 1)), false);
  assert.match(draftProblems(answered(d, 4)).join(), /5개 이상/);
  const eleven: Draft = { title: "t", questions: [...answered(d).questions, tapAnswer(fromTemplate(ABOUT_ME[29]), 0)] };
  assert.equal(eleven.questions.length, QUESTIONS_MAX + 1);
  assert.match(draftProblems(eleven).join(), /10개까지/);
});

test("limits are counted in graphemes (Korean syllables, emoji), with clear Korean messages", () => {
  const base = tapAnswer({ ...blankQuestion(), q: "질문", options: ["가", "나"] }, 0);
  assert.deepEqual(questionProblems(base), []);
  // 80 Korean syllables are fine (240 UTF-8 bytes, 80 UTF-16 units), 81 are not.
  assert.deepEqual(questionProblems({ ...base, q: "가".repeat(Q_MAX) }), []);
  assert.match(questionProblems({ ...base, q: "가".repeat(Q_MAX + 1) })[0].message, /80자까지/);
  // A family emoji is one grapheme but 11 UTF-16 units.
  assert.equal(graphemeLength("👨‍👩‍👧‍👦"), 1);
  assert.deepEqual(questionProblems({ ...base, options: ["👨‍👩‍👧‍👦".repeat(OPTION_MAX), "나"] }), []);
  assert.match(questionProblems({ ...base, options: ["가".repeat(OPTION_MAX + 1), "나"] })[0].message, /30자까지/);
  assert.match(questionProblems({ ...base, q: "  " })[0].message, /질문을 적어/);
  assert.match(questionProblems({ ...base, options: ["가", " "] })[0].message, /빈 보기/);
  assert.match(questionProblems({ ...base, options: ["가", "가 "] })[0].message, /같은 보기/);
  assert.match(questionProblems({ ...base, options: ["가"] })[0].message, /2~4개/);
  assert.match(questionProblems({ ...base, options: ["가", "나", "다", "라", "마"] })[0].message, /2~4개/);
  assert.match(questionProblems({ ...base, answer: 2 })[0].message, /진짜 답/, "answer index out of range");
  const d = answered(newDraft("나", rng(4)));
  assert.match(draftProblems({ ...d, title: " " }).join(), /제목을 적어/);
  assert.equal(canFinish({ ...d, title: "가".repeat(TITLE_MAX) }), true);
  assert.match(draftProblems({ ...d, title: "가".repeat(TITLE_MAX + 1) }).join(), /40자까지/);
});

// ── the quizPack payload ──
test("quizPack: trimmed title/questions/options, answer index, settings {rounds = count, answerMs = 10 s}", () => {
  const d = answered(newDraft("라임", rng(5)), 6);
  d.title = "  라임 맞히기 ";
  d.questions[0] = { ...d.questions[0], q: ` ${d.questions[0].q} `, options: d.questions[0].options.map((o) => ` ${o}`), answer: 3 };
  const pack = buildQuizPack(d);
  assert.equal(pack.title, "라임 맞히기");
  assert.equal(pack.questions.length, 6);
  assert.equal(pack.questions[0].q, d.questions[0].q.trim());
  assert.equal(pack.questions[0].answer, 3);
  assert.ok(pack.questions[0].options.every((o) => o === o.trim()));
  assert.deepEqual(pack.settings, { rounds: 6, answerMs: ANSWER_MS });
  assert.equal(ANSWER_MS, 10_000);
  for (const q of pack.questions) assert.deepEqual(Object.keys(q).sort(), ["answer", "options", "q"], "no draft-only fields (id, custom)");
  assert.ok(isQuizPack(pack));
  assert.throws(() => buildQuizPack(newDraft("x", rng(5))), /답을 고르지/);
  assert.equal(isQuizPack({ title: "x", questions: [{ q: "a", options: ["1", "2"], answer: 5 }] }), false);
});

// ── the invite link carries no questions ──
test("the invite link names the room only — no question, option or answer text in it", () => {
  const pack = buildQuizPack(answered(newDraft("라임", rng(6))));
  const code = newRoomCode();
  const url = friendLink("https://snack.example", QUIZ_SLUG, new URLSearchParams(), code);
  assert.equal(url, `https://snack.example/p/${QUIZ_SLUG}?room=${code}`);
  const decoded = decodeURIComponent(url);
  for (const q of pack.questions) {
    assert.ok(!decoded.includes(q.q), "question text in the link");
    for (const o of q.options) assert.ok(!decoded.includes(o), `option '${o}' in the link`);
  }
  assert.ok(!/[?&#](d|pack|q|answer)=/.test(url));
  // The maker's ?make=1 is dropped from a shared link only by the caller; the room id ignores it.
  assert.equal(roomIdFor(QUIZ_SLUG, new URLSearchParams({ room: code, [MAKE_PARAM]: "1" })), `${QUIZ_SLUG}~${code}`);
});

// ── storage ──
const memKV = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const throwingKV: KV = {
  getItem: () => { throw new Error("SecurityError"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
  removeItem: () => { throw new Error("SecurityError"); },
};

test("draft round-trips through device storage (answers, custom flag, ids)", () => {
  const kv = memKV();
  const d = newDraft("라임", rng(8));
  d.questions[0] = tapAnswer(d.questions[0], 2);
  d.questions.push({ ...blankQuestion(), q: "내 별명은?", options: ["a", "b", "c"], answer: 1 });
  assert.equal(quizStore(kv).saveDraft(d), true);
  const back = quizStore(kv).loadDraft(); // a new store = a reload
  assert.deepEqual(back, d);
  quizStore(kv).clearDraft();
  assert.equal(quizStore(kv).loadDraft(), null);
});

test("storage that throws: nothing crashes, save reports false, the page keeps the draft in memory", () => {
  const s = quizStore(throwingKV);
  const d = newDraft("라임", rng(9));
  assert.equal(s.saveDraft(d), false);
  assert.deepEqual(s.loadDraft(), d);
  const pack = buildQuizPack(answered(d));
  assert.equal(s.rememberRoomPack("tpl-x~CODE", pack), false);
  assert.deepEqual(s.roomPack("tpl-x~CODE"), pack, "the in-app move to the room still finds the pack");
  assert.equal(quizStore(null).saveDraft(d), false, "no storage at all");
  // Corrupt JSON in storage reads as nothing.
  const kv = memKV();
  kv.setItem("snack.quiz.draft", "{nope");
  kv.setItem("snack.quiz.rooms", "[1,2");
  assert.equal(quizStore(kv).loadDraft(), null);
  assert.equal(quizStore(kv).roomPack("a"), null);
});

test("room packs: remembered per room, newest 10 kept, forgotten when someone else becomes the subject", () => {
  const kv = memKV();
  const s = quizStore(kv);
  const pack = buildQuizPack(answered(newDraft("라임", rng(10))));
  for (let i = 0; i < 12; i++) s.rememberRoomPack(`room${i}`, pack, 1000 + i);
  assert.equal(s.roomPack("room0"), null);
  assert.equal(s.roomPack("room1"), null);
  assert.deepEqual(quizStore(kv).roomPack("room11"), pack);
  s.forgetRoomPack("room11");
  assert.equal(s.roomPack("room11"), null);
});

// ── sending the pack in the room ──
test("packAction: send in lobby/result until the room plays my pack, at most every 3 s; re-send when the room lost it", () => {
  const base = { phase: "lobby", info: null, myNick: "라임", packTitle: "라임 맞히기", confirmed: false, lastSentAt: 0, now: 10_000 };
  const mine = { custom: true, about: "라임", title: "라임 맞히기", count: 8 };
  assert.equal(packAction(base), "send", "first join");
  assert.equal(packAction({ ...base, phase: "result" }), "send");
  assert.equal(packAction({ ...base, phase: "play" }), "wait", "the room refuses packs mid-game");
  assert.equal(packAction({ ...base, phase: "countdown" }), "wait");
  assert.equal(packAction({ ...base, lastSentAt: 8_000 }), "wait", "3 s gap");
  assert.equal(packAction({ ...base, lastSentAt: 7_000 }), "send");
  assert.equal(packAction({ ...base, info: mine }), "confirm");
  assert.equal(packAction({ ...base, info: mine, confirmed: true }), "wait");
  assert.equal(packAction({ ...base, info: { custom: false }, confirmed: true }), "send", "reconnect / hand-over lost it → re-send");
});

test("packAction: 나도 만들기 — a new maker replaces the previous subject; the previous subject then stops", () => {
  const other = { custom: true, about: "감자", title: "감자 맞히기", count: 6 };
  // The new maker (not yet confirmed) sends over the other subject's pack…
  assert.equal(packAction({ phase: "result", info: other, myNick: "라임", packTitle: "라임 맞히기", confirmed: false, lastSentAt: 0, now: 5000 }), "send");
  // …and the previous subject, whose pack was confirmed, forgets its own instead of fighting back.
  const prev = { phase: "lobby", info: { custom: true, about: "라임", title: "라임 맞히기" }, myNick: "감자", packTitle: "감자 맞히기", confirmed: true, lastSentAt: 0, now: 5000 };
  assert.equal(packAction(prev), "forget");
  // Confirmation is kept per room on the device.
  const s = quizStore(memKV());
  const pack = buildQuizPack(answered(newDraft("라임", rng(11))));
  s.rememberRoomPack("r", pack);
  assert.equal(s.roomPackConfirmed("r"), false);
  s.confirmRoomPack("r");
  assert.equal(s.roomPackConfirmed("r"), true);
  s.rememberRoomPack("r", pack);
  assert.equal(s.roomPackConfirmed("r"), false, "a new pack starts unconfirmed");
});

test("lobby copy", () => {
  assert.equal(lobbyCopy(null, true, 1).title, "친구를 초대해서 나를 얼마나 아는지 보자!");
  assert.match(lobbyCopy(null, true, 2).body, /준비 완료 · 2명/);
  assert.equal(lobbyCopy({ custom: true, about: "라임", count: 7, title: "라임 맞히기" }, false, 2).title, "라임 맞히기 · 7문제 · 곧 시작해요");
});
