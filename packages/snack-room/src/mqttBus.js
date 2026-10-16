// Pub/sub bus for serverless rooms over MQTT-over-WebSocket. One topic per room;
// every message is JSON. The broker publishes our "bye" if we vanish without
// closing (MQTT last will), so others react at once instead of waiting.
import mqtt from "mqtt";

// One broker per deployment (the player overrides it once, via VITE_BROKER_URL).
// No per-client failover: players on different brokers would never meet.
// Public, no account, no guarantees — room traffic is public (nicknames + actions).
export const DEFAULT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
// Joining: a public broker is sometimes slow — measured 2026-10-14 on broker.hivemq.com,
// 2 of 4 bare connects hit "connack timeout" twice (~20 s) before getting in. So one try
// waits CONNACK_TIMEOUT_MS for CONNACK, the next starts RECONNECT_MS later, and the join
// gives up only when the room topic is still not subscribed JOIN_BUDGET_MS after the first
// try (≈ 4 tries). The player says "slow, still trying" meanwhile (roomJoin.ts).
export const JOIN_BUDGET_MS = 42000;
export const CONNACK_TIMEOUT_MS = 10000;
const RECONNECT_MS = 1500;
// Joined, then the connection drops: reconnects are allowed this long (≈ 2 slow tries), then failed.
const DROP_BUDGET_MS = 22000;
// A subscribe that fails (the connection dropped before SUBACK, or the broker refused it)
// is tried again after 0.5 s, 1 s — the 3rd failure in a row gives up (≈ 2–4 s in all).
const SUBSCRIBE_TRIES = 3;
const subscribeBackoff = (tries) => 500 * 2 ** (tries - 1);

// CONNACK refusals (MQTT 3.1.1 codes 1–5, MQTT 5 reason codes ≥ 0x80): retrying won't help.
const isRefusal = (err) => typeof err?.code === "number" && ((err.code >= 1 && err.code <= 5) || err.code >= 0x80);

/**
 * Returns a `createBus(peerId)` for connectMesh.
 * failAfterMs: the join budget (first try → room topic subscribed); dropAfterMs: how long a
 * joined bus may stay disconnected. Each new connect try is reported as
 * {state: "attempt", attempt, reason} (reason = why the previous try ended) and counted in `attempts`.
 */
export function mqttBus({
  url = DEFAULT_BROKER,
  room,
  prefix = "playsnack/v1",
  failAfterMs = JOIN_BUDGET_MS,
  dropAfterMs = DROP_BUDGET_MS,
  connectTimeoutMs = CONNACK_TIMEOUT_MS,
  reconnectMs = RECONNECT_MS,
}) {
  const topic = `${prefix}/${room}`;
  return (peerId) => {
    const client = mqtt.connect(url, {
      clientId: `snk_${peerId}`.slice(0, 23),
      clean: true,
      keepalive: 10,
      reconnectPeriod: reconnectMs,
      resubscribe: false, // we subscribe on every "connect" ourselves (and count the tries)
      connectTimeout: connectTimeoutMs,
      will: { topic, payload: JSON.stringify({ from: peerId, t: "bye" }), qos: 0, retain: false },
    });
    const handlers = [];
    const statusFns = [];
    let subscribed;
    const ready = new Promise((r) => (subscribed = r));
    let ending = false;
    let failed = null;
    let joined = false; // subscribed at least once
    let attempts = 1; // connect tries so far (mqtt.js has started the first)
    let lastError = ""; // why the current try ended (reported with the next one)
    let downTimer = null;
    let subTries = 0; // subscribe attempts since the last SUBACK
    let subTimer = null;
    const emit = (s) => {
      for (const fn of statusFns) fn(s);
    };
    const fail = (reason) => {
      if (failed || ending) return;
      failed = reason;
      clearTimeout(joinTimer);
      clearTimeout(downTimer);
      clearTimeout(subTimer);
      ending = true;
      client.end(true);
      emit({ state: "failed", reason });
    };
    // Not subscribed within the join budget (however many tries that took) → failed.
    const joinTimer = setTimeout(() => fail("timeout"), failAfterMs);
    // Joined, then disconnected: reconnects are allowed for a while, then we stop.
    const armDown = () => {
      if (ending || downTimer || !joined) return;
      downTimer = setTimeout(() => fail("timeout"), dropAfterMs);
    };
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
          client.options.reconnectPeriod = reconnectMs;
          if (!joined) {
            joined = true;
            clearTimeout(joinTimer);
          }
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
      lastError = "";
      clearTimeout(downTimer);
      downTimer = null;
      clearTimeout(subTimer);
      subscribe();
    });
    client.on("offline", armDown);
    client.on("close", () => {
      if (!lastError) lastError = "closed";
      armDown();
    });
    client.on("reconnect", () => {
      if (ending) return;
      attempts += 1;
      const reason = lastError || "closed";
      lastError = "";
      emit({ state: "attempt", attempt: attempts, reason });
    });
    client.on("error", (err) => {
      if (isRefusal(err)) return fail(`refused: ${err.message || err.code}`);
      lastError = String(err?.message || "error").slice(0, 60);
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
      /** Connect tries so far (1 = the first one). */
      get attempts() {
        return attempts;
      },
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
        clearTimeout(joinTimer);
        clearTimeout(downTimer);
        clearTimeout(subTimer);
        setTimeout(() => client.end(false), 50);
      },
    };
  };
}
