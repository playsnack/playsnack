// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SPEED_QUIZ_ID, cardPath, flagshipActions, isBareQuizLink, isFeatured, redirectFor, splitHome, templateFileOf, type CatalogEntry } from "../src/catalog.ts";
import { roomIdFor } from "../src/links.ts";
import { QUIZ_APP_ID, QUIZ_SLUG } from "../src/quiz.ts";

const index = JSON.parse(
  readFileSync(new URL("../../snack-server/data/bite/index.json", import.meta.url), "utf8"),
) as CatalogEntry[];

// The 대표작 (#144): "나 맞히기" — its own card on the home, above 추천.
const FLAGSHIP = QUIZ_APP_ID;
// 추천작: games that passed a real-phone check or had their fix merged, in the
// order the owner named them (#128). Promote a game by adding `featured: n` +
// `reviewedIn: "#<issue/PR>"` to its index.json entry — then add it here.
const REVIEWED = ["coop-click", "balance-game-vote"];
// 나 맞히기 follow-up candidates that already exist as a template (#158).
const DERIVATIVES = ["most-likely-roster-vote"];
const e = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, title: id, category: "game", emoji: "🎮", mode: "single", ...extra });

test("대표작 = exactly one app in index.json, the 나 맞히기 quiz, shown", () => {
  const marked = index.filter((t) => t.flagship !== undefined);
  assert.deepEqual(marked.map((t) => t.id), [FLAGSHIP], "flagship must be set on exactly one app");
  assert.equal(marked[0].flagship, true);
  assert.ok(!marked[0].hidden && !marked[0].mergedInto, "the flagship is hidden/merged");
  assert.equal(marked[0].featured, undefined, "the flagship also has a 추천 rank");
  assert.equal(splitHome(index).flagship?.id, FLAGSHIP);
});

test("추천작 = exactly the reviewed games, in rank order, without the 대표작", () => {
  const { featured } = splitHome(index);
  assert.deepEqual(featured.map((t) => t.id), REVIEWED);
  assert.ok(!featured.some((t) => t.id === FLAGSHIP), "대표작 repeated in 추천작");
});

test("every other shown game is a 추천 후보, in catalog order, none twice", () => {
  const { flagship, featured, candidates } = splitHome(index);
  const shown = index.filter((t) => !t.hidden && !t.mergedInto);
  assert.equal(1 + featured.length + candidates.length, shown.length);
  const ids = [flagship!.id, ...featured.map((t) => t.id), ...candidates.map((t) => t.id)];
  assert.equal(new Set(ids).size, ids.length, "an app is listed twice");
  assert.deepEqual(new Set(ids), new Set(shown.map((t) => t.id)));
  for (const id of [FLAGSHIP, ...REVIEWED]) assert.ok(!candidates.some((t) => t.id === id), `${id} also in 추천 후보`);
  const orders = candidates.map((t) => t.order!);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.ok(candidates.every((t) => !t.featured && !t.reviewedIn && !t.flagship));
});

test("featured ranks in index.json are unique positive integers on shown games", () => {
  const ranked = index.filter((t) => t.featured !== undefined);
  const ranks = ranked.map((t) => t.featured!);
  assert.ok(ranks.every((r) => Number.isInteger(r) && r > 0), `bad rank in ${JSON.stringify(ranks)}`);
  assert.equal(new Set(ranks).size, ranks.length, "duplicate featured rank");
  assert.ok(ranked.every((t) => !t.hidden && !t.mergedInto), "a featured game is hidden/merged");
});

test("no implicit promotion: in index.json, featured and reviewedIn (#issue/PR) come only together", () => {
  for (const t of index) {
    assert.equal(t.featured !== undefined, t.reviewedIn !== undefined, `${t.id}: featured without reviewedIn, or the reverse`);
    if (t.reviewedIn !== undefined) assert.match(t.reviewedIn, /^#\d+$/, `${t.id}: reviewedIn must name the issue/PR`);
  }
  assert.deepEqual(index.filter(isFeatured).map((t) => t.id).sort(), [...REVIEWED].sort());
});

test("no implicit promotion: a rank alone, evidence alone, or a bad rank stays a 추천 후보", () => {
  const { featured, candidates } = splitHome([
    e("rank-only", { order: 1, featured: 1 }),
    e("evidence-only", { order: 2, reviewedIn: "#1" }),
    e("zero", { order: 3, featured: 0, reviewedIn: "#2" }),
    e("fraction", { order: 4, featured: 1.5, reviewedIn: "#3" }),
    e("blank", { order: 5, featured: 2, reviewedIn: " " }),
    e("ok", { order: 6, featured: 3, reviewedIn: "#4" }),
  ]);
  assert.deepEqual(featured.map((t) => t.id), ["ok"]);
  assert.deepEqual(candidates.map((t) => t.id), ["rank-only", "evidence-only", "zero", "fraction", "blank"]);
});

test("나 맞히기 derivatives: marked in data, follow-up 추천 후보 only, never 추천작", () => {
  const marked = index.filter((t) => t.derivativeOf !== undefined);
  assert.deepEqual(marked.map((t) => t.id).sort(), [...DERIVATIVES].sort());
  const { flagship, candidates } = splitHome(index);
  for (const t of marked) {
    assert.equal(t.derivativeOf, flagship!.id, `${t.id}: derivativeOf must name the 대표작`);
    assert.ok(!t.featured && !t.flagship, `${t.id}: a derivative promoted past 추천 후보`);
    assert.ok(candidates.some((c) => c.id === t.id), `${t.id}: not listed under 추천 후보`);
  }
});

test("the flagship leaves 추천작 / 추천 후보; a hidden flagship shows no card; first one wins", () => {
  const one = splitHome([e("a", { order: 1 }), e("b", { order: 2, flagship: true, featured: 1, reviewedIn: "#1" }), e("c", { order: 3, featured: 2, reviewedIn: "#2" })]);
  assert.equal(one.flagship?.id, "b");
  assert.deepEqual(one.featured.map((t) => t.id), ["c"]);
  assert.deepEqual(one.candidates.map((t) => t.id), ["a"]);
  const hidden = splitHome([e("a", { order: 1 }), e("b", { order: 2, flagship: true, hidden: true })]);
  assert.equal(hidden.flagship, null);
  assert.deepEqual(hidden.candidates.map((t) => t.id), ["a"]);
  const two = splitHome([e("x", { order: 5, flagship: true }), e("y", { order: 1, flagship: true })]);
  assert.equal(two.flagship?.id, "y");
  assert.deepEqual(two.candidates.map((t) => t.id), ["x"]);
});

test("hidden / merged games are never shown, in any tier; rank beats catalog order", () => {
  const { flagship, featured, candidates } = splitHome([
    e("a", { order: 1 }),
    e("b", { order: 2, featured: 2, reviewedIn: "#1" }),
    e("c", { order: 3, featured: 1, reviewedIn: "#2" }),
    e("d", { order: 4, hidden: true, featured: 3, reviewedIn: "#3" }),
    e("e", { order: 5, mergedInto: "a" }),
    e("f", { order: 0 }),
    e("g", { order: 6, hidden: true, flagship: true }),
    e("h", { order: 7, mergedInto: "a", featured: 4, reviewedIn: "#4" }),
  ]);
  assert.equal(flagship, null);
  assert.deepEqual(featured.map((t) => t.id), ["c", "b"]);
  assert.deepEqual(candidates.map((t) => t.id), ["f", "a"]);
});

test("index.json: no hidden / merged game reaches any home tier", () => {
  const { flagship, featured, candidates } = splitHome(index);
  const gone = new Set(index.filter((t) => t.hidden || t.mergedInto).map((t) => t.id));
  assert.ok(gone.size > 0);
  for (const t of [flagship!, ...featured, ...candidates]) assert.ok(!gone.has(t.id), `${t.id} is hidden/merged but shown`);
});

// ── #210: 나 맞히기 (대표작) and 스피드 퀴즈 are two games, two cards, one template ──
const BITE = new URL("../../snack-server/data/bite/", import.meta.url);

test("index.json: no duplicate ids", () => {
  const ids = index.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
});

test("대표작 card (나 맞히기): one button, 내 퀴즈 만들기 → the maker; no 스피드 퀴즈 link on it", () => {
  const { flagship } = splitHome(index);
  assert.equal(flagship?.title, "나 맞히기 퀴즈");
  const actions = flagshipActions(flagship!);
  assert.deepEqual(actions, [{ action: "make", label: "내 퀴즈 만들기", path: `/p/${QUIZ_SLUG}?make=1` }]);
  assert.ok(!actions.some((a) => /스피드/.test(a.label) || a.path === cardPath({ id: QUIZ_APP_ID })), "the public quiz room is on the 대표작 card again");
  assert.deepEqual(flagshipActions(e("other")), [{ action: "play", label: "바로 하기", path: "/p/tpl-other" }], "a non-quiz flagship still opens");
});

test("스피드 퀴즈: its own entry, listed once under 추천 후보, its own link — the quiz template's file", () => {
  const speed = index.filter((t) => t.title === "스피드 퀴즈");
  assert.deepEqual(speed.map((t) => t.id), [SPEED_QUIZ_ID], "스피드 퀴즈 must be one catalog entry");
  const s = speed[0];
  assert.equal(s.mode, "multi");
  assert.equal(templateFileOf(s), QUIZ_APP_ID);
  assert.ok(!s.flagship && !isFeatured(s), "스피드 퀴즈 promoted without review");
  const { flagship, featured, candidates } = splitHome(index);
  assert.equal(candidates.filter((t) => t.id === SPEED_QUIZ_ID).length, 1);
  assert.ok(flagship!.id !== SPEED_QUIZ_ID && !featured.some((t) => t.id === SPEED_QUIZ_ID));
  assert.equal(cardPath(s), "/p/tpl-speed-quiz");
  // Its own public room — not the 나 맞히기 one; friends rooms are its own too.
  const none = new URLSearchParams();
  assert.equal(roomIdFor(`tpl-${s.id}`, none), "tpl-speed-quiz");
  assert.notEqual(roomIdFor(`tpl-${s.id}`, none), roomIdFor(QUIZ_SLUG, none));
});

test("template: names an entry with its own file (no chains); index.html preloads that file", () => {
  const aliases = index.filter((t) => t.template !== undefined);
  assert.deepEqual(aliases.map((t) => t.id), [SPEED_QUIZ_ID]);
  for (const t of aliases) {
    const target = index.find((x) => x.id === t.template);
    assert.ok(target && !target.template && !target.mergedInto, `${t.id}: template ${t.template} is not a playable entry`);
    assert.ok(existsSync(new URL(`${t.template}.bite.json`, BITE)), `${t.id}: ${t.template}.bite.json missing`);
    assert.ok(!existsSync(new URL(`${t.id}.bite.json`, BITE)), `${t.id}: has a file of its own and a template`);
  }
  for (const t of index.filter((x) => !x.template && !x.mergedInto)) assert.ok(existsSync(new URL(`${t.id}.bite.json`, BITE)), `${t.id}.bite.json missing`);
  // The page preloads an app's file before the code runs (index.html); its alias map = index.json.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const map = JSON.parse(/var file = (\{[^}]*\})\[tpl\[1\]\]/.exec(html)![1]);
  assert.deepEqual(map, Object.fromEntries(aliases.map((t) => [t.id, t.template])));
});

test("a bare 나 맞히기 link (no room code, not the maker) opens 스피드 퀴즈; quiz links with a code stay", async () => {
  const p = (q: string) => new URLSearchParams(q);
  assert.equal(isBareQuizLink(QUIZ_SLUG, p("")), true);
  assert.equal(isBareQuizLink(QUIZ_SLUG, p("room=1")), true, "a legacy forced room is the public room");
  assert.equal(isBareQuizLink(QUIZ_SLUG, p("room=ABCDEFGHJK")), false, "a friends quiz room");
  assert.equal(isBareQuizLink(QUIZ_SLUG, p("make=1")), false, "the maker");
  assert.equal(isBareQuizLink(QUIZ_SLUG, p("room=bad!")), false, "a cut code → LiveApp's bad-link screen");
  assert.equal(isBareQuizLink("tpl-speed-quiz", p("")), false);
  assert.equal(isBareQuizLink("tpl-quiz-ox", p("")), false);
  assert.equal(await redirectFor(QUIZ_SLUG, p("")), "tpl-speed-quiz");
});

test("merged 상식 트리비아 레이스 → 스피드 퀴즈 (the built-in-questions game), not 나 맞히기", () => {
  assert.equal(index.find((t) => t.id === "race-trivia")?.mergedInto, SPEED_QUIZ_ID);
});
