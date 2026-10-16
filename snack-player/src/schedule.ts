// 시작 시간 예약 (#218, docs/bite-format.md §6.2): in a friends room the host sets when the game
// starts. The room says {t: "schedule", d: {on, endsIn, due}} — "it starts in endsIn ms" (on its
// own clock; negative / due = the time came, waiting for a second person). The shell runs it on
// THIS device's clock and hands the template three shell variables (only those it declares):
//   startAt     number — this device's epoch ms of the start (0 = nothing scheduled)
//   startIn     number — whole seconds left (0 = not counting: none, or the time came)
//   startAtText string — the start as a clock time in the device's locale ("오후 8:30", "내일 오전 9:00")
// The host picks the time in the shell's sheet (ScheduleSheet.tsx): presets or a clock time today
// (tomorrow when it already passed — at most 24 h ahead), sent as `schedule {in, start}`.
import { autoStartLeft } from "./autoStart";

/** The sheet's presets, in minutes. */
export const SCHEDULE_PRESETS_MIN = [1, 3, 5, 10] as const;
/** As the room (packages/snack-room SCHEDULE_MIN_MS / SCHEDULE_MAX_MS): sooner / later is refused. */
export const SCHEDULE_MIN_MS = 10_000;
export const SCHEDULE_MAX_MS = 24 * 60 * 60 * 1000;
/** The host's button in the lobby (a template host event — handled here, never sent to the room). */
export const SCHEDULE_OPEN_EVENT = "scheduleOpen";
/** Refusals of `schedule` / `unschedule` the sheet explains (the rest: "다시 해 주세요"). */
export const SCHEDULE_REFUSALS: Record<string, string> = {
  not_host: "방장만 시작 시간을 정할 수 있어요",
  not_subject: "퀴즈 주인공만 시작 시간을 정할 수 있어요",
  not_in_lobby: "이미 시작했어요",
  invalid_time: "지금부터 24시간 안의 시간을 골라 주세요",
};

export type ScheduleMsg = { on?: unknown; endsIn?: unknown; due?: unknown };
export type ScheduleVars = { startAt: number; startIn: number; startAtText: string };

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "오후 8:30" (the device's locale and time zone); "내일 " in front when it is not today here. */
export function clockText(at: number, now: number, locale?: string | string[]): string {
  const d = new Date(at);
  let t: string;
  try {
    t = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    t = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return sameDay(d, new Date(now)) ? t : `내일 ${t}`;
}

/** "m:ss" for whole seconds left (the template does the same with floor / pad). */
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * A clock time "HH:MM" (an <input type="time"> value) → ms from `now` until it, on this device:
 * today, or tomorrow when it already passed. null = not a time.
 */
export function msUntilClock(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  let at = d.getTime();
  if (at <= now) {
    d.setDate(d.getDate() + 1); // (a calendar day — DST-safe)
    at = d.getTime();
  }
  return at - now;
}

/** May `ms` be scheduled? (the room checks again: `min` is its SCHEDULE_MIN_MS) */
export const scheduleOk = (ms: number | null, min = SCHEDULE_MIN_MS): ms is number => ms != null && Number.isFinite(ms) && ms >= min && ms <= SCHEDULE_MAX_MS;

/** The vars for one room message at device time `now` (the message's endsIn was measured "now"). */
export function scheduleVars(d: ScheduleMsg, now: number, locale?: string | string[]): ScheduleVars {
  const endsIn = Number(d?.endsIn);
  if (d?.on !== true || !Number.isFinite(endsIn)) return { startAt: 0, startIn: 0, startAtText: "" };
  const at = now + endsIn;
  return { startAt: at, startIn: d.due === true ? 0 : autoStartLeft(at, now), startAtText: clockText(at, now, locale) };
}

/**
 * Feeds `set(vars)` from the room's schedule messages until stopped — startIn ticks down on this
 * device's clock (every 250 ms, only while counting). `env` is injectable for tests.
 */
export function scheduleTicker(
  set: (v: Partial<ScheduleVars>) => void,
  env: { now: () => number; every: (fn: () => void, ms: number) => unknown; stop: (h: unknown) => void; locale?: string | string[] } = {
    now: () => Date.now(),
    every: (fn, ms) => setInterval(fn, ms),
    stop: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  },
) {
  let handle: unknown = null;
  let last: ScheduleVars = { startAt: 0, startIn: 0, startAtText: "" };
  const put = (v: ScheduleVars) => {
    const diff: Partial<ScheduleVars> = {};
    if (v.startAt !== last.startAt) diff.startAt = v.startAt;
    if (v.startIn !== last.startIn) diff.startIn = v.startIn;
    if (v.startAtText !== last.startAtText) diff.startAtText = v.startAtText;
    last = v;
    if (Object.keys(diff).length) set(diff);
  };
  const stop = () => {
    if (handle != null) env.stop(handle);
    handle = null;
  };
  return {
    /** A room message. */
    message(d: ScheduleMsg) {
      stop();
      const now = env.now();
      let v = scheduleVars(d, now, env.locale);
      // the same schedule again (a rejoin): its start moves by the network's ms at most — keep it steady
      if (v.startAt && last.startAt && Math.abs(v.startAt - last.startAt) < 1500) {
        v = { startAt: last.startAt, startIn: d.due === true ? 0 : autoStartLeft(last.startAt, now), startAtText: last.startAtText };
      }
      put(v);
      if (v.startIn <= 0) return;
      const at = v.startAt;
      handle = env.every(() => {
        const n = autoStartLeft(at, env.now());
        put({ ...last, startIn: n });
        if (n <= 0) stop();
      }, 250);
    },
    /** The game started (or the room went away): nothing scheduled. */
    clear() {
      stop();
      put({ startAt: 0, startIn: 0, startAtText: "" });
    },
    /** What the template has now (for a sheet opened mid-countdown). */
    get vars() {
      return last;
    },
    stop,
  };
}
