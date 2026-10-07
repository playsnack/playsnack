// Seed-pool validator. Run after ANY manual (or future automated) refresh of
// data/pools/*.json so a bad edit can't silently break a live worldcup.
// Checks exactly what content.mjs (buildSongcup / buildPersonCup) needs:
//   songs   → {updatedAt, items:[{song, artist}]}, ≥2 rows
//   idols   → {updatedAt, items:[{name, gender:'m'|'f', rank?, rookie?}]}, ≥4 per gender, ≥1 rookie/gender
//   singers → same shape as idols
// Missing seed is NOT a failure (graceful LLM fallback covers it) — we only fail on
// a PRESENT-but-broken seed, which is the case that would ship a dead app.
// Usage: node snack-server/tools/validate-pools.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const POOLS = resolve(dirname(fileURLToPath(import.meta.url)), "../data/pools");
const load = (name) => {
  const p = resolve(POOLS, `${name}.json`);
  if (!existsSync(p)) return { missing: true };
  try { return { json: JSON.parse(readFileSync(p, "utf8")) }; }
  catch (e) { return { parseError: e.message }; }
};

let fails = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); fails++; };
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

function checkSongs() {
  console.log("songs.json");
  const { missing, parseError, json } = load("songs");
  if (missing) return warn("absent → LLM fallback (graceful). OK to ship.");
  if (parseError) return fail(`parse error: ${parseError}`);
  const items = json.items;
  if (!Array.isArray(items) || items.length < 2) return fail(`items must be an array of ≥2 (got ${items?.length})`);
  const bad = items.filter((x) => !x || typeof x.song !== "string" || typeof x.artist !== "string" || !x.song.trim() || !x.artist.trim());
  if (bad.length) return fail(`${bad.length} row(s) missing song/artist (e.g. ${JSON.stringify(bad[0])})`);
  ok(`${items.length} songs, updatedAt=${json.updatedAt}`);
}

function checkPeople(name) {
  console.log(`${name}.json`);
  const { missing, parseError, json } = load(name);
  if (missing) return warn("absent → LLM fallback (graceful). OK to ship.");
  if (parseError) return fail(`parse error: ${parseError}`);
  const items = json.items;
  if (!Array.isArray(items) || !items.length) return fail("items must be a non-empty array");
  const badGender = items.filter((x) => x?.gender !== "m" && x?.gender !== "f");
  if (badGender.length) fail(`${badGender.length} row(s) with gender not in {m,f} (e.g. ${JSON.stringify(badGender[0])}) — breaks SC-004`);
  const badName = items.filter((x) => typeof x?.name !== "string" || !x.name.trim());
  if (badName.length) fail(`${badName.length} row(s) missing name`);
  for (const g of ["m", "f"]) {
    const pool = items.filter((x) => x?.gender === g);
    if (pool.length < 4) fail(`gender '${g}': only ${pool.length} (need ≥4 to build a bracket)`);
    else if (pool.length < 16) warn(`gender '${g}': ${pool.length} (<16 → bracket repeats / shrinks)`);
    const top16 = [...pool].sort((a, b) => (a.rank || 999) - (b.rank || 999)).slice(0, 16);
    if (pool.length >= 4 && !pool.some((x) => x.rookie)) warn(`gender '${g}': no rookie in pool → SC-002 신인≥1 not guaranteed`);
    else if (pool.length >= 4) ok(`gender '${g}': ${pool.length} in pool, top16 rookie=${top16.some((x) => x.rookie) || "(injected)"}`);
  }
  ok(`updatedAt=${json.updatedAt}`);
}

console.log("=== seed-pool validation ===");
checkSongs();
checkPeople("idols");
checkPeople("singers");
console.log(fails ? `\nPOOLS: ${fails} FAIL` : "\nPOOLS: OK");
process.exit(fails ? 1 : 0);
