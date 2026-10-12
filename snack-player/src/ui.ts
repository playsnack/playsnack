// Shared shell styles for the "Mini-Block Arcade" skin (tokens from the SSOT).
import { TOKENS, C, R, S, blockShadow } from "./tokens.gen";

const BEVEL = "inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.45)";
/** Press = the signature motion: a tap collapses the hard shadow (the block sinks). */
export const BLOCK_CSS = `
.blk{ transition: transform .06s ease, box-shadow .06s ease; }
.blk:hover{ transform: translateY(2px); box-shadow: ${BEVEL}, 0 4px 0 ${C.shadow}; }
.blk:active{ transform: translateY(6px); box-shadow: ${BEVEL}, 0 0 0 ${C.shadow}; }
.blk:focus-visible{ outline: 3px solid ${C.ink}; outline-offset: 3px; }
@keyframes snackBlink { 0%,100%{opacity:1} 50%{opacity:.25} }
@media (prefers-reduced-motion: reduce){ .blk{ transition: none; } }
`;

export const primaryBtn: React.CSSProperties = {
  width: "100%", padding: S.s4, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.accentInk}`,
  background: C.accent, color: C.accentInk, boxShadow: blockShadow, cursor: "pointer",
  font: `800 ${TOKENS.size.bodyLg}px ${TOKENS.font.body}`,
};
export const secondaryBtn: React.CSSProperties = {
  width: "100%", padding: S.s4, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  background: C.surface2, color: C.ink, boxShadow: blockShadow, cursor: "pointer",
  font: `700 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`,
};
/** Small dark block that floats over the play canvas (home button, people count). */
export const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, minHeight: 36, padding: "0 12px",
  background: C.surface, color: C.ink, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
  boxShadow: "0 4px 0 #000000", font: `700 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, whiteSpace: "nowrap",
};
