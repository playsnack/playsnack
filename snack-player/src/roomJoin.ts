// One `room_join` telemetry event per join attempt (docs/telemetry.md §6), and the
// same outcome in the on-device test log (?debug=1).
//   start()  — connect() / retry() is called: the clock starts
//   conn()   — the first "connected" (ok, ms) or "failed" (reason, ms) ends the attempt;
//              later states (a drop after joining, a repeated "failed") are not joins.
// Erasable TypeScript only (Node runs it directly in tests).
import { joinFailReason, trackJoin, type RoomKind, type TelemetryEvent } from "./telemetry.ts";
import { dlog, setRoomCode } from "./debugLog.ts";

type JoinEvent = Extract<TelemetryEvent, { k: "room_join" }>;
export type JoinTracker = {
  start(kind: "connect" | "retry"): void;
  conn(state: string, reason?: string): void;
  /** The screen went away: an unfinished attempt is dropped (debug log only). */
  end(): void;
};

export function joinTracker(o: {
  slug: string;
  /** The room id as the transport sees it (`slug` or `slug~CODE`). */
  room: string;
  now?: () => number;
  /** Defaults to telemetry's trackJoin (main's metrics helper). */
  send?: (ev: JoinEvent) => void;
}): JoinTracker {
  const now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const send = o.send ?? ((ev: JoinEvent) => trackJoin(o.slug, ev.ok, { ms: ev.ms, room: ev.room, reason: ev.reason }));
  const code = o.room.includes("~") ? o.room.slice(o.room.indexOf("~") + 1) : null;
  const room: RoomKind = code ? "friend" : "public";
  setRoomCode(code);
  let t0 = 0;
  let open = false;
  const ms = () => Math.max(0, Math.round(now() - t0));
  const event = (ok: boolean, reason?: string): JoinEvent => {
    // trackJoin adds the app (appOf: no room code, made apps → "custom").
    const ev: JoinEvent = { k: "room_join", ok, ms: ms(), room };
    // Only a listed reason code ("refused: <broker text>" → "refused"): no free text leaves.
    if (!ok) ev.reason = joinFailReason(reason);
    return ev;
  };
  return {
    start(kind) {
      t0 = now();
      open = true;
      dlog("join", `${kind} → room ${o.room}`);
    },
    conn(state, reason) {
      if (!open) return;
      if (state === "connected") {
        open = false;
        const ev = event(true);
        dlog("join", `joined in ${ev.ms} ms`);
        send(ev);
      } else if (state === "failed") {
        open = false;
        const ev = event(false, reason || "other");
        dlog("join", `failed after ${ev.ms} ms (${reason || "other"})`);
        send(ev);
      }
    },
    end() {
      if (open) dlog("join", `left after ${ms()} ms, before joining`);
      open = false;
    },
  };
}
