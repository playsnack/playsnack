import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRoom, cleanNick, sanitizeQuizPack, EARLY_REVEAL_MS } from "../src/room.js";
// raceBoard rows carry a per-room `pid`; compare names and scores
const rows = (b) => (b || []).map(({ pid, ...x }) => x);

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
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 2 }, { nick: "닉2", score: 1 }]);
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
  [1, 2, 3].forEach(a.join); // p3 never answers: the full window runs
  a.act(1, "start", { game: "trivia", quiz: true, rounds: 2, answerMs: 8000, revealMs: 2000 });
  await a.advance(3000 + 2000); // 2s into round 1
  a.act(1, "answer", { option: 1 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot())); // over the wire
  a.room.destroy();

  // New host: its clock is unrelated; the snapshot is 500ms old by the time it lands.
  const b = harness({ pack });
  await b.advance(123456);
  assert.equal(b.room.restore(snap, 500), true);
  [1, 2, 3].forEach(b.join);
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
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 5 }]);
  h.act(1, "taps", { count: 100 }); // 100 taps in 1 s: impossible → clamped to 15·1 + 5
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 20 }]);
  h.act(2, "tap"); // legacy per-tap clients still count (+1 each)
  h.act(2, "tap");
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 20 }, { nick: "닉2", score: 2 }]);
  await h.advance(4000); // window over → result
  assert.equal(h.v("sessionPhase"), "result");
  await h.advance(2000); // two lost sends (700 ms resend) + the worst broker delay still make it
  h.act(2, "taps", { count: 7 }); // the final batch lands inside the grace: the board agrees with the card
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 20 }, { nick: "닉2", score: 7 }]);
  await h.advance(1000);
  h.act(2, "taps", { count: 9 }); // too late (grace is 2.5 s)
  assert.deepEqual(rows(h.v("raceBoard"))[1], { nick: "닉2", score: 7 });
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
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2 (나감)", score: 1, left: true }]);
  h.room.join("p2b", { anonId: "a2", nick: "닉2" });
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2", score: 1 }]);
  assert.deepEqual(rows(stateTo(h, "p2b").raceBoard), [{ nick: "닉2 (나감)", score: 1, left: true }]); // the state went first …
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
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2 (나감)", score: 2, left: true }, { nick: "닉1", score: 1 }]);
  h.join(4); // a late joiner sees the same
  assert.deepEqual(stateTo(h, "p4").raceBoard, h.v("raceBoard"));
  h.room.join("p2b", { anonId: "a2", nick: "닉2" }); // back → unmarked again on the next change
  h.act(3, "tap");
  assert.deepEqual(rows(h.v("raceBoard"))[0], { nick: "닉2", score: 2 });
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
// quizProgress counts (its round / sessionNo are checked on their own)
const prog = (h) => {
  const { answered, of } = h.v("quizProgress");
  return { answered, of };
};
const pts = (ms, win = 8000) =>Math.max(100, 1000 - Math.round((ms / win) * 800));
const info = (h) => {
  const { packId, ...rest } = h.v("quizInfo");
  return rest;
};

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
  assert.deepEqual(info(h), { title: "제".repeat(40), count: 2, custom: true, about: "닉1", answerMs: 3000, subjectHere: true });
  assert.match(h.v("quizInfo").packId, /^[a-z0-9]{32}$/); // a random id per accepted pack
  assert.ok(!JSON.stringify(h.v("quizInfo")).includes('"answer"'), "no answers in the public var");
  // more than 20 valid questions → the first 20
  h.act(1, "quizPack", { title: "많다", questions: Array.from({ length: 25 }, (_, i) => ({ q: `Q${i}`, options: ["a", "b"], answer: 1 })) });
  assert.equal(h.room._state.session.quizPack.questions.length, 20);
  assert.equal(h.room._state.session.quizPack.questions[19].q, "Q19");
});

test("quizPack: nothing playable is refused (the stored pack stays); the subject's update replaces it", () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "첫 팩", questions: QS });
  for (const bad of [{ title: "x" }, { questions: [] }, { questions: [{ q: "q", options: ["a"], answer: 0 }] }, { questions: "nope" }, null]) {
    h.act(1, "quizPack", bad);
    assert.deepEqual(ackOf(h, 1, "quizPack"), { clientMsgId: "m1quizPack", accepted: false, reason: "invalid_pack" });
  }
  assert.equal(h.v("quizInfo").title, "첫 팩");
  assert.equal(h.v("quizInfo").about, "닉1");
  h.act(1, "quizPack", { title: "고친 팩", questions: QS.slice(0, 1), about: "  내 이름은 아주아주 긴 별명입니다  " });
  assert.deepEqual(info(h), { title: "고친 팩", count: 1, custom: true, about: "내 이름은 아주아주", answerMs: null, subjectHere: true }); // `about`: a nickname, ≤10 graphemes
  assert.equal(h.room._state.session.quizPack.questions.length, 1);
});

test("quizPack in the lobby: only the subject may replace it (not_subject) — unless the subject left (30 s grace)", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "닉1 팩", questions: QS });
  h.act(2, "quizPack", { title: "가로채기", questions: QS });
  assert.deepEqual(ackOf(h, 2, "quizPack"), { clientMsgId: "m2quizPack", accepted: false, reason: "not_subject" });
  assert.equal(h.v("quizInfo").about, "닉1");
  assert.equal(h.room._state.session.subject, "a1");
  h.room.leave("p1"); // the subject switched apps…
  h.act(2, "quizPack", { title: "닉2 팩", questions: QS });
  assert.equal(ackOf(h, 2, "quizPack").reason, "not_subject", "…a few seconds away is not 'left'");
  await h.advance(30000); // gone for good: the room is not stuck with their quiz
  h.act(2, "quizPack", { title: "닉2 팩", questions: QS });
  assert.equal(ackOf(h, 2, "quizPack").accepted, true);
  assert.equal(h.v("quizInfo").about, "닉2");
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
  assert.deepEqual(h.v("quizInfo"), { title: "상식", count: 3, custom: false, about: null, answerMs: 8000, packId: null, subjectHere: true });
  h.act(1, "answer", { option: shownAnswer(h), ms: 800 });
  await h.advance(8000);
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: pts(800) }]);
});

test("custom pack: creator's question order, its settings win, options shuffled with the answer remapped", async () => {
  const h = harness(); // random 0.5: [a, b, c, d] → [a, d, b, c]; [a, b] stays
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS, settings: { rounds: 2, answerMs: 5000 } });
  h.act(1, "start", { ...QUIZ_START, rounds: 6, answerMs: 9000 });
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
  assert.deepEqual(prog(h), { answered: 2, of: 2 });
  assert.ok(!h.out.some((m) => m.d?.id === "raceBoard" && m.d.value.some((x) => x.score > 0)), "no score shown before the reveal");
  await h.advance(7000);
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉3", score: pts(900) }, { nick: "닉2", score: 0 }]);
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
  assert.deepEqual([recap.title, recap.about, recap.packId], ["나", "닉1", h.v("quizInfo").packId]);
  assert.equal(recap.rounds.length, 2);
  assert.deepEqual(recap.rounds.map((r) => [r.q, r.options, r.answer]), rounds.map((r) => [r.q, r.options, r.answer]));
  assert.deepEqual(recap.rounds[0].picks, [
    { nick: "닉2", pid: "p2", option: a0, ms: 1000, correct: true, points: pts(1000) },
    { nick: "닉3", pid: "p3", option: (a0 + 1) % 4, ms: 900, correct: false, points: 0 },
  ]);
  assert.deepEqual(recap.rounds[1].picks, [
    { nick: "닉2", pid: "p2", option: a1, ms: 400, correct: true, points: pts(400) },
    { nick: "닉3", pid: "p3", option: -1, ms: -1, correct: false, points: 0 },
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
  assert.deepEqual(info(h), { title: "이번엔 나", count: 2, custom: true, about: "닉2", answerMs: null, subjectHere: true });
  assert.notEqual(h.v("quizInfo").packId, h.v("quizRecap").packId, "the result screen can tell a new quiz is waiting");
  assert.equal(h.v("raceBoard")[0].nick, "닉2", "the old result stays until the next start");
  h.act(1, "start", QUIZ_START); // the old subject: not their quiz any more
  await h.advance(0);
  assert.deepEqual(ackOf(h, 1, "start"), { clientMsgId: "m1start", accepted: false, reason: "not_subject" });
  assert.equal(h.v("sessionPhase"), "result");
  h.act(2, "start", QUIZ_START); // the new subject starts from the result
  await h.advance(0);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.deepEqual(h.v("quizRecap"), { subject: null, about: null, title: "", packId: null, rounds: [] });
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉1", score: 0 }]); // 닉2 is the subject now
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 100 }); // the new subject: ignored
  h.act(1, "answer", { option: shownAnswer(h), ms: 500 });
  await h.advance(8000);
  assert.equal(h.v("raceBoard")[0].score, pts(500));
  await h.advance(20000);
  assert.equal(h.v("quizRecap").subject, "닉2");
  assert.equal(h.v("quizRecap").title, "이번엔 나");
  assert.equal(h.v("quizRecap").packId, h.v("quizInfo").packId);
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
  assert.deepEqual(rows(b.v("raceBoard")), [{ nick: "닉3", score: pts(1200) + pts(300) }, { nick: "닉2", score: pts(700) }]);
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
  b.act(2, "start", QUIZ_START);
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
    assert.deepEqual(prog(h), { answered: 0, of: 1 });
    await h.advance(500);
    h.act(2, "answer", { option: shownAnswer(h), ms: 500 });
    assert.deepEqual(prog(h), { answered: 1, of: 1 });
    await h.advance(7500 + 2000);
  }
  assert.equal(h.v("sessionPhase"), "result");
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2", score: 3 * pts(500) }]);
  assert.equal(h.v("quizRecap").rounds.length, 3);
});

test("telemetry state: S.acted = who took part (a late joiner who never acts is not in it); survives a hand-over", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  a.act(1, "start", QUIZ_START);
  await a.advance(3000 + 500);
  a.act(2, "answer", { option: 0, ms: 300 });
  a.join(4); // late joiner, never acts
  const S = a.room._state.session;
  assert.deepEqual([...S.acted].sort(), ["a1", "a2"]); // the subject takes part by being guessed; 3 and 4 did nothing
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

test("start in the result: a cold quiz restarts from anyone; a custom one only from its subject (anyone once they left)", async () => {
  const h = harness({ pack: QS });
  [1, 2].forEach(h.join);
  h.act(2, "start", QUIZ_START); // cold: anyone
  await h.advance(3000 + 3 * (8000 + 2000));
  assert.equal(h.v("sessionPhase"), "result");
  h.act(1, "start", QUIZ_START); // cold again, from the result, by someone else
  await h.advance(0);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.v("sessionNo"), 2);
  await h.advance(3000 + 3 * (8000 + 2000));
  h.act(1, "quizPack", { title: "닉1", questions: QS.slice(0, 1) }); // 나도 만들기 from the result
  h.act(2, "start", QUIZ_START);
  assert.equal(ackOf(h, 2, "start").reason, "not_subject");
  h.room.leave("p1"); // the subject is gone: the room is not stuck
  await h.advance(30000);
  h.join(3);
  h.act(2, "start", QUIZ_START);
  await h.advance(0);
  assert.equal(ackOf(h, 2, "start").accepted, true);
  assert.equal(h.v("sessionNo"), 3);
});

test("pid: a per-room key on every board row and recap pick — two players with one nick stay two; survives a hand-over", async () => {
  const a = harness();
  a.room.join("p1", { anonId: "a1", nick: "민지" });
  a.room.join("p2", { anonId: "a2", nick: "철수" });
  a.room.join("p3", { anonId: "a3", nick: "철수" }); // same nickname
  a.act(1, "quizPack", { title: "민지", questions: QS.slice(0, 1) });
  const myPid = (h, peer) => h.out.filter((m) => m.to === peer && m.d?.id === "myPid").at(-1)?.d.value;
  assert.deepEqual(["p1", "p2", "p3"].map((p) => myPid(a, p)), ["p1", "p2", "p3"]);
  a.act(1, "start", QUIZ_START);
  await a.advance(3000 + 1000);
  a.act(2, "answer", { option: shownAnswer(a), ms: 500 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  assert.ok(!JSON.stringify(snap.pids).includes("p0"));
  const b = harness();
  b.room.restore(snap, 0);
  b.room.join("q3", { anonId: "a3", nick: "철수" }); // re-joins the new host in another order
  b.room.join("q1", { anonId: "a1", nick: "민지" });
  b.room.join("q2", { anonId: "a2", nick: "철수" });
  assert.equal(stateTo(b, "q3").myPid ?? myPid(b, "q3"), "p3");
  await b.advance(20000);
  assert.deepEqual(b.v("raceBoard"), [{ nick: "철수", score: pts(500), pid: "p2" }, { nick: "철수", score: 0, pid: "p3" }]);
  assert.deepEqual(b.v("quizRecap").rounds[0].picks.map((p) => p.pid), ["p2", "p3"]);
  assert.ok(!JSON.stringify(b.v("raceBoard")).includes("a2"), "never the anonId");
  assert.equal(stateTo(b, "q1").sessionNo, 1);
  assert.equal(b.room.snapshot().session.round, 1, "sessionNo rides in the snapshot (session.round)");
});

// ── review fixes (lane A engine review) ──
const lastQuizInfo = (h) => h.v("quizInfo");

test("R1: the subject leaves the lobby → after the 30 s grace anyone may start; back in time keeps it theirs", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS });
  assert.equal(lastQuizInfo(h).subjectHere, true);
  h.room.leave("p1"); // the subject goes to KakaoTalk to share the invite
  await h.advance(10000);
  h.act(2, "start", QUIZ_START);
  assert.equal(ackOf(h, 2, "start").reason, "not_subject", "10 s away is not gone");
  assert.equal(lastQuizInfo(h).subjectHere, true);
  h.room.join("p1", { anonId: "a1", nick: "닉1" }); // back in time
  await h.advance(30000);
  assert.equal(lastQuizInfo(h).subjectHere, true);
  h.room.leave("p1"); // gone for good
  await h.advance(29999);
  assert.equal(lastQuizInfo(h).subjectHere, true);
  await h.advance(1);
  assert.equal(lastQuizInfo(h).subjectHere, false, "published when the grace runs out");
  h.act(2, "start", QUIZ_START);
  await h.advance(0);
  assert.equal(ackOf(h, 2, "start").accepted, true);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.v("quizInfo").about, "닉1", "still the subject's quiz");
});

test("R2: an aborted game closes the answer window — a lobby / countdown answer never scores or lands in the next game", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  const right = shownAnswer(h);
  h.act(2, "lobby"); // a friend cannot end the subject's game
  assert.equal(ackOf(h, 2, "lobby").reason, "not_subject");
  assert.equal(h.v("sessionPhase"), "play");
  h.act(1, "lobby"); // the subject ends it mid-round
  assert.equal(h.v("sessionPhase"), "lobby");
  h.act(2, "answer", { option: right, ms: 100 }); // in the lobby
  assert.equal(h.room._state.scores.get("a2") ?? 0, 0);
  h.act(1, "start", QUIZ_START);
  await h.advance(1000);
  h.act(2, "answer", { option: 0, ms: 100 }); // during the countdown
  assert.equal(h.room._state.session.answered?.has("a2") ?? false, false);
  await h.advance(2000 + 1000);
  h.act(2, "answer", { option: shownAnswer(h), ms: 800 });
  await h.advance(8000);
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2", score: pts(800) }], "one answer, scored once (not 1984)");
});

test("R3: a late resend for an earlier round / game is refused (stale_round), never scored in the current one", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 8000 + 2000 + 1000); // round 2 is open
  assert.equal(h.v("roundIdx"), 1);
  const sessionNo = h.v("sessionNo");
  h.act(2, "answer", { option: shownAnswer(h), ms: 500, round: 0, sessionNo }); // the round-1 tap, delivered 11 s late
  assert.deepEqual(ackOf(h, 2, "answer"), { clientMsgId: "m2answer", accepted: false, reason: "stale_round" });
  h.act(2, "answer", { option: shownAnswer(h), ms: 500, round: 1, sessionNo: sessionNo - 1 }); // last game's
  assert.equal(ackOf(h, 2, "answer").reason, "stale_round");
  assert.equal(h.room._state.session.answered.has("a2"), false);
  h.act(2, "answer", { option: shownAnswer(h), ms: 500, round: 1, sessionNo });
  assert.equal(ackOf(h, 2, "answer").accepted, true);
  await h.advance(8000);
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2", score: pts(500) }]);
});

test("R4: a join / leave while a round is open does not reveal this round's points", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 8000 + 2000 + 1000); // round 2 open (the board is known since round 1's reveal)
  const sent = h.out.length;
  h.act(2, "answer", { option: shownAnswer(h), ms: 500 });
  h.join(4); // board goes out (MP-12 / late joiner)
  h.room.leave("p3");
  const before = h.out.slice(sent).filter((m) => m.to === "*" && m.d?.id === "raceBoard").map((m) => m.d.value);
  assert.ok(before.length >= 1, "the join / leave did publish a board");
  assert.ok(before.every((b) => b.every((x) => x.score === 0)), JSON.stringify(before.at(-1)));
  assert.ok(stateTo(h, "p4").raceBoard.every((x) => x.score === 0), "the late joiner's state too");
  await h.advance(8000);
  assert.equal(rows(h.v("raceBoard"))[0].score, pts(500), "shown at the reveal");
});

test("R5: subject grace rides in the snapshot (relative); every time-relative snapshot field is zeroed by meshClient", async () => {
  const a = harness();
  [1, 2].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS });
  a.room.leave("p1");
  await a.advance(20000);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  assert.equal(snap.session.subjectAwayAgo, 20000);
  assert.equal(snap.session.subjectAwayAt, undefined, "no absolute time crosses devices");
  const b = harness();
  await b.advance(777777);
  b.room.restore(snap, 0);
  b.join(2);
  await b.advance(9999);
  b.act(2, "start", QUIZ_START);
  assert.equal(ackOf(b, 2, "start").reason, "not_subject");
  await b.advance(1);
  assert.equal(b.v("quizInfo").subjectHere, false);
  b.act(2, "start", QUIZ_START);
  assert.notEqual(ackOf(b, 2, "start").reason, "not_subject");
  // meshClient's snapshot key ignores time passing: every field that changes with time alone is in TIME_KEYS
  const src = readFileSync(new URL("../src/meshClient.js", import.meta.url), "utf8");
  const timeKeys = new Set(JSON.parse(src.match(/TIME_KEYS = new Set\((\[[^\]]*\])\)/)[1]));
  const c = harness();
  [1, 2, 3].forEach(c.join);
  c.act(1, "quizPack", { title: "나", questions: QS });
  c.act(1, "start", QUIZ_START);
  await c.advance(3000 + 1000);
  c.room.leave("p1"); // subject away + a round open: every relative clock is running
  const s1 = c.room.snapshot();
  await c.advance(500);
  const s2 = c.room.snapshot();
  const changed = [];
  const diff = (x, y, key) => {
    if (x && typeof x === "object") return Object.keys({ ...x, ...y }).forEach((k) => diff(x[k], y?.[k], k));
    if (x !== y) changed.push(key);
  };
  diff(s1, s2, "");
  assert.ok(changed.length >= 2, `${changed}`);
  assert.deepEqual(changed.filter((k) => !timeKeys.has(k)), [], "a time-relative field missing from meshClient TIME_KEYS");
});

test("R5: 나도 만들기 race — the first new pack in a result wins until the next start (pack_waiting)", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "닉1", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 8000 + 2000);
  assert.equal(h.v("sessionPhase"), "result");
  h.act(2, "quizPack", { title: "닉2", questions: QS.slice(0, 1) });
  assert.equal(ackOf(h, 2, "quizPack").accepted, true);
  h.act(3, "quizPack", { title: "닉3", questions: QS.slice(0, 1) });
  assert.deepEqual(ackOf(h, 3, "quizPack"), { clientMsgId: "m3quizPack", accepted: false, reason: "pack_waiting" });
  h.act(1, "quizPack", { title: "닉1 again", questions: QS.slice(0, 1) });
  assert.equal(ackOf(h, 1, "quizPack").reason, "pack_waiting");
  h.act(2, "quizPack", { title: "닉2 고침", questions: QS.slice(0, 1) }); // the maker re-sending (shell retry) is fine
  assert.equal(ackOf(h, 2, "quizPack").accepted, true);
  assert.equal(h.v("quizInfo").about, "닉2");
  h.act(2, "start", QUIZ_START);
  await h.advance(3000 + 8000 + 2000);
  h.act(3, "quizPack", { title: "닉3", questions: QS.slice(0, 1) }); // the next result: open again
  assert.equal(ackOf(h, 3, "quizPack").accepted, true);
});

test("R5: a waiting 나도 만들기 pack whose maker left for good stops blocking the result", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "닉1", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 8000 + 2000);
  h.act(2, "quizPack", { title: "닉2", questions: QS.slice(0, 1) });
  h.room.leave("p2"); // the maker leaves before starting it
  h.act(3, "quizPack", { title: "닉3", questions: QS.slice(0, 1) });
  assert.equal(ackOf(h, 3, "quizPack").reason, "pack_waiting", "within the grace it still waits");
  await h.advance(30000);
  assert.equal(h.v("quizInfo").subjectHere, false);
  h.act(3, "quizPack", { title: "닉3", questions: QS.slice(0, 1) });
  assert.equal(ackOf(h, 3, "quizPack").accepted, true);
  assert.equal(h.v("quizInfo").about, "닉3");
});

test("R6: size bombs — a mark flood is dropped, text is capped in UTF-16 too; 20 questions × 20 players snapshot < 64 KB", async () => {
  const zalgo = "Z" + "́".repeat(5000);
  const h0 = harness();
  h0.join(1);
  h0.act(1, "quizPack", { title: zalgo, questions: [{ q: zalgo, options: ["a", "b"], answer: 0 }, { q: "ok", options: [zalgo, "b", "c"], answer: 1 }] });
  assert.equal(ackOf(h0, 1, "quizPack").accepted, true);
  const p0 = h0.room._state.session.quizPack;
  assert.equal(p0.title, "");
  assert.deepEqual(p0.questions, [{ q: "ok", options: ["b", "c"], answer: 0 }], "the flooded question / option is dropped");
  const accents = "é".repeat(200); // 1 mark per letter: legit, but 2 units per grapheme
  assert.ok(sanitizeQuizPack({ questions: [{ q: accents, options: ["a", "b"], answer: 0 }] }).questions[0].q.length <= 4 * 80);
  const family = "👨‍👩‍👧‍👦".repeat(40); // 11 UTF-16 units per grapheme
  const fq = sanitizeQuizPack({ questions: [{ q: family, options: ["a", "b"], answer: 0 }] }).questions[0].q;
  assert.ok(fq.length <= 320 && fq.length > 0 && fq.length % 11 === 0, `${fq.length} — whole graphemes only`);

  // the largest legit room: 20 questions at the caps, 20 players with real (uuid) ids, at the result
  const h = harness();
  const uuid = (i) => `c0ffee00-0000-4000-8000-${String(i).padStart(12, "0")}`;
  for (let i = 1; i <= 21; i++) h.room.join(`p${i}`, { anonId: uuid(i), nick: "가".repeat(10) });
  const cap = (n, ch) => ch.repeat(n);
  const big = Array.from({ length: 20 }, (_, i) => ({ q: cap(79, "문") + i, options: [cap(30, "가"), cap(30, "나"), cap(30, "다"), cap(30, "라")], answer: i % 4 }));
  h.room.action("p1", { name: "quizPack", payload: { title: cap(40, "제"), about: cap(10, "주"), questions: big }, clientMsgId: "big" });
  h.room.action("p1", { name: "start", payload: QUIZ_START, clientMsgId: "go" });
  await h.advance(3000);
  for (let r = 0; r < 20; r++) {
    await h.advance(500);
    for (let i = 2; i <= 21; i++) h.room.action(`p${i}`, { name: "answer", payload: { option: i % 4, ms: 400 }, clientMsgId: `a${r}-${i}` });
    await h.advance(7500 + 2000);
  }
  assert.equal(h.v("sessionPhase"), "result");
  assert.equal(h.v("quizRecap").rounds.length, 20);
  const size = JSON.stringify(h.room.snapshot()).length;
  assert.ok(size < 64 * 1024, `snapshot ${size} chars`);
  const snap = JSON.parse(JSON.stringify(h.room.snapshot()));
  assert.equal(snap.vars.some(([id]) => id === "quizRecap"), false, "quizRecap is not stored twice");
  const b = harness();
  b.room.restore(snap, 0);
  b.room.join("q2", { anonId: uuid(2), nick: "가".repeat(10) });
  assert.deepEqual(stateTo(b, "q2").quizRecap, h.v("quizRecap"), "rebuilt on restore");
});

test("R7: in a room with a pack, a crafted start ({} / a number) is refused for everyone but the subject", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS });
  for (const crafted of [{}, 5000, { mode: "reaction" }]) {
    h.act(2, "start", crafted);
    await h.advance(0);
    assert.equal(ackOf(h, 2, "start").reason, "not_subject", JSON.stringify(crafted));
    assert.equal(h.v("sessionPhase") ?? "lobby", "lobby");
  }
});

test("R8: S.acted counts only accepted actions inside the play window", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(1000);
  h.act(3, "answer", { option: 0, ms: 100 }); // countdown: not accepted
  h.act(3, "vote", {}); // not a vote (no option)
  await h.advance(2000 + 500);
  h.act(2, "answer", { option: 0, ms: 100 }); // accepted
  h.act(1, "answer", { option: 0, ms: 100 }); // the subject's answer is ignored (the subject is in by start)
  assert.deepEqual([...h.room._state.session.acted].sort(), ["a1", "a2"]);
});

test("R9: board ties are listed by nickname, then join order — the same on every host", async () => {
  const h = harness();
  h.room.join("p1", { anonId: "x", nick: "나" });
  h.room.join("p2", { anonId: "y", nick: "가" });
  h.room.join("p3", { anonId: "z", nick: "가" });
  h.act(1, "start", { duration: 5000 });
  await h.advance(3000 + 1000);
  for (const n of [1, 3, 2]) h.act(n, "tap"); // 1 tap each, in an order unlike the listing
  assert.deepEqual(h.v("raceBoard").map((x) => [x.nick, x.pid]), [["가", "p2"], ["가", "p3"], ["나", "p1"]]);
  h.room.leave("p3");
  assert.deepEqual(h.v("raceBoard").map((x) => [x.nick, x.pid]), [["가", "p2"], ["가 (나감)", "p3"], ["나", "p1"]]);
});

test("R11: quizProgress counts present answerers only — a leaver's answer does not inflate it", async () => {
  const h = harness();
  [1, 2, 3, 4].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 100 });
  assert.deepEqual(prog(h), { answered: 1, of: 3 });
  h.room.leave("p2");
  assert.deepEqual(prog(h), { answered: 0, of: 2 });
  h.act(3, "answer", { option: 0, ms: 100 });
  assert.deepEqual(prog(h), { answered: 1, of: 2 });
});

// ── Early reveal: everyone present has answered → reveal in EARLY_REVEAL_MS ──
const revealed = (h) => h.v("roundAnswer") >= 0;

test("early reveal: every present answerer answered (the subject never does) → reveal 300 ms later, then revealMs, then the next round", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  const a = shownAnswer(h);
  h.act(2, "answer", { option: a, ms: 900 });
  await h.advance(500);
  h.act(3, "answer", { option: a, ms: 1400 }); // the last one (the subject p1 only watches)
  await h.advance(EARLY_REVEAL_MS - 1);
  assert.equal(revealed(h), false, "a beat before the reveal");
  await h.advance(1);
  assert.equal(h.v("roundAnswer"), a, "revealed 300 ms after the last answer — not at 8 s");
  assert.deepEqual(rows(h.v("raceBoard")), [{ nick: "닉2", score: pts(900) }, { nick: "닉3", score: pts(1400) }], "device-measured scoring unchanged");
  await h.advance(1999);
  assert.equal(h.v("roundNum"), 1);
  await h.advance(1);
  assert.equal(h.v("roundNum"), 2, "the next round after the normal reveal duration");
  assert.equal(revealed(h), false);
  assert.deepEqual(h.v("quizProgress"), { answered: 0, of: 2, round: 1, sessionNo: 1 }, "the count says which round / game it is for");
  // a late resend of round 1's answer is still refused in round 2
  h.room.action("p2", { name: "answer", payload: { option: 0, ms: 100, round: 0, sessionNo: 1 }, clientMsgId: "late" });
  assert.equal(h.out.filter((m) => m.type === "actionAck" && m.d.clientMsgId === "late").at(-1).d.reason, "stale_round");
});

test("early reveal: one answerer missing → the full window", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.act(2, "answer", { option: shownAnswer(h), ms: 900 });
  h.act(1, "answer", { option: shownAnswer(h), ms: 900 }); // the subject: ignored, does not count
  assert.deepEqual(prog(h), { answered: 1, of: 2 });
  await h.advance(8000 - 1000 - 1);
  assert.equal(revealed(h), false);
  await h.advance(1);
  assert.equal(revealed(h), true, "revealed at the end of the 8 s window");
});

test("early reveal: the last one still to answer leaves mid-round → reveal 300 ms after the leave", async () => {
  const h = harness();
  [1, 2, 3, 4].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.act(2, "answer", { option: 0, ms: 900 });
  h.act(3, "answer", { option: 0, ms: 900 });
  await h.advance(1000);
  assert.equal(revealed(h), false);
  h.room.leave("p4");
  assert.deepEqual(prog(h), { answered: 2, of: 2 });
  await h.advance(EARLY_REVEAL_MS - 1);
  assert.equal(revealed(h), false);
  await h.advance(1);
  assert.equal(revealed(h), true);
});

test("early reveal: an answerer who already answered leaving does not reveal while others are missing", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.act(2, "answer", { option: 0, ms: 900 });
  h.room.leave("p2");
  assert.deepEqual(prog(h), { answered: 0, of: 1 });
  await h.advance(5000);
  assert.equal(revealed(h), false);
  await h.advance(2000);
  assert.equal(revealed(h), true, "full window");
});

test("early reveal: a player coming back during the beat reopens the round to the window's own end (a newcomer only watches)", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.room.leave("p3"); // drops out before answering (e.g. app switch)
  h.act(2, "answer", { option: 0, ms: 900 });
  await h.advance(150);
  h.join(4); // a newcomer mid-game is a spectator: the beat stays
  assert.deepEqual(prog(h), { answered: 1, of: 1 });
  h.join(3); // mid-beat: a player of this game is back on the roster
  assert.deepEqual(prog(h), { answered: 1, of: 2 });
  await h.advance(8000 - 1150 - 1);
  assert.equal(revealed(h), false, "not revealed early — p3 may still answer");
  h.act(3, "answer", { option: 0, ms: 100 }); // 1 ms before the end: nothing to pull in
  await h.advance(1);
  assert.equal(revealed(h), true);
  // a reload of someone who already answered does not reopen it
  const g = harness();
  [1, 2].forEach(g.join);
  g.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  g.act(1, "start", QUIZ_START);
  await g.advance(3000 + 1000);
  g.act(2, "answer", { option: 0, ms: 900 });
  g.room.join("p2b", { anonId: "a2", nick: "닉2" });
  await g.advance(600);
  assert.equal(revealed(g), true);
});

test("early reveal: a hand-over during the beat keeps it (timer as remaining ms); rejoins do not reopen it", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  a.act(1, "start", QUIZ_START);
  await a.advance(3000 + 1000);
  const a0 = shownAnswer(a);
  a.act(2, "answer", { option: a0, ms: 700 });
  a.act(3, "answer", { option: a0, ms: 800 });
  await a.advance(150); // 150 ms into the 300 ms beat
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  assert.equal(snap.timers.find((x) => x.step === "revealQuizRound").remaining, 150);
  a.room.destroy();

  const b = harness({ random: () => 0.1 });
  await b.advance(424242);
  assert.equal(b.room.restore(snap, 100), true);
  [3, 1, 2].forEach(b.join); // re-joins in any order
  await b.advance(49);
  assert.equal(revealed(b), false);
  await b.advance(1);
  assert.equal(b.v("roundAnswer"), a0, "revealed on the beat's own schedule (150 − 100 ms age)");
  assert.deepEqual(rows(b.v("raceBoard")), [{ nick: "닉2", score: pts(700) }, { nick: "닉3", score: pts(800) }]);
  await b.advance(2000);
  assert.equal(b.v("roundNum"), 2);

  // not all in at the hand-over: rejoining answerers first must not pull the reveal in
  const c = harness();
  [1, 2, 3].forEach(c.join);
  c.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  c.act(1, "start", QUIZ_START);
  await c.advance(3000 + 1000);
  c.act(2, "answer", { option: 0, ms: 700 });
  const snap2 = JSON.parse(JSON.stringify(c.room.snapshot()));
  const d = harness();
  d.room.restore(snap2, 0);
  d.join(1);
  d.join(2); // p2 (answered) back first: 1/1 for a moment
  await d.advance(600);
  assert.equal(revealed(d), false, "a rejoin is not an answer");
  d.join(3);
  d.act(3, "answer", { option: 0, ms: 2000 });
  await d.advance(600);
  assert.equal(revealed(d), true, "the real last answer pulls it in");
});

// ── Spectators: a first join during countdown / play watches until the next start ──
const ackFor = (h, n, name) => h.out.filter((m) => m.type === "actionAck" && m.to === `p${n}` && m.d.clientMsgId === `m${n}${name}`).at(-1)?.d;
const flagOf = (h, n) => h.room.playerVars(`p${n}`).iAmSpectator;

test("spectate: a late joiner mid-quiz watches — flag in its state, answers refused (spectator), not in progress / board / recap / acted", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.join(4);
  assert.equal(stateTo(h, "p4").iAmSpectator, true, "the flag rides in the joiner's state");
  assert.equal(flagOf(h, 2), undefined, "players never get the flag");
  assert.equal(h.v("spectators"), 1);
  assert.deepEqual(prog(h), { answered: 0, of: 2 });
  h.act(4, "answer", { option: shownAnswer(h), ms: 100 });
  assert.deepEqual(ackFor(h, 4, "answer"), { clientMsgId: "m4answer", accepted: false, reason: "spectator" });
  assert.deepEqual(prog(h), { answered: 0, of: 2 });
  h.act(2, "answer", { option: shownAnswer(h), ms: 900 });
  h.act(3, "answer", { option: shownAnswer(h), ms: 900 });
  await h.advance(600);
  assert.ok(revealed(h), "early reveal is not held up by the spectator");
  assert.deepEqual(rows(h.v("raceBoard")).map((x) => x.nick), ["닉2", "닉3"]);
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), "result");
  const recap = h.v("quizRecap");
  assert.ok(recap.rounds.every((r) => r.picks.every((p) => p.nick !== "닉4")), "no recap row for the spectator");
  assert.deepEqual([...h.room._state.session.acted].sort(), ["a1", "a2", "a3"]);
  assert.equal(flagOf(h, 4), true, "still watching in the result (until the next start)");
  // next start: a normal player
  h.act(1, "start", QUIZ_START);
  await h.advance(0);
  assert.equal(flagOf(h, 4), false);
  assert.ok(h.out.some((m) => m.to === "p4" && m.type === "setVar" && m.d.id === "iAmSpectator" && m.d.value === false));
  assert.equal(h.v("spectators"), 0);
  await h.advance(3000 + 500);
  assert.deepEqual(prog(h), { answered: 0, of: 3 });
  h.room.action("p4", { name: "answer", payload: { option: shownAnswer(h), ms: 300 }, clientMsgId: "m4again" });
  assert.equal(h.out.filter((m) => m.d?.clientMsgId === "m4again").at(-1).d.accepted, true);
  assert.deepEqual(prog(h), { answered: 1, of: 3 });
});

test("spectate: joining during the countdown watches too; joining during the content fetch plays", async () => {
  const h = harness({ pack: QS });
  [1, 2].forEach(h.join);
  h.act(1, "start", QUIZ_START);
  h.join(3); // the lobby is still up while the pack loads
  await h.advance(1000); // countdown
  h.join(4);
  assert.equal(stateTo(h, "p3").iAmSpectator, undefined);
  assert.equal(stateTo(h, "p4").iAmSpectator, true);
  await h.advance(2500);
  assert.deepEqual(prog(h), { answered: 0, of: 3 });
});

test("spectate: a player's reload mid-play is not a spectator (same anonId); a spectator's reload stays one", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS.slice(0, 1) });
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 1000);
  h.room.leave("p2");
  h.room.join("p2b", { anonId: "a2", nick: "닉2" }); // reloaded tab
  assert.equal(stateTo(h, "p2b").iAmSpectator, undefined);
  h.room.action("p2b", { name: "answer", payload: { option: 0, ms: 500 }, clientMsgId: "r2" });
  assert.equal(h.out.filter((m) => m.d?.clientMsgId === "r2").at(-1).d.accepted, true);
  h.room.leave("p1");
  h.room.join("p1b", { anonId: "a1", nick: "닉1" }); // the subject is back: never a spectator
  assert.notEqual(stateTo(h, "p1b").iAmSpectator, true);
  h.join(5);
  h.room.leave("p5");
  h.room.join("p5b", { anonId: "a5", nick: "닉5" });
  assert.equal(stateTo(h, "p5b").iAmSpectator, true);
  assert.equal(h.v("spectators"), 1);
});

test("spectate: a hand-over keeps spectators and members (arrays in the snapshot); rejoins change nothing", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS.slice(0, 2) });
  a.act(1, "start", QUIZ_START);
  await a.advance(3000 + 1000);
  a.join(4);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  assert.deepEqual(snap.session.spectators, ["a4"]);
  assert.deepEqual(snap.session.members, ["a1", "a2", "a3"]);
  a.room.destroy();
  const b = harness();
  await b.advance(55555);
  b.room.restore(snap, 0);
  [4, 1, 2, 3].forEach(b.join); // the spectator back first
  assert.equal(stateTo(b, "p4").iAmSpectator, true);
  assert.equal(stateTo(b, "p2").iAmSpectator, undefined);
  b.act(4, "answer", { option: 0, ms: 100 });
  assert.equal(ackFor(b, 4, "answer").reason, "spectator");
  b.act(2, "answer", { option: b.room._state.session.rounds[0].answer, ms: 900 });
  b.act(3, "answer", { option: b.room._state.session.rounds[0].answer, ms: 900 });
  assert.deepEqual(prog(b), { answered: 2, of: 2 });
  await b.advance(600);
  assert.ok(revealed(b));
});

test("spectate: tap battle / reaction / vote / guess / nunchi / tally / score — a spectator never scores or counts", async () => {
  // tap race
  const t = harness();
  [1, 2].forEach(t.join);
  t.act(1, "start", { duration: 6000 });
  await t.advance(3000 + 1000);
  t.join(3);
  t.act(3, "taps", { count: 10 });
  t.act(3, "tap");
  t.act(3, "tally", { delta: 5 });
  t.act(3, "score", { score: 999 });
  t.act(2, "taps", { count: 5 });
  for (const name of ["taps", "tap", "tally", "score"]) assert.equal(ackFor(t, 3, name).reason, "spectator", name);
  await t.advance(6000);
  assert.deepEqual(rows(t.v("raceBoard")), [{ nick: "닉2", score: 5 }]);
  assert.ok(!t.room._state.session.acted.has("a3"));
  assert.equal(t.room._state.coop, 0);
  // reaction
  const r = harness({ random: () => 0 });
  [1, 2].forEach(r.join);
  r.act(1, "start", { mode: "reaction" });
  await r.advance(3000 + 1500 + 100);
  r.join(3);
  r.act(3, "reaction", { ms: 120 });
  assert.equal(ackFor(r, 3, "reaction").reason, "spectator");
  await r.advance(5000);
  assert.ok(!(r.v("raceBoard") ?? []).some((x) => x.nick === "닉3"));
  // bracket: the spectator's vote neither counts nor holds up "everyone voted"
  const b = harness({ pack: ["A", "B", "C", "D"], defaults: { o0: 0, o1: 0 } });
  [1, 2].forEach(b.join);
  b.act(1, "start", { game: "wc", bracket: true, matchupMs: 8000 });
  await b.advance(3000 + 100);
  b.join(3);
  b.act(3, "vote", { option: "o1" });
  assert.equal(ackFor(b, 3, "vote").reason, "spectator");
  assert.deepEqual(b.v("votesByOption"), { o0: 0, o1: 0 });
  b.act(1, "vote", { option: "o0" });
  b.act(2, "vote", { option: "o0" });
  await b.advance(600);
  assert.equal(b.v("matchWinner"), 0, "everyone playing voted → advances early");
  // guess
  const g = harness({ pack: [{ a: "x", b: "y" }] });
  [1, 2].forEach(g.join);
  g.act(1, "start", { game: "majority", mode: "guess", rounds: 1, roundMs: 5000 });
  await g.advance(3000);
  g.join(3);
  g.act(3, "vote", { option: "o0" });
  g.act(1, "vote", { option: "o0" });
  await g.advance(5000);
  assert.ok(!g.v("raceBoard").some((x) => x.nick === "닉3"));
  // nunchi: a spectator is never "alive" (no 공동 생존 with a watcher)
  const n = harness();
  [1, 2].forEach(n.join);
  n.act(1, "start", { mode: "nunchi" });
  await n.advance(3000);
  n.join(3);
  n.act(3, "tap");
  assert.equal(ackFor(n, 3, "tap").reason, "spectator");
  await n.advance(30000);
  assert.ok(!String(n.v("nunchiWinner")).includes("닉3"), n.v("nunchiWinner"));
  // the lobby is not a session: nobody is refused there
  const l = harness({ defaults: { A: 0 } });
  l.join(1);
  l.act(1, "start", { duration: 3000 });
  await l.advance(3000 + 100);
  l.join(2);
  l.act(1, "lobby");
  l.act(2, "vote", { option: "A" });
  assert.equal(ackFor(l, 2, "vote").accepted, true);
});

test("spectate: a room that never had a spectator never sends the flag or the count (MP-13)", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 3000 });
  await h.advance(6000);
  h.join(3); // after the game: a player
  h.act(1, "start", { duration: 3000 });
  await h.advance(6000);
  assert.ok(!h.out.some((m) => m.d?.id === "iAmSpectator" || m.d?.id === "spectators"));
  assert.ok(!("spectators" in h.room.sharedState()));
});

// ── rename (#104): a guest picks a real name in the lobby ──
test("rename in the lobby: roster, board row and every connection of that player follow; others untouched", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.room.join("p1b", { anonId: "a1", nick: "닉1" }); // a second tab of player 1
  h.act(1, "start", { duration: 2000 });
  await h.advance(3000);
  h.act(1, "tap");
  h.act(2, "tap");
  await h.advance(2000 + 2000);
  assert.equal(h.v("sessionPhase"), "result");
  h.act(1, "lobby");
  assert.equal(h.v("sessionPhase"), "lobby");
  const pidBefore = h.v("raceBoard").find((x) => x.nick === "닉1").pid;
  h.act(1, "rename", { nick: "민지" });
  assert.deepEqual(ackOf(h, 1, "rename"), { clientMsgId: "m1rename", accepted: true });
  assert.deepEqual(h.v("roster"), ["민지", "닉2"]);
  const row = h.v("raceBoard").find((x) => x.pid === pidBefore);
  assert.equal(row.nick, "민지", "the board row keeps its pid, shows the new name");
  assert.ok(h.v("raceBoard").some((x) => x.nick === "닉2"));
  assert.equal(h.room.nickOf("p1"), "민지");
  assert.equal(h.room.nickOf("p1b"), "민지", "the other tab goes by the new name too");
  assert.equal(h.room.nickOf("p2"), "닉2");
  assert.deepEqual(h.points.at(-1), ["a1", 0], "the new name is registered with no points");
  // a later score is owned by the new name
  h.act(1, "start", { duration: 2000 });
  await h.advance(3000);
  h.act(1, "tap");
  assert.ok(h.v("raceBoard").some((x) => x.nick === "민지"));
});

test("rename: in the result too; refused during the countdown and play (not_in_lobby), nothing changes", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 2000 });
  await h.advance(0);
  assert.equal(h.v("sessionPhase"), "countdown");
  h.act(2, "rename", { nick: "카운트" });
  assert.deepEqual(ackOf(h, 2, "rename"), { clientMsgId: "m2rename", accepted: false, reason: "not_in_lobby" });
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "play");
  h.act(2, "tap");
  h.act(2, "rename", { nick: "플레이" });
  assert.deepEqual(ackOf(h, 2, "rename"), { clientMsgId: "m2rename", accepted: false, reason: "not_in_lobby" });
  assert.deepEqual(h.v("roster"), ["닉1", "닉2"]);
  assert.equal(h.v("raceBoard")[0].nick, "닉2");
  assert.equal(h.room.nickOf("p2"), "닉2");
  await h.advance(2000 + 2000);
  assert.equal(h.v("sessionPhase"), "result");
  h.act(2, "rename", { nick: "결과" });
  assert.equal(ackOf(h, 2, "rename").accepted, true);
  assert.deepEqual(h.v("roster"), ["닉1", "결과"]);
  assert.equal(h.v("raceBoard")[0].nick, "결과");
});

test("rename: sanitized like a join's nickname (trim, 10 graphemes); blank / missing / not text is refused (invalid_nick)", () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "rename", { nick: "  내 이름은 아주아주 긴 별명입니다  " });
  assert.equal(h.v("roster")[0], "내 이름은 아주아주");
  assert.equal(h.v("roster")[0], cleanNick("내 이름은 아주아주 긴 별명입니다"));
  h.act(1, "rename", { nick: "👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦👩‍👩‍👧‍👦" });
  assert.equal(h.v("roster")[0], "👩‍👩‍👧‍👦".repeat(10), "an emoji counts one");
  for (const bad of [{ nick: "   " }, { nick: "" }, {}, { nick: 7 }, { nick: ["a"] }, null]) {
    h.act(2, "rename", bad);
    assert.deepEqual(ackOf(h, 2, "rename"), { clientMsgId: "m2rename", accepted: false, reason: "invalid_nick" }, JSON.stringify(bad));
  }
  assert.deepEqual(h.v("roster"), ["👩‍👩‍👧‍👦".repeat(10), "닉2"]);
});

test("rename: per-player vars and a stored quiz's `about` stay; a rename before sending the pack names the subject", () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "내 퀴즈", questions: QS });
  assert.equal(h.v("quizInfo").about, "닉1");
  const mine = JSON.stringify([...h.room._state.mine]);
  h.act(1, "rename", { nick: "새이름" });
  assert.equal(h.v("quizInfo").about, "닉1", "a pack already sent keeps its subject name");
  assert.equal(JSON.stringify([...h.room._state.mine]), mine, "per-player vars unchanged");
  assert.deepEqual(h.v("roster"), ["새이름", "닉2", "닉3"]);
  // renamed first, then the pack (no `about`): the subject is shown by the new name
  const g = harness();
  [1, 2].forEach(g.join);
  g.act(2, "rename", { nick: "지우" });
  g.act(2, "quizPack", { title: "", questions: QS });
  assert.equal(g.v("quizInfo").about, "지우");
  assert.equal(g.v("quizInfo").title, "지우 퀴즈");
});

test("rename survives snapshot → restore (host hand-over / room server wake-up) and a rejoin with the new name", async () => {
  const a = harness();
  [1, 2].forEach(a.join);
  a.act(1, "start", { duration: 2000 });
  await a.advance(3000);
  a.act(1, "tap");
  a.act(1, "tap");
  a.act(2, "tap");
  await a.advance(4000);
  a.act(1, "rename", { nick: "민지" });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot())); // over the wire
  assert.equal(new Map(snap.nicks).get("a1"), "민지", "the score owner name rides in the snapshot");
  // the next host: the renamed device's hello now carries its new name (the shell updates it)
  const b = harness();
  b.room.restore(snap, 0);
  b.room.join("p1", { anonId: "a1", nick: "민지" });
  b.join(2);
  assert.deepEqual(b.v("roster"), ["민지", "닉2"]);
  assert.deepEqual(b.room.stateFor("p2").sharedState.raceBoard.map((x) => x.nick), ["민지", "닉2"]);
  // a room server woke from hibernation: rejoin from the sockets' attachments, no messages
  const c = harness();
  c.room.restore(snap, 0);
  c.room.rejoin("p1", { anonId: "a1", nick: "민지" });
  c.room.rejoin("p2", { anonId: "a2", nick: "닉2" });
  assert.deepEqual(c.room.stateFor("p2").sharedState.raceBoard.map((x) => x.nick), ["민지", "닉2"]);
  assert.deepEqual(c.room.stateFor("p2").sharedState.roster, ["민지", "닉2"]);
  assert.equal(c.out.length, 0);
});

// ── Hidden picks (start {hidden: true} — 밸런스게임, #126) ──
const BAL = [
  { a: "치킨", b: "피자" },
  { a: "여름", b: "겨울" },
];
const HIDDEN_START = { game: "balance", rounds: 2, roundMs: 10000, revealMs: 3000, hidden: true };
const ZERO = { o0: 0, o1: 0 };
const anonOf = (peer) => `a${peer.slice(1).replace(/b$/, "")}`; // "p1" / "p1b" (a reload) → "a1"
// Nothing that left the room before the reveal says what anyone ELSE picked: no tally but
// zeros, no names, and a pick (myPick) only ever goes to a peer of the player who made it.
const assertNoLeak = (h, from, picks) => {
  for (const m of h.out.slice(from)) {
    const vars = m.type === "setVar" ? { [m.d.id]: m.d.value } : m.type === "state" ? m.d.sharedState : {};
    if ("votesByOption" in vars) assert.deepEqual(vars.votesByOption, ZERO, `running tally to ${m.to}: ${JSON.stringify(m)}`);
    if ("roundPicks" in vars) assert.ok(Object.values(vars.roundPicks).every((x) => x.length === 0), `names to ${m.to}`);
    if ("myPick" in vars) {
      assert.notEqual(m.to, "*", "a pick broadcast to everyone");
      assert.ok([].concat(picks[anonOf(m.to)] ?? []).includes(vars.myPick.option), `${m.to} got someone else's pick`);
    }
    if ("revealRound" in vars) assert.equal(vars.revealRound, -1);
  }
};
const lastTo = (h, peer, id) => [...h.out].reverse().find((m) => m.to === peer && m.type === "setVar" && m.d.id === id)?.d.value;

test("hidden picks: before the reveal nobody gets another's pick or a running tally — only n/m; timeout reveals the split + names at once", async () => {
  const h = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", HIDDEN_START);
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "play");
  assert.equal(h.v("revealRound"), -1);
  assert.deepEqual(h.v("voteProgress"), { voted: 0, of: 3, round: 0, sessionNo: 1 });
  const from = h.out.length;
  h.act(1, "vote", { option: "o0" });
  h.act(2, "vote", { option: "o0" });
  h.act(2, "vote", { option: "o1" }); // a change of mind before the reveal is fine
  assert.deepEqual(h.v("voteProgress"), { voted: 2, of: 3, round: 0, sessionNo: 1 });
  assert.deepEqual(lastTo(h, "p1", "myPick"), { sessionNo: 1, round: 0, option: "o0" }, "my own pick comes back to me");
  assert.equal(lastTo(h, "p2", "myPick")?.option, "o1");
  assert.equal(lastTo(h, "p3", "myPick"), undefined);
  h.join(9); // a newcomer mid-round (a spectator): its state carries no live tally
  h.room.join("p1b", { anonId: "a1", nick: "닉1" }); // p1 reloads: gets its own pick back
  assert.equal(h.room.stateFor("p1b").sharedState.myPick?.option, "o0");
  assert.equal(h.room.stateFor("p3").sharedState.myPick, undefined);
  assert.deepEqual(h.room.stateFor("p9").sharedState.votesByOption, ZERO);
  h.act(9, "vote", { option: "o1" });
  assert.equal(h.v("voteProgress").voted, 2, "a spectator's vote is refused");
  assertNoLeak(h, from, { a1: "o0", a2: ["o0", "o1"] });
  await h.advance(10000 - 1);
  assert.equal(h.v("revealRound"), -1, "p3 never picked → the full window");
  await h.advance(1);
  assert.equal(h.v("revealRound"), 0);
  assert.deepEqual(h.v("votesByOption"), { o0: 1, o1: 1 });
  assert.deepEqual(h.v("roundPicks"), { o0: ["닉1"], o1: ["닉2"] });
  // after the reveal the round is closed: a late pick changes nothing
  h.act(3, "vote", { option: "o1" });
  assert.equal(h.out.filter((m) => m.type === "actionAck" && m.to === "p3").at(-1).d.reason, "closed");
  assert.deepEqual(h.room.stateFor("p3").sharedState.votesByOption, { o0: 1, o1: 1 });
  await h.advance(3000);
  assert.equal(h.v("roundNum"), 2);
  assert.equal(h.v("revealRound"), -1);
  assert.deepEqual(h.v("votesByOption"), ZERO);
  assert.notEqual(h.room.stateFor("p1b").sharedState.myPick.round, h.v("roundIdx"), "last round's pick is not this round's");
  await h.advance(10000 + 3000);
  assert.equal(h.v("sessionPhase"), "result");
});

test("hidden picks: everyone present picked → revealed EARLY_REVEAL_MS later; a leave of the last one missing reveals too", async () => {
  const h = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2].forEach(h.join);
  h.act(1, "start", HIDDEN_START);
  await h.advance(3000 + 1000);
  h.act(1, "vote", { option: "o1" });
  h.act(2, "vote", { option: "o1" });
  assert.deepEqual(h.v("voteProgress"), { voted: 2, of: 2, round: 0, sessionNo: 1 });
  await h.advance(EARLY_REVEAL_MS - 1);
  assert.equal(h.v("revealRound"), -1);
  await h.advance(1);
  assert.equal(h.v("revealRound"), 0);
  assert.deepEqual(h.v("votesByOption"), { o0: 0, o1: 2 });
  assert.deepEqual(h.v("roundPicks"), { o0: [], o1: ["닉1", "닉2"] });
  await h.advance(3000); // revealMs → round 2
  assert.equal(h.v("roundNum"), 2);
  // round 2: p1 picks, p2 (the last one missing) leaves → everyone here has picked
  h.join(3); // a spectator (first join mid-game) never counts
  h.act(1, "vote", { option: "o0" });
  assert.deepEqual(h.v("voteProgress"), { voted: 1, of: 2, round: 1, sessionNo: 1 });
  h.room.leave("p2");
  assert.deepEqual(h.v("voteProgress"), { voted: 1, of: 1, round: 1, sessionNo: 1 });
  await h.advance(EARLY_REVEAL_MS);
  assert.equal(h.v("revealRound"), 1);
  assert.deepEqual(h.v("roundPicks"), { o0: ["닉1"], o1: [] });
});

test("hidden picks: a member reloading mid-round keeps their pick (only to them) and doesn't reopen; one coming back unpicked during the beat reopens it", async () => {
  const h = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2, 3].forEach(h.join);
  h.act(1, "start", HIDDEN_START);
  await h.advance(3000 + 1000);
  const from = h.out.length;
  h.act(1, "vote", { option: "o0" });
  h.act(2, "vote", { option: "o1" });
  h.room.leave("p3"); // p3's phone drops → 2/2 → the beat starts
  await h.advance(100);
  h.join(3); // p3 back (a member, not a spectator), not picked → back to the window's end
  assert.deepEqual(h.v("voteProgress"), { voted: 2, of: 3, round: 0, sessionNo: 1 });
  await h.advance(1000);
  assert.equal(h.v("revealRound"), -1, "reopened");
  h.room.leave("p1");
  h.join(1); // p1 reloads: its own pick in its state, the count unchanged
  assert.equal(h.out.filter((m) => m.type === "state" && m.to === "p1").at(-1).d.sharedState.myPick?.option, "o0");
  assert.deepEqual(h.v("voteProgress"), { voted: 2, of: 3, round: 0, sessionNo: 1 });
  assertNoLeak(h, from, { a1: "o0", a2: "o1" });
  h.act(3, "vote", { option: "o0" });
  await h.advance(EARLY_REVEAL_MS);
  assert.equal(h.v("revealRound"), 0);
  assert.deepEqual(h.v("roundPicks"), { o0: ["닉1", "닉3"], o1: ["닉2"] });
});

test("hidden picks: a hand-over / room-server wake-up mid-round keeps the picks hidden and the reveal on schedule", async () => {
  const a = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2].forEach(a.join);
  a.act(1, "start", HIDDEN_START);
  await a.advance(3000 + 2000);
  a.act(1, "vote", { option: "o1" });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  a.room.destroy();
  const b = harness({ pack: BAL, defaults: { ...ZERO } });
  assert.equal(b.room.restore(snap, 0), true);
  [2, 1].forEach(b.join);
  assertNoLeak(b, 0, { a1: "o1" });
  assert.equal(b.out.find((m) => m.type === "state" && m.to === "p1").d.sharedState.myPick?.option, "o1");
  assert.equal(b.out.find((m) => m.type === "state" && m.to === "p2").d.sharedState.myPick, undefined);
  assert.deepEqual(b.v("voteProgress"), { voted: 1, of: 2, round: 0, sessionNo: 1 });
  b.act(2, "vote", { option: "o1" });
  await b.advance(EARLY_REVEAL_MS);
  assert.equal(b.v("revealRound"), 0);
  assert.deepEqual(b.v("votesByOption"), { o0: 0, o1: 2 });
  // untouched by a rejoin (no messages) too: the window's own end still reveals
  const c = harness({ pack: BAL, defaults: { ...ZERO } });
  c.room.restore(snap, 1000);
  c.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
  c.room.rejoin("p2", { anonId: "a2", nick: "닉2" });
  assert.equal(c.out.length, 0);
  await c.advance(10000 - 2000 - 1000 - 1);
  assert.equal(c.v("revealRound"), undefined);
  await c.advance(1);
  assert.equal(c.v("revealRound"), 0);
  assert.deepEqual(c.v("roundPicks"), { o0: [], o1: ["닉1"] });
});

test("hidden picks: the clock samples server time on resync and wake-up without per-second broadcasts", async () => {
  const a = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2].forEach(a.join);
  a.act(1, "start", HIDDEN_START);
  await a.advance(3000);
  assert.deepEqual(a.v("voteClock"), { round: 0, sessionNo: 1, ms: 10000, leftMs: 10000 });
  await a.advance(4500);
  assert.equal(a.room.stateFor("p1").sharedState.voteClock.leftMs, 5500);
  a.join(3);
  assert.equal(a.out.filter((m) => m.type === "state" && m.to === "p3").at(-1).d.sharedState.voteClock.leftMs, 5500);
  assert.equal(a.out.filter((m) => m.type === "setVar" && m.d.id === "voteClock").length, 1);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  a.room.destroy();
  const b = harness({ pack: BAL, defaults: { ...ZERO } });
  b.room.restore(snap, 500);
  [1, 2].forEach(b.join);
  assert.equal(b.room.stateFor("p1").sharedState.voteClock.leftMs, 5000);
  await b.advance(4999);
  assert.equal(b.room.stateFor("p1").sharedState.voteClock.leftMs, 1);
  assert.equal(b.room.stateFor("p1").sharedState.revealRound, -1);
  await b.advance(1);
  assert.equal(b.v("voteClock").leftMs, 0);
  assert.equal(b.v("revealRound"), 0);
  await b.advance(3000);
  assert.deepEqual(b.v("voteClock"), { round: 1, sessionNo: 1, ms: 10000, leftMs: 10000 });
  b.room.destroy();
});

test("hidden picks are opt-in: a plain round vote (우리 중 누가?) still shows the live tally", async () => {
  const h = harness({ pack: BAL, defaults: { ...ZERO } });
  [1, 2].forEach(h.join);
  h.act(1, "start", { game: "balance", rounds: 1, roundMs: 5000 });
  await h.advance(3000);
  h.act(1, "vote", { option: "o0" });
  assert.deepEqual(h.v("votesByOption"), { o0: 1, o1: 0 });
  assert.equal(h.v("voteProgress"), undefined);
  assert.equal(h.v("revealRound"), undefined, "MP-13: no new variables for templates that never asked");
  assert.equal(h.v("myPick"), undefined);
  assert.equal(h.v("voteClock"), undefined);
});
