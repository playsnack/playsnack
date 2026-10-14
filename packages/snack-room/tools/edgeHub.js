// Node stand-in for the Cloudflare room relay (edge/room): the SAME core.js logic
// (auth, PIN lockout, tokens, relay, bye, cleanup alarm, usage guard) behind a `ws`
// server, so tests and sims run without wrangler. Rooms live in memory.
//
// Accounting for docs/edge-relay.md: every room keeps its counters after it empties
// (`history`), so a sim can report messages per player per game.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { RoomRelay, UsageMeter, memoryStore, ROOM_ID_RE } from "../../../edge/room/src/core.js";

/**
 * @param {{port?: number, host?: string, secret?: string, limits?: object, now?: () => number, usageShare?: number, free?: object}} [o]
 */
export async function startEdgeHub({ port = 4550, host = "127.0.0.1", secret = "hub-test-secret", limits = {}, now = Date.now, usageShare = 0.7, free } = {}) {
  const meterStore = memoryStore();
  const meter = new UsageMeter({ store: meterStore, now, share: usageShare, ...(free ? { free } : {}) });
  const rooms = new Map(); // id → { relay, store, sockets: Set<adapter>, alarm }
  const history = new Map(); // id → stats of the room (kept after it empties)

  const roomFor = (id) => {
    let r = rooms.get(id);
    if (r) return r;
    const store = memoryStore();
    r = { store, sockets: new Set(), alarm: null, alarmAt: null };
    r.relay = new RoomRelay({
      roomId: id,
      store,
      secret,
      usage: meter,
      now,
      limits,
      setAlarm: (at) => {
        clearTimeout(r.alarm);
        r.alarmAt = at;
        r.alarm = setTimeout(() => fireAlarm(id), Math.max(0, at - now()));
        r.alarm.unref?.();
      },
    });
    rooms.set(id, r);
    history.set(id, { ...r.relay.stats, first: now(), last: now() });
    return r;
  };
  const fireAlarm = async (id) => {
    const r = rooms.get(id);
    if (!r) return;
    r.alarm = null;
    r.alarmAt = null;
    if (await r.relay.onAlarm([...r.sockets])) rooms.delete(id); // the DO would be evicted too
  };
  const snapshotStats = (id, r) => history.set(id, { ...r.relay.stats, byType: { ...r.relay.stats.byType }, first: history.get(id)?.first ?? now(), last: now() });

  const http = createServer((req, res) => {
    const m = /^\/room\/([^/]+)$/.exec(new URL(req.url, "http://x").pathname);
    res.writeHead(m && ROOM_ID_RE.test(m[1]) ? 426 : 404).end(m ? "websocket only" : "not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    const m = /^\/room\/([^/]+)$/.exec(new URL(req.url, "http://x").pathname);
    if (!m || !ROOM_ID_RE.test(m[1])) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, m[1]));
  });

  const attach = (ws, id) => {
    const r = roomFor(id);
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
    r.relay.onOpen(sock, [...r.sockets]);
    // Messages of one socket are handled in order (as a DO delivers them).
    let chain = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? data : data.toString();
      chain = chain.then(() => r.relay.onMessage(sock, msg, [...r.sockets])).catch(() => {});
    });
    ws.on("close", () => {
      chain = chain.then(async () => {
        r.sockets.delete(sock);
        await r.relay.onClose(sock, [...r.sockets, sock]);
        snapshotStats(id, r);
      });
    });
    ws.on("error", () => {});
  };

  await new Promise((res, rej) => {
    http.once("error", rej);
    http.listen(port, host, res);
  });
  const actual = http.address().port;
  const sockets = () => [...rooms.values()].reduce((n, r) => n + r.sockets.size, 0);
  return {
    url: `ws://${host}:${actual}`,
    port: actual,
    meter,
    rooms,
    /** Stats per room id (live rooms refreshed). */
    history() {
      for (const [id, r] of rooms) snapshotStats(id, r);
      return history;
    },
    sockets,
    /** Run a room's cleanup alarm now (tests; the real one fires roomTtlMs after it empties). */
    fireAlarm,
    async close() {
      for (const r of rooms.values()) {
        clearTimeout(r.alarm);
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
