// Drift guard: fail if snack-player/src/tokens.gen.ts is out of sync with the SSOT.
// Wired into gate-all so a forgotten regen can't silently break the "single source".
//   node snack-server/tools/check-tokens.mjs
import { readFileSync } from "node:fs";
import { renderTokens, OUT } from "./gen-tokens.mjs";

let actual = "";
try { actual = readFileSync(OUT, "utf8"); } catch { actual = ""; }
const expected = renderTokens();

if (actual === expected) {
  console.log(JSON.stringify({ summary: "tokens.gen.ts in sync with SSOT (tokens.mjs)" }));
  process.exit(0);
}
console.error(JSON.stringify({ summary: "DRIFT: tokens.gen.ts ≠ SSOT — run `node snack-server/tools/gen-tokens.mjs`" }));
process.exit(1);
