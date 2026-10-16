// 시작 시간 정하기 (#218): the friends-room host's sheet over the lobby — presets (1/3/5/10분 뒤) or a
// clock time today (tomorrow once it passed, at most 24 h ahead), shown in this device's locale. The
// room decides (server clock) and tells everyone; this sheet closes when the room said it took it,
// or shows why not. With a schedule already set: what it is, and 예약 취소.
import { useEffect, useMemo, useRef, useState } from "react";
import BlockButton from "./BlockButton";
import { primaryBtn, secondaryBtn } from "./ui";
import { C, R, S, TOKENS } from "./tokens.gen";
import { SCHEDULE_PRESETS_MIN, clockText, mmss, msUntilClock, scheduleOk } from "./schedule";

export type ScheduleSheetProps = {
  /** What is scheduled now (the lobby's countdown), or null. */
  current: { startAt: number; startAtText: string } | null;
  busy: boolean;
  error: string | null;
  onPick: (ms: number) => void;
  onCancel: () => void;
  onClose: () => void;
  /** Tests only (localStorage snack_sched_test_s): one more, short preset. The room still checks its minimum. */
  testSec?: number;
  now?: () => number;
};

export default function ScheduleSheet({ current, busy, error, onPick, onCancel, onClose, testSec, now = () => Date.now() }: ScheduleSheetProps) {
  const [clock, setClock] = useState("");
  const [tick, setTick] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeFn.current(); };
    addEventListener("keydown", onKey);
    const id = setInterval(() => setTick((n) => n + 1), 1000); // "12분 뒤" stays true while the sheet is open
    return () => { removeEventListener("keydown", onKey); clearInterval(id); };
  }, []);
  const t = now();
  const clockMs = useMemo(() => (clock ? msUntilClock(clock, t) : null), [clock, tick]);
  const clockValid = scheduleOk(clockMs);
  const leftText = (ms: number) => (ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}시간 ${Math.floor((ms % 3600_000) / 60_000)}분 뒤` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 뒤` : `${mmss(Math.ceil(ms / 1000))} 뒤`);
  const presets: { label: string; ms: number }[] = [
    ...(testSec ? [{ label: `${testSec}초 뒤`, ms: testSec * 1000 }] : []),
    ...SCHEDULE_PRESETS_MIN.map((m) => ({ label: `${m}분 뒤`, ms: m * 60_000 })),
  ];

  return (
    <div style={sheet} role="dialog" aria-modal="true" aria-label="시작 시간 정하기" data-testid="schedule-sheet">
      <div style={col}>
        <h1 style={title}>시작 시간 정하기</h1>
        <p style={muted}>정한 시간이 되면 2명 이상일 때 저절로 시작해요. 혼자면 친구가 오는 대로 시작해요.</p>
        {current && (
          <div style={nowCard} data-testid="schedule-current">
            <span>{current.startAtText} 시작</span>
            <span style={{ ...muted, textAlign: "left" }}>{leftText(Math.max(0, current.startAt - t))} · 다시 고르면 바뀌어요</span>
          </div>
        )}
        <div style={grid}>
          {presets.map((p) => (
            <BlockButton key={p.label} style={presetBtn} disabled={busy} onClick={() => onPick(p.ms)} data-testid={`schedule-preset-${p.ms}`}>
              {p.label}
            </BlockButton>
          ))}
        </div>
        <label style={label} htmlFor="schedule-clock">시각으로 정하기</label>
        <div style={{ display: "flex", gap: S.s2 }}>
          <input id="schedule-clock" type="time" value={clock} onChange={(e) => setClock(e.target.value)} style={input} data-testid="schedule-clock" />
          <BlockButton style={{ ...primaryBtn, width: "auto", flex: "none", padding: `0 ${S.s4}px` }} disabled={busy || !clockValid} onClick={() => clockMs != null && onPick(clockMs)}>
            예약
          </BlockButton>
        </div>
        {clock && (
          <p style={{ ...muted, textAlign: "left", color: clockValid ? C.ink : C.inkMuted }} role="status">
            {clockMs == null ? "시각을 다시 골라 주세요" : clockValid ? `${clockText(t + clockMs, t)} 시작 · ${leftText(clockMs)}` : "너무 가까워요 · 조금 더 뒤로 골라 주세요"}
          </p>
        )}
        {busy && <p style={muted} role="status">예약하는 중…</p>}
        {error && <p style={{ ...muted, color: C.ink }} role="alert">{error}</p>}
        {current && <BlockButton style={secondaryBtn} disabled={busy} onClick={onCancel} data-testid="schedule-cancel">예약 취소</BlockButton>}
        <BlockButton buttonRef={closeRef} style={secondaryBtn} onClick={onClose}>닫기</BlockButton>
      </div>
    </div>
  );
}

const sheet: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 50, background: C.bg, color: C.ink, overflowY: "auto",
  display: "flex", justifyContent: "center",
  padding: `calc(var(--snack-safe-top) + ${S.s4}px) 16px calc(var(--snack-safe-bottom) + ${S.s4}px)`,
  font: `600 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`,
};
const col: React.CSSProperties = { width: "100%", maxWidth: 400, margin: "auto 0", display: "flex", flexDirection: "column", alignItems: "stretch", gap: S.s3 };
const title: React.CSSProperties = { margin: 0, textAlign: "center", font: `800 ${TOKENS.size.titleMd}px ${TOKENS.font.body}` };
const muted: React.CSSProperties = { margin: 0, textAlign: "center", color: C.inkMuted, font: `600 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, wordBreak: "keep-all" };
const label: React.CSSProperties = { marginTop: S.s2, color: C.ink, font: `700 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}` };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.s2 };
const presetBtn: React.CSSProperties = { ...secondaryBtn, padding: `${S.s3}px ${S.s2}px`, font: `700 ${TOKENS.size.bodyLg}px ${TOKENS.font.body}` };
const nowCard: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: S.s1, padding: `${S.s2}px ${S.s3}px`, background: C.surface,
  border: `${TOKENS.border.block}px solid ${C.accent}`, borderRadius: R.block, color: C.ink, font: `700 ${TOKENS.size.bodyLg}px ${TOKENS.font.body}`,
};
const input: React.CSSProperties = {
  flex: 1, minWidth: 0, minHeight: 50, padding: `0 ${S.s3}px`, background: C.surface2, color: C.ink, colorScheme: "dark",
  border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, font: `700 ${TOKENS.size.bodyLg}px ${TOKENS.font.body}`,
};
