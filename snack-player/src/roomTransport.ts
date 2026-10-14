// How a live app talks to its room. The player only sees this interface, so the
// room can run on the server (today) or on a host player's device behind a thin
// relay (host mode) without touching LiveApp or the app documents.
//
// Wire messages are the room engine's (@snack/room): inbound "state", "setVar",
// "participants", "reaction", "actionAck"; outbound actions and reactions.

import { debugEnabled, dlog, noteRoomMessage } from "./debugLog";
import { engineMetrics } from "./telemetry";
import { engineResults } from "./roomResult";
import type { Bus } from "@snack/room/mesh-client";

export type RoomMessage = { t: string; d: Record<string, unknown> };

/**
 * Connection status, delivered through onMessage as `{ t: "conn", d: ConnStatus }`
 * whenever it changes ("connecting" first, then "connected" or "failed").
 * The screen shows connecting / failed (with retry and "혼자 하기") from this.
 */
export type ConnState = "connecting" | "connected" | "failed";
export type ConnStatus = { state: ConnState; reason?: string };

export interface RoomTransport {
  /** Open the connection and join the room. */
  connect(): void;
  close(): void;
  sendAction(name: string, payload?: unknown): void;
  sendReaction(emoji: string): void;
  onMessage(fn: (m: RoomMessage) => void): void;
  /** After "failed": try again (emits "connecting" → "connected" | "failed"). */
  retry?(): void;
}

export type Identity = { slug: string; anonId: string; nick: string };

/** No room state this long after connecting → "failed" (the screen offers retry). */
export const CONNECT_TIMEOUT_MS = 15000;

/**
 * Shared plumbing: listeners and the connection status every transport reports
 * ("connecting" → "connected" once the room state arrives | "failed").
 */
abstract class BaseTransport implements RoomTransport {
  private listeners = new Set<(m: RoomMessage) => void>();
  private state: ConnState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every connect/close, so callbacks of an abandoned attempt are ignored. */
  protected gen = 0;

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

  protected setConn(state: ConnState, reason?: string) {
    if (this.state === state) return;
    this.state = state;
    dlog("conn", reason ? `${state} (${reason})` : state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (state === "connecting") {
      const gen = this.gen;
      this.timer = setTimeout(() => {
        if (gen === this.gen && this.state === "connecting") this.fail("timeout");
      }, CONNECT_TIMEOUT_MS);
    }
    this.emit({ t: "conn", d: reason ? { state, reason } : { state } });
  }

  /** Give up on this attempt: report "failed" and stop its connection. */
  protected fail(reason: string) {
    this.setConn("failed", reason);
    this.stop();
  }

  /** Tear down the live connection without reporting anything. */
  protected abstract stop(): void;

  protected stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = null;
  }
}

/** The room runs on snack-server; one WebSocket per player. */
export class ServerTransport extends BaseTransport {
  private ws: WebSocket | null = null;

  constructor(private url: string, protected me: Identity) {
    super();
  }

  /** What the first frame carries (the edge room adds its tokens). */
  protected helloData(): Record<string, unknown> {
    return this.me;
  }

  /** A transport-level frame (not a room message)? Handle it and return true. */
  protected control(_m: RoomMessage): boolean {
    return false;
  }

  connect() {
    const gen = ++this.gen;
    this.setConn("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", d: this.helloData() }));
    ws.onmessage = (ev) => {
      let m: RoomMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (gen === this.gen && !this.control(m)) this.receive(m);
    };
    ws.onclose = () => {
      if (gen === this.gen) this.fail(this.connState === "connected" ? "disconnected" : "unreachable");
    };
  }

  protected stop() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      ws.close();
    }
  }

  close() {
    this.gen++;
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
  constructor(roomUrl: string, me: Identity) {
    super(`${roomUrl.replace(/\/+$/, "")}/room/${encodeURIComponent(me.slug)}`, me);
  }

  protected helloData() {
    const token = sessionTokens.get(this.me.slug);
    const organizerToken = sessionTokens.get(`org:${this.me.slug}`);
    return { ...this.me, ...(token ? { token } : {}), ...(organizerToken ? { organizerToken } : {}) };
  }

  protected control(m: RoomMessage) {
    const token = typeof m.d?.token === "string" ? m.d.token : "";
    if (m.t === "token") sessionTokens.set(this.me.slug, token);
    else if (m.t === "organizer") sessionTokens.set(`org:${this.me.slug}`, token);
    else if (m.t === "denied") this.fail(String(m.d?.reason ?? "denied"));
    else return false;
    return true;
  }
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
  ) {
    super();
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
    return mqttBus({ room: this.me.slug, url: this.brokerUrl || undefined });
  }

  protected async open(gen: number) {
    const [{ connectMesh }, createBus] = await Promise.all([import("@snack/room/mesh-client"), this.bus()]);
    if (gen !== this.gen) return null;
    let drops = 0;
    const fresh = this.freshRoom;
    this.freshRoom = false;
    return connectMesh({
      ...(fresh ? { timing: { discoveryMs: FRESH_DISCOVERY_MS } } : {}),
      createBus,
      me: this.me,
      getPack: this.getPack,
      // games are reported by the host only (docs/telemetry.md §9.5); a friends room's
      // finished game is saved for its link (docs/room-results.md)
      engine: { ...engineMetrics(this.me.slug), ...engineResults(this.me.slug) },
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

/** Discovery wait in a room this device has just made (see MeshTransport). */
export const FRESH_DISCOVERY_MS = 150;

// Edge relay tokens (15 min) survive a reload of this tab, so a PIN room is not asked again.
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
