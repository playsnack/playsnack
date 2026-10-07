// Thin relay for host mode: routes messages between the players of a room and
// picks who hosts. No game logic and no room state beyond who is connected —
// the host player's device runs the room engine (@snack/room relayClient).
import { WebSocketServer } from "ws";

const MAX_PER_SECOND = 15; // same abuse guard as the server-run rooms
const HOST_SILENCE_MS = 3000; // no snapshot/heartbeat for this long → the host is stalled

export function attachRelay(server, { path = "/relay" } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  // slug → { peers: Map<peerId, {ws, anonId, nick}>, hostId, snapshot, snapAt, lastBeat }
  const rooms = new Map();
  let seq = 0;
  const out = (ws, t, d) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t, d }));
  };

  // Hand the room to the longest-present other player, with the host's latest
  // snapshot so the game continues where it was. A still-connected old host is
  // demoted to a normal player.
  const migrate = (r, oldId) => {
    const next = [...r.peers.keys()].find((id) => id !== oldId);
    if (!next) return;
    r.hostId = next;
    r.lastBeat = Date.now();
    const peers = [...r.peers].map(([id, p]) => ({ peerId: id, anonId: p.anonId, nick: p.nick }));
    out(r.peers.get(next).ws, "become-host", { peers, snapshot: r.snapshot ?? null, age: r.snapAt ? Date.now() - r.snapAt : 0 });
    if (r.peers.has(oldId)) out(r.peers.get(oldId).ws, "demote", {});
  };
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) if (r.peers.size > 1 && now - (r.lastBeat ?? now) > HOST_SILENCE_MS) migrate(r, r.hostId);
  }, 1000);
  watchdog.unref?.();

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== path) return; // other WS paths handle themselves
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    const peerId = `r${++seq}`;
    let slug = null;
    ws.on("message", (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      const { t, d } = m;
      const room = slug && rooms.get(slug);
      if (t === "hello" && !slug) {
        slug = String(d?.slug ?? "");
        const r = rooms.get(slug) ?? { peers: new Map(), hostId: null, snapshot: null, snapAt: 0, lastBeat: Date.now() };
        rooms.set(slug, r);
        r.peers.set(peerId, { ws, anonId: String(d?.anonId ?? ""), nick: String(d?.nick ?? "") });
        if (!r.hostId) {
          r.hostId = peerId;
          r.lastBeat = Date.now();
        }
        out(ws, "welcome", { peerId, hostId: r.hostId });
        if (r.hostId !== peerId) out(r.peers.get(r.hostId)?.ws, "peer-join", { peerId, anonId: d?.anonId, nick: d?.nick });
        return;
      }
      if (!room) return;
      if (peerId === room.hostId) {
        // Host → everyone else, or → one peer; plus liveness + resumable state.
        room.lastBeat = Date.now();
        if (t === "broadcast") {
          for (const [id, p] of room.peers) if (id !== peerId) out(p.ws, d?.t, d?.d);
        } else if (t === "send") {
          out(room.peers.get(d?.peerId)?.ws, d?.t, d?.d);
        } else if (t === "snapshot") {
          room.snapshot = d?.snap ?? null;
          room.snapAt = Date.now();
        } else if (t === "handoff") migrate(room, peerId); // e.g. the host's app went to the background
        return;
      }
      if (t === "action" || t === "react") {
        const now = Date.now();
        ws.times = (ws.times || []).filter((x) => now - x < 1000);
        ws.times.push(now);
        if (ws.times.length > MAX_PER_SECOND) return out(ws, "actionAck", { clientMsgId: d?.clientMsgId, accepted: false, reason: "rate_limited" });
        out(room.peers.get(room.hostId)?.ws, "from", { peerId, kind: t, d });
      }
    });
    ws.on("close", () => {
      const r = slug && rooms.get(slug);
      if (!r) return;
      r.peers.delete(peerId);
      if (r.peers.size === 0) {
        rooms.delete(slug);
        return;
      }
      if (r.hostId === peerId) {
        migrate(r, peerId); // host left: the longest-present player takes over
      } else {
        out(r.peers.get(r.hostId)?.ws, "peer-leave", { peerId });
      }
    });
  });

  return {
    close: () => clearInterval(watchdog),
    /** Players currently connected through the relay in a room. */
    size: (slug) => rooms.get(slug)?.peers.size ?? 0,
    rooms,
  };
}
