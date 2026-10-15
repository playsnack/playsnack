// Pure geometry and physics behind the renderer's input: where the frame sits
// on the canvas, client point → frame point, and drag-to-scroll with a fling.
// No Pixi, no DOM — unit-tested in Node (test/gesture.test.js).

/** Where a `fw`×`fh` frame lands in a `width`×`height` canvas: contain, centred. */
export function fitFrame(width, height, fw, fh) {
  const scale = Math.min(width / fw, height / fh);
  return { scale, x: (width - fw * scale) / 2, y: (height - fh * scale) / 2 };
}

/**
 * A client (CSS px) point → frame units. `rect` is the canvas's client rect —
 * it already carries any shift of the canvas itself (the shell's canvasFit
 * drop), so only the frame's centring offset and scale are applied on top.
 */
export function clientToFrame(clientX, clientY, rect, fit) {
  return { x: (clientX - rect.left - fit.x) / fit.scale, y: (clientY - rect.top - fit.y) / fit.scale };
}

export const clampScroll = (y, max) => Math.max(0, Math.min(Math.max(0, max), y));

// Fling: the list keeps going after a quick flick and slows down, like a native
// list. Velocity is in frame units per ms, measured over the last VELOCITY_WINDOW
// ms of the drag (older samples would blur a flick that ends a slow drag).
const VELOCITY_WINDOW = 100;
const FRICTION = 0.995; // velocity kept per ms (≈ 0.92 per 60 Hz frame)
const MIN_FLING = 0.05; // frame units / ms below which a release just stops
const MAX_FLING = 6;

/** Content velocity (frame units / ms, + = offset grows) from drag samples [{t, y}] of the finger in frame units. */
export function releaseVelocity(samples, now) {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW);
  if (recent.length < 2) return 0;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  if (now - b.t > 50) return 0; // the finger stopped before lifting: no fling
  const v = -(b.y - a.y) / dt; // finger up → content offset grows
  return Math.max(-MAX_FLING, Math.min(MAX_FLING, v));
}

/** Whether a release at velocity `v` starts a fling. */
export const flings = (v) => Math.abs(v) >= MIN_FLING;

/**
 * Advance a fling by `dt` ms. Returns the new offset and velocity; `done` once
 * it has slowed below the threshold or hit an end of the list.
 */
export function stepFling(y, v, dt, max) {
  const k = Math.pow(FRICTION, dt);
  // distance under exponential decay over dt: v · (1 − k) / −ln(FRICTION)
  const travelled = (v * (1 - k)) / -Math.log(FRICTION);
  const next = y + travelled;
  const clamped = clampScroll(next, max);
  const nv = v * k;
  return { y: clamped, v: nv, done: clamped !== next || Math.abs(nv) < MIN_FLING / 2 };
}

// ── mouse wheel / trackpad (#117) ──────────────────────────────────────────
// A desktop browser never turns a wheel into pointer events, so the canvas
// scrolls its boxes itself: the innermost box under the cursor that can still
// move that way takes the wheel; at an end, the wheel goes on to an outer box
// (or the page).

const LINE_PX = 40; // deltaMode 1 (Firefox mouse wheel): one "line" in CSS px

/**
 * A wheel event → CSS px {dx, dy} (+ = content offset grows). `pagePx` is one
 * page for deltaMode 2. Shift+wheel on a plain mouse (no deltaX) scrolls sideways.
 */
export function wheelPixels({ deltaX = 0, deltaY = 0, deltaMode = 0, shiftKey = false }, pagePx = 800) {
  const unit = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? pagePx : 1;
  let dx = deltaX * unit;
  let dy = deltaY * unit;
  if (shiftKey && dx === 0) [dx, dy] = [dy, 0];
  return { dx, dy };
}

/** Scroll boxes containing frame point (x, y), outermost first (an instance tree laid out by @snack/bite-layout). */
export function scrollChainAt(root, x, y, scroll) {
  const chain = [];
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    const inside = x >= ax && x < ax + inst.box.w && y >= ay && y < ay + inst.box.h;
    if ((inst.style?.clip || inst.style?.scroll) && !inside) return;
    if (inst.style?.scroll && inside && inst.contentSize) chain.push(inst);
    const off = scroll?.get(inst.key) ?? { x: 0, y: 0 };
    for (const c of inst.children ?? []) walk(c, ax - off.x, ay - off.y);
  };
  walk(root, -root.box.x, -root.box.y);
  return chain;
}

/** The axis a scroll box moves along: its main axis (`row` → x, else y). */
export const scrollAxis = (inst) => (inst.layout === "row" ? "x" : "y");

/**
 * Which box a wheel of (dx, dy) frame units moves, and to where: the innermost
 * box in `chain` that can still move in that direction. Null when none can —
 * the event is then left to the page.
 * @returns {{ key: string, offset: { x: number, y: number } } | null}
 */
export function pickWheelTarget(chain, dx, dy, scroll) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const inst = chain[i];
    const axis = scrollAxis(inst);
    const d = axis === "x" ? dx : dy;
    if (!d) continue;
    const max = axis === "x" ? inst.contentSize.w - inst.box.w : inst.contentSize.h - inst.box.h;
    const cur = scroll?.get(inst.key) ?? { x: 0, y: 0 };
    const from = clampScroll(cur[axis], max);
    const next = clampScroll(from + d, max);
    if (Math.abs(next - from) < 1e-6) continue; // already at that end
    return { key: inst.key, offset: { x: cur.x ?? 0, y: cur.y ?? 0, [axis]: next } };
  }
  return null;
}
