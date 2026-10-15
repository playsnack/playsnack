import { useRef, useState } from "react";
import { setNick, randomNick, uploadPhoto } from "./identity";
import { NICK_INPUT_MAX_UNITS, NICK_MAX, capGraphemes, clampNick } from "./nick";
import { SERVERLESS } from "./backend";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";
import BlockButton from "./BlockButton";
import { Brand } from "./Brand";
import { BLOCK_CSS } from "./ui";

// First-visit onboarding: pick a nickname + (optional) selfie before entering.
// Stored per-browser (localStorage) so each browser is an independent player;
// the selfie is uploaded by anonId and used as content in photo apps (얼굴 지목판 등).
// Skin = "Mini-Block Arcade": block frame avatar, lime hero CTA, tokens from SSOT.
export function NicknameGate({ onDone }: { onDone: (nick: string) => void }) {
  const [value, setValue] = useState(() => randomNick());
  const [photo, setPhoto] = useState<string | null>(null); // downscaled data-URL preview
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const v = clampNick(value);
  // Capped in graphemes (a Korean syllable or an emoji counts one) so the name
  // fits the ranking rows. Never cut the value while an IME is composing a
  // syllable (Chrome Android / Safari drop the composition): cap when the
  // composition ends, on blur and on commit. maxLength (UTF-16 units) is only
  // a far guard that no 10-grapheme name can hit.
  const composing = useRef(false);
  const typeNick = (s: string) => setValue(composing.current ? s : capGraphemes(s, NICK_MAX));
  const endCompose = (s: string) => {
    composing.current = false;
    setValue(capGraphemes(s, NICK_MAX));
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    const dataUrl = await downscale(file).catch(() => null);
    if (dataUrl) setPhoto(dataUrl);
  };

  const commit = async () => {
    if (!v || busy) return;
    setNick(v);
    if (photo) {
      setBusy(true);
      await uploadPhoto(photo); // best-effort; enter even if it fails
      setBusy(false);
    }
    onDone(v);
  };

  return (
    <div style={shell}>
      <style>{CSS}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <Brand />
        <h1 style={{ fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 600, margin: `${S.s3}px 0 ${S.s2}px`, lineHeight: 1.4 }}>닉네임을 정해주세요</h1>
        <p style={{ color: C.inkMuted, margin: `0 0 ${S.s5}px`, fontSize: TOKENS.size.bodyMd }}>{SERVERLESS ? "같이 하는 방에서 이 이름으로 보여요." : "같이 하는 방에서 이 이름·사진으로 보여요."}</p>

        {/* selfie — block frame (square, 핀 꽂힌 폴라로이드 느낌). Needs the server to store it. */}
        {!SERVERLESS && <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: S.s5 }}>
          <button className="blk" onClick={() => fileRef.current?.click()} style={{ ...avatarBtn, backgroundImage: photo ? `url(${photo})` : "none" }} title="사진 추가">
            {!photo && <span style={{ fontSize: 30 }}>📷</span>}
          </button>
          <input
            ref={fileRef} type="file" accept="image/*" capture="user" style={{ display: "none" }}
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
          <span style={{ color: C.inkMuted, fontSize: TOKENS.size.caption, marginTop: S.s2 }}>
            {photo ? "사진 변경 · 탭" : "사진 추가 (선택) — 얼굴 게임에 쓰여요"}
          </span>
        </div>}

        <div style={{ display: "flex", gap: S.s2 }}>
          <input
            value={value} maxLength={NICK_INPUT_MAX_UNITS} autoFocus
            onChange={(e) => typeNick(e.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(e) => endCompose(e.currentTarget.value)}
            onBlur={(e) => endCompose(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void commit(); }}
            placeholder="닉네임" style={input}
          />
          <button className="blk" onClick={() => setValue(randomNick())} title="랜덤" style={diceBtn}>🎲</button>
        </div>

        <BlockButton onClick={() => void commit()} disabled={!v || busy} style={{ ...cta, opacity: v && !busy ? 1 : 0.4, cursor: v && !busy ? "pointer" : "default" }}>
          {busy ? "사진 올리는 중…" : "시작하기"}
        </BlockButton>
        <p style={{ color: "#5b606b", margin: `${S.s4}px 0 0`, fontSize: TOKENS.size.caption, textAlign: "center" }}>
          이 브라우저에만 저장돼요 · 가입 없음
        </p>
      </div>
    </div>
  );
}

// Center-crop + downscale to 256² JPEG (~20–40KB) so uploads stay tiny.
function downscale(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const S2 = 256;
      const c = document.createElement("canvas");
      c.width = S2; c.height = S2;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("no ctx"));
      const scale = Math.max(S2 / img.width, S2 / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (S2 - w) / 2, (S2 - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const CSS = `
${BLOCK_CSS}
`;
const shell: React.CSSProperties = {
  position: "fixed", inset: 0, background: C.bg, color: C.ink,
  backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px)",
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "0 22px", font: `16px ${TOKENS.font.body}`,
};
const avatarBtn: React.CSSProperties = {
  width: 96, height: 96, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, boxShadow: blockShadow,
  background: C.surface, backgroundSize: "cover", backgroundPosition: "center",
  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: C.inkMuted,
};
const input: React.CSSProperties = {
  flex: 1, minWidth: 0, background: C.surface2, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
  // Body font: the pixel face is only for headings ≥22px (design system rule).
  padding: "15px 16px", color: C.ink, fontFamily: TOKENS.font.body, fontSize: TOKENS.size.bodyLg, fontWeight: 700, outline: "none",
};
const diceBtn: React.CSSProperties = {
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, boxShadow: blockShadow, width: 54,
  fontSize: 22, cursor: "pointer", color: C.ink,
};
const cta: React.CSSProperties = {
  width: "100%", marginTop: S.s4, padding: S.s4, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.accentInk}`,
  background: C.accent, color: C.accentInk, boxShadow: blockShadow, fontWeight: 800, fontSize: TOKENS.size.bodyLg,
};
