// 시작 시간 예약 on the edge (#218, edge/room/src/game.js): the scheduled start is the room's ONE
// storage alarm (shared with the away deadlines, #213) — never a timer, so the room can hibernate
// while it waits; a forced eviction mid-schedule still starts the game at the time. The link
// preview reads the time at GET /room/<id>/result (`startAt`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";

const GRACE = 600;
let hub = null;
const RUN = Date.now().toString(36);
const LEGACY = () => Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const fid = () => `tpl-tap-battle~${LEGACY()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START = { duration: 3000 };

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_SCHEDULE || 4995), limits: { awayGraceMs: GRACE, scheduleMinMs: 200 } });
});
after(async () => hub?.close());

function player(room, anonId) {
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
    else if (m.t === "schedule") vars.schedule = m.d;
  };
  ws.onclose = (ev) => (closed = ev.code);
  const opened = new Promise((r) => (ws.onopen = r));
  let n = 0;
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
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...extra } }),
    act: (name, payload) => p.raw({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${RUN}-${++n}` } }),
    ack: () => frames.filter((m) => m.t === "actionAck").at(-1)?.d,
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
async function two() {
  const room = fid();
  const a = player(room, `a${RUN}`);
  await a.hello({ organize: true });
  const b = player(room, `b${RUN}`);
  await b.hello();
  for (const p of [a, b]) assert.ok(await p.until(() => p.vars.roster?.length === 2 && p.vars.iAmHost !== undefined), "two in");
  return { room, a, b, r: hub.room(room) };
}
const getResult = async (room) => {
  const res = await fetch(`${hub.url.replace(/^ws/, "http")}/room/${room}/result`);
  return { status: res.status, body: await res.json() };
};
/** Count the room's usage meter calls from now on. */
const spyMeter = (r) => {
  const c = { rows: 0, alarms: 0 };
  const orig = r.core.meter.count.bind(r.core.meter);
  r.core.meter.count = (k, n = 1) => {
    if (k in c) c[k] += n;
    return orig(k, n);
  };
  return c;
};

test("the host schedules: everyone hears the countdown, the room's alarm is set for the time (no engine timer), it starts by itself", async () => {
  const { a, b, r } = await two();
  assert.equal(a.vars.iAmHost, true);
  const used = spyMeter(r);
  await b.act("schedule", { in: 1500, start: START });
  assert.ok(await b.until(() => b.ack()?.reason === "not_host"), "a guest may not");
  const t0 = Date.now();
  await a.act("schedule", { in: 1500, start: START });
  assert.ok(await b.until(() => b.vars.schedule?.on === true), "the guest hears it");
  assert.ok(b.vars.schedule.endsIn > 1000 && b.vars.schedule.endsIn <= 1500, `endsIn ${b.vars.schedule.endsIn}`);
  assert.ok(r.alarmAt != null && Math.abs(r.alarmAt - (t0 + 1500)) < 300, "the room's alarm is the start");
  assert.equal(r.core.engine._state.session.timers.length, 0, "no engine timer (the DO may hibernate)");
  assert.deepEqual(used, { rows: 1, alarms: 1 }, "one alarm (its write + its firing)");
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown" && b.vars.sessionPhase === "countdown", 3000), "started by itself");
  assert.ok(Date.now() - t0 >= 1400, "not before the time");
  [a, b].forEach((p) => p.ws.close());
});

test("forced eviction mid-schedule: the alarm wakes the room, which rebuilds from its snapshot and starts at the time", async () => {
  const { room, a, b, r } = await two();
  await a.act("schedule", { in: 2500, start: START });
  assert.ok(await b.until(() => b.vars.schedule?.on === true));
  await sleep(1300); // the idle snapshot is written (debounced 1 s)
  const snap = await r.store.get("snap");
  assert.ok(snap?.s?.session?.sched, "the schedule is in the snapshot");
  r.core.forget(); // evicted: memory gone, sockets still attached, the alarm still in storage
  assert.equal(r.core.engine, null);
  // the link preview asks a sleeping room: from its snapshot
  const res = await getResult(room);
  assert.equal(res.status, 404, "no saved game");
  assert.ok(Math.abs(res.body.startAt - (Date.now() + 1200)) < 400, `startAt ${res.body.startAt}`);
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown" && b.vars.sessionPhase === "countdown", 3000), "started at the time");
  assert.equal(r.core.stats.rehydrated, 1);
  [a, b].forEach((p) => p.ws.close());
});

test("alone at the time: the room waits ('due'), the 2nd arrival starts it at once; 예약 취소 drops a schedule", async () => {
  const room = fid();
  const a = player(room, `s${RUN}`);
  await a.hello({ organize: true });
  assert.ok(await a.until(() => a.vars.iAmHost === true));
  await a.act("schedule", { in: 400, start: START });
  assert.ok(await a.until(() => a.vars.schedule?.due === true, 2000), "due, waiting");
  assert.notEqual(a.vars.sessionPhase, "countdown");
  assert.equal((await getResult(room)).body.startAt, undefined, "the time came: no startAt in the preview");
  const b = player(room, `t${RUN}`);
  await b.hello();
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown", 2000), "the 2nd arrival starts it");
  [a, b].forEach((p) => p.ws.close());

  const c = await two();
  await c.a.act("schedule", { in: 800, start: START });
  assert.ok(await c.b.until(() => c.b.vars.schedule?.on === true));
  await c.a.act("unschedule");
  assert.ok(await c.b.until(() => c.b.vars.schedule?.on === false), "everyone hears the cancel");
  await sleep(1200);
  assert.notEqual(c.a.vars.sessionPhase, "countdown", "nothing at the old time (its alarm fired for nothing)");
  [c.a, c.b].forEach((p) => p.ws.close());
});

test("one alarm for both: an away deadline before the start takes the alarm, then the start gets it back", async () => {
  const { a, b, r } = await two();
  const room = r.id;
  const c = player(room, `c${RUN}`);
  await c.hello();
  assert.ok(await a.until(() => a.vars.roster?.length === 3));
  const t0 = Date.now();
  await a.act("schedule", { in: 2000, start: START });
  assert.ok(await b.until(() => b.vars.schedule?.on === true));
  await c.raw({ t: "away", d: {} });
  await sleep(50);
  assert.ok(r.alarmAt < t0 + 1500, "the away deadline (sooner) is the alarm now");
  assert.ok(await a.until(() => a.vars.roster?.length === 2, GRACE + 1500), "the away player is let go");
  await sleep(50);
  assert.ok(r.alarmAt != null && Math.abs(r.alarmAt - (t0 + 2000)) < 300, "…and the alarm is the start again");
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown", 2500), "started at the time");
  [a, b].forEach((p) => p.ws.close());
});

test("the preview's startAt: ahead only, and gone once the game started", async () => {
  const { room, a, b } = await two();
  assert.equal((await getResult(room)).body.startAt, undefined, "nothing scheduled");
  await a.act("schedule", { in: 60000, start: START });
  assert.ok(await b.until(() => b.vars.schedule?.on === true));
  const at = (await getResult(room)).body.startAt;
  assert.ok(Math.abs(at - (Date.now() + 60000)) < 500, `startAt ${at}`);
  await a.act("start", START); // 지금 시작
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown"));
  assert.equal((await getResult(room)).body.startAt, undefined);
  [a, b].forEach((p) => p.ws.close());
});
