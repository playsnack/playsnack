import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../bite/src/runtime.js";
import { createRoom } from "../src/room.js";

// Headless "two devices, one room": each device runs the REAL template in the Bite
// runtime; its `emit`s go into the room engine and the engine's setVars go back to every
// device — the way the player wires it (LiveApp). Per-device state (내 탭, 내 반응, my vote)
// is the template's own business, so what one device shows must agree with what the
// board says about it — in the first game and in the next one, whoever pressed 시작.
const DIR = new URL("../../../snack-server/data/bite/", import.meta.url);
const CONTENT = new URL("../../../snack-server/data/multi-content/", import.meta.url);
const load = (id) => JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));

function table(id, nicks, { random = () => 0.3 } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const devices = new Map(); // peerId → app
  const room = createRoom({
    defaults: load(id).vars?.votesByOption ?? {},
    now: () => t,
    random,
    setTimer: (fn, ms) => {
      const h = ++seq;
      timers.set(h, { at: t + ms, fn, h });
      return h;
    },
    clearTimer: (h) => timers.delete(h),
    getPack: async (game) => {
      try {
        return JSON.parse(readFileSync(new URL(`${game}.json`, CONTENT), "utf8"));
      } catch {
        return null;
      }
    },
    broadcast: (type, d) => {
      if (type !== "setVar") return;
      for (const app of devices.values()) app.setVar(d.id, d.value);
    },
    send: (peerId, type, d) => {
      const app = devices.get(peerId);
      if (!app) return;
      if (type === "setVar") app.setVar(d.id, d.value);
      if (type === "state") for (const [k, v] of Object.entries(d.sharedState)) app.setVar(k, v);
    },
  });
  for (const [i, nick] of nicks.entries()) {
    const peerId = `p${i}`;
    const app = createBite(load(id), { now: () => t, warn: (m) => assert.fail(`${nick}: ${m}`) });
    app.on("emit", (e) => room.action(peerId, { name: e.name, payload: e.payload, clientMsgId: `${peerId}-${++seq}` }));
    app.start();
    devices.set(peerId, app);
    room.join(peerId, { anonId: `a${i}`, nick });
  }
  const flush = () => new Promise((r) => setImmediate(r));
  // Time passes: run due timers, and every device renders a frame every `frame` ms.
  const advance = async (ms, frame = 16) => {
    await flush();
    const end = t + ms;
    while (t < end) {
      const next = [...timers.values()].filter((x) => x.at <= Math.min(end, t + frame)).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (next) {
        timers.delete(next.h);
        t = next.at;
        next.fn();
        await flush();
      } else t = Math.min(end, t + frame);
      for (const app of devices.values()) app.tick();
      await flush();
    }
  };
  const app = (i) => devices.get(`p${i}`);
  return { room, advance, app, tap: (i, node) => app(i).tap(node), v: (i, name) => app(i).eval(name), phase: (i) => app(i).phase };
}

test("tap-battle: game 2 started by the OTHER device — board == 내 탭 card on the non-starter", async () => {
  const T = table("tap-battle", ["A", "B"]);
  T.tap(0, "startBtn"); // A starts game 1
  await T.advance(3200);
  assert.equal(T.phase(1), "play");
  for (let i = 0; i < 40; i++) {
    T.tap(1, "tapArea"); // 12.5 taps/s — a fast human, under the 15/s cap
    await T.advance(80);
  }
  await T.advance(10000); // the 10 s window ends (+ the final batch)
  assert.equal(T.phase(1), "result");
  assert.equal(T.v(1, "myTaps"), 40);
  assert.deepEqual(T.v(1, "raceBoard"), [{ nick: "B", score: 40 }]);
  T.tap(0, "againBtn"); // A starts game 2; B never pressed anything but the pad
  await T.advance(3200);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "myTaps"), 0, "the card starts at 0 for the non-starter too");
  for (let i = 0; i < 50; i++) {
    T.tap(1, "tapArea");
    await T.advance(80);
  }
  await T.advance(10000);
  assert.equal(T.phase(1), "result");
  assert.equal(T.v(1, "myTaps"), 50);
  assert.deepEqual(T.v(1, "raceBoard"), [{ nick: "B", score: 50 }], "board == card (not 90)");
  assert.deepEqual(T.v(0, "raceBoard"), T.v(1, "raceBoard"));
});

test("reaction-duel: game 2 on the non-starter starts un-reacted and measures again", async () => {
  const T = table("reaction-duel-score", ["A", "B"], { random: () => 0 }); // green 1.5 s after play
  T.tap(0, "startBtn");
  await T.advance(3000 + 1500 + 300);
  T.tap(1, "tapArea"); // B reacts ~300 ms after green
  assert.equal(T.v(1, "myReacted"), true);
  await T.advance(5000);
  assert.equal(T.phase(1), "result");
  const first = T.v(1, "raceBoard");
  assert.equal(first[0].nick, "B");
  assert.ok(first[0].score >= 2000 - 320 && first[0].score <= 2000 - 290, JSON.stringify(first));
  T.tap(0, "againBtn");
  await T.advance(3000 + 100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "myReacted"), false, "the pad is live again for the non-starter");
  assert.equal(T.v(1, "myResult"), "");
  await T.advance(1400 + 150);
  T.tap(1, "tapArea"); // ~150 ms after green this time
  await T.advance(5000);
  const second = T.v(1, "raceBoard");
  assert.ok(second[0].score >= 2000 - 170 && second[0].score <= 2000 - 140, JSON.stringify(second));
});

test("majority-guess: game 2 round 1 on the non-starter does not show last game's vote", async () => {
  const T = table("majority-guess", ["A", "B"]);
  const start = { game: "majority", mode: "guess", rounds: 1, roundMs: 3000, revealMs: 1000 };
  T.room.action("p0", { name: "start", payload: start, clientMsgId: "s1" });
  await T.advance(3100);
  assert.equal(T.phase(1), "play");
  T.tap(1, "cardA"); // B votes in game 1, round index 0
  assert.equal(T.v(1, "myVoteRound"), 0);
  await T.advance(5000);
  assert.equal(T.phase(1), "result");
  T.room.action("p0", { name: "start", payload: start, clientMsgId: "s2" }); // A restarts
  await T.advance(3100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "roundIdx"), 0);
  assert.notEqual(T.v(1, "myVoteRound"), T.v(1, "roundIdx"), "no 'voted already' from last game's round 0");
});
