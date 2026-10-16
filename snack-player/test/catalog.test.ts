// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isFeatured, splitHome, type CatalogEntry } from "../src/catalog.ts";
import { QUIZ_APP_ID } from "../src/quiz.ts";

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
