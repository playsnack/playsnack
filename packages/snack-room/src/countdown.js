// Client-side countdown (MP-03 / MP-08 "N ms 뒤 종료"): the host says when play starts
// ("countdown" {n, stepMs, endsIn}) and every device runs 3·2·1 on its own clock, so the
// numbers don't each ride a separate, jittery, droppable message. Every later message
// that implies the deadline (the host's own `sessionCountdown` k = "k steps left", a
// resync) refines the estimate: a message can only arrive late, so the EARLIEST deadline
// seen is the closest to the truth (an NTP-style minimum filter).
//
// The driver delivers `setVar sessionCountdown` to the app itself; while it runs, the
// host's values for that variable are swallowed (used as estimates). It stops at 0, or
// when the host sends a non-positive value (play started / back to the lobby).

/**
 * @param {object} o
 * @param {(t: string, d: object) => void} o.deliver   hand a room message to the app
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {(h: any) => void} [o.clearTimer]
 */
export function localCountdown({ deliver, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) }) {
  let active = false;
  let deadline = 0;
  let stepMs = 1000;
  let shown = null;
  let timer = null;
  const show = (k) => {
    if (shown === k) return;
    shown = k;
    deliver("setVar", { id: "sessionCountdown", value: k });
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    active = false;
  };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const left = deadline - now();
    const k = Math.ceil(left / stepMs);
    if (k <= 0) {
      show(0);
      stop();
      return;
    }
    show(k);
    timer = setTimer(schedule, Math.max(1, left - (k - 1) * stepMs)); // next boundary
  };
  const estimate = (endsIn) => {
    const est = now() + endsIn;
    if (!active || est < deadline) deadline = est;
    active = true;
    schedule();
  };
  return {
    get active() {
      return active;
    },
    /** The host's "countdown" message. */
    start({ endsIn, stepMs: step }) {
      if (!(Number(endsIn) >= 0)) return;
      if (!active) shown = null; // a new countdown
      if (Number(step) > 0) stepMs = Number(step);
      estimate(Number(endsIn));
    },
    /**
     * A host-sent value for sessionCountdown. Returns true when swallowed (the driver
     * shows its own numbers, or already showed this 0); false when it should be delivered.
     */
    intercept(value) {
      if (active && typeof value === "number" && value > 0) {
        estimate(value * stepMs); // sent `value` steps before the end
        return true;
      }
      const dup = value === 0 && shown === 0; // the driver reached 0 first: the host's 0 is a repeat
      stop(); // play (0) or a reset: the host decides from here
      shown = null;
      return dup;
    },
    stop,
  };
}
