import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom, cleanNick } from "../src/room.js";

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
  const right = h.v("roundContent").options.indexOf("2"); // options are shuffled each round
  h.act(1, "answer", { option: right }); // instantly
  await h.advance(4000);
  h.act(2, "answer", { option: right }); // halfway
  h.act(2, "answer", { option: right }); // second answer ignored
  await h.advance(4000);
  assert.equal(h.v("roundAnswer"), right);
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
  await h.advance(2000);
  h.act(1, "reaction", { ms: 3900 }); // reacted inside the window, the message was slow
  assert.deepEqual(h.v("raceBoard").map((x) => [x.nick, x.score]), [["닉1", 1]]);
  await h.advance(1000); // grace (2.5 s) over
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
  await h.advance(2000); // two lost sends (700 ms resend) + the worst broker delay still make it
  h.act(2, "taps", { count: 7 }); // the final batch lands inside the grace: the board agrees with the card
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 20 }, { nick: "닉2", score: 7 }]);
  await h.advance(1000);
  h.act(2, "taps", { count: 9 }); // too late (grace is 2.5 s)
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

test("T-21: a leaver's vote does not count as 'everyone here voted'; a leave can complete it", async () => {
  const pack = ["a", "b", "c", "d"].map((name) => ({ name }));
  const h = harness({ pack, random: () => 0.99 });
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", { game: "worldcup", bracket: true, matchupMs: 8000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o1" });
  h.room.leave("p1"); // voted, then left
  h.act(2, "vote", { option: "o1" });
  await h.advance(1000);
  assert.equal(h.v("matchWinner"), -1); // 닉3 is here and has not voted: wait (voters 2 ≥ roster 2 would be wrong)
  h.act(3, "vote", { option: "o0" });
  await h.advance(600);
  assert.equal(h.v("matchWinner"), 1); // 2–1 (the leaver's vote still counts in the tally)
  await h.advance(2200);
  assert.equal(h.v("bracketLabel"), "4강 · 2/2");
  h.act(2, "vote", { option: "o0" });
  await h.advance(1000);
  assert.equal(h.v("matchWinner"), -1);
  h.room.leave("p3"); // the only one missing leaves: everyone still here has voted
  await h.advance(600);
  assert.equal(h.v("matchWinner"), 0);
});

test("MP-12: a player whose connection flapped during the result is unmarked on rejoin, with no new score", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 3000 });
  await h.advance(3000);
  h.act(2, "tap");
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "result");
  h.room.leave("p2");
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉2 (나감)", score: 1, left: true }]);
  h.room.join("p2b", { anonId: "a2", nick: "닉2" });
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉2", score: 1 }]);
  assert.deepEqual(stateTo(h, "p2b").raceBoard, [{ nick: "닉2 (나감)", score: 1, left: true }]); // the state went first …
  assert.ok(h.out.at(-1).type !== "state"); // … and the unmarked board followed it
});

test("nicknames are capped at 10 graphemes (one syllable or one emoji = one), like the player's input", () => {
  assert.equal(cleanNick("가나다라마바사아자차카타"), "가나다라마바사아자차");
  assert.equal(cleanNick("  abc  "), "abc");
  assert.equal(cleanNick("👨‍👩‍👧‍👦".repeat(12)), "👨‍👩‍👧‍👦".repeat(10)); // a ZWJ family is one grapheme (11 UTF-16 units)
  assert.equal(cleanNick("가".repeat(10) + " "), "가".repeat(10));
  const h = harness();
  h.room.join("p1", { anonId: "a1", nick: "열두글자닉네임입니다요호" });
  assert.deepEqual(h.v("roster"), ["열두글자닉네임입니다"]);
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

// ── 나 맞히기 퀴즈: quizPack, subject, device-measured answers, recap ──
const ackOf = (h, n, name) => h.out.filter((m) => m.to === `p${n}` && m.type === "actionAck" && m.d.clientMsgId === `m${n}${name}`).at(-1)?.d;
const QS = [
  { q: "내가 좋아하는 색은?", options: ["빨강", "파랑", "초록", "노랑"], answer: 1 },
  { q: "내 MBTI는?", options: ["INFP", "ENTJ"], answer: 0 },
  { q: "내 고향은?", options: ["서울", "부산", "대구"], answer: 2 },
];
// The shown index of the right answer, by its text (options are shuffled each round).
const shownAnswer = (h) => {
  const rc = h.v("roundContent");
  const src = QS.find((x) => x.q === rc.q);
  return rc.options.indexOf(src.options[src.answer]);
};
const QUIZ_START = { game: "trivia", quiz: true, rounds: 6, answerMs: 8000, revealMs: 2000 };
const pts = (ms, win = 8000) => Math.max(100, 1000 - Math.round((ms / win) * 800));

test("quizPack: sanitized (trim, caps, invalid questions dropped), quizInfo has no answers", () => {
  const h = harness();
  [1, 2].forEach(h.join);
  const long = "가".repeat(100);
  h.act(1, "quizPack", {
    title: `  ${"제".repeat(50)}  `,
    questions: [
      { q: `  ${long} `, options: [` ${"나".repeat(40)} `, "B"], answer: 0 }, // capped: q 80, option 30
      { q: "보기 하나", options: ["A"], answer: 0 }, // < 2 options
      { q: "보기 다섯", options: ["A", "B", "C", "D", "E"], answer: 0 }, // > 4
      { q: "", options: ["A", "B"], answer: 0 }, // no question
      { q: "답 범위 밖", options: ["A", "B"], answer: 2 },
      { q: "답이 숫자 아님", options: ["A", "B"], answer: "x" },
      { q: "빈 보기는 빠지고 답 번호가 따라감", options: ["A", "  ", "C"], answer: 2 },
      { q: "답이 빈 보기", options: ["A", "", "C"], answer: 1 },
      "not an object",
      null,
    ],
    settings: { rounds: 99, answerMs: 1000, extra: 1 },
  });
  assert.equal(ackOf(h, 1, "quizPack").accepted, true);
  const p = h.room._state.session.quizPack;
  assert.equal(p.title, "제".repeat(40));
  assert.equal(p.questions.length, 2);
  assert.equal(p.questions[0].q, "가".repeat(80));
  assert.deepEqual(p.questions[0].options, ["나".repeat(30), "B"]);
  assert.deepEqual(p.questions[1], { q: "빈 보기는 빠지고 답 번호가 따라감", options: ["A", "C"], answer: 1 });
  assert.deepEqual(p.settings, { rounds: 20, answerMs: 3000 }); // clamped
  assert.deepEqual(h.v("quizInfo"), { title: "제".repeat(40), count: 2, custom: true, about: "닉1", answerMs: 3000 });
  assert.ok(!JSON.stringify(h.v("quizInfo")).includes('"answer"'), "no answers in the public var");
  // more than 20 valid questions → the first 20
  h.act(2, "quizPack", { title: "많다", questions: Array.from({ length: 25 }, (_, i) => ({ q: `Q${i}`, options: ["a", "b"], answer: 1 })) });
  assert.equal(h.room._state.session.quizPack.questions.length, 20);
  assert.equal(h.room._state.session.quizPack.questions[19].q, "Q19");
});

test("quizPack: nothing playable is refused (the stored pack stays); a new pack replaces it", () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "첫 팩", questions: QS });
  for (const bad of [{ title: "x" }, { questions: [] }, { questions: [{ q: "q", options: ["a"], answer: 0 }] }, { questions: "nope" }, null]) {
    h.act(2, "quizPack", bad);
    assert.deepEqual(ackOf(h, 2, "quizPack"), { clientMsgId: "m2quizPack", accepted: false, reason: "invalid_pack" });
  }
  assert.equal(h.v("quizInfo").title, "첫 팩");
  assert.equal(h.v("quizInfo").about, "닉1");
  h.act(2, "quizPack", { title: "둘째 팩", questions: QS.slice(0, 1) });
  assert.deepEqual(h.v("quizInfo"), { title: "둘째 팩", count: 1, custom: true, about: "닉2", answerMs: null });
  assert.equal(h.room._state.session.quizPack.questions.length, 1);
});

test("quizPack: only in the lobby / result — refused mid-game", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "팩", questions: QS });
  h.act(1, "start", QUIZ_START);
  await h.advance(0);
  h.act(2, "quizPack", { title: "끼어들기", questions: QS });
  assert.deepEqual(ackOf(h, 2, "quizPack"), { clientMsgId: "m2quizPack", accepted: false, reason: "not_in_lobby" });
  await h.advance(3000);
  h.act(2, "quizPack", { title: "끼어들기", questions: QS });
  assert.equal(ackOf(h, 2, "quizPack").reason, "not_in_lobby");
  assert.equal(h.v("quizInfo").about, "닉1");
});

test("subject: iAmSubject goes to each player only; a rejoin keeps it", () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "팩", questions: QS });
  const flag = (peer) => h.out.filter((m) => m.to === peer && m.type === "setVar" && m.d.id === "iAmSubject").at(-1)?.d.value;
  assert.equal(flag("p1"), true);
  assert.equal(flag("p2"), false);
  assert.equal(h.out.some((m) => m.to === "*" && m.d?.id === "iAmSubject"), false, "never broadcast");
  h.join(3);
  assert.equal(flag("p3"), false);
  h.room.leave("p1");
  h.room.join("p1b", { anonId: "a1", nick: "닉1" });
  assert.equal(stateTo(h, "p1b").iAmSubject, true);
  assert.equal(flag("p1b"), true);
});

test("start rule: the subject alone cannot start (need_answerer); one friend is enough (1:1)", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "quizPack", { title: "팩", questions: QS });
  h.act(1, "start", QUIZ_START);
  await h.advance(0);
  assert.deepEqual(ackOf(h, 1, "start"), { clientMsgId: "m1start", accepted: false, reason: "need_answerer" });
  assert.notEqual(h.v("sessionPhase"), "countdown");
  h.join(2);
  h.act(1, "start", QUIZ_START);
  await h.advance(0);
  assert.equal(ackOf(h, 1, "start").accepted, true);
  assert.equal(h.v("sessionPhase"), "countdown");
});

test("no pack (opened cold): the default trivia pack plays solo, no subject", async () => {
  const h = harness({ pack: QS });
  h.join(1);
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  assert.equal(h.v("sessionPhase"), "play");
  assert.deepEqual(h.v("quizInfo"), { title: "상식", count: 3, custom: false, about: null, answerMs: 8000 });
  h.act(1, "answer", { option: shownAnswer(h), ms: 800 });
  await h.advance(8000);
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: pts(800) }]);
});

test("custom pack: creator's question order, its settings win, options shuffled with the answer remapped", async () => {
  const h = harness(); // random 0.5: [a, b, c, d] → [a, d, b, c]; [a, b] stays
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS, settings: { rounds: 2, answerMs: 5000 } });
  h.act(2, "start", { ...QUIZ_START, rounds: 6, answerMs: 9000 });
  await h.advance(3000);
  assert.equal(h.v("roundTotal"), 2);
  assert.equal(h.room._state.session.answerMs, 5000);
  assert.equal(h.v("quizInfo").answerMs, 5000);
  assert.deepEqual(h.v("roundContent"), { q: QS[0].q, options: ["빨강", "노랑", "파랑", "초록"] });
  assert.equal(h.room._state.session.rounds[0].answer, 2); // 파랑 moved from 1 to 2
  await h.advance(5000);
  assert.equal(h.v("roundAnswer"), 2);
  await h.advance(2000);
  assert.deepEqual(h.v("roundContent"), { q: QS[1].q, options: ["INFP", "ENTJ"] });
  assert.equal(h.room._state.session.rounds[1].answer, 0);
});

test("answers: scored by the DEVICE's ms; forged / missing ms never beat the host's own measurement", async () => {
  const h = harness();
  [1, 2, 3, 4, 5, 6, 7, 8].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 4000); // 4 s into the 8 s window, as the host sees it
  const a = shownAnswer(h);
  h.act(2, "answer", { option: a, ms: 1000 }); // honest: tapped after 1 s, a slow network delivered it at 4 s
  h.act(3, "answer", { option: a, ms: -500 }); // negative → host's 4000
  h.act(4, "answer", { option: a, ms: "abc" }); // NaN → 4000
  h.act(5, "answer", { option: a, ms: 4500 }); // more than the host has seen (4000) → 4050
  h.act(6, "answer", { option: a, ms: 99999 }); // past the window → 4000
  h.act(7, "answer", { option: a }); // legacy client without ms → 4000
  h.act(8, "answer", { option: a, ms: 2000.4 }); // fractional → rounded
  h.act(1, "answer", { option: a, ms: 0 }); // the subject watches: ignored
  await h.advance(4000);
  const score = Object.fromEntries(h.v("raceBoard").map((x) => [x.nick, x.score]));
  assert.deepEqual(score, { 닉2: pts(1000), 닉3: pts(4000), 닉4: pts(4000), 닉5: pts(4050), 닉6: pts(4000), 닉7: pts(4000), 닉8: pts(2000) });
  assert.equal("닉1" in score, false, "the subject is not on the board");
  const picks = h.room._state.session.picks[0];
  assert.deepEqual(picks.a8, { option: a, ms: 2000, correct: true, points: pts(2000) });
  assert.equal(picks.a1, undefined);
});

test("answers: one per player per round; an invalid option is not an answer; the board waits for the reveal", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  const a = shownAnswer(h);
  h.act(2, "answer", { option: 9, ms: 100 }); // not a choice → ignored, can still answer
  h.act(2, "answer", { option: (a + 1) % 4, ms: 500 }); // wrong
  h.act(2, "answer", { option: a, ms: 600 }); // second answer ignored
  h.act(3, "answer", { option: a, ms: 900 });
  assert.deepEqual(h.v("quizProgress"), { answered: 2, of: 2 });
  assert.ok(!h.out.some((m) => m.d?.id === "raceBoard" && m.d.value.some((x) => x.score > 0)), "no score shown before the reveal");
  await h.advance(7000);
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉3", score: pts(900) }, { nick: "닉2", score: 0 }]);
});

test("ties stay ties: the same device time scores the same", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 3000);
  const a = shownAnswer(h);
  h.act(2, "answer", { option: a, ms: 1500 });
  await h.advance(1000); // arrives a second later — still the same device time
  h.act(3, "answer", { option: a, ms: 1500 });
  await h.advance(4000);
  const [x, y] = h.v("raceBoard");
  assert.equal(x.score, pts(1500));
  assert.equal(x.score, y.score);
});

test("quizRecap: {subject, rounds}: options as shown, every answerer's pick (no answer = -1), the subject left out", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  const a0 = shownAnswer(h);
  h.act(2, "answer", { option: a0, ms: 1000 });
  h.act(3, "answer", { option: (a0 + 1) % 4, ms: 900 });
  await h.advance(7000 + 2000 + 1000);
  const a1 = shownAnswer(h);
  h.act(2, "answer", { option: a1, ms: 400 }); // 닉3 does not answer round 2
  await h.advance(7000 + 2000);
  assert.equal(h.v("sessionPhase"), "result");
  const recap = h.v("quizRecap");
  const rounds = h.room._state.session.rounds;
  assert.equal(recap.subject, "닉1");
  assert.equal(recap.rounds.length, 2);
  assert.deepEqual(recap.rounds.map((r) => [r.q, r.options, r.answer]), rounds.map((r) => [r.q, r.options, r.answer]));
  assert.deepEqual(recap.rounds[0].picks, [
    { nick: "닉2", option: a0, ms: 1000, correct: true, points: pts(1000) },
    { nick: "닉3", option: (a0 + 1) % 4, ms: 900, correct: false, points: 0 },
  ]);
  assert.deepEqual(recap.rounds[1].picks, [
    { nick: "닉2", option: a1, ms: 400, correct: true, points: pts(400) },
    { nick: "닉3", option: -1, ms: -1, correct: false, points: 0 },
  ]);
  assert.ok(recap.rounds.every((r) => r.picks.every((p) => p.nick !== "닉1")), "the subject has no picks");
  // the recap is set before the result phase, so the result screen has it on entry
  const iRecap = h.out.findLastIndex((m) => m.d?.id === "quizRecap");
  const iResult = h.out.findLastIndex((m) => m.d?.id === "sessionPhase" && m.d.value === "result");
  assert.ok(iRecap >= 0 && iRecap < iResult);
});

test("나도 만들기: a pack sent from the result makes a new subject; scores and recap reset at the next start", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "닉1 퀴즈", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.act(2, "answer", { option: shownAnswer(h), ms: 1000 });
  await h.advance(7000 + 2000);
  assert.equal(h.v("sessionPhase"), "result");
  assert.equal(h.v("raceBoard")[0].nick, "닉2");
  h.act(2, "quizPack", { title: "이번엔 나", questions: QS.slice(1, 3) }); // from the result screen
  assert.equal(ackOf(h, 2, "quizPack").accepted, true);
  assert.deepEqual(h.v("quizInfo"), { title: "이번엔 나", count: 2, custom: true, about: "닉2", answerMs: null });
  assert.equal(h.v("raceBoard")[0].nick, "닉2", "the old result stays until the next start");
  h.act(1, "start", QUIZ_START);
  await h.advance(0);
  assert.deepEqual(h.v("quizRecap"), { subject: null, rounds: [] });
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉1", score: 0 }]); // 닉2 is the subject now
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 100 }); // the new subject: ignored
  h.act(1, "answer", { option: shownAnswer(h), ms: 500 });
  await h.advance(8000);
  assert.equal(h.v("raceBoard")[0].score, pts(500));
  await h.advance(20000);
  assert.equal(h.v("quizRecap").subject, "닉2");
  assert.equal(h.v("raceBoard").length, 1);
});

test("hand-over mid-quiz: pack, subject, picks and scores carry over; the next host finishes the same", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  a.act(1, "start", QUIZ_START);
  await a.advance(3000 + 1000);
  const a0 = shownAnswer(a);
  a.act(2, "answer", { option: a0, ms: 700 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot())); // over the wire
  a.room.destroy();

  const b = harness({ random: () => 0.1 }); // a different device (its own random)
  await b.advance(55555);
  assert.equal(b.room.restore(snap, 300), true);
  [1, 2, 3].forEach(b.join);
  assert.equal(stateTo(b, "p1").iAmSubject, true);
  assert.equal(stateTo(b, "p2").iAmSubject, false);
  b.act(2, "answer", { option: a0, ms: 50 }); // already answered → ignored
  b.act(1, "answer", { option: a0, ms: 50 }); // the subject → ignored
  b.act(3, "answer", { option: a0, ms: 1200 });
  await b.advance(8000 - 1000 - 300 + 2000 + 1000);
  assert.equal(b.v("roundNum"), 2);
  b.act(3, "answer", { option: shownAnswer(b), ms: 300 });
  await b.advance(20000);
  assert.equal(b.v("sessionPhase"), "result");
  const recap = b.v("quizRecap");
  assert.equal(recap.subject, "닉1");
  assert.deepEqual(recap.rounds[0].picks.map((p) => [p.nick, p.ms, p.correct]), [["닉2", 700, true], ["닉3", 1200, true]]);
  assert.deepEqual(recap.rounds[1].options, snap.session.rounds[1].options, "round 2 options were fixed before the hand-over");
  assert.deepEqual(b.v("raceBoard"), [{ nick: "닉3", score: pts(1200) + pts(300) }, { nick: "닉2", score: pts(700) }]);
  assert.equal(b.room._state.session.quizPack.subject.anonId, "a1");
});

test("hand-over in the lobby: the stored pack (and its subject) is used by the next host's start", async () => {
  const a = harness();
  [1, 2].forEach(a.join);
  a.act(2, "quizPack", { title: "닉2 퀴즈", questions: QS, settings: { rounds: 1 } });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  a.room.destroy();
  const b = harness();
  b.room.restore(snap, 0);
  [1, 2].forEach(b.join);
  assert.equal(stateTo(b, "p1").quizInfo.about, "닉2");
  assert.equal(stateTo(b, "p2").iAmSubject, true);
  b.act(1, "start", QUIZ_START);
  await b.advance(3000);
  assert.equal(b.v("roundContent").q, QS[0].q);
  assert.equal(b.v("roundTotal"), 1);
  assert.equal(b.v("quizInfo").custom, true);
});

test("2 players (1:1): subject + one friend play a whole quiz to the result", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나를 맞혀봐", questions: QS });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(h.v("quizProgress"), { answered: 0, of: 1 });
    await h.advance(500);
    h.act(2, "answer", { option: shownAnswer(h), ms: 500 });
    assert.deepEqual(h.v("quizProgress"), { answered: 1, of: 1 });
    await h.advance(7500 + 2000);
  }
  assert.equal(h.v("sessionPhase"), "result");
  assert.deepEqual(h.v("raceBoard"), [{ nick: "닉2", score: 3 * pts(500) }]);
  assert.equal(h.v("quizRecap").rounds.length, 3);
});

test("telemetry state: S.acted = who took part (a late joiner who never acts is not in it); survives a hand-over", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  a.act(3, "start", QUIZ_START); // pressing start is not taking part
  await a.advance(3000 + 500);
  a.act(2, "answer", { option: 0, ms: 300 });
  a.join(4); // late joiner, never acts
  const S = a.room._state.session;
  assert.deepEqual([...S.acted].sort(), ["a1", "a2"]); // the subject takes part by being guessed
  assert.deepEqual([...S.answerers], ["a2"]);
  assert.equal(S.subject, "a1");
  assert.ok(S.sid.length >= 16);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  assert.deepEqual([...snap.session.acted].sort(), ["a1", "a2"]);
  const b = harness();
  b.room.restore(snap, 0);
  [1, 2, 3, 4].forEach(b.join);
  b.act(3, "answer", { option: 0, ms: 300 });
  await b.advance(20000);
  const T = b.room._state.session;
  assert.deepEqual([...T.acted].sort(), ["a1", "a2", "a3"]);
  assert.equal(T.done, 1);
  assert.equal(T.sid, S.sid);
  b.act(1, "lobby");
  b.act(1, "start", QUIZ_START);
  await b.advance(0);
  assert.deepEqual([...b.room._state.session.acted], ["a1"], "reset on each start");
});
