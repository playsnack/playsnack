// Node stand-in for the Cloudflare edge rooms (edge/room): the SAME platform-free
// logic the Worker and the Durable Objects run, behind a `ws` server — so tests and sims run
// without wrangler. Rooms live in memory.
//   POST /mint   a new signed room code (edge/room/src/admit.js decideMint)
//   /room/<id>   server-authoritative game room (edge/room/src/game.js — the engine runs here),
//                checked first as the Worker does (admit.js decideUpgrade; in-memory rate limiters)
//   /relay/<id>  dumb relay for the serverless mesh (edge/room/src/core.js RoomRelay) — kept here for
//                the local mesh sims (`relay: false` → 410 as the Worker answers)
// The client's address: `cf-connecting-ip` when a test sends one (as Cloudflare sets it), else the socket's.
// /room sockets emulate the Durable Object's WebSocket auto-response (#142, worker.js): the exact text
// "ping" is answered "pong" here and never reaches the room — only its time is kept (sock.pongAt(),
// as getWebSocketAutoResponseTimestamp); anything else goes to the room as before. `autoResponse:
// false` turns it off (tests: a ping then reaches the room like any frame).
// Accounting for docs/edge-rooms.md: every room keeps its counters after it empties
// (`history`), so a sim can report messages per player per game.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { RoomRelay, UsageMeter, memoryStore, ROOM_ID_RE } from "../../../edge/room/src/core.js";
import { GameRoom, roomReadBody, PING, PONG } from "../../../edge/room/src/game.js";
import { StatsSender, isFriendRoom } from "../../../edge/room/src/results.js";
import { decideUpgrade, decideMint, decideResult, configFrom, memoryLimiters, verifyAdmit, WorkerTally } from "../../../edge/room/src/admit.js";

const PACKS = new URL("../../../snack-server/data/multi-content/", import.meta.url);
/** Round content as the static player serves it (data/multi-content/<game>.json). */
export const filePack = async (game) => {
  if (!/^[a-z0-9-]{1,40}$/.test(String(game ?? ""))) return null;
  try {
    return JSON.parse(await readFile(new URL(`${game}.json`, PACKS), "utf8"));
  } catch {
    return null;
  }
};
const ROUTE = /^\/(room|relay)\/([^/]+)$/;

/**
 * `stats`: game stats as the Worker sends them (results.js StatsSender) — {url, secret?, fetch?,
 * flushMs?}; unset → none (the sims never post to a real stats API).
 * `env`: the Worker's vars (ALLOWED_ORIGINS, LEGACY_CREATE_UNTIL, LEGACY_JOIN_UNTIL); `relay`: serve
 * /relay (local mesh sims; the Worker answers 410). `tallyEvery`: Worker refusals per meter call (1 =
 * at once, so tests can read them; the Worker batches 200).
 * @param {{port?: number, host?: string, secret?: string, limits?: object, now?: () => number, stages?: object, free?: object, getPack?: Function, stats?: object, env?: object, relay?: boolean, tallyEvery?: number, autoResponse?: boolean}} [o]
 */
export async function startEdgeHub({ port = 4550, host = "127.0.0.1", secret = "hub-test-secret", limits = {}, now = Date.now, stages, free, getPack = filePack, stats = null, env = {}, relay = true, tallyEvery = 1, autoResponse = true } = {}) {
  const meterStore = memoryStore();
  const meter = new UsageMeter({ store: meterStore, now, ...(stages ? { stages } : {}), ...(free ? { free } : {}) });
  const cfg = configFrom(env);
  const limiters = memoryLimiters(now);
  const tally = new WorkerTally({ every: tallyEvery, now });
  const counts = { workerDenied: 0, pinRpc: 0, pongs: 0 }; // tests: what the Worker answered itself (+ auto-responses)
  const counted = (d) => {
    const due = tally.count(d);
    if (due) return meter.add(due);
  };
  const ipOf = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "");
  const rooms = new Map(); // "kind:id" → { kind, core, store, sockets: Set<adapter>, alarm }
  const history = new Map(); // "kind:id" → stats of the room (kept after it empties)

  const roomFor = (kind, id) => {
    const key = `${kind}:${id}`;
    let r = rooms.get(key);
    if (r) return r;
    const store = memoryStore();
    r = { kind, id, store, sockets: new Set(), alarm: null, alarmAt: null };
    const setAlarm = (at) => {
      clearTimeout(r.alarm);
      r.alarmAt = at;
      r.alarm = setTimeout(() => fireAlarm(key), Math.max(0, at - now()));
      r.alarm.unref?.();
    };
    r.core =
      kind === "room"
        ? new GameRoom({ roomId: id, store, secret, usage: meter, now, limits, setAlarm, getPack, sockets: () => [...r.sockets], statsSender: stats?.url ? new StatsSender(stats) : null })
        : new RoomRelay({ roomId: id, store, secret, usage: meter, now, limits, setAlarm });
    rooms.set(key, r);
    history.set(key, { ...r.core.stats, first: now(), last: now() });
    return r;
  };
  const fireAlarm = async (key) => {
    const r = rooms.get(key);
    if (!r) return;
    r.alarm = null;
    r.alarmAt = null;
    const gone = r.kind === "room" ? await r.core.onAlarm() : await r.core.onAlarm([...r.sockets]);
    if (gone) rooms.delete(key); // the DO would be evicted too
  };
  const snapshotStats = (key, r) => history.set(key, { ...r.core.stats, byType: { ...r.core.stats.byType }, first: history.get(key)?.first ?? now(), last: now() });

  const http = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    // Dev-only (not in the Worker): a room's counters, for sims running the hub in its own process.
    if (path === "/_stats") {
      const q = new URL(req.url, "http://x").searchParams;
      const r = rooms.get(`room:${q.get("room")}`);
      if (r && q.get("reset")) {
        Object.assign(r.core.stats, { handleMs: 0, handled: 0, handleMaxMs: 0, fanoutMs: 0, fanoutMaxMs: 0, broadcasts: 0, chunks: 0, chunkMs: 0, chunkMaxMs: 0 });
        r.core.samples = { handle: [], chunk: [] };
      }
      res.writeHead(r ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(r ? { stats: r.core.stats, samples: r.core.samples ?? null } : {}));
      return;
    }
    if (path === "/usage") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await meter.report({ countRequest: true })));
      return;
    }
    // POST /mint — as worker.js (no room touched).
    if (path === "/mint") {
      await counted({ workerExtra: 1 });
      if (req.method !== "POST") return void res.writeHead(req.method === "OPTIONS" ? 204 : 405, { "access-control-allow-origin": "*" }).end();
      let text = "";
      for await (const c of req) {
        text += c;
        if (text.length > 4096) break;
      }
      const r = await decideMint({ secret, text, ip: ipOf(req), origin: req.headers.origin ?? null, now: now(), cfg, limiters });
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }).end(JSON.stringify(r.body));
      return;
    }
    if (!relay && /^\/relay(\/|$)/.test(path)) {
      await counted({ workerExtra: 1 });
      return void res.writeHead(410).end("gone");
    }
    // GET /room/<id>/result — as worker.js (checked friends rooms only, CORS, 10 s cache).
    const rr = /^\/room\/([^/]+)\/result$/.exec(path);
    if (rr && req.method === "GET") {
      const d = isFriendRoom(rr[1]) ? await decideResult({ secret, roomId: rr[1], params: new URL(req.url, "http://x").searchParams, now: now(), cfg }) : { notFound: true };
      let read = { rec: null, startAt: null };
      if (d.notFound) {
        counts.workerDenied += 1;
        await counted({ workerExtra: 1 });
      } else {
        const adm = d.forward.admit ? await verifyAdmit(secret, d.forward.admit, rr[1], now()) : null;
        read = await roomFor("room", rr[1]).core.readRoom(adm);
      }
      const { status, body } = roomReadBody(read);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "public, max-age=10", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
      return;
    }
    const m = ROUTE.exec(path);
    res.writeHead(m && ROOM_ID_RE.test(m[2]) ? 426 : 404).end(m ? "websocket only" : "not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  /** A refused upgrade, as the Worker's own WebSocketPair: `denied` then the close code. */
  const refuse = (req, socket, head, { reason, close, ...extra }) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ t: "denied", d: { reason, ...extra } }));
      ws.close(close, reason);
    });
  http.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    const u = new URL(req.url, "http://x");
    const m = ROUTE.exec(u.pathname);
    if (!m || !ROOM_ID_RE.test(m[2])) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (m[1] === "relay") {
      if (relay) return void wss.handleUpgrade(req, socket, head, (ws) => attach(ws, "relay", m[2]));
      await counted({ workerExtra: 1 });
      return void socket.end("HTTP/1.1 410 Gone\r\n\r\n");
    }
    const roomId = m[2];
    // The Worker's side (worker.js fetch): no room is touched unless the code, PIN and limits pass.
    const d = await decideUpgrade({
      secret,
      roomId,
      params: u.searchParams,
      ip: ipOf(req),
      origin: req.headers.origin ?? null,
      now: now(),
      cfg,
      limiters,
      pinAttempt: (ipKey) => roomFor("room", roomId).core.pinAttempt(ipKey),
    });
    if (d.deny) {
      counts.workerDenied += 1;
      if (d.rpc) counts.pinRpc += 1;
      await counted({ workerExtra: 1, doExtra: d.rpc ? 1 + (d.alarms ?? 0) : 0, rows: d.rows ?? 0 });
      return refuse(req, socket, head, d.deny);
    }
    // The Durable Object's side (worker.js Game.fetch): a valid admit claim, then the right-PIN check.
    const adm = await verifyAdmit(secret, d.forward.admit, roomId, now());
    if (!adm) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const no = await roomFor("room", roomId).core.upgradeCheck(adm);
    if (no) return refuse(req, socket, head, { ...no, close: 4003 });
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, "room", roomId, adm));
  });

  const attach = (ws, kind, id, adm = null) => {
    const r = roomFor(kind, id);
    const key = `${kind}:${id}`;
    let state = {};
    let pongAt = null;
    const sock = {
      ws,
      /** The auto-response's last answer to this socket (#142; ms, null = never) — tests may set it. */
      pongAt: () => pongAt,
      setPongAt: (t) => (pongAt = t),
      get state() {
        return state;
      },
      save(s) {
        state = s;
      },
      send(str) {
        if (ws.readyState === 1) ws.send(str);
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
      },
    };
    r.sockets.add(sock);
    if (kind === "room") {
      r.core.onOpen(sock, adm);
      ws.on("message", (data, isBinary) => {
        const msg = isBinary ? data : data.toString();
        if (autoResponse && !isBinary && msg === PING) {
          pongAt = now(); // answered by "the runtime": the room never sees it
          counts.pongs += 1;
          return void (ws.readyState === 1 && ws.send(PONG));
        }
        r.core.onMessage(sock, msg).catch(() => {});
      });
      ws.on("close", () => {
        r.core.onClose(sock).finally(() => {
          r.sockets.delete(sock);
          snapshotStats(key, r);
        });
      });
    } else {
      r.core.onOpen(sock, [...r.sockets]);
      // Messages of one socket are handled in order (as a DO delivers them).
      let chain = Promise.resolve();
      ws.on("message", (data, isBinary) => {
        const msg = isBinary ? data : data.toString();
        chain = chain.then(() => r.core.onMessage(sock, msg, [...r.sockets])).catch(() => {});
      });
      ws.on("close", () => {
        chain = chain.then(async () => {
          r.sockets.delete(sock);
          await r.core.onClose(sock, [...r.sockets, sock]);
          snapshotStats(key, r);
        });
      });
    }
    ws.on("error", () => {});
  };

  await new Promise((res, rej) => {
    http.once("error", rej);
    http.listen(port, host, res);
  });
  const actual = http.address().port;
  return {
    url: `ws://${host}:${actual}`,
    port: actual,
    meter,
    secret,
    /** What the Worker side answered itself (no room touched, except a wrong PIN's RPC). */
    counts,
    /** "room:<id>" / "relay:<id>" → { core, store, sockets } */
    rooms,
    room: (id) => rooms.get(`room:${id}`),
    relay: (id) => rooms.get(`relay:${id}`),
    /** Stats per "kind:id" (live rooms refreshed). */
    history() {
      for (const [key, r] of rooms) if (r.sockets.size) snapshotStats(key, r);
      return history;
    },
    /** Run a room's cleanup alarm now (tests; the real one fires roomTtlMs after it empties). */
    fireAlarm: (id, kind = "relay") => fireAlarm(`${kind}:${id}`),
    async close() {
      for (const r of rooms.values()) {
        clearTimeout(r.alarm);
        if (r.kind === "room") r.core.forget();
        for (const s of r.sockets) s.ws.terminate();
      }
      wss.close();
      await new Promise((res) => http.close(() => res()));
    },
  };
}

/** True for a relay URL on this machine (gates refuse anything else). */
export const isLocalRelay = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
};
