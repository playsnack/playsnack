// Generate snack-player/src/tokens.gen.ts from the SSOT (snack-server/src/tokens.mjs).
// The two packages can't share a runtime import cleanly (separate workspace roots +
// Vite fs constraints), so the React side consumes a GENERATED copy. SSOT stays one file.
//   node snack-server/tools/gen-tokens.mjs      → writes the file
//   (imported by check-tokens.mjs to verify the committed copy is in sync)
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOKENS, hardShadow, hardShadowSm, pixelBevel, blockShadow } from "../src/tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(here, "../../snack-player/src/tokens.gen.ts");

// Single rendering function — gen AND drift-check use it, so they can't disagree.
export function renderTokens() {
  return `// ⚠️ AUTO-GENERATED from snack-server/src/tokens.mjs — DO NOT EDIT.
// Regenerate:  node snack-server/tools/gen-tokens.mjs  (also runs on player prebuild)
// SSOT for the "Mini-Block Arcade" design system (color/radius/space/shadow/font).

export const TOKENS = ${JSON.stringify(TOKENS, null, 2)} as const;

/** color shorthand */
export const C = TOKENS.color;
/** spacing 4-grid shorthand */
export const S = TOKENS.space;
/** radius shorthand */
export const R = TOKENS.radius;

/** blur:0 hard offset shadow (the block signature) */
export const hardShadow = ${JSON.stringify(hardShadow)};
export const hardShadowSm = ${JSON.stringify(hardShadowSm)};
/** 8-bit pixel bevel: light top highlight + dark bottom — reads as a raised block on dark bg */
export const pixelBevel = ${JSON.stringify(pixelBevel)};
/** standard block depth = bevel + hard offset (use on cards/buttons) */
export const blockShadow = ${JSON.stringify(blockShadow)};
`;
}

// Only write when run directly (not when imported by check-tokens.mjs).
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  writeFileSync(OUT, renderTokens());
  console.log("✓ wrote", OUT.replace(resolve(here, "../.."), "."));
}
