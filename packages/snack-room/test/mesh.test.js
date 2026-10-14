import { test } from "node:test";
import assert from "node:assert/strict";
import { connectMesh } from "../src/meshClient.js";
// raceBoard rows carry a per-room `pid`; compare names and scores
const rows = (b) => (b || []).map(({ pid, ...x }) => x);

// In-memory pub/sub with latency; a "frozen" node neither sends nor receives.
// `lose(m, to)` → true drops that delivery (a lossy public broker). `latency` may be
// a function: then every delivery gets its own delay (messages arrive out of order).
function hub(latency = 5, lose = () => false) {
  const subs = new Map(); // id → fn
  const frozen = new Set();
  const published = [];
  return {
    frozen,
    published,
    createBus: (id) => ({
      publish: (m) => {
        if (frozen.has(id)) return;
        published.push(m);
        if (typeof latency === "function") {
          for (const [sid, fn] of subs) {
            if (sid !== id && lose(m, sid)) continue;
            const copy = structuredClone(m);
            setTimeout(() => !frozen.has(sid) && subs.get(sid) === fn && fn(copy), latency());
          }
          return;
        }
        setTimeout(() => {
          for (const [sid, fn] of subs) if (!frozen.has(sid) && !(sid !== id && lose(m, sid))) fn(structuredClone(m));
        }, latency);
      },
      onMessage: (fn) => subs.set(id, fn),
      close: () => subs.delete(id),
    }),
  };
}
const FAST = { discoveryMs: 120, beatMs: 60, silenceMs: 250, snapshotMs: 20 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function player(h, slug, n, { timing = FAST, getPack } = {}) {
  const shared = {};
  const me = { slug, anonId: `a${n}`, nick: `닉${n}` }; // the shell keeps this object: a rename updates its nick
  const statuses = [];
  let gotState = false;
  const conn = connectMesh({
    createBus: h.createBus,
    me,
    timing,
    getPack,
    onStatus: (s) => statuses.push(s.state),
    onMessage: (m) => {
      if (m.t === "state") {
        gotState = true;
        Object.assign(shared, m.d.sharedState);
      } else if (m.t === "setVar") {
        shared[m.d.id] = m.d.value;
        if (m.d.id === "sessionCountdown") countdown.push([m.d.value, Date.now()]);
      } else if (m.t === "participants") shared.participants = m.d.count;
    },
  });
  const countdown = []; // every sessionCountdown value shown, with when
  return {
    conn,
    shared,
    statuses,
    countdown,
    me,
    get gotState() {
      return gotState;
    },
    act: (name, payload) => conn.sendAction(name, payload, `${n}-${name}-${Math.random()}`),
  };
}
const hosts = (ps) => ps.filter((p) => p.conn.isHost).length;

test("players agree on one host and everyone gets the room state", async () => {
  const h = hub();
  const a = player(h, "r", 1);
  await sleep(200);
  const b = player(h, "r", 2);
  const c = player(h, "r", 3);
  await sleep(400);
  assert.equal(hosts([a, b, c]), 1);
  assert.ok(a.conn.isHost); // first in → host
  assert.ok(b.gotState && c.gotState);
  assert.deepEqual(c.shared.roster, ["닉1", "닉2", "닉3"]);
  [a, b, c].forEach((p) => p.conn.close());
});

test("a player's action goes through the host to everyone", async () => {
  const h = hub();
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const peer = ps.find((p) => !p.conn.isHost);
  peer.act("tally", { delta: 3 });
  await sleep(150);
  assert.ok(ps.every((p) => p.shared.coopTotal === 3));
  ps.forEach((p) => p.conn.close());
});

test("host leaves mid-game → the next player resumes with the scores", async () => {
  const h = hub();
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const rest = ps.filter((p) => p !== host);
  rest[0].act("start", { duration: 2000 }); // countdown 3s + play 2s → result at ~5s
  await sleep(3300);
  assert.equal(rest[0].shared.sessionPhase, "play");
  rest[0].act("tap");
  rest[0].act("tap");
  rest[1].act("tap");
  await sleep(150);
  host.conn.close();
  await sleep(400);
  assert.equal(hosts(rest), 1);
  rest[1].act("tap");
  await sleep(2500);
  assert.equal(rest[0].shared.sessionPhase, "result");
  assert.deepEqual(rest[0].shared.raceBoard.map((x) => x.score), [2, 2]);
  assert.deepEqual(rest[0].shared.raceBoard, rest[1].shared.raceBoard);
  rest.forEach((p) => p.conn.close());
});

test("rename (#104) in a mesh room: everyone sees it; the next host keeps it (snapshot + the renamed device's heartbeat)", async () => {
  const h = hub();
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const rest = ps.filter((p) => p !== host);
  const guest = rest[0];
  // what LiveApp does: the transport's identity follows, then the room action
  guest.me.nick = "민지";
  guest.act("rename", { nick: "민지" });
  await sleep(150);
  for (const p of ps) assert.ok(p.shared.roster.includes("민지"), `roster ${p.shared.roster}`);
  assert.ok(!host.shared.roster.includes(`닉${guest.me.anonId.slice(1)}`));
  host.conn.close();
  await sleep(500);
  assert.equal(hosts(rest), 1);
  for (const p of rest) assert.deepEqual(p.shared.roster.slice().sort(), ["민지", `닉${rest[1].me.anonId.slice(1)}`].sort());
  rest.forEach((p) => p.conn.close());
});

test("hand-off moves the host to the back; the old host keeps playing", async () => {
  const h = hub();
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const old = ps.find((p) => p.conn.isHost);
  old.conn.handoff();
  await sleep(300);
  assert.equal(old.conn.isHost, false);
  assert.equal(hosts(ps), 1);
  old.act("tally", { delta: 1 });
  await sleep(150);
  assert.ok(ps.every((p) => p.shared.coopTotal === 1));
  ps.forEach((p) => p.conn.close());
});

test("hand-off whose announcement is lost: the room still ends up with one host", async () => {
  // The broker drops the hand-off heartbeat (the one carrying the snapshot) for everyone —
  // the first three such messages, so a host that repeats itself gets through eventually.
  const dropped = new Set();
  const h = hub(5, (m) => {
    if (m.t !== "here" || !m.snap || (dropped.size >= 3 && !dropped.has(m))) return false;
    dropped.add(m);
    return true;
  });
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const old = ps.find((p) => p.conn.isHost);
  old.conn.handoff();
  assert.equal(old.conn.isHost, false);
  await sleep(FAST.silenceMs * 3);
  assert.ok(dropped.size >= 1, `dropped ${dropped.size}`);
  assert.equal(hosts(ps), 1, "someone hosts");
  ps.find((p) => p !== old && !p.conn.isHost).act("tally", { delta: 1 });
  assert.ok(await until(() => ps.every((p) => p.shared.coopTotal === 1), 1500), JSON.stringify(ps.map((p) => p.shared.coopTotal)));
  ps.forEach((p) => p.conn.close());
});

test("a host that quietly stops hosting (heartbeats without a line) is replaced", async () => {
  // Nothing from the old host carries a line any more and no new line ever arrives:
  // peers must not wait for silence from a host that keeps beating.
  const h = hub(5, (m) => m.t === "here" && m.snap);
  const ps = [1, 2].map((n) => player(h, "r", n));
  await sleep(400);
  const old = ps.find((p) => p.conn.isHost);
  const other = ps.find((p) => p !== old);
  old.conn.handoff(); // its follow-up announcements are dropped too (they carry the snapshot)
  assert.ok(await until(() => other.conn.isHost, FAST.silenceMs * 4), "the other player took over");
  old.act("tally", { delta: 2 });
  assert.ok(await until(() => ps.every((p) => p.shared.coopTotal === 2), 1500));
  ps.forEach((p) => p.conn.close());
});

test("a frozen host is replaced, and steps down when it wakes up", async () => {
  const h = hub();
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const rest = ps.filter((p) => p !== host);
  rest[0].act("tally", { delta: 5 });
  await sleep(150);
  h.frozen.add(host.conn.peerId); // its app is suspended: no traffic either way
  await sleep(600);
  assert.equal(hosts(rest), 1);
  rest[1].act("tally", { delta: 1 });
  await sleep(150);
  assert.equal(rest[0].shared.coopTotal, 6); // continued from the snapshot
  h.frozen.delete(host.conn.peerId); // wakes up still believing it hosts
  await sleep(300);
  assert.equal(hosts(ps), 1);
  assert.equal(host.conn.isHost, false);
  ps.forEach((p) => p.conn.close());
});

test("players arriving at the same moment still end up with one host", async () => {
  const h = hub(20);
  const ps = [1, 2, 3, 4].map((n) => player(h, "r", n));
  await sleep(600);
  assert.equal(hosts(ps), 1);
  assert.ok(ps.every((p) => p.gotState));
  ps.forEach((p) => p.conn.close());
});

test("lost room messages: peers still converge (state resend + resync)", async () => {
  const seen = new Map();
  // Drop every 3rd room batch to each receiver (the first state included, for some).
  const h = hub(5, (m, to) => {
    if (m.t !== "batch") return false;
    seen.set(to, (seen.get(to) ?? 0) + 1);
    return seen.get(to) % 3 === 0;
  });
  const ps = [1, 2, 3, 4].map((k) => player(h, "r", k));
  await sleep(500);
  const host = ps.find((p) => p.conn.isHost);
  for (let i = 0; i < 6; i++) ps[i % 4].act("tally", { delta: 1 });
  await sleep(400); // a couple of beats
  assert.ok(ps.every((p) => p.gotState), "state");
  assert.ok(ps.every((p) => p.shared.coopTotal === 6), JSON.stringify(ps.map((p) => p.shared.coopTotal)));
  assert.deepEqual(new Set(ps.map((p) => JSON.stringify(p.shared.roster))).size, 1);
  assert.ok(host);
  ps.forEach((p) => p.conn.close());
});

const until = async (fn, ms, step = 20) => {
  for (let t = 0; t < ms && !fn(); t += step) await sleep(step);
  return fn();
};
const total = (p) => (p.shared.raceBoard || []).reduce((s, e) => s + e.score, 0);

test("MP-02: 'start' tapped before the room forms is replayed when I end up hosting", async () => {
  const h = hub();
  const a = player(h, "r", 1);
  a.act("start", { duration: 2000 }); // discovery still running — no host yet
  await sleep(300);
  assert.ok(a.conn.isHost);
  assert.equal(a.shared.sessionPhase, "countdown");
  a.conn.close();
});

test("MP-02: a queued action older than 5 s is dropped, not replayed", async () => {
  const h = hub();
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const a = player(h, "r", 1, { timing: { ...FAST, discoveryMs: 200 } });
    a.act("start", { duration: 2000 });
    skew = 6000; // the device slept through discovery
    await sleep(350);
    assert.ok(a.conn.isHost);
    assert.notEqual(a.shared.sessionPhase, "countdown"); // never started (no session → no phase at all)
    a.conn.close();
  } finally {
    Date.now = realNow;
  }
});

test("nothing is published before the bus is subscribed (a slow broker connection)", async () => {
  const published = [];
  let subscribe;
  const conn = connectMesh({
    createBus: () => ({
      ready: new Promise((r) => (subscribe = r)),
      publish: (m) => published.push(m),
      onMessage: () => {},
      close: () => {},
    }),
    me: { slug: "slow", anonId: "a1", nick: "닉1" },
    timing: FAST,
    onMessage: () => {},
  });
  await sleep(FAST.beatMs * 4); // several beats' worth of time, still connecting
  assert.deepEqual(published, []);
  subscribe();
  await sleep(FAST.beatMs * 2);
  assert.ok(published.some((m) => m.t === "here"), "beats start once subscribed");
  conn.close();
});

test("a host's heartbeat ends discovery early", async () => {
  const h = hub();
  const slow = { ...FAST, discoveryMs: 1500 };
  const a = player(h, "r", 1, { timing: slow });
  await sleep(1700);
  const b = player(h, "r", 2, { timing: slow });
  assert.ok(await until(() => b.gotState, 600), "joined well before the 1.5 s discovery window");
  b.act("tally", { delta: 1 }); // and can act right away (not queued until discovery ends)
  assert.ok(await until(() => a.shared.coopTotal === 1, 400), "action applied early");
  [a, b].forEach((p) => p.conn.close());
});

test("connection status: connecting → connected (host and peer); bus failure → failed", async () => {
  const h = hub();
  const a = player(h, "r", 1);
  const b = player(h, "r", 2);
  await sleep(400);
  assert.deepEqual(a.statuses, ["connecting", "connected"]);
  assert.deepEqual(b.statuses, ["connecting", "connected"]);
  const statuses = [];
  let failBus;
  const conn = connectMesh({
    createBus: () => ({ publish() {}, onMessage() {}, close() {}, ready: new Promise(() => {}), onStatus: (fn) => (failBus = fn) }),
    me: { slug: "x", anonId: "z", nick: "" },
    timing: FAST,
    onMessage() {},
    onStatus: (s) => statuses.push(s),
  });
  failBus({ state: "failed", reason: "timeout" });
  assert.deepEqual(statuses, [{ state: "connecting" }, { state: "failed", reason: "timeout" }]);
  conn.close();
  [a, b].forEach((p) => p.conn.close());
});

test("MP-07: an eliminated player stays out through resync beats and after a reload", async () => {
  const h = hub();
  const ps = [1, 2, 3, 4].map((n) => player(h, "r", n));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const [x, y] = ps.filter((p) => p !== host);
  host.act("start", { mode: "nunchi" });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play"), 4000));
  x.act("tap");
  y.act("tap"); // together → both out
  assert.ok(await until(() => x.shared.iAmOut === true && y.shared.iAmOut === true, 1000));
  await sleep(400); // several resync beats
  assert.equal(x.shared.iAmOut, true);
  assert.equal(y.shared.iAmOut, true);
  assert.equal(host.shared.iAmOut, false);
  // x reloads: same anonId, new connection
  x.conn.close();
  const x2 = player(h, "r", ps.indexOf(x) + 1);
  assert.ok(await until(() => x2.gotState, 1000));
  await sleep(300);
  assert.equal(x2.shared.iAmOut, true);
  [...ps.filter((p) => p !== x), x2].forEach((p) => p.conn.close());
});

test("lossy broker (5% drop, random delay → reordering): exact tap counts, same boards", async () => {
  let r = 7;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const h = hub(() => 5 + rnd() * 40, () => rnd() < 0.05);
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  assert.ok(await until(() => ps.every((p) => p.gotState && p.shared.participants === 3), 3000), "room formed");
  ps[1].act("start", { duration: 2500 });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play"), 5000), "play");
  for (let k = 0; k < 8; k++) {
    ps.forEach((p) => p.act("tap"));
    await sleep(15);
  }
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "result"), 5000), "result");
  assert.ok(await until(() => ps.every((p) => total(p) === 24), 1500), JSON.stringify(ps.map(total)));
  assert.equal(new Set(ps.map((p) => JSON.stringify(p.shared.raceBoard))).size, 1);
  ps.forEach((p) => p.conn.close());
});

test("an older batch arriving late never rolls a variable back", async () => {
  // Hold back exactly one batch to one peer and deliver it after newer ones.
  const h = hub(5);
  const ps = [1, 2].map((n) => player(h, "r", n));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const peer = ps.find((p) => p !== host);
  const bus = h.createBus("spy"); // peek at the host's batches
  const batches = [];
  bus.onMessage((m) => m.t === "batch" && batches.push(m));
  peer.act("tally", { delta: 1 });
  await sleep(150);
  peer.act("tally", { delta: 1 });
  await sleep(150);
  assert.equal(peer.shared.coopTotal, 2);
  const held = batches.find((b) => b.items.some((it) => it.t === "setVar" && it.d.id === "coopTotal" && it.d.value === 1));
  assert.ok(held);
  // Replay the stale batch as the host would have sent it (same `from`, older seq).
  const fakeHost = h.createBus(host.conn.peerId);
  fakeHost.publish(held); // same `from` + older seq
  for (let t = 0; t < 10; t++) {
    await sleep(10);
    assert.equal(peer.shared.coopTotal, 2);
  }
  bus.close();
  ps.forEach((p) => p.conn.close());
});

test("snapshots go out only when something changed, and carry only recent action ids", async () => {
  const h = hub();
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const ps = [1, 2].map((n) => player(h, "r", n, { timing: { ...FAST, silenceMs: 60000 } })); // the clock jumps below
    await sleep(400);
    const snaps = () => h.published.filter((m) => m.t === "snap");
    const before = snaps().length;
    await sleep(600); // ~10 beats in the lobby: nothing changes
    assert.ok(snaps().length - before <= 1, `${snaps().length - before} snapshots while idle`);
    const peer = ps.find((p) => !p.conn.isHost);
    peer.act("tally", { delta: 1 });
    await sleep(150);
    assert.equal(snaps().length - before, 1, "a change → one snapshot");
    assert.equal(snaps().at(-1).seen.length, 1);
    skew = 20000; // long after any resend could still arrive
    peer.act("tally", { delta: 1 });
    await sleep(150);
    assert.equal(snaps().at(-1).seen.length, 1, "the old id was forgotten");
    assert.ok(snaps().at(-1).n > snaps().at(-2).n);
    ps.forEach((p) => p.conn.close());
  } finally {
    Date.now = realNow;
  }
});

test("a host from an older build (no acks): actions are sent once, never resent", async () => {
  const h = hub();
  const old = h.createBus("0-old-host"); // sorts first → founds the room
  old.onMessage(() => {});
  const beat = setInterval(() => old.publish({ from: "0-old-host", t: "here", anonId: "o", nick: "old", line: ["0-old-host"], term: 1 }), 50);
  const a = player(h, "r", 1);
  await sleep(300);
  a.act("tap");
  await sleep(1000);
  assert.equal(h.published.filter((m) => m.t === "act").length, 1);
  clearInterval(beat);
  a.conn.close();
});

test("a peer whose heartbeat was lost is never counted anonymously (taps keep its name)", async () => {
  // B's heartbeats are lost until it has sent something else (its "sync" / an action):
  // the host first hears of B through that message, without B's anonId/nick.
  let bId = null;
  let bSpoke = false;
  const h = hub(5, (m) => {
    if (m.t === "here" && m.anonId === "a2") {
      bId = m.from;
      return !bSpoke;
    }
    if (m.from && m.from === bId) bSpoke = true;
    return false;
  });
  const a = player(h, "r", 1);
  await sleep(300);
  const b = player(h, "r", 2);
  assert.ok(await until(() => a.shared.participants === 2 && b.gotState, 3000), "B joined");
  a.act("start", { duration: 1500 });
  assert.ok(await until(() => b.shared.sessionPhase === "play", 5000));
  for (let k = 0; k < 4; k++) b.act("tap");
  assert.ok(await until(() => a.shared.sessionPhase === "result", 4000));
  await sleep(200);
  assert.deepEqual(rows(a.shared.raceBoard), [{ nick: "닉2", score: 4 }]);
  assert.deepEqual(b.shared.roster, ["닉1", "닉2"]);
  [a, b].forEach((p) => p.conn.close());
});

test("countdown runs on each device's clock: a lost '2' (and a stale state mid-count) never breaks 3·2·1·0", async () => {
  // Jittery broker; to one player every message that carries the host's "2" (the setVar
  // batch and the resync beats) is lost, and a resent `state` (as after a sync / hand-over)
  // carrying a stale 3 arrives while it counts. Order is asserted; the cross-device spread
  // is a wall-clock property and is proven deterministically in countdown.test.js.
  let r = 3;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  let victim = null;
  const carries2 = (m) => m.t === "batch" && m.items.some((it) => (it.t === "setVar" && it.d.id === "sessionCountdown" && it.d.value === 2) || (it.t === "resync" && it.d.sharedState?.sessionCountdown === 2));
  const h = hub(() => 5 + rnd() * 60, (m, to) => to === victim && carries2(m));
  const ps = [1, 2, 3].map((n) => player(h, "r", n));
  assert.ok(await until(() => ps.every((p) => p.gotState && p.shared.participants === 3), 3000), "room formed");
  const host = ps.find((p) => p.conn.isHost);
  const peer = ps.find((p) => !p.conn.isHost);
  victim = peer.conn.peerId;
  host.act("start", { duration: 2000 });
  assert.ok(await until(() => peer.countdown.some(([v]) => v === 2), 3000), "the peer is counting");
  // The peer asks for the room state again (as after a lost "state"): the host resends it
  // with its current number — that must go through the driver, never show out of order.
  const asPeer = h.createBus(peer.conn.peerId); // publishes under the peer's id (never closed: it would unsubscribe the real peer)
  asPeer.publish({ from: peer.conn.peerId, t: "sync", to: host.conn.peerId });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play"), 6000), "play");
  for (const p of ps) assert.deepEqual(p.countdown.map(([v]) => v), [3, 2, 1, 0], `player ${p.conn.peerId} saw ${JSON.stringify(p.countdown)}`);
  ps.forEach((p) => p.conn.close());
});

test("snapshots stay change-gated while a game only ages (play, result)", async () => {
  const h = hub();
  const ps = [1, 2].map((n) => player(h, "r", n));
  await sleep(400);
  const snaps = () => h.published.filter((m) => m.t === "snap").length;
  ps[0].act("start", { duration: 1500 });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play"), 5000), "play");
  await sleep(100);
  const inPlay = snaps();
  await sleep(600); // ~10 beats of nothing but time passing
  assert.ok(snaps() - inPlay <= 1, `${snaps() - inPlay} snapshots while idle in play`);
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "result"), 5000), "result");
  await sleep(100);
  const inResult = snaps();
  await sleep(600);
  assert.ok(snaps() - inResult <= 1, `${snaps() - inResult} snapshots while idle in result`);
  ps.forEach((p) => p.conn.close());
});

test("MP-06: a vote the old host acked but never snapshotted still counts with the new host", async () => {
  // 눈치 배틀: votes are hidden (no broadcast). Both are acked; then every snapshot is
  // lost and the host leaves — the new host resumes from the pre-vote snapshot.
  let loseSnaps = false;
  const h = hub(5, (m) => loseSnaps && m.t === "snap");
  const getPack = async (game) => (game === "majority" ? [{ a: "민초", b: "반민초" }] : null);
  const ps = [1, 2, 3].map((n) => player(h, "r", n, { getPack }));
  await sleep(400);
  const host = ps.find((p) => p.conn.isHost);
  const [x, y] = ps.filter((p) => p !== host);
  host.act("start", { game: "majority", mode: "guess", rounds: 1, roundMs: 2500, revealMs: 1000 });
  assert.ok(await until(() => ps.every((p) => p.shared.sessionPhase === "play" && p.shared.roundNum === 1), 5000), "play");
  await sleep(100); // the round's snapshot is out
  loseSnaps = true;
  const macks = () => h.published.filter((m) => m.t === "batch").flatMap((m) => m.items).filter((it) => it.t === "mack").length;
  const before = macks();
  x.act("vote", { option: "o1" });
  y.act("vote", { option: "o1" });
  assert.ok(await until(() => macks() >= before + 2, 1000), "both votes acked");
  host.conn.close(); // …and the host is gone
  assert.ok(await until(() => hosts([x, y]) === 1, 1500), "a new host");
  assert.ok(await until(() => x.shared.roundAnswer >= 0 && y.shared.roundAnswer >= 0, 5000), "revealed");
  assert.deepEqual(x.shared.votesByOption, { o1: 2 });
  assert.deepEqual(y.shared.votesByOption, { o1: 2 });
  assert.deepEqual(x.shared.raceBoard, y.shared.raceBoard);
  assert.equal(x.shared.raceBoard.length, 2); // both scored: the hand-over lost nothing
  [x, y].forEach((p) => p.conn.close());
});
