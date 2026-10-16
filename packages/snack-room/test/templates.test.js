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
function table(id, nicks, { random = () => 0.3, clock = [], down = [], up = [], startRule } = {}) {
  let t = 0;
  // The shell's "10초 뒤 시작" (snack-player autoStart.ts): device → when the room said the game starts.
  const autoAt = new Map();
  let seq = 0;
  const timers = new Map();
  const devices = new Map(); // peerId → app
  const sent = []; // every action a device emitted: {i, name, payload, at}
  const later = (ms, fn) => {
    const h = ++seq;
    timers.set(h, { at: t + ms, fn, h });
  };
  // As the shell (snack-player spectate.ts forTemplate): its own room vars reach a template only if declared.
  const SHELL_ROOM_VARS = new Set(["iAmSpectator", "spectators", "roomMode", "hostNick", "iAmHost", "tapBatchMs"]);
  const declared = load(id).vars ?? {};
  const put = (app, k, v) => (SHELL_ROOM_VARS.has(k) && !Object.hasOwn(declared, k) ? undefined : app.setVar(k, v));
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
    startRule,
    broadcast: (type, d) => {
      if (type === "autoStart") for (const peerId of devices.keys()) autoAt.set(peerId, d.endsIn >= 0 ? t + d.endsIn : null);
      if (type !== "setVar") return;
      for (const [peerId, app] of devices) toDevice(peerId, () => put(app, d.id, d.value));
    },
    send: (peerId, type, d) => {
      const app = devices.get(peerId);
      if (!app) return;
      if (type === "autoStart") autoAt.set(peerId, d.endsIn >= 0 ? t + d.endsIn : null);
      if (type === "setVar") toDevice(peerId, () => put(app, d.id, d.value));
      if (type === "state") toDevice(peerId, () => Object.entries(d.sharedState).forEach(([k, v]) => put(app, k, v)));
    },
  });
  const boot = (i, nick) => {
    const peerId = `p${i}`;
    const app = createBite(load(id), { now: () => t + (clock[i] ?? 0), warn: (m) => assert.fail(`${nick}: ${m}`) });
    app.on("emit", (e) => {
      if (devices.get(peerId) !== app) return; // a closed tab
      sent.push({ i, name: e.name, payload: e.payload, at: t, phase: app.phase }); // what this phone sent (message counts)
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
      for (const [peerId, app] of devices) {
        if (Object.hasOwn(app.vars, "autoStartIn") && autoAt.has(peerId)) {
          const at = autoAt.get(peerId);
          const left = at == null || app.vars.sessionPhase !== "lobby" ? 0 : Math.max(0, Math.ceil((at - t) / 1000));
          if (app.vars.autoStartIn !== left) app.setVar("autoStartIn", left);
        }
        app.tick();
      }
      await flush();
    }
  };
  const app = (i) => devices.get(`p${i}`);
  // A node's text / prop as device i renders it now.
  const nodeById = (nid, n = load(id).view) => (n?.id === nid ? n : (n?.children ?? []).map((c) => nodeById(nid, c)).find(Boolean));
  const prop = (i, nid, key = "text") => app(i).value(key.split(".").reduce((o, k) => o?.[k], nodeById(nid)));
  // A new device (a new player) opens the link now.
  const late = (nick) => {
    nicks.push(nick);
    boot(nicks.length - 1, nick);
    return nicks.length - 1;
  };
  // Is node `nid` (and every ancestor) shown on device i now?
  const pathTo = (nid, n = load(id).view) => (n?.id === nid ? [n] : (n?.children ?? []).map((c) => pathTo(nid, c)).find(Boolean)?.concat(n, []) ?? null);
  const shown = (i, nid) => pathTo(nid).every((n) => n.show == null || Boolean(app(i).eval(n.show)));
  return { room, sent, advance, app, prop, shown, gone, reload, late, now: () => t, tap: (i, node) => app(i).tap(node), v: (i, name) => app(i).eval(name), phase: (i) => app(i).phase };
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
  assert.equal(T.prop(1, "statusText"), "고르고 3초 뒤 확정 · 빠를수록 점수 UP", "the rule on the first question (#211)");
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
  assert.equal(T.prop(1, "statusText"), "3초 안에 바꿀 수 있어요", "B may still change for 3 s (#211)");
  assert.ok(T.prop(1, "timerBar", "width") < 298 * 0.8, "the bar runs down");
  await T.advance(50);
  assert.match(T.prop(0, "statusText"), /친구들이 고르는 중… \(1\/2\)/, "B's tap is still on its way");
  await T.advance(250); // B's tap lands (900 ms uplink): everyone has answered
  // everyone answered: bar and seconds clear at once; the reveal waits for the change windows
  assert.equal(T.prop(0, "statusText"), "다 골랐어요! 곧 공개 (2/2)");
  assert.equal(T.prop(2, "statusText"), "3초 안에 바꿀 수 있어요", "C's own window is still open");
  for (const i of [0, 2]) {
    assert.equal(T.prop(i, "timerBar", "width"), 0, "the bar jumps empty");
    assert.equal(T.prop(i, "timerSecs"), "");
  }
  assert.equal(T.v(0, "roundAnswer"), -1, "not revealed yet");
  await T.advance(2700);
  assert.equal(T.prop(2, "statusText"), "확정! 곧 공개 (2/2)", "C's 3 s are over on its device");
  assert.equal(T.v(0, "roundAnswer"), -1, "B's window (from when the room took its pick) is still open");
  await T.advance(300 + 300 + 300); // B's window closes 3 s after its pick landed, + the 300 ms beat, + B's 300 ms downlink
  assert.ok(T.v(1, "roundAnswer") >= 0, "revealed once every change window closed — not at the end of the 8 s window");
  // reveal: B and C both right — B was faster on its own device, so B leads
  const pts = (ms) => Math.max(100, 1000 - Math.round((ms / 8000) * 800));
  const board = T.v(0, "raceBoard");
  assert.deepEqual(board, [{ nick: "B", score: pts(msB), pid: "p2" }, { nick: "C", score: pts(msC), pid: "p3" }]);
  assert.deepEqual([0, 1, 2].map((i) => T.v(i, "myPid")), ["p1", "p2", "p3"], "each device knows its own row");
  assert.match(T.prop(1, "statusText"), /^정답! ✓ /);
  assert.equal(T.prop(0, "statusText"), "정답 공개!");
  assert.match(T.prop(1, `tile${right(1)}Txt`), /^✓ /);
  // round 2: B misses, C lets the clock run out on its device
  await T.advance(1700); // reveal 1.8 s (#116) + B's downlink
  assert.equal(T.v(1, "roundNum"), 2);
  T.tap(1, `tile${(right(1) + 1) % 3}`);
  await T.advance(6000); // C never answers: the full window
  assert.equal(T.v(1, "roundAnswer"), -1, "one answerer missing → no early reveal");
  await T.advance(2000);
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

test("speed-trivia R10: a reload mid-round restores the answer the room took and the change time left (#211)", async () => {
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
  const left = T.v(1, "myLockAt - now");
  assert.ok(left > 2700 && left <= 3000, `the change time left came back with it (${left} ms)`);
  assert.equal(T.prop(1, "statusText"), "3초 안에 바꿀 수 있어요");
  await T.advance(2900);
  assert.equal(T.prop(1, "statusText"), "확정! 곧 공개 (1/1)", "1:1 — the only answerer is in and locked: the reveal beat");
  T.tap(1, `tile${(first + 1) % 4}`); // locked: a tap does nothing
  assert.equal(T.v(1, "myAnswer"), first);
  await T.advance(1000); // the reload did not reopen the round: revealed 300 ms after the lock
  assert.match(T.prop(1, "statusText"), /^정답! ✓ /, "the restored pick gets its feedback");
});

// #211: after the first pick a player may switch for 3 s ("N초 안에 바꿀 수 있어요"), then
// "확정!". The score uses the last pick's time; a switch the room refuses (past its window
// on the room's clock) puts the room's pick back on the device.
test("speed-trivia answer change (#211): switch within 3 s → the last pick scores; then 확정!; a refused switch is undone", async () => {
  const T = table("speed-trivia-score", ["A", "B", "C"]);
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2, settings: { answerMs: 8000 } }, clientMsgId: "pack" });
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(1000);
  assert.equal(T.prop(1, "cdHint"), "한 번 고르면 3초 뒤 확정돼요 · 빠를수록 점수 UP", "the rule at quiz start");
  assert.equal(T.shown(1, "cdHint"), true);
  assert.equal(T.shown(0, "cdHint"), false, "not for the subject (who only watches)");
  await T.advance(2000 + 300);
  assert.equal(T.phase(1), "play");
  const right = rightOf(T, 1);
  const wrong = (right + 1) % 4;
  await T.advance(400);
  T.tap(1, `tile${wrong}`); // B: a fast random tap…
  const ms1 = T.v(1, "myMs");
  assert.equal(T.prop(1, "statusText"), "3초 안에 바꿀 수 있어요");
  assert.equal(T.prop(1, `tile${wrong}`, "fill"), "#d9ff00", "the pick is highlighted");
  assert.equal(T.prop(1, `tile${wrong}`, "stroke.color"), "#ffffff", "…with the open-window edge");
  await T.advance(1100);
  assert.equal(T.prop(1, "statusText"), "2초 안에 바꿀 수 있어요", "the countdown runs");
  assert.equal(T.tap(1, `tile${right}`), true); // …then the right one
  const msB = T.v(1, "myMs");
  assert.equal(msB, ms1 + 1100, "timed to the last tap");
  assert.equal(T.v(1, "myAnswer"), right);
  assert.equal(T.prop(1, `tile${wrong}`, "fill"), "#1e2127", "the old pick is cleared");
  assert.equal(T.prop(1, `tile${right}`, "fill"), "#d9ff00");
  await T.advance(32);
  assert.equal(T.v(1, "myPick.option"), right, "the room took the switch");
  assert.equal(T.v(0, "quizProgress.answered"), 1, "a switch is not a second answer");
  T.tap(2, `tile${rightOf(T, 2)}`); // C answers once
  await T.advance(1900); // B's window: 3 s from its first tap
  assert.equal(T.prop(1, "statusText"), "확정! 곧 공개 (2/2)");
  assert.equal(T.prop(1, `tile${right}`, "stroke.color"), "#2a2d33", "locked: no open-window edge");
  T.tap(1, `tile${wrong}`); // locked: a tap does nothing
  assert.equal(T.v(1, "myAnswer"), right);
  await T.advance(2000); // C's window closes, then the 300 ms beat
  assert.ok(T.v(1, "roundAnswer") >= 0, "revealed after every window closed");
  assert.match(T.prop(1, "statusText"), /^정답! ✓ /);
  const pts = (ms) => Math.max(100, 1000 - Math.round((ms / 8000) * 800));
  assert.equal(T.v(0, "raceBoard").find((x) => x.nick === "B").score, pts(msB), "scored from the switch, not the first tap");
  // round 2: the device thinks its window is still open (e.g. a stalled clock) — the room refuses
  await T.advance(1800);
  assert.equal(T.v(1, "roundNum"), 2);
  const r2 = rightOf(T, 1);
  T.tap(1, `tile${r2}`);
  await T.advance(3100); // locked on the room's clock
  T.app(1).setVar("myLockAt", T.now() + 5000);
  assert.equal(T.tap(1, `tile${(r2 + 1) % 3}`), true);
  assert.equal(T.v(1, "myAnswer"), (r2 + 1) % 3, "shown at once on the device…");
  await T.advance(32);
  assert.equal(T.v(1, "myAnswer"), r2, "…then the room's pick comes back (refused: locked)");
  assert.equal(T.v(1, "myPick.n"), 2);
  assert.equal(T.room._state.session.picks[1].a1.option, r2);
});

// Early reveal on the template: "everyone answered" is read only from a quizProgress for THIS
// round of THIS game. A device that has the new round's values before its fresh quizProgress
// (setVars land one by one) must not blank the bar from the last round's 1/1.
test("speed-trivia early reveal: a stale quizProgress (last round / last game) never blanks the new round's bar", async () => {
  const T = table("speed-trivia-score", ["A", "B"]);
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2 }, clientMsgId: "pack" });
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3000 + 200);
  T.tap(1, `tile${rightOf(T, 1)}`);
  await T.advance(32);
  assert.equal(T.prop(1, "timerBar", "width"), 0, "1/1 for this round: the beat");
  const lastRound = T.v(1, "quizProgress");
  assert.equal(lastRound.round, 0);
  assert.equal(lastRound.sessionNo, T.v(1, "sessionNo"));
  await T.advance(3000 + 300 + 1800); // change window → reveal → round 2 (#116 pace)
  assert.equal(T.v(1, "roundNum"), 2);
  assert.ok(T.prop(1, "timerBar", "width") > 280, "round 2 starts with a full bar");
  for (const stale of [lastRound, { ...lastRound, round: 1, sessionNo: lastRound.sessionNo - 1 }]) {
    T.app(1).setVar("quizProgress", stale); // the new round is here, its fresh count is not
    await T.advance(16);
    assert.ok(T.prop(1, "timerBar", "width") > 250, `bar not blanked by ${JSON.stringify(stale)}`);
    assert.notEqual(T.prop(1, "timerSecs"), "");
    assert.doesNotMatch(T.prop(0, "statusText") + T.prop(1, "statusText"), /다 골랐어요/);
  }
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

// Spectators (lane S): someone who opens the link mid-game watches — banner, question and
// reveal, tiles inert — and does not hold up the early reveal; from the next start they play.
test("speed-trivia spectate: a late joiner mid-quiz sees '관전 중 · A 맞히기 n/N', the question and the reveal; tiles inert; plays the next game", async () => {
  const T = table("speed-trivia-score", ["A", "B", "C"]);
  T.room.action("p0", { name: "quizPack", payload: { title: "A 맞히기", questions: QS2, settings: { answerMs: 8000 } }, clientMsgId: "pack" });
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(1000); // countdown
  const early = T.late("E"); // joins during the countdown
  await T.advance(32);
  assert.equal(T.v(early, "iAmSpectator"), true);
  assert.equal(T.prop(early, "specBannerCTxt"), "👀 관전 중 · 다음 판부터 같이 해요");
  await T.advance(2000 + 500);
  assert.equal(T.phase(1), "play");
  const d = T.late("D"); // opens the link mid-round
  await T.advance(32);
  assert.equal(T.phase(d), "play");
  assert.equal(T.v(d, "iAmSpectator"), true);
  assert.equal(T.v(1, "iAmSpectator"), false, "players have no banner");
  assert.equal(T.prop(d, "specBannerTxt"), "👀 관전 중 · A 맞히기 1/2");
  assert.equal(T.prop(d, "qText"), T.prop(1, "qText"), "the question is shown");
  assert.equal(T.prop(d, "statusText"), "친구들이 고르는 중… (0/2)");
  assert.equal(T.prop(d, "progressText"), "", "the count is in the status line (like the subject's)");
  T.tap(d, `tile${rightOf(T, d)}`);
  await T.advance(32);
  assert.equal(T.v(d, "myAnswerRound"), -2, "tiles are inert for a spectator");
  assert.equal(T.v(1, "quizProgress.answered"), 0);
  T.tap(1, `tile${rightOf(T, 1)}`);
  T.tap(2, `tile${rightOf(T, 2)}`);
  await T.advance(32);
  assert.equal(T.prop(d, "statusText"), "다 골랐어요! 곧 공개 (2/2)", "two spectators do not hold up the early reveal");
  await T.advance(3000 + 600);
  assert.ok(T.v(d, "roundAnswer") >= 0);
  assert.equal(T.prop(d, "statusText"), "정답 공개!");
  assert.match(T.prop(d, `tile${rightOf(T, d)}Txt`), /^✓ /, "the reveal is shown");
  assert.deepEqual(T.v(d, "raceBoard").map((x) => x.nick), ["B", "C"]);
  await T.advance(3000 + 9000 + 3000 + 500);
  assert.equal(T.phase(d), "result", "the result like everyone else");
  assert.ok(T.v(d, "quizRecap").rounds.every((r) => r.picks.every((p) => p.nick !== "D" && p.nick !== "E")));
  // the next game: D plays
  T.room.action("p0", { name: "start", payload: { game: "trivia", quiz: true }, clientMsgId: "again" });
  await T.advance(3000 + 300);
  assert.equal(T.phase(d), "play");
  assert.equal(T.v(d, "iAmSpectator"), false);
  T.tap(d, `tile${rightOf(T, d)}`);
  await T.advance(32);
  assert.equal(T.v(d, "myAnswerRound"), 0);
  assert.equal(T.v(1, "quizProgress.answered"), 1);
  assert.equal(T.v(1, "quizProgress.of"), 4);
});

// 다같이 300번 클릭 (#125): lobby → 시작하기 → 3·2·1 → everyone's taps add up to 300 →
// result (time taken, top tappers) → 다시 하기; a late joiner watches.
// Each listed device taps once per round, `every` ms apart (10/s each: under the 15/s cap).
async function tapRounds(T, who, rounds, every = 100) {
  for (let k = 0; k < rounds; k++) {
    for (const i of who) T.tap(i, "tapArea");
    await T.advance(every);
  }
}

test("coop-click: a lobby first — nothing counts until someone presses 시작하기", async () => {
  const T = table("coop-click", ["A", "B"]);
  await T.advance(100);
  assert.equal(T.phase(0), "lobby");
  assert.equal(T.prop(0, "lobbyCount"), "참가자 2명");
  assert.equal(T.prop(1, "lobbyNames"), "A · B");
  T.tap(1, "tapArea"); // the pad is not on screen in the lobby
  await T.advance(500);
  assert.equal(T.v(1, "myTaps"), 0);
  assert.equal(T.v(0, "coopTotal"), 0);
});

test("coop-click: 3 players → 3·2·1 → taps add up to 300 → result with time and top tappers → 다시 하기", async () => {
  const T = table("coop-click", ["A", "B", "C"]);
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(100);
  assert.equal(T.phase(2), "countdown");
  assert.equal(T.prop(2, "cdNum"), "3");
  await T.advance(3000);
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "play", `device ${i}`);
  // A taps every round, B 2 of 3, C 1 of 3 → A 60, B 40, C 20 per 60 rounds = 120 per 60 rounds.
  for (let k = 0; k < 150 && T.phase(0) === "play"; k++) {
    T.tap(0, "tapArea");
    if (k % 3 !== 2) T.tap(1, "tapArea");
    if (k % 3 === 0) T.tap(2, "tapArea");
    await T.advance(100);
  }
  await T.advance(600); // last batch + the result
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "result", `device ${i}`);
  const total = T.v(0, "coopTotal");
  assert.ok(total >= 300, `total ${total}`);
  const ms = T.v(0, "coopTimeMs");
  assert.ok(ms > 10000 && ms < 20000, `took ${ms} ms`); // ~150 rounds of 100 ms, ended early (not the 60 s cap)
  assert.equal(T.prop(1, "resTitle"), `${(ms / 1000).toFixed(1)}초 만에 300 달성!`);
  assert.equal(T.prop(1, "resSub"), "300 / 300 · 3명이 함께");
  const board = rows(T.v(1, "raceBoard"));
  assert.deepEqual(board.map((r) => r.nick), ["A", "B", "C"]);
  assert.equal(board.reduce((s, r) => s + r.score, 0), total, "total = sum of everyone's taps");
  for (const i of [0, 1, 2]) assert.equal(board.find((r) => r.nick === "ABC"[i]).score, T.v(i, "myTaps"), `board == 내 탭 for ${"ABC"[i]}`);
  assert.equal(T.prop(0, "rnick0"), "A");
  assert.equal(T.prop(0, "resMine"), `내가 보탠 탭 ${T.v(0, "myTaps")}회`);
  // 다시 하기 from another device: a fresh count for everyone
  T.tap(2, "againBtn");
  await T.advance(3100);
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "play", `again device ${i}`);
  assert.equal(T.v(0, "coopTotal"), 0);
  assert.equal(T.v(0, "coopTimeMs"), 0);
  assert.equal(T.v(1, "myTaps"), 0);
  assert.equal(T.prop(1, "goalNum"), "0");
});

test("coop-click: time runs out short of 300 → '아쉽다', the board still shows who tapped", async () => {
  const T = table("coop-click", ["A", "B"]);
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3100);
  await tapRounds(T, [0, 1], 20); // 40 taps in 2 s
  await T.advance(300); // the last batches land
  assert.equal(T.prop(0, "goalNum"), "40");
  await T.advance(60000);
  assert.equal(T.phase(0), "result");
  assert.equal(T.v(0, "coopTimeMs"), 0);
  assert.equal(T.v(0, "coopTotal"), 40);
  assert.equal(T.prop(1, "resTitle"), "아쉽다! 60초 안에 못 채웠어요");
  assert.deepEqual(rows(T.v(0, "raceBoard")), [{ nick: "A", score: 20 }, { nick: "B", score: 20 }]);
});

test("coop-click: a late joiner mid-game spectates — pad inert, taps not counted — and plays the next game", async () => {
  const T = table("coop-click", ["A", "B"]);
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3100);
  await tapRounds(T, [0, 1], 10);
  const c = T.late("C");
  await T.advance(100);
  assert.equal(T.phase(c), "play");
  assert.equal(T.v(c, "iAmSpectator"), true);
  assert.equal(T.prop(c, "navP", "props.subtitle"), "관전 중 · 다음 판부터 같이 해요");
  assert.equal(T.prop(0, "navP", "props.subtitle"), "다 같이 연타! · 구경 1명");
  const before = T.v(0, "coopTotal");
  await tapRounds(T, [c], 10);
  assert.equal(T.v(c, "myTaps"), 0);
  assert.equal(T.v(0, "coopTotal"), before);
  assert.equal(T.prop(c, "goalNum"), String(before), "the spectator sees the shared count");
  await T.advance(60000);
  assert.equal(T.phase(c), "result");
  assert.ok(!rows(T.v(c, "raceBoard")).some((r) => r.nick === "C"));
  T.tap(c, "againBtn"); // the spectator may start the next one and plays it
  await T.advance(3100);
  assert.equal(T.v(c, "iAmSpectator"), false);
  await tapRounds(T, [c], 5);
  await T.advance(300);
  assert.equal(T.v(0, "coopTotal"), 5);
  assert.deepEqual(rows(T.v(0, "raceBoard")), [{ nick: "C", score: 5 }]);
});

// ── 방장 · 자동 시작 (#135 / #136): what each device shows and may tap ──

test("tap-battle friends room (host): the host has 시작하기; a friend sees '방장이 시작하길 기다리는 중' and cannot start; 다시 하기 likewise", async () => {
  const T = table("tap-battle", ["A", "B"], { startRule: "host" });
  await T.advance(100);
  assert.equal(T.v(0, "iAmHost"), true);
  assert.equal(T.v(1, "iAmHost"), false);
  assert.equal(T.prop(1, "startWaitMain"), "방장이 시작하길 기다리는 중");
  assert.equal(T.prop(1, "startWaitSub"), "방장 · A");
  assert.equal(T.prop(1, "lobbyHint"), "다 모이면 방장이 시작해요 · 3·2·1 후 10초 연타!");
  assert.equal(T.tap(1, "startBtn"), false, "no start button for a friend");
  await T.advance(500);
  assert.equal(T.phase(1), "lobby");
  assert.equal(T.tap(0, "startBtn"), true);
  await T.advance(3200);
  assert.equal(T.phase(1), "play");
  await T.advance(11000);
  assert.equal(T.phase(1), "result");
  assert.equal(T.tap(1, "againBtn"), false);
  assert.equal(T.prop(1, "againWaitMain"), "방장이 다시 시작하길 기다리는 중");
  assert.equal(T.tap(0, "againBtn"), true);
  await T.advance(3200);
  assert.equal(T.phase(1), "play");
});

// #141: device i stays in a lobby with no countdown the whole time (checked every second — a game
// that started and ended in between would show), not just at the end.
async function waitsAlone(T, i, ms) {
  for (let left = ms; left > 0; left -= 1000) {
    await T.advance(Math.min(1000, left));
    assert.equal(T.phase(i), "lobby", `still the lobby (${ms - left + Math.min(1000, left)} ms)`);
    assert.equal(T.v(i, "autoStartIn"), 0, "no countdown");
  }
}

test("tap-battle public room (auto): no start button — '10초 뒤 시작 · 2명' counts down and the game starts by itself", async () => {
  const doc = load("tap-battle");
  const T = table("tap-battle", ["A", "B"], { startRule: "auto" });
  T.room.configureAuto(doc.room.start, doc.room.autoStartMs); // as the edge room does from the first hello
  await T.advance(100);
  assert.equal(T.v(0, "roomMode"), "auto");
  assert.equal(T.prop(0, "startWaitMain"), "10초 뒤 시작 · 2명");
  assert.equal(T.tap(0, "startBtn"), false);
  await T.advance(4000);
  assert.equal(T.prop(1, "startWaitMain"), "6초 뒤 시작 · 2명");
  await T.advance(6000 + 3200);
  assert.equal(T.phase(0), "play");
  assert.equal(T.phase(1), "play");
  // both play (so the room re-arms after the result — #136 "someone played")
  for (let k = 0; k < 10; k++) {
    T.tap(0, "tapArea");
    T.tap(1, "tapArea");
    await T.advance(100);
  }
  await T.advance(10000);
  assert.equal(T.phase(0), "result");
  assert.ok(T.room._state.session.acted.size >= 2, "someone played this game");
  assert.equal(T.tap(0, "againBtn"), false);
  assert.equal(T.prop(0, "againWaitMain"), "잠시 뒤 다음 판이 자동으로 시작돼요");
  // #141: B leaves at the result — A alone: the next game waits for a second person
  T.gone(1);
  await T.advance(200);
  assert.equal(T.prop(0, "againWaitMain"), "한 명 더 오면 다음 판을 시작해요");
  assert.equal(T.prop(0, "againWaitSub"), "링크를 친구에게 보내도 돼요");
  await T.advance(8000); // RESULT_HOLD_MS: back to the lobby — which does not count down alone
  await waitsAlone(T, 0, 30000);
  assert.equal(T.prop(0, "startWaitMain"), "한 명 더 오면 시작해요");
  assert.equal(T.shown(0, "startBtn"), false);
  const c = T.late("C");
  await T.advance(100);
  assert.equal(T.prop(c, "startWaitMain"), "10초 뒤 시작 · 2명");
  assert.equal(T.prop(0, "startWaitMain"), "10초 뒤 시작 · 2명");
});

// #141: every public-room template — one person alone sees "한 명 더 오면 시작해요" (no start button,
// nothing starts), the second person's arrival shows "10초 뒤 시작 · 2명", one leaving goes back to waiting.
for (const id of ["balance-game-vote", "coop-click", "coop-tap-goal", "majority-guess", "most-likely-roster-vote", "nunchi-tap", "reaction-duel-score", "tap-battle", "worldcup-group-vote"]) {
  test(`${id} public room (auto, #141): alone → '한 명 더 오면 시작해요'; 2nd person → '10초 뒤 시작 · 2명'; one leaves → waiting again`, async () => {
    const doc = load(id);
    const T = table(id, ["A"], { startRule: "auto" });
    T.room.configureAuto(doc.room.start, doc.room.autoStartMs);
    await T.advance(100);
    assert.equal(T.prop(0, "startWaitMain"), "한 명 더 오면 시작해요");
    assert.equal(T.prop(0, "startWaitSub"), "링크를 친구에게 보내도 돼요");
    assert.equal(T.shown(0, "startWait"), true);
    assert.equal(T.shown(0, "startBtn"), false);
    assert.equal(T.tap(0, "startBtn"), false);
    await waitsAlone(T, 0, 30000); // alone: never starts
    const b = T.late("B");
    await T.advance(100);
    for (const i of [0, b]) {
      assert.equal(T.prop(i, "startWaitMain"), "10초 뒤 시작 · 2명");
      assert.equal(T.prop(i, "startWaitSub"), "지금 들어온 사람 모두 같이 시작해요");
      assert.equal(T.shown(i, "startBtn"), false);
    }
    await T.advance(3000);
    assert.equal(T.v(0, "autoStartIn"), 7, "counting down");
    T.gone(b);
    await T.advance(20);
    assert.equal(T.v(0, "autoStartIn"), 0, "the room stopped the countdown (autoStart endsIn −1)");
    assert.equal(T.prop(0, "startWaitMain"), "한 명 더 오면 시작해요", "cancelled: waiting again");
    await waitsAlone(T, 0, 30000);
  });
}

test("speed-trivia friends room (host, default quiz): only the host starts; a friend's lobby says the host is to start", async () => {
  const T = table("speed-trivia-score", ["A", "B"], { startRule: "host" });
  await T.advance(100);
  assert.equal(T.prop(1, "waitBtn", "props.label"), "방장이 시작하길 기다리는 중");
  assert.equal(T.tap(1, "startBtn"), false);
  await T.advance(500);
  assert.equal(T.phase(1), "lobby");
  assert.equal(T.tap(0, "startBtn"), true);
  await T.advance(3200);
  assert.equal(T.phase(1), "play");
});

test("speed-trivia friends room (host) + 나 맞히기: the subject (not the host) starts their quiz — the existing rule", async () => {
  const T = table("speed-trivia-score", ["A", "B", "C"], { startRule: "host" });
  await T.advance(100);
  T.room.action("p1", { name: "quizPack", payload: { title: "B 퀴즈", about: "B", questions: [{ q: "q1", options: ["x", "y"], answer: 0 }] }, clientMsgId: "pack-b-1" });
  await T.advance(200);
  assert.equal(T.v(1, "iAmSubject"), true);
  assert.equal(T.tap(0, "startBtn"), false, "the host is not this quiz's subject");
  assert.equal(T.tap(1, "startBtn"), true, "the subject starts it");
  await T.advance(3200);
  assert.equal(T.phase(2), "play");
});

test("speed-trivia public room (auto): alone it waits; with two the lobby counts down and the quiz starts by itself", async () => {
  const doc = load("speed-trivia-score");
  const T = table("speed-trivia-score", ["A"], { startRule: "auto" });
  T.room.configureAuto(doc.room.start, doc.room.autoStartMs);
  await T.advance(100);
  assert.equal(T.prop(0, "waitBtn", "props.label"), "한 명 더 오면 시작해요", "alone (#141): waits for a second person");
  assert.equal(T.tap(0, "startBtn"), false);
  await T.advance(30000);
  assert.equal(T.phase(0), "lobby");
  const b = T.late("B");
  await T.advance(100);
  assert.equal(T.prop(0, "waitBtn", "props.label"), "10초 뒤 시작 · 2명");
  assert.equal(T.prop(b, "waitBtn", "props.label"), "10초 뒤 시작 · 2명");
  assert.equal(T.tap(0, "startBtn"), false);
  await T.advance(10000 + 3200);
  assert.equal(T.phase(0), "play");
  assert.equal(T.phase(b), "play");
});

// 밸런스게임 (#126): picks stay hidden until everyone here picked (or the timer) — then all at once.
test("balance-game: no peeking — pick count + only my own pick marked; all picked → split + names on every device", async () => {
  const T = table("balance-game-vote", ["A", "B", "C"]);
  T.tap(0, "startBtn");
  await T.advance(3000 + 100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.prop(1, "pickProgress"), "0/3명 선택 · 시간 끝나면 공개");
  T.tap(0, "cardA"); // A picks
  await T.advance(200);
  assert.equal(T.prop(1, "pickProgress"), "1/3명 선택 · 시간 끝나면 공개", "B sees only the count");
  assert.equal(T.shown(1, "cardAPct"), false, "no % before the reveal");
  assert.equal(T.shown(1, "cardANames"), false);
  assert.equal(T.shown(1, "cardAMine"), false, "A's pick is not marked on B's phone");
  assert.deepEqual(T.v(1, "votesByOption"), { o0: 0, o1: 0 }, "B's device never got a running tally");
  assert.equal(T.shown(0, "cardAMine"), true, "A sees ✓ 내 선택 on A");
  assert.match(T.prop(0, "cardA", "stroke.color"), /#d9ff00/i);
  assert.match(T.prop(1, "cardA", "stroke.color"), /#16181c/i);
  T.tap(1, "cardB");
  T.tap(2, "cardB");
  await T.advance(100);
  assert.equal(T.prop(2, "pickProgress"), "다 골랐어요! 곧 공개 (3/3)");
  await T.advance(300);
  for (const i of [0, 1, 2]) {
    assert.equal(T.prop(i, "pickProgress"), "결과 공개 🎉");
    assert.equal(T.shown(i, "cardAPct"), true);
    assert.equal(T.prop(i, "cardAPct"), "33%");
    assert.equal(T.prop(i, "cardBPct"), "67%");
    assert.equal(T.prop(i, "cardANames"), "A");
    assert.equal(T.prop(i, "cardBNames"), "B · C");
  }
  assert.match(T.prop(0, "cardA", "stroke.color"), /#d9ff00/i, "my pick stays marked after the reveal");
  T.tap(1, "cardA"); // too late: a revealed round can't be changed
  await T.advance(50);
  assert.equal(T.v(1, "myVote"), "o1");
  assert.equal(T.prop(1, "cardBNames"), "B · C");
  await T.advance(3500); // revealMs → round 2: back to hidden, nothing marked
  assert.equal(T.v(1, "roundNum"), 2);
  assert.equal(T.shown(1, "cardAPct"), false);
  assert.equal(T.shown(0, "cardAMine"), false);
  assert.equal(T.prop(0, "pickProgress"), "0/3명 선택 · 시간 끝나면 공개");
});

test("balance-game: a reload mid-round shows my pick again; someone who never picks → the timer reveals", async () => {
  const T = table("balance-game-vote", ["A", "B"]);
  T.tap(0, "startBtn");
  await T.advance(3000 + 100);
  T.tap(1, "cardB");
  await T.advance(100);
  T.reload(1);
  await T.advance(100);
  assert.equal(T.phase(1), "play");
  assert.equal(T.shown(1, "cardBMine"), true, "the room gave my pick back");
  assert.equal(T.prop(1, "pickProgress"), "1/2명 선택 · 시간 끝나면 공개");
  assert.equal(T.shown(0, "cardBMine"), false);
  await T.advance(10000 - 300);
  assert.equal(T.prop(0, "pickProgress"), "결과 공개 🎉", "A never picked: revealed when the 10 s ran out");
  assert.equal(T.prop(0, "cardBPct"), "100%");
  assert.equal(T.prop(0, "cardANames"), "아무도 없어요");
});

test("balance-game: visible server countdown survives reload and clock skew, then resets for the next round", async () => {
  const T = table("balance-game-vote", ["A", "B"], { clock: [3600000, -60000] });
  T.tap(0, "startBtn");
  await T.advance(3100);
  assert.equal(T.prop(0, "voteTimerSecs"), "10초");
  assert.equal(T.prop(1, "voteTimerSecs"), "10초");
  const full = T.prop(0, "voteTimerBar", "width");
  await T.advance(4200);
  assert.equal(T.prop(0, "voteTimerSecs"), "6초");
  assert.ok(T.prop(0, "voteTimerBar", "width") < full);
  T.reload(1);
  await T.advance(100);
  assert.equal(T.prop(1, "voteTimerSecs"), "6초", "a reload gets time left, not another 10 seconds");
  assert.ok(Math.abs(T.prop(1, "voteTimerBar", "width") - T.prop(0, "voteTimerBar", "width")) <= 1);
  await T.advance(5600);
  assert.equal(T.prop(0, "voteTimerSecs"), "공개", "nobody picked: the round still ends");
  assert.equal(T.prop(1, "voteTimerSecs"), "공개");
  assert.equal(T.prop(0, "voteTimerBar", "width"), 0);
  await T.advance(3600);
  assert.equal(T.v(0, "roundNum"), 2);
  assert.equal(T.prop(0, "voteTimerSecs"), "10초");
  T.tap(0, "cardA");
  T.tap(1, "cardB");
  await T.advance(16);
  assert.equal(T.prop(0, "voteTimerSecs"), "곧 공개");
  assert.equal(T.prop(0, "voteTimerBar", "width"), 0, "early reveal does not show a misleading full timer");
  await T.advance(300);
  assert.equal(T.prop(0, "voteTimerSecs"), "공개");
});

// Tap batching (#190 / #179): every message a phone sends is one Durable Object request on the
// edge (docs/edge-rooms.md §6), so timed tap games send their taps in batches of `tapBatchMs`
// (250 ms; the room makes it 1 s for more than 20 players) plus the rest once at the end.
// Each device in `who` taps on its own pattern every `every` ms while ITS screen is in play.
async function tapWhilePlaying(T, who, every = 80, pattern = () => true) {
  for (let k = 0; ; k++) {
    let any = false;
    for (const i of who) {
      if (T.phase(i) !== "play") continue;
      any = true;
      if (pattern(i, k)) T.tap(i, "tapArea");
    }
    if (!any) return;
    await T.advance(every);
  }
}
const sentBy = (T, i, name) => T.sent.filter((e) => e.i === i && e.name === name);

test("coop-tap-goal (#190): tallies go out in batches — ≤ 4 msgs/s per phone, instant gauge, total = sum of taps, the last taps counted", async () => {
  const T = table("coop-tap-goal", ["A", "B", "C"], { up: [40, 90, 150], down: [30, 60, 120] });
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3300);
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "play", `device ${i}`);
  assert.equal(T.v(0, "tapBatchMs"), 250, "a small room: 250 ms");
  assert.equal(T.room._state.vars.has("tapBatchMs"), false, "…and the room never sends it (feel unchanged)");
  assert.equal(T.prop(1, "goalNum"), "0 / 150");
  T.tap(1, "tapArea");
  assert.equal(T.prop(1, "goalNum"), "1 / 150", "the gauge moves on the tap itself, before any message");
  assert.equal(sentBy(T, 1, "tally").length, 0, "…and nothing was sent for it yet");
  const playFrom = T.now();
  // 12.5 taps/s for A, 2 of 3 rounds for B, every other round for C — until each one's screen leaves play
  await tapWhilePlaying(T, [0, 1, 2], 80, (i, k) => i === 0 || (i === 1 ? k % 3 !== 2 : k % 2 === 0));
  const playMs = T.now() - playFrom;
  await T.advance(2000); // the last batches land
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "result", `device ${i}`);
  const mine = [0, 1, 2].map((i) => T.v(i, "myTaps"));
  const total = mine.reduce((a, b) => a + b, 0);
  assert.ok(mine[0] > 150, `A tapped ${mine[0]}`);
  for (const i of [0, 1, 2]) {
    const tallies = sentBy(T, i, "tally");
    assert.equal(tallies.reduce((s, e) => s + Number(e.payload.delta), 0), mine[i], `device ${i}: deltas add up to its taps`);
    const inPlay = tallies.filter((e) => e.phase === "play").length;
    assert.ok(inPlay <= Math.ceil(playMs / 250) + 1, `device ${i}: ${inPlay} tallies in ${playMs} ms of play (≤ 4/s)`);
    assert.ok(inPlay < mine[i], `device ${i}: fewer messages (${inPlay}) than taps (${mine[i]})`);
    assert.ok(tallies.filter((e) => e.phase === "result").length <= 1, `device ${i}: the rest goes at most once, as play ends`);
    assert.equal(T.v(i, "coopTotal"), total, `device ${i}: the room's total = every tap`);
  }
  assert.ok(T.sent.some((e) => e.name === "tally" && e.phase === "result"), "a phone tapping to the end sends its rest in the result — and it is counted");
  assert.equal(T.room._state.coop, total);
  assert.equal(T.prop(2, "resSub"), `${total} / 150 탭`);
  assert.equal(T.prop(2, "resTitle"), "성공! 다 같이 해냈어요");
  assert.equal(T.prop(0, "resMine"), `내가 보탠 탭 ${mine[0]}회`);
  // 다시 하기: a fresh count — nothing of the last game is sent again
  const before = T.sent.length;
  T.tap(0, "againBtn");
  await T.advance(3300);
  for (const i of [0, 1, 2]) assert.equal(T.phase(i), "play", `again device ${i}`);
  assert.equal(T.prop(1, "goalNum"), "0 / 150");
  assert.deepEqual(T.sent.slice(before).map((e) => e.name), ["start"]);
});

test("coop-tap-goal (#190): a spectator's taps are not counted, and its gauge settles back to the room's total", async () => {
  const T = table("coop-tap-goal", ["A", "B"]);
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3300);
  for (let k = 0; k < 10; k++) {
    T.tap(0, "tapArea"); // A: 10 taps, then the game runs on
    await T.advance(100);
  }
  const c = T.late("C"); // joins mid-game → watches this one
  await T.advance(100);
  for (let k = 0; k < 5; k++) {
    T.tap(c, "tapArea");
    await T.advance(100);
  }
  const shownCount = () => T.prop(c, "goalNum").split(" / ")[0]; // the goal is the template's (it counts the roster)
  assert.equal(shownCount(), "15", "its own taps show at once…");
  await T.advance(2500);
  assert.equal(shownCount(), "10", "…and settle back to what the room counted");
  assert.equal(T.v(0, "coopTotal"), 10);
});

test("big room (#179): 25 phones → tapBatchMs 1 s for tap-battle, coop-click and coop-tap-goal — every tap still counted", async () => {
  const nicks = () => Array.from({ length: 25 }, (_, i) => `P${i}`);
  for (const id of ["tap-battle", "coop-click", "coop-tap-goal"]) {
    // a slow park network: 400 ms up — the final batch still lands inside LATE_GRACE_MS
    const T = table(id, nicks(), { up: Array(25).fill(400), down: Array(25).fill(100) });
    await T.advance(100);
    T.tap(0, "startBtn"); // reaches the room 400 ms later
    await T.advance(1600);
    assert.equal(T.phase(5), "countdown", `${id}: the 3·2·1 as before`);
    assert.equal(T.v(5, "tapBatchMs"), 1000, `${id}: the room set 1 s during the countdown`);
    await T.advance(1900);
    assert.equal(T.phase(5), "countdown", `${id}: still 3·2·1 just before 3 s`);
    await T.advance(200);
    assert.equal(T.phase(5), "play", `${id}: play 3 s after the start, as before`);
    const playFrom = T.now();
    const who = Array.from({ length: 25 }, (_, i) => i);
    await tapWhilePlaying(T, who, 100, (i, k) => (i + k) % 3 !== 0); // ~6.7 taps/s each
    const playMs = T.now() - playFrom;
    await T.advance(2000);
    const name = id === "coop-tap-goal" ? "tally" : "taps";
    let sum = 0;
    for (const i of who) {
      assert.equal(T.phase(i), "result", `${id} device ${i}`);
      const inPlay = sentBy(T, i, name).filter((e) => e.phase === "play").length;
      assert.ok(inPlay <= Math.ceil(playMs / 1000) + 1, `${id} device ${i}: ${inPlay} messages in ${playMs} ms (≤ 1/s)`);
      sum += T.v(i, "myTaps");
    }
    if (id === "coop-tap-goal") {
      assert.equal(T.v(3, "coopTotal"), sum, `${id}: the room's total = every tap`);
    } else {
      // the board shows the top 8; the room's scores hold everyone
      for (const i of who) assert.equal(T.room._state.scores.get(`a${i}`), T.v(i, "myTaps"), `${id}: the room's count == 내 탭 for P${i}`);
      for (const r of rows(T.v(3, "raceBoard"))) assert.equal(r.score, T.v(Number(r.nick.slice(1)), "myTaps"), `${id}: board row ${r.nick}`);
      if (id === "coop-click") assert.equal(T.v(3, "coopTotal"), sum, `${id}: total = sum of everyone's taps`);
    }
  }
});

test("tapBatchMs (#179): 20 players keep 250 ms; 21 get 1 s; a room that shrank goes back to 250 at the next game", async () => {
  const T = table("tap-battle", Array.from({ length: 21 }, (_, i) => `P${i}`));
  await T.advance(100);
  T.tap(0, "startBtn");
  await T.advance(3300);
  assert.equal(T.v(0, "tapBatchMs"), 1000, "21 players → 1 s");
  await T.advance(12000);
  T.gone(20); // 20 left
  T.tap(0, "againBtn");
  await T.advance(3300);
  assert.equal(T.phase(0), "play");
  assert.equal(T.v(0, "tapBatchMs"), 250, "20 players → back to 250 ms");
  assert.equal(T.v(7, "tapBatchMs"), 250);
});
