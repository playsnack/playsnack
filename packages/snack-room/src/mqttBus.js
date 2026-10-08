// Pub/sub bus for serverless rooms over MQTT-over-WebSocket. One topic per room;
// every message is JSON. The broker publishes our "bye" if we vanish without
// closing (MQTT last will), so others react at once instead of waiting.
import mqtt from "mqtt";

// Free public brokers — no account, no guarantees. Fastest from Korea (2026-10)
// first. Room traffic is public on these (nicknames + game actions only).
export const PUBLIC_BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081/mqtt", "wss://broker.hivemq.com:8884/mqtt"];

/** Returns a `createBus(peerId)` for connectMesh. */
export function mqttBus({ url = PUBLIC_BROKERS[0], room, prefix = "snackapp/v1" }) {
  const topic = `${prefix}/${room}`;
  return (peerId) => {
    const client = mqtt.connect(url, {
      clientId: `snk_${peerId}`.slice(0, 23),
      clean: true,
      keepalive: 10,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
      will: { topic, payload: JSON.stringify({ from: peerId, t: "bye" }), qos: 0, retain: false },
    });
    const handlers = [];
    let subscribed;
    const ready = new Promise((r) => (subscribed = r));
    client.on("connect", () => client.subscribe(topic, { qos: 0 }, () => subscribed()));
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
      publish: (m) => client.publish(topic, JSON.stringify(m), { qos: 0 }),
      onMessage: (fn) => handlers.push(fn),
      // Graceful end: our own "bye" is already out, so no last will is sent.
      close: () => setTimeout(() => client.end(false), 50),
    };
  };
}
