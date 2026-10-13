// node --test snack-server/test/   (pnpm server:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOM_ID_RE, appSlugOf, isFriendRoom, isRoomId, roomIdForApp, sumRoomsOf } from "../src/roomId.mjs";

test("room id on the wire: slug, slug~CODE, app-<hash>; nothing with slashes or non-id characters", () => {
  for (const ok of ["tpl-tap-battle", "tpl-tap-battle~K7MNP2QRS4", "app-k3j9x", "app-k3j9x~ABCDEFGH", "a.b_c"]) assert.ok(isRoomId(ok), ok);
  for (const bad of ["", "../../etc/passwd", "tpl-x/../y", "tpl x", "x".repeat(81), null, undefined, 42, "tpl-x\n"]) assert.ok(!isRoomId(bad), String(bad));
  assert.ok(!ROOM_ID_RE.test("tpl-x?room=1"));
});

test("appSlugOf / isFriendRoom", () => {
  assert.equal(appSlugOf("tpl-tap-battle~K7MNP2QRS4"), "tpl-tap-battle");
  assert.equal(appSlugOf("tpl-tap-battle"), "tpl-tap-battle");
  assert.ok(isFriendRoom("tpl-x~ABCDEFGH"));
  assert.ok(!isFriendRoom("tpl-x"));
});

test("roomIdForApp: /api/apps/:slug?room= names only a room of that app", () => {
  assert.equal(roomIdForApp("tpl-x", "tpl-x~K7MNP2QRS4"), "tpl-x~K7MNP2QRS4");
  assert.equal(roomIdForApp("tpl-x", undefined), "tpl-x");
  assert.equal(roomIdForApp("tpl-x", "tpl-y~K7MNP2QRS4"), "tpl-x", "another app's room → the public room");
  assert.equal(roomIdForApp("tpl-x", "../votes"), "tpl-x");
  assert.equal(roomIdForApp("tpl-x", ["tpl-x~A"]), "tpl-x", "array query value");
});

test("sumRoomsOf counts the public room and every friend room of one app, no others", () => {
  const rooms = new Map([
    ["tpl-x", { n: 2 }],
    ["tpl-x~K7MNP2QRS4", { n: 3 }],
    ["tpl-x~ABCDEFGH23", { n: 1 }],
    ["tpl-xy", { n: 7 }],
    ["tpl-y~K7MNP2QRS4", { n: 5 }],
  ]);
  assert.equal(sumRoomsOf(rooms, "tpl-x", (r) => r.n), 6);
  assert.equal(sumRoomsOf(rooms, "tpl-xy", (r) => r.n), 7);
  assert.equal(sumRoomsOf(rooms, "tpl-z", (r) => r.n), 0);
});
