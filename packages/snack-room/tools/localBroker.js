// Local MQTT-over-WebSocket broker for tests, sims and the serverless oracle —
// so no gate ever depends on (or leaks traffic to) a public broker.
//
// Lossy mode imitates a busy public broker: every PUBLISH delivered to a
// subscriber is independently dropped (~5%) or delayed (50–300 ms), so
// messages also arrive out of order. Switch it at runtime with setLossy().
//
// Each connection is RE-BUFFERED both ways through an MQTT packet parser:
// browsers / mqtt.js may split one MQTT packet across WebSocket frames (and
// aedes may write one packet in several chunks); on Node 26 aedes stalled on
// split inbound packets. Whole packets in, whole packets out.
//
// aedes reads its input with `conn.read(null)` and expects ALL buffered bytes;
// on Node 26 that returns one pushed chunk per call. aedes then re-enters its
// parser from a packet that finished synchronously (a QoS 0 PUBLISH) to read
// the next chunk, and mqtt-packet's parser, re-entered mid-packet, emits the
// PUBLISH twice and swallows what followed: a SUBSCRIBE sent right behind a
// PUBLISH (mqtt.js flushing its offline queue at CONNACK) got no SUBACK, the
// stream desynced, and the next PUBLISH closed the connection ("Not supported").
// So the stream hands aedes everything buffered in one read.
import { Aedes } from "aedes";
import { WebSocketServer } from "ws";
import { Duplex } from "node:stream";
import mqttPacket from "mqtt-packet";

export const LOSSY_DEFAULT = { drop: 0.05, minDelay: 50, maxDelay: 300 };

/**
 * @param {{port?: number, host?: string, lossy?: boolean | {drop?: number, minDelay?: number, maxDelay?: number}, refuse?: boolean, cutOnSubscribe?: number, random?: () => number}} [o]
 *        refuse: answer every CONNECT with "server unavailable" (a broker that turns clients away)
 *        cutOnSubscribe: cut the connection on this many SUBSCRIBEs (before any SUBACK) — a
 *        connection that drops between CONNACK and SUBACK (what a busy public broker / network does)
 * @returns {Promise<{url: string, port: number, setLossy(l: boolean | object): void, stats: {delivered: number, dropped: number, publishes: number, bytes: number, cut: number, startedAt: number}, close(): Promise<void>}>}
 */
export async function startLocalBroker({ port = 0, host = "127.0.0.1", lossy = false, refuse = false, cutOnSubscribe = 0, random = Math.random } = {}) {
  const aedes = await Aedes.createBroker(
    refuse ? { authenticate: (_c, _u, _p, cb) => cb(Object.assign(new Error("Server unavailable"), { returnCode: 3 }), false) } : {},
  );
  let mode = null;
  const setLossy = (l) => {
    mode = l ? { ...LOSSY_DEFAULT, ...(typeof l === "object" ? l : {}) } : null;
  };
  setLossy(lossy);
  // delivered/dropped: per-subscriber deliveries in lossy mode (evidence that loss happened);
  // publishes/bytes: what clients published (payload bytes) — the room's broker load.
  const stats = { delivered: 0, dropped: 0, publishes: 0, bytes: 0, cut: 0, startedAt: Date.now() };
  const wss = new WebSocketServer({ host, port, handleProtocols: (protocols) => (protocols.has("mqtt") ? "mqtt" : false) });
  const sockets = new Set();

  wss.on("connection", (ws) => {
    sockets.add(ws);
    let opts = { protocolVersion: 4 };
    const send = (packet) => {
      if (ws.readyState === 1) ws.send(mqttPacket.generate(packet, opts));
    };
    // aedes → client
    const out = mqttPacket.parser(opts);
    out.on("packet", (packet) => {
      if (packet.cmd !== "publish" || !mode) return send(packet);
      if (random() < mode.drop) {
        stats.dropped += 1;
        return;
      }
      stats.delivered += 1;
      setTimeout(() => send(packet), mode.minDelay + random() * (mode.maxDelay - mode.minDelay));
    });
    out.on("error", () => ws.terminate());
    const stream = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        out.parse(chunk);
        cb();
      },
      final(cb) {
        ws.close();
        cb();
      },
      destroy(err, cb) {
        ws.terminate();
        cb(err);
      },
    });
    // client → aedes
    const inp = mqttPacket.parser(opts);
    inp.on("packet", (packet) => {
      if (packet.cmd === "connect") {
        opts = { protocolVersion: packet.protocolVersion || 4 };
        inp.settings = opts;
        out.settings = opts;
      } else if (packet.cmd === "subscribe" && cutOnSubscribe > 0) {
        cutOnSubscribe -= 1;
        stats.cut += 1;
        return ws.terminate();
      } else if (packet.cmd === "publish") {
        stats.publishes += 1;
        stats.bytes += packet.payload.length;
      }
      stream.push(mqttPacket.generate(packet, opts));
    });
    inp.on("error", () => ws.terminate());
    ws.on("message", (data) => inp.parse(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on("close", () => {
      sockets.delete(ws);
      stream.push(null);
      stream.destroy();
    });
    ws.on("error", () => stream.destroy());
    const readOne = stream.read.bind(stream);
    stream.read = (n) => {
      if (n != null) return readOne(n);
      const parts = [];
      for (let c = readOne(); c !== null; c = readOne()) parts.push(c);
      return parts.length > 1 ? Buffer.concat(parts) : (parts[0] ?? null);
    };
    aedes.handle(stream);
  });

  await new Promise((res, rej) => {
    wss.once("listening", res);
    wss.once("error", rej);
  });
  const actualPort = wss.address().port;
  return {
    url: `ws://${host}:${actualPort}/mqtt`,
    aedes, // for harnesses that log broker events (client / clientDisconnect / subscribe …)
    port: actualPort,
    setLossy,
    get lossy() {
      return Boolean(mode);
    },
    stats,
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise((res) => wss.close(() => res()));
      await new Promise((res) => aedes.close(() => res()));
    },
  };
}

/** True for a broker URL on this machine (gates refuse anything else). */
export const isLocalBroker = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
};
