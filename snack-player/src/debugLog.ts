// On-device test log (?debug=1). Off by default and then costs one boolean check
// per call. When on, it records into a ring buffer in memory only — nothing leaves
// the device unless the person copies it from the 🪲 panel (DebugLog.tsx).
// Room codes are cut to their first 3 symbols; nicknames, payloads and ids are
// never logged by the callers (action names only, message-id suffixes only).
// Erasable TypeScript only (Node runs it directly in tests).

export type DebugEntry = { t: number; wall: number; cat: string; msg: string };

/** Fixed-size buffer: keeps the newest `max` items. */
export class Ring<T> {
  private buf: T[] = [];
  private start = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }
  push(x: T): void {
    if (this.buf.length < this.max) this.buf.push(x);
    else {
      this.buf[this.start] = x;
      this.start = (this.start + 1) % this.max;
    }
  }
  items(): T[] {
    return this.buf.slice(this.start).concat(this.buf.slice(0, this.start));
  }
  clear(): void {
    this.buf = [];
    this.start = 0;
  }
  get size(): number {
    return this.buf.length;
  }
}

export const MAX_LINES = 500;
const MAX_MSG = 500;
const STORAGE_KEY = "snack.debug";

let on = false;
let ring = new Ring<DebugEntry>(MAX_LINES);
let roomCode: string | null = null;
const listeners = new Set<() => void>();
let lastPhase: unknown;
let lastPeople: unknown;
let mono: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function debugEnabled(): boolean {
  return on;
}

/** Room codes → first 3 symbols + "…" (`room=K7MNP2QRS4` → `room=K7M…`, `slug~K7MNP2QRS4` → `slug~K7M…`). */
export function redact(text: string): string {
  let s = String(text);
  if (roomCode && roomCode.length > 3) s = s.split(roomCode).join(`${roomCode.slice(0, 3)}…`);
  s = s.replace(/([?&#]room=|\broom=)([A-Za-z0-9]{3})[A-Za-z0-9-]+/gi, "$1$2…");
  s = s.replace(/~([A-Za-z0-9]{3})[A-Za-z0-9]{3,}/g, "~$1…");
  // A link-carried app (?d= / #d=) is long and says nothing about the bug.
  s = s.replace(/([?&#]d=)[A-Za-z0-9_-]{16,}/g, (_m, p: string) => `${p}<${_m.length - p.length} chars>`);
  return s;
}

/** Remember this room's code so it is cut anywhere it appears (e.g. inside an error message). */
export function setRoomCode(code: string | null): void {
  roomCode = code ? code.toUpperCase() : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** `+12.345s 14:03:22.120 [conn] connected` — ms since page load, then the wall clock. */
export function formatEntry(e: DebugEntry): string {
  const d = new Date(e.wall);
  const wall = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `+${(e.t / 1000).toFixed(3)}s ${wall} [${e.cat}] ${e.msg}`;
}

/** Record one line (no-op unless ?debug=1 turned the log on). */
export function dlog(cat: string, msg: string): void {
  if (!on) return;
  const text = redact(msg);
  ring.push({ t: mono(), wall: Date.now(), cat, msg: text.length > MAX_MSG ? `${text.slice(0, MAX_MSG)}…` : text });
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not break logging */
    }
  }
}

export function entries(): DebugEntry[] {
  return ring.items();
}

export function clearLog(): void {
  ring.clear();
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The whole log as text (what "로그 복사" copies). */
export function logText(): string {
  const items = ring.items();
  return [`snack test log · ${items.length} lines · copied ${new Date().toISOString()}`, ...items.map(formatEntry)].join("\n");
}

/** Known in-app browsers (their WebViews behave differently from Safari/Chrome). */
export function inAppBrowser(ua: string): string | null {
  const rules: [RegExp, string][] = [
    [/KAKAOTALK/i, "KakaoTalk"],
    [/NAVER\(inapp|NAVER\//, "Naver"],
    [/Instagram/i, "Instagram"],
    [/FBAN|FBAV|FB_IAB|FBIOS/, "Facebook"],
    [/\bLine\//, "LINE"],
    [/DaumApps/i, "Daum"],
    [/everytimeApp/i, "Everytime"],
    [/BAND\//, "Band"],
    [/musical_ly|BytedanceWebview|TikTok/i, "TikTok"],
    [/Twitter/i, "Twitter"],
    [/Snapchat/i, "Snapchat"],
    [/DiscordBot|Discord\//i, "Discord"],
    [/; wv\)/, "Android WebView"],
  ];
  for (const [re, name] of rules) if (re.test(ua)) return name;
  return null;
}

/** Path + query with room codes cut and link-carried apps shortened. */
export function describeLocation(loc: { pathname: string; search: string; hash: string }): string {
  return redact(`${loc.pathname}${loc.search}${loc.hash}`);
}

/** Session phase (sessionPhase var) and head-count changes seen in room messages; logs changes only. */
export function noteRoomMessage(m: { t: string; d: Record<string, unknown> }): void {
  if (!on) return;
  let phase: unknown;
  let people: unknown;
  if (m.t === "state") {
    phase = (m.d.sharedState as Record<string, unknown> | undefined)?.sessionPhase;
    people = m.d.participants;
  } else if (m.t === "setVar" && m.d.id === "sessionPhase") phase = m.d.value;
  else if (m.t === "participants") people = m.d.count;
  if (phase !== undefined && phase !== lastPhase) {
    lastPhase = phase;
    dlog("phase", String(phase));
  }
  if (typeof people === "number" && people !== lastPeople) {
    lastPeople = people;
    dlog("room", `${people} in the room`);
  }
}

function argText(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack.split("\n").slice(1, 4).join("\n")}` : ""}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

type Env = {
  location: { pathname: string; search: string; hash: string };
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | null;
};

/**
 * Decide once per page: `?debug=1` turns the log on (remembered in sessionStorage for
 * this tab), `?debug=0` turns it off, otherwise the tab's remembered choice.
 */
export function decideDebug({ location, storage }: Env): boolean {
  const q = new URLSearchParams(location.search).get("debug");
  try {
    if (q === "1") storage?.setItem(STORAGE_KEY, "1");
    else if (q === "0") storage?.removeItem(STORAGE_KEY);
    return q === "1" || (q !== "0" && storage?.getItem(STORAGE_KEY) === "1");
  } catch {
    return q === "1"; // storage blocked: only this page view
  }
}

/** For tests: turn on/off and reset the buffer without a browser. */
export function _resetForTest(o: { on: boolean; max?: number; now?: () => number }): void {
  on = o.on;
  ring = new Ring<DebugEntry>(o.max ?? MAX_LINES);
  roomCode = null;
  lastPhase = undefined;
  lastPeople = undefined;
  if (o.now) mono = o.now;
}

/**
 * Browser entry (main.tsx): when ?debug=1, start recording — environment first, then
 * errors (window.error, unhandledrejection, console.error/warn), route, visibility,
 * network and size changes. Returns whether the log is on.
 */
export function initDebug(build: string): boolean {
  let storage: Env["storage"] = null;
  try {
    storage = sessionStorage;
  } catch {
    /* blocked */
  }
  const enabled = decideDebug({ location, storage });
  // Take ?debug= out of the address (remembered for the tab instead), so an invite
  // link made from this page never turns the log on for a friend.
  const url = new URL(location.href);
  if (url.searchParams.has("debug")) {
    url.searchParams.delete("debug");
    try {
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* keep the address as it is */
    }
  }
  if (!enabled) return false;
  on = true;
  const nav = navigator;
  dlog("env", `build ${build}`);
  dlog("env", `ua ${nav.userAgent}`);
  dlog("env", `in-app browser: ${inAppBrowser(nav.userAgent) ?? "none"}`);
  const size = () => `viewport ${innerWidth}×${innerHeight} dpr ${devicePixelRatio}${visualViewport ? ` visual ${Math.round(visualViewport.width)}×${Math.round(visualViewport.height)}` : ""}`;
  dlog("env", size());
  dlog("env", `online ${nav.onLine} · lang ${nav.language}`);
  dlog("route", describeLocation(location));

  addEventListener("error", (e: ErrorEvent) => {
    const where = e.filename ? ` @ ${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : "";
    dlog("error", `${e.error ? argText(e.error) : e.message}${where}`);
  });
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => dlog("error", `unhandledrejection: ${argText(e.reason)}`));
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    let inside = false;
    console[level] = (...args: unknown[]) => {
      if (!inside) {
        inside = true;
        try {
          dlog(`console.${level}`, args.map(argText).join(" "));
        } finally {
          inside = false;
        }
      }
      orig(...args);
    };
  }
  addEventListener("popstate", () => dlog("route", describeLocation(location)));
  document.addEventListener("visibilitychange", () => dlog("page", document.visibilityState));
  addEventListener("online", () => dlog("page", "online"));
  addEventListener("offline", () => dlog("page", "offline"));
  let resize: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => {
    clearTimeout(resize);
    resize = setTimeout(() => dlog("env", size()), 400);
  });
  return true;
}
