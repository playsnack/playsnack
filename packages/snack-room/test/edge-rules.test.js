// Who starts a game in an edge room (#135 / #136, edge/room/src/game.js): a friends room's
// organizer is its host (방장) and only the host starts — enforced by the room, not just the UI;
// a public room starts by itself from the app's start payload, and someone arriving mid-game is
// moved to the next generation room (`slug.g2`), which counts down and starts on its own. A new
// room goes through the free-tier guard: refused, the client comes back with `stay` and watches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { nextRoomId, startRuleFor } from "../../../edge/room/src/game.js";

let hub = null;
let guarded = null;
const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AUTO = { start: { duration: 3000 }, ms: 3000 }; // the template's `room` (short for the test)

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_RULES || 4710) });
  // 75 % of a free limit already used today: stage 1 = no new rooms (ongoing rooms go on)
  guarded = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_RULES_GUARD || 4711), free: { workerRequests: 1000 } });
});
after(async () => {
  await hub?.close();
  await guarded?.close();
});

function player(url, room, anonId, hello = {}) {
  const ws = new WebSocket(`${url}/room/${room}`);
  const frames = [];
  const vars = {};
  let closed = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    frames.push(m);
    if (m.t === "state") Object.assign(vars, m.d.sharedState, { participants: m.d.participants });
    else if (m.t === "setVar") vars[m.d.id] = m.d.value;
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
    raw: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello, ...extra } }),
    act: (name, payload) => p.raw({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${++n}` } }),
    frame: (pred) => frames.find(pred),
    async until(fn, ms = 6000) {
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
const reason = (p, r) => p.frame((m) => m.t === "actionAck" && m.d?.reason === r);

test("room ids: friends / organized rooms host, public rooms start by themselves; generations are deterministic", () => {
  assert.equal(startRuleFor("tpl-tap-battle~ABCDEFGH", null), "host");
  assert.equal(startRuleFor("tpl-tap-battle", { org: 1 }), "host");
  assert.equal(startRuleFor("tpl-tap-battle", {}), "auto");
  assert.equal(nextRoomId("tpl-tap-battle"), "tpl-tap-battle.g2");
  assert.equal(nextRoomId("tpl-tap-battle.g2"), "tpl-tap-battle.g3");
  assert.equal(nextRoomId("tpl-tap-battle.g41"), "tpl-tap-battle.g42");
});

test("friends room (#135): the organizer hosts; a friend's start / lobby are refused by the room (not_host); the host starts", async () => {
  const room = `tpl-tap-battle~${RUN.toUpperCase().replace(/[^A-Z2-9]/g, "Q").padEnd(8, "Q")}`;
  const host = player(hub.url, room, "host1", { nick: "방장님" });
  await host.hello({ organize: true });
  assert.ok(await host.until(() => host.frame((m) => m.t === "organizer")));
  const f = player(hub.url, room, "friend1", { nick: "친구" });
  await f.hello();
  assert.ok(await f.until(() => f.vars.roster?.length === 2));
  assert.equal(f.vars.roomMode, "host");
  assert.equal(f.vars.hostNick, "방장님");
  assert.equal(f.vars.iAmHost, false);
  assert.ok(await host.until(() => host.vars.iAmHost === true));
  await f.act("start", { duration: 3000 });
  await f.act("lobby");
  assert.ok(await f.until(() => f.frames.filter((m) => m.d?.reason === "not_host").length === 2));
  await sleep(150);
  assert.notEqual(f.vars.sessionPhase, "countdown");
  await host.act("start", { duration: 3000 });
  assert.ok(await f.until(() => f.vars.sessionPhase === "countdown"));
  assert.equal(reason(host, "not_host"), undefined);
  // no autoStart countdown, no moving, in a friends room
  assert.equal(f.frame((m) => m.t === "autoStart" || m.t === "moveTo"), undefined);
  host.close();
  f.close();
});

test("public room (#136): counts down from the first arrival, starts by itself; a late arrival is moved to the next room, which starts on its own", async () => {
  const room = `tpl-tap-battle-${RUN}`;
  const a = player(hub.url, room, "pa");
  await a.hello({ autoStart: { start: { duration: 20000 }, ms: 3000 } });
  assert.ok(await a.until(() => a.frame((m) => m.t === "autoStart")));
  assert.equal(a.vars.roomMode, "auto");
  const first = a.frame((m) => m.t === "autoStart").d;
  assert.ok(first.endsIn > 2500 && first.endsIn <= 3000, `endsIn ${first.endsIn}`);
  await sleep(1000);
  const b = player(hub.url, room, "pb");
  await b.hello({ autoStart: AUTO });
  assert.ok(await b.until(() => b.frame((m) => m.t === "autoStart")));
  const left = b.frame((m) => m.t === "autoStart").d.endsIn;
  assert.ok(left < 2200 && left > 1000, `joined mid-countdown, told ${left} ms left`);
  await b.act("start", {});
  assert.ok(await b.until(() => reason(b, "auto_start")), "nobody presses start");
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown", 4000), "started by itself");
  assert.equal(b.vars.sessionPhase, "countdown");
  // a late arrival: told to move, closed 4010, never on this room's roster
  const c = player(hub.url, room, "pc");
  await c.hello({ autoStart: AUTO });
  assert.ok(await c.until(() => c.closed !== null));
  assert.equal(c.closed, 4010);
  assert.deepEqual(c.frame((m) => m.t === "moveTo")?.d, { room: `${room}.g2` });
  assert.equal(c.frame((m) => m.t === "state"), undefined);
  await sleep(200);
  assert.deepEqual(a.vars.roster, ["pa", "pb"]);
  // a second late arrival lands in the same next room
  const d = player(hub.url, room, "pd");
  await d.hello({ autoStart: AUTO });
  assert.ok(await d.until(() => d.closed === 4010));
  assert.equal(d.frame((m) => m.t === "moveTo").d.room, `${room}.g2`);
  // they play there: its own countdown, then a game
  const c2 = player(hub.url, `${room}.g2`, "pc");
  await c2.hello({ autoStart: AUTO });
  const d2 = player(hub.url, `${room}.g2`, "pd");
  await d2.hello({ autoStart: AUTO });
  assert.ok(await c2.until(() => c2.frame((m) => m.t === "autoStart")));
  assert.ok(await d2.until(() => d2.vars.roster?.length === 2));
  assert.ok(await c2.until(() => c2.vars.sessionPhase === "countdown", 4000));
  assert.ok(await c2.until(() => c2.vars.sessionPhase === "play", 4000));
  assert.notEqual(c2.vars.iAmSpectator, true);
  // a member of the first room reloading mid-game is not moved
  b.close();
  await sleep(100);
  const b2 = player(hub.url, room, "pb");
  await b2.hello({ autoStart: AUTO });
  assert.ok(await b2.until(() => b2.frame((m) => m.t === "state")));
  assert.equal(b2.frame((m) => m.t === "moveTo"), undefined);
  // an old client (no start payload) is never moved: it watches, as before
  const old = player(hub.url, room, "old1");
  await old.hello();
  assert.ok(await old.until(() => old.frame((m) => m.t === "state")));
  assert.equal(old.vars.iAmSpectator, true);
  [a, b2, c2, d2, old].forEach((x) => x.close());
});

test("public room after a game: the result holds, then the lobby — and the countdown again", { timeout: 30000 }, async () => {
  const room = `tpl-coop-${RUN}`;
  const a = player(hub.url, room, "qa");
  await a.hello({ autoStart: { start: { duration: 3000 }, ms: 3000 } });
  assert.ok(await a.until(() => a.vars.sessionPhase === "play", 8000));
  await a.act("taps", { count: 4 });
  assert.ok(await a.until(() => a.vars.sessionPhase === "result", 5000));
  const n = a.frames.filter((m) => m.t === "autoStart").length;
  assert.ok(await a.until(() => a.vars.sessionPhase === "lobby", 10000), "back to the lobby after RESULT_HOLD_MS");
  assert.ok(await a.until(() => a.frames.filter((m) => m.t === "autoStart").length === n + 1));
  a.close();
});

test("free-tier guard: the next room cannot open today → refused (room_full_today); back in the first room with `stay`, the person watches", async () => {
  await guarded.meter.add({ conns: 750 }); // 75 % of 1,000 Worker requests → stage 1
  const room = `tpl-guard-${RUN}`;
  // the first room opens while the day is still under 70 % (limit raised for a moment)
  guarded.meter.free.workerRequests = 100000;
  const a = player(guarded.url, room, "ga");
  await a.hello({ autoStart: AUTO });
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown", 5000));
  guarded.meter.free.workerRequests = 1000; // now at 75 %
  const c = player(guarded.url, room, "gc");
  await c.hello({ autoStart: AUTO });
  assert.ok(await c.until(() => c.closed === 4010));
  const next = c.frame((m) => m.t === "moveTo").d.room;
  const c2 = player(guarded.url, next, "gc");
  await c2.hello({ autoStart: AUTO });
  assert.ok(await c2.until(() => c2.frame((m) => m.t === "denied")));
  assert.equal(c2.frame((m) => m.t === "denied").d.reason, "room_full_today", "a new room goes through the same guard");
  const c3 = player(guarded.url, room, "gc");
  await c3.hello({ autoStart: AUTO, stay: true });
  assert.ok(await c3.until(() => c3.frame((m) => m.t === "state")));
  assert.equal(c3.frame((m) => m.t === "moveTo"), undefined);
  assert.equal(c3.vars.iAmSpectator, true);
  [a, c3].forEach((x) => x.close());
});
