// How a live app talks to its room. The player only sees this interface, so the
// room can run on the server (today) or on a host player's device behind a thin
// relay (host mode) without touching LiveApp or the app documents.
//
// Wire messages are the room engine's (@snack/room): inbound "state", "setVar",
// "participants", "reaction", "actionAck"; outbound actions and reactions.

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

/** The room runs on snack-server; one WebSocket per player. */
export class ServerTransport implements RoomTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<(m: RoomMessage) => void>();

  constructor(private url: string, private me: Identity) {}

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", d: this.me }));
    ws.onmessage = (ev) => {
      let m: RoomMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(m);
    };
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  sendAction(name: string, payload?: unknown) {
    this.send({ t: "action", d: { name, payload, clientMsgId: crypto.randomUUID() } });
  }

  sendReaction(emoji: string) {
    this.send({ t: "react", d: { emoji } });
  }

  onMessage(fn: (m: RoomMessage) => void) {
    this.listeners.add(fn);
  }

  private send(m: { t: string; d: unknown }) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }
}

/**
 * Host mode: the room runs on a player's device. The first player in the room
 * hosts (runs the room engine); the server only relays messages.
 */
export class RelayTransport implements RoomTransport {
  private conn: { sendAction(n: string, p: unknown, id: string): void; sendReaction(e: string): void; handoff(): void; close(): void } | null = null;
  // Mobile browsers throttle timers in hidden tabs — a hosting device that goes
  // to the background hands the room to another player first.
  private onHidden = () => {
    if (document.visibilityState === "hidden") this.conn?.handoff();
  };
  private listeners = new Set<(m: RoomMessage) => void>();
  private closed = false;

  constructor(private url: string, private me: Identity, private packUrl: string, private eventsUrl?: string) {}

  connect() {
    // Loaded lazily so server-run rooms never pay for the host engine.
    void import("@snack/room/relay-client").then(({ connectRelay }) => {
      if (this.closed) return; // left before the engine finished loading
      this.conn = connectRelay({
        url: this.url,
        WebSocket,
        me: this.me,
        eventsUrl: this.eventsUrl,
        onMessage: (m: RoomMessage) => this.listeners.forEach((fn) => fn(m)),
        getPack: async (game: string, opts: { theme?: string }) => {
          const q = new URLSearchParams({ game: game ?? "", theme: opts?.theme ?? "" });
          const r = await fetch(`${this.packUrl}?${q}`).catch(() => null);
          return r?.ok ? ((await r.json()).pack ?? null) : null;
        },
      });
      document.addEventListener("visibilitychange", this.onHidden);
    });
  }

  close() {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onHidden);
    this.conn?.close();
    this.conn = null;
  }

  sendAction(name: string, payload?: unknown) {
    this.conn?.sendAction(name, payload, crypto.randomUUID());
  }

  sendReaction(emoji: string) {
    this.conn?.sendReaction(emoji);
  }

  onMessage(fn: (m: RoomMessage) => void) {
    this.listeners.add(fn);
  }
}
