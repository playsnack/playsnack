// Pub/sub bus for serverless rooms over MQTT-over-WebSocket. One topic per room;
// every message is JSON. The broker publishes our "bye" if we vanish without
// closing (MQTT last will), so others react at once instead of waiting.
import mqtt from "mqtt";

// One broker per deployment (the player overrides it once, via VITE_BROKER_URL).
// No per-client failover: players on different brokers would never meet.
// Public, no account, no guarantees — room traffic is public (nicknames + actions).
export const DEFAULT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
const FAIL_AFTER_MS = 8000; // not connected for this long → give up (the player shows retry)
const RECONNECT_MS = 1000;
// A subscribe that fails (the connection dropped before SUBACK, or the broker refused it)
// is tried again after 0.5 s, 1 s — the 3rd failure in a row gives up (≈ 2–4 s in all).
const SUBSCRIBE_TRIES = 3;
const subscribeBackoff = (tries) => 500 * 2 ** (tries - 1);

// CONNACK refusals (MQTT 3.1.1 codes 1–5, MQTT 5 reason codes ≥ 0x80): retrying won't help.
const isRefusal = (err) => typeof err?.code === "number" && ((err.code >= 1 && err.code <= 5) || err.code >= 0x80);

/** Returns a `createBus(peerId)` for connectMesh. */
export function mqttBus({ url = DEFAULT_BROKER, room, prefix = "snackapp/v1", failAfterMs = FAIL_AFTER_MS }) {
  const topic = `${prefix}/${room}`;
  return (peerId) => {
    const client = mqtt.connect(url, {
      clientId: `snk_${peerId}`.slice(0, 23),
      clean: true,
      keepalive: 10,
      reconnectPeriod: RECONNECT_MS,
      resubscribe: false, // we subscribe on every "connect" ourselves (and count the tries)
      connectTimeout: failAfterMs,
      will: { topic, payload: JSON.stringify({ from: peerId, t: "bye" }), qos: 0, retain: false },
    });
    const handlers = [];
    const statusFns = [];
    let subscribed;
    const ready = new Promise((r) => (subscribed = r));
    let ending = false;
    let failed = null;
    let downTimer = null;
    let subTries = 0; // subscribe attempts since the last SUBACK
    let subTimer = null;
    const fail = (reason) => {
      if (failed || ending) return;
      failed = reason;
      clearTimeout(downTimer);
      clearTimeout(subTimer);
      ending = true;
      client.end(true);
      for (const fn of statusFns) fn({ state: "failed", reason });
    };
    // Disconnected (or never connected): reconnects are allowed for a while, then we stop.
    const armDown = () => {
      if (ending || downTimer) return;
      downTimer = setTimeout(() => fail("timeout"), failAfterMs);
    };
    armDown();
    // Subscribe on every (re)connect. A failure is not final: a connection that drops
    // before SUBACK reconnects (after the backoff) and subscribes again; a refused
    // subscription is tried again on the same connection. SUBSCRIBE_TRIES in a row → failed.
    const subscribe = () => {
      if (ending || !client.connected) return;
      subTries += 1;
      client.subscribe(topic, { qos: 0 }, (err, granted) => {
        if (ending) return;
        if (!err && !granted?.some((g) => g.qos === 128)) {
          subTries = 0;
          client.options.reconnectPeriod = RECONNECT_MS;
          return subscribed();
        }
        if (subTries >= SUBSCRIBE_TRIES) return fail("subscribe");
        const wait = subscribeBackoff(subTries);
        // Dropped before SUBACK: mqtt.js reconnects after reconnectPeriod and "connect"
        // subscribes again. Still connected (refused): the timer tries on this connection.
        client.options.reconnectPeriod = wait;
        subTimer = setTimeout(subscribe, wait);
      });
    };
    client.on("connect", () => {
      clearTimeout(downTimer);
      downTimer = null;
      clearTimeout(subTimer);
      subscribe();
    });
    client.on("offline", armDown);
    client.on("close", armDown);
    client.on("error", (err) => {
      if (isRefusal(err)) fail(`refused: ${err.message || err.code}`);
    });
    client.on("message", (_t, payload) => {
      let m;
      try {
        m = JSON.parse(payload.toString());
      } catch {
        return;
      }
      for (const fn of handlers) fn(m);
    });
    return {
      ready,
      publish: (m) => {
        if (!ending) client.publish(topic, JSON.stringify(m), { qos: 0 });
      },
      onMessage: (fn) => handlers.push(fn),
      onStatus: (fn) => {
        statusFns.push(fn);
        if (failed) fn({ state: "failed", reason: failed });
      },
      // Graceful end: our own "bye" is already out, so no last will is sent.
      close: () => {
        ending = true;
        clearTimeout(downTimer);
        clearTimeout(subTimer);
        setTimeout(() => client.end(false), 50);
      },
    };
  };
}
