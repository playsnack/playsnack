// Usage meter, 1:1 (#151): every incoming WebSocket message counts as one Durable Object
// request toward the free plan's 100,000/day (Cloudflare documents its 20:1 ratio for billing
// only), plus each socket opened, each alarm and each meter call. The 70 % / 90 % stages are
// judged on that. In memory (no network, no ports).
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageMeter, UsageReporter, FREE, STAGES, LIMITS, memoryStore } from "../../../edge/room/src/core.js";
import { RoomRelay } from "../../../edge/room/src/core.js";
import { GameRoom } from "../../../edge/room/src/game.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A memoryStore that counts its writes. */
function countingStore() {
  const s = memoryStore();
  s.puts = 0;
  const put = s.put;
  s.put = (k, v) => (s.puts++, put(k, v));
  return s;
}

/** In-memory socket: records frames and its close code. */
function sock() {
  return {
    state: {},
    frames: [],
    closed: null,
    save(s) {
      this.state = s;
    },
    send(str) {
      this.frames.push(JSON.parse(str));
    },
    close(code) {
      this.closed = code;
    },
    frame(t) {
      return this.frames.find((m) => m.t === t);
    },
  };
}

/** A game room on in-memory sockets, its meter calls counted. */
function gameRoom(meter, roomId, limits = {}) {
  const socks = [];
  const calls = { add: 0, admit: 0 };
  const usage = { admit: () => (calls.admit++, meter.admit()), add: (d) => (calls.add++, meter.add(d)) };
  const store = countingStore();
  const room = new GameRoom({ roomId, store, secret: "s", usage, limits, sockets: () => socks });
  const join = async (anonId, extra = {}) => {
    const s = sock();
    socks.push(s);
    room.onOpen(s);
    await room.onMessage(s, JSON.stringify({ t: "hello", d: { slug: roomId, anonId, nick: anonId, ...extra } }));
    await sleep(5); // the send queue drains on a timer
    return s;
  };
  const leave = async (s) => {
    socks.splice(socks.indexOf(s), 1);
    await room.onClose(s);
    await sleep(5);
  };
  const vote = (s, i) => room.onMessage(s, JSON.stringify({ t: "action", d: { name: "vote", payload: { option: `o${i % 2}` }, clientMsgId: `m${i}` } }));
  return { room, store, calls, join, leave, vote, socks };
}

test("the guard runs on the free plan's own numbers: 100,000 DO requests/day, 70 % / 90 %", () => {
  assert.equal(FREE.doRequests, 100000);
  assert.deepEqual(STAGES, { newRooms: 0.7, newJoins: 0.9 });
});

test("meter: incoming WebSocket messages count 1:1, plus sockets, alarms and its own calls", async () => {
  const m = new UsageMeter({ store: memoryStore() });
  await m.add({ conns: 3, msgs: 1000, alarms: 2 });
  const r = await m.report();
  assert.equal(r.used.doRequests, 3 + 1000 + 2 + 1, "sockets + messages (1:1) + alarms + this add");
  assert.deepEqual(r.doRequestsBy, { conns: 3, msgs: 1000, alarms: 2, meterCalls: 1 });
  assert.equal(r.used.workerRequests, 3);
  assert.equal(r.percent.doRequests, 1);
});

test("stage 1 at 70,000 DO requests and stage 2 at 90,000 — counted 1:1", async () => {
  const m = new UsageMeter({ store: memoryStore() });
  assert.equal((await m.add({ msgs: 69998 })).stage, 0, "69,998 messages + 1 meter call = 69,999");
  assert.equal((await m.admit()).ok, true, "a new room still opens below 70 %");
  // 69,998 + 2 meter calls + 1 more message + this call = 70,002
  assert.equal((await m.add({ msgs: 1 })).stage, 1);
  const a = await m.admit();
  assert.deepEqual(a, { ok: false, stage: 1 }, "≥ 70 %: no new rooms");
  // 69,999 messages + 4 meter calls = 70,003 so far
  assert.equal((await m.add({ msgs: 19990 })).stage, 1, "89,994 — not yet 90 %");
  assert.equal((await m.add({ msgs: 5 })).stage, 2, "90,000: no new joins");
  const r = await m.report();
  assert.equal(r.used.doRequests, 90000);
  assert.equal(r.percent.doRequests, 90);
  assert.equal(r.refusedRooms, 1);
});

test("a game room counts every incoming message 1:1 — refused and malformed ones too", async () => {
  const meter = new UsageMeter({ store: memoryStore() });
  const g = gameRoom(meter, "one-to-one", { reportMs: 60000, actionsPerSec: 5 });
  const a = await g.join("ma");
  for (let i = 0; i < 20; i++) await g.vote(a, i); // 15 of them over the rate limit
  await g.room.onMessage(a, "not json");
  await g.room.onMessage(a, JSON.stringify({ t: "react", d: { emoji: "🔥" } }));
  await g.leave(a);
  const r = await meter.report();
  assert.deepEqual(r.doRequestsBy, { conns: 1, msgs: 1 + 20 + 1 + 1, alarms: 1, meterCalls: 2 }, "hello + 20 votes + bad + react; the cleanup alarm; admit + one report");
  assert.equal(r.used.doRequests, 1 + 23 + 1 + 2);
  g.room.forget();
});

test("a relay room counts auth and spoofed messages too", async () => {
  const meter = new UsageMeter({ store: memoryStore() });
  const usage = { admit: () => meter.admit(), add: (d) => meter.add(d) };
  const relay = new RoomRelay({ roomId: "relay-1to1", store: memoryStore(), secret: "s", usage, limits: { reportMs: 60000 } });
  const s = sock();
  relay.onOpen(s, [s]);
  await relay.onMessage(s, JSON.stringify({ t: "auth", peer: "p1" }), [s]);
  await relay.onMessage(s, JSON.stringify({ from: "p1", t: "here" }), [s]);
  await relay.onMessage(s, JSON.stringify({ from: "someone-else", t: "here" }), [s]); // spoofed: dropped, still a request
  await relay.onClose(s, []);
  await sleep(5);
  const r = await meter.report();
  assert.deepEqual(r.doRequestsBy, { conns: 1, msgs: 3, alarms: 1, meterCalls: 2 });
});

test("metering costs no storage write per message: the meter writes once per report, the room never", async () => {
  const meterStore = countingStore();
  const meter = new UsageMeter({ store: meterStore });
  const g = gameRoom(meter, "no-writes", { reportMs: 60000, persistMs: 60000 });
  const a = await g.join("wa");
  const roomPuts = g.store.puts; // the room's meta (created once)
  const meterPuts = meterStore.puts; // the admit
  for (let i = 0; i < 200; i++) await g.vote(a, i);
  assert.equal(g.store.puts, roomPuts, "200 messages: no room writes");
  assert.equal(meterStore.puts, meterPuts, "200 messages: no meter writes (batched in memory)");
  assert.equal(g.calls.add, 0, "no meter call within the report window");
  await g.leave(a);
  assert.equal(g.calls.add, 1, "one batched report when the room empties");
  assert.equal(meterStore.puts, meterPuts + 1);
  assert.equal((await meter.report()).doRequestsBy.msgs, 1 + 200);
  g.room.forget();
});

test("under 1:1 the stages reach rooms: 70 % no new rooms, 90 % no new joins — reconnects still get in", async () => {
  const meter = new UsageMeter({ store: memoryStore() });
  const live = gameRoom(meter, "live", { reportMs: 0 }); // reports on every message
  const a = await live.join("ra");
  const seat = a.frame("token")?.d.token;
  assert.ok(seat, "a seat token");

  await meter.add({ msgs: 70000 }); // ≥ 70 % from messages alone
  await live.vote(a, 1); // traffic → report → the room learns stage 1
  await sleep(5);
  assert.equal(live.room.meter.stage, 1);
  const fresh = gameRoom(meter, "fresh");
  const n = await fresh.join("rn");
  assert.equal(n.frame("denied")?.d.reason, "room_full_today", "stage 1: no new rooms");
  const b = await live.join("rb");
  assert.ok(b.frame("token"), "stage 1: an ongoing room still takes players");

  await meter.add({ msgs: 20000 }); // ≥ 90 %
  await live.vote(b, 2);
  await sleep(5);
  assert.equal(live.room.meter.stage, 2);
  const c = await live.join("rc");
  assert.equal(c.frame("denied")?.d.reason, "room_full_today", "stage 2: no new joins");
  assert.equal(c.frame("token"), undefined);

  await live.leave(a); // a drops…
  const back = await live.join("ra", { token: seat }); // …and comes back with its seat token
  assert.equal(back.frame("denied"), undefined);
  assert.ok(back.frame("token"), "stage 2: a reconnect gets in");
  const r = await meter.report();
  assert.equal(r.stage, 2);
  assert.ok(r.refusedRooms >= 1);
  assert.ok(r.refusedJoins >= 1);
  live.room.forget();
  fresh.room.forget();
});

test("a busy room reports every 1,000 requests, not only every 30 s — the guard sees it early", async () => {
  assert.equal(LIMITS.reportEvery, 1000, "1 meter call per 1,000 requests (0.1 %)");
  const meterStore = countingStore();
  const meter = new UsageMeter({ store: meterStore });
  const g = gameRoom(meter, "busy", { reportMs: 60000, reportEvery: 50, actionsPerSec: 1000 });
  const a = await g.join("ba");
  for (let i = 0; i < 120; i++) await g.vote(a, i); // 1 socket + hello + 120 votes, all within 60 s
  await sleep(5);
  assert.equal(g.calls.add, 2, "two reports by count (at 50 and 100 unreported), none by time");
  assert.equal(g.store.puts, 1, "still no room write per message (only its meta)");
  const r = await meter.report();
  assert.equal(r.doRequestsBy.msgs + r.doRequestsBy.conns, 100, "the meter already knows 100 of them, mid-window");
  await g.leave(a);
  assert.equal((await meter.report()).doRequestsBy.msgs, 121);
  g.room.forget();
});

test("a stage heard yesterday does not refuse today: the stage is scoped to its UTC day", async () => {
  let t = Date.UTC(2026, 9, 15, 23, 59, 0); // 08:59 KST
  const now = () => t;
  const r = new UsageReporter({ usage: null, now });
  r.stage = 2;
  assert.equal(r.stage, 2);
  t = Date.UTC(2026, 9, 16, 0, 0, 1); // 09:00:01 KST — the free limits reset
  assert.equal(r.stage, 0, "a new UTC day: no stage until the meter answers again");
  r.stage = 1;
  assert.equal(r.stage, 1);

  // In a room: stage 2 at 23:59 UTC refuses a new joiner; the first joiner after the reset gets in.
  t = Date.UTC(2026, 9, 15, 23, 59, 0);
  const meter = new UsageMeter({ store: memoryStore(), now });
  const socks = [];
  const usage = { admit: () => meter.admit(), add: (d) => meter.add(d) };
  const room = new GameRoom({ roomId: "midnight", store: memoryStore(), secret: "s", usage, now, limits: { reportMs: 60 * 60 * 1000 }, sockets: () => socks });
  const join = async (anonId) => {
    const s = sock();
    socks.push(s);
    room.onOpen(s);
    await room.onMessage(s, JSON.stringify({ t: "hello", d: { slug: "midnight", anonId, nick: anonId } }));
    await sleep(5);
    return s;
  };
  await join("m1");
  room.meter.stage = 2; // what the meter answered at 23:59 UTC
  assert.equal((await join("m2")).frame("denied")?.d.reason, "room_full_today", "stage 2 before the reset");
  t = Date.UTC(2026, 9, 16, 0, 0, 5);
  const m3 = await join("m3");
  assert.equal(m3.frame("denied"), undefined, "after 00:00 UTC the old stage no longer refuses");
  assert.ok(m3.frame("token"));
  room.forget();
});
