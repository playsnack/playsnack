// #232: a friends room (`slug~CODE`) holds at most FRIENDS_ROOM_MAX (30) people — distinct devices
// (anonId), spectators included. A device that already has a seat (its socket still in, a seat
// token, the organizer) always gets back in; the next NEW device is refused `friends_full` (4029),
// counted in the meter. Public rooms keep only the 300-socket cap. The hub runs with friendsMax 3.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { FRIENDS_ROOM_MAX, FRIENDS_FULL, GAME_LIMITS } from "../../../edge/room/src/game.js";

let hub = null;
const RUN = Date.now().toString(36).toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "Q");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX = 3;

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_FRIENDS || 5030), limits: { friendsMax: MAX } });
});
after(async () => {
  await hub?.close();
});

function player(room, anonId, hello = {}) {
  const ws = new WebSocket(`${hub.url}/room/${room}`);
  const frames = [];
  const vars = {};
  let closed = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    frames.push(m);
    if (m.t === "state") Object.assign(vars, m.d.sharedState, { participants: m.d.participants });
    else if (m.t === "participants") vars.participants = m.d.count;
    else if (m.t === "setVar") vars[m.d.id] = m.d.value;
  };
  ws.onclose = (ev) => (closed = ev.code);
  const opened = new Promise((r) => (ws.onopen = r));
  const p = {
    frames,
    vars,
    get closed() {
      return closed;
    },
    hello: async (extra = {}) => {
      await opened;
      ws.send(JSON.stringify({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello, ...extra } }));
    },
    act: async (name, payload) => {
      await opened;
      ws.send(JSON.stringify({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${Math.random()}` } }));
    },
    frame: (pred) => frames.find(pred),
    denied: () => frames.find((m) => m.t === "denied")?.d,
    token: () => [...frames].reverse().find((m) => m.t === "token")?.d?.token,
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
const friendsRoom = (tag) => `tpl-tap-battle~${(RUN + tag).padEnd(10, "Q").slice(-10)}`;

test("the cap is a constant: 30 by default (FRIENDS_ROOM_MAX), the hub's test limit overrides it", () => {
  assert.equal(FRIENDS_ROOM_MAX, 30);
  assert.equal(GAME_LIMITS.friendsMax, 30);
  assert.equal(FRIENDS_FULL, "friends_full");
});

test("friends room: the 4th new device is refused friends_full (4029, counted); a spectator holds a seat; the same device on a new socket and a seat token get in when full", { timeout: 20000 }, async () => {
  const room = friendsRoom("A");
  const host = player(room, "fh");
  await host.hello({ organize: true });
  assert.ok(await host.until(() => host.frame((m) => m.t === "organizer")));
  const b = player(room, "fb");
  await b.hello();
  assert.ok(await b.until(() => b.vars.participants === 2));
  // the game starts: the 3rd arrives mid-game and only watches — still a seat
  await host.act("start", { duration: 60000 });
  assert.ok(await b.until(() => b.vars.sessionPhase === "countdown" || b.vars.sessionPhase === "play"));
  const c = player(room, "fc");
  await c.hello();
  assert.ok(await c.until(() => c.vars.iAmSpectator === true), "the 3rd device is a spectator");
  assert.ok(await host.until(() => host.vars.participants === 3));
  const before = (await hub.meter.report()).refusedJoins ?? 0;
  // the 4th new device: refused, with the reason first, then 4029
  const d = player(room, "fd");
  await d.hello();
  assert.ok(await d.until(() => d.closed !== null));
  assert.deepEqual(d.denied(), { reason: "friends_full", max: MAX });
  assert.equal(d.closed, 4029);
  assert.equal(d.frame((m) => m.t === "state"), undefined, "never in the room");
  await sleep(50);
  assert.equal(host.vars.participants, 3, "nobody else saw them");
  // a device that has a seat comes back even though the room is full:
  //   (a) the same device on a second socket with its seat token (silent rejoin #115 / takeover)
  const cTok = c.token();
  assert.ok(cTok);
  const c2 = player(room, "fc");
  await c2.hello({ token: cTok });
  assert.ok(await c2.until(() => c2.frame((m) => m.t === "state")), "takeover of its own seat");
  assert.equal(c2.denied(), undefined);
  //   (b) a device that left (reload) and comes back with its seat token after someone new filled its place
  const bTok = b.token();
  b.close();
  assert.ok(await host.until(() => host.vars.participants === 2));
  const e = player(room, "fe");
  await e.hello();
  assert.ok(await e.until(() => e.frame((m) => m.t === "state")), "a free seat → a new device gets it");
  assert.ok(await host.until(() => host.vars.participants === 3));
  const b2 = player(room, "fb");
  await b2.hello({ token: bTok });
  assert.ok(await b2.until(() => b2.frame((m) => m.t === "state")), "its seat token lets it back in, full or not");
  assert.equal(b2.denied(), undefined);
  //   (c) the organizer reloading with its organizer token
  const orgTok = host.frame((m) => m.t === "organizer").d.token;
  host.close();
  await sleep(100);
  const f = player(room, "ff");
  await f.hello();
  assert.ok(await f.until(() => f.closed !== null));
  assert.equal(f.denied()?.reason, "friends_full", "3 devices (b, c, e) still in: a 4th new one is refused");
  const host2 = player(room, "fh");
  await host2.hello({ organizerToken: orgTok });
  assert.ok(await host2.until(() => host2.frame((m) => m.t === "state")), "the organizer always gets back in");
  assert.equal(host2.denied(), undefined);
  // the refusals are counted in the usage meter like the other refused joins
  for (const p of [b2, c2, e, host2]) p.close();
  await sleep(200);
  assert.ok(((await hub.meter.report()).refusedJoins ?? 0) >= before + 2, "both friends_full refusals counted");
});

test("public room: no friends cap — a 4th, 5th device join (only the 300-socket cap applies)", { timeout: 15000 }, async () => {
  const room = `tpl-tap-battle-pub${RUN.toLowerCase()}`;
  const ps = [];
  for (let i = 0; i < 5; i++) {
    const p = player(room, `pu${i}`);
    await p.hello();
    ps.push(p);
  }
  assert.ok(await ps[0].until(() => ps[0].vars.participants === 5), "5 devices in a public room");
  assert.ok(ps.every((p) => p.denied() === undefined));
  for (const p of ps) p.close();
});
