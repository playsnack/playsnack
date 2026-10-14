// Where the play canvas starts, so the shell's top row never covers the app.
//
// Templates keep the top 59 units of their 390×844 frame free for the shell's
// pills (← 홈 / 친구 초대 / 👥 N명): those are CSS pixels — 10 from the top, 44 tall,
// a 4px block shadow (Screens.tsx homePos, ui.ts pill) — so their bottom edge is at
// 58. The renderer scales the frame to fit (contain, centred; bite-pixi
// renderer.js fit), and on a phone shorter than the frame's shape (360×640,
// 375×667…) the 59 units shrink below 58px and the app's top line slides under
// 홈 (#85). The canvas then starts that much lower — the smallest drop that keeps
// the band clear; 0 on every phone where it already is (390×844 and up).

/** Bottom of the shell's top-row pills, CSS px from the canvas top (10 + 44 + 4 shadow). */
export const PILLS_BOTTOM = 58;
/** Frame units every template keeps free at the top for the shell. */
export const FRAME_TOP_BAND = 59;

type Frame = readonly [number, number];

/** The frame's top band edge on screen (px from the area's top) when the canvas starts `drop` lower. */
export function bandBottom(w: number, h: number, drop: number, frame: Frame = [390, 844]): number {
  const [fw, fh] = frame;
  const ch = Math.max(0, h - drop);
  const s = Math.min(w / fw, ch / fh); // renderer.js fit
  return drop + (ch - fh * s) / 2 + FRAME_TOP_BAND * s;
}

/** How far below the safe-area top the canvas starts in a `w`×`h` area (whole px). */
export function canvasDrop(w: number, h: number, frame: Frame = [390, 844]): number {
  if (!(w > 0 && h > 0)) return 0;
  let drop = 0;
  while (drop < PILLS_BOTTOM && bandBottom(w, h, drop, frame) < PILLS_BOTTOM) drop++;
  return drop;
}
