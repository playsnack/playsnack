// Cloudflare Worker + Durable Objects: the room relay (spike, not deployed).
//   GET /room/<roomId>  (WebSocket upgrade) → the room's Durable Object (one per room id)
//   anything else       → 404 (there is no room listing)
// The room logic is core.js — the same module the Node test hub runs.
import { DurableObject } from "cloudflare:workers";
import { RoomRelay, UsageMeter, ROOM_ID_RE } from "./core.js";

const num = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
// Test knobs (wrangler dev --var …); unset in production → core.js LIMITS.
const limitsFrom = (env) => {
  const l = { roomTtlMs: num(env.ROOM_TTL_MS), pinIterations: num(env.PIN_ITERATIONS), lockMs: num(env.LOCK_MS) };
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
    if (!env.ROOM_TOKEN_SECRET) return new Response("not configured", { status: 503 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    const fwd = new Request(req);
    fwd.headers.set("x-room-id", m[1]);
    return stub.fetch(fwd);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.states = new WeakMap(); // ws → its attachment (cached while awake)
    this.relay = null;
  }

  core(roomId) {
    if (!this.relay) {
      const meter = this.env.METER.get(this.env.METER.idFromName("global"));
      this.relay = new RoomRelay({
        roomId,
        store: this.ctx.storage,
        secret: this.env.ROOM_TOKEN_SECRET,
        usage: { admit: () => meter.admit(), add: (d) => meter.add(d) },
        setAlarm: (at) => this.ctx.storage.setAlarm(at),
        limits: limitsFrom(this.env),
      });
    }
    return this.relay;
  }

  sock(ws) {
    const states = this.states;
    return {
      ws,
      get state() {
        let s = states.get(ws);
        if (!s) states.set(ws, (s = ws.deserializeAttachment() ?? {}));
        return s;
      },
      save(s) {
        states.set(ws, s);
        ws.serializeAttachment(s);
      },
      send(str) {
        try {
          ws.send(str);
        } catch {
          /* closing */
        }
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {
          /* closed */
        }
      },
    };
  }

  // Wrappers must be stable within one event (the core compares them by identity).
  all(except) {
    return this.ctx.getWebSockets().map((ws) => (except && ws === except.ws ? except : this.sock(ws)));
  }

  async fetch(req) {
    const roomId = req.headers.get("x-room-id");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const s = this.sock(server);
    const core = this.core(roomId);
    core.onOpen(s, this.all(s));
    s.save({ ...s.state, room: roomId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const s = this.sock(ws);
    await this.core(s.state.room).onMessage(s, msg, this.all(s));
  }

  async webSocketClose(ws) {
    const s = this.sock(ws);
    await this.core(s.state.room).onClose(s, this.all(s).filter((x) => x.ws !== ws && x.ws.readyState !== WebSocket.CLOSED));
    s.close(1000, "bye");
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const live = this.ctx.getWebSockets();
    if (!live.length) await this.ctx.storage.deleteAll(); // also clears the alarm
  }
}

/** One per account: today's usage estimate (see UsageMeter). Called twice per room. */
export class Meter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.m = new UsageMeter({ store: ctx.storage, share: num(env.USAGE_SHARE) ?? 0.7 });
  }
  admit() {
    return this.m.admit();
  }
  add(d) {
    return this.m.add(d);
  }
}
