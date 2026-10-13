// The real MQTT path: mqttBus ↔ the local broker (aedes over WebSocket), lossy mode included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import mqttPacket from "mqtt-packet";
import { startLocalBroker, isLocalBroker } from "../tools/localBroker.js";
import { mqttBus } from "../src/mqttBus.js";
import { connectMesh } from "../src/meshClient.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 25) => {
  for (let t = 0; t < ms && !fn(); t += step) await sleep(step);
  return fn();
};

test("broker: an MQTT packet split across WebSocket frames still gets through", async () => {
  const b = await startLocalBroker();
  const ws = new WebSocket(b.url, "mqtt");
  await new Promise((r) => ws.once("open", r));
  const packets = [];
  const parser = mqttPacket.parser();
  parser.on("packet", (p) => packets.push(p));
  ws.on("message", (d) => parser.parse(d));
  const connect = mqttPacket.generate({ cmd: "connect", protocolId: "MQTT", protocolVersion: 4, clean: true, clientId: "split", keepalive: 10 });
  ws.send(connect.subarray(0, 5));
  await sleep(30);
  ws.send(connect.subarray(5));
  assert.ok(await until(() => packets.some((p) => p.cmd === "connack" && p.returnCode === 0), 2000));
  ws.close();
  await b.close();
});

// A PUBLISH and a SUBSCRIBE back to back — what mqtt.js sends when it flushes a QoS 0
// message queued while offline right before subscribing (a slow page: the mesh beat
// fired before CONNACK). One WebSocket frame (the browser coalesces them) or two.
for (const frames of [1, 2]) {
  test(`broker: PUBLISH then SUBSCRIBE in ${frames} frame(s) → SUBACK, and the connection stays usable`, async () => {
    const b = await startLocalBroker();
    const errors = [];
    b.aedes.on("clientError", (_c, e) => errors.push(e.message));
    const ws = new WebSocket(b.url, "mqtt");
    await new Promise((r) => ws.once("open", r));
    const packets = [];
    const parser = mqttPacket.parser();
    parser.on("packet", (p) => packets.push(p));
    ws.on("message", (d) => parser.parse(d));
    const gen = (p) => mqttPacket.generate(p, { protocolVersion: 4 });
    ws.send(gen({ cmd: "connect", protocolId: "MQTT", protocolVersion: 4, clean: true, clientId: `pubsub${frames}`, keepalive: 10 }));
    assert.ok(await until(() => packets.some((p) => p.cmd === "connack"), 2000));
    const pub = gen({ cmd: "publish", topic: "t/room", payload: Buffer.from(JSON.stringify({ t: "here", nick: "심야 펭귄" })), qos: 0 });
    const sub = gen({ cmd: "subscribe", messageId: 7, subscriptions: [{ topic: "t/room", qos: 0 }] });
    if (frames === 1) ws.send(Buffer.concat([pub, sub]));
    else {
      ws.send(pub);
      ws.send(sub);
    }
    assert.ok(await until(() => packets.some((p) => p.cmd === "suback" && p.messageId === 7), 2000), "no SUBACK");
    ws.send(gen({ cmd: "publish", topic: "t/room", payload: Buffer.from("{}"), qos: 0 })); // the next beat
    assert.ok(await until(() => packets.some((p) => p.cmd === "publish"), 2000), "subscribed: own publish comes back");
    assert.deepEqual(errors, []);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await b.close();
  });
}

test("broker: lossy mode drops ~5% and reorders; switchable at runtime", async () => {
  const b = await startLocalBroker({ lossy: true });
  const got = [];
  const sub = mqttBus({ url: b.url, room: "loss" })("sub");
  sub.onMessage((m) => got.push(m.i));
  const pub = mqttBus({ url: b.url, room: "loss" })("pub");
  await Promise.all([sub.ready, pub.ready]);
  for (let i = 0; i < 400; i++) pub.publish({ i });
  await sleep(700);
  const lost = 400 - got.filter((x) => x !== undefined).length;
  assert.ok(lost > 0 && lost < 50, `lost ${lost}/400`);
  assert.ok(got.some((x, i) => i > 0 && x < got[i - 1]), "reordered");
  b.setLossy(false);
  got.length = 0;
  for (let i = 0; i < 100; i++) pub.publish({ i });
  await sleep(300);
  assert.deepEqual(got, [...Array(100).keys()]);
  sub.close();
  pub.close();
  await sleep(100);
  await b.close();
});

test("mqttBus: unreachable broker → failed after the deadline (no endless retry)", async () => {
  const b = await startLocalBroker();
  const url = b.url;
  await b.close(); // nothing listens there now
  const statuses = [];
  const bus = mqttBus({ url, room: "x", failAfterMs: 400 })("p");
  bus.onStatus((s) => statuses.push(s));
  assert.ok(await until(() => statuses.length > 0, 2000));
  assert.deepEqual(statuses, [{ state: "failed", reason: "timeout" }]);
  bus.close();
});

test("mqttBus: a broker that refuses the connection → failed at once", async () => {
  const b = await startLocalBroker({ refuse: true });
  const statuses = [];
  const t0 = Date.now();
  const bus = mqttBus({ url: b.url, room: "x", failAfterMs: 5000 })("p");
  bus.onStatus((s) => statuses.push(s));
  assert.ok(await until(() => statuses.length > 0, 3000));
  assert.equal(statuses[0].state, "failed");
  assert.match(statuses[0].reason, /^refused/);
  assert.ok(Date.now() - t0 < 2000);
  await sleep(1500); // no reconnect attempts after giving up
  assert.equal(statuses.length, 1);
  bus.close();
  await b.close();
});

test("mqttBus: the connection drops before SUBACK → reconnects and subscribes (no permanent 'subscribe' failure)", async () => {
  const b = await startLocalBroker({ cutOnSubscribe: 1 });
  const statuses = [];
  const bus = mqttBus({ url: b.url, room: "cut", failAfterMs: 6000 })("cutp");
  bus.onStatus((s) => statuses.push(s));
  let ready = false;
  bus.ready.then(() => (ready = true));
  assert.ok(await until(() => ready || statuses.length > 0, 6000), "neither ready nor failed");
  assert.equal(b.stats.cut, 1, "the broker cut the first SUBSCRIBE");
  assert.deepEqual(statuses, []);
  assert.ok(ready, "subscribed after the drop");
  // and it really is subscribed: a message on the room topic arrives
  const got = [];
  bus.onMessage((m) => got.push(m));
  const other = mqttBus({ url: b.url, room: "cut" })("cutq");
  await other.ready;
  other.publish({ hi: 1 });
  assert.ok(await until(() => got.length > 0, 2000), "no message after resubscribe");
  bus.close();
  other.close();
  await sleep(100);
  await b.close();
});

test("mqttBus: the connection keeps dropping before SUBACK → failed 'subscribe' after a bounded number of tries", async () => {
  const b = await startLocalBroker({ cutOnSubscribe: 100 });
  const statuses = [];
  const t0 = Date.now();
  const bus = mqttBus({ url: b.url, room: "cut2", failAfterMs: 8000 })("cutr");
  bus.onStatus((s) => statuses.push(s));
  assert.ok(await until(() => statuses.length > 0, 9000));
  assert.deepEqual(statuses, [{ state: "failed", reason: "subscribe" }]);
  assert.ok(b.stats.cut >= 3, `tried ${b.stats.cut}×`);
  assert.ok(Date.now() - t0 < 7000, `gave up after ${Date.now() - t0} ms`);
  const cuts = b.stats.cut;
  await sleep(1500); // no more attempts after giving up
  assert.equal(b.stats.cut, cuts);
  bus.close();
  await b.close();
});

test("mqttBus: a refused subscription (SUBACK 0x80) is tried again on the same connection", async () => {
  const b = await startLocalBroker();
  let refusals = 1;
  b.aedes.authorizeSubscribe = (_client, sub, cb) => (refusals-- > 0 ? cb(null, null) : cb(null, sub)); // null → granted 0x80
  const statuses = [];
  const bus = mqttBus({ url: b.url, room: "refused" })("refp");
  bus.onStatus((s) => statuses.push(s));
  let ready = false;
  bus.ready.then(() => (ready = true));
  assert.ok(await until(() => ready || statuses.length > 0, 4000));
  assert.ok(ready, JSON.stringify(statuses));
  assert.equal(refusals, -1, "subscribed on the 2nd try");
  bus.close();
  await sleep(100);
  await b.close();
});

test("mesh over the lossy local broker: 3 players, exact tap race", async () => {
  const b = await startLocalBroker({ lossy: true });
  const T = { discoveryMs: 400, beatMs: 200, silenceMs: 1500, snapshotMs: 100, resendMs: 700 };
  const ps = [1, 2, 3].map((n) => {
    const shared = {};
    const statuses = [];
    const conn = connectMesh({
      createBus: mqttBus({ url: b.url, room: "race" }),
      me: { slug: "race", anonId: `a${n}`, nick: `닉${n}` },
      timing: T,
      onStatus: (s) => statuses.push(s.state),
      onMessage: (m) => {
        if (m.t === "state") Object.assign(shared, m.d.sharedState, { participants: m.d.participants ?? shared.participants });
        else if (m.t === "setVar") shared[m.d.id] = m.d.value;
        else if (m.t === "participants") shared.participants = m.d.count;
      },
    });
    return { conn, shared, statuses, act: (name, payload) => conn.sendAction(name, payload, `${n}-${Math.random()}`) };
  });
  const total = (p) => (p.shared.raceBoard || []).reduce((s, e) => s + e.score, 0);
  assert.ok(await until(() => ps.every((p) => p.shared.participants === 3), 8000), "room formed");
  assert.ok(ps.every((p) => p.statuses.join() === "connecting,connected"));
  ps[2].act("start", { duration: 3000 });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play"), 6000), "play");
  for (let k = 0; k < 5; k++) {
    ps.forEach((p) => p.act("tap"));
    await sleep(40);
  }
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "result" && total(p) === 15), 8000), JSON.stringify(ps.map(total)));
  assert.equal(new Set(ps.map((p) => JSON.stringify(p.shared.raceBoard))).size, 1);
  ps.forEach((p) => p.conn.close());
  await sleep(150);
  await b.close();
});

test("isLocalBroker only accepts this machine", () => {
  assert.ok(isLocalBroker("ws://127.0.0.1:1883/mqtt"));
  assert.ok(isLocalBroker("ws://localhost:9/mqtt"));
  assert.ok(!isLocalBroker("wss://broker.hivemq.com:8884/mqtt"));
  assert.ok(!isLocalBroker("not a url"));
});
