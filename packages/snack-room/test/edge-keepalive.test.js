// Host keepalive (#142, edge/room/src/game.js): a host phone that lost its network on screen sends
// nothing. Its page pings ("ping", exact text) every 20 s in the lobby / result; the Durable Object's
// auto-response answers without waking the room (the hub emulates it: edgeHub.js) and keeps the
// time. The room reads that time only inside events that already woke it — never a timer of its own.
// A clock the test moves (the hub's `now`): no real 45 s waits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { hostStale, HOST_STALE_MS, LOST_CLOSE, PING_EVERY_MS } from "../../../edge/room/src/game.js";

let T = Date.UTC(2026, 9, 16, 1, 0, 0); // fixed: the test moves it by hours (no UTC day change)
const clock = () => T;
let hub = null;
const RUN = Date.now().toString(36);
const LEGACY = () => Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const fid = (s) => `k-${RUN}-${s}~${LEGACY()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_KEEPALIVE || 4996), now: clock });
});
after(async () => hub?.close());

function player(room, anonId) {
  const ws = new WebSocket(`${hub.url}/room/${room}`);
  const frames = [];
  const texts = [];
  const vars = {};
  let closed = null;
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return void texts.push(ev.data);
    }
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
    texts,
    vars,
    get closed() {
      return closed;
    },
    text: async (s) => {
      await opened;
      ws.send(s);
    },
    raw: (m) => p.text(JSON.stringify(m)),
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...extra } }),
    react: () => p.raw({ t: "react", d: { emoji: "❤️" } }),
    async until(fn, ms = 3000) {
      for (let t = 0; t < ms; t += 20) {
        if (fn()) return true;
        await sleep(20);
      }
      return Boolean(fn());
    },
  };
  return p;
}
/** A host (the organizer) and a guest in a fresh friends room. */
async function pair(name) {
  const room = fid(name);
  const h = player(room, `${name}h`);
  await h.hello({ organize: true });
  assert.ok(await h.until(() => h.vars.iAmHost === true), "h hosts");
  const g = player(room, `${name}g`);
  await g.hello();
  for (const p of [h, g]) assert.ok(await p.until(() => p.vars.roster?.length === 2), "two in");
  return { room, h, g, r: hub.room(room) };
}
const hostOf = (r) => r.core.engine?._state.session.host;
const settle = () => sleep(150);

test("hostStale: the decision on fake timestamps", () => {
  const now = 1_000_000;
  const base = { now, phase: "lobby", away: false };
  assert.equal(hostStale({ ...base, pongAt: null }), false, "never pinged = unknown, not dead");
  assert.equal(hostStale({ ...base, pongAt: now - HOST_STALE_MS - 1 }), true, "two pings missed + slack");
  assert.equal(hostStale({ ...base, pongAt: now - HOST_STALE_MS }), false, "exactly at the limit: not yet");
  assert.equal(hostStale({ ...base, pongAt: now - 21000 }), false, "one ping late");
  assert.equal(hostStale({ ...base, phase: "result", pongAt: now - 60000 }), true, "result too");
  for (const phase of ["countdown", "play"]) assert.equal(hostStale({ ...base, phase, pongAt: now - 600000 }), false, `${phase}: no pings then — never judged`);
  assert.equal(hostStale({ ...base, away: true, pongAt: now - 600000 }), false, "away: #213's alarm decides");
  assert.equal(hostStale({ ...base, pongAt: now - 60000, seenAt: now - 1000 }), false, "a recent frame is a sign of life");
  assert.equal(hostStale({ ...base, pongAt: now - 60000, phaseAt: now - 1000 }), false, "just back in the lobby: its ping may not have come yet");
  assert.equal(hostStale({ ...base, pongAt: now - 60000, seenAt: now - 50000, phaseAt: now - 50000 }), true);
});

test("auto-response: exactly \"ping\" → \"pong\", the room never sees it; anything ping-like is pingMiss", async () => {
  const { h, g, r } = await pair("auto");
  const in0 = r.core.stats.in;
  const p0 = hub.counts.pongs;
  const sock = [...r.sockets].find((s) => s.state.anonId === "autoh");
  assert.equal(sock.pongAt(), null, "no ping yet");
  await h.text("ping");
  assert.ok(await h.until(() => h.texts.includes("pong")), "pong back");
  assert.equal(hub.counts.pongs - p0, 1);
  assert.equal(sock.pongAt(), T, "its time is kept");
  assert.equal(r.core.stats.in, in0, "not a frame of the room");
  assert.equal(r.core.stats.pingMiss ?? 0, 0);
  for (const miss of ["Ping", "ping\n", " ping", '"ping"', JSON.stringify({ t: "ping" })]) await h.text(miss);
  await settle();
  assert.equal(r.core.stats.pingMiss, 5, "each wrong one woke the room: counted");
  assert.equal(h.texts.filter((x) => x === "pong").length, 1, "no pong for them");
  assert.equal(h.closed, null, "and nothing else happens");
  h.ws.close();
  g.ws.close();
  await settle();
  const rep = await hub.meter.report();
  assert.ok(rep.pingMiss >= 5, `/usage pingMiss (${rep.pingMiss})`);
  assert.ok("pings" in rep.doRequestsBy, "/usage doRequestsBy.pings");
});

test("a host whose pings stopped (offline on screen): gone at the next event past 45 s — handed over at once", async () => {
  const { h, g, r } = await pair("lost");
  await h.text("ping");
  assert.ok(await h.until(() => h.texts.includes("pong")));
  T += 30000;
  await g.react();
  await settle();
  assert.equal(h.closed, null, "30 s: still here");
  assert.equal(hostOf(r), "losth");
  T += 20000; // 50 s since its last ping
  await g.react(); // an event that wakes the room anyway
  assert.ok(await g.until(() => g.vars.roster?.length === 1 && g.vars.participants === 1), `the guest sees the host gone (${g.vars.roster?.length})`);
  assert.ok(await g.until(() => g.vars.iAmHost === true), "and hosts now");
  assert.equal(hostOf(r), "lostg");
  assert.ok(await h.until(() => h.closed === LOST_CLOSE), `its socket closed ${LOST_CLOSE} (${h.closed})`);
  assert.equal(r.core.stats.hostLost, 1);
  g.ws.close();
});

test("a host that keeps pinging stays; a host that never pinged (null) is unknown, not dead", async () => {
  const { h, g, r } = await pair("alive");
  for (let i = 0; i < 6; i++) {
    T += PING_EVERY_MS;
    await h.text("ping");
    await h.until(() => h.texts.filter((x) => x === "pong").length === i + 1);
    await g.react();
  }
  await settle();
  assert.equal(h.closed, null);
  assert.equal(hostOf(r), "aliveh");
  h.ws.close();
  g.ws.close();

  const b = await pair("never");
  T += 10 * 60000;
  await b.g.react();
  await settle();
  assert.equal(b.h.closed, null, "no pong ever: not judged");
  assert.equal(hostOf(b.r), "neverh");
  b.h.ws.close();
  b.g.ws.close();
});

test("only in the lobby / result, and not while away; the host back on a new socket is not 'gone'", async () => {
  const { room, h, g, r } = await pair("rules");
  await h.text("ping");
  await h.until(() => h.texts.includes("pong"));
  // away: #213's alarm decides, not the keepalive
  await h.raw({ t: "away", d: {} });
  await settle();
  T += 60000;
  await g.react();
  await settle();
  assert.equal(h.closed, null, "away host: not closed by the keepalive check");
  assert.equal(hostOf(r), "rulesh");
  // back, a game starts: no pings during it, nothing judged
  await h.raw({ t: "here", d: {} });
  await h.raw({ t: "action", d: { name: "start", payload: { duration: 10000 }, clientMsgId: "s1" } });
  assert.ok(await g.until(() => g.vars.sessionPhase === "countdown" || g.vars.sessionPhase === "play"), `a game runs (${g.vars.sessionPhase})`);
  T += 120000;
  await g.react();
  await settle();
  assert.equal(h.closed, null, "mid-game: never judged");
  // the host's own phone back on a new socket (seat token) after a long silence: a takeover, still the host
  const token = h.frames.find((m) => m.t === "token").d.token;
  const h2 = player(room, "rulesh");
  await h2.hello({ token });
  assert.ok(await h2.until(() => h2.frames.some((m) => m.t === "state")));
  await settle();
  assert.equal(hostOf(r), "rulesh", "still the host");
  assert.equal(r.core.stats.hostLost ?? 0, 0);
  h2.ws.close();
  g.ws.close();
});

test("after a hibernation (memory gone, sockets kept): a stale host is still caught by the next event", async () => {
  const { h, g, r } = await pair("hib");
  await h.text("ping");
  await h.until(() => h.texts.includes("pong"));
  await sleep(1200); // the snapshot is written
  r.core.forget();
  T += 50000;
  await g.react();
  assert.ok(await g.until(() => g.vars.roster?.length === 1), "gone");
  assert.ok(await g.until(() => g.vars.iAmHost === true), "handed over");
  g.ws.close();
});

test("meter: the host's auto-answered pings are estimated 1:1 (elapsed / 20 s) — ≤ 180 a room-hour", async () => {
  const before = (await hub.meter.report()).doRequestsBy.pings;
  const { h, g, r } = await pair("meter");
  await h.text("ping");
  await h.until(() => h.texts.includes("pong"));
  const est0 = r.core.stats.pingsEst ?? 0;
  for (let i = 0; i < 30; i++) {
    T += 2 * 60000; // an hour in 2-minute steps (each step: the host pings, the guest reacts)
    await h.text("ping");
    await g.react();
  }
  await settle();
  const est = (r.core.stats.pingsEst ?? 0) - est0;
  assert.ok(est >= 179 && est <= 181, `≈ 180 in an hour (${est})`);
  // away time is not counted
  await h.raw({ t: "away", d: {} });
  await settle();
  const atAway = r.core.stats.pingsEst;
  T += 10 * 60000;
  await g.react();
  await h.raw({ t: "here", d: {} });
  await settle();
  assert.equal(r.core.stats.pingsEst, atAway, "none while away");
  h.ws.close();
  g.ws.close();
  await settle();
  const rep = await hub.meter.report();
  assert.ok(rep.doRequestsBy.pings - before >= 180, `reported to the meter (${rep.doRequestsBy.pings - before})`);
  assert.equal(rep.used.doRequests, rep.doRequestsBy.conns + rep.doRequestsBy.msgs + rep.doRequestsBy.pings + rep.doRequestsBy.alarms + rep.doRequestsBy.meterCalls, "counted as DO requests");
});
