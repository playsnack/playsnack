// Shell screens around the play canvas: full-screen messages (bad link,
// network error, loading), the home button, the room status chip and the
// "couldn't join the room" sheet. Plain Korean (해요체), no raw error text.
import { hrefTo } from "./backend";
import { BLOCK_CSS, pill, primaryBtn, secondaryBtn } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";

type Btn = { label: string; onClick: () => void };

export const goHome = () => {
  location.href = hrefTo("/");
};

export function MessageScreen({ icon, title, body, primary, secondary, withHome = false }: {
  icon: string; title: string; body?: string; primary?: Btn; secondary?: Btn; withHome?: boolean;
}) {
  return (
    <div style={screen} role="alert">
      <style>{BLOCK_CSS}</style>
      {withHome && <HomeButton />}
      <div style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 48, lineHeight: 1 }}>{icon}</div>
        <h1 style={titleStyle}>{title}</h1>
        {body && <p style={bodyStyle}>{body}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: S.s3, marginTop: S.s5 }}>
          {primary && <button className="blk" style={primaryBtn} onClick={primary.onClick}>{primary.label}</button>}
          {secondary && <button className="blk" style={secondaryBtn} onClick={secondary.onClick}>{secondary.label}</button>}
        </div>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div style={screen} aria-busy="true">
      <style>{BLOCK_CSS}</style>
      <HomeButton />
      <div style={{ display: "flex", gap: 8 }} aria-label="불러오는 중">
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 14, height: 14, background: C.accent, animation: `snackBlink 0.9s ${i * 0.15}s infinite` }} />
        ))}
      </div>
    </div>
  );
}

/** "← 홈" — on every play screen. */
export function HomeButton() {
  return (
    <button className="blk" style={{ ...pill, ...homePos }} onClick={goHome} aria-label="홈으로">
      ← 홈
    </button>
  );
}

/** Top-right room status: joining… → 👥 N명. */
export function RoomChip({ state, people }: { state: "connecting" | "connected"; people: number }) {
  return (
    <div style={{ ...pill, ...chipPos }} aria-live="polite">
      {state === "connecting" ? (
        <>
          <span style={{ width: 8, height: 8, background: C.accent, animation: "snackBlink 0.9s infinite" }} />
          방에 들어가는 중
        </>
      ) : (
        <>👥 {people}명</>
      )}
    </div>
  );
}

/**
 * Still joining after a while (a slow broker): a calm line under the top row with the
 * seconds, and the "혼자 하기" way out the failed sheet would offer — it keeps trying meanwhile.
 */
export function RoomSlowNotice({ text, solo }: { text: string; solo: Btn }) {
  return (
    <div style={slowDock} role="status" aria-live="polite">
      <div style={slowCard}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: "none", width: 8, height: 8, background: C.accent, animation: "snackBlink 0.9s infinite" }} />
          {text}
        </span>
        <button className="blk" style={{ ...secondaryBtn, padding: S.s2, fontSize: TOKENS.size.bodyMd }} onClick={solo.onClick}>{solo.label}</button>
      </div>
    </div>
  );
}

/** Bottom sheet when the shared room can't be joined. */
/** Edge rooms past today's free-tier guard (docs/edge-rooms.md §무료 한도): limits reset 00:00 UTC = 09:00 KST. */
export const ROOM_FULL_TODAY = "room_full_today";
export function RoomFailedSheet({ onRetry, solo, reason }: { onRetry: () => void; solo: Btn; reason?: string }) {
  const full = reason === ROOM_FULL_TODAY;
  const title = full ? "오늘 준비한 방이 다 찼어요" : "같이 하는 방에 못 들어갔어요";
  return (
    <div style={dim}>
      <div style={sheet} role="alertdialog" aria-label={title}>
        <div style={{ fontSize: 36, lineHeight: 1 }}>{full ? "🌙" : "📡"}</div>
        <h2 style={{ ...titleStyle, margin: `${S.s3}px 0 ${S.s2}px` }}>{title}</h2>
        <p style={bodyStyle}>{full ? "한국 시간 오전 9시에 다시 열려요" : "인터넷이 불안정하거나 방 연결이 잠시 막혔을 수 있어요."}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: S.s3, marginTop: S.s5 }}>
          {!full && <button className="blk" style={primaryBtn} onClick={onRetry}>다시 시도</button>}
          <button className="blk" style={secondaryBtn} onClick={solo.onClick}>{solo.label}</button>
        </div>
      </div>
    </div>
  );
}

const screen: React.CSSProperties = {
  position: "fixed", inset: 0, background: C.bg, color: C.ink,
  display: "flex", alignItems: "center", justifyContent: "center", padding: "0 16px",
  font: `16px ${TOKENS.font.body}`,
};
// Korean headings: Pretendard 700 (heading); the pixel face is only for Latin/digit-only text (design system rule, #84).
const titleStyle: React.CSSProperties = {
  fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 700, lineHeight: 1.4, margin: `${S.s4}px 0 ${S.s2}px`, wordBreak: "keep-all",
};
const bodyStyle: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodyMd, lineHeight: 1.5, margin: 0, wordBreak: "keep-all" };
// Offset by the notch inset like the canvas (BitePlayer), so the pills sit over
// the same part of the app on every phone.
const homePos: React.CSSProperties = { position: "fixed", top: "calc(var(--snack-safe-top) + 10px)", left: 12, zIndex: 40 };
const chipPos: React.CSSProperties = { position: "fixed", top: "calc(var(--snack-safe-top) + 10px)", right: 12, zIndex: 20, pointerEvents: "none" };
// Under the top row (홈 · invite pill · people chip), like LiveApp's topDock.
const slowDock: React.CSSProperties = {
  position: "fixed", top: "calc(var(--snack-safe-top) + 66px)", left: 16, right: 16, maxWidth: 488, margin: "0 auto", zIndex: 16,
};
const slowCard: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: S.s2, padding: `${S.s3}px ${S.s3}px`,
  background: C.surface, color: C.ink, border: `2px solid ${C.borderBlock}`, borderRadius: R.block,
  font: `600 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`, wordBreak: "keep-all",
};
const dim: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 30, background: "rgba(0,0,0,0.6)",
  display: "flex", alignItems: "flex-end", justifyContent: "center",
};
const sheet: React.CSSProperties = {
  width: "100%", maxWidth: 520, background: C.surface, color: C.ink, textAlign: "center",
  borderTop: `${TOKENS.border.heavy}px solid ${C.accent}`, borderRadius: R.block, boxShadow: blockShadow,
  padding: `${S.s5}px 16px calc(var(--snack-safe-bottom) + ${S.s5}px)`, font: `16px ${TOKENS.font.body}`,
};
