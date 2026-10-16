// "QR" next to every invite button: opens a full-screen sheet with the invite
// link as a big QR code, for friends in the same place to scan off this screen.
// This file is tiny and in the play bundle; the sheet and the QR encoder load
// only when the button is tapped (InviteQrSheet.tsx → qr.ts → qrcode-generator).
import { lazy, Suspense } from "react";
import { pill, secondaryBtn } from "./ui";
import { C, S, TOKENS } from "./tokens.gen";

/**
 * `pin` (edge rooms, #157): the room's PIN as this device chose it (host only; null = none known)
 * and the "비밀번호 걸기" row — offered only while this device is alone in the room (`canSet`).
 */
export type InvitePin = { value: string | null; canSet: boolean; onSet: () => void };
type SheetProps = { url: string; onClose: () => void; onCopied?: () => void; pin?: InvitePin; manual?: boolean };

const sheetBase: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 50, background: C.bg, color: C.ink,
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: S.s4,
  padding: `calc(var(--snack-safe-top) + ${S.s4}px) 16px calc(var(--snack-safe-bottom) + ${S.s4}px)`,
  font: `600 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`,
};

/** The sheet's chunk did not arrive (offline, new deploy): say so, never a blank or broken screen. */
function LoadFailed({ onClose }: SheetProps) {
  // React keeps a lazy component's first result; start over so the next tap tries again.
  const close = () => { Sheet = loadSheet(); onClose(); };
  return (
    <div style={sheetBase} role="dialog" aria-modal="true" aria-label="QR 코드로 초대하기">
      <p style={{ margin: 0, textAlign: "center" }}>QR을 불러오지 못했어요. 연결을 확인하고 다시 눌러 주세요.</p>
      <button className="blk" style={{ ...secondaryBtn, maxWidth: 360 }} onClick={close}>닫기</button>
    </div>
  );
}

const loadSheet = () => lazy(() => import("./InviteQrSheet.tsx").catch(() => ({ default: LoadFailed })));
let Sheet = loadSheet();

/** The "QR" button, 44 px at least; `style` lets a dock size it like its neighbour. */
export function QrButton({ onClick, style }: { onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button className="blk" style={{ ...pill, minWidth: 44, justifyContent: "center", padding: "0 12px", ...style }}
      onClick={onClick} aria-label="QR 코드로 초대하기">
      QR
    </button>
  );
}

/**
 * The sheet itself. `url` is the exact link the invite button hands out;
 * `onCopied` runs only once "링크 복사" really wrote the clipboard.
 */
export function InviteQrSheet(props: SheetProps) {
  return (
    <Suspense fallback={<div style={sheetBase} aria-label="불러오는 중" />}>
      <Sheet {...props} />
    </Suspense>
  );
}
