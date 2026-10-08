import { test } from "node:test";
import assert from "node:assert/strict";
import { connectMesh } from "../src/meshClient.js";

// In-memory pub/sub with latency; a "frozen" node neither sends nor receives.
// `lose(m, to)` → true drops that delivery (a lossy public broker).
function hub(latency = 5, lose = () => false) {
  const subs = new Map(); // id → fn
  const frozen = new Set();
  return {
    frozen,
    createBus: (id) => ({
      publish: (m) => {
        if (frozen.has(id)) return;
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

function player(h, slug, n) {
  const shared = {};
  let gotState = false;
  const conn = connectMesh({
    createBus: h.createBus,
    me: { slug, anonId: `a${n}`, nick: `닉${n}` },
    timing: FAST,
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
