import type { CSSProperties } from "react";
import { C, S, TOKENS } from "./tokens.gen";

export function Brand() {
  return (
    <div style={brand}>
      <img
        src={`${import.meta.env.BASE_URL}icons/playsnack-icon.svg`}
        width={40} height={40} alt="" draggable={false}
        style={{ display: "block", flexShrink: 0, borderRadius: 8 }}
      />
      <span style={wordmark}>PlaySnack</span>
      <span style={beta}>BETA</span>
    </div>
  );
}

const brand: CSSProperties = {
  display: "flex", alignItems: "center", flexWrap: "wrap", gap: S.s2,
  minHeight: 40, maxWidth: "100%", letterSpacing: 0,
};
const wordmark: CSSProperties = {
  fontFamily: TOKENS.font.heading, fontSize: 28, fontWeight: 700,
  color: C.ink, lineHeight: 1.2, whiteSpace: "nowrap",
};
const beta: CSSProperties = {
  fontFamily: TOKENS.font.body, fontSize: 11, fontWeight: 700, lineHeight: 1.4,
  color: C.inkMuted, background: C.surface2, border: `1px solid ${C.borderBlock}`,
  borderRadius: 4, padding: "2px 6px", whiteSpace: "nowrap", flexShrink: 0,
};
