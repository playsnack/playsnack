// Saved room results (docs/room-results.md): onResult fires on the engine running the
// room, once per game — also across a host hand-over (snapshot → restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom } from "../src/room.js";

const QS = [
  { q: "내 MBTI는?", options: ["INFP", "ESTJ"], answer: 0 },
  { q: "좋아하는 색은?", options: ["빨강", "파랑", "초록"], answer: 1 },
];
const QUIZ_START = { quiz: true, game: "quiz", rounds: 2, answerMs: 4000, revealMs: 1500 };
const QUIZ_MS = 3000 + 2 * (4000 + 1500);
const mid = (n) => `${n}`.padStart(8, "0") + "-1111-4222-8333-444455556666";

function harness({ pack = null, onResult = null } = {}) {
  let t = 1_000;
  let seq = 0;
  const timers = new Map();
  const results = [];
  const room = createRoom({
    random: () => 0.5,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    getPack: async () => pack,
    broadcast: () => {},
    send: () => {},
    onResult: onResult || ((r) => results.push(r)),
  });
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
  let msg = 0;
  const join = (n) => room.join(`p${n}`, { anonId: `a${n}`, nick: `닉${n}` });
  const leave = (n) => room.leave(`p${n}`);
  const act = (n, name, payload, id = mid(++msg)) => room.action(`p${n}`, { name, payload, clientMsgId: id });
  const phase = () => room._state.session.phase;
  return { room, results, advance, join, leave, act, phase };
}

test("a custom quiz: one result with board (raceBoard order), title / about and the quizRecap", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나 맞히기", questions: QS });
  h.act(1, "start", QUIZ_START, mid(901));
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 400 });
  h.act(3, "answer", { option: 1, ms: 400 });
  await h.advance(4000 + 1500);
  h.act(2, "answer", { option: 1, ms: 400 });
  h.leave(3); // left before the end: stays ranked, marked
  await h.advance(QUIZ_MS);
  assert.equal(h.phase(), "result");
  assert.equal(h.results.length, 1);
  const r = h.results[0];
  assert.equal(r.v, 1);
  assert.equal(r.sid, mid(901).replace(/-/g, ""));
  assert.equal(typeof r.endedAt, "number");
  assert.equal(r.title, "나 맞히기");
  assert.equal(r.about, "닉1");
  assert.deepEqual(r.board.map((b) => [b.nick, b.left === true]), [["닉2", false], ["닉3", true]]);
  assert.ok(r.board[0].score > 0 && r.board[1].score === 0);
  assert.ok(r.board.every((b) => /^p\d+$/.test(b.pid)));
  assert.equal(r.quizRecap.rounds.length, 2);
  assert.equal(r.quizRecap.subject, "닉1");
  assert.ok(!/"a\d"/.test(JSON.stringify(r)), "no anonIds in the result");
  await h.advance(20000);
  assert.equal(h.results.length, 1, "staying in the result reports nothing more");
});

test("a tap race: a board and no quiz fields", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 3000 });
  await h.advance(3000 + 100);
  h.act(2, "taps", { count: 3 });
  await h.advance(4000);
  assert.equal(h.phase(), "result");
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].quizRecap, undefined);
  assert.equal(h.results[0].title, undefined);
  assert.equal(h.results[0].board[0].nick, "닉2");
});

test("hand-over: once per game — on the new host when it took over mid-game, never again when it took over in the result", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS });
  a.act(1, "start", QUIZ_START, mid(77));
  await a.advance(3000 + 500);
  a.act(2, "answer", { option: 0, ms: 300 });
  const snap = JSON.parse(JSON.stringify(a.room.snapshot()));
  a.room.destroy();

  const b = harness();
  b.room.restore(snap, 0);
  [1, 2, 3].forEach(b.join);
  await b.advance(QUIZ_MS);
  assert.equal(b.phase(), "result");
  assert.equal(b.results.length, 1);
  assert.equal(b.results[0].sid, mid(77).replace(/-/g, ""));
  assert.equal(a.results.length, 0);

  const c = harness();
  c.room.restore(JSON.parse(JSON.stringify(b.room.snapshot())), 0);
  [1, 2, 3].forEach(c.join);
  await c.advance(20000);
  assert.equal(c.results.length, 0);
});

test("a second game in the room is a second result (new sid); a default quiz is about nobody", async () => {
  const h = harness({ pack: QS });
  [1, 2].forEach(h.join);
  for (const id of [10, 11]) {
    h.act(1, "start", QUIZ_START, mid(id));
    await h.advance(3000 + 500);
    h.act(2, "answer", { option: 0, ms: 300 });
    await h.advance(QUIZ_MS);
    assert.equal(h.phase(), "result");
  }
  assert.deepEqual(h.results.map((r) => r.sid), [mid(10), mid(11)].map((m) => m.replace(/-/g, "")));
  assert.equal(h.results[0].about, undefined);
});

test("a throwing onResult never breaks the room", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x);
  try {
    const h = harness({ onResult: () => { throw new Error("boom"); } });
    [1, 2].forEach(h.join);
    h.act(1, "start", { duration: 3000 });
    await h.advance(3000 + 100);
    h.act(2, "taps", { count: 3 });
    await h.advance(4000);
    assert.equal(h.phase(), "result");
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
  }
});
