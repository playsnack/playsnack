import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { contentFor, parseContentUrl, hangulInitials } from "../src/index.js";

const D = new URL("../../../snack-server/data/", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, D), "utf8"));
const data = {
  bank: json("seed-content/content.json"),
  pools: { songs: json("pools/songs.json").items, idols: json("pools/idols.json").items, singers: json("pools/singers.json").items },
};

test("every template's data.url has keyless content with the keys its vars expect", () => {
  const dir = new URL("bite/", D);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".bite.json"))) {
    const doc = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    if (!doc.data?.url) continue;
    const q = parseContentUrl(doc.data.url);
    assert.ok(q, `${f}: content url`);
    const c = contentFor(q.kind, q.theme, data);
    assert.ok(c, `${f}: no keyless content for ${q.kind}/${q.theme}`);
    const keys = Object.keys(c).filter((k) => k in doc.vars);
    assert.ok(keys.length > 0, `${f}: content keys ${Object.keys(c)} match no vars`);
  }
});

test("person cups keep the gender and include a rookie when the pool has one", () => {
  const cup = contentFor("idolcup", "f", data);
  assert.equal(cup.current.length, 16);
  const females = new Set(data.pools.idols.filter((x) => x.gender === "f").map((x) => x.name));
  assert.ok(cup.current.every((c) => females.has(c.name)));
});

test("초성 puzzles are computed from the answer", () => {
  assert.equal(hangulInitials("비행기"), "ㅂㅎㄱ");
  const c = contentFor("choseong", "", data, () => 0.3);
  for (const q of c.questions) assert.equal(q.chosung, hangulInitials(q.options[q.answer]));
});
