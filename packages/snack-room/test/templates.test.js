import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../bite/src/runtime.js";
import { createRoom } from "../src/room.js";
// raceBoard rows carry a per-room `pid`; compare names and scores
const rows = (b) => (b || []).map(({ pid, ...x }) => x);

// Headless "two devices, one room": each device runs the REAL template in the Bite
// runtime; its `emit`s go into the room engine and the engine's setVars go back to every
// device — the way the player wires it (LiveApp). Per-device state (내 탭, 내 반응, my vote)
// is the template's own business, so what one device shows must agree with what the
// board says about it — in the first game and in the next one, whoever pressed 시작.
const DIR = new URL("../../../snack-server/data/bite/", import.meta.url);
const CONTENT = new URL("../../../snack-server/data/multi-content/", import.meta.url);
const load = (id) => JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));

// Optional per device: `clock` offset (its own wall clock), `down` / `up` network delay
// (host → device setVars, device → host actions) in ms — delivered in order.
function table(id, nicks, { random = () => 0.3, clock = [], down = [], up = [] } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const devices = new Map(); // peerId → app
  const later = (ms, fn) => {
    const h = ++seq;
    timers.set(h, { at: t + ms, fn, h });
  };
  const toDevice = (peerId, fn) => {
    const ms = down[Number(peerId.slice(1))] ?? 0;
    if (ms) later(ms, fn);
    else fn();
  };
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
      for (const [peerId, app] of devices) toDevice(peerId, () => app.setVar(d.id, d.value));
    },
    send: (peerId, type, d) => {
      const app = devices.get(peerId);
      if (!app) return;
      if (type === "setVar") toDevice(peerId, () => app.setVar(d.id, d.value));
      if (type === "state") toDevice(peerId, () => Object.entries(d.sharedState).forEach(([k, v]) => app.setVar(k, v)));
    },
  });
  const boot = (i, nick) => {
    const peerId = `p${i}`;
    const app = createBite(load(id), { now: () => t + (clock[i] ?? 0), warn: (m) => assert.fail(`${nick}: ${m}`) });
    app.on("emit", (e) => {
      if (devices.get(peerId) !== app) return; // a closed tab
      const act = () => room.action(peerId, { name: e.name, payload: e.payload, clientMsgId: `${peerId}-${++seq}` });
      if (up[i]) later(up[i], act);
      else act();
    });
    app.start();
    devices.set(peerId, app);
    room.join(peerId, { anonId: `a${i}`, nick });
  };
  nicks.forEach((nick, i) => boot(i, nick));
  // Device i closes its tab (leaves) / reloads (a fresh app, same player).
  const gone = (i) => {
    devices.delete(`p${i}`);
    room.leave(`p${i}`);
  };
  const reload = (i) => {
    gone(i);
    boot(i, nicks[i]);
  };
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
  // A node's text / prop as device i renders it now.
  const nodeById = (nid, n = load(id).view) => (n?.id === nid ? n : (n?.children ?? []).map((c) => nodeById(nid, c)).find(Boolean));
  const prop = (i, nid, key = "text") => app(i).value(key.split(".").reduce((o, k) => o?.[k], nodeById(nid)));
  return { room, advance, app, prop, gone, reload, now: () => t, tap: (i, node) => app(i).tap(node), v: (i, name) => app(i).eval(name), phase: (i) => app(i).phase };
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
  assert.deepEqual(rows(T.v(1, "raceBoard")), [{ nick: "B", score: 40 }]);
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
  assert.deepEqual(rows(T.v(1, "raceBoard")), [{ nick: "B", score: 50 }], "board == card (not 90)");
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

// 나 맞히기 퀴즈 (speed-trivia-score): A is the subject (sent the pack, as the shell does);
// B has a slow network (question reaches it 300 ms late, its taps take 900 ms to arrive),
// C's wall clock is a day off. The score must come from each DEVICE's own "question shown →
// tap" time, never from when the host heard the tap.
test("speed-trivia (나 맞히기): answer time measured on each device's clock; the subject only watches", async () => {
  const QS = [
    { q: "A가 좋아하는 색은?", options: ["빨강", "파랑", "초록", "노랑"], answer: 1 },
    { q: "A의 MBTI는?", options: ["INFP", "ENTJ", "ISTJ"], answer: 2 },
  ];
  const T = table("speed-trivia-score", ["A", "B", "C"], { clock: [0, 5000, 86_400_000], down: [0, 300, 0], up: [0, 900, 0] });
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS, settings: { answerMs: 8000 } }, clientMsgId: "pack" });
  await T.advance(400);
  assert.equal(T.v(0, "iAmSubject"), true);
  assert.equal(T.v(1, "iAmSubject"), false);
  assert.equal(T.v(1, "quizInfo.about"), "A");
  assert.equal(T.tap(1, "startBtn"), false, "only the subject has a start button");
  assert.equal(T.prop(1, "waitBtn", "props.label"), "A 님이 시작하면 바로 시작돼요");
  assert.equal(T.prop(0, "lobbyStatus"), "준비 완료 · 시작하기를 눌러요");
  T.tap(0, "startBtn"); // the subject starts
  await T.advance(3000 + 300 + 32);
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "play");
  const right = (i) => {
    const rc = T.v(i, "roundContent");
    const src = QS.find((x) => x.q === rc.q);
    return rc.options.indexOf(src.options[src.answer]);
  };
  assert.equal(T.v(1, "seenRound"), 0);
  const seenB = T.v(1, "seenAt");
  const seenC = T.v(2, "seenAt");
  assert.match(T.prop(0, "statusText"), /친구들이 고르는 중… \(0\/2\)/);
  assert.equal(T.prop(1, "statusText"), "A 님을 맞혀라!");
  assert.ok(T.prop(1, "timerBar", "width") > 280, "the bar starts full");
  // the subject's tap does nothing
  T.tap(0, `tile${right(0)}`);
  assert.equal(T.v(0, "myAnswerRound"), -2);
  await T.advance(1200);
  T.tap(1, `tile${right(1)}`); // B: ~1.2 s after it saw the question
  await T.advance(800);
  T.tap(2, `tile${right(2)}`); // C: slower on its own device, but its tap reaches the host BEFORE B's
  const msB = T.v(1, "myMs");
  const msC = T.v(2, "myMs");
  assert.ok(msB >= 1200 - 32 && msB <= 1200 + 32, `B measured ${msB}`);
  // C saw the question 300 ms before B (no delay), so 2.3 s on its own clock; its tap still
  // reaches the host ~100 ms before B's (B's uplink is 900 ms)
  assert.equal(msC, T.v(2, "now - seenAt"));
  assert.ok(msC >= 2332 - 32 && msC <= 2332, `C measured ${msC} (clock a day off)`);
  assert.ok(seenC > 86_400_000, "C's own clock");
  assert.equal(T.prop(1, "statusText"), "선택 완료! 공개를 기다려요");
  assert.ok(T.prop(1, "timerBar", "width") < 298 * 0.8, "the bar runs down");
  T.tap(1, `tile${(right(1) + 1) % 4}`); // a second tap changes nothing
  await T.advance(1000);
  assert.match(T.prop(0, "statusText"), /\(2\/2\)/);
  await T.advance(8000 - 3000 - 32 + 300);
  // reveal: B and C both right — B was faster on its own device, so B leads
  const pts = (ms) => Math.max(100, 1000 - Math.round((ms / 8000) * 800));
  const board = T.v(0, "raceBoard");
  assert.deepEqual(board, [{ nick: "B", score: pts(msB), pid: "p2" }, { nick: "C", score: pts(msC), pid: "p3" }]);
  assert.deepEqual([0, 1, 2].map((i) => T.v(i, "myPid")), ["p1", "p2", "p3"], "each device knows its own row");
  assert.match(T.prop(1, "statusText"), /^정답! ✓ /);
  assert.equal(T.prop(0, "statusText"), "정답 공개!");
  assert.match(T.prop(1, `tile${right(1)}Txt`), /^✓ /);
  // round 2: B misses, C lets the clock run out on its device
  await T.advance(3000);
  assert.equal(T.v(1, "roundNum"), 2);
  T.tap(1, `tile${(right(1) + 1) % 3}`);
  await T.advance(8500);
  assert.equal(T.prop(1, "statusText"), "땡! ✗");
  assert.equal(T.prop(2, "statusText"), "시간 초과 ⌛");
  assert.match(T.prop(1, `tile${(right(1) + 1) % 3}Txt`), /^✗ /);
  await T.advance(4000);
  assert.equal(T.phase(1), "result");
  const recap = T.v(1, "quizRecap");
  assert.equal(recap.subject, "A");
  assert.deepEqual(recap.rounds[0].picks.map((p) => [p.nick, p.ms, p.correct]), [["B", msB, true], ["C", msC, true]]);
  assert.deepEqual(recap.rounds[1].picks.map((p) => [p.nick, p.option >= 0, p.correct]), [["B", true, false], ["C", false, false]]);
  assert.equal(T.v(2, "quizRecap.rounds[1].options.length"), 3, "a 3-choice question");
});

// Review R1 + R10 on the real template.
const QS2 = [
  { q: "A가 좋아하는 색은?", options: ["빨강", "파랑", "초록", "노랑"], answer: 1 },
  { q: "A의 MBTI는?", options: ["INFP", "ENTJ", "ISTJ"], answer: 2 },
];
const rightOf = (T, i) => {
  const rc = T.v(i, "roundContent");
  const src = QS2.find((x) => x.q === rc.q);
  return rc.options.indexOf(src.options[src.answer]);
};

test("speed-trivia R1: the subject left for good → a friend gets 시작하기 and can start their quiz", async () => {
  const T = table("speed-trivia-score", ["A", "B"]);
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2 }, clientMsgId: "pack" });
  await T.advance(100);
  assert.equal(T.tap(1, "startBtn"), false, "the subject is here: not B's to start");
  T.gone(0); // A goes to share the invite…
  await T.advance(10000);
  assert.equal(T.tap(1, "startBtn"), false, "…10 s is not gone");
  await T.advance(20100);
  assert.equal(T.prop(1, "lobbyStatus"), "A 님이 나갔어요 · 대신 시작할 수 있어요");
  assert.equal(T.tap(1, "startBtn"), true);
  await T.advance(3100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "quizInfo.about"), "A");
});

test("speed-trivia R10: a reload mid-round restores the answer the room took — no second tap", async () => {
  const T = table("speed-trivia-score", ["A", "B"]);
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2 }, clientMsgId: "pack" });
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3000 + 200);
  const first = rightOf(T, 1);
  T.tap(1, `tile${first}`);
  const ms = T.v(1, "myMs");
  T.reload(1); // B's tab reloads mid-round
  await T.advance(200);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "myAnswerRound"), T.v(1, "roundIdx"), "restored from the room");
  assert.equal(T.v(1, "myAnswer"), first);
  assert.equal(T.v(1, "myMs"), ms);
  assert.equal(T.prop(1, "statusText"), "선택 완료! 공개를 기다려요");
  T.tap(1, `tile${(first + 1) % 4}`); // a second tap does nothing
  assert.equal(T.v(1, "myAnswer"), first);
  await T.advance(9000);
  assert.match(T.prop(1, "statusText"), /^정답! ✓ /, "the restored pick gets its feedback");
});

// A device that just made a quiz for this room holds it until the room takes it (the shell's
// `packPending` = its title, quiz.ts packPending). Meanwhile its lobby / result must not offer
// the quiz the room has now — the cold default one — or the maker could start it by mistake.
test("speed-trivia: a pack still on its way → '<title> · 준비 중…', no start; the room takes it → the maker's lobby", async () => {
  const T = table("speed-trivia-score", ["A", "B"]);
  await T.advance(100);
  T.app(0).setVar("packPending", "A 맞히기"); // LiveApp: made here, not taken yet
  await T.advance(50);
  assert.equal(T.prop(0, "lobbyTitle"), "A 맞히기 · 준비 중…");
  assert.equal(T.prop(0, "waitBtn", "props.label"), "준비 중…");
  assert.equal(T.tap(0, "startBtn"), false, "the cold quiz cannot be started from the maker's device");
  await T.advance(3500);
  assert.equal(T.phase(0), "lobby");
  assert.equal(T.prop(1, "lobbyTitle"), "스피드 퀴즈", "a friend's lobby is the room's as before");
  // The pack lands; the shell clears packPending once quizInfo.packId / iAmSubject confirm it.
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2 }, clientMsgId: "pack" });
  T.app(0).setVar("packPending", "");
  await T.advance(50);
  assert.equal(T.prop(0, "lobbyTitle"), "A 맞히기 · 2문제");
  assert.equal(T.tap(0, "startBtn"), true);
  await T.advance(3100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.v(1, "quizInfo.about"), "A");
});

test("speed-trivia: 나도 만들기 from a default-quiz result — while the pack is on its way no 다시 하기", async () => {
  const T = table("speed-trivia-score", ["A", "B"]);
  T.tap(0, "startBtn"); // the cold default quiz
  await T.advance(3000 + 6 * (9000 + 3000) + 500);
  assert.equal(T.phase(1), "result");
  T.app(1).setVar("resultView", { ...T.v(1, "resultView"), next: "again" }); // the shell's view (quizResult.ts)
  T.app(1).setVar("packPending", "B 맞히기");
  await T.advance(50);
  assert.equal(T.tap(1, "againBtn"), false);
  assert.equal(T.prop(1, "nextBannerTxt"), "B 맞히기 · 준비 중…");
  await T.advance(3500);
  assert.equal(T.phase(1), "result", "the old quiz did not restart");
});
