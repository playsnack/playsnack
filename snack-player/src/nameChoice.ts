// "이름 정하기" (#104): someone who opens a room link enters at once under an auto-assigned
// guest name ("느긋한 치킨", App.tsx). In the lobby the shell then offers a small card to keep
// or change it — never a gate. Changing it renames this player in the room live (room action
// `rename`, docs/bite-format.md §6.1) and on this device; keeping it marks the name as chosen,
// so the card never comes back. Pure, so it is unit-tested in Node (test/nameChoice.test.ts).

import { NICK_MAX, capGraphemes, clampNick } from "./nick";
import { frameFit } from "./canvasFit";

export type NameCardState = {
  /** This device's nickname is the auto-assigned guest one (identity.isNickAuto). */
  auto: boolean;
  /** Kept or changed on this page already (also covers storage that cannot remember it). */
  chosen: boolean;
  /** The app is played together and the room is connected. */
  live: boolean;
  /** The room's session phase ("" before the room said = the lobby). */
  phase: string;
  /** Something else owns the top of the screen now (maker, last result, a shell notice). */
  covered: boolean;
};

/** The card: only for an auto name, in a connected room's lobby, until chosen. */
export const showNameCard = (s: NameCardState) => s.auto && !s.chosen && s.live && (s.phase === "lobby" || s.phase === "") && !s.covered;

/**
 * What the field holds after a keystroke. Never cut while an IME is composing a syllable
 * (Chrome Android / Safari drop the composition) — capped to NICK_MAX graphemes when the
 * composition ends, on blur and on commit, like NicknameGate.
 */
export const typedNick = (raw: string, composing: boolean) => (composing ? raw : capGraphemes(raw, NICK_MAX));

/** The name to keep / send: trimmed, ≤ NICK_MAX graphemes; null when blank. */
export const nickToCommit = (raw: string): string | null => clampNick(raw) || null;

/**
 * Where the card sits (CSS px, from the play area's top-left — under the safe-area top):
 * under the top-row pills (bottom 58), left of the 🪲 / 💬 column (🪲 starts 96 px from the right
 * edge — DebugLog.tsx; 💬 58), over the templates' title band, never over a lobby button
 * (test/nameChoice.test.ts checks every together template at 360×640 and 390×844).
 * Width: `maxW`, narrower on a phone under 390 wide (`calc(100vw - right)` in CSS).
 */
export const NAME_CARD_BOX = { x: 12, y: 66, maxW: 278, right: 100, h: 112 } as const;
/** Its hard block shadow below the box. */
export const NAME_CARD_SHADOW = 6; // blockShadow (tokens: hardY)

/** The card's box on screen (CSS px, shadow included) in a play area `w` wide. */
export function nameCardRect(w: number) {
  const b = NAME_CARD_BOX;
  return { x: b.x, y: b.y, w: Math.min(b.maxW, w - b.x - b.right), h: b.h + NAME_CARD_SHADOW };
}

/** The card's box in frame units (the play canvas's coordinates) in a `w`×`h` play area. */
export function nameCardFrameBox(w: number, h: number, frame: readonly [number, number] = [390, 844]) {
  const { s, x, y } = frameFit(w, h, frame);
  const r = nameCardRect(w);
  return { x: (r.x - x) / s, y: (r.y - y) / s, w: r.w / s, h: r.h / s };
}
