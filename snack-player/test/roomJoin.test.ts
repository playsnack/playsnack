// room_join: one event per join attempt, ms from connect()/retry() to the first outcome.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinTracker } from "../src/roomJoin.ts";
import { _resetForTest, entries } from "../src/debugLog.ts";

function setup(slug = "tpl-tap-battle", room = "tpl-tap-battle~K7MNP2QRS4") {
  let t = 1000;
  const sent: unknown[] = [];
  const j = joinTracker({ slug, room, now: () => t, send: (e) => sent.push(e) });
  return { j, sent, advance: (ms: number) => (t += ms) };
}

test("ok: ms from start to the first connected; later states are not joins", () => {
  const { j, sent, advance } = setup();
  j.start("connect");
  j.conn("connecting");
  advance(1234.4);
  j.conn("connected");
  j.conn("connected");
  j.conn("failed", "disconnected"); // a drop after joining
  assert.deepEqual(sent, [{ k: "room_join", ok: true, ms: 1234, room: "friend" }]);
});

test("via: the transport the join used rides on every outcome (and only when known)", () => {
  let t = 0;
  const sent: unknown[] = [];
  const j = joinTracker({ slug: "tpl-tap-battle", room: "tpl-tap-battle", via: "edge", now: () => t, send: (e) => sent.push(e) });
  j.start("connect");
  t += 700;
  j.conn("connected");
  j.start("retry");
  t += 15000;
  j.conn("failed", "timeout");
  assert.deepEqual(sent, [
    { k: "room_join", ok: true, ms: 700, room: "public", via: "edge" },
    { k: "room_join", ok: false, ms: 15000, room: "public", reason: "timeout", via: "edge" },
  ]);
});

test("fail: reason is the code word only; retry is a new attempt", () => {
  const { j, sent, advance } = setup();
  j.start("connect");
  advance(8000);
  j.conn("failed", "refused: Server unavailable (broker.example.test)");
  j.conn("failed", "silence"); // LiveApp's own timer firing later: same attempt, not counted again
  j.start("retry");
  advance(900);
  j.conn("connected");
  assert.deepEqual(sent, [
    { k: "room_join", ok: false, ms: 8000, room: "friend", reason: "refused" },
    { k: "room_join", ok: true, ms: 900, room: "friend" },
  ]);
});

test("no outcome before leaving: nothing sent; public room; reasons map onto the reported set", () => {
  const a = setup();
  a.j.start("connect");
  a.j.end();
  a.j.conn("connected");
  assert.deepEqual(a.sent, []);
  const b = setup("app-1x2y", "app-1x2y");
  b.j.start("connect");
  b.j.conn("failed");
  b.j.start("retry");
  b.j.conn("failed", "subscribe");
  b.j.start("retry");
  b.j.conn("failed", "silence");
  assert.deepEqual(b.sent, [
    { k: "room_join", ok: false, ms: 0, room: "public", reason: "other" },
    { k: "room_join", ok: false, ms: 0, room: "public", reason: "subscribe" },
    { k: "room_join", ok: false, ms: 0, room: "public", reason: "silence" },
  ]);
});

test("debug log gets the join timeline with the room code cut", () => {
  _resetForTest({ on: true });
  const { j, advance } = setup();
  j.start("connect");
  advance(1500);
  j.conn("connected");
  const lines = entries().map((e) => `${e.cat}:${e.msg}`);
  assert.deepEqual(lines, ["join:connect → room tpl-tap-battle~K7M…", "join:joined in 1500 ms"]);
  _resetForTest({ on: false });
});
