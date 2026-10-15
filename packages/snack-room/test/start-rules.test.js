// Who starts a game (#135 / #136): a friends room's host (방장) — only they start / end a game,
// handed on after HOST_GRACE_MS away — and a public room that starts by itself (auto-start
// countdown, back to the lobby after the result, late arrivals told they would only watch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom, HOST_GRACE_MS, AUTO_START_MS, AUTO_START_MIN, RESULT_HOLD_MS } from "../src/room.js";

function harness({ startRule = "any", pack = null, autoStartMs, autoStartMin, getPack } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const out = [];
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
    getPack: getPack ?? (async () => pack),
    broadcast: (type, d) => out.push({ to: "*", type, d }),
    send: (peerId, type, d) => out.push({ to: peerId, type, d }),
    ...(autoStartMs ? { autoStartMs } : {}),
    ...(autoStartMin ? { autoStartMin } : {}),
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
  // What player n sees for a per-player var (their own sends, else their last state)
  const mine = (n, id) => {
    for (const m of [...out].reverse()) {
      if (m.to !== `p${n}`) continue;
      if (m.type === "setVar" && m.d.id === id) return m.d.value;
      if (m.type === "state" && id in m.d.sharedState) return m.d.sharedState[id];
    }
    return undefined;
  };
  const join = (n) => room.join(`p${n}`, { anonId: `a${n}`, nick: `닉${n}` });
  const act = (n, name, payload) => room.action(`p${n}`, { name, payload, clientMsgId: `m${n}${name}${++seq}` });
  const ackOf = (n) => [...out].reverse().find((m) => m.to === `p${n}` && m.type === "actionAck")?.d;
  const autoMsgs = () => out.filter((m) => m.type === "autoStart");
  return { room, out, advance, v, mine, join, act, ackOf, autoMsgs, timers, opts, now: () => t };
}

// ── 방장 (host) ──

test("host room: the first person in hosts — others' start / lobby are refused (not_host), the host's start runs", async () => {
  const h = harness({ startRule: "host" });
  h.join(1);
  h.join(2);
  assert.equal(h.v("roomMode"), "host");
  assert.equal(h.v("hostNick"), "닉1");
  assert.equal(h.mine(1, "iAmHost"), true);
  assert.equal(h.mine(2, "iAmHost"), false);
  assert.equal(h.room.stateFor("p2").sharedState.iAmHost, false);
  h.act(2, "start", { duration: 5000 });
  assert.deepEqual([h.ackOf(2).accepted, h.ackOf(2).reason], [false, "not_host"]);
  await h.advance(10);
  assert.notEqual(h.v("sessionPhase"), "countdown");
  h.act(1, "start", { duration: 5000 });
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  await h.advance(3000 + 5000);
  assert.equal(h.v("sessionPhase"), "result");
  // 다시 하기 / 대기실 from the result: host only too
  h.act(2, "start", { duration: 5000 });
  assert.equal(h.ackOf(2).reason, "not_host");
  h.act(2, "lobby");
  assert.equal(h.ackOf(2).reason, "not_host");
  assert.equal(h.v("sessionPhase"), "result");
  h.act(1, "lobby");
  assert.equal(h.v("sessionPhase"), "lobby");
});

test("host room: away < 30 s keeps the host; past HOST_GRACE_MS the earliest-joined player takes over; the old host does not take it back", async () => {
  const h = harness({ startRule: "host" });
  h.join(1);
  h.join(2);
  h.join(3);
  h.room.leave("p1");
  await h.advance(HOST_GRACE_MS - 1000);
  assert.equal(h.v("hostNick"), "닉1", "still the host within the grace");
  h.act(2, "start", {});
  assert.equal(h.ackOf(2).reason, "not_host");
  await h.advance(1000);
  assert.equal(h.v("hostNick"), "닉2", "handed to the earliest-joined player here");
  assert.equal(h.mine(2, "iAmHost"), true);
  assert.equal(h.mine(3, "iAmHost"), false);
  h.join(1); // back later
  assert.equal(h.mine(1, "iAmHost"), false, "no automatic take-back");
  assert.equal(h.room.stateFor("p1").sharedState.iAmHost, false);
  h.act(1, "start", { duration: 3000 });
  assert.equal(h.ackOf(1).reason, "not_host");
  h.act(2, "start", { duration: 3000 });
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
});

test("host room: back within the grace (a reload / the share sheet) stays the host", async () => {
  const h = harness({ startRule: "host" });
  h.join(1);
  h.join(2);
  h.room.leave("p1");
  await h.advance(5000);
  h.join(1);
  await h.advance(HOST_GRACE_MS);
  assert.equal(h.v("hostNick"), "닉1");
  assert.equal(h.mine(1, "iAmHost"), true);
});

test("host room + 나 맞히기 quiz: the subject's rule wins (the subject starts their quiz, host or not)", async () => {
  const h = harness({ startRule: "host" });
  h.join(1); // host
  h.join(2);
  h.act(2, "quizPack", { title: "나", questions: [{ q: "q", options: ["a", "b"], answer: 0 }] });
  assert.notEqual(h.ackOf(2).accepted, false);
  h.act(1, "start", { quiz: true });
  assert.equal(h.ackOf(1).reason, "not_subject", "the host is not this quiz's subject");
  h.act(2, "start", { quiz: true });
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
});

test("any room (default): roomMode / hostNick are never sent (MP-13), anyone starts", async () => {
  const h = harness();
  h.join(1);
  h.join(2);
  h.act(2, "start", { duration: 3000 });
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.out.some((m) => m.type === "setVar" && ["roomMode", "hostNick", "iAmHost"].includes(m.d.id)), false);
  assert.equal(h.autoMsgs().length, 0);
});

test("host snapshot / restore keeps the host and its away clock", async () => {
  const h = harness({ startRule: "host" });
  h.join(1);
  h.join(2);
  h.room.leave("p1");
  await h.advance(20000);
  const snap = h.room.snapshot();
  const h2 = harness({ startRule: "host" });
  h2.room.restore(snap, 0);
  h2.room.join("p2", { anonId: "a2", nick: "닉2" });
  await h2.advance(9000);
  assert.equal(h2.room._state.session.host, "a1", "10 s of grace left");
  await h2.advance(1000);
  assert.equal(h2.room._state.session.host, "a2");
});

// ── 자동 시작 (auto) ──
// #141: the countdown runs only with AUTO_START_MIN (2) players here — one person alone waits.

test("auto room: nothing until configured; one person alone never starts — the 2nd arrival arms the countdown, which starts by itself", async () => {
  const h = harness({ startRule: "auto" });
  h.join(1);
  assert.equal(h.v("roomMode"), "auto");
  assert.equal(h.autoMsgs().length, 0, "no start payload yet: no countdown");
  assert.equal(h.room.configureAuto({ duration: 4000 }, undefined), true);
  assert.equal(h.room.configureAuto({ duration: 9999 }, 3000), false, "the first one kept wins");
  assert.equal(AUTO_START_MIN, 2);
  assert.equal(h.autoMsgs().length, 0, "alone: no countdown");
  h.act(1, "start", { duration: 1 });
  assert.equal(h.ackOf(1).reason, "need_players", "a tap alone does not start it either");
  await h.advance(5 * 60000);
  assert.equal(h.v("sessionPhase"), undefined, "5 minutes alone: still the lobby");
  assert.equal(h.autoMsgs().length, 0);
  h.join(2); // the second person: the countdown starts for both
  assert.deepEqual(
    h.autoMsgs().map((m) => [m.to, m.d]),
    [["*", { endsIn: AUTO_START_MS, ms: AUTO_START_MS }]],
  );
  await h.advance(6000);
  h.join(3); // during the countdown: a player, told the time left
  const told = h.out.filter((m) => m.to === "p3" && m.type === "autoStart");
  assert.deepEqual(told.map((m) => m.d.endsIn), [4000]);
  h.act(3, "start", { duration: 1 });
  assert.equal(h.ackOf(3).reason, "auto_start", "nobody needs to (or may) press start");
  await h.advance(4000);
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.equal(h.room.wouldSpectate("a3"), false, "joined during the countdown: plays");
  assert.equal(h.room.wouldSpectate("a9"), true, "someone new now would only watch");
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "play");
});

test("auto room: dropping to 1 during the countdown cancels it (everyone told); a 2nd person again starts a fresh one", async () => {
  const h = harness({ startRule: "auto" });
  h.join(1);
  h.room.configureAuto({ duration: 3000 });
  h.join(2);
  await h.advance(6000);
  h.room.leave("p2");
  assert.equal(h.room._state.session.timers.some((x) => x.step === "autoStart"), false, "cancelled");
  assert.deepEqual(h.autoMsgs().at(-1), { to: "*", type: "autoStart", d: { endsIn: -1, ms: AUTO_START_MS } }, "the one left is told: no countdown");
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), undefined, "never started alone");
  h.join(3);
  assert.equal(h.autoMsgs().at(-1).d.endsIn, AUTO_START_MS, "a 2nd person again: a fresh countdown");
  // a reload (same person, a new connection overlapping the old) is not a leave
  h.room.join("p3b", { anonId: "a3", nick: "닉3" });
  h.room.leave("p3");
  assert.equal(h.room._state.session.timers.some((x) => x.step === "autoStart"), true, "still 2 here: counting");
  h.join(4);
  h.room.leave("p4"); // 3 → 2: keeps counting
  assert.equal(h.room._state.session.timers.some((x) => x.step === "autoStart"), true);
  await h.advance(AUTO_START_MS + 10);
  assert.equal(h.v("sessionPhase"), "countdown");
});

test("auto room: the 2nd person leaves while the start fetches its content → no game alone; waits, a new 2nd arrival starts it", async () => {
  let release = () => {};
  let fetches = 0;
  const pack = [{ q: "1+1?", options: ["2", "3"], answer: 0 }];
  const getPack = () => {
    fetches += 1;
    return new Promise((res) => (release = () => res(pack)));
  };
  const h = harness({ startRule: "auto", getPack });
  h.join(1);
  h.room.configureAuto({ game: "speed-trivia", quiz: true, rounds: 1 });
  h.join(2);
  await h.advance(AUTO_START_MS); // the timer fires: the start is fetching (the lobby still up)
  assert.equal(fetches, 1);
  assert.equal(h.v("sessionPhase"), undefined, "still the lobby while fetching");
  h.join(3); // a join meanwhile: no second countdown on top of the start in flight
  assert.equal(h.room._state.session.timers.some((x) => x.step === "autoStart"), false);
  h.room.leave("p3");
  h.room.leave("p2"); // one left before the content arrives
  release();
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), undefined, "never started with one member");
  assert.equal(h.room._state.session.members, null);
  assert.equal(h.autoMsgs().at(-1).d.endsIn, -1, "the one left is told: waiting again");
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), undefined, "still waiting alone");
  h.join(4);
  assert.equal(h.autoMsgs().at(-1).d.endsIn, AUTO_START_MS, "a new 2nd person: a fresh countdown");
  await h.advance(AUTO_START_MS);
  release();
  await h.advance(10);
  assert.equal(h.v("sessionPhase"), "countdown");
  assert.deepEqual([...h.room._state.session.members].sort(), ["a1", "a4"]);
});

test("auto room: everyone leaves during the countdown → it stops", async () => {
  const h = harness({ startRule: "auto" });
  h.join(1);
  h.join(2);
  h.room.configureAuto({ duration: 3000 });
  await h.advance(5000);
  h.room.leave("p1");
  h.room.leave("p2"); // (the room is torn down here — a fresh engine would start over)
  assert.equal(h.room._state.session.timers.some((x) => x.step === "autoStart"), false);
});

test("auto room: after the result the lobby comes back (RESULT_HOLD_MS) and counts down again — only if someone played", async () => {
  const h = harness({ startRule: "auto", autoStartMs: 3000 });
  h.join(1);
  h.join(2);
  h.room.configureAuto({ duration: 3000 }, 3000);
  await h.advance(3000 + 10);
  await h.advance(3000); // 3·2·1 → play
  h.act(1, "taps", { count: 3 });
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "result");
  h.act(1, "lobby");
  assert.equal(h.ackOf(1).reason, "auto_start");
  await h.advance(RESULT_HOLD_MS);
  assert.equal(h.v("sessionPhase"), "lobby");
  assert.equal(h.autoMsgs().at(-1).d.endsIn, 3000, "re-armed: someone played");
  // a game nobody played: the lobby idles (two phones left open do not loop games)
  await h.advance(3000 + 3000 + 3000);
  assert.equal(h.v("sessionPhase"), "result");
  const n = h.autoMsgs().length;
  await h.advance(RESULT_HOLD_MS);
  assert.equal(h.v("sessionPhase"), "lobby");
  assert.equal(h.autoMsgs().length, n, "idle: no countdown");
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), "lobby");
  h.act(1, "start", {}); // a tap wakes it
  assert.notEqual(h.ackOf(1).accepted, false);
  assert.equal(h.autoMsgs().length, n + 1);
  h.join(3); // already counting: told, not re-armed
  assert.equal(h.autoMsgs().length, n + 2);
  assert.equal(h.autoMsgs().at(-1).to, "p3");
});

test("auto room: someone played but only one is left when the result returns to the lobby → waits; a 2nd arrival arms it", async () => {
  const h = harness({ startRule: "auto", autoStartMs: 3000 });
  h.join(1);
  h.join(2);
  h.room.configureAuto({ duration: 3000 }, 3000);
  await h.advance(3000 + 10 + 3000);
  h.act(1, "taps", { count: 3 });
  h.act(2, "taps", { count: 2 });
  await h.advance(3000);
  assert.equal(h.v("sessionPhase"), "result");
  h.room.leave("p2");
  const n = h.autoMsgs().length;
  await h.advance(RESULT_HOLD_MS);
  assert.equal(h.v("sessionPhase"), "lobby");
  assert.equal(h.autoMsgs().length, n, "alone after the result: no countdown");
  h.act(1, "start", {});
  assert.equal(h.ackOf(1).reason, "need_players");
  await h.advance(60000);
  assert.equal(h.v("sessionPhase"), "lobby", "a lone phone does not loop games");
  h.join(4);
  assert.equal(h.autoMsgs().at(-1).d.endsIn, 3000, "the 2nd person: counting again");
  await h.advance(3000 + 10);
  assert.equal(h.v("sessionPhase"), "countdown");
});

test("auto room: snapshot mid-countdown → restored engine starts on time; too few back → it waits (hibernation / hand-over)", async () => {
  const h = harness({ startRule: "auto" });
  h.join(1);
  h.join(2);
  h.room.configureAuto({ duration: 3000 });
  await h.advance(7000);
  const snap = h.room.snapshot();
  assert.equal(snap.timers.find((x) => x.step === "autoStart").remaining, 3000);
  const back = (hx) => {
    hx.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
    hx.room.rejoin("p2", { anonId: "a2", nick: "닉2" });
  };
  const h2 = harness({ startRule: "auto" });
  h2.room.restore(snap, 1000); // stored 1 s ago
  back(h2);
  await h2.advance(1999);
  assert.notEqual(h2.v("sessionPhase"), "countdown");
  await h2.advance(1 + 10);
  assert.equal(h2.v("sessionPhase"), "countdown");
  // a new arrival after the restore is told the time left on the restored clock
  const h3 = harness({ startRule: "auto" });
  h3.room.restore(snap, 0);
  back(h3);
  h3.join(3);
  assert.equal(h3.out.find((m) => m.to === "p3" && m.type === "autoStart").d.endsIn, 3000);
  // one of the two leaves after the restore: cancelled, the other waits
  const h4 = harness({ startRule: "auto" });
  h4.room.restore(snap, 0);
  back(h4);
  h4.room.leave("p2");
  assert.equal(h4.autoMsgs().at(-1).d.endsIn, -1);
  await h4.advance(60000);
  assert.equal(h4.v("sessionPhase"), undefined);
  // only one came back before the countdown ran out: it does not start alone
  const h5 = harness({ startRule: "auto" });
  h5.room.restore(snap, 0);
  h5.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
  await h5.advance(3000 + 10);
  assert.equal(h5.v("sessionPhase"), undefined, "not started with one");
  assert.equal(h5.autoMsgs().at(-1).d.endsIn, -1, "told: waiting again");
  h5.join(2);
  assert.equal(h5.autoMsgs().at(-1).d.endsIn, AUTO_START_MS, "the second back: counting");
  // a snapshot taken while one waits alone keeps waiting after the restore
  const h6 = harness({ startRule: "auto" });
  h6.join(1);
  h6.room.configureAuto({ duration: 3000 });
  const lone = h6.room.snapshot();
  assert.equal(lone.timers.length, 0);
  const h7 = harness({ startRule: "auto" });
  h7.room.restore(lone, 0);
  h7.room.rejoin("p1", { anonId: "a1", nick: "닉1" });
  await h7.advance(60000);
  assert.equal(h7.autoMsgs().length, 0);
  h7.join(2);
  assert.equal(h7.autoMsgs().at(-1).d.endsIn, AUTO_START_MS);
});

test("auto room: the minimum is an option (autoStartMin); 1 = the old first-arrival rule", () => {
  const h = harness({ startRule: "auto", autoStartMin: 1 });
  h.join(1);
  h.room.configureAuto({ duration: 3000 });
  assert.equal(h.autoMsgs().at(-1).d.endsIn, AUTO_START_MS);
  const h3 = harness({ startRule: "auto", autoStartMin: 3 });
  h3.join(1);
  h3.join(2);
  h3.room.configureAuto({ duration: 3000 });
  assert.equal(h3.autoMsgs().length, 0);
  h3.join(3);
  assert.equal(h3.autoMsgs().length, 1);
});

test("auto room: a quiz pack is refused (a public room plays the app's own quiz); bad configs are ignored", () => {
  const h = harness({ startRule: "auto" });
  h.join(1);
  assert.equal(h.room.configureAuto(["x"]), false);
  assert.equal(h.room.configureAuto({ big: "x".repeat(2000) }), false);
  assert.equal(h.room.configureAuto({ quiz: true }, 999999), true);
  assert.equal(h.room._state.session.autoMs, 60000, "clamped");
  h.act(1, "quizPack", { title: "t", questions: [{ q: "q", options: ["a", "b"], answer: 0 }] });
  assert.equal(h.ackOf(1).reason, "auto_room");
});
