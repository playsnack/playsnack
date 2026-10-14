import { useRef, useState } from "react";
import { NICK_INPUT_MAX_UNITS } from "./nick";
import { NAME_CARD_BOX, nickToCommit, typedNick } from "./nameChoice";
import { TOKENS, C, R, S, blockShadow } from "./tokens.gen";
import { BLOCK_CSS } from "./ui";

// "이름 정하기" card in a room's lobby (#104, rules in nameChoice.ts): prefilled with the
// auto-assigned guest name; "이 이름 그대로" keeps it, "바꾸기" sends the edited one.
// Non-blocking — the template's own lobby buttons stay tappable around it.
export function NameCard({ nick, onKeep, onChange }: { nick: string; onKeep: () => void; onChange: (nick: string) => void }) {
  const [value, setValue] = useState(nick);
  const composing = useRef(false);
  const endCompose = (s: string) => {
    composing.current = false;
    setValue(typedNick(s, false));
  };
  const next = nickToCommit(value);
  const commit = () => {
    if (composing.current || !next) return;
    if (next === nickToCommit(nick)) onKeep();
    else onChange(next);
  };
  return (
    <div style={card} role="group" aria-label="이름 정하기">
      <style>{BLOCK_CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: S.s2 }}>
        <label htmlFor="snack-name-card" style={label}>이름 정하기</label>
        <button className="blk" style={keepBtn} onClick={onKeep}>이 이름 그대로</button>
      </div>
      <div style={{ display: "flex", gap: S.s2 }}>
        <input
          id="snack-name-card" value={value} maxLength={NICK_INPUT_MAX_UNITS} enterKeyHint="done" autoComplete="nickname"
          onChange={(e) => setValue(typedNick(e.target.value, composing.current))}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => endCompose(e.currentTarget.value)}
          onBlur={(e) => endCompose(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) commit(); }}
          placeholder="닉네임" style={input}
        />
        <button className="blk" style={{ ...changeBtn, opacity: next ? 1 : 0.4 }} disabled={!next} onClick={commit}>바꾸기</button>
      </div>
    </div>
  );
}

// Over the templates' title band, under the top-row pills, left of 💬 (nameChoice.ts NAME_CARD_BOX).
const card: React.CSSProperties = {
  position: "fixed", top: `calc(var(--snack-safe-top) + ${NAME_CARD_BOX.y}px)`, left: NAME_CARD_BOX.x,
  width: `min(${NAME_CARD_BOX.maxW}px, calc(100vw - ${NAME_CARD_BOX.x + NAME_CARD_BOX.right}px))`, height: NAME_CARD_BOX.h, boxSizing: "border-box", zIndex: 14,
  display: "flex", flexDirection: "column", justifyContent: "center", gap: S.s2, padding: `0 ${S.s3 - 2}px`,
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.accent}`, borderRadius: R.block, boxShadow: blockShadow,
  font: `${TOKENS.size.bodyMd}px ${TOKENS.font.body}`, color: C.ink,
};
const label: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: TOKENS.size.bodySm, fontWeight: 700, color: C.ink, whiteSpace: "nowrap" };
const keepBtn: React.CSSProperties = {
  flex: "none", height: 36, padding: "0 10px", borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  background: C.surface2, color: C.ink, boxShadow: "0 3px 0 #000000", cursor: "pointer",
  font: `700 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, whiteSpace: "nowrap",
};
const input: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 44, boxSizing: "border-box", background: C.surface2, border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  borderRadius: R.block, padding: "0 10px", color: C.ink, outline: "none",
  // Body font: the pixel face is only for headings ≥22px (design system rule). 16px: iOS does not zoom in on focus.
  font: `700 16px ${TOKENS.font.body}`,
};
const changeBtn: React.CSSProperties = {
  flex: "none", height: 44, padding: "0 14px", borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.accentInk}`,
  background: C.accent, color: C.accentInk, boxShadow: "0 3px 0 #000000", cursor: "pointer",
  font: `800 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`,
};
