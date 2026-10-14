import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, slugify, statusLabelChange, STATUSES } from "../work.mjs";

test("parseArgs: positional + flags", () => {
  assert.deepEqual(parseArgs(["add", "Fix it", "--type", "bug", "--dry-run"]), { _: ["add", "Fix it"], type: "bug", "dry-run": true });
});
test("slugify: ASCII words, Korean-only falls back", () => {
  assert.equal(slugify("[Task] Exclude bots from stats"), "exclude-bots-from-stats");
  assert.equal(slugify("[Task] 자동 브라우저 제외"), "work");
});
test("statusLabelChange: swaps any old status label (with or without a space) for the target", () => {
  assert.deepEqual(statusLabelChange(["type: task", "status: backlog"], "in-progress"), { remove: ["status: backlog"], add: ["status: in-progress"] });
  assert.deepEqual(statusLabelChange(["status:done", "status: review"], "done"), { remove: ["status:done", "status: review"], add: ["status: done"] });
  assert.deepEqual(statusLabelChange(["status: done"], "done"), { remove: [], add: [] });
  assert.throws(() => statusLabelChange([], "nope"));
  assert.equal(Object.keys(STATUSES).length, 6);
});
