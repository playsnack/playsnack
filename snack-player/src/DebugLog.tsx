// The 🪲 test-log panel (only with ?debug=1; loaded lazily from main.tsx, so normal
// visitors never download it). Shows the in-memory log from debugLog.ts; nothing is
// sent anywhere — "로그 복사" puts it on the clipboard, or shows it selected to copy by hand.
import { useEffect, useRef, useState } from "react";
import { clearLog, entries, formatEntry, logText, subscribe } from "./debugLog";
import { C, R, TOKENS } from "./tokens.gen";

export default function DebugLog() {
  const [open, setOpen] = useState(false);
  const [, setVersion] = useState(0);
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");
  const listRef = useRef<HTMLPreElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-render on new lines only while the panel is open (at most once a frame).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const unsub = subscribe(() => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setVersion((v) => v + 1); });
    });
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, [open]);
  const lines = open ? entries().map(formatEntry) : [];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, lines.length]);
  useEffect(() => {
    if (copy === "manual") areaRef.current?.select();
  }, [copy]);

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(logText());
      setCopy("copied");
      setTimeout(() => setCopy((c) => (c === "copied" ? "idle" : c)), 2000);
    } catch {
      setCopy("manual"); // no clipboard (in-app browsers, http): select-all text to long-press
    }
  };

  return (
    <>
      <button style={bugBtn} onClick={() => setOpen((o) => !o)} aria-label="테스트 로그" data-testid="debug-bug">🪲</button>
      {open && (
        <div style={panel} role="dialog" aria-label="테스트 로그" data-testid="debug-panel">
          <div style={bar}>
            <strong style={{ flex: 1 }}>테스트 로그 · {lines.length}줄</strong>
            <button style={btn} onClick={() => void doCopy()}>{copy === "copied" ? "복사했어요" : "로그 복사"}</button>
            <button style={btn} onClick={() => { clearLog(); setCopy("idle"); setVersion((v) => v + 1); }}>지우기</button>
            <button style={btn} onClick={() => { setOpen(false); setCopy("idle"); }} aria-label="닫기">✕</button>
          </div>
          {copy === "manual" ? (
            <>
              <div style={note}>복사가 막혀 있어요. 아래 글을 길게 눌러 전체 선택 후 복사해 주세요.</div>
              <textarea ref={areaRef} readOnly value={logText()} style={area} data-testid="debug-copy-area" />
            </>
          ) : (
            <pre ref={listRef} style={list} data-testid="debug-lines">{lines.join("\n")}</pre>
          )}
          <div style={note}>이 기록은 이 기기에만 있어요. 복사해서 보내기 전엔 어디에도 전송되지 않아요.</div>
        </div>
      )}
    </>
  );
}

// Left of the 😀 slot, under the top row: no template draws text or a button there
// (shellDocks.test.ts "debugTab" zone: x 294–326, y 62–94 on a 390-wide frame).
const bugBtn: React.CSSProperties = {
  // zIndex 13: under the shell's transient notices (topDock 15, result note 14), which may pass over this spot.
  position: "fixed", top: "calc(var(--snack-safe-top) + 62px)", right: 64, width: 32, height: 32, zIndex: 13,
  padding: 0, borderRadius: R.block, border: `2px solid ${C.borderBlock}`, background: C.surface, color: C.ink,
  fontSize: 16, lineHeight: "28px", cursor: "pointer", opacity: 0.85,
};
const panel: React.CSSProperties = {
  position: "fixed", left: 8, right: 8, bottom: "calc(var(--snack-safe-bottom) + 8px)", top: "calc(var(--snack-safe-top) + 116px)",
  zIndex: 46, display: "flex", flexDirection: "column", gap: 6, padding: 8,
  background: "rgba(11,12,14,0.96)", color: C.ink, border: `2px solid ${C.borderBlock}`, borderRadius: R.block,
  font: `13px ${TOKENS.font.body}`,
};
const bar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const btn: React.CSSProperties = {
  minHeight: 36, padding: "0 10px", borderRadius: R.block, border: `2px solid ${C.borderBlock}`,
  background: C.surface2, color: C.ink, font: `700 13px ${TOKENS.font.body}`, cursor: "pointer",
};
const list: React.CSSProperties = {
  flex: 1, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
  font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace", userSelect: "text",
};
const area: React.CSSProperties = {
  flex: 1, width: "100%", boxSizing: "border-box", resize: "none", background: "#000", color: C.ink,
  border: `1px solid ${C.borderBlock}`, font: "11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
};
const note: React.CSSProperties = { color: C.inkMuted, fontSize: 12 };
