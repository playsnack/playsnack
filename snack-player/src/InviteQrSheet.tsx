// The invite QR sheet (loaded on demand by InviteQr.tsx). Full screen over the
// play area: the invite link as a big QR (always black on a white quiet zone,
// so phone cameras read it even in the dark UI), the link itself, "링크 복사",
// "닫기". Only what really happened is said: "복사했어요" after the clipboard
// write resolved; with no clipboard, the link is selected to copy by hand.
import { useEffect, useMemo, useRef, useState } from "react";
import { QUIET_ZONE, qrMatrix, qrPath } from "./qr";
import BlockButton from "./BlockButton";
import { primaryBtn, secondaryBtn } from "./ui";
import { C, S, TOKENS } from "./tokens.gen";

export default function InviteQrSheet({ url, onClose, onCopied }: { url: string; onClose: () => void; onCopied?: () => void }) {
  const qr = useMemo(() => {
    const m = qrMatrix(url);
    return m && { d: qrPath(m), side: m.size + 2 * QUIET_ZONE };
  }, [url]);
  const [copy, setCopy] = useState<"copied" | "manual" | null>(null);
  const linkRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const closeFn = useRef(onClose);
  closeFn.current = onClose; // the room re-renders the parent often; keep one listener
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeFn.current(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
      onCopied?.();
    } catch {
      // No clipboard (in-app browsers, http): select the link for a long-press copy.
      setCopy("manual");
      const el = linkRef.current;
      const sel = getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  return (
    <div style={sheet} role="dialog" aria-modal="true" aria-label="QR 코드로 초대하기">
      <div style={col}>
        <h1 style={title}>QR로 초대하기</h1>
        {qr ? (
          <>
            <p style={muted}>옆에 있는 친구가 카메라로 찍으면 이 링크가 열려요</p>
            <div style={card}>
              <svg viewBox={`0 0 ${qr.side} ${qr.side}`} width="100%" height="100%" shapeRendering="crispEdges"
                role="img" aria-label="초대 링크 QR 코드" data-qr-url={url}>
                <rect width={qr.side} height={qr.side} fill="#FFFFFF" />
                <path d={qr.d} fill="#000000" />
              </svg>
            </div>
            <p style={muted}>화면 밝기를 올리면 더 잘 찍혀요</p>
          </>
        ) : (
          <p style={{ ...muted, color: C.ink }} role="status">이 링크는 너무 길어서 QR에 담을 수 없어요. 링크 복사로 보내 주세요.</p>
        )}
        <div ref={linkRef} style={link} data-testid="qr-link">{url}</div>
        {copy && (
          <p style={{ ...muted, color: copy === "copied" ? C.accent : C.ink }} role="status">
            {copy === "copied" ? "링크를 복사했어요" : "복사가 안 돼요. 위 링크를 길게 눌러 복사해 주세요"}
          </p>
        )}
        <BlockButton style={primaryBtn} onClick={() => void copyLink()}>링크 복사</BlockButton>
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
const col: React.CSSProperties = {
  width: "100%", maxWidth: 400, margin: "auto 0", display: "flex", flexDirection: "column", alignItems: "stretch", gap: S.s3,
};
const title: React.CSSProperties = {
  margin: 0, textAlign: "center", font: `800 ${TOKENS.size.titleMd}px ${TOKENS.font.body}`,
};
const muted: React.CSSProperties = {
  margin: 0, textAlign: "center", color: C.inkMuted, font: `600 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`,
};
// Square, as big as fits under the text and buttons (~430 px of them at most).
const card: React.CSSProperties = {
  alignSelf: "center", width: "min(100%, 360px, calc(100dvh - 430px))", minWidth: 200, aspectRatio: "1 / 1",
  background: "#FFFFFF", border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
};
const link: React.CSSProperties = {
  maxHeight: 64, overflowY: "auto", padding: `${S.s2}px ${S.s3}px`, background: C.surface,
  border: `${TOKENS.border.hairline}px solid ${C.hairline}`, color: C.ink, textAlign: "center",
  font: `600 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, wordBreak: "break-all", userSelect: "all",
};
