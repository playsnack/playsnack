// Node stand-in for the Cloudflare edge rooms (edge/room): the SAME platform-free
// logic the Durable Objects run, behind a `ws` server — so tests and sims run without
// wrangler. Rooms live in memory.
//   /room/<id>   server-authoritative game room (edge/room/src/game.js — the engine runs here)
//   /relay/<id>  dumb relay for the serverless mesh (edge/room/src/core.js RoomRelay)
// Accounting for docs/edge-rooms.md: every room keeps its counters after it empties
// (`history`), so a sim can report messages per player per game.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { RoomRelay, UsageMeter, memoryStore, ROOM_ID_RE } from "../../../edge/room/src/core.js";
import { GameRoom } from "../../../edge/room/src/game.js";
import { StatsSender, isFriendRoom } from "../../../edge/room/src/results.js";

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
 * @param {{port?: number, host?: string, secret?: string, limits?: object, now?: () => number, stages?: object, free?: object, getPack?: Function, stats?: object}} [o]
 */
export async function startEdgeHub({ port = 4550, host = "127.0.0.1", secret = "hub-test-secret", limits = {}, now = Date.now, stages, free, getPack = filePack, stats = null } = {}) {
  const meterStore = memoryStore();
  const meter = new UsageMeter({ store: meterStore, now, ...(stages ? { stages } : {}), ...(free ? { free } : {}) });
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
    // GET /room/<id>/result — as worker.js (friends rooms only, CORS, 10 s cache).
    const rr = /^\/room\/([^/]+)\/result$/.exec(path);
    if (rr && req.method === "GET") {
      const rec = isFriendRoom(rr[1]) ? await roomFor("room", rr[1]).core.readResult() : null;
      res.writeHead(rec ? 200 : 404, { "content-type": "application/json", "cache-control": "public, max-age=10", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(rec ? { ok: true, result: rec } : { ok: false, error: "not_found" }));
      return;
    }
    const m = ROUTE.exec(path);
    res.writeHead(m && ROOM_ID_RE.test(m[2]) ? 426 : 404).end(m ? "websocket only" : "not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    const m = ROUTE.exec(new URL(req.url, "http://x").pathname);
    if (!m || !ROOM_ID_RE.test(m[2])) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1], m[2]));
  });

  const attach = (ws, kind, id) => {
    const r = roomFor(kind, id);
    const key = `${kind}:${id}`;
    let state = {};
    const sock = {
      ws,
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
      r.core.onOpen(sock);
      ws.on("message", (data, isBinary) => r.core.onMessage(sock, isBinary ? data : data.toString()).catch(() => {}));
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
