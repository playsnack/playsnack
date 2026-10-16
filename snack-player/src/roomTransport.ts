// How a live app talks to its room. The player only sees this interface, so the
// room can run on the server (today) or on a host player's device behind a thin
// relay (host mode) without touching LiveApp or the app documents.
//
// Wire messages are the room engine's (@snack/room): inbound "state", "setVar",
// "participants", "reaction", "actionAck"; outbound actions and reactions.

import { debugEnabled, dlog, noteRoomMessage } from "./debugLog";
import { engineMetrics, type RoomVia } from "./telemetry";
import { engineResults } from "./roomResult";
import type { Bus } from "@snack/room/mesh-client";
import { browserEnv, isHidden, onPageBack, visibleTimeout, type PageBack, type PageEnv, type VisibleTimer } from "./visibleTimer";
import { roomKindOf } from "./links";
import { passes, PIN_REASONS } from "./roomAdmission";

export type RoomMessage = { t: string; d: Record<string, unknown> };

/**
 * Connection status, delivered through onMessage as `{ t: "conn", d: ConnStatus }`
 * whenever it changes ("connecting" first, then "connected" or "failed").
 * "reconnecting": was in the room, the connection dropped (the page went to the background
 * for the share sheet, a network blip) and the transport is getting back in on its own —
 * the screen stays as it is (#115); "failed" only if that does not work within the budget.
 * The screen shows connecting / failed (with retry and "혼자 하기") from this.
 */
export type ConnState = "connecting" | "connected" | "reconnecting" | "failed";
/**
 * A refusal's details (edge rooms, docs/room-admission.md §4): `left` = wrong PINs before this
 * address is locked; `retryIn` = ms until a locked PIN / a rate limit lets it try again.
 */
export type ConnDetail = { left?: number; retryIn?: number };
export type ConnStatus = { state: ConnState; reason?: string } & ConnDetail;

export interface RoomTransport {
  /** Where the room runs: 'edge' room server, player-hosted 'mesh', or snack-'server' (room_join telemetry). */
  readonly via: RoomVia;
  /** Open the connection and join the room. */
  connect(): void;
  close(): void;
  sendAction(name: string, payload?: unknown): void;
  sendReaction(emoji: string): void;
  onMessage(fn: (m: RoomMessage) => void): void;
  /** After "failed": try again (emits "connecting" → "connected" | "failed"). */
  retry?(): void;
  /** Edge PIN rooms: try again with this PIN (after a refusal, or the first one typed). */
  enterPin?(pin: string): void;
}

export type Identity = { slug: string; anonId: string; nick: string };

/**
 * No room state this long after connecting → "failed" (the screen offers retry).
 * Covers a slow public broker: mqttBus keeps trying for its JOIN_BUDGET_MS (42 s, ≈ 4 connect
 * tries), then mesh discovery (≤ 1.5 s) and the room state. The screen says "slow, still
 * trying" from SLOW_JOIN_MS (roomJoin.ts) on.
 */
export const CONNECT_TIMEOUT_MS = 45000;

/**
 * Pause before each reconnect try after a dropped socket (the first one is immediate). The
 * whole reconnect has the same visible-time budget as a join (CONNECT_TIMEOUT_MS).
 */
export const RECONNECT_BACKOFF_MS = [0, 500, 1000, 2000, 4000, 5000];
/**
 * Back on screen after at least this long in the background: the socket is replaced even if
 * it still looks open — iOS may have frozen it without a close (the seat token keeps the seat).
 */
export const STALE_AFTER_HIDDEN_MS = 3000;
/**
 * Close codes the room uses for "do not come back" (edge/room game.js / worker.js: bad hello or
 * Origin 4000, seat replaced 4009, full / limits 4029, PIN refusals 4003, a link the server did
 * not make or that ran out 4004). The `denied` frame before the close names the reason.
 */
const FINAL_CLOSE = new Set([4000, 4001, 4003, 4004, 4009, 4029]);

/**
 * Shared plumbing: listeners and the connection status every transport reports
 * ("connecting" → "connected" once the room state arrives | "failed").
 */
abstract class BaseTransport implements RoomTransport {
  abstract readonly via: RoomVia;
  private listeners = new Set<(m: RoomMessage) => void>();
  private state: ConnState | null = null;
  private timer: VisibleTimer | null = null;
  /** Bumped on every connect/close, so callbacks of an abandoned attempt are ignored. */
  protected gen = 0;
  /** "connecting" this long without the room state → failed "timeout". */
  protected connectTimeoutMs = CONNECT_TIMEOUT_MS;
  /** Clock, timers and page visibility (tests pass a fake: visibleTimer.ts PageEnv). */
  env: PageEnv = browserEnv();

  abstract connect(): void;
  abstract close(): void;
  abstract sendAction(name: string, payload?: unknown): void;
  abstract sendReaction(emoji: string): void;

  /** The current connection state (null before connect()). */
  get connState(): ConnState | null {
    return this.state;
  }

  onMessage(fn: (m: RoomMessage) => void) {
    this.listeners.add(fn);
  }

  /** Start over after "failed" (or a stalled "connecting"). */
  retry() {
    this.close();
    this.connect();
  }

  protected emit(m: RoomMessage) {
    for (const fn of this.listeners) fn(m);
  }

  /** Room messages pass through here: the first "state" means we are in. */
  protected receive(m: RoomMessage) {
    if (m.t === "state") this.setConn("connected");
    noteRoomMessage(m); // ?debug=1 test log: phase / participant changes
    this.emit(m);
  }

  protected setConn(state: ConnState, reason?: string, detail: ConnDetail = {}) {
    if (this.state === state) return;
    this.state = state;
    dlog("conn", reason ? `${state} (${reason})` : state);
    this.timer?.cancel();
    this.timer = null;
    // The deadline counts only time on screen (#115): a page in the background (the share
    // sheet, another app) is not failing to join.
    if (state === "connecting" || state === "reconnecting") {
      const gen = this.gen;
      this.timer = visibleTimeout(() => {
        if (gen === this.gen && this.state === state) this.fail(state === "connecting" ? this.timeoutReason() : "disconnected");
      }, this.connectTimeoutMs, this.env);
    }
    const d: ConnStatus = reason ? { state, reason } : { state };
    if (typeof detail.left === "number") d.left = detail.left;
    if (typeof detail.retryIn === "number") d.retryIn = detail.retryIn;
    this.emit({ t: "conn", d });
  }

  /** Why a join that ran out of time failed. */
  protected timeoutReason() {
    return "timeout";
  }

  /** Give up on this attempt: report "failed" and stop its connection. */
  protected fail(reason: string, detail?: ConnDetail) {
    this.setConn("failed", reason, detail);
    this.stop();
  }

  /** Tear down the live connection without reporting anything. */
  protected abstract stop(): void;

  protected stopTimer() {
    this.timer?.cancel();
    this.timer = null;
    this.state = null;
  }
}

/**
 * The room runs on snack-server (or an edge room); one WebSocket per player. A socket that
 * drops is replaced on its own (#115) — at once, then with RECONNECT_BACKOFF_MS pauses — and
 * at once when the page comes back from the background; "failed" only when that has not
 * worked within the visible-time budget. The room takes the same device back by its anonId
 * (edge rooms: and the seat token), so the player keeps their seat.
 */
export class ServerTransport extends BaseTransport {
  readonly via: RoomVia = "server";
  private ws: WebSocket | null = null;
  /** Reconnect tries since the room state last arrived (picks the backoff pause). */
  private tries = 0;
  /** A socket of this join opened (else a timeout means the room server was unreachable). */
  private opened = false;
  private retryTimer: unknown = null;
  private offBack: (() => void) | null = null;
  private offLeave: (() => void) | null = null;
  /**
   * Leave signals (#213, edge rooms only): `away` when the page goes to the background with the
   * socket open, `here` when it is back on that same socket, `bye` when the page goes away for good
   * (pagehide: tab closed, ← 홈, a reload) or the room is closed — so everyone's count goes down at
   * once instead of when (if ever) a frozen phone's socket closes. One frame per event, nothing periodic.
   */
  protected leaveSignals = false;
  private awaySent = false;

  constructor(protected url: string, protected me: Identity) {
    super();
  }

  /** A new socket for this join now (the edge room moved us to another room, #136). */
  protected reopen() {
    this.tries = 0;
    this.open(this.gen);
  }

  /** What the first frame carries (the edge room adds its tokens). */
  protected helloData(): Record<string, unknown> {
    return this.me;
  }

  /** A transport-level frame (not a room message)? Handle it and return true. */
  protected control(_m: RoomMessage): boolean {
    return false;
  }

  /** The address of each new socket (the edge room adds a PIN room's pass / PIN). */
  protected socketUrl(): string {
    return this.url;
  }

  /** Why the room closed us on purpose (a final close code without a `denied` frame before it). */
  protected finalReason(code: number, reason: string): string {
    if (code === 4009) return "replaced";
    if (code === 4004) return "expired";
    if (code === 4003) return reason === "pin" || reason === "locked" || reason === "closed" ? reason : "pin-required";
    if (code === 4029 && reason === "slow") return "slow";
    return this.connState === "connected" ? "disconnected" : "unreachable";
  }

  connect() {
    const gen = ++this.gen;
    this.tries = 0;
    this.opened = false;
    this.setConn("connecting");
    this.offBack?.();
    this.offBack = onPageBack((why, hiddenMs) => this.back(gen, why, hiddenMs), this.env);
    this.offLeave?.();
    this.offLeave = this.leaveSignals ? this.watchLeave(gen) : null;
    this.open(gen);
  }

  protected timeoutReason() {
    return this.opened ? "timeout" : "unreachable";
  }

  /** A new socket for this join (any old one is dropped quietly). */
  private open(gen: number) {
    this.clearRetry();
    this.stop();
    const ws = new WebSocket(this.socketUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.opened = true;
      ws.send(JSON.stringify({ t: "hello", d: this.helloData() }));
    };
    ws.onmessage = (ev) => {
      let m: RoomMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (gen !== this.gen || this.ws !== ws || this.control(m)) return;
      if (m.t === "state") this.tries = 0;
      this.receive(m);
      // In while already in the background (a join that finished behind the share sheet): away now.
      if (m.t === "state" && this.leaveSignals && isHidden(this.env) && !this.awaySent) {
        this.send({ t: "away", d: {} });
        this.awaySent = true;
      }
    };
    ws.onclose = (ev) => {
      if (gen !== this.gen || this.ws !== ws) return;
      this.ws = null;
      // The room closed us on purpose — this seat was taken over by another tab of this
      // device, the room is full, a bad hello: coming back would not help (or would fight).
      if (FINAL_CLOSE.has(ev?.code)) return this.fail(this.finalReason(ev.code, typeof ev.reason === "string" ? ev.reason : ""));
      this.lost(gen);
    };
  }

  /** The socket dropped (or the room turned it away for now): get back in, quietly. */
  protected lost(gen = this.gen) {
    if (gen !== this.gen || this.connState === "failed" || this.connState === null) return;
    this.stop();
    if (this.connState === "connected") this.setConn("reconnecting");
    // In the background: nothing to do until the page is back (back() then reconnects at once).
    if (isHidden(this.env)) return dlog("conn", "dropped in the background → reconnect when back");
    const pause = RECONNECT_BACKOFF_MS[Math.min(this.tries, RECONNECT_BACKOFF_MS.length - 1)];
    this.tries += 1;
    dlog("conn", `dropped → reconnect try ${this.tries}${pause ? ` in ${pause} ms` : ""}`);
    this.clearRetry();
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.gen && this.connState !== "failed" && !isHidden(this.env)) this.open(gen); // hidden: back() does it
    }, pause);
  }

  /** The page is back (visible, from the back/forward cache, online): reconnect now if needed. */
  private back(gen: number, why: PageBack, hiddenMs: number) {
    const st = this.connState;
    if (gen !== this.gen || st === "failed" || st === null) return;
    const ws = this.ws;
    const live = ws != null && ws.readyState <= 1; // CONNECTING or OPEN
    // A socket that slept through a long background (or a network change) may be dead
    // without having said so: replace it. The room gives the same device its seat back.
    const stale = why !== "visible" || hiddenMs >= STALE_AFTER_HIDDEN_MS;
    if (live && !stale) {
      if (this.awaySent) this.send({ t: "here", d: {} }); // the same socket: still here
      this.awaySent = false;
      return;
    }
    this.awaySent = false; // a new socket's hello says it
    dlog("conn", `page back (${why}${hiddenMs ? `, hidden ${Math.round(hiddenMs / 100) / 10} s` : ""}) → reconnect now`);
    this.tries = 0;
    if (st === "connected") this.setConn("reconnecting");
    this.open(gen);
  }

  private clearRetry() {
    if (this.retryTimer != null) this.env.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  protected stop() {
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  close() {
    this.gen++;
    this.offBack?.();
    this.offBack = null;
    this.offLeave?.();
    this.offLeave = null;
    this.bye();
    this.stopTimer();
    this.stop();
  }

  sendAction(name: string, payload?: unknown) {
    const id = crypto.randomUUID();
    dlog("action", `${name} #${id.slice(-6)}`);
    this.send({ t: "action", d: { name, payload, clientMsgId: id } });
  }

  sendReaction(emoji: string) {
    this.send({ t: "react", d: { emoji } });
  }

  /** The page hides → `away`; the page goes away (pagehide) → `bye` and the socket closes. → unsubscribe. */
  private watchLeave(gen: number): () => void {
    const { doc, win } = this.env;
    const vis = () => {
      if (gen !== this.gen || !isHidden(this.env) || this.awaySent) return;
      if (this.ws?.readyState === 1 && this.connState === "connected") {
        this.send({ t: "away", d: {} });
        this.awaySent = true;
      }
    };
    // Also on a page kept in the back/forward cache: it is not in the room meanwhile (pageshow
    // brings it back — back() opens a new socket).
    const hide = () => {
      if (gen !== this.gen) return;
      this.bye();
      this.stop();
    };
    doc?.addEventListener("visibilitychange", vis);
    win?.addEventListener("pagehide", hide);
    return () => {
      doc?.removeEventListener("visibilitychange", vis);
      win?.removeEventListener("pagehide", hide);
    };
  }

  /** Leaving for good: the room lets everyone know at once (edge rooms). */
  private bye() {
    if (this.leaveSignals && this.ws?.readyState === 1) this.send({ t: "bye", d: {} });
    this.awaySent = false;
  }

  private send(m: { t: string; d: unknown }) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }
}

/**
 * Edge room (VITE_ROOM_URL, docs/edge-rooms.md): the room engine runs in a Cloudflare
 * Durable Object — server-authoritative, the snack-server /ws protocol. Adds the seat token
 * (a reload / reconnect takes this device's seat back) and the organizer token.
 */
export class EdgeRoomTransport extends ServerTransport {
  override readonly via: RoomVia = "edge";
  protected override leaveSignals = true;
  /** The room this transport is in now: the link's, or the next one a public room moved us to (#136). */
  roomId: string;
  /** Moved here from this room (a refused new room sends us back to watch there). */
  private movedFrom: string | null = null;
  private stay = false;
  /** Moved, and the new room's state not here yet (a refusal now is that room's). */
  private moving = false;
  /** Left this room alone to go back to the link's room (#141): refused there → back here. */
  private leftAlone: string | null = null;
  /** What this room shows now: people here, its session phase — "alone in a moved room?" (#141). */
  private here = 0;
  private phase = "lobby";
  private loneTimer: VisibleTimer | null = null;

  /**
   * The PIN typed for a PIN room (#157): rides in the socket URL (`?pin=`, the Worker checks and
   * strips it — never in the hello), and is wiped once the room's first state arrives: by then the
   * room has sent this device its pass, which every later socket uses instead.
   */
  private pin: string | null;

  /**
   * The organizer (방장, #135) is whoever made the room: the room server's /mint ticket kept by
   * rememberOrganizerTicket() rides in the hello as `organizerToken` (no more `organize: true`).
   * `opts.autoStart`: the app's start payload (its template's `room`) — a public room starts by
   * itself with it, and may move a late arrival to the next room (`moveTo`, #136).
   * `opts.pin`: the PIN typed for a PIN room (see `pin`).
   */
  constructor(private roomUrl: string, me: Identity, private opts: EdgeRoomOptions = {}) {
    super(edgeRoomUrl(roomUrl, me.slug), me);
    this.roomId = me.slug;
    this.pin = opts.pin ?? null;
  }

  /** Whether a PIN is held (tests: it is gone after the first state). */
  get holdsPin(): boolean {
    return this.pin !== null;
  }

  /** A PIN typed (first, or after a refusal — wrong / locked / needed): try (again) with it. */
  enterPin(pin: string) {
    this.pin = pin;
    this.retry();
  }

  /**
   * A PIN room (20-symbol code): `?k=` this device's pass (else its seat token) — the Worker lets
   * it in without the PIN — or `?pin=` the PIN just typed. Other rooms: the plain room URL.
   */
  protected socketUrl() {
    const code = this.roomId.includes("~") ? this.roomId.slice(this.roomId.indexOf("~") + 1) : "";
    if (roomKindOf(code) !== "pin" || !code) return this.url;
    const q = new URLSearchParams();
    // A typed PIN goes alone: the Worker checks `k` first, and a seat token the room no longer
    // takes (another incarnation) would shadow a right PIN.
    const k = this.pin ? null : (passes.get(this.roomId)?.token ?? sessionTokens.get(this.roomId));
    if (k) q.set("k", k);
    if (this.pin) q.set("pin", this.pin);
    const qs = q.toString();
    return qs ? `${this.url}?${qs}` : this.url;
  }

  protected helloData() {
    const room = this.roomId;
    const token = sessionTokens.get(room);
    const organizerToken = sessionTokens.get(`org:${room}`);
    const { autoStart } = this.opts;
    return {
      ...this.me,
      slug: room,
      ...(token ? { token } : {}),
      ...(organizerToken ? { organizerToken } : {}),
      ...(autoStart ? { autoStart } : {}),
      ...(this.stay ? { stay: true } : {}),
    };
  }

  /** Into another room of this app, quietly: the screen keeps showing the lobby it had. */
  private moveTo(room: string, stay = false) {
    dlog("conn", `room → ${room}${stay ? " (stay)" : ""}`);
    this.clearLone();
    this.roomId = room;
    this.stay = stay;
    this.moving = true;
    this.url = edgeRoomUrl(this.roomUrl, room);
    this.emit({ t: "moved", d: { room } });
    this.reopen();
  }

  protected control(m: RoomMessage) {
    const token = typeof m.d?.token === "string" ? m.d.token : "";
    if (m.t === "token") sessionTokens.set(this.roomId, token);
    else if (m.t === "organizer") sessionTokens.set(`org:${this.roomId}`, token);
    // A PIN room let us in on the PIN: this device's pass (12 h) — no PIN on a reload / later visit.
    else if (m.t === "pass") {
      const exp = Number(m.d?.exp);
      if (token && Number.isFinite(exp)) passes.set(this.roomId, { token, exp });
    }
    // To the organizer of a PIN room: wrong PINs keep coming / the room closed to new PINs.
    else if (m.t === "pinClosed" || m.t === "alert") this.emit({ t: m.t, d: m.d ?? {} });
    else if (m.t === "moveTo") {
      // A public room whose game is under way: its next room plays soon (the same one for every
      // late arrival). Only a next room of this same app is followed.
      const room = typeof m.d?.room === "string" ? m.d.room : "";
      if (!isNextRoom(this.roomId, room)) return this.fail("moved"), true;
      this.movedFrom ??= this.roomId;
      this.leftAlone = null;
      this.moveTo(room);
    } else if (m.t === "denied") {
      const reason = String(m.d?.reason ?? "denied");
      const detail: ConnDetail = {};
      if (typeof m.d?.left === "number") detail.left = m.d.left;
      if (typeof m.d?.retryIn === "number") detail.retryIn = m.d.retryIn;
      // A PIN refusal (wrong, locked, needed): the PIN screen asks again — a typed PIN is not
      // retried on its own (no reconnect loop), and a pass that did not hold is dropped.
      if (PIN_REASONS.has(reason)) {
        this.pin = null;
        if (reason === "pin-required") passes.forget(this.roomId);
        this.fail(reason, detail);
        return true;
      }
      const alone = this.moving ? this.leftAlone : null;
      // Our own seat still held by the old socket the room has not seen close yet (a long
      // background, an expired seat token): it lets go soon — keep trying within the budget.
      if (reason === "seat_taken" && this.connState === "reconnecting") this.lost();
      // The link's room could not take us back (#141): wait in the room we came from again.
      else if (alone) {
        this.leftAlone = null;
        this.movedFrom = this.roomId;
        this.moveTo(alone);
      }
      // The next room could not open (today's free-tier guard): watch the game where we were.
      else if (this.movedFrom && !this.stay && this.moving) this.moveTo(this.movedFrom, true);
      else this.fail(reason, detail);
    }
    else return false;
    return true;
  }

  protected receive(m: RoomMessage) {
    super.receive(m);
    if (m.t === "state") {
      this.pin = null; // in: the pass came with the hello's answer; the PIN is not kept
      this.moving = false;
      this.leftAlone = null;
      this.here = Number(m.d?.participants) || 0;
      const sh = m.d?.sharedState as Record<string, unknown> | undefined;
      this.phase = typeof sh?.sessionPhase === "string" ? sh.sessionPhase : "lobby";
    } else if (m.t === "participants") this.here = Number(m.d?.count) || 0;
    else if (m.t === "setVar" && m.d?.id === "sessionPhase") this.phase = String(m.d.value);
    else return;
    this.watchAlone();
  }

  /**
   * #141: a public room starts only with 2+ people, and moves a late arrival on only while its
   * game runs — so someone alone in a room it moved them to (`slug.g2`) could wait there for
   * good once the link's room is back in its lobby (a friend opening the link lands there; rooms
   * never talk to each other). Alone there, no game running, for LONE_RETURN_MS on screen: back
   * to the link's room. Still mid-game there, it moves us to the same next room again.
   */
  private watchAlone() {
    const alone = this.roomId !== this.me.slug && !this.stay && !this.moving && this.here < 2 && this.phase !== "countdown" && this.phase !== "play";
    if (!alone) return this.clearLone();
    if (this.loneTimer) return;
    const gen = this.gen;
    this.loneTimer = visibleTimeout(() => {
      this.loneTimer = null;
      if (gen !== this.gen || this.connState !== "connected") return;
      dlog("conn", `alone in ${this.roomId} → back to ${this.me.slug}`);
      this.leftAlone = this.roomId;
      this.movedFrom = null;
      this.moveTo(this.me.slug);
    }, LONE_RETURN_MS, this.env);
  }

  private clearLone() {
    this.loneTimer?.cancel();
    this.loneTimer = null;
  }

  close() {
    this.clearLone();
    super.close();
  }
}

/**
 * Alone (no one else, no game running) this long on screen in a room a public room moved us to:
 * back to the link's room (#141) — about one short game plus its result, so the link's room is
 * usually back in its lobby by then; if not, it moves us on to the same next room again.
 */
export const LONE_RETURN_MS = 20000;

export type EdgeRoomOptions = { autoStart?: { start: unknown; ms?: number }; pin?: string };
const edgeRoomUrl = (roomUrl: string, room: string) => `${roomUrl.replace(/\/+$/, "")}/room/${encodeURIComponent(room)}`;
/** `slug` → `slug.g2` → `slug.g3` … (edge/room game.js nextRoomId): only a public room moves, one step on. */
export function isNextRoom(from: string, to: string): boolean {
  if (from.includes("~")) return false;
  const m = /^(.*)\.g(\d{1,6})$/.exec(from);
  return to === (m ? `${m[1]}.g${Number(m[2]) + 1}` : `${from}.g2`);
}

type EngineConn = { sendAction(n: string, p: unknown, id: string): void; sendReaction(e: string): void; handoff(): void; close(): void };
type PackFn = (game: string, opts: { theme?: string }) => Promise<unknown[] | null>;

/** Room engine running on a player's device (host mode / serverless). */
abstract class EngineTransport extends BaseTransport {
  protected conn: EngineConn | null = null;
  // Mobile browsers throttle timers in hidden tabs — a hosting device that goes
  // to the background hands the room to another player first.
  private onHidden = () => {
    if (document.visibilityState === "hidden" && this.conn) {
      dlog("host", "tab hidden → hand the room on if hosting");
      this.conn.handoff();
    }
  };

  /** Load the engine lazily and connect it (resolves to null if abandoned meanwhile). */
  protected abstract open(gen: number): Promise<EngineConn | null>;

  connect() {
    const gen = ++this.gen;
    this.setConn("connecting");
    this.open(gen).then(
      (conn) => {
        if (gen !== this.gen) return conn?.close(); // left (or retried) before the engine finished loading
        this.conn = conn;
        document.addEventListener("visibilitychange", this.onHidden);
      },
      () => gen === this.gen && this.fail("load"),
    );
  }

  protected stop() {
    document.removeEventListener("visibilitychange", this.onHidden);
    this.conn?.close();
    this.conn = null;
  }

  close() {
    this.gen++;
    this.stopTimer();
    this.stop();
  }

  sendAction(name: string, payload?: unknown) {
    const id = crypto.randomUUID();
    dlog("action", `${name} #${id.slice(-6)}${this.conn ? "" : " (not connected: dropped)"}`);
    this.conn?.sendAction(name, payload, id);
  }

  sendReaction(emoji: string) {
    this.conn?.sendReaction(emoji);
  }
}

/**
 * Host mode: the room runs on a player's device. The first player in the room
 * hosts (runs the room engine); the server only relays messages.
 */
export class RelayTransport extends EngineTransport {
  readonly via: RoomVia = "server";
  constructor(private url: string, private me: Identity, private packUrl: string, private eventsUrl?: string) {
    super();
  }

  protected async open(gen: number) {
    const { connectRelay } = await import("@snack/room/relay-client");
    if (gen !== this.gen) return null;
    return connectRelay({
      url: this.url,
      WebSocket,
      me: this.me,
      eventsUrl: this.eventsUrl,
      engine: engineMetrics(this.me.slug), // games are reported by the host only (docs/telemetry.md §9.5)
      onMessage: (m: RoomMessage) => {
        if (gen !== this.gen) return;
        if (m.t === "disconnected") this.fail(this.connState === "connected" ? "disconnected" : "unreachable");
        else this.receive(m);
      },
      getPack: async (game: string, opts: { theme?: string }) => {
        const q = new URLSearchParams({ game: game ?? "", theme: opts?.theme ?? "" });
        const r = await fetch(`${this.packUrl}?${q}`).catch(() => null);
        return r?.ok ? ((await r.json()).pack ?? null) : null;
      },
    });
  }
}

/**
 * Serverless room: players meet on an MQTT broker (one per deployment — see
 * backend.ts BROKER_URL); one of them hosts the room engine.
 */
export class MeshTransport extends EngineTransport {
  readonly via: RoomVia = "mesh";
  /**
   * `freshRoom`: this device made the room code a moment ago, so nobody can be there yet —
   * the first connect waits FRESH_DISCOVERY_MS for a host instead of the mesh's 1.5 s
   * (a reload or a retry waits the full time again).
   */
  constructor(
    private me: Identity,
    private brokerUrl: string | undefined,
    private getPack: PackFn,
    private freshRoom = false,
    /** Edge room relay (VITE_ROOM_URL): rooms go through it instead of the MQTT broker. */
    private roomUrl?: string,
    /** Tests only: shorter broker / join timings (a slow local broker in seconds, not minutes). */
    private tuning: { bus?: MeshBusTuning; connectTimeoutMs?: number } = {},
  ) {
    super();
    if (tuning.connectTimeoutMs) this.connectTimeoutMs = tuning.connectTimeoutMs;
  }

  /** The bus: the edge relay when roomUrl is set, else the MQTT broker (the default). */
  private async bus(): Promise<(peerId: string) => Bus> {
    if (this.roomUrl) {
      const { wsBus } = await import("@snack/room/ws-bus");
      if (debugEnabled()) dlog("broker", `edge ${hostOf(this.roomUrl)}`);
      return wsBus({ url: this.roomUrl, room: this.me.slug, tokens: sessionTokens });
    }
    const { mqttBus, DEFAULT_BROKER } = await import("@snack/room/mqtt-bus");
    if (debugEnabled()) dlog("broker", hostOf(this.brokerUrl || DEFAULT_BROKER));
    return mqttBus({ ...this.tuning.bus, room: this.me.slug, url: this.brokerUrl || undefined });
  }

  protected async open(gen: number) {
    const [{ connectMesh }, busFor] = await Promise.all([import("@snack/room/mesh-client"), this.bus()]);
    if (gen !== this.gen) return null;
    let drops = 0;
    const fresh = this.freshRoom;
    this.freshRoom = false;
    // Every broker connect try is passed on ({t: "connAttempt"}: the join tracker counts them).
    const createBus = (peerId: string) => {
      const bus = busFor(peerId) as Bus & { attempts?: number };
      if (gen === this.gen && bus.attempts != null) this.emit({ t: "connAttempt", d: { n: bus.attempts } });
      bus.onStatus?.((s) => {
        if (s.state === "attempt" && gen === this.gen) this.emit({ t: "connAttempt", d: { n: s.attempt, reason: s.reason } });
      });
      return bus;
    };
    return connectMesh({
      ...(fresh ? { timing: { discoveryMs: FRESH_DISCOVERY_MS } } : {}),
      createBus,
      me: this.me,
      getPack: this.getPack,
      // games are reported by the host only (docs/telemetry.md §9.5); a friends room's
      // finished game is saved for its link (docs/room-results.md). A friends room has a host
      // (방장, #135): the first device in (the engine's first join is its own device). Public mesh
      // rooms keep "anyone starts" — auto-start + moving late arrivals needs the edge room server.
      engine: { ...engineMetrics(this.me.slug), ...engineResults(this.me.slug), ...(this.me.slug.includes("~") ? { startRule: "host" as const } : {}) },
      onRole: (isHost) => dlog("host", isHost ? "this device hosts the room" : "another player hosts"),
      // Mesh internals for the test log: line adoption / discovery; stale-host drops only counted.
      debug: debugEnabled()
        ? (event: string) => {
            if (event !== "drop") dlog("mesh", event);
            else if (++drops <= 3 || drops % 50 === 0) dlog("mesh", `drop from a stale host (${drops})`);
          }
        : undefined,
      onMessage: (m) => gen === this.gen && this.receive(m as RoomMessage),
      onStatus: (s) => {
        if (gen !== this.gen) return;
        if (s.state === "failed") this.fail(s.reason ?? "broker");
        else if (s.state === "connected") this.setConn("connected");
      },
    });
  }
}

/** mqttBus timing overrides (tests): join budget, CONNACK wait per try, pause between tries. */
export type MeshBusTuning = { failAfterMs?: number; dropAfterMs?: number; connectTimeoutMs?: number; reconnectMs?: number };

/** Discovery wait in a room this device has just made (see MeshTransport). */
export const FRESH_DISCOVERY_MS = 150;

/**
 * This device made `roomId` a moment ago (room server /mint): its organizer ticket (10 min) rides
 * in the first hello, and the room answers with the 12 h organizer token that replaces it.
 */
export const rememberOrganizerTicket = (roomId: string, ticket: string) => sessionTokens.set(`org:${roomId}`, ticket);
/** A seat token for `roomId` in this tab (a PIN room then opens without asking for the PIN). */
export const hasSeatToken = (roomId: string) => Boolean(sessionTokens.get(roomId));
/** Whether this tab holds the organizer token (or /mint ticket) of `roomId`. */
export const isOrganizerHere = (roomId: string) => Boolean(sessionTokens.get(`org:${roomId}`));

// Edge room seat / organizer tokens survive a reload of this tab (the seat is taken back).
const TOKEN_KEY = "snk-room-token:";
const sessionTokens = {
  get(room: string): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY + room);
    } catch {
      return null;
    }
  },
  set(room: string, token: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY + room, token);
    } catch {
      /* storage blocked: the token lives as long as this page */
    }
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(bad url)";
  }
}
