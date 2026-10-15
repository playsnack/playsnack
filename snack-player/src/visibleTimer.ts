// Deadlines that count only the time the page is on screen (#115).
//
// A phone puts a page in the background whenever its player opens another app — the
// share sheet / KakaoTalk to invite a friend is the common one. iOS then throttles or
// freezes the page's timers and closes its WebSockets. A join / reconnect deadline that
// keeps counting meanwhile fails a room the player never left; this one pauses while the
// page is hidden and goes on when it is visible again.
//
// Also the "the page is back" signal (visibilitychange → visible, pageshow from the
// back/forward cache, online): the room transport reconnects at once on it.
// Erasable TypeScript only (Node runs it directly in tests).

/** What the timer needs from the browser (tests pass a fake). */
export type PageEnv = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** null = no document (Node): always visible, no events. */
  doc: { visibilityState: string; addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void } | null;
  win: { addEventListener(t: string, fn: (e: unknown) => void): void; removeEventListener(t: string, fn: (e: unknown) => void): void } | null;
};

export function browserEnv(): PageEnv {
  return {
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    doc: typeof document !== "undefined" && typeof document.addEventListener === "function" ? document : null,
    win: typeof window !== "undefined" && typeof window.addEventListener === "function" ? (window as unknown as PageEnv["win"]) : null,
  };
}

export const isHidden = (env: PageEnv) => env.doc?.visibilityState === "hidden";

/**
 * A timer that fires later than asked by more than this was frozen with its page (iOS
 * suspends a hidden page without always saying so first): the time it slept is not counted.
 */
export const FROZEN_SLACK_MS = 2000;

export type VisibleTimer = { cancel(): void; /** Visible time still to go (ms). */ left(): number };

/**
 * `fn` after `ms` of time with the page visible. Hidden time does not count; a timer that
 * slept through a freeze runs its slice again instead of firing on stale time.
 */
export function visibleTimeout(fn: () => void, ms: number, env: PageEnv = browserEnv()): VisibleTimer {
  let left = ms;
  let handle: unknown = null;
  let startedAt = 0;
  let done = false;
  const run = () => {
    if (done || handle != null || isHidden(env)) return;
    startedAt = env.now();
    const slice = left;
    handle = env.setTimeout(() => {
      handle = null;
      if (done) return;
      const took = env.now() - startedAt;
      if (isHidden(env) || took > slice + FROZEN_SLACK_MS) return run(); // asleep meanwhile: this slice again
      done = true;
      cleanup();
      fn();
    }, slice);
  };
  const pause = () => {
    if (handle == null) return;
    env.clearTimeout(handle);
    handle = null;
    left = Math.max(0, left - (env.now() - startedAt));
  };
  const onVis = () => (isHidden(env) ? pause() : run());
  const cleanup = () => env.doc?.removeEventListener("visibilitychange", onVis);
  env.doc?.addEventListener("visibilitychange", onVis);
  run();
  return {
    cancel() {
      done = true;
      pause();
      cleanup();
    },
    left() {
      return handle == null ? left : Math.max(0, left - (env.now() - startedAt));
    },
  };
}

export type PageBack = "visible" | "pageshow" | "online";

/**
 * Calls `fn` whenever the page comes back: visible again (with how long it was hidden),
 * restored from the back/forward cache (pageshow persisted), or the network is back
 * (online). Returns the unsubscribe.
 */
export function onPageBack(fn: (why: PageBack, hiddenMs: number) => void, env: PageEnv = browserEnv()): () => void {
  let hiddenAt: number | null = isHidden(env) ? env.now() : null;
  const vis = () => {
    if (isHidden(env)) {
      hiddenAt ??= env.now();
      return;
    }
    const ms = hiddenAt == null ? 0 : env.now() - hiddenAt;
    hiddenAt = null;
    fn("visible", ms);
  };
  const show = (e: unknown) => {
    if ((e as { persisted?: boolean } | null)?.persisted) fn("pageshow", 0);
  };
  const online = () => fn("online", 0);
  env.doc?.addEventListener("visibilitychange", vis);
  env.win?.addEventListener("pageshow", show);
  env.win?.addEventListener("online", online);
  return () => {
    env.doc?.removeEventListener("visibilitychange", vis);
    env.win?.removeEventListener("pageshow", show);
    env.win?.removeEventListener("online", online);
  };
}
