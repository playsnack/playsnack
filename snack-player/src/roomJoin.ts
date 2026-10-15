// One `room_join` telemetry event per join attempt (docs/telemetry.md §6), and the
// same outcome in the on-device test log (?debug=1).
//   start()   — connect() / retry() is called: the clock starts
//   attempt() — the transport started broker connect try n (serverless rooms: mqttBus)
//   conn()    — the first "connected" (ok, ms) or "failed" (reason, ms) ends the attempt;
//               later states (a drop after joining, a repeated "failed") are not joins.
// Also what the connecting screen says while a join is slow (slowJoinText).
// Erasable TypeScript only (Node runs it directly in tests).
import { joinFailReason, trackJoin, type RoomKind, type RoomVia, type TelemetryEvent } from "./telemetry.ts";
import { dlog, setRoomCode } from "./debugLog.ts";

type JoinEvent = Extract<TelemetryEvent, { k: "room_join" }>;
export type JoinTracker = {
  start(kind: "connect" | "retry"): void;
  /** Broker connect try `n` began (n ≥ 1); `reason` = why the previous try ended. */
  attempt(n: number, reason?: string): void;
  conn(state: string, reason?: string): void;
  /** The screen went away: an unfinished attempt is dropped (debug log only). */
  end(): void;
};

/**
 * Still connecting after this long → the connecting UI says the connection is slow and
 * that it keeps trying (a public broker can take ~20 s: @snack/room mqttBus.js). A join
 * that gets in after this is reported with `slow: true`.
 */
export const SLOW_JOIN_MS = 6000;

/** The calm "slow, still trying" line with the elapsed seconds, or null while not slow yet. */
export function slowJoinText(elapsedMs: number): string | null {
  if (!(elapsedMs >= SLOW_JOIN_MS)) return null;
  return `연결이 느려요 · 계속 시도하는 중… ${Math.floor(elapsedMs / 1000)}초`;
}

export function joinTracker(o: {
  slug: string;
  /** The room id as the transport sees it (`slug` or `slug~CODE`). */
  room: string;
  /** The transport this join uses (RoomTransport.via): the stats keep room-server joins apart. */
  via?: RoomVia;
  now?: () => number;
  /** Defaults to telemetry's trackJoin (main's metrics helper). */
  send?: (ev: JoinEvent) => void;
}): JoinTracker {
  const now = o.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const send = o.send ?? ((ev: JoinEvent) => trackJoin(o.slug, ev.ok, { ms: ev.ms, room: ev.room, reason: ev.reason, tries: ev.tries, slow: ev.slow, via: ev.via }));
  const code = o.room.includes("~") ? o.room.slice(o.room.indexOf("~") + 1) : null;
  const room: RoomKind = code ? "friend" : "public";
  setRoomCode(code);
  let t0 = 0;
  let open = false;
  let tries = 0; // broker connect tries reported for this attempt (0 = the transport doesn't say)
  const ms = () => Math.max(0, Math.round(now() - t0));
  const event = (ok: boolean, reason?: string): JoinEvent => {
    // trackJoin adds the app (appOf: no room code, made apps → "custom").
    const ev: JoinEvent = { k: "room_join", ok, ms: ms(), room };
    // Only a listed reason code ("refused: <broker text>" → "refused"): no free text leaves.
    if (!ok) ev.reason = joinFailReason(reason);
    if (tries > 0) ev.tries = Math.min(20, tries);
    if (ok && ev.ms! >= SLOW_JOIN_MS) ev.slow = true;
    if (o.via) ev.via = o.via;
    return ev;
  };
  const detail = (ev: JoinEvent) => [ev.tries ? `${ev.tries} ${ev.tries === 1 ? "try" : "tries"}` : "", ev.slow ? "after a slow start" : ""].filter(Boolean).join(", ");
  return {
    start(kind) {
      t0 = now();
      open = true;
      tries = 0;
      dlog("join", `${kind} → room ${o.room}`);
    },
    attempt(n, reason) {
      if (!open || !(n >= 1)) return;
      tries = Math.max(tries, Math.floor(n));
      if (n > 1) dlog("join", `broker try ${n} at ${ms()} ms${reason ? ` (previous: ${reason})` : ""}`);
    },
    conn(state, reason) {
      if (!open) return;
      if (state === "connected") {
        open = false;
        const ev = event(true);
        const d = detail(ev);
        dlog("join", `joined in ${ev.ms} ms${d ? ` (${d})` : ""}`);
        send(ev);
      } else if (state === "failed") {
        open = false;
        const ev = event(false, reason || "other");
        const d = detail(ev);
        dlog("join", `failed after ${ev.ms} ms (${reason || "other"}${d ? `, ${d}` : ""})`);
        send(ev);
      }
    },
    end() {
      if (open) dlog("join", `left after ${ms()} ms, before joining`);
      open = false;
    },
  };
}
