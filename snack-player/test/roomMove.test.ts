// #135 / #136 on the client (EdgeRoomTransport): a device that just made a friends room asks to
// organize it (the organizer is the host); a public room's hello carries the app's start payload;
// `moveTo` mid-game reconnects quietly into the next room (never "failed", never "connected"
// before that room's state), a refused next room sends it back to watch (`stay`); and the
// "10초 뒤 시작" ticker (autoStart.ts).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeRoomTransport, isNextRoom, type RoomMessage } from "../src/roomTransport.ts";
import { autoStartLeft, autoStartTicker } from "../src/autoStart.ts";
import type { PageEnv } from "../src/visibleTimer.ts";

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: { t: string; d: Record<string, unknown> }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  closedByClient = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(t: string, d: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ t, d }) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const store = new Map<string, string>();
Object.assign(globalThis, {
  WebSocket: FakeWS,
  sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
});
// A page that stays visible; only zero-delay timers run (the first reconnect try).
const env: PageEnv = {
  now: () => 0,
  setTimeout: (fn: () => void, ms: number) => (ms === 0 ? void fn() : 0), // only an immediate retry runs
  clearTimeout: () => {},
  doc: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  win: { addEventListener: () => {}, removeEventListener: () => {} },
};
const AUTO = { start: { duration: 10000 }, ms: 10000 };

function transport(slug: string, opts = {}) {
  FakeWS.all = [];
  store.clear();
  const t = new EdgeRoomTransport("wss://room.test", { slug, anonId: "dev-1", nick: "가나" }, opts);
  t.env = env;
  const seen: RoomMessage[] = [];
  t.onMessage((m) => seen.push(m));
  t.connect();
  const states = () => seen.filter((m) => m.t === "conn").map((m) => m.d.state);
  return { t, seen, states, last: () => FakeWS.all[FakeWS.all.length - 1] };
}

test("public room mid-game: moveTo → a new socket to the next room, quietly; its hello names that room and carries the start payload", () => {
  const { t, seen, states, last } = transport("tpl-tap-battle", { autoStart: AUTO });
  const first = last();
  assert.equal(first.url, "wss://room.test/room/tpl-tap-battle");
  first.open();
  assert.deepEqual(first.sent[0].d.autoStart, AUTO);
  assert.equal(first.sent[0].d.organize, undefined, "a public room is never organized");
  first.push("moveTo", { room: "tpl-tap-battle.g2" });
  assert.ok(first.closedByClient, "the old socket is let go");
  assert.equal(FakeWS.all.length, 2);
  const next = last();
  assert.equal(next.url, "wss://room.test/room/tpl-tap-battle.g2");
  assert.equal(t.roomId, "tpl-tap-battle.g2");
  first.drop(4010); // the room's close after moveTo: not ours any more
  next.open();
  assert.equal(next.sent[0].d.slug, "tpl-tap-battle.g2");
  assert.deepEqual(next.sent[0].d.autoStart, AUTO);
  assert.deepEqual(states(), ["connecting"], "still joining — no 'failed', no early 'connected'");
  assert.ok(seen.some((m) => m.t === "moved" && m.d.room === "tpl-tap-battle.g2"));
  next.push("token", { token: "seat-g2" });
  next.push("state", { sharedState: { sessionPhase: "lobby" }, participants: 1 });
  assert.deepEqual(states(), ["connecting", "connected"]);
  // a later reconnect goes back to the room it is in (with that room's seat token)
  next.drop(1006);
  assert.equal(last().url, "wss://room.test/room/tpl-tap-battle.g2");
  last().open();
  assert.equal(last().sent[0].d.token, "seat-g2");
  t.close();
});

test("the next room cannot open today (room_full_today) → back to the first room with stay: true", () => {
  const { t, states, last } = transport("tpl-tap-battle.g2", { autoStart: AUTO });
  last().open();
  last().push("moveTo", { room: "tpl-tap-battle.g3" });
  last().open();
  last().push("denied", { reason: "room_full_today" });
  const back = last();
  assert.equal(back.url, "wss://room.test/room/tpl-tap-battle.g2");
  back.open();
  assert.equal(back.sent[0].d.stay, true);
  back.push("state", { sharedState: { sessionPhase: "play", iAmSpectator: true }, participants: 3 });
  assert.deepEqual(states(), ["connecting", "connected"]);
  t.close();
});

test("moveTo anywhere but this app's next room is not followed", () => {
  const { states, last } = transport("tpl-tap-battle", { autoStart: AUTO });
  last().open();
  last().push("moveTo", { room: "tpl-other.g2" });
  assert.equal(FakeWS.all.length, 1);
  assert.deepEqual(states(), ["connecting", "failed"]);
  assert.equal(isNextRoom("tpl-a", "tpl-a.g2"), true);
  assert.equal(isNextRoom("tpl-a.g2", "tpl-a.g3"), true);
  assert.equal(isNextRoom("tpl-a.g2", "tpl-a.g2.g2"), false);
  assert.equal(isNextRoom("tpl-a~ABCDEFGH", "tpl-a~ABCDEFGH.g2"), false, "a friends room never moves");
});

test("a room this device just made asks to organize it (the organizer = the host); a reload uses the organizer token instead", () => {
  const { t, last } = transport("tpl-tap-battle~K7MNP2QRS4", { organize: true });
  last().open();
  assert.equal(last().sent[0].d.organize, true);
  last().push("organizer", { token: "org-tok" });
  last().push("state", { sharedState: {}, participants: 1 });
  last().drop(1006);
  last().open();
  assert.equal(last().sent[0].d.organizerToken, "org-tok");
  assert.equal(last().sent[0].d.organize, undefined);
  t.close();
});

test("autoStart ticker: whole seconds on this device's clock; −1 / a new phase clears it", () => {
  assert.equal(autoStartLeft(10_000, 0), 10);
  assert.equal(autoStartLeft(10_000, 9_001), 1);
  assert.equal(autoStartLeft(10_000, 10_000), 0);
  assert.equal(autoStartLeft(10_000, 12_000), 0);
  let now = 0;
  let tick: (() => void) | null = null;
  const got: number[] = [];
  const a = autoStartTicker((n) => got.push(n), { now: () => now, every: (fn) => (tick = fn), stop: () => (tick = null) });
  a.message(9_500);
  for (now = 0; now <= 10_000 && tick; now += 250) (tick as () => void)();
  assert.deepEqual(got, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.equal(tick, null, "stops at 0");
  a.message(3_000);
  a.clear();
  assert.equal(got.at(-1), 0);
  a.message(-1);
  assert.equal(got.at(-1), 0);
});
