// Free-tier guard (edge/room core.js UsageMeter / UsageReporter, docs/edge-rooms.md §무료 한도):
// stage 1 (≥ 70 % of any daily limit) refuses NEW rooms, ongoing rooms continue;
// stage 2 (≥ 90 %) refuses new joins except reconnects; stage ≥ 1 drops snapshot writes first.
// Rooms report batched (≤ once per reportMs); GET /usage shows today's % of each limit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { UsageMeter, memoryStore } from "../../../edge/room/src/core.js";
import { GameRoom } from "../../../edge/room/src/game.js";

const FREE = { workerRequests: 1000, doRequests: 1000, doGbSeconds: 1000, rowsWritten: 1000 };
let hub;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const rid = (s) => `u-${RUN}-${s}`;

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_USAGE || 4554), free: FREE, limits: { reportMs: 100 } });
});
after(async () => hub?.close());

function player(room, anonId, hello = {}) {
  const ws = new WebSocket(`${hub.url}/room/${room}`);
  const frames = [];
  const vars = {};
  let closed = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    frames.push(m);
    if (m.t === "state") Object.assign(vars, m.d.sharedState, { participants: m.d.participants });
    else if (m.t === "setVar") vars[m.d.id] = m.d.value;
    else if (m.t === "participants") vars.participants = m.d.count;
  };
  ws.onclose = (ev) => (closed = ev.code);
  const opened = new Promise((r) => (ws.onopen = r));
  let n = 0;
  const p = {
    frames,
    vars,
    get closed() {
      return closed;
    },
    send: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    hello: (extra = {}) => p.send({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello, ...extra } }),
    act: (name, payload) => p.send({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${++n}` } }),
    frame: (pred) => frames.find(pred),
    async until(fn, ms = 3000) {
      for (let t = 0; t < ms; t += 25) {
        if (fn()) return true;
        await sleep(25);
      }
      return Boolean(fn());
    },
    close: () => ws.close(),
  };
  return p;
}
/** Push today's DO-request estimate to `share` of the free limit (msgs/20 = requests). */
const setShare = async (share) => {
  const now = (await hub.meter.report()).used.doRequests;
  const want = Math.ceil(FREE.doRequests * share);
  if (want > now) await hub.meter.add({ msgs: (want - now) * 20 });
};
const denied = (p) => p.frame((m) => m.t === "denied")?.d.reason;

test("meter: estimates, % of each free limit and the stage", async () => {
  const m = new UsageMeter({ store: memoryStore(), free: FREE });
  assert.equal((await m.admit()).ok, true);
  await m.add({ conns: 10, msgs: 400, awakeMs: 1000 * 1000, rows: 5 });
  const r = await m.report();
  assert.deepEqual(r.used, { workerRequests: 10, doRequests: 10 + 20 + 2, doGbSeconds: 128, rowsWritten: 5 + 2 });
  assert.equal(r.percent.doGbSeconds, 12.8);
  assert.equal(r.stage, 0);
  await m.add({ rows: 700 });
  assert.equal((await m.report()).stage, 1, "70 % of rows written");
  await m.add({ rows: 200 });
  assert.equal((await m.report()).stage, 2);
  assert.equal(r.resetsAt, "00:00 UTC (09:00 KST)");
});

test("meter: a new UTC day starts from zero", async () => {
  let t = Date.parse("2026-10-14T14:59:00Z"); // 23:59 KST
  const m = new UsageMeter({ store: memoryStore(), free: FREE, now: () => t });
  await m.add({ rows: 950 });
  assert.equal((await m.report()).stage, 2);
  t = Date.parse("2026-10-15T00:00:01Z"); // 09:00 KST
  assert.equal((await m.report()).stage, 0);
});

test("stages 1 and 2 on game rooms: new rooms refused, then new joins; ongoing rooms and reconnects continue", async () => {
  const live = rid("live");
  const a = player(live, "la");
  await a.hello();
  assert.ok(await a.until(() => a.frame((m) => m.t === "token")));
  const seat = a.frame((m) => m.t === "token").d.token;

  await setShare(0.72); // stage 1
  await a.act("vote", { option: "o0" }); // traffic → the room's next report learns the stage
  await sleep(150);
  await a.act("vote", { option: "o1" });
  await sleep(100);
  const fresh = player(rid("new1"), "n1");
  await fresh.hello();
  assert.ok(await fresh.until(() => fresh.closed !== null));
  assert.equal(denied(fresh), "room_full_today", "stage 1: no new rooms");
  const b = player(live, "lb");
  await b.hello();
  assert.ok(await b.until(() => b.vars.participants === 2), "stage 1: an ongoing room still takes players");

  await setShare(0.93); // stage 2
  await b.act("vote", { option: "o0" });
  await sleep(150);
  await b.act("vote", { option: "o1" });
  await sleep(100);
  assert.equal(hub.room(live).core.meter.stage, 2);
  const c = player(live, "lc");
  await c.hello();
  assert.ok(await c.until(() => c.closed !== null));
  assert.equal(denied(c), "room_full_today", "stage 2: no new joins");
  // …but the player who dropped comes back with its seat token
  a.close();
  await sleep(100);
  const back = player(live, "la");
  await back.hello({ token: seat });
  assert.ok(await back.until(() => back.vars.participants === 2), "stage 2: a reconnect gets in");
  await b.act("vote", { option: "o0" }); // and the game goes on
  assert.ok(await back.until(() => back.vars.votesByOption?.o0 >= 1));
  const rep = await hub.meter.report();
  assert.ok(rep.refusedRooms >= 1);
  b.close();
  back.close();
  await sleep(200);
  assert.ok((await hub.meter.report()).refusedJoins >= 1);
});

test("stage ≥ 1 drops non-essential work first: no snapshot writes", async () => {
  hub.meter.store.map.clear(); // a fresh day (stage 0)
  const room = rid("nosnap");
  const ws = new WebSocket(`${hub.url}/room/${room}`);
  await new Promise((r) => (ws.onopen = r));
  const send = (m) => ws.send(JSON.stringify(m));
  send({ t: "hello", d: { slug: room, anonId: "sa", nick: "sa" } });
  send({ t: "action", d: { name: "vote", payload: { option: "o0" }, clientMsgId: "1" } });
  await sleep(1300);
  assert.ok(hub.room(room).store.map.get("snap"), "stage 0: the idle room is snapshotted");
  const writes = hub.room(room).core.stats.snapWrites;
  await hub.meter.add({ rows: 750 }); // stage 1
  await sleep(150);
  send({ t: "action", d: { name: "vote", payload: { option: "o1" }, clientMsgId: "2" } }); // traffic → report → stage 1
  await sleep(150);
  send({ t: "action", d: { name: "vote", payload: { option: "o0" }, clientMsgId: "3" } });
  await sleep(1300);
  assert.equal(hub.room(room).core.meter.stage, 1);
  assert.equal(hub.room(room).core.stats.snapWrites, writes, "no more snapshot writes");
  ws.close();
  await sleep(100);
  await setShare(0.93); // the tests below expect stage 2
});

test("relay rooms follow the same stage 1 rule", async () => {
  const ws = new WebSocket(`${hub.url}/relay/${rid("relay")}`);
  const got = [];
  ws.onmessage = (ev) => got.push(JSON.parse(ev.data));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "auth", peer: "rp" }));
  for (let i = 0; i < 40 && !got.length; i++) await sleep(25);
  assert.equal(got[0]?.reason, "room_full_today");
});

test("GET /usage: today's numbers and % of each free limit", async () => {
  const r = await fetch(`${hub.url.replace(/^ws/, "http")}/usage`).then((x) => x.json());
  for (const k of ["workerRequests", "doRequests", "doGbSeconds", "rowsWritten"]) {
    assert.equal(typeof r.used[k], "number", k);
    assert.equal(typeof r.percent[k], "number", k);
  }
  assert.equal(r.stage, 2);
  assert.equal(r.free.doGbSeconds, 1000);
});

test("rooms report batched: at most once per reportMs, plus when they empty", async () => {
  // A GameRoom with in-memory sockets (no network): count the meter calls.
  const meter = new UsageMeter({ store: memoryStore(), free: FREE });
  let calls = 0;
  const usage = { admit: () => meter.admit(), add: (d) => (calls++, meter.add(d)) };
  const socks = [];
  const room = new GameRoom({ roomId: "batch", store: memoryStore(), secret: "s", usage, limits: { reportMs: 60000 }, sockets: () => socks });
  const sock = { state: {}, save(s) { this.state = s; }, send() {}, close() {} };
  socks.push(sock);
  room.onOpen(sock);
  await room.onMessage(sock, JSON.stringify({ t: "hello", d: { slug: "batch", anonId: "bb", nick: "bb" } }));
  for (let i = 0; i < 30; i++) await room.onMessage(sock, JSON.stringify({ t: "action", d: { name: "vote", payload: { option: `o${i % 2}` }, clientMsgId: `m${i}` } }));
  assert.equal(calls, 0, "no report within the 60 s window");
  await room.onClose(sock);
  socks.length = 0;
  await sleep(20);
  assert.equal(calls, 1, "one report when the room empties");
  const u = await meter.report();
  assert.equal(u.used.workerRequests, 1);
  assert.equal(u.used.doRequests, 1 + 2 + 2, "1 socket + 31 msgs/20 + admit + report");
  assert.ok(u.used.rowsWritten >= 2);
  room.forget();
});
