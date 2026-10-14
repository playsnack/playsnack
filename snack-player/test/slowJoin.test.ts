// A slow public broker (live 2026-10-14: "connack timeout" twice, ~20 s to get in): the
// serverless join keeps trying, says so after SLOW_JOIN_MS, fails only at the deadline,
// counts its broker tries for room_join, and retry() still works.
// MeshTransport runs for real here against the local test broker (aedes) that swallows
// the first N CONNECTs; broker / join timings are scaled down (ms instead of seconds).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { startLocalBroker } from "../../packages/snack-room/tools/localBroker.js";
import { CONNECT_TIMEOUT_MS, MeshTransport, type RoomMessage } from "../src/roomTransport.ts";
import { SLOW_JOIN_MS, joinTracker, slowJoinText } from "../src/roomJoin.ts";
import { JOIN_BUDGET_MS, CONNACK_TIMEOUT_MS } from "@snack/room/mqtt-bus";
import { _resetForTest, entries } from "../src/debugLog.ts";

// EngineTransport listens for the tab going to the background.
Object.assign(globalThis, { document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms: number, step = 25) => {
  for (let t = 0; t < ms && !fn(); t += step) await sleep(step);
  return fn();
};

// One try waits 400 ms for CONNACK, the next starts 100 ms later.
const BUS = { connectTimeoutMs: 400, reconnectMs: 100 };

function player(url: string, room: string, n: number, tuning: ConstructorParameters<typeof MeshTransport>[4]) {
  const me = { slug: room, anonId: `anon${n}`, nick: `느림${n}` };
  const t = new MeshTransport(me, url, async () => null, false, tuning);
  const log: { at: number; m: RoomMessage }[] = [];
  const t0 = Date.now();
  let people = 0;
  t.onMessage((m) => {
    log.push({ at: Date.now() - t0, m });
    if (m.t === "state" && typeof m.d.participants === "number") people = m.d.participants;
    else if (m.t === "participants") people = m.d.count as number;
  });
  const conns = () => log.filter((x) => x.m.t === "conn").map((x) => x.m.d.state);
  const tries = () => Math.max(0, ...log.filter((x) => x.m.t === "connAttempt").map((x) => Number(x.m.d.n)));
  return { t, log, conns, tries, people: () => people, at: (state: string) => log.find((x) => x.m.t === "conn" && x.m.d.state === state)?.at };
}

test("timings: the join budget covers ≈ 4 slow broker tries and fits inside the transport's deadline", () => {
  assert.ok(JOIN_BUDGET_MS >= 40_000 && JOIN_BUDGET_MS <= 45_000, `bus budget ${JOIN_BUDGET_MS}`);
  assert.ok(CONNACK_TIMEOUT_MS >= 8_000 && CONNACK_TIMEOUT_MS <= 12_000);
  assert.ok(Math.floor(JOIN_BUDGET_MS / (CONNACK_TIMEOUT_MS + 2000)) >= 3, "at least 3 full tries + a 4th");
  // The bus gives up first (its reason is reported); discovery + the room state still fit.
  assert.ok(CONNECT_TIMEOUT_MS >= JOIN_BUDGET_MS + 1500 && CONNECT_TIMEOUT_MS <= 46_000, `transport ${CONNECT_TIMEOUT_MS}`);
  assert.ok(SLOW_JOIN_MS === 6000);
});

test("the slow line: nothing before 6 s, then the calm text with whole seconds", () => {
  assert.equal(slowJoinText(0), null);
  assert.equal(slowJoinText(5999), null);
  assert.equal(slowJoinText(6000), "연결이 느려요 · 계속 시도하는 중… 6초");
  assert.equal(slowJoinText(23_456), "연결이 느려요 · 계속 시도하는 중… 23초");
  assert.equal(slowJoinText(Number.NaN), null);
});

test("join tracker: broker tries and a slow start ride on room_join (and the test log)", () => {
  _resetForTest({ on: true });
  let t = 0;
  const sent: unknown[] = [];
  const j = joinTracker({ slug: "tpl-tap-battle", room: "tpl-tap-battle~K7MNP2QRS4", now: () => t, send: (e) => sent.push(e) });
  j.start("connect");
  j.attempt(1);
  t = 10_000;
  j.attempt(2, "connack timeout");
  t = 20_000;
  j.attempt(3, "connack timeout");
  t = 23_100;
  j.conn("connected");
  // A fast join: 1 try, no slow flag. A failure never carries `slow`.
  j.start("retry");
  j.attempt(1);
  t += 800;
  j.conn("connected");
  j.start("retry");
  for (let n = 1; n <= 30; n++) j.attempt(n);
  t += 45_000;
  j.conn("failed", "timeout");
  assert.deepEqual(sent, [
    { k: "room_join", ok: true, ms: 23_100, room: "friend", tries: 3, slow: true },
    { k: "room_join", ok: true, ms: 800, room: "friend", tries: 1 },
    { k: "room_join", ok: false, ms: 45_000, room: "friend", reason: "timeout", tries: 20 },
  ]);
  const lines = entries().map((e) => e.msg);
  assert.ok(lines.includes("broker try 2 at 10000 ms (previous: connack timeout)"), lines.join("\n"));
  assert.ok(lines.includes("joined in 23100 ms (3 tries, after a slow start)"), lines.join("\n"));
  assert.ok(lines.includes("failed after 45000 ms (timeout, 20 tries)"), lines.join("\n"));
  _resetForTest({ on: false });
});

test("MeshTransport: 2 swallowed CONNECTs each → both players still join the friends room (2명)", async () => {
  const b = await startLocalBroker({ dropConnects: 4 });
  const room = "tpl-tap-battle~SLOW2";
  const tuning = { bus: { ...BUS, failAfterMs: 4000 }, connectTimeoutMs: 6000 };
  const ps = [1, 2].map((n) => player(b.url, room, n, tuning));
  ps.forEach((p) => p.t.connect());
  try {
    assert.ok(await until(() => ps.every((p) => p.people() === 2), 8000), JSON.stringify(ps.map((p) => [p.conns(), p.tries(), p.people()])));
    assert.equal(b.stats.droppedConnects, 4);
    for (const p of ps) {
      assert.deepEqual(p.conns(), ["connecting", "connected"]);
      assert.ok(p.tries() >= 2, `tries ${p.tries()}`);
      // "connected" only with the room state — never before it.
      const firstState = p.log.findIndex((x) => x.m.t === "state");
      const connected = p.log.findIndex((x) => x.m.t === "conn" && x.m.d.state === "connected");
      assert.ok(firstState > 0 && connected === firstState - 1, `connected (#${connected}) comes right with the room state (#${firstState})`);
    }
    assert.equal(ps[0].tries() + ps[1].tries(), 6, "4 swallowed + 2 answered");
  } finally {
    ps.forEach((p) => p.t.close());
    await sleep(100);
    await b.close();
  }
});

test("MeshTransport: a broker that never answers → 'connecting' for the whole budget, then failed; retry() then joins", async () => {
  const b = await startLocalBroker({ dropConnects: 1000 });
  const tuning = { bus: { ...BUS, failAfterMs: 1500 }, connectTimeoutMs: 2500 };
  const p = player(b.url, "tpl-tap-battle~NEVER", 1, tuning);
  p.t.connect();
  try {
    await sleep(1300);
    assert.deepEqual(p.conns(), ["connecting"], "still trying before the budget is spent");
    assert.ok(await until(() => p.conns().includes("failed"), 3000));
    const failedAt = p.at("failed")!;
    assert.ok(failedAt >= 1500 && failedAt < 2100, `failed at ${failedAt} ms (bus budget 1500)`);
    assert.equal(p.log.find((x) => x.m.t === "conn" && x.m.d.state === "failed")!.m.d.reason, "timeout");
    assert.ok(p.tries() >= 3, `tries ${p.tries()}`);
    const tries = b.stats.connects;
    await sleep(600);
    assert.equal(b.stats.connects, tries, "no tries after failing");
  } finally {
    await b.close();
  }
  // The broker is back (answers now): "다시 시도" joins.
  const b2 = await startLocalBroker({ port: Number(new URL(b.url).port) });
  try {
    p.t.retry();
    assert.ok(await until(() => p.conns().at(-1) === "connected", 4000), JSON.stringify(p.conns()));
    assert.deepEqual(p.conns(), ["connecting", "failed", "connecting", "connected"]);
    assert.equal(p.people(), 1);
  } finally {
    p.t.close();
    await sleep(100);
    await b2.close();
  }
});
