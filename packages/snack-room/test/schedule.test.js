// 시작 시간 예약 (#218): in a friends room the host sets when the game starts; at the time it starts
// by itself with 2+ players (3·2·1 as always), alone it waits and starts when the next person joins.
// The host may start early (지금 시작) or cancel (예약 취소). Not a session timer — the room's host
// wakes the engine (scheduleWake → wake(); on the edge the room's one storage alarm).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom, HOST_GRACE_MS, SCHEDULE_MIN_MS, SCHEDULE_MAX_MS } from "../src/room.js";

const START = { duration: 5000 };

function harness({ startRule = "host", wakeHook = false, scheduleMinMs, getPack } = {}) {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const out = [];
  const wakes = [];
  const opts = {
    startRule,
    now: () => t,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    getPack: getPack ?? (async () => null),
    broadcast: (type, d) => out.push({ to: "*", type, d }),
    send: (peerId, type, d) => out.push({ to: peerId, type, d }),
    ...(wakeHook ? { scheduleWake: (at) => wakes.push(at) } : {}),
    ...(scheduleMinMs != null ? { scheduleMinMs } : {}),
  };
  const room = createRoom(opts);
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
  const v = (id) => [...out].reverse().find((m) => m.to === "*" && m.type === "setVar" && m.d.id === id)?.d.value;
  const join = (n) => room.join(`p${n}`, { anonId: `a${n}`, nick: `닉${n}` });
  const act = (n, name, payload) => room.action(`p${n}`, { name, payload, clientMsgId: `m${n}${name}${++seq}` });
  const ackOf = (n) => [...out].reverse().find((m) => m.to === `p${n}` && m.type === "actionAck")?.d;
  const sched = (to = "*") => [...out].reverse().find((m) => m.type === "schedule" && m.to === to)?.d;
  return { room, out, advance, v, join, act, ackOf, sched, timers, wakes, opts, now: () => t, setNow: (x) => (t = x) };
}

test("host only: a guest's schedule / unschedule is refused (not_host); the host's is taken and everyone hears it", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(2, "schedule", { in: 60000, start: START });
  assert.deepEqual([h.ackOf(2).accepted, h.ackOf(2).reason], [false, "not_host"]);
  assert.equal(h.room.scheduled, null);
  h.act(1, "schedule", { in: 60000, start: START });
  assert.equal(h.ackOf(1).accepted, true);
  assert.deepEqual(h.sched(), { on: true, endsIn: 60000, due: false });
  assert.deepEqual(h.room.scheduled, { at: h.now() + 60000, due: false });
  h.act(2, "unschedule");
  assert.deepEqual([h.ackOf(2).accepted, h.ackOf(2).reason], [false, "not_host"]);
  assert.notEqual(h.room.scheduled, null, "still scheduled");
  h.room.destroy();
});

test("friends rooms only: a public room (auto_start) and an 'any' room (not_friends_room) refuse it", () => {
  for (const [rule, reason] of [["auto", "auto_start"], ["any", "not_friends_room"]]) {
    const h = harness({ startRule: rule });
    h.join(1);
    h.act(1, "schedule", { in: 60000, start: START });
    assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, reason], rule);
    assert.equal(h.room.scheduled, null);
    h.room.destroy();
  }
});

test("validation: in within [SCHEDULE_MIN_MS, SCHEDULE_MAX_MS], a start payload ≤ 1 KB, lobby only", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  for (const bad of [{ in: SCHEDULE_MIN_MS - 1, start: START }, { in: SCHEDULE_MAX_MS + 1, start: START }, { in: "soon", start: START }, { start: START }, { in: NaN, start: START }]) {
    h.act(1, "schedule", bad);
    assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, "invalid_time"], JSON.stringify(bad));
  }
  for (const bad of [{ in: 60000 }, { in: 60000, start: [1] }, { in: 60000, start: "x" }, { in: 60000, start: { theme: "x".repeat(2000) } }]) {
    h.act(1, "schedule", bad);
    assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, "invalid_start"], JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(h.room.scheduled, null);
  h.act(1, "schedule", { in: SCHEDULE_MIN_MS, start: START });
  assert.equal(h.ackOf(1).accepted, true, "the minimum is taken");
  h.act(1, "schedule", { in: SCHEDULE_MAX_MS, start: 12000 });
  assert.equal(h.ackOf(1).accepted, true, "24 h (and a bare-number start) is taken — it replaces the first");
  assert.equal(h.room.scheduled.at, h.now() + SCHEDULE_MAX_MS);
  // not in the lobby
  h.act(1, "start", START);
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  h.act(1, "schedule", { in: 60000, start: START });
  assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, "not_in_lobby"]);
  h.room.destroy();
});

test("the time comes with 2 here: the game starts by itself (3·2·1, the scheduled payload) — no session timer meanwhile", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(1, "schedule", { in: 60000, start: { duration: 7000 } });
  assert.equal(h.room._state.session.timers.length, 0, "not a session timer (the room may sleep)");
  await h.advance(59000);
  assert.notEqual(h.v("sessionPhase"), "countdown");
  await h.advance(1000);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.room.scheduled, null, "cleared by the start");
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "play");
  await h.advance(7000);
  assert.equal(h.v("sessionPhase"), "result", "the scheduled payload's 7 s");
  h.room.destroy();
});

test("alone at the time: it waits ('due') and starts the moment the 2nd person joins", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "schedule", { in: 30000, start: START });
  await h.advance(30000);
  assert.notEqual(h.v("sessionPhase"), "countdown", "alone: no game");
  assert.deepEqual(h.room.scheduled, { at: h.now(), due: true });
  assert.deepEqual(h.sched(), { on: true, endsIn: 0, due: true }, "everyone hears: waiting");
  await h.advance(120000);
  assert.notEqual(h.v("sessionPhase"), "countdown", "still waiting, no timer");
  assert.equal(h.timers.size, 0);
  h.join(2);
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown", "the 2nd arrival starts it");
  assert.equal(h.room.scheduled, null);
  h.room.destroy();
});

test("late joiners before the time just join the lobby — they get the countdown on their clock", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "schedule", { in: 60000, start: START });
  await h.advance(20000);
  h.join(2);
  assert.deepEqual(h.sched("p2"), { on: true, endsIn: 40000, due: false });
  assert.equal(h.v("sessionPhase") ?? "lobby", "lobby");
  h.room.destroy();
});

test("예약 취소: the host cancels — everyone hears {on: false}; the time passes with nothing", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(1, "schedule", { in: 60000, start: START });
  h.act(1, "unschedule");
  assert.equal(h.ackOf(1).accepted, true);
  assert.deepEqual(h.sched(), { on: false, endsIn: -1, due: false });
  assert.equal(h.timers.size, 0, "its timer is gone");
  await h.advance(120000);
  assert.notEqual(h.v("sessionPhase"), "countdown");
  h.room.destroy();
});

test("지금 시작: the host starts early — the schedule ends (no second start at the time)", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(1, "schedule", { in: 60000, start: START });
  await h.advance(5000);
  h.act(1, "start", START);
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.room.scheduled, null);
  await h.advance(3000 + 5000);
  assert.equal(h.v("sessionPhase"), "result");
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), "result", "nothing restarts at the old time");
  h.room.destroy();
});

test("restore mid-schedule (hibernation / a host hand-over): the time left carries over, then it starts", async () => {
  const a = harness();
  a.join(1);
  a.join(2);
  a.act(1, "schedule", { in: 60000, start: START });
  await a.advance(20000);
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  a.room.destroy();
  const b = harness();
  b.setNow(5_000_000); // another clock: only relative times travel
  assert.equal(b.room.restore(snap, 1000), true);
  assert.deepEqual(b.room.scheduled, { at: b.now() + 39000, due: false });
  b.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
  b.room.rejoin("p2", { anonId: "a2", nick: "닉2" });
  await b.advance(38900);
  assert.notEqual(b.v("sessionPhase"), "countdown");
  await b.advance(100);
  assert.equal(b.v("sessionPhase"), "countdown", "started at the restored time");
  b.room.destroy();
});

test("restore of a schedule that came due while asleep / waiting alone: the next join starts it", async () => {
  const a = harness();
  a.join(1);
  a.act(1, "schedule", { in: 15000, start: START });
  await a.advance(15000);
  assert.equal(a.room.scheduled.due, true);
  const snap = a.room.snapshot();
  a.room.destroy();
  const b = harness();
  b.room.restore(snap, 5000);
  assert.equal(b.room.scheduled.due, true);
  b.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
  b.join(2);
  await b.advance(10);
  assert.equal(b.v("sessionPhase"), "countdown");
  b.room.destroy();
});

test("host hand-over keeps the schedule: the new host may cancel it, the old one no longer", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.join(3);
  h.act(1, "schedule", { in: 5 * 60000, start: START });
  h.room.leave("p1");
  await h.advance(HOST_GRACE_MS + 10);
  assert.equal(h.v("hostNick"), "닉2", "handed over");
  assert.notEqual(h.room.scheduled, null, "still scheduled");
  h.join(1); // back: not the host any more
  h.act(1, "unschedule");
  assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, "not_host"]);
  h.act(2, "unschedule");
  assert.equal(h.ackOf(2).accepted, true);
  assert.equal(h.room.scheduled, null);
  h.room.destroy();
});

test("a hand-over left alone runs it: the schedule fires for the new host", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.join(3);
  h.act(1, "schedule", { in: 2 * 60000, start: START });
  h.room.leave("p1");
  await h.advance(2 * 60000);
  assert.equal(h.v("sessionPhase"), "countdown", "p2 + p3 play at the time");
  h.room.destroy();
});

test("the room empties: the schedule goes with it (its timer too)", () => {
  const h = harness();
  h.join(1);
  h.act(1, "schedule", { in: 60000, start: START });
  assert.equal(h.timers.size, 1);
  h.room.leave("p1");
  assert.equal(h.timers.size, 0);
});

test("scheduleWake (the edge's alarm): asked for the time, null on cancel / start / due; wake() early changes nothing", async () => {
  const h = harness({ wakeHook: true });
  h.join(1);
  h.join(2);
  h.act(1, "schedule", { in: 60000, start: START });
  assert.deepEqual(h.wakes, [h.now() + 60000]);
  assert.equal(h.timers.size, 0, "no engine timer of its own");
  h.act(1, "unschedule");
  assert.deepEqual(h.wakes.at(-1), null);
  h.act(1, "schedule", { in: 30000, start: START });
  const at = h.wakes.at(-1);
  await h.advance(10000);
  h.room.wake(); // early (an alarm for someone away)
  assert.notEqual(h.v("sessionPhase"), "countdown");
  assert.equal(h.wakes.at(-1), at, "the same time again");
  await h.advance(20000);
  assert.notEqual(h.v("sessionPhase"), "countdown", "nothing fires without wake()");
  h.room.wake();
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.wakes.at(-1), null);
  h.room.destroy();
});

test("scheduleMinMs (tests only): a shorter minimum", () => {
  const h = harness({ scheduleMinMs: 1000 });
  h.join(1);
  h.act(1, "schedule", { in: 5000, start: START });
  assert.equal(h.ackOf(1).accepted, true);
  h.room.destroy();
});

test("나 맞히기: the quiz subject is the host — they schedule (the room's host may not); the time starts their quiz", async () => {
  const h = harness();
  h.join(1); // host
  h.join(2);
  h.act(2, "quizPack", { title: "닉2 퀴즈", questions: [{ q: "좋아하는 색?", options: ["빨강", "파랑"], answer: 1 }] });
  assert.equal(h.ackOf(2).accepted, true);
  h.act(1, "schedule", { in: 60000, start: { quiz: true } });
  assert.deepEqual([h.ackOf(1).accepted, h.ackOf(1).reason], [false, "not_subject"]);
  h.act(2, "schedule", { in: 60000, start: { quiz: true } });
  assert.equal(h.ackOf(2).accepted, true);
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.v("quizInfo").about, "닉2", "the subject's own quiz");
  h.room.destroy();
});

test("나 맞히기 at the time with only the subject here: it waits for someone to guess", async () => {
  const h = harness();
  h.join(1);
  h.act(1, "quizPack", { questions: [{ q: "좋아하는 색?", options: ["빨강", "파랑"], answer: 1 }] });
  h.act(1, "schedule", { in: 20000, start: { quiz: true } });
  await h.advance(20000);
  assert.notEqual(h.v("sessionPhase"), "countdown");
  h.join(2);
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  h.room.destroy();
});
