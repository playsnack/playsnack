import { test } from "node:test";
import assert from "node:assert/strict";
import { connectMesh } from "../src/meshClient.js";

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

function player(h, slug, n, { timing = FAST } = {}) {
  const shared = {};
  const statuses = [];
  let gotState = false;
  const conn = connectMesh({
    createBus: h.createBus,
    me: { slug, anonId: `a${n}`, nick: `닉${n}` },
    timing,
    onStatus: (s) => statuses.push(s.state),
    onMessage: (m) => {
      if (m.t === "state") {
        gotState = true;
        Object.assign(shared, m.d.sharedState);
      } else if (m.t === "setVar") shared[m.d.id] = m.d.value;
      else if (m.t === "participants") shared.participants = m.d.count;
    },
  });
  return {
    conn,
    shared,
    statuses,
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
  assert.deepEqual(rest[0].shared.leaderboard, [2, 2]);
  assert.deepEqual(rest[0].shared.raceBoard, rest[1].shared.raceBoard);
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
    assert.equal(a.shared.sessionPhase, "lobby");
    a.conn.close();
  } finally {
    Date.now = realNow;
  }
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
  assert.deepEqual(a.shared.raceBoard, [{ nick: "닉2", score: 4 }]);
  assert.deepEqual(b.shared.roster, ["닉1", "닉2"]);
  [a, b].forEach((p) => p.conn.close());
});
