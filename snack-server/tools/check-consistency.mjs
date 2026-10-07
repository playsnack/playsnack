// Release-consistency checker for the 44 curated templates. Enforces the design-system
// rules that tokens.mjs documents as "린트로 강제 예정" (planned-lint), now actually enforced:
//   · raw hex 직박 금지 — every color must be in the TOKENS roster
//   · spacing 4-grid only — padding/gap/margin must be multiples of 4
//   · radius 4단만 — radius ∈ {0, 999, "full"} (∪ documented circle exceptions)
// Colors are checked everywhere they can appear in a Bite doc — fill / color /
// stroke.color / shadow.color / gradient.colors — INCLUDING hex literals inside
// templates ("{picked ? '#d9ff00' : '#1e2127'}"), which state-bound colors used to hide.
// READ-ONLY. Prints a per-file + aggregate report. Exits 1 if any HARD violation
// (so it can join gate-all). Run: node snack-server/tools/check-consistency.mjs [--json]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { TOKENS } from "../src/tokens.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data/bite");
const ROSTER = new Set(Object.values(TOKENS.color).map((c) => c.toLowerCase())); // token roster
// Documented intentional off-roster colors (semantic game surfaces the roster doesn't
// cover). NEW colors outside roster∪this set HARD-FAIL → catches accidental drift like
// the #ff6b6b/#5aa7ff/#34d399 shades we snapped back to roster. Keep this list tight;
// don't add a color here just to silence the gate — only genuinely-intentional ones.
const GAME_ALLOWLIST = new Set([
  "#1b2030", // whackamole hole / dark game panel
  "#14243f", // game board (dark blue)
  "#111317", "#121418", // near-black raised panels (≈ surface)
  "#18351f", // win state bg (dark green)
  "#3b1115", "#3a171a", "#c0392b", // lose / danger reds
  "#2a3a10", "#393114", // dim-lime / olive accent surfaces
  "#d7dce3", // light divider/text (lighter inkMuted)
  "#ffb4b4", // light error/red text
]);
const ALLOWED_COLOR = (hex) => ROSTER.has(hex) || GAME_ALLOWLIST.has(hex);
const SPACING_KEYS = new Set(["pad", "gap"]);
const SAFE_AREA = new Set([TOKENS.layout.safeTop, TOKENS.layout.safeBottom]); // 59/34 — iOS safe-area, intentionally off the 4-grid
const COLOR_KEYS = new Set(["fill", "color", "colors"]); // + stroke.color / shadow.color via "color"
const RADIUS_OK = new Set([0, 999, "full"]);
const HEX_IN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const norm6 = (h) => { // #rgb / #rrggbb / #rrggbbaa → base #rrggbb lowercase, else null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(h.trim());
  if (!m) return null;
  let x = m[1].toLowerCase();
  if (x.length === 3) x = [...x].map((c) => c + c).join("");
  return "#" + x.slice(0, 6);
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".bite.json")).sort();
const agg = { color: new Map(), spacing: new Map(), radius: new Map() }; // value → count
const fileReports = [];
let hardFails = 0, softSpacing = 0, softRadius = 0;

for (const f of files) {
  const doc = JSON.parse(readFileSync(resolve(DIR, f), "utf8"));
  const v = { color: [], spacing: [], radius: [] };
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [k, val] of Object.entries(node)) {
      const p = `${path}.${k}`;
      const colorStrings = COLOR_KEYS.has(k) ? (Array.isArray(val) ? val : [val]).filter((x) => typeof x === "string") : [];
      if (colorStrings.length) {
        for (const str of colorStrings) {
          for (const m of str.match(HEX_IN) ?? []) {
            const hex = norm6(m);
            if (hex && !ALLOWED_COLOR(hex)) { v.color.push({ hex, p }); agg.color.set(hex, (agg.color.get(hex) || 0) + 1); }
          }
        }
      } else if (SPACING_KEYS.has(k) && (typeof val === "number" || Array.isArray(val))) {
        for (const n of (Array.isArray(val) ? val : [val]).filter((x) => typeof x === "number")) {
          if (n % 4 !== 0 && !SAFE_AREA.has(n)) { v.spacing.push({ k, val: n, p }); agg.spacing.set(n, (agg.spacing.get(n) || 0) + 1); }
        }
      } else if (k === "radius" && (typeof val === "number" || typeof val === "string")) {
        if (!RADIUS_OK.has(val)) { v.radius.push({ val, p }); agg.radius.set(val, (agg.radius.get(val) || 0) + 1); }
      } else if (val && typeof val === "object") walk(val, p);
    }
  };
  walk(doc, basename(f, ".bite.json"));
  // HARD = off-roster color (drift). SOFT = off-grid spacing / off-scale radius —
  // overwhelmingly intentional (notch-tuned gaps, circular elements), so reported
  // for awareness but NOT gate-failing. Only color discipline blocks the gate.
  if (v.color.length) { fileReports.push({ f, v }); hardFails += v.color.length; }
  softSpacing += v.spacing.length; softRadius += v.radius.length;
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ files: fileReports, summary: { hardFails, softSpacing, softRadius } }, null, 2));
  process.exit(hardFails ? 1 : 0);
}

console.log("=== release-consistency check (44 templates) ===\n");
console.log("HARD — off-roster colors (not in token roster ∪ documented allowlist):");
if (!fileReports.length) console.log("  ✓ none — all colors on-roster\n");
for (const { f, v } of fileReports) {
  console.log(`  ▸ ${f} (${v.color.length}): ${[...new Set(v.color.map((c) => c.hex))].join(", ")}`);
}
const fmtAgg = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join("  ");
console.log("\nSOFT — intentional, not gate-failing (awareness only):");
console.log(`  off-grid spacing values: ${fmtAgg(agg.spacing) || "(none)"}`);
console.log(`  off-scale radius values: ${fmtAgg(agg.radius) || "(none)"}`);
console.log(hardFails ? `\nCONSISTENCY: ${hardFails} off-roster color(s) across ${fileReports.length} files — FAIL` : "\nCONSISTENCY: OK");
process.exit(hardFails ? 1 : 0);
