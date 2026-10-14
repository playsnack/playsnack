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
