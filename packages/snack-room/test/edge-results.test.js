// What the host phone did in mesh mode, done by the edge room's Durable Object (#96,
// edge/room/src/results.js · game.js): a friends room keeps its last scored game 7 days
// (write-once per game, readable at GET /room/<id>/result by someone alone in the room,
// gone after the 7-day alarm), and game stats go to the stats API server to server —
// batched, once per game across reconnects / a hibernation wake, never retried on failure.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";
import { memoryStore } from "../../../edge/room/src/core.js";
import { roomAlarm } from "../../../edge/room/src/game.js";
import { StatsSender, resultRecord, appOf, isFriendRoom, RESULT_TTL_MS, STATS_UA } from "../../../edge/room/src/results.js";
import { parseRoomResult } from "../../../api/_lib/roomResult.js";

const SECRET = "room-server-test-secret-0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 10 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const friends = () => `tpl-speed-trivia-score~${code()}`;

let hub;
let skew = 0; // the hub's clock runs `skew` ms ahead (7 days later, without waiting)
const posts = []; // what the stats API received: {url, headers, body}
let apiDown = false;
before(async () => {
  hub = await startEdgeHub({
    port: Number(process.env.EDGE_TEST_PORT_RESULTS || 4556),
    now: () => Date.now() + skew,
    stats: {
      url: "https://stats.test/api/ev",
      secret: SECRET,
      flushMs: 150,
      fetch: async (url, init) => {
        posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        if (apiDown) throw new Error("network down");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  });
});
after(async () => hub?.close());

function player(room, anonId) {
  const ws = new WebSocket(`${hub.url}/room/${room}`);
  const frames = [];
  const vars = {};
  let closed = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    frames.push(m);
    if (m.t === "state") Object.assign(vars, m.d.sharedState, { participants: m.d.participants });
    else if (m.t === "setVar") vars[m.d.id] = m.d.value;
    else if (m.t === "participants") vars.participants = m.d.count;
  };
  ws.onclose = (ev) => (closed = ev.code);
  const opened = new Promise((r) => (ws.onopen = r));
  let n = 0;
  const p = {
    frames,
    vars,
    get closed() {
      return closed;
    },
    raw: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...extra } }),
    act: (name, payload) => p.raw({ t: "action", d: { name, payload, clientMsgId: crypto.randomUUID() } }),
    frame: (pred) => frames.find(pred),
    async until(fn, ms = 6000) {
      for (let t = 0; t < ms; t += 25) {
        if (fn()) return true;
        await sleep(25);
      }
      return Boolean(fn());
    },
    close: () => ws.close(),
  };
  return p;
}

const PACK = {
  title: "공원 퀴즈",
  questions: [
    { q: "하나 더하기 하나는?", options: ["1", "2", "3", "4"], answer: 1 },
    { q: "한국의 수도는?", options: ["부산", "서울", "대구"], answer: 1 },
  ],
  settings: { answerMs: 3000 },
};

/** Organizer + 2 players play the 2-question quiz to its result. */
async function playQuiz(room, ps = null) {
  ps ??= await (async () => {
    const org = player(room, "host");
    await org.hello({ organize: true });
    const a = player(room, "pa");
    const b = player(room, "pb");
    await a.hello();
    await b.hello();
    assert.ok(await org.until(() => org.vars.participants === 3));
    return [org, a, b];
  })();
  const [org, a, b] = ps;
  await org.act("quizPack", PACK);
  assert.ok(await org.until(() => org.vars.quizInfo?.custom === true));
  await org.act("start", { game: "trivia", quiz: true, revealMs: 300, answerMs: 3000 });
  for (let i = 0; i < 2; i++) {
    assert.ok(await a.until(() => a.vars.sessionPhase === "play" && a.vars.roundContent?.q === PACK.questions[i].q, 8000), `round ${i}`);
    const right = a.vars.roundContent.options.indexOf(PACK.questions[i].options[1]);
    await a.act("answer", { option: right, ms: 900 });
    await b.act("answer", { option: (right + 1) % a.vars.roundContent.options.length, ms: 1200 });
    await org.act("answer", { option: right, ms: 1500 });
    assert.ok(await a.until(() => a.vars.myPick));
    a.vars.myPick = null;
  }
  assert.ok(await a.until(() => a.vars.sessionPhase === "result", 8000), "the game reached its result");
  return ps;
}

const getResult = async (room) => {
  const res = await fetch(`${hub.url.replace(/^ws/, "http")}/room/${room}/result`);
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), body: await res.json() };
};

test("a friends room keeps its game once; someone alone in it reads it; the 7-day alarm removes it", async () => {
  const room = friends();
  const ps = await playQuiz(room);
  const r = hub.room(room);
  assert.ok(await ps[0].until(() => r.store.map.get("result")), "stored at the result");
  const saved = r.store.map.get("result");
  assert.equal(r.core.stats.resultWrites, 1);
  assert.equal(saved.rec.v, 1);
  assert.equal(saved.rec.app, "tpl-speed-trivia-score");
  assert.equal(saved.rec.title, "공원 퀴즈");
  assert.ok(["pa", "pb"].every((n) => saved.rec.board.some((b) => b.nick === n)), "the players are ranked");
  assert.equal(saved.rec.board[0].nick, "pa", "pa answered right, first");
  assert.equal(saved.rec.quizRecap.rounds.length, 2);
  assert.ok(saved.exp - (Date.now() + skew) > RESULT_TTL_MS - 60000);
  assert.ok(!JSON.stringify(saved).includes("anonId") && !JSON.stringify(saved.rec).includes(room), "no anonId, no room code in the record");
  // The same game reported again (a hand-over / restore): not written twice.
  await r.core.saveResult({ v: 1, sid: saved.sid, endedAt: 0, board: [{ pid: "p1", nick: "x", score: 1 }] });
  assert.equal(r.core.stats.resultWrites, 1);
  assert.equal(r.core.stats.resultDupes, 1);
  assert.equal(r.store.map.get("result").rec.board[0].nick, saved.rec.board[0].nick);

  for (const p of ps) p.close();
  await sleep(200);
  assert.equal(r.store.map.get("snap"), undefined, "the snapshot leaves with the last player");
  // Someone opens the link later and is alone in the lobby: the room's state, then the result.
  const lone = player(room, "late");
  await lone.hello();
  assert.ok(await lone.until(() => lone.vars.participants === 1));
  assert.equal(lone.vars.sessionPhase ?? "lobby", "lobby");
  const got = await getResult(room);
  assert.equal(got.status, 200);
  assert.equal(got.cors, "*");
  assert.deepEqual(got.body, { ok: true, result: saved.rec });
  lone.close();
  await sleep(200);

  // The 24 h cleanup alarm: the room goes (meta), its result stays and the alarm moves to its expiry.
  assert.equal(await hub.fireAlarm(room, "room"), undefined);
  assert.equal(r.store.map.get("meta"), undefined);
  assert.ok(r.store.map.get("result"));
  assert.equal(r.alarmAt, saved.exp);
  assert.equal((await getResult(room)).status, 200);
  // 7 days later: no longer served, and its alarm deletes it.
  skew = RESULT_TTL_MS + 1000;
  try {
    assert.equal((await getResult(room)).status, 404);
    await hub.fireAlarm(room, "room");
    assert.equal(hub.room(room), undefined, "nothing left of the room");
  } finally {
    skew = 0;
  }
});

test("public rooms save nothing; GET for a non-friends id is 404", async () => {
  const room = `tpl-speed-trivia-score`;
  const ps = await playQuiz(room);
  await sleep(300);
  assert.equal(hub.room(room).store.map.get("result"), undefined);
  for (const p of ps) p.close();
  assert.equal((await getResult(room)).status, 404);
  assert.equal((await getResult(friends())).status, 404, "a friends room with no game yet");
});

test("game stats: batched, server UA + secret, exactly once per game across a reconnect and a hibernation wake", async () => {
  const room = friends();
  await sleep(400); // the earlier tests' rooms have flushed (no event carries a room id to tell them apart)
  const before = posts.length;
  const mine = () => posts.slice(before).flatMap((p) => p.body.events);
  const ps = await playQuiz(room);
  const [org, a] = ps;
  const r = hub.room(room);
  assert.ok(await org.until(() => mine().some((e) => e.k === "session_done")), "session_done posted");
  const p0 = posts[before];
  assert.equal(p0.url, "https://stats.test/api/ev");
  assert.equal(p0.headers["user-agent"], STATS_UA);
  assert.equal(p0.headers["x-room-server"], SECRET);
  const done1 = mine().filter((e) => e.k === "session_done");
  assert.equal(done1.length, 1);
  assert.deepEqual(Object.keys(done1[0]).sort(), ["about", "ans", "app", "k", "p", "sid"], "only the schema's fields");
  assert.equal(done1[0].p, 3);
  assert.equal(done1[0].about, true, "a made quiz is about its organizer here");
  assert.equal(mine().filter((e) => e.k === "game_created").length, 1);
  assert.ok(!JSON.stringify(mine()).includes(room.split("~")[1]), "the room code is never sent");
  assert.ok(posts.slice(before).length <= 2, "batched (quiz made + game done in ≤ 2 posts)");

  // A player reconnects with its seat token (takes its seat over) during the result.
  const tok = a.frames.filter((m) => m.t === "token").at(-1).d.token;
  const back = player(room, "pa");
  await back.hello({ token: tok });
  assert.ok(await back.until(() => back.vars.sessionPhase === "result"));
  // Hibernation: the DO forgets everything in memory (a new StatsSender too) and wakes on a join.
  await sleep(1300); // the idle snapshot (debounced 1 s)
  r.core.forget();
  r.core.statsSender = new StatsSender({ url: "https://stats.test/api/ev", secret: SECRET, flushMs: 150, fetch: async (url, init) => (posts.push({ url, headers: init.headers, body: JSON.parse(init.body) }), new Response("{}")) });
  const c = player(room, "pc");
  await c.hello();
  assert.ok(await c.until(() => c.vars.participants === 4));
  assert.equal(r.core.stats.rehydrated, 1);
  await sleep(500);
  assert.equal(mine().filter((e) => e.k === "session_done").length, 1, "still one session_done");

  // The next game in the room: a rematch + its own session_done.
  await playQuiz(room, [org, back, c]);
  assert.ok(await org.until(() => mine().filter((e) => e.k === "session_done").length === 2));
  assert.equal(mine().filter((e) => e.k === "rematch").length, 1);
  const sids = mine().filter((e) => e.k === "session_done").map((e) => e.sid);
  assert.notEqual(sids[0], sids[1]);
  assert.equal(r.core.stats.resultWrites, 2, "the room's last game replaces the first");
  for (const p of [org, back, c, ps[2]]) p.close();
});

test("StatsSender: one POST per flush, ≤ 20 events each, dupes dropped; a failure is counted, never retried", async () => {
  let t = 0;
  const timers = [];
  const calls = [];
  let fail = true;
  const s = new StatsSender({
    url: "https://stats.test/api/ev",
    flushMs: 10000,
    setTimer: (fn, ms) => (timers.push({ fn, at: t + ms }), timers.length),
    clearTimer: () => {},
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (fail) return new Response("no", { status: 503 });
      return new Response("{}", { status: 200 });
    },
  });
  const h = s.hooks("app-abc123~ABCDEFGH");
  h.onSessionEnd({ sid: "s".repeat(20), players: 2, quiz: false });
  h.onSessionEnd({ sid: "s".repeat(20), players: 2, quiz: false }); // the same game again
  h.onSessionEnd({ sid: "t".repeat(20), players: 0, quiz: false }); // nobody took part
  h.onSessionStart({ sid: "u".repeat(20), players: 3, again: false }); // not a rematch
  h.onGameCreated({ gid: "g".repeat(20), source: "editor" });
  assert.equal(s.queue.length, 2);
  assert.equal(calls.length, 0, "nothing sent before the flush timer");
  await timers[0].fn();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].events, [
    { k: "session_done", app: "custom", p: 2, sid: "s".repeat(20) },
    { k: "game_created", app: "custom", source: "editor", gid: "g".repeat(20) },
  ]);
  assert.deepEqual({ failed: s.counts.failed, dropped: s.counts.dropped, dupes: s.counts.dupes }, { failed: 1, dropped: 2, dupes: 1 });
  assert.equal(s.queue.length, 0, "dropped, not re-queued");
  await s.flush(); // nothing queued → no POST (no retry loop)
  assert.equal(calls.length, 1);
  // 25 events → 20 sent at once (cap), the other 5 on the timer.
  fail = false;
  for (let i = 0; i < 25; i++) h.onSessionStart({ sid: `r${String(i).padStart(19, "0")}`, players: 2, again: true });
  await sleep(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].events.length, 20);
  await s.flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].events.length, 5);
  assert.ok(calls.every((c) => JSON.stringify(c).length <= 4000));
  assert.equal(s.counts.sent, 25);
  // A throwing fetch never escapes.
  const boom = new StatsSender({ url: "x", fetch: () => { throw new Error("sync"); } });
  boom.add({ k: "rematch", app: "x", p: 2, sid: "z".repeat(20) });
  await boom.flush();
  assert.equal(boom.counts.failed, 1);
  assert.equal(new StatsSender({ url: "" }).add({ k: "rematch", sid: "q" }), undefined, "no URL = off");
});

test("a lost API in a live room: the game goes on, events dropped and counted", async () => {
  apiDown = true;
  try {
    const room = friends();
    const ps = await playQuiz(room);
    const r = hub.room(room);
    // game_created (at the pack) and session_done (at the result): each POST fails once.
    assert.ok(await ps[0].until(() => r.core.statsSender.counts.dropped >= 2));
    assert.equal(r.core.statsSender.counts.failed, r.core.statsSender.counts.posts);
    const n = posts.length;
    await sleep(500);
    assert.equal(posts.length, n, "no retries");
    assert.ok(r.store.map.get("result"), "the result is still saved");
    for (const p of ps) p.close();
  } finally {
    apiDown = false;
  }
});

test("resultRecord: the API's record shape, whitelisted, fitted under 24 KB; friends rooms only", () => {
  const room = "tpl-speed-trivia-score~ABCDEFGH";
  assert.equal(isFriendRoom(room), true);
  assert.equal(isFriendRoom("tpl-speed-trivia-score"), false);
  assert.equal(appOf(room), "speed-trivia-score");
  const base = { v: 1, sid: "a".repeat(32), endedAt: 1, title: "제목", about: "민지", board: [{ pid: "p1", nick: "민지", score: 900, anonId: "secret" }, { pid: "p2", nick: "준", score: 0, left: true }] };
  assert.equal(resultRecord("tpl-speed-trivia-score", base), null, "a public room");
  const rec = resultRecord(room, base, 1234);
  assert.deepEqual(rec, { v: 1, app: "tpl-speed-trivia-score", endedAt: 1234, title: "제목", about: "민지", board: [{ pid: "p1", nick: "민지", score: 900 }, { pid: "p2", nick: "준", score: 0, left: true }] });
  // The API would store the very same record (same validation).
  const api = parseRoomResult(JSON.stringify({ room, sid: base.sid, result: rec }), 1234);
  assert.equal(api.status, 200);
  assert.deepEqual(api.record, rec);
  // 20 players × 20 long questions: picks cut to the top 8, then the ranking alone.
  const nick = (i) => `닉네임${String(i).padStart(4, "0")}`;
  const board = Array.from({ length: 24 }, (_, i) => ({ pid: `p${i + 1}`, nick: nick(i), score: 1000 - i }));
  const rounds = Array.from({ length: 20 }, (_, i) => ({
    q: `${"아주 긴 문제 ".repeat(9)}${i}`.slice(0, 80),
    options: ["가".repeat(30), "나".repeat(30), "다".repeat(30), "라".repeat(30)],
    answer: 1,
    picks: board.map((b) => ({ pid: b.pid, nick: b.nick, option: 1, ms: 1000, correct: true, points: 900, extra: 1 })),
  }));
  const big = resultRecord(room, { ...base, board, quizRecap: { subject: null, about: null, title: "", packId: null, rounds } }, 1);
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length <= 24 * 1024);
  assert.equal(big.board.length, 20);
  if (big.quizRecap) assert.ok(big.quizRecap.rounds.every((rd) => rd.picks.length <= 8 && rd.picks.every((p) => !("extra" in p))));
  assert.equal(parseRoomResult(JSON.stringify({ room, sid: base.sid, result: big }), 1).status, 200);
});

test("roomAlarm (the Worker's alarm with no room in memory): keeps a fresh result, else empties the room", async () => {
  const store = memoryStore();
  let alarm = null;
  const setAlarm = (at) => (alarm = at);
  await store.put("meta", { epoch: "e" });
  await store.put("snap", { at: 1 });
  await store.put("result", { sid: "s", exp: 5000, rec: { v: 1 } });
  assert.equal(await roomAlarm({ store, now: () => 1000, setAlarm }), false);
  assert.deepEqual([...store.map.keys()], ["result"]);
  assert.equal(alarm, 5000);
  assert.equal(await roomAlarm({ store, now: () => 5000, setAlarm }), true);
  assert.equal(store.map.size, 0);
});
