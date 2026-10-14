// Edge room relay (edge/room/src/core.js): auth before relay, PIN lockout, tokens,
// bye on close, no listing, cleanup alarm, usage guard — and meshClient over wsBus.
// Runs against the Node hub (same core) by default; EDGE_URL=ws://127.0.0.1:4551 runs
// the shared cases against `wrangler dev` (start it with LOCK_MS=400 ROOM_TTL_MS=1500).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { wsBus } from "../src/wsBus.js";
import { connectMesh } from "../src/meshClient.js";
import { RoomRelay, RoomGate, UsageMeter, memoryStore, signToken, verifyToken } from "../../../edge/room/src/core.js";

const EXTERNAL = process.env.EDGE_URL || "";
const LOCK_MS = 400;
const TTL_MS = 1500;
let hub = null;
let URL_ = EXTERNAL;
const RUN = Date.now().toString(36);
const rid = (s) => `t-${RUN}-${s}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (EXTERNAL) return;
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT || 4552), limits: { lockMs: LOCK_MS, roomTtlMs: TTL_MS } });
  URL_ = hub.url;
});
after(async () => hub?.close());

/** A raw socket that records frames. */
function raw(room) {
  const ws = new WebSocket(`${URL_}/relay/${room}`);
  const got = [];
  const waiters = [];
  let closed = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    got.push(m);
    for (const w of waiters.splice(0)) w();
  };
  ws.onclose = (ev) => {
    closed = ev.code;
    for (const w of waiters.splice(0)) w();
  };
  const opened = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const c = {
    ws,
    got,
    get closed() {
      return closed;
    },
    send: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    /** Wait until a frame matches (or ms pass) → the frame or null. */
    async next(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = got.find(pred);
        if (hit) {
          got.splice(got.indexOf(hit), 1);
          return hit;
        }
        if (Date.now() >= end || closed !== null) return got.find(pred) ?? null;
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, Math.min(100, end - Date.now()));
        });
      }
    },
    async auth(peer, extra = {}) {
      await c.send({ t: "auth", peer, ...extra });
      return c.next((m) => m.ctl === "ok" || m.ctl === "denied");
    },
    async waitClosed(ms = 3000) {
      for (let t = 0; closed === null && t < ms; t += 50) await sleep(50);
      return closed;
    },
    close: () => ws.close(),
  };
  return c;
}

test("nothing is relayed before auth; an unauthed socket that talks is closed", async () => {
  const room = rid("preauth");
  const a = raw(room);
  assert.equal((await a.auth("pa")).ctl, "ok");
  const lurker = raw(room); // connected, never authenticates
  const talker = raw(room);
  await talker.send({ from: "pt", t: "here" }); // not an auth frame
  assert.equal(await talker.waitClosed(), 4001);
  await a.send({ from: "pa", t: "here", n: 1 });
  await sleep(300);
  assert.equal(a.got.length, 0, "the sender does not get its own publish");
  assert.equal(lurker.got.length, 0, "an unauthed socket receives nothing");
  assert.equal((await lurker.auth("pl")).ctl, "ok");
  await a.send({ from: "pa", t: "here", n: 2 });
  assert.equal((await lurker.next((m) => m.t === "here"))?.n, 2);
  // a frame claiming another sender is dropped
  await a.send({ from: "someone-else", t: "here", n: 3 });
  assert.equal(await lurker.next((m) => m.n === 3, 400), null);
  [a, lurker].forEach((x) => x.close());
});

test("wrong PIN: 3 per connection → closed; 5 in a row → locked, then the lock doubles", async () => {
  const room = rid("pin");
  const owner = raw(room);
  assert.equal((await owner.auth("own", { pin: "4321" })).ctl, "ok");
  owner.close();
  const g1 = raw(room);
  for (let i = 0; i < 3; i++) assert.equal((await g1.auth("g1", { pin: "0000" })).reason, "pin");
  assert.equal(await g1.waitClosed(), 4003);
  const g2 = raw(room);
  assert.equal((await g2.auth("g2", { pin: "0001" })).reason, "pin");
  const fifth = await g2.auth("g2", { pin: "0002" });
  assert.equal(fifth.reason, "locked");
  assert.equal(fifth.retryIn, LOCK_MS);
  g2.close();
  const g3 = raw(room);
  assert.equal((await g3.auth("g3", { pin: "4321" })).reason, "locked", "even the right PIN waits out the lock");
  assert.equal((await g3.auth("g3")).reason, "pin-required", "no PIN at all is not an attempt");
  g3.close();
  await sleep(LOCK_MS + 100);
  const g4 = raw(room);
  for (let i = 0; i < 3; i++) await g4.auth("g4", { pin: `9${i}` });
  g4.close();
  const g5 = raw(room);
  await g5.auth("g5", { pin: "98" });
  const second = await g5.auth("g5", { pin: "97" });
  assert.equal(second.reason, "locked");
  assert.equal(second.retryIn, LOCK_MS * 2, "the second lock is twice as long");
  g5.close();
  await sleep(LOCK_MS * 2 + 100);
  const ok = raw(room);
  assert.equal((await ok.auth("ok", { pin: "4321" })).ctl, "ok");
  ok.close();
});

test("20 wrong PINs within an hour → locked for the rest of the hour", async () => {
  // Core level (no sockets): a 1 ms lock, so only the hourly cap can stop attempt 21.
  let t = 1000000;
  const gate = new RoomGate({ roomId: "hour", store: memoryStore(), secret: "s", now: () => t, limits: { lockMs: 1, maxLockMs: 1, pinIterations: 1000 } });
  assert.ok((await gate.check({ pin: "1111" }, {})).meta, "created with a PIN");
  let last;
  for (let i = 0; i < 21; i++) {
    t += 10;
    last = await gate.check({ pin: `x${i}` }, {});
  }
  assert.equal(last.deny, "locked");
  assert.ok(last.retryIn > 3500000, `retryIn ${last.retryIn}`);
  t += 3600001;
  assert.equal((await gate.check({ pin: "1111" }, {})).deny, undefined, "an hour later the right PIN works");
});

test("a token lets a dropped player back in without the PIN; another room refuses it", async () => {
  const room = rid("tok");
  const a = raw(room);
  const ok = await a.auth("ta", { pin: "2468" });
  assert.equal(ok.ctl, "ok");
  assert.ok(ok.token);
  a.ws.close();
  const back = raw(room);
  assert.equal((await back.auth("ta", { token: ok.token })).ctl, "ok");
  back.close();
  const other = rid("tok-other");
  const o = raw(other);
  await o.auth("ob", { pin: "1357" });
  o.close();
  const cross = raw(other);
  assert.equal((await cross.auth("ta", { token: ok.token })).reason, "pin-required");
  const forged = raw(room);
  assert.equal((await forged.auth("ta", { token: ok.token.slice(0, -2) + "AA" })).reason, "pin-required");
  [cross, forged].forEach((x) => x.close());
});

test("no room listing: only /room/<id> WebSocket upgrades exist", async () => {
  const http = URL_.replace(/^ws/, "http");
  for (const p of ["/", "/rooms", "/room", "/room/", "/room/a/b", "/room/..%2F", "/relay", "/relay/", "/relays"]) assert.equal((await fetch(http + p)).status, 404, p);
  assert.equal((await fetch(`${http}/room/${rid("x")}`)).status, 426);
  assert.equal((await fetch(`${http}/relay/${rid("x")}`)).status, 426);
});

test("bye: a socket that vanishes is announced once; a graceful leaver is not doubled", async () => {
  const room = rid("bye");
  const a = raw(room);
  const b = raw(room);
  const c = raw(room);
  for (const [x, p] of [[a, "ba"], [b, "bb"], [c, "bc"]]) assert.equal((await x.auth(p)).ctl, "ok");
  b.ws.close(); // no bye of its own (a crash / lost network)
  assert.deepEqual(await a.next((m) => m.t === "bye"), { from: "bb", t: "bye" });
  await c.send({ from: "bc", t: "bye" }); // graceful: its own bye, then close
  c.close();
  assert.deepEqual(await a.next((m) => m.t === "bye"), { from: "bc", t: "bye" });
  assert.equal(await a.next((m) => m.t === "bye", 500), null, "no second bye for bc");
  a.close();
});

test("cleanup alarm: storage is deleted after the last socket leaves (PIN gone, old token dead)", async () => {
  const room = rid("ttl");
  const a = raw(room);
  const ok = await a.auth("la", { pin: "5555" });
  a.close();
  await sleep(TTL_MS + 800);
  if (hub) assert.equal(Boolean(hub.relay(room)), false, "room dropped after the alarm");
  // Same id again: a NEW room (no PIN), and the old token's epoch no longer matches.
  const b = raw(room);
  const again = await b.auth("lb", { pin: "7777" });
  assert.equal(again.ctl, "ok", "a fresh room takes a new PIN");
  b.close();
  await sleep(100);
  const c = raw(room);
  assert.equal((await c.auth("la", { token: ok.token })).reason, "pin-required", "the old incarnation's token is refused");
  c.close();
});

test("an occupied room is not cleaned up", { skip: EXTERNAL ? "hub only" : false }, async () => {
  const room = rid("occupied");
  const a = raw(room);
  await a.auth("oa", { pin: "1212" });
  const b = raw(room);
  await b.auth("ob", { pin: "1212" });
  b.close();
  await sleep(100);
  await hub.fireAlarm(room);
  assert.equal(Boolean(hub.relay(room)), true);
  assert.ok(hub.relay(room).store.map.get("meta"));
  a.close();
});

test("core: tokens are signed, expire and name their room", async () => {
  const tok = await signToken("s", { r: "room", p: "e", exp: 5 });
  assert.deepEqual(await verifyToken("s", tok), { r: "room", p: "e", exp: 5 });
  assert.equal(await verifyToken("other", tok), null);
  assert.equal(await verifyToken("s", "garbage"), null);
  let t = 1000;
  const store = memoryStore();
  const relay = new RoomRelay({ roomId: "r1", store, secret: "s", usage: new UsageMeter({ store: memoryStore(), now: () => t }), now: () => t });
  const sent = [];
  const sock = { state: {}, save(s) { this.state = s; }, send: (x) => sent.push(JSON.parse(x)), close() {} };
  relay.onOpen(sock, [sock]);
  await relay.onMessage(sock, JSON.stringify({ t: "auth", peer: "p" }), [sock]);
  const { token } = sent.find((m) => m.ctl === "ok");
  // only meta is stored — no peer ids, nicknames or messages
  assert.deepEqual([...store.map.keys()], ["meta"]);
  assert.deepEqual(Object.keys(store.map.get("meta")).sort(), ["created", "epoch"]);
  await relay.onMessage(sock, JSON.stringify({ from: "p", t: "here", nick: "누구" }), [sock]);
  assert.deepEqual([...store.map.keys()], ["meta"]);
  // a token expires after 15 min
  const s2 = { state: {}, save(s) { this.state = s; }, send: (x) => sent.push(JSON.parse(x)), close() {} };
  store.map.set("meta", { ...store.map.get("meta"), salt: "AAAAAAAAAAAAAAAAAAAAAA", iter: 1000, hash: "0".repeat(64) });
  t += 15 * 60 * 1000 + 1;
  relay.onOpen(s2, [sock, s2]);
  await relay.onMessage(s2, JSON.stringify({ t: "auth", peer: "q", token }), [sock, s2]);
  assert.equal(sent.at(-1).reason, "pin-required");
  // traffic past 5 min refreshes the token
  const before = sent.length;
  await relay.onMessage(sock, JSON.stringify({ from: "p", t: "here" }), [sock]);
  assert.equal(sent.slice(before).filter((m) => m.ctl === "token").length, 1);
});

test("meshClient over wsBus: two players meet, one hosts, actions round-trip", async () => {
  const room = `${rid("mesh")}~ABCDEFGHJK`; // a friends room id (slug~CODE)
  const mk = (n) => {
    const shared = {};
    const st = [];
    const conn = connectMesh({
      createBus: wsBus({ url: URL_, room }),
      me: { slug: room, anonId: `a${n}`, nick: `n${n}` },
      timing: { discoveryMs: 300 },
      onStatus: (s) => st.push(s.state),
      onMessage: (m) => {
        if (m.t === "state") Object.assign(shared, m.d.sharedState, { participants: m.d.participants });
        else if (m.t === "participants") shared.participants = m.d.count;
        else if (m.t === "setVar") shared[m.d.id] = m.d.value;
      },
    });
    return { conn, shared, st };
  };
  const p1 = mk(1);
  await sleep(500);
  const p2 = mk(2);
  for (let i = 0; i < 60 && !(p1.shared.participants === 2 && p2.shared.participants === 2); i++) await sleep(100);
  assert.equal(p2.shared.participants, 2);
  assert.equal(p1.conn.isHost !== p2.conn.isHost, true, "exactly one host");
  assert.ok(p2.st.includes("connected"));
  p1.conn.close();
  p2.conn.close();
});

test("wsBus: a wrong PIN fails the bus with reason 'pin'", async () => {
  const room = rid("buspin");
  const o = raw(room);
  await o.auth("o", { pin: "1000" });
  const bus = wsBus({ url: URL_, room, pin: "2000" })("bp");
  const st = await new Promise((r) => bus.onStatus(r));
  assert.deepEqual(st, { state: "failed", reason: "pin" });
  bus.close();
  o.close();
});
