// Floating emoji reactions in a room (#121): what each one does on screen, kept
// free of the DOM so it is unit-tested (test/reactionFx.test.ts). ReactionLayer.tsx
// plays these plans with the Web Animations API — transform + opacity only.
//
//   · each reaction pops in with an overshoot, floats up with a sway and a random
//     drift, lingers ~2.5–3.5 s, then fades;
//   · reactions stack and scatter instead of replacing each other, up to CAP on
//     screen (a 200-player room never janks: the oldest leaves first);
//   · my own tap is an immediate local burst (no round trip), and the room's echo of
//     that same tap is not shown a second time (the room broadcasts to everyone,
//     sender included — snack-room room.js react());
//   · prefers-reduced-motion: no movement, a plain fade in place.

/** At most this many reactions on screen at once. */
export const REACTION_CAP = 24;
/** How long the room's echo of my own tap may take to come back and still be recognised. */
export const ECHO_WINDOW_MS = 5000;
/** My own tap shows this many (one big + small satellites). */
export const OWN_BURST = 3;

export type Particle = {
  emoji: string;
  /** Horizontal start, % of the overlay width. */
  x: number;
  /** Start, px above the overlay's bottom. */
  bottom: number;
  /** Font size, px. */
  size: number;
  /** How far up it floats, px. */
  rise: number;
  /** Sideways drift at the end, px (signed). */
  drift: number;
  /** Sway amplitude, px (signed: which way it leans first). */
  sway: number;
  /** Tilt at the end, deg. */
  tilt: number;
  delay: number;
  duration: number;
};

type Rnd = () => number;
const between = (rnd: Rnd, a: number, b: number) => a + rnd() * (b - a);

/** One reaction: mine is a burst of OWN_BURST around one spot, anyone else's is one. */
export function planBurst(emoji: string, own: boolean, rnd: Rnd = Math.random): Particle[] {
  if (!emoji) return [];
  const one = (i: number): Particle => {
    const lead = i === 0;
    return {
      emoji,
      x: 0, // set below
      bottom: between(rnd, 90, 140),
      size: Math.round(lead ? between(rnd, 50, 60) : between(rnd, 32, 40)),
      rise: Math.round(between(rnd, 300, 460)),
      drift: Math.round(between(rnd, -60, 60)),
      sway: Math.round(between(rnd, 14, 26) * (rnd() < 0.5 ? -1 : 1)),
      tilt: Math.round(between(rnd, -18, 18)),
      delay: lead ? 0 : Math.round(60 + i * 90 + rnd() * 60),
      duration: Math.round(between(rnd, 2600, 3400)),
    };
  };
  if (!own) {
    const p = one(0);
    p.x = between(rnd, 12, 80);
    return [p];
  }
  // My own: from the right side (under my thumb, near the 😀 button's column), fanning out.
  const cx = between(rnd, 58, 74);
  return Array.from({ length: OWN_BURST }, (_, i) => {
    const p = one(i);
    p.x = Math.max(4, Math.min(88, cx + (i === 0 ? 0 : (i % 2 ? -1 : 1) * between(rnd, 8, 16))));
    return p;
  });
}

export type Frame = { transform: string; opacity: number; offset?: number };

/** The keyframes for one particle (transform + opacity only). */
export function keyframesFor(p: Particle, reduced: boolean): Frame[] {
  if (reduced) {
    return [
      { transform: "none", opacity: 0, offset: 0 },
      { transform: "none", opacity: 1, offset: 0.1 },
      { transform: "none", opacity: 1, offset: 0.75 },
      { transform: "none", opacity: 0, offset: 1 },
    ];
  }
  const at = (t: number, s: number, o: number, offset: number): Frame => {
    // Rises with an ease-out feel, sways on a sine, drifts linearly to its end.
    const y = -p.rise * (1 - (1 - t) * (1 - t));
    const x = p.drift * t + p.sway * Math.sin(t * Math.PI * 2.5);
    const r = p.tilt * t;
    return { transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r.toFixed(1)}deg) scale(${s})`, opacity: o, offset };
  };
  return [
    { transform: "translate(0px, 0px) scale(0.2)", opacity: 0, offset: 0 },
    at(0.04, 1.45, 1, 0.07), // pop: overshoot
    at(0.1, 0.92, 1, 0.13),
    at(0.16, 1.08, 1, 0.19),
    at(0.25, 1, 1, 0.28),
    at(0.5, 1, 1, 0.52),
    at(0.75, 1, 1, 0.76), // still fully there ~2.3 s in
    at(1, 0.9, 0, 1),
  ];
}

/** Which particles are on screen; adding past the cap names the oldest to remove. */
export class ReactionQueue<T = number> {
  private live: T[] = [];
  constructor(readonly cap = REACTION_CAP) {}
  /** Add one; returns those that must leave now (oldest first) to stay within the cap. */
  add(id: T): T[] {
    this.live.push(id);
    return this.live.length > this.cap ? this.live.splice(0, this.live.length - this.cap) : [];
  }
  remove(id: T) {
    const i = this.live.indexOf(id);
    if (i >= 0) this.live.splice(i, 1);
  }
  get size() {
    return this.live.length;
  }
}

/** The room echoes my own reactions back to me: skip one echo per tap already shown locally. */
export class EchoFilter {
  private pending: { emoji: string; at: number }[] = [];
  constructor(readonly windowMs = ECHO_WINDOW_MS) {}
  sent(emoji: string, now: number) {
    this.prune(now);
    this.pending.push({ emoji, at: now });
  }
  /** True when this incoming reaction should be shown (false = my own echo, already shown). */
  incoming(emoji: string, now: number): boolean {
    this.prune(now);
    const i = this.pending.findIndex((p) => p.emoji === emoji);
    if (i < 0) return true;
    this.pending.splice(i, 1);
    return false;
  }
  private prune(now: number) {
    this.pending = this.pending.filter((p) => now - p.at <= this.windowMs);
  }
}
