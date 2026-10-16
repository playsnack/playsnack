// Shell screens around the play canvas: full-screen messages (bad link,
// network error, loading), the home button, the room status chip and the
// "couldn't join the room" sheet. Plain Korean (해요체), no raw error text.
import { useEffect, useRef, useState } from "react";
import { hrefTo } from "./backend";
import { BLOCK_CSS, pill, primaryBtn, secondaryBtn } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";
import { HOST_NOTICE_BOX, PIN_LENGTH, failCopy, isPin, pinDigits, pinErrorText, waitText } from "./roomAdmission";

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

/** Top-right room status: joining… → 👥 N명 (→ "다시 연결 중…" while getting back in after a drop, #115). */
export function RoomChip({ state, people, reconnecting = false }: { state: "connecting" | "connected"; people: number; reconnecting?: boolean }) {
  return (
    <div style={{ ...pill, ...chipPos }} aria-live="polite">
      {state === "connecting" || reconnecting ? (
        <>
          <span style={{ width: 8, height: 8, background: C.accent, animation: "snackBlink 0.9s infinite" }} />
          {state === "connecting" ? "방에 들어가는 중" : "다시 연결 중…"}
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

/** Edge rooms past today's free-tier guard (docs/edge-rooms.md §무료 한도): limits reset 00:00 UTC = 09:00 KST. */
export const ROOM_FULL_TODAY = "room_full_today";

/** ms left until `until` (epoch ms), ticking every second while above 0. */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!until || until <= Date.now()) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

/**
 * Bottom sheet when the shared room can't be joined. The words come from one table per reason
 * (roomAdmission.ts failCopy, design §7): an expired / forged link has no "다시 시도"; a rate
 * limit's "다시 시도" waits `retryIn` ms (counting down); "홈으로" where the copy offers it.
 */
export function RoomFailedSheet({ onRetry, solo, reason, retryIn }: { onRetry: () => void; solo: Btn; reason?: string; retryIn?: number }) {
  const copy = failCopy(reason);
  const [until] = useState(() => (retryIn && retryIn > 0 ? Date.now() + retryIn : null));
  const wait = useCountdown(until);
  return (
    <div style={dim}>
      <div style={sheet} role="alertdialog" aria-label={copy.title} data-reason={reason ?? ""}>
        {copy.icon && <div style={{ fontSize: 36, lineHeight: 1 }}>{copy.icon}</div>}
        <h2 style={{ ...titleStyle, margin: `${copy.icon ? S.s3 : 0}px 0 ${S.s2}px` }}>{copy.title}</h2>
        <p style={bodyStyle}>{copy.body}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: S.s3, marginTop: S.s5 }}>
          {copy.retry && (
            <button className="blk" style={{ ...primaryBtn, opacity: wait > 0 ? 0.5 : 1 }} disabled={wait > 0} onClick={onRetry}>
              {wait > 0 ? `다시 시도 · ${waitText(wait)}` : "다시 시도"}
            </button>
          )}
          <button className="blk" style={secondaryBtn} onClick={solo.onClick}>{solo.label}</button>
          {copy.home && <button className="blk" style={secondaryBtn} onClick={goHome}>홈으로</button>}
        </div>
      </div>
    </div>
  );
}

/** The last refusal the PIN screen shows: wrong (with tries left) or locked (with the wait). */
export type PinError = { reason: string; left?: number; retryIn?: number };

/**
 * The PIN screen (#157). Full screen over the play area, the field near the top so the phone's
 * keyboard never covers it; a numeric keypad (inputMode numeric), the one-time-code autofill
 * hint, a 32 px field (≥ 16 px: iOS does not zoom on focus). Pretendard only (no pixel face on
 * Korean).
 *   set    the host picks 4 digits → 확인 (a new invite link is made) / 취소
 *   enter  a friend types the room's PIN → sent on the 4th digit ("확인 중…"); a wrong one shakes
 *          and clears the field with the tries left; locked counts down and turns itself back on.
 * The PIN lives only in this field until it is handed over; the screen keeps no copy.
 */
export function PinSheet({ mode, checking = false, error = null, onSubmit, onCancel, solo }: {
  mode: "set" | "enter"; checking?: boolean; error?: PinError | null; onSubmit: (pin: string) => void; onCancel?: () => void; solo?: Btn;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A new refusal: clear the field (and shake it for a wrong PIN); locked counts down from now.
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [shake, setShake] = useState(0);
  useEffect(() => {
    if (!error) return;
    setValue("");
    if (error.reason === "pin") setShake((n) => n + 1);
    setLockUntil(error.reason === "locked" ? Date.now() + Math.max(0, error.retryIn ?? 0) : null);
    inputRef.current?.focus({ preventScroll: true });
  }, [error]);
  const lockLeft = useCountdown(lockUntil);
  const locked = lockUntil !== null && lockLeft > 0;
  const shown = locked
    ? pinErrorText("locked", { retryInMs: lockLeft })
    : error?.reason === "pin" ? pinErrorText("pin", { left: error.left }) : null;
  const busy = checking || locked;
  const submit = (pin: string) => {
    if (busy || !isPin(pin)) return;
    onSubmit(pin);
    if (mode === "enter") setValue(""); // handed over: the field keeps no copy
  };
  const change = (s: string) => {
    const v = pinDigits(s);
    setValue(v);
    if (mode === "enter" && v.length === PIN_LENGTH) submit(v);
  };
  const title = mode === "set" ? "비밀번호 4자리를 정해 주세요" : "비밀번호를 입력해 주세요";
  return (
    <div style={pinScreen} role="dialog" aria-modal="true" aria-label={title} data-pin-mode={mode}>
      <style>{BLOCK_CSS + PIN_CSS}</style>
      <div style={pinCol}>
        <h1 style={{ ...titleStyle, margin: 0, textAlign: "center" }}>{title}</h1>
        <p style={{ ...bodyStyle, textAlign: "center" }}>
          {mode === "set" ? "새 초대 링크가 만들어지고, 들어올 때 한 번만 물어봐요" : checking ? "확인 중…" : "방장이 정한 4자리 숫자예요"}
        </p>
        <input
          ref={inputRef} key={shake} className={shake ? "snk-shake" : undefined} id="snack-pin" aria-label="비밀번호 4자리"
          type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" enterKeyHint={mode === "set" ? "done" : "go"}
          maxLength={PIN_LENGTH} value={value} disabled={busy} autoFocus
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(value); }}
          style={{ ...pinInput, opacity: busy ? 0.5 : 1 }}
        />
        {shown && (
          <div role="alert" style={{ textAlign: "center" }}>
            <p style={{ ...bodyStyle, color: C.ink, fontWeight: 700 }}>{shown.title}</p>
            {shown.body && <p style={{ ...bodyStyle, marginTop: S.s1 }}>{shown.body}</p>}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: S.s3, marginTop: S.s2 }}>
          {mode === "set" ? (
            <>
              <button className="blk" style={{ ...primaryBtn, opacity: isPin(value) && !busy ? 1 : 0.5 }} disabled={!isPin(value) || busy} onClick={() => submit(value)}>
                {checking ? "새 링크 만드는 중…" : "확인"}
              </button>
              <button className="blk" style={secondaryBtn} onClick={onCancel}>취소</button>
            </>
          ) : (
            <>
              {solo && <button className="blk" style={secondaryBtn} onClick={solo.onClick}>{solo.label}</button>}
              <button className="blk" style={secondaryBtn} onClick={goHome}>홈으로</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * To the host of a PIN room (top, under the home row): wrong PINs keep coming (`alert`), or the
 * room took too many and no longer lets anyone new in (`pinClosed`). One tap: a new link.
 */
export function HostPinNotice({ kind, busy = false, onMove, onClose }: { kind: "alert" | "closed"; busy?: boolean; onMove: () => void; onClose?: () => void }) {
  const text = kind === "closed" ? "비밀번호를 여러 번 틀린 시도가 있어 새로 들어오기가 막혔어요" : "누군가 비밀번호를 계속 틀리고 있어요";
  return (
    <div style={noticeDock} role="alert" data-host-pin={kind}>
      <div style={slowCard}>
        <span style={{ display: "flex", alignItems: "flex-start", gap: S.s2 }}>
          <span style={{ flex: 1 }}>{text}</span>
          {onClose && <button style={noticeClose} onClick={onClose} aria-label="닫기">✕</button>}
        </span>
        <button className="blk" style={{ ...primaryBtn, padding: S.s2, fontSize: TOKENS.size.bodyMd, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={onMove}>
          {busy ? "새 링크 만드는 중…" : "새 링크로 옮기기"}
        </button>
      </div>
    </div>
  );
}

const screen: React.CSSProperties = {
  position: "fixed", inset: 0, background: C.bg, color: C.ink,
  display: "flex", alignItems: "center", justifyContent: "center", padding: "0 16px",
  font: `16px ${TOKENS.font.body}`,
};
// Korean headings: Pretendard 600 (heading, #102); the pixel face is only for Latin/digit-only text (design system rule, #84).
const titleStyle: React.CSSProperties = {
  fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 600, lineHeight: 1.4, margin: `${S.s4}px 0 ${S.s2}px`, wordBreak: "keep-all",
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
// Under the top row like slowDock; the PIN notice for the host (HostPinNotice).
// Left of 😀 (others are in the room when it shows), under the top-row pills (shellDocks.test.ts).
const noticeDock: React.CSSProperties = {
  position: "fixed", top: `calc(var(--snack-safe-top) + ${HOST_NOTICE_BOX.y}px)`, left: HOST_NOTICE_BOX.x, right: HOST_NOTICE_BOX.right, zIndex: 17,
};
const noticeClose: React.CSSProperties = {
  flex: "none", width: 32, height: 32, margin: "-6px -6px 0 0", padding: 0, border: "none", background: "transparent",
  color: C.ink, fontSize: 16, cursor: "pointer",
};
// Above every room overlay (the name card 14, notices 15–17, the failure sheet 30); under the QR sheet (50).
const pinScreen: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 35, background: C.bg, color: C.ink, overflowY: "auto",
  display: "flex", justifyContent: "center", alignItems: "flex-start",
  padding: `calc(var(--snack-safe-top) + 72px) 16px calc(var(--snack-safe-bottom) + ${S.s4}px)`,
  font: `16px ${TOKENS.font.body}`,
};
const pinCol: React.CSSProperties = { width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", alignItems: "stretch", gap: S.s3 };
const pinInput: React.CSSProperties = {
  width: "100%", height: 64, boxSizing: "border-box", textAlign: "center", letterSpacing: "0.5em", paddingLeft: "0.5em",
  background: C.surface2, color: C.ink, border: `${TOKENS.border.block}px solid ${C.accent}`, borderRadius: R.block, outline: "none",
  // Body font, never the pixel face; 32 px ≥ 16 px so iOS does not zoom in on focus.
  font: `800 32px ${TOKENS.font.body}`, fontVariantNumeric: "tabular-nums",
};
const PIN_CSS = `
@keyframes snkShake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-10px)} 40%{transform:translateX(10px)} 60%{transform:translateX(-6px)} 80%{transform:translateX(6px)} }
.snk-shake{ animation: snkShake .36s ease; }
@media (prefers-reduced-motion: reduce){ .snk-shake{ animation: none; } }
#snack-pin::placeholder{ color: ${C.inkMuted}; }
`;
const dim: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 30, background: "rgba(0,0,0,0.6)",
  display: "flex", alignItems: "flex-end", justifyContent: "center",
};
const sheet: React.CSSProperties = {
  width: "100%", maxWidth: 520, background: C.surface, color: C.ink, textAlign: "center",
  borderTop: `${TOKENS.border.heavy}px solid ${C.accent}`, borderRadius: R.block, boxShadow: blockShadow,
  padding: `${S.s5}px 16px calc(var(--snack-safe-bottom) + ${S.s5}px)`, font: `16px ${TOKENS.font.body}`,
};
