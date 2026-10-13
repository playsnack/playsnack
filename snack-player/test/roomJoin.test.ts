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
  assert.deepEqual(sent, [{ k: "room_join", ok: true, ms: 1234, app: "tap-battle" }]);
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
    { k: "room_join", ok: false, ms: 8000, reason: "refused", app: "tap-battle" },
    { k: "room_join", ok: true, ms: 900, app: "tap-battle" },
  ]);
});

test("no outcome before leaving: nothing sent; shared apps carry no app id", () => {
  const a = setup();
  a.j.start("connect");
  a.j.end();
  a.j.conn("connected");
  assert.deepEqual(a.sent, []);
  const b = setup("app-1x2y", "app-1x2y");
  b.j.start("connect");
  b.j.conn("failed");
  assert.deepEqual(b.sent, [{ k: "room_join", ok: false, ms: 0, reason: "other" }]);
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
