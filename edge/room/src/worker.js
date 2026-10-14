// Cloudflare Worker + Durable Objects: snack rooms at the edge (spike, not deployed).
//   GET /room/<roomId>   (WebSocket) → GameRoom DO: the room engine runs here (server-authoritative)
//   GET /relay/<roomId>  (WebSocket) → Relay DO: a dumb relay for the serverless mesh
//   anything else        → 404 (there is no room listing)
// One DO per room id. The logic is game.js / core.js — the same modules the Node hub runs.
import { DurableObject } from "cloudflare:workers";
import { RoomRelay, UsageMeter, ROOM_ID_RE } from "./core.js";
import { GameRoom } from "./game.js";

const num = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
// Test knobs (wrangler dev --var …); unset in production → the LIMITS in core.js / game.js.
const limitsFrom = (env) => {
  const l = { roomTtlMs: num(env.ROOM_TTL_MS), pinIterations: num(env.PIN_ITERATIONS), lockMs: num(env.LOCK_MS), claimWindowMs: num(env.CLAIM_WINDOW_MS) };
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/usage" && req.method === "GET") return usage(req, env, ctx);
    const m = /^\/(room|relay)\/([^/]+)$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[2])) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
    if (!env.ROOM_TOKEN_SECRET) return new Response("not configured", { status: 503 });
    const ns = m[1] === "room" ? env.GAMES : env.ROOMS;
    const fwd = new Request(req);
    fwd.headers.set("x-room-id", m[2]);
    return ns.get(ns.idFromName(m[2])).fetch(fwd);
  },
};

// GET /usage: today's estimate and % of each free limit. Cached 60 s at the edge so a page
// refreshing it costs (almost) nothing; a cache miss counts itself as one Worker request.
async function usage(req, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/usage", req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const body = await env.METER.get(env.METER.idFromName("global")).report({ countRequest: true });
  const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** Socket adapters over hibernatable WebSockets (state = the attachment, cached while awake). */
class Sockets {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new WeakMap(); // ws → adapter
  }
  of(ws) {
    let a = this.cache.get(ws);
    if (a) return a;
    let state;
    a = {
      ws,
      get state() {
        state ??= ws.deserializeAttachment() ?? {};
        return state;
      },
      save(s) {
        state = s;
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
    this.cache.set(ws, a);
    return a;
  }
  all() {
    return this.ctx.getWebSockets().map((ws) => this.of(ws));
  }
  accept(roomId) {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const s = this.of(server);
    s.save({ room: roomId });
    return { client, s };
  }
}

const meterOf = (env) => {
  const meter = env.METER.get(env.METER.idFromName("global"));
  return { admit: () => meter.admit(), add: (d) => meter.add(d) };
};

/** Server-authoritative game room (game.js). */
export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socks = new Sockets(ctx);
    this.room = null;
  }
  core(roomId) {
    const base = this.env.PACK_BASE_URL;
    this.room ??= new GameRoom({
      roomId,
      store: this.ctx.storage,
      secret: this.env.ROOM_TOKEN_SECRET,
      usage: meterOf(this.env),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      limits: limitsFrom(this.env),
      sockets: () => this.socks.all().filter((s) => s.ws.readyState !== WebSocket.CLOSED),
      // Round content: the same static files the player serves (data/multi-content/<game>.json).
      getPack: async (game) => {
        if (!base || !/^[a-z0-9-]{1,40}$/.test(String(game ?? ""))) return null;
        const r = await fetch(`${base.replace(/\/+$/, "")}/${game}.json`).catch(() => null);
        return r?.ok ? r.json().catch(() => null) : null;
      },
    });
    return this.room;
  }
  roomOf(ws) {
    return this.core(this.socks.of(ws).state.room);
  }
  async fetch(req) {
    const roomId = req.headers.get("x-room-id");
    const { client, s } = this.socks.accept(roomId);
    this.core(roomId).onOpen(s);
    s.save({ ...s.state, room: roomId });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    await this.roomOf(ws).onMessage(this.socks.of(ws), msg);
  }
  async webSocketClose(ws) {
    await this.roomOf(ws).onClose(this.socks.of(ws));
    this.socks.of(ws).close(1000, "bye");
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    if (!this.ctx.getWebSockets().length) await this.ctx.storage.deleteAll();
  }
}

/** Dumb relay for the serverless mesh (core.js RoomRelay). */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socks = new Sockets(ctx);
    this.relay = null;
  }
  core(roomId) {
    this.relay ??= new RoomRelay({
      roomId,
      store: this.ctx.storage,
      secret: this.env.ROOM_TOKEN_SECRET,
      usage: meterOf(this.env),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      limits: limitsFrom(this.env),
    });
    return this.relay;
  }
  async fetch(req) {
    const roomId = req.headers.get("x-room-id");
    const { client, s } = this.socks.accept(roomId);
    this.core(roomId).onOpen(s, this.socks.all());
    s.save({ ...s.state, room: roomId });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, msg) {
    const s = this.socks.of(ws);
    await this.core(s.state.room).onMessage(s, msg, this.socks.all());
  }
  async webSocketClose(ws) {
    const s = this.socks.of(ws);
    await this.core(s.state.room).onClose(s, this.socks.all().filter((x) => x.ws !== ws && x.ws.readyState !== WebSocket.CLOSED));
    s.close(1000, "bye");
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    if (!this.ctx.getWebSockets().length) await this.ctx.storage.deleteAll(); // also clears the alarm
  }
}

/** One per account: today's usage (UsageMeter). Rooms call it on create and ≤ every 30 s. */
export class Meter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const stages = { newRooms: num(env.STAGE_NEW_ROOMS), newJoins: num(env.STAGE_NEW_JOINS) };
    this.m = new UsageMeter({ store: ctx.storage, stages: Object.fromEntries(Object.entries(stages).filter(([, v]) => v !== undefined)) });
  }
  admit() {
    return this.m.admit();
  }
  add(d) {
    return this.m.add(d);
  }
  report(o) {
    return this.m.report(o);
  }
}
