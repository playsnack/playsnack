// #115: a player in a room opens the share sheet / KakaoTalk to invite a friend (the page goes
// to the background, iOS freezes it and closes its WebSocket) and comes back. Expected: the
// transport gets back in on its own, with the same device identity (seat), and never reports
// "failed" for time the page spent in the background. "failed" only when reconnecting keeps
// failing for the whole budget of visible time.
// Fake clock / timers / page visibility (visibleTimer.ts PageEnv) and a fake WebSocket.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECT_TIMEOUT_MS, EdgeRoomTransport, RECONNECT_BACKOFF_MS, STALE_AFTER_HIDDEN_MS, type RoomMessage } from "../src/roomTransport.ts";
import { FROZEN_SLACK_MS, onPageBack, visibleTimeout, type PageEnv } from "../src/visibleTimer.ts";

// ── a fake page: clock, timers, visibility, window events ──
function fakePage() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const docL = new Map<string, Set<() => void>>();
  const winL = new Map<string, Set<(e: unknown) => void>>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (k: string, fn: () => void) => void (docL.get(k) ?? docL.set(k, new Set()).get(k)!).add(fn),
    removeEventListener: (k: string, fn: () => void) => void docL.get(k)?.delete(fn),
  };
  const win = {
    addEventListener: (k: string, fn: (e: unknown) => void) => void (winL.get(k) ?? winL.set(k, new Set()).get(k)!).add(fn),
    removeEventListener: (k: string, fn: (e: unknown) => void) => void winL.get(k)?.delete(fn),
  };
  const env: PageEnv = {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: t + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    doc,
    win,
  };
  /** Run the clock forward, firing due timers in order. `frozen`: timers do not run (an iOS page asleep). */
  const advance = (ms: number, { frozen = false } = {}) => {
    const end = t + ms;
    if (frozen) return void (t = end);
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      t = Math.max(t, due[1].at);
      due[1].fn();
    }
    t = end;
  };
  const setHidden = (hidden: boolean) => {
    doc.visibilityState = hidden ? "hidden" : "visible";
    for (const fn of [...(docL.get("visibilitychange") ?? [])]) fn();
  };
  const fire = (k: string, e: unknown = {}) => {
    for (const fn of [...(winL.get(k) ?? [])]) fn(e);
  };
  return { env, advance, setHidden, fire, timers };
}

// ── a fake WebSocket the test drives as the room server ──
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
  // server side
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(t: string, d: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ t, d }) });
  }
  /** The room lets this player in (as edge/room game.js hello: token, then the state). */
  admit(token = "seat-1") {
    this.open();
    this.push("token", { token });
    this.push("state", { sharedState: { sessionPhase: "lobby", roster: ["가나"] }, participants: 1 });
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

function joined(page = fakePage()) {
  FakeWS.all = [];
  store.clear();
  const me = { slug: "tpl-tap-battle~K7MNP2QRS4", anonId: "dev-anon-1", nick: "가나" };
  const t = new EdgeRoomTransport("wss://room.test", me);
  t.env = page.env;
  const states: string[] = [];
  const reasons: (string | undefined)[] = [];
  t.onMessage((m: RoomMessage) => {
    if (m.t === "conn") {
      states.push(m.d.state as string);
      reasons.push(m.d.reason as string | undefined);
    }
  });
  t.connect();
  FakeWS.all[0].admit();
  assert.deepEqual(states, ["connecting", "connected"]);
  const last = () => FakeWS.all[FakeWS.all.length - 1];
  return { t, page, states, reasons, me, last };
}

test("back from the share sheet: the socket closed in the background → reconnects at once when visible, same seat, never 'failed'", () => {
  const { t, page, states, last, me } = joined();
  page.setHidden(true);
  last().drop(); // iOS closes the socket of a page in the background
  assert.equal(t.connState, "reconnecting");
  assert.equal(FakeWS.all.length, 1, "no reconnect try while in the background");
  page.advance(10 * 60_000); // ten minutes in KakaoTalk: no deadline runs out
  assert.ok(!states.includes("failed"));
  page.setHidden(false);
  assert.equal(FakeWS.all.length, 2, "a new socket the moment the page is back");
  const ws = last();
  ws.open();
  const hello = ws.sent[0];
  assert.equal(hello.t, "hello");
  assert.equal(hello.d.anonId, me.anonId, "the same device identity: the room gives the seat back");
  assert.equal(hello.d.token, "seat-1", "with the seat token");
  ws.push("state", { sharedState: { sessionPhase: "lobby" }, participants: 2 });
  assert.equal(t.connState, "connected");
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected"]);
  t.close();
});

test("a socket that looks open after a long background (frozen by iOS) is replaced; a short one is kept", () => {
  const { t, page, states, last } = joined();
  const first = last();
  page.setHidden(true);
  page.advance(STALE_AFTER_HIDDEN_MS - 500, { frozen: true });
  page.setHidden(false);
  assert.equal(FakeWS.all.length, 1, "back after a moment: the open socket is kept");
  page.setHidden(true);
  page.advance(60_000, { frozen: true });
  page.setHidden(false);
  assert.equal(FakeWS.all.length, 2, "back after a minute: a fresh socket");
  assert.ok(first.closedByClient, "the old one is let go");
  assert.equal(t.connState, "reconnecting");
  last().admit("seat-2");
  assert.equal(t.connState, "connected");
  first.drop(4009); // the room replaces the old socket: its close is not ours any more
  assert.equal(t.connState, "connected");
  assert.ok(!states.includes("failed"));
  t.close();
});

test("pageshow from the back/forward cache and 'online' reconnect at once", () => {
  const { t, page, last } = joined();
  page.fire("pageshow", { persisted: false });
  assert.equal(FakeWS.all.length, 1, "a normal pageshow: nothing to do");
  page.fire("pageshow", { persisted: true });
  assert.equal(FakeWS.all.length, 2);
  last().admit();
  page.fire("online");
  assert.equal(FakeWS.all.length, 3);
  last().admit();
  assert.equal(t.connState, "connected");
  t.close();
});

test("a drop on screen retries at once, then with pauses; 'failed' only after the whole visible budget — background time not counted", () => {
  const { t, page, states, reasons, last } = joined();
  last().drop();
  assert.equal(t.connState, "reconnecting");
  page.advance(0);
  assert.equal(FakeWS.all.length, 2, "first try at once");
  // Every try fails (the network is gone).
  const failEvery = () => {
    const ws = last();
    if (ws.readyState === 0) ws.drop();
  };
  let visible = 0;
  for (; visible < 30_000; visible += 100) {
    failEvery();
    page.advance(100);
  }
  assert.ok(FakeWS.all.length >= 6, `kept trying (${FakeWS.all.length} sockets)`);
  assert.ok(!states.includes("failed"), "30 s of trying on screen: not failed yet");
  // Into the background for 5 minutes: none of that counts.
  page.setHidden(true);
  failEvery();
  const before = FakeWS.all.length;
  page.advance(5 * 60_000);
  assert.equal(FakeWS.all.length, before, "no tries in the background");
  assert.ok(!states.includes("failed"));
  page.setHidden(false);
  for (; visible < CONNECT_TIMEOUT_MS - 1000; visible += 100) {
    failEvery();
    page.advance(100);
  }
  assert.ok(!states.includes("failed"), "just under the budget of visible time");
  for (let i = 0; i < 30 && !states.includes("failed"); i++) {
    failEvery();
    page.advance(100);
  }
  assert.equal(states.at(-1), "failed");
  assert.equal(reasons.at(-1), "disconnected");
  // The pauses between tries follow the backoff (capped).
  assert.equal(RECONNECT_BACKOFF_MS[0], 0);
  assert.ok(Math.max(...RECONNECT_BACKOFF_MS) <= 5000);
  // retry() after that starts over.
  t.retry();
  last().admit();
  assert.equal(t.connState, "connected");
  t.close();
});

test("the room still holding the old seat (seat_taken while reconnecting) is waited out, not a failure", () => {
  const { t, page, states, last } = joined();
  last().drop();
  page.advance(0);
  const ws = last();
  ws.open();
  ws.push("denied", { reason: "seat_taken" });
  assert.equal(t.connState, "reconnecting");
  page.advance(RECONNECT_BACKOFF_MS[1]);
  last().admit();
  assert.equal(t.connState, "connected");
  assert.ok(!states.includes("failed"));
  t.close();
});

test("closed on purpose by the room (seat taken over by another tab of this device) → failed, no fight back", () => {
  const { t, states, reasons, last } = joined();
  last().drop(4009);
  assert.equal(states.at(-1), "failed");
  assert.equal(reasons.at(-1), "replaced");
  assert.equal(FakeWS.all.length, 1);
  t.close();
});

test("a first join in the background (opened the link, switched away) does not time out there", () => {
  const page = fakePage();
  FakeWS.all = [];
  const t = new EdgeRoomTransport("wss://room.test", { slug: "tpl-x~K7MNP2QRS4", anonId: "a2", nick: "나" });
  t.env = page.env;
  const states: string[] = [];
  t.onMessage((m) => m.t === "conn" && states.push(m.d.state as string));
  t.connect();
  page.setHidden(true);
  FakeWS.all[0].drop();
  page.advance(CONNECT_TIMEOUT_MS * 3);
  assert.deepEqual(states, ["connecting"]);
  page.setHidden(false);
  page.advance(0);
  FakeWS.all.at(-1)!.admit();
  assert.deepEqual(states, ["connecting", "connected"]);
  t.close();
});

test("a join that never reaches the room fails as 'unreachable' after the visible budget", () => {
  const page = fakePage();
  FakeWS.all = [];
  const t = new EdgeRoomTransport("wss://room.test", { slug: "tpl-x~K7MNP2QRS4", anonId: "a3", nick: "나" });
  t.env = page.env;
  const log: [string, string | undefined][] = [];
  t.onMessage((m) => m.t === "conn" && log.push([m.d.state as string, m.d.reason as string | undefined]));
  t.connect();
  for (let ms = 0; ms <= CONNECT_TIMEOUT_MS + 100; ms += 100) {
    const ws = FakeWS.all.at(-1)!;
    if (ws.readyState === 0) ws.drop();
    page.advance(100);
  }
  assert.deepEqual(log.at(-1), ["failed", "unreachable"]);
  t.close();
});

test("close() stops everything: no reconnect, no listeners left", () => {
  const { t, page } = joined();
  t.close();
  page.setHidden(true);
  page.setHidden(false);
  page.fire("online");
  assert.equal(FakeWS.all.length, 1);
  assert.equal(page.timers.size, 0, "no timers left behind");
});

test("visibleTimeout: counts only visible time; a timer that slept through a freeze runs its slice again", () => {
  const page = fakePage();
  let fired = 0;
  const v = visibleTimeout(() => fired++, 10_000, page.env);
  page.advance(4000);
  page.setHidden(true);
  page.advance(60_000);
  assert.equal(fired, 0);
  assert.ok(Math.abs(v.left() - 6000) < 1);
  page.setHidden(false);
  page.advance(5999);
  assert.equal(fired, 0);
  page.advance(1);
  assert.equal(fired, 1);
  // Frozen without a visibilitychange: the late fire does not count the frozen time.
  const w = visibleTimeout(() => fired++, 10_000, page.env);
  page.advance(10_000 + FROZEN_SLACK_MS + 30_000, { frozen: true });
  page.advance(0); // the page wakes: the overdue timer runs now
  assert.equal(fired, 1, "not fired on stale time");
  page.advance(10_000);
  assert.equal(fired, 2);
  w.cancel();
  const x = visibleTimeout(() => fired++, 100, page.env);
  x.cancel();
  page.advance(1000);
  assert.equal(fired, 2, "cancelled");
});

test("onPageBack: says how long the page was hidden", () => {
  const page = fakePage();
  const got: [string, number][] = [];
  const off = onPageBack((why, ms) => got.push([why, ms]), page.env);
  page.setHidden(true);
  page.advance(7000);
  page.setHidden(false);
  page.fire("online");
  off();
  page.setHidden(true);
  page.setHidden(false);
  assert.deepEqual(got, [["visible", 7000], ["online", 0]]);
});
