// This browser's random id + own usage counters (deviceStats.ts) and the once-a-day
// `seen` report (telemetry.ts). node --import tsx --test snack-player/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DID_KEY, USAGE_KEY, ageBucket, dailySeen, deviceId, gamesBucket, madeBucket, markActive, newDeviceId, noteUsage, usesBucket,
} from "../src/deviceStats.ts";
// @ts-ignore — plain JS: the server's lists must match the client's buckets
import { USAGE_BUCKETS } from "../../api/_lib/schema.js";

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };

test("id: 128 random bits as 22 base64url chars, made once and reused", () => {
  const id = newDeviceId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newDeviceId(), id);
  assert.equal(newDeviceId(() => new Uint8Array(16).fill(255)), "_____________________w");
  const s = mem();
  const a = deviceId(s);
  assert.ok(a);
  assert.equal(deviceId(s), a, "reused");
  assert.equal(s.m.get(DID_KEY), a);
  s.m.set(DID_KEY, "garbage");
  assert.notEqual(deviceId(s), "garbage", "an invalid stored value is replaced");
});

test("id: blocked or forgetful storage → no id (never a new id per page)", () => {
  assert.equal(deviceId(null), null);
  assert.equal(deviceId(blocked), null);
  const forgetful = { getItem: () => null, setItem: () => {} };
  assert.equal(deviceId(forgetful), null);
  assert.equal(dailySeen(forgetful, "2026-10-14"), null);
  assert.equal(dailySeen(blocked, "2026-10-14"), null);
});

test("bucket edges (and the same lists as the server)", () => {
  assert.deepEqual([1, 2, 3, 4, 7, 8, 14, 15, 30, 31, 400].map(usesBucket), ["1", "2-3", "2-3", "4-7", "4-7", "8-14", "8-14", "15-30", "15-30", "31+", "31+"]);
  assert.deepEqual([0, 1, 2, 4, 5, 9, 10, 19, 20, 49, 50].map(gamesBucket), ["0", "1", "2-4", "2-4", "5-9", "5-9", "10-19", "10-19", "20-49", "20-49", "50+"]);
  assert.deepEqual([0, 1, 2, 4, 5, 99].map(madeBucket), ["0", "1", "2-4", "2-4", "5+", "5+"]);
  assert.deepEqual([0, 1, 6, 7, 29, 30, 89, 90].map(ageBucket), ["0", "1-6", "1-6", "7-29", "7-29", "30-89", "30-89", "90+"]);
  const all = (f: (n: number) => string) => [...new Set(Array.from({ length: 500 }, (_, i) => f(i)))].filter((b) => b !== "0" || f !== usesBucket);
  assert.deepEqual(all(usesBucket).sort(), [...USAGE_BUCKETS.uses.values].sort());
  assert.deepEqual(all(gamesBucket).sort(), [...USAGE_BUCKETS.games.values].sort());
  assert.deepEqual(all(madeBucket).sort(), [...USAGE_BUCKETS.made.values].sort());
  assert.deepEqual(all(ageBucket).sort(), [...USAGE_BUCKETS.age.values].sort());
});

test("local counters: active days once per KST day, games and quizzes, first day kept", () => {
  const s = mem();
  assert.equal(markActive(s, "2026-10-01").activeDays, 1);
  assert.equal(markActive(s, "2026-10-01").activeDays, 1, "same day");
  noteUsage(s, "2026-10-01", "game");
  noteUsage(s, "2026-10-03", "game");
  noteUsage(s, "2026-10-03", "made");
  const u = JSON.parse(s.m.get(USAGE_KEY)!);
  assert.deepEqual(u, { firstDay: "2026-10-01", activeDays: 2, gamesFinished: 2, quizzesMade: 1, lastActiveDay: "2026-10-03", lastReportDay: "" });
  noteUsage(blocked, "2026-10-03", "game"); // best effort: never throws
});

test("the `seen` report: once per KST day, buckets only — never the counters or anything else", () => {
  const s = mem();
  const r1 = dailySeen(s, "2026-10-01");
  assert.ok(r1);
  assert.deepEqual(Object.keys(r1).sort(), ["age", "d", "games", "k", "made", "uses"]);
  assert.deepEqual({ ...r1, d: "-" }, { k: "seen", d: "-", uses: "1", games: "0", made: "0", age: "0" });
  assert.equal(dailySeen(s, "2026-10-01"), null, "second page view the same day: nothing");
  for (let i = 0; i < 11; i++) noteUsage(s, "2026-10-02", "game");
  const r2 = dailySeen(s, "2026-11-05");
  assert.ok(r2);
  assert.equal(r2.d, r1.d, "the same browser id");
  assert.deepEqual({ uses: r2.uses, games: r2.games, made: r2.made, age: r2.age }, { uses: "2-3", games: "10-19", made: "0", age: "30-89" });
});

test("telemetry: trackDailySeen sends one `seen` a day while enabled, nothing when disabled or DNT", async () => {
  const s = mem();
  const sent: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, navigator: g.navigator };
  Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: { sendBeacon: (_u: string, b: string) => (sent.push(String(b)), true) }, configurable: true, writable: true });
  try {
    const t = await import("../src/telemetry.ts");
    t.configureTelemetry({ enabled: false });
    t.trackDailySeen();
    t.noteDeviceUsage("game");
    t.flush();
    assert.equal(sent.length, 0);
    assert.equal(s.m.size, 0, "disabled: no id, no counters written");
    t.configureTelemetry({ enabled: true });
    t.trackDailySeen();
    t.trackDailySeen();
    t.flush();
    const seen = sent.flatMap((b) => JSON.parse(b).events).filter((e: { k: string }) => e.k === "seen");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].d, s.m.get(DID_KEY));
    // DNT wins over enabled: true.
    sent.length = 0;
    s.m.clear();
    Object.defineProperty(globalThis, "navigator", { value: { doNotTrack: "1", sendBeacon: () => (sent.push("x"), true) }, configurable: true, writable: true });
    t.trackDailySeen();
    t.flush();
    assert.equal(sent.length, 0);
    assert.equal(s.m.size, 0);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: saved.localStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true, writable: true });
  }
});
