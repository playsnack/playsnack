// #135 / #136 on the client (EdgeRoomTransport): a device that just made a friends room asks to
// organize it (the organizer is the host); a public room's hello carries the app's start payload;
// `moveTo` mid-game reconnects quietly into the next room (never "failed", never "connected"
// before that room's state), a refused next room sends it back to watch (`stay`); and the
// "10초 뒤 시작" ticker (autoStart.ts).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeRoomTransport, isNextRoom, LONE_RETURN_MS, type RoomMessage } from "../src/roomTransport.ts";
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

function transport(slug: string, opts = {}, pageEnv: PageEnv = env) {
  FakeWS.all = [];
  store.clear();
  const t = new EdgeRoomTransport("wss://room.test", { slug, anonId: "dev-1", nick: "가나" }, opts);
  t.env = pageEnv;
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

// A page clock whose timers run when the test says so (the lone-return wait, #141).
function clockEnv() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const pageEnv: PageEnv = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++seq, { at: now + ms, fn }), seq),
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    doc: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
    win: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const run = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { pageEnv, run };
}
const BASE = "wss://room.test/room/tpl-tap-battle";
const G2 = "wss://room.test/room/tpl-tap-battle.g2";

/** Opened the link's room, was moved to .g2 mid-game, and is in there now (its state as given). */
function movedToG2(state: Record<string, unknown>) {
  const { pageEnv, run } = clockEnv();
  const x = transport("tpl-tap-battle", { autoStart: AUTO }, pageEnv);
  x.last().open();
  x.last().push("moveTo", { room: "tpl-tap-battle.g2" });
  x.last().open();
  x.last().push("state", state);
  assert.equal(x.t.roomId, "tpl-tap-battle.g2");
  return { ...x, run };
}

test("#141: alone in the room a public room moved us to → after LONE_RETURN_MS back to the link's room (a friend opening the link lands there)", () => {
  const { t, states, last, run } = movedToG2({ sharedState: { sessionPhase: "lobby" }, participants: 1 });
  const g2 = last();
  run(LONE_RETURN_MS - 1);
  assert.equal(last(), g2, "not yet");
  run(1);
  const home = last();
  assert.notEqual(home, g2);
  assert.ok(g2.closedByClient);
  assert.equal(home.url, BASE);
  assert.equal(t.roomId, "tpl-tap-battle");
  home.open();
  assert.equal(home.sent[0].d.slug, "tpl-tap-battle");
  assert.deepEqual(home.sent[0].d.autoStart, AUTO);
  assert.equal(home.sent[0].d.stay, undefined);
  home.push("state", { sharedState: { sessionPhase: "lobby", roster: ["가나", "다라"] }, participants: 2 });
  run(5 * LONE_RETURN_MS);
  assert.equal(last(), home, "in the link's room: stays (whoever else is there)");
  assert.deepEqual(states(), ["connecting", "connected"], "quietly — never failed or reconnecting");
  t.close();
});

test("#141: back at the link's room while its game still runs → moved to the same next room again (and back once alone there a while)", () => {
  const { t, states, last, run } = movedToG2({ sharedState: { sessionPhase: "lobby" }, participants: 1 });
  run(LONE_RETURN_MS);
  last().open();
  last().push("moveTo", { room: "tpl-tap-battle.g2" }); // still mid-game there
  const g2 = last();
  assert.equal(g2.url, G2);
  g2.open();
  assert.equal(g2.sent[0].d.slug, "tpl-tap-battle.g2");
  g2.push("state", { sharedState: { sessionPhase: "lobby" }, participants: 1 });
  run(LONE_RETURN_MS);
  assert.equal(last().url, BASE, "alone again: tries the link's room again");
  assert.deepEqual(states(), ["connecting", "connected"]);
  t.close();
});

test("#141: two in the moved room — or a game running there — never sends anyone back", () => {
  const { t, last, run } = movedToG2({ sharedState: { sessionPhase: "lobby" }, participants: 2 });
  const g2 = last();
  run(3 * LONE_RETURN_MS);
  assert.equal(last(), g2, "two here: the countdown is theirs");
  g2.push("setVar", { id: "sessionPhase", value: "countdown" });
  g2.push("participants", { count: 1 }); // the other one left mid-game
  run(3 * LONE_RETURN_MS);
  assert.equal(last(), g2, "a game running: stays");
  g2.push("setVar", { id: "sessionPhase", value: "result" });
  run(LONE_RETURN_MS - 1);
  assert.equal(last(), g2);
  g2.push("participants", { count: 2 }); // someone came: the wait starts over
  run(3 * LONE_RETURN_MS);
  assert.equal(last(), g2);
  g2.push("participants", { count: 1 });
  run(LONE_RETURN_MS);
  assert.equal(last().url, BASE, "alone after the result: back to the link's room");
  t.close();
});

test("#141: the link's room refuses us on the way back (today's guard) → back to wait in the moved room, not 'failed'", () => {
  const { t, states, last, run } = movedToG2({ sharedState: { sessionPhase: "lobby" }, participants: 1 });
  run(LONE_RETURN_MS);
  last().open();
  last().push("denied", { reason: "room_full_today" });
  const g2 = last();
  assert.equal(g2.url, G2);
  g2.open();
  assert.equal(g2.sent[0].d.stay, undefined, "waits to play there, not to watch");
  g2.push("state", { sharedState: { sessionPhase: "lobby" }, participants: 1 });
  assert.deepEqual(states(), ["connecting", "connected"]);
  t.close();
});

test("#141: a room we only watch (stay) or the link's own room never send us anywhere", () => {
  const { pageEnv, run } = clockEnv();
  const a = transport("tpl-tap-battle", { autoStart: AUTO }, pageEnv);
  a.last().open();
  a.last().push("state", { sharedState: { sessionPhase: "lobby" }, participants: 1 });
  run(5 * LONE_RETURN_MS);
  assert.equal(FakeWS.all.length, 1, "alone in the link's room: waits there");
  a.t.close();
  const b = transport("tpl-tap-battle", { autoStart: AUTO }, pageEnv);
  b.last().open();
  b.last().push("moveTo", { room: "tpl-tap-battle.g2" });
  b.last().open();
  b.last().push("denied", { reason: "room_full_today" });
  b.last().open();
  b.last().push("state", { sharedState: { sessionPhase: "result" }, participants: 1 });
  const n = FakeWS.all.length;
  run(5 * LONE_RETURN_MS);
  assert.equal(FakeWS.all.length, n, "watching in the link's room (stay): stays");
  b.t.close();
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
