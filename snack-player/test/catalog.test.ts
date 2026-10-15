// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitHome, type CatalogEntry } from "../src/catalog.ts";
import { QUIZ_APP_ID } from "../src/quiz.ts";

const index = JSON.parse(
  readFileSync(new URL("../../snack-server/data/bite/index.json", import.meta.url), "utf8"),
) as CatalogEntry[];

// The 대표작 (#144): "나 맞히기" — its own card on the home, above 추천.
const FLAGSHIP = QUIZ_APP_ID;
// The owner's real-phone-reviewed games, in the order he named them (#128).
// Promote a game by adding `featured: n` to its index.json entry — then add it here.
const REVIEWED = ["coop-click", "balance-game-vote"];

test("대표작 = exactly one app in index.json, the 나 맞히기 quiz, shown", () => {
  const marked = index.filter((t) => t.flagship !== undefined);
  assert.deepEqual(marked.map((t) => t.id), [FLAGSHIP], "flagship must be set on exactly one app");
  assert.equal(marked[0].flagship, true);
  assert.ok(!marked[0].hidden && !marked[0].mergedInto, "the flagship is hidden/merged");
  assert.equal(marked[0].featured, undefined, "the flagship also has a 추천 rank");
  assert.equal(splitHome(index).flagship?.id, FLAGSHIP);
});

test("추천 = exactly the reviewed games, in rank order, without the 대표작", () => {
  const { featured } = splitHome(index);
  assert.deepEqual(featured.map((t) => t.id), REVIEWED);
  assert.ok(!featured.some((t) => t.id === FLAGSHIP), "대표작 repeated in 추천");
});

test("every other shown game is under 검토 전, in catalog order, none twice", () => {
  const { flagship, featured, unreviewed } = splitHome(index);
  const shown = index.filter((t) => !t.hidden && !t.mergedInto);
  assert.equal(1 + featured.length + unreviewed.length, shown.length);
  const ids = [flagship!.id, ...featured.map((t) => t.id), ...unreviewed.map((t) => t.id)];
  assert.equal(new Set(ids).size, ids.length, "an app is listed twice");
  assert.deepEqual(new Set(ids), new Set(shown.map((t) => t.id)));
  for (const id of [FLAGSHIP, ...REVIEWED]) assert.ok(!unreviewed.some((t) => t.id === id), `${id} also in 검토 전`);
  const orders = unreviewed.map((t) => t.order!);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.ok(unreviewed.every((t) => !t.featured && !t.flagship));
});

test("featured ranks in index.json are unique positive integers on shown games", () => {
  const ranked = index.filter((t) => t.featured !== undefined);
  const ranks = ranked.map((t) => t.featured!);
  assert.ok(ranks.every((r) => Number.isInteger(r) && r > 0), `bad rank in ${JSON.stringify(ranks)}`);
  assert.equal(new Set(ranks).size, ranks.length, "duplicate featured rank");
  assert.ok(ranked.every((t) => !t.hidden && !t.mergedInto), "a featured game is hidden/merged");
});

test("the flagship leaves 추천 / 검토 전; a hidden flagship shows no card; first one wins", () => {
  const e = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, title: id, category: "game", emoji: "🎮", mode: "single", ...extra });
  const one = splitHome([e("a", { order: 1 }), e("b", { order: 2, flagship: true, featured: 1 }), e("c", { order: 3, featured: 2 })]);
  assert.equal(one.flagship?.id, "b");
  assert.deepEqual(one.featured.map((t) => t.id), ["c"]);
  assert.deepEqual(one.unreviewed.map((t) => t.id), ["a"]);
  const hidden = splitHome([e("a", { order: 1 }), e("b", { order: 2, flagship: true, hidden: true })]);
  assert.equal(hidden.flagship, null);
  assert.deepEqual(hidden.unreviewed.map((t) => t.id), ["a"]);
  const two = splitHome([e("x", { order: 5, flagship: true }), e("y", { order: 1, flagship: true })]);
  assert.equal(two.flagship?.id, "y");
  assert.deepEqual(two.unreviewed.map((t) => t.id), ["x"]);
});

test("hidden / merged games appear in neither section; rank beats catalog order", () => {
  const e = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, title: id, category: "game", emoji: "🎮", mode: "single", ...extra });
  const { flagship, featured, unreviewed } = splitHome([
    e("a", { order: 1 }),
    e("b", { order: 2, featured: 2 }),
    e("c", { order: 3, featured: 1 }),
    e("d", { order: 4, hidden: true, featured: 3 }),
    e("e", { order: 5, mergedInto: "a" }),
    e("f", { order: 0 }),
  ]);
  assert.equal(flagship, null);
  assert.deepEqual(featured.map((t) => t.id), ["c", "b"]);
  assert.deepEqual(unreviewed.map((t) => t.id), ["f", "a"]);
});
