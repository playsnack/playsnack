// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ABOUT_ME, ANSWER_MS, MAKE_PARAM, MAX_SENDS, OPTION_MAX, Q_MAX, QUESTIONS_MAX, QUESTIONS_MIN, QUIZ_SLUG, QUIZ_TTL_MS, RECENT_KEEP, SUGGEST_COUNT, TITLE_MAX,
  addOption, addSuggested, blankQuestion, buildQuizPack, canFinish, defaultTitle, draftFromPack, draftProblems, editOption, editQuestion,
  fromTemplate, graphemeLength, isQuizPack, nameProblem, newDraft, oneLine, opensMakerPage, PACK_REFUSALS, packAction, packFailureMessage, packPending, questionProblems, quizStore,
  removeOption, setName, swapCandidate, swapNeedsConfirm, tapAnswer,
  type Draft, type KV, type PackState,
} from "../src/quiz.ts";
import { friendLink, newRoomCode, roomIdFor } from "../src/links.ts";

// Deterministic random for picks.
const rng = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const draftOf = (seed: number, nick = "라임") => newDraft(nick, { random: rng(seed) });
const answered = (d: Draft, n = d.questions.length): Draft => ({ ...d, questions: d.questions.slice(0, n).map((q) => tapAnswer(q, 0)) });

// ── question templates file ──
test("about-me templates: 30–32 questions, 4 non-empty unique options each, no answers, no duplicate questions, within limits", () => {
  const raw = JSON.parse(readFileSync(new URL("../src/data/about-me.json", import.meta.url), "utf8"));
  assert.ok(raw.questions.length >= 30 && raw.questions.length <= 32, `${raw.questions.length} questions`);
  assert.equal(ABOUT_ME.length, raw.questions.length);
  const qs = new Set<string>();
  for (const t of raw.questions) {
    assert.equal(t.answer, undefined, `template has an answer: ${t.q}`);
    assert.ok(t.q.trim() && graphemeLength(t.q) <= Q_MAX, t.q);
    assert.ok(!qs.has(t.q.trim()), `duplicate question: ${t.q}`);
    qs.add(t.q.trim());
    assert.equal(t.options.length, 4, t.q);
    assert.equal(new Set(t.options).size, 4, `duplicate option in: ${t.q}`);
    for (const o of t.options) assert.ok(o.trim() && graphemeLength(o) <= OPTION_MAX && oneLine(o) === o, `${t.q} / ${o}`);
    assert.ok(typeof t.topic === "string" && t.topic, `topic missing: ${t.q}`);
    // A template is a valid question as soon as the creator taps an answer.
    assert.deepEqual(questionProblems(tapAnswer(fromTemplate(t), 3)), []);
  }
});

test("about-me templates: varied — food at most 5, at least 6 topics", () => {
  const topics = ABOUT_ME.map((t) => t.topic);
  assert.ok(topics.filter((t) => t === "food").length <= 5, `food: ${topics.filter((t) => t === "food").length}`);
  assert.ok(new Set(topics).size >= 6, `topics: ${[...new Set(topics)].join(",")}`);
  const app = ABOUT_ME.find((t) => t.topic === "app");
  assert.ok(app && app.options.some((o) => /넷플릭스|OTT/.test(o)) && app.options.some((o) => /틱톡|쇼츠/.test(o)) && app.options.some((o) => /웹툰/.test(o)), "app question offers 넷플릭스/틱톡/웹툰-type answers");
});

// ── the tap-to-answer model ──
test("a template becomes a draft question with no answer; a tap sets it, a second tap clears it", () => {
  const q = fromTemplate(ABOUT_ME[0]);
  assert.equal(q.answer, null);
  assert.equal(q.tpl, ABOUT_ME[0].q, "remembers which suggestion it came from");
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
  const d = draftOf(7, "라임 감자");
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

test("an edited suggestion becomes the creator's own: swap asks first, and its suggestion is not offered again", () => {
  const d = draftOf(12);
  const q0 = d.questions[0];
  assert.equal(swapNeedsConfirm(q0), false, "an untouched suggestion swaps directly");
  const edited = editQuestion(q0, "내가 제일 좋아하는 간식은?");
  assert.equal(swapNeedsConfirm(edited), true);
  assert.equal(swapNeedsConfirm(editOption(q0, 1, "다른 보기")), true);
  assert.equal(swapNeedsConfirm(blankQuestion()), true);
  const d2 = { ...d, questions: [edited, ...d.questions.slice(1)] };
  for (let i = 0; i < 40; i++) assert.notEqual(swapCandidate(d2, rng(i + 1))?.q, q0.q, "the edited card's original suggestion is still counted as used");
});

test("추천 질문 추가 adds one unused suggestion, never past 10", () => {
  const d = answered(draftOf(13), 3);
  const more = addSuggested(d, rng(2));
  assert.equal(more.questions.length, 4);
  assert.equal(more.questions[3].answer, null);
  assert.ok(!d.questions.some((q) => q.q === more.questions[3].q));
  const full = draftOf(14);
  assert.equal(addSuggested(full), full);
});

test("line breaks (typed or pasted) become spaces in questions, options and the pack", () => {
  const q = editQuestion(fromTemplate(ABOUT_ME[1]), "내가\n제일\r\n좋아하는 것은?");
  assert.equal(q.q, "내가 제일 좋아하는 것은?");
  assert.equal(editOption(q, 0, "가\n나").options[0], "가 나");
  const d = answered(draftOf(15));
  d.questions[0] = { ...d.questions[0], q: "줄\n바꿈" }; // e.g. a draft stored by an older build
  assert.equal(buildQuizPack(d).questions[0].q, "줄 바꿈");
});

// ── done-button rule / validation ──
test("완료 stays disabled until every kept question has an answer and there are 5–10 questions", () => {
  const d = draftOf(3);
  assert.equal(canFinish(d), false);
  assert.match(draftProblems(d).join(), /답을 고르지 않은 질문이 10개/);
  assert.equal(canFinish(answered(d)), true);
  const nine = answered(d);
  nine.questions[8] = { ...nine.questions[8], answer: null };
  assert.equal(canFinish(nine), false);
  assert.equal(canFinish(answered(d, QUESTIONS_MIN)), true);
  assert.equal(canFinish(answered(d, QUESTIONS_MIN - 1)), false);
  assert.match(draftProblems(answered(d, 4)).join(), /5개 이상/);
  const eleven: Draft = { ...d, questions: [...answered(d).questions, tapAnswer(fromTemplate(ABOUT_ME[29]), 0)] };
  assert.equal(eleven.questions.length, QUESTIONS_MAX + 1);
  assert.match(draftProblems(eleven).join(), /10개까지/);
});

test("limits are counted in graphemes (Korean syllables, emoji), with clear Korean messages", () => {
  const base = tapAnswer({ ...blankQuestion(), q: "질문", options: ["가", "나"] }, 0);
  assert.deepEqual(questionProblems(base), []);
  assert.deepEqual(questionProblems({ ...base, q: "가".repeat(Q_MAX) }), []);
  assert.match(questionProblems({ ...base, q: "가".repeat(Q_MAX + 1) })[0].message, /80자까지/);
  assert.equal(graphemeLength("👨‍👩‍👧‍👦"), 1);
  assert.deepEqual(questionProblems({ ...base, options: ["👨‍👩‍👧‍👦".repeat(OPTION_MAX), "나"] }), []);
  assert.match(questionProblems({ ...base, options: ["가".repeat(OPTION_MAX + 1), "나"] })[0].message, /30자까지/);
  assert.match(questionProblems({ ...base, q: "  " })[0].message, /질문을 적어/);
  assert.match(questionProblems({ ...base, options: ["가", " "] })[0].message, /빈 보기/);
  assert.match(questionProblems({ ...base, options: ["가", "가 "] })[0].message, /같은 보기/);
  assert.match(questionProblems({ ...base, options: ["가"] })[0].message, /2~4개/);
  assert.match(questionProblems({ ...base, options: ["가", "나", "다", "라", "마"] })[0].message, /2~4개/);
  assert.match(questionProblems({ ...base, answer: 2 })[0].message, /진짜 답/, "answer index out of range");
  const d = answered(draftOf(4));
  assert.match(draftProblems({ ...d, title: " " }).join(), /제목을 적어/);
  assert.equal(canFinish({ ...d, title: "가".repeat(TITLE_MAX) }), true);
  assert.match(draftProblems({ ...d, title: "가".repeat(TITLE_MAX + 1) }).join(), /40자까지/);
});

// ── the creator's real name ──
test("an auto-assigned nickname: 완료 waits until the creator picks a name; the name goes to the pack as `about`", () => {
  const d = answered(newDraft("엉뚱한 수달", { random: rng(16), nickAuto: true }));
  assert.equal(d.name, "엉뚱한 수달", "prefilled");
  assert.equal(canFinish(d), false);
  assert.match(nameProblem(d)!, /내 이름을 정해/);
  const blank = setName(d, "  ");
  assert.match(nameProblem(blank)!, /내 이름을 적어/);
  const named = setName(d, "민지");
  assert.equal(nameProblem(named), null);
  assert.equal(named.title, "민지 맞히기", "a default title follows the name");
  assert.equal(canFinish(named), true);
  assert.equal(buildQuizPack(named).about, "민지");
  // Keeping the suggested name is a real choice too (the button "이 이름 그대로").
  assert.equal(canFinish(setName(d, d.name!)), true);
  // A title the creator wrote stays.
  assert.equal(setName({ ...d, title: "우리 반 퀴즈" }, "민지").title, "우리 반 퀴즈");
  // Names are capped like nicknames (10 graphemes, one line).
  assert.equal(setName(d, "가나다라마바사아자차카\n").name, "가나다라마바사아자차");
  // A nickname the person chose: no name step.
  assert.equal(nameProblem(answered(newDraft("라임", { random: rng(1) }))), null);
});

// ── the quizPack payload ──
test("quizPack: trimmed title/questions/options, about, answer index, settings {rounds = count, answerMs = 10 s}", () => {
  const d = answered(draftOf(5), 6);
  d.title = "  라임 맞히기 ";
  d.questions[0] = { ...d.questions[0], q: ` ${d.questions[0].q} `, options: d.questions[0].options.map((o) => ` ${o}`), answer: 3 };
  const pack = buildQuizPack(d);
  assert.equal(pack.title, "라임 맞히기");
  assert.equal(pack.about, "라임");
  assert.equal(pack.questions.length, 6);
  assert.equal(pack.questions[0].q, d.questions[0].q.trim());
  assert.equal(pack.questions[0].answer, 3);
  assert.ok(pack.questions[0].options.every((o) => o === o.trim()));
  assert.deepEqual(pack.settings, { rounds: 6, answerMs: ANSWER_MS });
  assert.equal(ANSWER_MS, 10_000);
  for (const q of pack.questions) assert.deepEqual(Object.keys(q).sort(), ["answer", "options", "q"], "no draft-only fields (id, custom, tpl)");
  assert.deepEqual(Object.keys(pack).sort(), ["about", "questions", "settings", "title"]);
  assert.ok(isQuizPack(pack));
  assert.throws(() => buildQuizPack(draftOf(5)), /답을 고르지/);
  assert.equal(isQuizPack({ title: "x", questions: [{ q: "a", options: ["1", "2"], answer: 5 }] }), false);
  // 내 퀴즈로 다시 하기: a stored pack back in the editor, answers kept.
  const again = draftFromPack(pack, "라임");
  assert.equal(canFinish(again), true);
  assert.deepEqual(buildQuizPack(again), pack);
});

// ── the invite link carries no questions ──
test("the invite link names the room only — no question, option or answer text in it", () => {
  const pack = buildQuizPack(answered(draftOf(6)));
  const code = newRoomCode();
  const url = friendLink("https://snack.example", QUIZ_SLUG, new URLSearchParams({ [MAKE_PARAM]: "1" }), code);
  assert.equal(url, `https://snack.example/p/${QUIZ_SLUG}?room=${code}`, "and no make=1");
  const decoded = decodeURIComponent(url);
  for (const q of pack.questions) {
    assert.ok(!decoded.includes(q.q), "question text in the link");
    for (const o of q.options) assert.ok(!decoded.includes(o), `option '${o}' in the link`);
  }
  assert.ok(!/[?&#](d|pack|q|answer|make)=/.test(url));
  assert.equal(roomIdFor(QUIZ_SLUG, new URLSearchParams({ room: code, [MAKE_PARAM]: "1" })), `${QUIZ_SLUG}~${code}`);
});

test("maker page only for ?make=1 with no room param; a cut room code is a bad link, not the maker", () => {
  const p = (s: string) => new URLSearchParams(s);
  assert.equal(opensMakerPage(QUIZ_SLUG, p("make=1")), true);
  assert.equal(opensMakerPage(QUIZ_SLUG, p("make=1&room=ABCDEFGH23")), false, "in a room: the maker opens over the room");
  assert.equal(opensMakerPage(QUIZ_SLUG, p("make=1&room=ABC")), false, "cut code → LiveApp's invalid-link screen");
  assert.equal(opensMakerPage(QUIZ_SLUG, p("make=1&room=1")), false, "legacy room param → the room");
  assert.equal(opensMakerPage(QUIZ_SLUG, p("")), false);
  assert.equal(opensMakerPage("tpl-tap-battle", p("make=1")), false, "only the quiz app");
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

test("draft round-trips through device storage (answers, custom/tpl flags, name state)", () => {
  const kv = memKV();
  const d = newDraft("수달", { random: rng(8), nickAuto: true });
  d.questions[0] = tapAnswer(d.questions[0], 2);
  d.questions.push({ ...blankQuestion(), q: "내 별명은?", options: ["a", "b", "c"], answer: 1 });
  const named = setName(d, "민지");
  assert.equal(quizStore(kv).saveDraft(named), true);
  assert.deepEqual(quizStore(kv).loadDraft(), named); // a new store = a reload
  quizStore(kv).clearDraft();
  assert.equal(quizStore(kv).loadDraft(), null);
});

test("storage that throws: nothing crashes, save reports false, the page keeps the draft and packs in memory", () => {
  const s = quizStore(throwingKV);
  const d = draftOf(9);
  assert.equal(s.saveDraft(d), false);
  assert.deepEqual(s.loadDraft(), d);
  const pack = buildQuizPack(answered(d));
  assert.equal(s.rememberRoomPack("tpl-x~CODE", pack), false);
  assert.deepEqual(s.roomPack("tpl-x~CODE"), pack, "the in-app move to the room still finds the pack");
  assert.deepEqual(s.recentPacks(), [pack]);
  assert.equal(quizStore(null).saveDraft(d), false, "no storage at all");
  const kv = memKV();
  kv.setItem("snack.quiz.draft", "{nope");
  kv.setItem("snack.quiz.rooms", "[1,2");
  kv.setItem("snack.quiz.recent", "{}");
  assert.equal(quizStore(kv).loadDraft(), null);
  assert.equal(quizStore(kv).roomPack("a"), null);
  assert.deepEqual(quizStore(kv).recentPacks(), []);
});

test("rooms + recent quizzes: newest 10 rooms, newest 3 quizzes, 7-day expiry; forgetting a room keeps the quiz", () => {
  let now = 1_000_000;
  const kv = memKV();
  const s = quizStore(kv, () => now);
  const packs = [1, 2, 3, 4].map((i) => buildQuizPack({ ...answered(draftOf(20 + i)), title: `퀴즈 ${i}` }));
  for (let i = 0; i < 12; i++) {
    now += 1000;
    s.rememberRoomPack(`room${i}`, packs[i % 4]);
  }
  assert.equal(s.roomPack("room0"), null);
  assert.equal(s.roomPack("room1"), null);
  assert.deepEqual(quizStore(kv, () => now).roomPack("room11"), packs[3]);
  assert.equal(s.recentPacks().length, RECENT_KEEP);
  assert.deepEqual(s.recentPacks()[0], packs[3], "newest first, no duplicates");
  s.forgetRoomPack("room11");
  assert.equal(s.roomPack("room11"), null);
  assert.deepEqual(s.recentPacks()[0], packs[3], "another quiz became active: mine is still on the device");
  now += QUIZ_TTL_MS;
  assert.equal(s.roomPack("room10"), null, "rooms expire after 7 days");
  assert.deepEqual(s.recentPacks(), [], "so do recent quizzes");
});

test("per-room send state: confirm resets the count, refusals and retries are stored", () => {
  const s = quizStore(memKV());
  const pack = buildQuizPack(answered(draftOf(11)));
  s.rememberRoomPack("r", pack);
  s.countSend("r");
  s.countSend("r");
  assert.equal(s.roomEntry("r")?.sends, 2);
  s.confirmRoomPack("r");
  assert.deepEqual([s.roomEntry("r")?.confirmed, s.roomEntry("r")?.sends], [true, 0]);
  s.refuseRoomPack("r", "not_subject");
  assert.equal(s.roomEntry("r")?.refused, "not_subject");
  s.retryRoomPack("r");
  assert.equal(s.roomEntry("r")?.refused, undefined);
  s.rememberRoomPack("r", pack);
  assert.equal(s.roomEntry("r")?.confirmed, undefined, "a new pack starts unconfirmed");
});

// ── sending the pack in the room (keys off the room's per-player iAmSubject) ──
const st = (o: Partial<PackState> = {}): PackState => ({ phase: "lobby", info: null, iAmSubject: undefined, entry: {}, lastSentAt: 0, now: 10_000, ...o });
const mine = { custom: true, about: "라임", title: "라임 맞히기", count: 8 };

test("packAction: first join sends in lobby/result, at most every 3 s; confirm on iAmSubject", () => {
  assert.equal(packAction(st()), "send", "first join");
  assert.equal(packAction(st({ phase: "result" })), "send");
  assert.equal(packAction(st({ phase: "play" })), "wait", "the room refuses packs mid-game");
  assert.equal(packAction(st({ phase: "countdown" })), "wait");
  assert.equal(packAction(st({ lastSentAt: 8_000 })), "wait", "3 s gap");
  assert.equal(packAction(st({ lastSentAt: 7_000 })), "send");
  assert.equal(packAction(st({ info: mine, iAmSubject: true })), "confirm");
  assert.equal(packAction(st({ info: mine, iAmSubject: true, entry: { confirmed: true } })), "wait");
  assert.equal(packAction(st({ info: { custom: false }, iAmSubject: false, entry: { confirmed: true } })), "send", "the room lost it → re-send");
});

test("packAction: same nickname and title on two devices — only the room's iAmSubject decides", () => {
  // Two devices both named 라임 with the same default title; the room made the OTHER one the subject.
  assert.equal(packAction(st({ info: mine, iAmSubject: false, entry: { confirmed: true } })), "forget", "I was the subject: stop");
  assert.equal(packAction(st({ info: mine, iAmSubject: false, entry: {} })), "send", "my new quiz is not the room's yet: send (the room decides)");
  assert.equal(packAction(st({ info: mine, iAmSubject: true })), "confirm", "a matching nick alone never matters; the flag does");
});

test("packAction: 나도 만들기 from the result — the new maker sends; the old subject stops but keeps the quiz", () => {
  const other = { custom: true, about: "감자", title: "감자 맞히기", count: 6 };
  assert.equal(packAction(st({ phase: "result", info: other, iAmSubject: false })), "send");
  assert.equal(packAction(st({ phase: "lobby", info: other, iAmSubject: false, entry: { confirmed: true } })), "forget");
});

test("packAction: stop re-sending when refused or after 5 unconfirmed sends — and say so", () => {
  assert.equal(packAction(st({ entry: { refused: "invalid_pack" } })), "failed");
  assert.equal(packAction(st({ phase: "result", info: mine, iAmSubject: false, entry: { refused: "not_subject" } })), "failed");
  assert.equal(packAction(st({ entry: { sends: MAX_SENDS - 1 } })), "send");
  assert.equal(packAction(st({ entry: { sends: MAX_SENDS } })), "failed");
  assert.equal(packAction(st({ iAmSubject: true, entry: { sends: MAX_SENDS } })), "confirm", "a late confirmation still wins");
  assert.match(packFailureMessage("invalid_pack"), /다시 만들어/);
  assert.match(packFailureMessage("not_subject"), /다른 친구의 퀴즈 차례/);
  assert.match(packFailureMessage("pack_waiting"), /다른 친구가 먼저 새 퀴즈를 만들었어요/);
  assert.ok(PACK_REFUSALS.has("pack_waiting"), "the room's first-maker-wins refusal stops re-sending");
  assert.match(packFailureMessage(undefined), /연결을 확인/);
});

test("packPending: the lobby says '준비 중…' (no start) from 완료 until the room takes the pack", () => {
  // made on its own page → a fresh room: nothing yet, then the room's cold default quiz
  assert.equal(packPending(st()), true, "connecting: no room state yet");
  assert.equal(packPending(st({ info: { custom: false, packId: null }, iAmSubject: false })), true, "the room plays the default quiz");
  assert.equal(packPending(st({ entry: { sends: 2 }, lastSentAt: 9_000 })), true, "sent, no answer yet");
  assert.equal(packPending(st({ info: { ...mine, packId: "p1" }, iAmSubject: true })), false, "taken: I am the subject");
  assert.equal(packPending(st({ entry: { refused: "pack_waiting" } })), false, "refused: the failure notice says so instead");
  assert.equal(packPending(st({ entry: { sends: MAX_SENDS } })), false, "gave up");
  assert.equal(packPending(st({ info: { ...mine, packId: "p1" }, iAmSubject: false, entry: { confirmed: true } })), false, "someone else's quiz now (forget)");
  assert.equal(packPending(st({ info: { ...mine, packId: "p1" }, iAmSubject: undefined, entry: { confirmed: true } })), false, "a reload: my confirmed quiz is the room's");
  assert.equal(packPending(st({ info: { custom: false }, iAmSubject: false, entry: { confirmed: true } })), true, "the room lost it: re-sending");
});

test("packAction: the subject remaking their quiz — only a NEW packId confirms it (iAmSubject is already true)", () => {
  const over = { ...mine, packId: "old" };
  const made = { madeOver: "old" };
  assert.equal(packAction(st({ info: over, iAmSubject: true, entry: made })), "send", "the room still has my OLD quiz: send the new one");
  assert.equal(packPending(st({ info: over, iAmSubject: true, entry: made })), true);
  assert.equal(packAction(st({ info: { ...mine, packId: "new" }, iAmSubject: true, entry: made })), "confirm");
  assert.equal(packPending(st({ info: { ...mine, packId: "new" }, iAmSubject: true, entry: made })), false);
  assert.equal(packAction(st({ info: { ...mine, packId: "new" }, iAmSubject: true, entry: { ...made, confirmed: true } })), "wait");
  // made over the default quiz (madeOver null): the first custom packId is mine
  assert.equal(packAction(st({ info: { custom: false, packId: null }, iAmSubject: false, entry: { madeOver: null } })), "send");
  assert.equal(packAction(st({ info: { ...mine, packId: "x" }, iAmSubject: true, entry: { madeOver: null } })), "confirm");
  const s = quizStore(null);
  s.rememberRoomPack("r", buildQuizPack({ title: "t", questions: Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, q: `q${i}`, options: ["a", "b"], answer: 0 })) }), "old");
  assert.equal(s.roomEntry("r")?.madeOver, "old", "stored with the pack");
});
