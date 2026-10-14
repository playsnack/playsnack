// Home's quiet "📊 통계" link at the very bottom, for everyone: opens /stats in-app,
// with the one-line notice about the random browser id (deviceStats.ts).
import { TOKENS, C, S } from "./tokens.gen";

export function StatsLink({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: S.s6, gap: S.s1 }}>
      <button style={link} onClick={onOpen} aria-label="익명 통계 보기">📊 통계</button>
      <p style={notice}>익명 통계를 위해 이 브라우저에 무작위 번호를 저장해요 · 누가 했는지는 알 수 없어요</p>
    </div>
  );
}

const notice: React.CSSProperties = {
  margin: 0, maxWidth: 320, textAlign: "center", color: C.inkMuted, opacity: 0.8,
  fontSize: TOKENS.size.caption, lineHeight: 1.5,
};
// Quiet: no block, no lime — muted text with a 44px touch target.
const link: React.CSSProperties = {
  minHeight: TOKENS.layout.tap, padding: `0 ${S.s4}px`, background: "transparent", color: C.inkMuted,
  border: "none", textDecoration: "underline", textUnderlineOffset: 3,
  font: `600 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, cursor: "pointer",
};
