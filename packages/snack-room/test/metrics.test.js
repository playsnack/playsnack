// Free-beta metrics hooks (docs/telemetry.md §9.5): onSessionStart / onSessionEnd /
// onGameCreated fire on the engine running the room, once per game / pack — also
// across a host hand-over (snapshot → restore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom } from "../src/room.js";

const QS = [
  { q: "내 MBTI는?", options: ["INFP", "ESTJ"], answer: 0 },
  { q: "좋아하는 색은?", options: ["빨강", "파랑", "초록"], answer: 1 },
];
const QUIZ_START = { quiz: true, game: "quiz", rounds: 2, answerMs: 4000, revealMs: 1500 };
const QUIZ_MS = 3000 + 2 * (4000 + 1500); // countdown + 2 rounds (answer + reveal)
const mid = (n) => `${n}`.padStart(8, "0") + "-1111-4222-8333-444455556666"; // a crypto.randomUUID()-like id

function harness({ pack = null } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const ev = { start: [], end: [], created: [] };
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
    onSessionStart: (e) => ev.start.push(e),
    onSessionEnd: (e) => ev.end.push(e),
    onGameCreated: (e) => ev.created.push(e),
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
  const act = (n, name, payload, id = mid(++msg)) => room.action(`p${n}`, { name, payload, clientMsgId: id });
  const phase = () => room._state.session.phase;
  return { room, ev, advance, join, act, phase };
}

test("a custom quiz: game_created (editor), one session_done with p / about / ans, no rematch on the first game", async () => {
  const h = harness();
  [1, 2, 3].forEach(h.join);
  h.act(1, "quizPack", { title: "나", questions: QS }, mid(900));
  assert.deepEqual(h.ev.created, [{ gid: mid(900).replace(/-/g, ""), source: "editor" }]);
  h.act(1, "start", QUIZ_START, mid(901));
  await h.advance(0);
  assert.deepEqual(h.ev.start, [{ sid: mid(901).replace(/-/g, ""), players: 3, again: false }]);
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 400 }); // player 3 never answers
  h.join(4); // a late joiner who never acts is not counted
  await h.advance(QUIZ_MS);
  assert.equal(h.phase(), "result");
  assert.deepEqual(h.ev.end, [{ sid: mid(901).replace(/-/g, ""), players: 2, quiz: true, about: true, answerers: 1 }]);
  await h.advance(10000); // staying in the result reports nothing more
  assert.equal(h.ev.end.length, 1);
});

test("a default quiz: about false, the subject is nobody; a tap race carries no quiz fields", async () => {
  const q = harness({ pack: QS });
  [1, 2].forEach(q.join);
  q.act(1, "start", QUIZ_START);
  await q.advance(3000 + 500);
  q.act(1, "answer", { option: 0, ms: 300 });
  q.act(2, "answer", { option: 1, ms: 300 });
  await q.advance(QUIZ_MS);
  assert.equal(q.ev.end.length, 1);
  assert.deepEqual({ ...q.ev.end[0], sid: "" }, { sid: "", players: 2, quiz: true, about: false, answerers: 2 });

  const r = harness();
  [1, 2, 3].forEach(r.join);
  r.act(1, "start", { duration: 5000 });
  await r.advance(3000 + 100);
  r.act(1, "taps", { count: 4 });
  r.act(3, "taps", { count: 2 });
  await r.advance(6000);
  assert.equal(r.phase(), "result");
  assert.deepEqual({ ...r.ev.end[0], sid: "" }, { sid: "", players: 2, quiz: false });
});

test("rematch: the second start in the room is `again`; a game ended by 'lobby' is no session_done", async () => {
  const h = harness();
  [1, 2].forEach(h.join);
  h.act(1, "start", { duration: 3000 });
  await h.advance(1000);
  h.act(1, "lobby"); // abandoned before the result
  assert.equal(h.ev.end.length, 0);
  h.act(1, "start", { duration: 3000 });
  await h.advance(3000 + 100);
  h.act(2, "taps", { count: 1 });
  await h.advance(4000);
  assert.equal(h.ev.end.length, 1);
  h.act(2, "start", { duration: 3000 });
  await h.advance(0);
  assert.deepEqual(h.ev.start.map((e) => e.again), [false, false, true]);
  assert.equal(h.ev.start[2].players, 2);
  assert.notEqual(h.ev.start[2].sid, h.ev.start[1].sid);
});

test("hand-over: session_done fires once — on the new host when it took over mid-game, never again when it took over in the result", async () => {
  const a = harness();
  [1, 2, 3].forEach(a.join);
  a.act(1, "quizPack", { title: "나", questions: QS });
  a.act(1, "start", QUIZ_START, mid(77));
  await a.advance(3000 + 500);
  a.act(2, "answer", { option: 0, ms: 300 });
  const mid1 = JSON.parse(JSON.stringify(a.room.snapshot())); // over the wire
  a.room.destroy(); // the old host vanishes mid-game

  const b = harness();
  b.room.restore(mid1, 0);
  [1, 2, 3].forEach(b.join);
  assert.equal(b.ev.start.length, 0, "a restored game does not start again");
  await b.advance(QUIZ_MS);
  assert.equal(b.phase(), "result");
  assert.equal(b.ev.end.length, 1);
  assert.deepEqual(b.ev.end[0], { sid: mid(77).replace(/-/g, ""), players: 2, quiz: true, about: true, answerers: 1 });
  assert.equal(a.ev.end.length, 0);

  // A third host takes over from a snapshot taken in the result: nothing more.
  const c = harness();
  c.room.restore(JSON.parse(JSON.stringify(b.room.snapshot())), 0);
  [1, 2, 3].forEach(c.join);
  await c.advance(20000);
  assert.equal(c.ev.end.length, 0);
  assert.equal(c.room._state.session.done, 1);
});

test("hand-over race: a host that replays the same start reports the same sid (the server keeps one)", async () => {
  const run = async () => {
    const h = harness();
    [1, 2].forEach(h.join);
    h.act(1, "start", { duration: 3000 }, mid(5));
    await h.advance(3000 + 100);
    h.act(2, "taps", { count: 1 });
    await h.advance(4000);
    return h.ev.end[0].sid;
  };
  const s1 = await run();
  assert.equal(await run(), s1);
  assert.match(s1, /^[A-Za-z0-9_-]{16,32}$/);
});

test("game_created: remake = a pack from the result by someone other than the finished game's subject; the subject's own is editor", async () => {
  const played = async () => {
    const h = harness();
    [1, 2, 3].forEach(h.join);
    h.act(1, "quizPack", { title: "1", questions: QS });
    h.act(1, "start", QUIZ_START);
    await h.advance(3000 + 500);
    h.act(2, "answer", { option: 0, ms: 300 });
    await h.advance(QUIZ_MS);
    assert.equal(h.phase(), "result");
    return h;
  };
  const p = await played();
  p.act(3, "quizPack", { title: "x", questions: [] }); // refused: not playable → not counted
  p.act(2, "quizPack", { title: "2", questions: QS }); // a participant makes one: 참가자→개설
  p.act(3, "quizPack", { title: "3", questions: QS }); // refused (pack_waiting): not counted
  assert.deepEqual(p.ev.created.map((e) => e.source), ["editor", "remake"]);
  const s = await played();
  s.act(1, "quizPack", { title: "1 again", questions: QS }); // the subject edits their own quiz
  assert.deepEqual(s.ev.created.map((e) => e.source), ["editor", "editor"]);
});

test("game_created after a default quiz: anyone's pack is a remake (there was no subject)", async () => {
  const h = harness({ pack: QS });
  [1, 2].forEach(h.join);
  h.act(1, "start", QUIZ_START);
  await h.advance(3000 + 500);
  h.act(2, "answer", { option: 0, ms: 300 });
  await h.advance(QUIZ_MS);
  h.act(1, "quizPack", { title: "1", questions: QS });
  assert.deepEqual(h.ev.created.map((e) => e.source), ["remake"]);
});

test("a throwing hook never breaks the room", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x);
  try {
    let t = 0;
    const timers = [];
    const room = createRoom({
      now: () => t,
      setTimer: (fn, ms) => timers.push({ at: t + ms, fn }),
      clearTimer: () => {},
      broadcast: () => {},
      send: () => {},
      onSessionStart: () => { throw new Error("x"); },
      onSessionEnd: () => { throw new Error("y"); },
    });
    room.join("p1", { anonId: "a1", nick: "1" });
    room.action("p1", { name: "start", payload: { duration: 3000 }, clientMsgId: mid(1) });
    await new Promise((r) => setImmediate(r));
    for (const x of timers.sort((p, q) => p.at - q.at)) { t = x.at; x.fn(); }
    assert.equal(room._state.session.phase, "result");
    assert.equal(errors.length, 2);
  } finally {
    console.error = orig;
  }
});
