// 공개 방 자동 시작 (#136, docs/bite-format.md §6.2): the room says {t: "autoStart", d: {endsIn, ms}}
// — "the game starts by itself in endsIn ms" (−1 = no countdown). The shell runs it on this
// device's clock and hands the template whole seconds left in its `autoStartIn` variable
// ("10초 뒤 시작 · n명"); 0 = no countdown running.

/** Whole seconds left until `at` (both on the same clock), never below 0. */
export const autoStartLeft = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

/**
 * Feeds `set(seconds)` from the room's autoStart messages until stopped. `clock` / timers are
 * injectable for tests.
 */
export function autoStartTicker(
  set: (seconds: number) => void,
  env: { now: () => number; every: (fn: () => void, ms: number) => unknown; stop: (h: unknown) => void } = {
    now: () => performance.now(),
    every: (fn, ms) => setInterval(fn, ms),
    stop: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  },
) {
  let handle: unknown = null;
  let last = -1;
  const put = (n: number) => {
    if (n !== last) set((last = n));
  };
  const stop = () => {
    if (handle != null) env.stop(handle);
    handle = null;
  };
  return {
    /** A room message: endsIn ms from now (negative / missing = none). */
    message(endsIn: unknown) {
      stop();
      const ms = Number(endsIn);
      if (!Number.isFinite(ms) || ms < 0) return put(0);
      const at = env.now() + ms;
      const tick = () => {
        const n = autoStartLeft(at, env.now());
        put(n);
        if (n <= 0) stop();
      };
      tick();
      if (handle == null && last > 0) handle = env.every(tick, 250);
    },
    /** The game started (or the room went away): no countdown. */
    clear() {
      stop();
      put(0);
    },
    stop,
  };
}
