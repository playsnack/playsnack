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

test("a reload overlapping the old connection keeps the player on the roster", () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.room.join("p2b", { anonId: "a2", nick: "닉2" }); // the reloaded tab, before the old one is gone
  assert.deepEqual(h.v("roster"), ["닉1", "닉2"]);
  assert.equal(h.room.leave("p2"), false); // the old connection drops
  assert.deepEqual(h.v("roster"), ["닉1", "닉2"]);
  assert.equal(h.room.stateFor("p1").sharedState.roster.length, 2);
  h.room.leave("p2b");
  assert.deepEqual(h.v("roster"), ["닉1"]);
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
  assert.deepEqual(h.v("raceBoard").map((x) => x.score), [2, 1]);
  assert.equal(h.v("leaderboard"), undefined); // MP-13: a session never shows the numbers-only board
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

test("nunchi: an eliminated player leaving does not end the game early", async () => {
  const h = harness();
  [1, 2, 3, 4].forEach(h.join);
  h.act(1, "start", { mode: "nunchi" });
  await h.advance(3000);
  h.act(2, "tap");
  h.act(3, "tap");
  await h.advance(400);
  assert.equal(h.v("eliminatedCount"), 2);
  h.room.leave("p2"); // knocked out, closes the tab
  h.act(1, "tap"); // a solo claim: 1 and 4 are still in
  await h.advance(400);
  assert.equal(h.v("nunchiNum"), 2);
  assert.equal(h.v("sessionPhase"), "play");
  h.room.leave("p4"); // a survivor leaves: now 1 is the last one
  h.act(1, "tap");
  await h.advance(400);
  assert.equal(h.v("sessionPhase"), "result");
  assert.match(h.v("nunchiWinner"), /닉1 최후의 1인/);
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
  assert.deepEqual(b.v("raceBoard").map((x) => x.score), [2, 2]);
});

// ── variable stores (MP-05 · MP-07) ──
const stateTo = (h, peer) => h.out.filter((m) => m.type === "state" && m.to === peer).at(-1)?.d.sharedState;

test("MP-05: a late joiner gets the current round (content, counter) at once", async () => {
  const pack = [{ a: "짜장", b: "짬뽕" }, { a: "여름", b: "겨울" }];
  const h = harness({ pack, random: () => 0.99, defaults: { o0: 0, o1: 0 } });
  [1, 2].forEach(h.join);
  h.act(1, "start", { game: "balance", rounds: 2, roundMs: 5000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o0" });
  h.join(3); // arrives mid-round
  const s = stateTo(h, "p3");
  assert.equal(s.sessionPhase, "play");
  assert.deepEqual(s.roundContent, pack[0]);
  assert.equal(s.roundNum, 1);
  assert.equal(s.roundTotal, 2);
  assert.deepEqual(s.votesByOption, { o0: 1, o1: 0 });
  assert.deepEqual(s.roster, ["닉1", "닉2", "닉3"]);
});

test("MP-05: 눈치 배틀 votes stay hidden from a late joiner too", async () => {
  const h = harness({ pack: [{ a: "x", b: "y" }], defaults: {} });
  [1, 2].forEach(h.join);
  h.act(1, "start", { game: "majority", mode: "guess", rounds: 1, roundMs: 5000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o1" });
  h.join(3);
  assert.notEqual(stateTo(h, "p3").votesByOption?.o1, 1);
});

test("MP-07: an eliminated player stays out after a reload (same anonId, new peer)", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", { mode: "nunchi" });
  await h.advance(3000);
  h.act(2, "tap");
  h.act(3, "tap");
  await h.advance(400);
  assert.ok(h.out.some((m) => m.to === "p2" && m.d?.id === "iAmOut" && m.d.value === true));
  // p2 reloads: leaves, comes back as a new peer with the same anonId
  h.room.leave("p2");
  h.room.join("p2b", { anonId: "a2", nick: "닉2" });
  assert.equal(stateTo(h, "p2b").iAmOut, true);
  assert.equal(h.room.stateFor("p1").sharedState.iAmOut, false); // others are still in
  // the next game resets everyone
  h.act(1, "lobby");
  h.act(1, "start", { mode: "nunchi" });
  await h.advance(0);
  assert.equal(h.room.stateFor("p2b").sharedState.iAmOut, false);
});

test("per-player values survive snapshot → restore (host hand-over)", async () => {
  const a = harness();
  [1, 2, 3, 4].forEach(a.join);
  a.act(1, "start", { mode: "nunchi" });
  await a.advance(3000);
  a.act(2, "tap");
  a.act(3, "tap");
  await a.advance(400);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  const b = harness();
  b.room.restore(snap, 0);
  [1, 2, 3, 4].forEach(b.join);
  assert.equal(stateTo(b, "p2").iAmOut, true);
  assert.equal(stateTo(b, "p1").iAmOut, false);
  assert.equal(stateTo(b, "p1").sessionPhase, "play");
  assert.equal(stateTo(b, "p1").eliminatedCount, 2);
});

// ── fair judging (MP-08) ──
test("MP-08: a reaction is scored by the DEVICE's measured ms, not by when the host heard it", async () => {
  const h = harness({ random: () => 0 }); // green 1.5s after play
  [1, 2, 3, 4, 5].forEach(h.join);
  h.act(1, "start", { mode: "reaction" });
  await h.advance(3000 + 1500);
  assert.equal(h.v("reactionGo"), true);
  await h.advance(400);
  h.act(1, "reaction", { ms: 400 }); // honest: reacted in 400, the message arrived at +400
  await h.advance(500);
  h.act(2, "reaction", { ms: 150 }); // reacted in 150 but a slow network: arrived at +900
  h.act(3, "reaction", { ms: 30 }); // faster than a human: anticipated → 부정출발
  h.act(4, "reaction", { ms: -1 }); // tapped before green (the device says so) → 부정출발
  h.act(5, "reaction", { ms: 9000 }); // after the window → not ranked
  const rb = h.v("raceBoard");
  assert.deepEqual(rb.map((x) => [x.nick, x.score]), [["닉2", 1850], ["닉1", 1600], ["닉3", 0], ["닉4", 0]]);
  // Host-time scoring (the old rule) would have put 닉1 (+400) ahead of 닉2 (+900).
  assert.ok(rb[0].nick === "닉2" && 2000 - rb[0].score === 150, "score = 2000 − device ms");
});

test("MP-08: a reaction claim faster than the host itself saw is clamped (and one per player)", async () => {
  const h = harness({ random: () => 0 });
  h.join(1);
  h.act(1, "start", { mode: "reaction" });
  await h.advance(3000 + 1500);
  await h.advance(20);
  h.act(1, "reaction", { ms: 100 }); // the host saw green only 20 ms ago → at most 70
  assert.equal(h.v("raceBoard")[0].score, 2000 - 70);
  h.act(1, "reaction", { ms: 90 }); // second one ignored
  assert.equal(h.v("raceBoard")[0].score, 2000 - 70);
});

test("MP-08: a reaction still lands in the grace after the window closes", async () => {
  const h = harness({ random: () => 0 });
  [1, 2].forEach(h.join);
  h.act(1, "start", { mode: "reaction" });
  await h.advance(3000 + 1500 + 4000); // window over → result
  assert.equal(h.v("sessionPhase"), "result");
  await h.advance(1000);
  h.act(1, "reaction", { ms: 3900 }); // reacted inside the window, the message was slow
  assert.deepEqual(h.v("raceBoard").map((x) => [x.nick, x.score]), [["닉1", 1]]);
  await h.advance(1000); // grace over
  h.act(2, "reaction", { ms: 3950 });
  assert.equal(h.v("raceBoard").length, 1);
});

test("MP-08: tap counts — the max of the device's cumulative batches, capped at 15/s, final value after the window", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 5000 });
  await h.advance(3000 + 1000); // 1 s into play
  h.act(1, "taps", { count: 5 });
  h.act(1, "taps", { count: 3 }); // an older batch arriving late: never rolls back
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 5 }]);
  h.act(1, "taps", { count: 100 }); // 100 taps in 1 s: impossible → clamped to 15·1 + 5
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 20 }]);
  h.act(2, "tap"); // legacy per-tap clients still count (+1 each)
  h.act(2, "tap");
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 20 }, { nick: "닉2", score: 2 }]);
  await h.advance(4000); // window over → result
  assert.equal(h.v("sessionPhase"), "result");
  await h.advance(1000);
  h.act(2, "taps", { count: 7 }); // the final batch lands inside the grace: the board agrees with the card
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 20 }, { nick: "닉2", score: 7 }]);
  await h.advance(1000);
  h.act(2, "taps", { count: 9 }); // too late
  assert.deepEqual(h.v("raceBoard")[1], { nick: "닉2", score: 7 });
  assert.ok(h.out.some((m) => m.type === "actionAck" && m.d.clientMsgId === "m2taps"), "acked anyway");
});

test("MP-08: a 'countdown' message says when play starts, right before the first number", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "start", { duration: 5000 });
  await h.advance(0);
  const cd = h.out.find((m) => m.type === "countdown");
  assert.deepEqual(cd.d, { n: 3, stepMs: 1000, endsIn: 3000 });
  assert.equal(h.out[h.out.indexOf(cd) + 2].d.id, "sessionCountdown"); // countdown → sessionPhase → sessionCountdown
});

test("MP-08: tap counts survive a hand-over (play clock and grace are in the snapshot)", async () => {
  const a = harness();
  [1, 2].forEach(a.join);
  a.act(1, "start", { duration: 5000 });
  await a.advance(3000 + 2000);
  a.act(1, "taps", { count: 10 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  const b = harness();
  await b.advance(99999);
  b.room.restore(snap, 100);
  [1, 2].forEach(b.join);
  b.act(2, "taps", { count: 200 }); // 2.1 s of play on the new host's clock → cap 15·2.1 + 5
  assert.deepEqual(b.v("raceBoard").map((x) => x.score), [36, 10]);
});

// ── ties (MP-11) · leavers (MP-12) · early advance (T-21) ──
test("MP-11: a bracket tie is announced as 동점 and settled by the coin, not by position", async () => {
  const pack = ["a", "b", "c", "d"].map((name) => ({ name }));
  const h = harness({ pack, random: () => 0.99 }); // shuffle keeps order; the coin says 1
  [1, 2].forEach(h.join);
  h.act(1, "start", { game: "worldcup", bracket: true, matchupMs: 4000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o0" });
  h.act(2, "vote", { option: "o1" }); // 1–1, everyone voted → resolves early
  await h.advance(600);
  assert.equal(h.v("matchWinner"), 1); // the old rule: ">= → the left one"
  assert.match(h.v("bracketLabel"), /동점/);
  await h.advance(2200);
  assert.doesNotMatch(h.v("bracketLabel"), /동점/); // the next matchup starts clean
});

test("T-21: a matchup resolves once everyone here has voted, not after the full timer", async () => {
  const pack = ["a", "b", "c", "d"].map((name) => ({ name }));
  const h = harness({ pack, random: () => 0.99 });
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", { game: "worldcup", bracket: true, matchupMs: 8000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o1" });
  h.act(2, "vote", { option: "o1" });
  await h.advance(1000);
  assert.equal(h.v("matchWinner"), -1); // one vote still missing → waiting
  h.act(3, "vote", { option: "o0" });
  await h.advance(600);
  assert.equal(h.v("matchWinner"), 1); // all in → resolved at once (~0.6 s), 6 s early
  await h.advance(2200);
  assert.equal(h.v("bracketLabel"), "4강 · 2/2");
  h.act(1, "vote", { option: "o0" });
  h.act(1, "vote", { option: "o1" }); // a re-vote is not a second voter
  await h.advance(1000);
  assert.equal(h.v("matchWinner"), -1);
});

test("MP-11: a 눈치 배틀 tie has no majority — roundAnswer 2, nobody scores", async () => {
  const pack = [{ a: "민초", b: "반민초" }];
  const h = harness({ pack, defaults: {} });
  [1, 2].forEach(h.join);
  h.act(1, "start", { game: "majority", mode: "guess", rounds: 1, roundMs: 5000, revealMs: 2000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o0" });
  h.act(2, "vote", { option: "o1" });
  await h.advance(5000);
  assert.equal(h.v("roundAnswer"), 2);
  assert.deepEqual(h.v("raceBoard"), []);
});

test("MP-12: a player who left is still ranked, marked (나감), on every board", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", { duration: 5000 });
  await h.advance(3000);
  h.act(2, "tap");
  h.act(2, "tap");
  h.act(1, "tap");
  h.room.leave("p2");
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉2 (나감)", score: 2, left: true }, { nick: "닉1", score: 1 }]);
  h.join(4); // a late joiner sees the same
  assert.deepEqual(stateTo(h, "p4").raceBoard, h.v("raceBoard"));
  h.room.join("p2b", { anonId: "a2", nick: "닉2" }); // back → unmarked again on the next change
  h.act(3, "tap");
  assert.deepEqual(h.v("raceBoard")[0], { nick: "닉2", score: 2 });
});
