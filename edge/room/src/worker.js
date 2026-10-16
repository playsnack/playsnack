// Cloudflare Worker + Durable Objects: snack rooms at the edge (docs/edge-rooms.md, docs/room-admission.md).
//   POST /mint {slug, pin?, anonId?}  → a new signed room code + organizer ticket (+ pass with a PIN); no DO
//   GET /room/<roomId>   (WebSocket) → checked here first (admit.js decideUpgrade: code tag, PIN,
//                                      rate limits, Origin) → GameRoom DO with a signed admit claim;
//                                      refused → a socket of the Worker's own carries `denied`, no DO woken
//   GET /room/<roomId>/result         → that friends room's last saved game (7 days) or 404; + `startAt`
//                                      when its start is scheduled (#218, for the link preview)
//   /relay/<roomId>                   → 410: the mesh relay is retired (the live player uses /room only)
//   anything else        → 404 (there is no room listing)
// One DO per room id. The logic is admit.js / game.js / core.js — the same modules the Node hub runs.
import { DurableObject } from "cloudflare:workers";
import { RoomRelay, UsageMeter, ROOM_ID_RE } from "./core.js";
import { GameRoom, roomAlarm, roomReadBody } from "./game.js";
import { StatsSender, isFriendRoom } from "./results.js";
import { decideUpgrade, decideMint, decideResult, configFrom, limitersFrom, memoryLimiters, verifyAdmit, stripRoomHeaders, originAllowed, WorkerTally } from "./admit.js";

const num = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
// Test knobs (wrangler dev --var …); unset in production → the LIMITS in core.js / game.js.
const limitsFrom = (env) => {
  const l = { roomTtlMs: num(env.ROOM_TTL_MS), pinIterations: num(env.PIN_ITERATIONS), lockMs: num(env.LOCK_MS), claimWindowMs: num(env.CLAIM_WINDOW_MS) };
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
};

// Per isolate (best effort — an evicted isolate forgets): the rate-limit fallback when a
// `ratelimits` binding is missing, and the tally of refusals for the usage meter.
const fallbackLimiters = memoryLimiters();
const tally = new WorkerTally();
/** Count a request the Worker answered itself; flush the batch to the meter when due (one DO call per ~200). */
const counted = (env, ctx, d) => {
  const due = tally.count(d);
  if (due && env.METER) ctx.waitUntil(env.METER.get(env.METER.idFromName("global")).add(due).catch(() => {}));
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/usage" && req.method === "GET") return usage(req, env, ctx);
    if (url.pathname === "/mint") return mint(req, env, ctx);
    const res = /^\/room\/([^/]+)\/result$/.exec(url.pathname);
    if (res) return result(req, env, ctx, res[1], url);
    if (/^\/relay(\/|$)/.test(url.pathname)) {
      counted(env, ctx, { workerExtra: 1 });
      return new Response("gone", { status: 410 });
    }
    const m = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
    if (!env.ROOM_TOKEN_SECRET) return new Response("not configured", { status: 503 });
    const roomId = m[1];
    const stub = () => env.GAMES.get(env.GAMES.idFromName(roomId));
    const d = await decideUpgrade({
      secret: env.ROOM_TOKEN_SECRET,
      roomId,
      params: url.searchParams,
      ip: req.headers.get("cf-connecting-ip") ?? "",
      origin: req.headers.get("origin"),
      cfg: configFrom(env),
      limiters: limitersFrom(env, fallbackLimiters),
      pinAttempt: (ipKey) => stub().pinAttempt({ roomId, ipKey }),
    });
    if (d.deny) {
      // W1 D0 (a wrong PIN: + the PIN-lock RPC, its rows and the alarm it may arm)
      counted(env, ctx, { workerExtra: 1, doExtra: d.rpc ? 1 + (d.alarms ?? 0) : 0, rows: d.rows ?? 0 });
      return refuse(d.deny);
    }
    // Forward without the token / PIN in the URL and without any client-sent x-room-* header.
    const fwdUrl = new URL(url);
    fwdUrl.searchParams.delete("k");
    fwdUrl.searchParams.delete("pin");
    const fwd = new Request(fwdUrl.toString(), req);
    stripRoomHeaders(fwd.headers);
    fwd.headers.set("x-room-id", roomId);
    fwd.headers.set("x-room-admit", d.forward.admit);
    return stub().fetch(fwd);
  },
};

/** A refused upgrade: the Worker's own socket says why (browsers hide an upgrade's HTTP status), then closes. */
// (`wrangler dev` logs "Network connection lost" for each — local proxy noise; the client gets the frame and the code.)
function refuse({ reason, close, ...extra }) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.addEventListener("error", () => {}); // the client may drop it first: nothing to do
  server.send(JSON.stringify({ t: "denied", d: { reason, ...extra } }));
  server.close(close, reason);
  return new Response(null, { status: 101, webSocket: client });
}

// POST /mint (text/plain → no CORS preflight; OPTIONS answered anyway). No Durable Object.
async function mint(req, env, ctx) {
  const origin = req.headers.get("origin");
  const cfg = configFrom(env);
  const cors = { "access-control-allow-origin": origin && originAllowed(origin, cfg.allowedOrigins) ? origin : "*", vary: "origin" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
  counted(env, ctx, { workerExtra: 1 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { ...cors, allow: "POST" } });
  if (!env.ROOM_TOKEN_SECRET) return new Response("not configured", { status: 503, headers: cors });
  const len = Number(req.headers.get("content-length") ?? 0);
  const text = len > 1024 ? null : await req.text().catch(() => null);
  const r = await decideMint({ secret: env.ROOM_TOKEN_SECRET, text, ip: req.headers.get("cf-connecting-ip") ?? "", origin, cfg, limiters: limitersFrom(env, fallbackLimiters) });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" } });
}

// GET /usage: today's estimate and % of each free limit. Cached 60 s at the edge so a page
// refreshing it costs (almost) nothing; a cache miss counts itself as one Worker request.
// The Cache API is a no-op on *.workers.dev, so the isolate also keeps the last answer 60 s.
let usageMemo = null; // { at, body }
async function usage(req, env, ctx) {
  if (usageMemo && Date.now() - usageMemo.at < 60000) return usageResponse(usageMemo.body);
  const cache = caches.default;
  const key = new Request(new URL("/usage", req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  const body = JSON.stringify(await env.METER.get(env.METER.idFromName("global")).report({ countRequest: true }));
  usageMemo = { at: Date.now(), body };
  const res = usageResponse(body);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
// GET /room/<id>/result: friends rooms whose code checks out (admit.js decideResult); a PIN room
// only with ?k=<pass | seat | organizer token>. Anything else is 404 without waking a DO.
// Unlisted like /api/room-result: whoever has the link (and, for a PIN room, the pass) may read it.
const CORS = { "access-control-allow-origin": "*" };
async function result(req, env, ctx, roomId, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET", "access-control-max-age": "86400" } });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...CORS, allow: "GET" } });
  const notFound = () => {
    counted(env, ctx, { workerExtra: 1 });
    return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=10" } });
  };
  if (!isFriendRoom(roomId)) return notFound(); // public / malformed ids never hold a result
  if (!env.ROOM_TOKEN_SECRET) return new Response("not configured", { status: 503, headers: CORS });
  const d = await decideResult({ secret: env.ROOM_TOKEN_SECRET, roomId, params: url.searchParams, cfg: configFrom(env) });
  if (d.notFound) return notFound(); // ids are URL-unreserved chars: nothing to decode
  const fwdUrl = new URL(url);
  fwdUrl.searchParams.delete("k");
  const fwd = new Request(fwdUrl.toString(), req);
  stripRoomHeaders(fwd.headers);
  fwd.headers.set("x-room-id", roomId);
  if (d.forward.admit) fwd.headers.set("x-room-admit", d.forward.admit);
  return env.GAMES.get(env.GAMES.idFromName(roomId)).fetch(fwd);
}
const usageResponse = (body) => new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });

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
  return { admit: (o) => meter.admit(o), add: (d) => meter.add(d) };
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
    const waitUntil = (p) => this.ctx.waitUntil(p.catch(() => {}));
    this.room ??= new GameRoom({
      waitUntil,
      // Game stats → the site's /api/ev (docs/telemetry.md §9.7). STATS_URL "" turns them off.
      statsSender: this.env.STATS_URL ? new StatsSender({ url: this.env.STATS_URL, secret: this.env.ROOM_SERVER_SECRET || "", waitUntil }) : null,
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
    const secret = this.env.ROOM_TOKEN_SECRET;
    const adm = secret && roomId ? await verifyAdmit(secret, req.headers.get("x-room-admit"), roomId) : null;
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      // GET /room/<id>/result (worker.js result: checked there; a PIN room's carries an admit claim)
      // (+ the scheduled start, #218 — `startAt` for the link preview)
      const { status, body } = roomReadBody(await this.core(roomId).readRoom(adm));
      const headers = { "content-type": "application/json", "cache-control": adm ? "private, max-age=10" : "public, max-age=10", "access-control-allow-origin": "*" };
      return new Response(JSON.stringify(body), { status, headers });
    }
    // Only upgrades the Worker checked (admit.js): a signed claim for this room, ≤ 30 s old.
    if (!adm) return new Response("forbidden", { status: 403 });
    const room = this.core(roomId);
    const no = await room.upgradeCheck(adm); // a right PIN while locked / closed: as a wrong one
    if (no) return refuse({ ...no, close: 4003 });
    const { client, s } = this.socks.accept(roomId);
    room.onOpen(s, adm);
    s.save({ ...s.state, room: roomId });
    return new Response(null, { status: 101, webSocket: client });
  }
  /** RPC from the Worker: a wrong PIN for this room (game.js pinAttempt). */
  async pinAttempt({ roomId, ipKey }) {
    return this.core(roomId).pinAttempt(ipKey);
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
    // Occupied: the alarm is a player's away deadline (#213) or the scheduled start (#218, game.js onAlarm) — the room of its sockets.
    const live = this.socks.all().find((s) => s.state?.room);
    if (live) return void (await this.core(live.state.room).onAlarm());
    if (this.ctx.getWebSockets().length) return;
    if (this.room) await this.room.onAlarm();
    else await roomAlarm({ store: this.ctx.storage, setAlarm: (at) => this.ctx.storage.setAlarm(at) }); // keeps a saved result (7 days)
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
  admit(o) {
    return this.m.admit(o);
  }
  add(d) {
    return this.m.add(d);
  }
  report(o) {
    return this.m.report(o);
  }
}
