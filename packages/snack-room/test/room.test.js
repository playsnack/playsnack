import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom } from "../src/room.js";

// Deterministic clock + timer queue; every broadcast/send is recorded.
function harness({ pack = null, defaults = {}, random = () => 0.5 } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const out = [];
  const points = [];
  const room = createRoom({
    defaults,
    random,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    getPack: async () => pack,
    broadcast: (type, d) => out.push({ to: "*", type, d }),
    send: (peerId, type, d) => out.push({ to: peerId, type, d }),
    onPoints: (anonId, nick, p) => points.push([anonId, p]),
  });
  // Let pending async work (the content fetch in startSession) schedule its
  // timers before time moves.
  const flush = () => new Promise((res) => setImmediate(res));
  const advance = async (ms) => {
    await flush();
    const end = t + ms;
    for (;;) {
      const next = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      t = next.at;
      next.fn();
      await flush();
    }
    t = end;
    await flush();
  };
  // Latest value of a broadcast setVar.
  const v = (id) => [...out].reverse().find((m) => m.to === "*" && m.type === "setVar" && m.d.id === id)?.d.value;
  const join = (n) => room.join(`p${n}`, { anonId: `a${n}`, nick: `닉${n}` });
  const act = (n, name, payload) => room.action(`p${n}`, { name, payload, clientMsgId: `m${n}${name}` });
  return { room, out, points, advance, v, join, act, timers, now: () => t };
}

test("join sends full state to the newcomer and the roster to everyone", () => {
  const h = harness({ defaults: { A: 0, B: 0 } });
  h.join(1);
  h.join(2);
  const state = h.out.filter((m) => m.type === "state");
  assert.equal(state.length, 2);
  assert.equal(state[1].to, "p2");
  assert.equal(state[1].d.participants, 2);
  assert.deepEqual(state[1].d.sharedState.votesByOption, { A: 0, B: 0 });
  assert.deepEqual(h.v("roster"), ["닉1", "닉2"]);
  assert.equal(h.out.filter((m) => m.type === "participants").at(-1).d.count, 2);
  assert.equal(h.room.leave("p1"), false);
  assert.deepEqual(h.v("roster"), ["닉2"]);
  assert.equal(h.room.leave("p2"), true);
});

test("votes: one per person, re-vote moves it, tally broadcast + ack", () => {
  const h = harness({ defaults: { A: 0, B: 0 } });
  h.join(1);
  h.join(2);
  h.act(1, "vote", { option: "A" });
  h.act(2, "vote", { option: "A" });
  h.act(2, "vote", { option: "B" });
  assert.deepEqual(h.v("votesByOption"), { A: 1, B: 1 });
  assert.ok(h.out.some((m) => m.to === "p1" && m.type === "actionAck" && m.d.accepted));
});

test("co-op tally and best-score leaderboard", () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(1, "tally", { delta: 5 });
  h.act(2, "tally", {});
  assert.equal(h.v("coopTotal"), 6);
  h.act(1, "score", { score: 30 });
  h.act(1, "score", { score: 10 }); // not a record
  h.act(2, "score", { score: 50 });
  assert.deepEqual(h.v("leaderboard"), [50, 30]);
});

test("single-window session: countdown 3·2·1 → play → taps race → result", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(1, "start", { duration: 5000 });
  await h.advance(0);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.v("sessionCountdown"), 3);
  await h.advance(1000);
  assert.equal(h.v("sessionCountdown"), 2);
  await h.advance(2000);
  assert.equal(h.v("sessionPhase"), "play");
  h.act(1, "tap");
  h.act(1, "tap");
  h.act(2, "tap");
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 2 }, { nick: "닉2", score: 1 }]);
  h.act(2, "start", {}); // ignored while running
  await h.advance(5000);
  assert.equal(h.v("sessionPhase"), "result");
  assert.deepEqual(h.v("leaderboard"), [2, 1]);
});

test("quiz: answer hidden during the window, faster correct answers score more", async () => {
  const pack = [{ q: "1+1?", options: ["1", "2", "3", "4"], answer: 1 }];
  const h = harness({ pack });
  h.join(1);
  h.join(2);
  h.act(1, "start", { game: "trivia", quiz: true, rounds: 1, answerMs: 8000, revealMs: 2000 });
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "play");
  assert.equal(h.v("roundAnswer"), -1);
  assert.equal(h.v("roundContent").answer, undefined);
  h.act(1, "answer", { option: 1 }); // instantly
  await h.advance(4000);
  h.act(2, "answer", { option: 1 }); // halfway
  h.act(2, "answer", { option: 1 }); // second answer ignored
  await h.advance(4000);
  assert.equal(h.v("roundAnswer"), 1);
  const [first, second] = h.v("raceBoard");
  assert.equal(first.nick, "닉1");
  assert.equal(first.score, 1000);
  assert.equal(second.score, 600);
  await h.advance(2000);
  assert.equal(h.v("sessionPhase"), "result");
});

test("nunchi: a solo tap claims the number, simultaneous taps knock both out", async () => {
  const h = harness();
  [1, 2, 3, 4].forEach(h.join);
  h.act(1, "start", { mode: "nunchi" });
  await h.advance(3000);
  h.act(1, "tap");
  await h.advance(400);
  assert.equal(h.v("nunchiNum"), 2);
  h.act(2, "tap");
  h.act(3, "tap");
  await h.advance(400);
  assert.equal(h.v("eliminatedCount"), 2);
  assert.ok(h.out.some((m) => m.to === "p2" && m.d?.id === "iAmOut" && m.d.value === true));
  assert.ok(!h.out.some((m) => m.to === "p1" && m.d?.id === "iAmOut" && m.d.value === true));
  assert.equal(h.v("sessionPhase"), "play");
});

test("bracket: matchups advance by room vote down to a champion", async () => {
  const pack = ["a", "b", "c", "d"].map((name) => ({ name }));
  const h = harness({ pack, random: () => 0.99 }); // shuffle keeps order
  h.join(1);
  h.act(1, "start", { game: "worldcup", bracket: true, matchupMs: 4000 });
  await h.advance(3000);
  assert.equal(h.v("bracketLabel"), "4강 · 1/2");
  h.act(1, "vote", { option: "o1" });
  await h.advance(4000 + 2200);
  assert.equal(h.v("bracketLabel"), "4강 · 2/2");
  await h.advance(4000 + 2200); // no votes → o0 wins
  assert.equal(h.v("bracketLabel"), "결승 · 1/1");
  await h.advance(4000 + 2200);
  assert.equal(h.v("sessionPhase"), "result");
  assert.ok(h.v("champion")?.name);
});

test("reaction: tapping before green is a foul, after green scores by speed", async () => {
  const h = harness({ random: () => 0 }); // green 1.5s after play
  h.join(1);
  h.join(2);
  h.act(1, "start", { mode: "reaction" });
  await h.advance(3000);
  h.act(1, "tap"); // foul
  await h.advance(1500);
  assert.equal(h.v("reactionGo"), true);
  await h.advance(300);
  h.act(2, "tap");
  const rb = h.v("raceBoard");
  assert.deepEqual(rb.map((x) => [x.nick, x.score]), [["닉2", 1700], ["닉1", 0]]);
});

test("guess: votes stay hidden, majority voters score at the reveal", async () => {
  const pack = [{ a: "민초", b: "반민초" }];
  const h = harness({ pack, defaults: {} });
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", { game: "majority", mode: "guess", rounds: 1, roundMs: 5000, revealMs: 2000 });
  await h.advance(3000);
  const before = h.out.filter((m) => m.d?.id === "votesByOption").length;
  h.act(1, "vote", { option: "o1" });
  h.act(2, "vote", { option: "o1" });
  h.act(3, "vote", { option: "o0" });
  assert.equal(h.out.filter((m) => m.d?.id === "votesByOption").length, before); // hidden
  await h.advance(5000);
  assert.equal(h.v("roundAnswer"), 1);
  assert.deepEqual(h.v("raceBoard").map((x) => x.score), [100, 100]);
});

test("lobby resets the session; teardown makes pending timers harmless", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "start", { duration: 5000 });
  await h.advance(1000);
  h.act(1, "lobby");
  assert.equal(h.v("sessionPhase"), "lobby");
  assert.equal(h.timers.size, 0);
  h.act(1, "start", { duration: 5000 });
  h.room.leave("p1"); // room empties while the content fetch is in flight
  await h.advance(10000);
  assert.notEqual(h.v("sessionPhase"), "play");
});

test("snapshot → restore on another engine resumes a quiz mid-round (host hand-over)", async () => {
  const pack = [
    { q: "1+1?", options: ["1", "2", "3", "4"], answer: 1 },
    { q: "2+2?", options: ["2", "3", "4", "5"], answer: 2 },
  ];
  const a = harness({ pack, random: () => 0.99 }); // shuffle keeps order
  [1, 2].forEach(a.join);
  a.act(1, "start", { game: "trivia", quiz: true, rounds: 2, answerMs: 8000, revealMs: 2000 });
  await a.advance(3000 + 2000); // 2s into round 1
  a.act(1, "answer", { option: 1 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot())); // over the wire
  a.room.destroy();

  // New host: its clock is unrelated; the snapshot is 500ms old by the time it lands.
  const b = harness({ pack });
  await b.advance(123456);
  assert.equal(b.room.restore(snap, 500), true);
  [1, 2].forEach(b.join);
  b.act(2, "answer", { option: 1 }); // still inside the window
  b.act(1, "answer", { option: 0 }); // already answered → ignored
  await b.advance(8000 - 2000 - 500 - 1);
  assert.notEqual(b.v("roundAnswer"), 1); // not revealed yet
  await b.advance(1);
  assert.equal(b.v("roundAnswer"), 1); // reveal lands on the original schedule
  const board = b.v("raceBoard");
  assert.equal(board[0].nick, "닉1"); // the pre-hand-over answer kept its score
  assert.equal(board[0].score, 800); // answered 2s into an 8s window
  assert.equal(board[1].nick, "닉2");
  await b.advance(2000);
  assert.equal(b.v("roundNum"), 2);
});

test("snapshot carries a tap race through a hand-over to the result", async () => {
  const a = harness();
  [1, 2].forEach(a.join);
  a.act(1, "start", { duration: 6000 });
  await a.advance(3000 + 1000);
  a.act(1, "tap");
  a.act(2, "tap");
  a.act(2, "tap");
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  const b = harness();
  b.room.restore(snap, 0);
  [1, 2].forEach(b.join);
  b.act(1, "tap");
  await b.advance(5000);
  assert.equal(b.v("sessionPhase"), "result");
  assert.deepEqual(b.v("leaderboard"), [2, 2]);
});
