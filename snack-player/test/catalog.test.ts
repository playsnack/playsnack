// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitHome, type CatalogEntry } from "../src/catalog.ts";

const index = JSON.parse(
  readFileSync(new URL("../../snack-server/data/bite/index.json", import.meta.url), "utf8"),
) as CatalogEntry[];

// The owner's real-phone-reviewed games, in the order he named them (#128).
// Promote a game by adding `featured: n` to its index.json entry — then add it here.
const REVIEWED = ["speed-trivia-score", "coop-click", "balance-game-vote"];

test("추천 = exactly the reviewed games, in rank order", () => {
  const { featured } = splitHome(index);
  assert.deepEqual(featured.map((t) => t.id), REVIEWED);
});

test("every other shown game is under 검토 전, in catalog order, none twice", () => {
  const { featured, unreviewed } = splitHome(index);
  const shown = index.filter((t) => !t.hidden && !t.mergedInto);
  assert.equal(featured.length + unreviewed.length, shown.length);
  for (const id of REVIEWED) assert.ok(!unreviewed.some((t) => t.id === id), `${id} also in 검토 전`);
  const orders = unreviewed.map((t) => t.order!);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.ok(unreviewed.every((t) => !t.featured));
});

test("featured ranks in index.json are unique positive integers on shown games", () => {
  const ranked = index.filter((t) => t.featured !== undefined);
  const ranks = ranked.map((t) => t.featured!);
  assert.ok(ranks.every((r) => Number.isInteger(r) && r > 0), `bad rank in ${JSON.stringify(ranks)}`);
  assert.equal(new Set(ranks).size, ranks.length, "duplicate featured rank");
  assert.ok(ranked.every((t) => !t.hidden && !t.mergedInto), "a featured game is hidden/merged");
});

test("hidden / merged games appear in neither section; rank beats catalog order", () => {
  const e = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, title: id, category: "game", emoji: "🎮", mode: "single", ...extra });
  const { featured, unreviewed } = splitHome([
    e("a", { order: 1 }),
    e("b", { order: 2, featured: 2 }),
    e("c", { order: 3, featured: 1 }),
    e("d", { order: 4, hidden: true, featured: 3 }),
    e("e", { order: 5, mergedInto: "a" }),
    e("f", { order: 0 }),
  ]);
  assert.deepEqual(featured.map((t) => t.id), ["c", "b"]);
  assert.deepEqual(unreviewed.map((t) => t.id), ["f", "a"]);
});
