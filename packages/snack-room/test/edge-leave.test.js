// Leaving an edge room (#213, edge/room/src/game.js): everyone's count goes down when someone
// leaves — at once on `bye` (← 홈, the tab closing) or a close; after AWAY_GRACE_MS for a phone
// that went to the background and never came back (its socket frozen open, no close ever comes).
// `here` / a new socket within the grace keeps the seat (no flicker). The deadline is the room's
// storage alarm (no timer keeps the room awake), and nothing here is periodic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { AWAY_CLOSE } from "../../../edge/room/src/game.js";
import { createRoom, HOST_GRACE_MS } from "../src/room.js";

const GRACE = 600;
let hub = null;
const RUN = Date.now().toString(36);
const LEGACY = () => Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const fid = (s) => `l-${RUN}-${s}~${LEGACY()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_LEAVE || 4994), limits: { awayGraceMs: GRACE } });
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
  const p = {
    ws,
    frames,
    vars,
    get closed() {
      return closed;
    },
    raw: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello, ...extra } }),
    frame: (pred) => frames.find(pred),
    async until(fn, ms = 4000) {
      for (let t = 0; t < ms; t += 20) {
        if (fn()) return true;
        await sleep(20);
      }
      return Boolean(fn());
    },
  };
  return p;
}
/** Three in a fresh friends room: a (the organizer), b, c — everyone sees 3. */
async function three(name) {
  const room = fid(name);
  const a = player(room, `${name}a`);
  await a.hello({ organize: true });
  const b = player(room, `${name}b`);
  await b.hello();
  const c = player(room, `${name}c`);
  await c.hello();
  for (const p of [a, b, c]) assert.ok(await p.until(() => p.vars.roster?.length === 3 && p.vars.participants === 3), "three in");
  return { room, a, b, c, r: hub.room(room) };
}
const gone = (p) => p.vars.roster?.length === 2 && p.vars.participants === 2;

test("bye (← 홈, the tab closing): everyone's count goes down at once; the close after it changes nothing", async () => {
  const { a, b, c, r } = await three("bye");
  const in0 = r.core.stats.in;
  const t0 = Date.now();
  await c.raw({ t: "bye", d: {} });
  assert.ok(await a.until(() => gone(a) && gone(b), 1500), "a and b see 2 within 1.5 s");
  assert.ok(Date.now() - t0 < 1000, `fast (${Date.now() - t0} ms)`);
  assert.ok(await c.until(() => c.closed !== null), "the room closes the leaver's socket");
  await sleep(300);
  assert.deepEqual([a.vars.participants, a.vars.roster.length], [2, 2], "its close is not a second leave");
  assert.equal(r.core.stats.in - in0, 1, "one frame for the leave");
  [a, b].forEach((p) => p.ws.close());
});

test("a close without bye: out at once too (as before)", async () => {
  const { a, c } = await three("close");
  c.ws.close();
  assert.ok(await a.until(() => gone(a), 1500));
  a.ws.close();
});

test("away (the background, frozen open): still here during the grace, then out for everyone — the room closes it (4011)", async () => {
  const { a, b, c, r } = await three("away");
  const in0 = r.core.stats.in;
  await c.raw({ t: "away", d: {} });
  await sleep(GRACE / 2);
  assert.deepEqual([a.vars.roster.length, a.vars.participants], [3, 3], "no flicker during the grace");
  assert.ok(r.alarmAt != null, "the deadline is the room's alarm");
  assert.ok(await a.until(() => gone(a) && gone(b), GRACE + 1500), "then a and b see 2");
  assert.ok(await c.until(() => c.closed === AWAY_CLOSE), `closed ${AWAY_CLOSE} (${c.closed})`);
  assert.equal(r.core.stats.awayClosed, 1);
  assert.equal(r.core.stats.in - in0, 1, "one frame from the leaver, nothing periodic");
  [a, b].forEach((p) => p.ws.close());
});

test("away then here (back on the same socket within the grace): stays, no leave", async () => {
  const { a, c, r } = await three("here");
  await c.raw({ t: "away", d: {} });
  await sleep(GRACE / 3);
  await c.raw({ t: "here", d: {} });
  await sleep(GRACE + 400); // the alarm fires: nobody is away any more
  assert.deepEqual([a.vars.roster.length, a.vars.participants], [3, 3]);
  assert.equal(c.closed, null);
  assert.equal(r.core.stats.awayClosed ?? 0, 0);
  // any other frame also says "alive": an action after away
  await c.raw({ t: "away", d: {} });
  await c.raw({ t: "action", d: { name: "rename", payload: { nick: "씨씨" }, clientMsgId: "x1" } });
  await sleep(GRACE + 400);
  assert.equal(a.vars.roster.length, 3);
  [a, c].forEach((p) => p.ws.close());
});

test("away then a new socket with the seat token (back after > 3 s): the seat is taken over — never off the roster", async () => {
  const { room, a, c, r } = await three("seat");
  const token = c.frames.find((m) => m.t === "token").d.token;
  await c.raw({ t: "away", d: {} });
  await sleep(GRACE / 3);
  const seen = [];
  const watch = setInterval(() => seen.push(a.vars.roster.length), 20);
  const c2 = player(room, "seatc");
  await c2.hello({ token });
  assert.ok(await c2.until(() => c2.frame((m) => m.t === "state")));
  await sleep(GRACE + 400); // the old deadline passes
  clearInterval(watch);
  assert.ok(seen.every((n) => n === 3), `a saw 3 throughout (${[...new Set(seen)]})`);
  assert.equal(c2.closed, null, "the new socket is not swept");
  assert.equal(r.core.stats.awayClosed ?? 0, 0);
  [a, c2].forEach((p) => p.ws.close());
});

test("a close after a hibernation (an idle lobby): everyone's count still goes down — the woken room knew the leaver", async () => {
  const { a, b, c, r } = await three("hibclose");
  await sleep(1200); // the snapshot is written (idle lobby)
  r.core.forget(); // evicted: memory gone, sockets still attached
  c.ws.close();
  assert.ok(await a.until(() => gone(a) && gone(b), 1500), `a and b see 2 (a: roster ${a.vars.roster?.length}, chip ${a.vars.participants})`);
  [a, b].forEach((p) => p.ws.close());
});

test("bye after a hibernation: the same", async () => {
  const { a, b, c, r } = await three("hibbye");
  await sleep(1200);
  r.core.forget();
  await c.raw({ t: "bye", d: {} });
  assert.ok(await a.until(() => gone(a) && gone(b), 1500));
  [a, b].forEach((p) => p.ws.close());
});

test("away across a hibernation: the alarm wakes the room, which rebuilds and lets the away player go", async () => {
  const { a, b, c, r } = await three("hib");
  await sleep(1200); // the snapshot is written (idle lobby)
  await c.raw({ t: "away", d: {} });
  await sleep(50);
  r.core.forget(); // evicted: memory gone, sockets still attached
  assert.ok(await a.until(() => gone(a) && gone(b), GRACE + 2000), "out after the grace");
  assert.ok(await c.until(() => c.closed === AWAY_CLOSE));
  [a, b].forEach((p) => p.ws.close());
});

test("engine: a host who left after being away gets the grace counted from then (handed on at once past HOST_GRACE_MS)", () => {
  let t = 100000;
  const room = createRoom({ startRule: "host", now: () => t, broadcast: () => {}, send: () => {}, setTimer: (fn, ms) => (ms <= 0 ? (fn(), 0) : 0), clearTimer: () => {} });
  room.join("p1", { anonId: "h", nick: "방장" });
  room.join("p2", { anonId: "x", nick: "친구" });
  room.leave("p1", { awaySince: t - HOST_GRACE_MS });
  assert.equal(room._state.session.host, "x", "handed on at once");
  // an awaySince in the future is not believed (now)
  room.join("p3", { anonId: "y", nick: "셋" });
  room.leave("p2", { awaySince: t + 99999 });
  assert.equal(room._state.session.hostAwayAt, t);
});
