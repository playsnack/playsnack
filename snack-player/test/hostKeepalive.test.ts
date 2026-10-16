// #142 host keepalive (roomTransport.ts EdgeRoomTransport): only the host, only with the page on
// screen, only in the lobby / result, sends the exact text "ping" every PING_EVERY_MS (+ one at
// once when it starts / the page is back). Nobody else sends anything periodic.
// Fake clock / timers / visibility (visibleTimer.ts PageEnv) and a fake WebSocket that keeps raw frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeRoomTransport, PING_EVERY_MS, PING_TEXT } from "../src/roomTransport.ts";
import type { PageEnv } from "../src/visibleTimer.ts";

function fakePage() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const docL = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (k: string, fn: () => void) => void (docL.get(k) ?? docL.set(k, new Set()).get(k)!).add(fn),
    removeEventListener: (k: string, fn: () => void) => void docL.get(k)?.delete(fn),
  };
  const env: PageEnv = {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: t + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    doc,
    win: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const advance = (ms: number) => {
    const end = t + ms;
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
  return { env, advance, setHidden };
}

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  raw: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.raw.push(s);
  }
  close() {
    this.readyState = 3;
  }
  push(t: string, d: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ t, d }) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get pings() {
    return this.raw.filter((s) => s === PING_TEXT).length;
  }
}
const store = new Map<string, string>();
Object.assign(globalThis, {
  WebSocket: FakeWS,
  sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
});

function join({ host = false, phase = "lobby" } = {}) {
  FakeWS.all = [];
  store.clear();
  const page = fakePage();
  const t = new EdgeRoomTransport("wss://room.test", { slug: "tpl-tap-battle~K7MNP2QRS4", anonId: "dev-1", nick: "가나" });
  t.env = page.env;
  t.connect();
  const ws = FakeWS.all[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.push("token", { token: "seat-1" });
  ws.push("state", { sharedState: { sessionPhase: phase, roster: ["가나"], iAmHost: host }, participants: 1 });
  return { t, page, ws, last: () => FakeWS.all[FakeWS.all.length - 1] };
}

test("constants: the exact text, every 20 s", () => {
  assert.equal(PING_TEXT, "ping");
  assert.equal(PING_EVERY_MS, 20000);
});

test("the host in the lobby: one ping at once, then one every 20 s — exactly \"ping\" (not JSON, no newline)", () => {
  const { page, ws } = join({ host: true });
  assert.equal(ws.pings, 1, "at once");
  page.advance(PING_EVERY_MS - 1);
  assert.equal(ws.pings, 1);
  page.advance(1);
  assert.equal(ws.pings, 2);
  page.advance(10 * PING_EVERY_MS);
  assert.equal(ws.pings, 12);
  const others = ws.raw.filter((s) => s !== PING_TEXT);
  assert.ok(others.every((s) => JSON.parse(s).t === "hello"), "nothing else but the hello");
  assert.ok(ws.raw.filter((s) => s.includes("ping")).every((s) => s === "ping"), "byte for byte");
});

test("a guest never pings (nor anything periodic)", () => {
  const { page, ws } = join({ host: false });
  page.advance(30 * 60000);
  assert.equal(ws.pings, 0);
  assert.equal(ws.raw.length, 1, "the hello only");
});

test("countdown / play: no pings; back in the result → one at once and on again", () => {
  const { page, ws } = join({ host: true });
  ws.push("setVar", { id: "sessionPhase", value: "countdown" });
  const n = ws.pings;
  ws.push("setVar", { id: "sessionPhase", value: "play" });
  page.advance(5 * PING_EVERY_MS);
  assert.equal(ws.pings, n, "nothing during the game");
  ws.push("setVar", { id: "sessionPhase", value: "result" });
  assert.equal(ws.pings, n + 1, "at once in the result");
  page.advance(PING_EVERY_MS);
  assert.equal(ws.pings, n + 2);
});

test("hidden: no pings (the `away` frame says it); visible again → one at once", () => {
  const { page, ws } = join({ host: true });
  page.setHidden(true);
  const n = ws.pings;
  page.advance(2000); // < STALE_AFTER_HIDDEN_MS: the same socket on return
  assert.equal(ws.pings, n);
  page.setHidden(false);
  assert.equal(ws.pings, n + 1, "at once on visible");
  page.advance(PING_EVERY_MS);
  assert.equal(ws.pings, n + 2);
  page.setHidden(true);
  page.advance(10 * PING_EVERY_MS);
  assert.equal(ws.pings, n + 2, "none while hidden");
});

test("becomes host (hand-over) → starts; no longer host → stops", () => {
  const { page, ws } = join({ host: false });
  ws.push("setVar", { id: "iAmHost", value: true });
  assert.equal(ws.pings, 1, "at once");
  page.advance(PING_EVERY_MS);
  assert.equal(ws.pings, 2);
  ws.push("setVar", { id: "iAmHost", value: false });
  page.advance(10 * PING_EVERY_MS);
  assert.equal(ws.pings, 2);
  // other vars / participants change nothing (no extra ping)
  ws.push("setVar", { id: "iAmHost", value: true });
  const n = ws.pings;
  ws.push("participants", { count: 3 });
  ws.push("setVar", { id: "roster", value: ["a", "b"] });
  assert.equal(ws.pings, n);
});

test("socket dropped: no pings while reconnecting; the new socket's state starts them again; close() stops", () => {
  const { t, page, ws, last } = join({ host: true });
  ws.drop();
  const n = ws.pings;
  page.advance(PING_EVERY_MS * 2); // (within the reconnect budget)
  assert.equal(ws.pings, n, "the dead socket gets nothing");
  const ws2 = last();
  assert.notEqual(ws2, ws, "reconnected");
  ws2.readyState = 1;
  ws2.onopen?.();
  assert.equal(ws2.pings, 0, "not before the room let us in");
  ws2.push("state", { sharedState: { sessionPhase: "lobby", iAmHost: true }, participants: 1 });
  assert.equal(ws2.pings, 1);
  t.close();
  page.advance(PING_EVERY_MS * 5);
  assert.equal(ws2.pings, 1, "closed: stopped");
});
