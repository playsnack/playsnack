// Server-authoritative edge rooms (edge/room/src/game.js): the engine runs in the room's
// Durable Object. Hello first, organizer-only controls, one seat per device (token
// takeover), answers never leave before the reveal, server-clock claim window, rehydrate
// after hibernation. Node hub by default; EDGE_URL=ws://127.0.0.1:4551 runs the shared
// cases against `wrangler dev` (start it with CLAIM_WINDOW_MS=300).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startEdgeHub } from "../tools/edgeHub.js";

const EXTERNAL = process.env.EDGE_URL || "";
const WINDOW = 300;
let hub = null;
let URL_ = EXTERNAL;
const RUN = Date.now().toString(36);
const rid = (s) => `g-${RUN}-${s}`;
// A friends room with a code from before v2 (10 symbols = legacy, #157): `organize` / `pin` in the hello as before.
const LEGACY = () => Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const fid = (s) => `g-${RUN}-${s}~${LEGACY()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (EXTERNAL) return;
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT || 4553), limits: { claimWindowMs: WINDOW } });
  URL_ = hub.url;
});
after(async () => hub?.close());

/** A player socket speaking the server /ws protocol; records every frame. */
function player(room, anonId, hello = {}) {
  const ws = new WebSocket(`${URL_}/room/${room}`);
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
    ws,
    frames,
    vars,
    get closed() {
      return closed;
    },
    raw: async (m) => {
      await opened;
      ws.send(JSON.stringify(m));
    },
    hello: (extra = {}) => p.raw({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello, ...extra } }),
    act: (name, payload) => p.raw({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${++n}` } }),
    frame: (pred) => frames.find(pred),
    async until(fn, ms = 4000) {
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
const ack = (p, reason) => p.frame((m) => m.t === "actionAck" && m.d?.reason === reason);

test("nothing before hello: another first frame closes the socket", async () => {
  const p = player(rid("hello"), "a1");
  await p.raw({ t: "action", d: { name: "start" } });
  assert.ok(await p.until(() => p.closed !== null));
  assert.equal(p.closed, 4001);
  assert.equal(p.frames.length, 0);
});

test("organizer = host (#135): only the room's creator starts / resets; its token restores the role", async () => {
  const room = fid("org");
  const org = player(room, "org1");
  await org.hello({ organize: true });
  assert.ok(await org.until(() => org.frame((m) => m.t === "organizer")));
  const orgToken = org.frame((m) => m.t === "organizer").d.token;
  const a = player(room, "pa");
  await a.hello({ organize: true }); // too late: the room exists
  assert.ok(await a.until(() => a.vars.participants === 2));
  assert.equal(a.frame((m) => m.t === "organizer"), undefined);
  for (const name of ["start", "lobby"]) await a.act(name, name === "start" ? { duration: 3000 } : {});
  assert.ok(await a.until(() => a.frames.filter((m) => m.d?.reason === "not_host").length === 2));
  assert.notEqual(a.vars.sessionPhase, "countdown");
  org.close();
  await sleep(100);
  const back = player(room, "org1");
  await back.hello({ organizerToken: orgToken });
  assert.ok(await back.until(() => back.frame((m) => m.t === "organizer")));
  await back.act("start", { duration: 3000 });
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown" || a.vars.sessionPhase === "play"));
  assert.equal(ack(back, "not_host"), undefined);
  a.close();
  back.close();
});

test("one seat per device: a second socket is refused; with the seat token it takes over", async () => {
  const room = rid("seat");
  const a = player(room, "dev1");
  await a.hello();
  assert.ok(await a.until(() => a.frame((m) => m.t === "token")));
  const tok = a.frame((m) => m.t === "token").d.token;
  const b = player(room, "other");
  await b.hello();
  assert.ok(await b.until(() => b.vars.participants === 2));
  const dup = player(room, "dev1");
  await dup.hello();
  assert.ok(await dup.until(() => dup.closed !== null));
  assert.equal(dup.closed, 4009);
  assert.equal(dup.frame((m) => m.t === "denied")?.d.reason, "seat_taken");
  const re = player(room, "dev1");
  await re.hello({ token: tok });
  assert.ok(await re.until(() => re.frame((m) => m.t === "state")));
  assert.ok(await a.until(() => a.closed !== null));
  assert.equal(a.closed, 4009, "the old socket is replaced");
  await sleep(200);
  assert.equal(b.vars.participants, 2, "still two people");
  assert.equal(b.vars.roster.length, 2);
  // a token for another room does not take this seat
  const other = rid("seat-other");
  const o = player(other, "dev1");
  await o.hello();
  assert.ok(await o.until(() => o.frame((m) => m.t === "token")));
  const cross = player(room, "dev1");
  await cross.hello({ token: o.frame((m) => m.t === "token").d.token });
  assert.ok(await cross.until(() => cross.closed !== null));
  assert.equal(cross.frame((m) => m.t === "denied")?.d.reason, "seat_taken");
  [b, re, o].forEach((x) => x.close());
});

test("back from the share sheet (#115): a takeover joins before the old socket leaves — same seat, never off the roster, a lone player's game kept", async () => {
  // Two players: the friend never sees the returning player leave the roster.
  const room = rid("back");
  const a = player(room, "ba");
  await a.hello({ nick: "가나" });
  assert.ok(await a.until(() => a.frame((m) => m.t === "token")));
  const b = player(room, "bb");
  await b.hello({ nick: "다라" });
  assert.ok(await b.until(() => b.vars.participants === 2));
  await a.act("start", { duration: 8000 });
  assert.ok(await b.until(() => b.vars.sessionPhase === "countdown" || b.vars.sessionPhase === "play"));
  const rosters = () => b.frames.filter((m) => m.t === "setVar" && m.d.id === "roster").map((m) => m.d.value.length);
  const before = rosters().length;
  const re = player(room, "ba");
  await re.hello({ nick: "가나", token: a.frame((m) => m.t === "token").d.token });
  assert.ok(await re.until(() => re.frame((m) => m.t === "state")));
  assert.ok(await a.until(() => a.closed !== null));
  await sleep(300);
  assert.ok(rosters().slice(before).every((n) => n === 2), `the friend's roster never drops to 1 (${rosters().slice(before)})`);
  assert.deepEqual(b.vars.roster, ["가나", "다라"]);
  const st = re.frame((m) => m.t === "state").d;
  assert.ok(["countdown", "play"].includes(st.sharedState.sessionPhase), "the game goes on for the returning player");
  assert.notEqual(re.vars.iAmSpectator, true, "a member who comes back is not a spectator");
  [b, re].forEach((x) => x.close());

  // Alone in the room (inviting friends from the lobby, or mid-game): the room is not torn down.
  const solo = rid("back-solo");
  const s = player(solo, "sa");
  await s.hello({ nick: "혼자" });
  assert.ok(await s.until(() => s.frame((m) => m.t === "token")));
  await s.act("start", { duration: 8000 });
  assert.ok(await s.until(() => s.vars.sessionPhase === "countdown" || s.vars.sessionPhase === "play"));
  const s2 = player(solo, "sa");
  await s2.hello({ nick: "혼자", token: s.frame((m) => m.t === "token").d.token });
  assert.ok(await s2.until(() => s2.frame((m) => m.t === "state")));
  const st2 = s2.frame((m) => m.t === "state").d;
  assert.ok(["countdown", "play"].includes(st2.sharedState.sessionPhase), `the lone player's game is kept (${st2.sharedState.sessionPhase})`);
  assert.ok(await s2.until(() => s2.vars.participants === 1), "one person (the old socket gone)");
  assert.deepEqual(st2.sharedState.roster, ["혼자"]);
  s2.close();
});

const PACK = {
  title: "공원 퀴즈",
  questions: [
    { q: "하나 더하기 하나는?", options: ["1", "2", "3", "4"], answer: 1 },
    { q: "한국의 수도는?", options: ["부산", "서울", "대구"], answer: 1 },
  ],
  settings: { answerMs: 4000 },
};

test("fairness: answers never leave the room before the reveal; picks go only to their player", async () => {
  const room = rid("fair");
  const org = player(room, "host");
  await org.hello({ organize: true });
  const ps = ["q1", "q2", "q3"].map((id) => player(room, id));
  for (const p of ps) await p.hello();
  assert.ok(await org.until(() => org.vars.participants === 4));
  await org.act("quizPack", PACK);
  assert.ok(await org.until(() => org.vars.quizInfo?.custom === true));
  await org.act("start", { game: "trivia", quiz: true, revealMs: 800, answerMs: 4000 });
  assert.ok(await ps[0].until(() => ps[0].vars.sessionPhase === "play" && ps[0].vars.roundContent?.q, 6000));
  const before = ps.map((p) => p.frames.length);
  const right = ps[0].vars.roundContent.options.indexOf(PACK.questions[0].options[1]);
  await ps[0].act("answer", { option: right, ms: 1500 });
  await ps[1].act("answer", { option: (right + 1) % 4, ms: 1500 });
  assert.ok(await ps[0].until(() => ps[0].vars.myPick));
  // Up to the reveal: no frame anywhere carries the answer, a pick of someone else, or a recap.
  assert.ok(await ps[2].until(() => ps[2].vars.roundAnswer >= 0, 6000));
  const revealAt = (p) => p.frames.findIndex((m) => m.t === "setVar" && m.d.id === "roundAnswer" && m.d.value >= 0);
  for (const p of [org, ...ps]) {
    const pre = p.frames.slice(0, revealAt(p));
    const txt = JSON.stringify(pre);
    assert.ok(!pre.some((m) => m.t === "setVar" && m.d.id === "quizRecap"), "no recap before the result");
    assert.ok(!pre.some((m) => (m.t === "setVar" && m.d.id === "roundContent" && "answer" in (m.d.value ?? {})) || (m.t === "state" && "answer" in (m.d.sharedState.roundContent ?? {}))), "round content without the answer");
    assert.ok(!/"correct"|"points"/.test(txt), "no scoring detail before the reveal");
  }
  assert.equal(ps[1].frames.filter((m) => m.d?.id === "myPick").length, 1);
  assert.equal(ps[2].frames.filter((m) => m.d?.id === "myPick").length, 0, "q3 never answered: no pick sent to it");
  assert.ok(before.every((n) => n > 0));
  [org, ...ps].forEach((p) => p.close());
});

test("answer change (#211): a switch goes back only to its player, nothing leaks before the reveal; locked 3 s after the pick on the server's clock", async () => {
  const room = rid("change");
  const org = player(room, "host");
  await org.hello({ organize: true });
  const ps = ["c1", "c2"].map((id) => player(room, id));
  for (const p of ps) await p.hello();
  assert.ok(await org.until(() => org.vars.participants === 3));
  await org.act("quizPack", PACK);
  assert.ok(await org.until(() => org.vars.quizInfo?.custom === true));
  await org.act("start", { game: "trivia", quiz: true, revealMs: 800 });
  assert.ok(await ps[0].until(() => ps[0].vars.sessionPhase === "play" && ps[0].vars.roundContent?.q, 6000));
  const right = ps[0].vars.roundContent.options.indexOf(PACK.questions[0].options[1]);
  const wrong = (right + 1) % 4;
  const sn = ps[0].vars.sessionNo;
  await ps[0].act("answer", { option: wrong, ms: 200, round: 0, sessionNo: sn, n: 1 });
  await ps[1].act("answer", { option: right, ms: 250, round: 0, sessionNo: sn, n: 1 });
  assert.ok(await ps[0].until(() => ps[0].vars.myPick?.n === 1));
  assert.ok(ps[0].vars.myPick.lockMs > 2500 && ps[0].vars.myPick.lockMs <= 3000, `lockMs ${ps[0].vars.myPick.lockMs}`);
  await ps[0].act("answer", { option: right, ms: 700, round: 0, sessionNo: sn, n: 2 }); // switch inside the window
  assert.ok(await ps[0].until(() => ps[0].vars.myPick?.n === 2 && ps[0].vars.myPick.option === right));
  assert.equal(ps[0].vars.roundAnswer, -1, "everyone answered, but the windows are open: not revealed yet");
  const all = [org, ...ps];
  const sizes = all.map((p) => p.frames.length);
  await sleep(3000); // past c1's window (3 s after the room took its first pick)
  await ps[0].act("answer", { option: wrong, ms: 3500, round: 0, sessionNo: sn, n: 3 });
  assert.ok(await ps[0].until(() => ps[0].frames.some((m) => m.t === "actionAck" && m.d.clientMsgId === "c1-3")));
  assert.equal(ps[0].frame((m) => m.t === "actionAck" && m.d.clientMsgId === "c1-3").d.reason, "locked");
  assert.ok(await ps[1].until(() => ps[1].vars.roundAnswer >= 0, 3000), "revealed once both windows closed");
  const revealAt = (p) => p.frames.findIndex((m) => m.t === "setVar" && m.d.id === "roundAnswer" && m.d.value >= 0);
  for (const [k, p] of all.entries()) {
    const pre = p.frames.slice(0, revealAt(p));
    assert.ok(sizes[k] <= pre.length, "the reveal came after the switch");
    const mine = p === org ? null : p === ps[0] ? "c1" : "c2";
    const picks = pre.filter((m) => m.d?.id === "myPick");
    if (!mine) assert.equal(picks.length, 0, "the organizer never answered: no pick sent to it");
    else assert.ok(picks.length > 0 && picks.every((m) => p === ps[0] ? [wrong, right].includes(m.d.value.option) : m.d.value.option === right), `only ${mine}'s own picks reach ${mine}`);
    assert.ok(!/"correct"|"points"/.test(JSON.stringify(pre)), "no scoring detail before the reveal");
    assert.ok(!pre.some((m) => (m.t === "setVar" && m.d.id === "roundContent" && "answer" in (m.d.value ?? {}))), "round content without the answer");
    assert.ok(!pre.some((m) => m.t === "setVar" && m.d.id === "raceBoard" && m.d.value.some((x) => x.score > 0)), "no scores before the reveal");
  }
  assert.equal(ps[1].frames.filter((m) => m.d?.id === "myPick").length, 1, "c2 never switched: one pick");
  const board = ps[1].vars.raceBoard;
  assert.ok(board.find((x) => x.nick === "c1").score < board.find((x) => x.nick === "c2").score, "c1 is scored from its later switch");
  all.forEach((p) => p.close());
});

test("hidden picks (밸런스게임 #126): no frame carries another's pick or a running tally before the reveal; all picked → revealed at once", async () => {
  const room = rid("balance");
  const org = player(room, "host");
  await org.hello({ organize: true });
  const ps = ["b1", "b2"].map((id) => player(room, id));
  for (const p of ps) await p.hello();
  assert.ok(await org.until(() => org.vars.participants === 3));
  await org.act("start", { game: "balance", rounds: 1, roundMs: 8000, revealMs: 1500, hidden: true });
  assert.ok(await ps[0].until(() => ps[0].vars.sessionPhase === "play" && ps[0].vars.roundContent?.a, 6000));
  await ps[0].act("vote", { option: "o0" });
  await ps[1].act("vote", { option: "o1" });
  assert.ok(await org.until(() => org.vars.voteProgress?.voted === 2));
  assert.equal(org.vars.revealRound, -1, "host (organizer) has not picked: not revealed yet");
  await org.act("vote", { option: "o1" });
  assert.ok(await org.until(() => org.vars.revealRound === 0, 3000), "all 3 picked → early reveal");
  for (const [p, mine] of [[org, "o1"], [ps[0], "o0"], [ps[1], "o1"]]) {
    const at = p.frames.findIndex((m) => m.t === "setVar" && m.d.id === "votesByOption" && Object.values(m.d.value).some((n) => n > 0));
    const pre = p.frames.slice(0, at);
    assert.ok(at > 0, "the split arrives at the reveal");
    assert.ok(!pre.some((m) => m.t === "setVar" && m.d.id === "roundPicks" && Object.values(m.d.value).some((x) => x.length)), "no names before the reveal");
    assert.ok(pre.filter((m) => m.d?.id === "myPick").every((m) => m.d.value.option === mine), "only my own pick comes to me");
    assert.ok(!pre.some((m) => m.t === "state" && Object.values(m.d.sharedState.votesByOption ?? {}).some((n) => n > 0)));
  }
  assert.deepEqual(ps[0].vars.votesByOption, { o0: 1, o1: 2 });
  assert.deepEqual(ps[0].vars.roundPicks, { o0: ["b1"], o1: ["b2", "host"] });
  [org, ...ps].forEach((p) => p.close());
});

test("server clock: a device claim is believed only within [elapsed − window, elapsed]", async () => {
  const room = rid("clock");
  const org = player(room, "host");
  await org.hello({ organize: true });
  const p = player(room, "fast");
  await p.hello();
  assert.ok(await org.until(() => org.vars.participants === 2));
  await org.act("quizPack", PACK);
  assert.ok(await org.until(() => org.vars.quizInfo?.custom === true));
  await org.act("start", { game: "trivia", quiz: true, revealMs: 800, answerMs: 4000 });
  assert.ok(await p.until(() => p.vars.sessionPhase === "play" && p.vars.roundContent?.q, 6000));
  const shownAt = Date.now();
  await sleep(1500);
  await p.act("answer", { option: 0, ms: 20 }); // "I answered in 20 ms" — after 1.5 s
  assert.ok(await p.until(() => p.vars.myPick));
  const elapsed = Date.now() - shownAt;
  assert.ok(p.vars.myPick.ms >= 1500 - WINDOW - 50, `ms ${p.vars.myPick.ms} (elapsed ${elapsed})`);
  assert.ok(p.vars.myPick.ms <= elapsed + 50);
  org.close();
  p.close();
});

test("hibernation: the engine is rebuilt from storage, players keep their seats and the quiz", { skip: EXTERNAL ? "hub only (forces an eviction)" : false }, async () => {
  const room = rid("hib");
  const org = player(room, "host");
  await org.hello({ organize: true });
  const a = player(room, "ha");
  await a.hello();
  assert.ok(await org.until(() => org.vars.participants === 2));
  await org.act("quizPack", PACK);
  assert.ok(await org.until(() => org.vars.quizInfo?.custom === true));
  await sleep(1300); // persisted (debounced 1 s)
  assert.ok(hub.room(room).store.map.get("snap"), "the snapshot is stored while the room is occupied");
  hub.room(room).core.forget(); // what an evicted DO loses
  const b = player(room, "hb");
  await b.hello();
  assert.ok(await b.until(() => b.vars.participants === 3));
  assert.equal(b.vars.quizInfo?.custom, true, "the quiz survived");
  assert.deepEqual(b.vars.roster.slice().sort(), ["ha", "hb", "host"]);
  assert.equal(hub.room(room).core.stats.rehydrated, 1);
  await org.act("start", { game: "trivia", quiz: true, revealMs: 800, answerMs: 4000 }); // the organizer is still the organizer
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown" || a.vars.sessionPhase === "play"));
  [org, a, b].forEach((p) => p.close());
  await sleep(200);
  assert.equal(hub.room(room).store.map.get("snap"), undefined, "nicknames and scores leave with the last player");
});

test("rename (#104): the room server renames in the lobby, refuses mid-game; the new name survives a wake from hibernation", async () => {
  const room = rid("ren");
  const a = player(room, "ra");
  await a.hello({ nick: "느긋한 치킨" });
  const b = player(room, "rb");
  await b.hello();
  assert.ok(await b.until(() => b.vars.participants === 2));
  assert.deepEqual(b.vars.roster, ["느긋한 치킨", "rb"]);
  await a.act("start", { duration: 4000 });
  assert.ok(await a.until(() => a.vars.sessionPhase === "countdown"));
  await a.act("rename", { nick: "게임 중" });
  assert.ok(await a.until(() => ack(a, "not_in_lobby")), "refused during the countdown");
  await a.act("lobby");
  assert.ok(await a.until(() => a.vars.sessionPhase === "lobby"));
  await a.act("rename", { nick: "  민지  " });
  assert.ok(await b.until(() => b.vars.roster?.[0] === "민지"), "everyone sees the new name");
  assert.ok(a.frame((m) => m.t === "actionAck" && m.d?.accepted === true && m.d.clientMsgId === "ra-3"));
  if (!EXTERNAL) {
    const sockA = [...hub.room(room).sockets].find((s) => s.state?.anonId === "ra");
    assert.equal(sockA.state.nick, "민지", "the socket attachment carries the new name");
    await sleep(1300); // persisted (debounced 1 s)
    hub.room(room).core.forget(); // what an evicted DO loses
    const c = player(room, "rc");
    await c.hello();
    assert.ok(await c.until(() => c.vars.participants === 3));
    assert.deepEqual(c.vars.roster, ["민지", "rb", "rc"], "rebuilt from the attachments: the new name, not the hello's");
    c.close();
  }
  a.close();
  b.close();
});

test("a PIN room: the right PIN joins, a wrong one is refused", async () => {
  const room = fid("pin");
  const a = player(room, "pa");
  await a.hello({ pin: "8080" });
  assert.ok(await a.until(() => a.frame((m) => m.t === "state")));
  const b = player(room, "pb");
  await b.hello({ pin: "1111" });
  assert.ok(await b.until(() => b.frame((m) => m.t === "denied")));
  assert.equal(b.frame((m) => m.t === "denied").d.reason, "pin");
  await b.hello({ pin: "8080" });
  assert.ok(await b.until(() => b.frame((m) => m.t === "state")));
  a.close();
  b.close();
});
