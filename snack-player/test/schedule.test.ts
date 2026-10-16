// 시작 시간 예약 (#218): the shell's side (snack-player/src/schedule.ts — the room's schedule message
// on this device's clock → startAt / startIn / startAtText) and the 10 session templates' lobby:
// the countdown "m:ss 뒤 시작!" (lime + pulse in the last minute, still with reduced motion), the
// host's "⏰ 시작 시간 정하기" / "예약 취소", "지금 시작" — friends rooms only, inside the frame.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, checkLayout, computeScene, initLayout } from "../../packages/bite-layout/src/index.js";
import { clockText, mmss, msUntilClock, scheduleOk, scheduleTicker, scheduleVars, SCHEDULE_MAX_MS, SCHEDULE_PRESETS_MIN } from "../src/schedule.ts";
import { HOST_ACTIONS } from "../../packages/snack-room/src/actions.js";
import { SCHEDULE_MIN_MS as ROOM_MIN, SCHEDULE_MAX_MS as ROOM_MAX } from "../../packages/snack-room/src/room.js";
import { SCHEDULE_MIN_MS } from "../src/schedule.ts";

test("the shell's limits are the room's; presets 1/3/5/10분", () => {
  assert.equal(SCHEDULE_MIN_MS, ROOM_MIN);
  assert.equal(SCHEDULE_MAX_MS, ROOM_MAX);
  assert.deepEqual([...SCHEDULE_PRESETS_MIN], [1, 3, 5, 10]);
  assert.ok(HOST_ACTIONS.schedule && HOST_ACTIONS.unschedule);
  for (const m of SCHEDULE_PRESETS_MIN) assert.equal(scheduleOk(m * 60_000), true);
  assert.equal(scheduleOk(5000), false, "too soon");
  assert.equal(scheduleOk(5000, 1000), true, "a test room's lower minimum");
  assert.equal(scheduleOk(SCHEDULE_MAX_MS + 1), false);
  assert.equal(scheduleOk(null), false);
});

test("clock time: today, or tomorrow once it passed — never more than 24 h", () => {
  const now = new Date(2026, 9, 16, 20, 10, 30).getTime(); // 20:10:30 local
  assert.equal(msUntilClock("20:30", now), 19 * 60_000 + 30_000);
  assert.equal(msUntilClock("20:10", now), 24 * 3600_000 - 30_000, "already passed (by 30 s): tomorrow");
  assert.equal(msUntilClock("9:05", now), (24 * 60 - (20 * 60 + 10) + 9 * 60 + 5) * 60_000 - 30_000);
  for (const bad of ["", "25:00", "12:60", "8pm", "12:5"]) assert.equal(msUntilClock(bad, now), null, bad);
  for (const hh of ["00:00", "20:11", "23:59"]) assert.ok(scheduleOk(msUntilClock(hh, now)), hh);
});

test("clock text: the device's locale; 내일 when not today", () => {
  const now = new Date(2026, 9, 16, 20, 10).getTime();
  assert.equal(clockText(new Date(2026, 9, 16, 20, 30).getTime(), now, "ko-KR"), "오후 8:30");
  assert.equal(clockText(new Date(2026, 9, 17, 9, 0).getTime(), now, "ko-KR"), "내일 오전 9:00");
  assert.equal(clockText(new Date(2026, 9, 16, 20, 30).getTime(), now, "en-US"), "8:30 PM");
  assert.equal(mmss(125), "2:05");
  assert.equal(mmss(42), "0:42");
});

test("scheduleVars: the room's message on this device's clock", () => {
  const now = new Date(2026, 9, 16, 20, 0).getTime();
  assert.deepEqual(scheduleVars({ on: true, endsIn: 125_000, due: false }, now, "ko-KR"), { startAt: now + 125_000, startIn: 125, startAtText: "오후 8:02" });
  assert.deepEqual(scheduleVars({ on: true, endsIn: 124_200 }, now, "ko-KR").startIn, 125, "whole seconds, rounded up");
  assert.equal(scheduleVars({ on: true, endsIn: -4000, due: true }, now).startIn, 0, "due: not counting");
  assert.ok(scheduleVars({ on: true, endsIn: -4000, due: true }, now).startAt > 0, "…still scheduled (waiting for a 2nd)");
  assert.deepEqual(scheduleVars({ on: false, endsIn: -1 }, now), { startAt: 0, startIn: 0, startAtText: "" });
  assert.deepEqual(scheduleVars({}, now), { startAt: 0, startIn: 0, startAtText: "" });
});

test("ticker: counts startIn down on this device's clock, stops at 0; clear() = nothing scheduled; a resend keeps the time steady", () => {
  let t = new Date(2026, 9, 16, 20, 0).getTime();
  const fns: (() => void)[] = [];
  const got: Record<string, unknown>[] = [];
  const k = scheduleTicker((v) => got.push(v), { now: () => t, every: (fn) => (fns.push(fn), fns.length), stop: () => fns.splice(0), locale: "ko-KR" });
  k.message({ on: true, endsIn: 3000, due: false });
  assert.deepEqual(got.at(-1), { startAt: t + 3000, startIn: 3, startAtText: "오후 8:00" });
  const at = t + 3000;
  t += 1000;
  fns[0]();
  assert.deepEqual(got.at(-1), { startIn: 2 }, "only what changed");
  t += 200;
  k.message({ on: true, endsIn: 1830, due: false }); // a rejoin: 30 ms of network later
  assert.equal(k.vars.startAt, at, "steady");
  t = at;
  fns[0]();
  assert.equal(k.vars.startIn, 0);
  assert.equal(fns.length, 0, "stopped");
  k.message({ on: true, endsIn: -10, due: true });
  assert.equal(k.vars.startIn, 0);
  k.clear();
  assert.deepEqual(k.vars, { startAt: 0, startIn: 0, startAtText: "" });
});

// ── the session templates, rendered ──
const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")) as { id: string; mode: string; hidden?: boolean; template?: string }[];
const SESSION = index.filter((t) => t.mode === "multi" && !t.hidden && !t.template).map((t) => t.id)
  .filter((id) => "sessionPhase" in (JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8")).vars ?? {}));
type Box = { x: number; y: number; w: number; h: number };
type Inst = { key: string; kind?: string; node?: { id?: string }; source?: { id?: string }; style?: Record<string, unknown>; text?: { lines: { text: string; width: number }[]; lineHeight: number }; tap?: unknown; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }
const ready = initLayout();
async function render(id: string, vars: Record<string, unknown>) {
  await ready;
  const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
  let t = 0;
  const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
  const emits: { name: string; payload?: unknown }[] = [];
  app.on("emit", (e: { name: string; payload?: unknown }) => emits.push(e));
  app.start();
  app.setVars(vars);
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  const { root } = computeScene(doc, app);
  const boxes = absBoxes(root, new Map()) as Map<string, Box>;
  const byId = new Map<string, { inst: Inst; box: Box; text: string; lines: number; width: number }>();
  for (const inst of walk(root as unknown as Inst)) {
    // a component instance goes by its `use` node's id (its text = the texts inside it)
    const id = inst.source?.id ?? inst.node?.id;
    if (!id || byId.has(id)) continue;
    const lines = [...walk(inst)].flatMap((x) => x.text?.lines?.filter((l) => l.text.trim()) ?? []);
    byId.set(id, { inst, box: boxes.get(inst.key)!, text: lines.map((l) => l.text).join(""), lines: lines.length, width: lines.length ? Math.max(...lines.map((l) => l.width)) : 0 });
  }
  const issues = checkLayout(root, doc.frame) as { where: string; kind: string; detail: string }[];
  return { doc, app, byId, issues, emits };
}
const isQuiz = (id: string) => id === "speed-trivia-score";
const roster2 = ["하늘", "바다"];
const hostVars = (id: string, extra: Record<string, unknown>) => ({
  sessionPhase: "lobby", roomMode: "host", roster: roster2, participants: 2, hostNick: "하늘", iAmHost: true,
  ...(isQuiz(id) ? { quizInfo: { title: "", count: 0, custom: false, about: "", answerMs: 9000, packId: null, subjectHere: true } } : {}),
  ...extra,
});
const SCHEDULED = { startAt: 1_800_000_000_000, startIn: 125, startAtText: "오후 8:30" };
// Lobby blocks that must not overlap each other (the shell's quiz invite band stays at its place).
const BLOCKS = ["lobbyCard", "lobbyIntro", "lobbyHint", "lobbyStatus", "schedCard", "schedBtn", "startBtn", "startWait", "waitBtn", "inviteBand"];
const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
function laidOut(id: string, r: Awaited<ReturnType<typeof render>>, what: string) {
  const bad = r.issues.filter((x) => x.kind !== "overflow-parent" || /^sched/.test(x.where));
  assert.deepEqual(bad.filter((x) => /sched|start|wait|lobby|invite/.test(x.where)), [], `${id} ${what}: layout lint`);
  const shown = BLOCKS.map((b) => [b, r.byId.get(b)] as const).filter(([, x]) => x && x.box.h > 0);
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) assert.ok(!overlap(shown[i][1]!.box, shown[j][1]!.box), `${id} ${what}: ${shown[i][0]} overlaps ${shown[j][0]}`);
  }
  for (const [b, x] of shown) assert.ok(x!.box.y + x!.box.h <= r.doc.frame[1] - 34 + 0.5, `${id} ${what}: ${b} above the home indicator (${x!.box.y + x!.box.h})`);
  if (isQuiz(id)) assert.equal(r.byId.get("inviteBand")!.box.y, 758, `${id} ${what}: the invite band stays where the shell puts its button`);
}

test("session templates found", () => assert.equal(SESSION.length, 10, SESSION.join(",")));
for (const id of SESSION) {
  test(`${id}: the host's lobby — "⏰ 시작 시간 정하기" opens the shell's sheet; scheduled: the countdown, "예약 취소", "지금 시작"`, async () => {
    const idle = await render(id, hostVars(id, {}));
    assert.ok(["startAt", "startIn", "startAtText", "reduceMotion"].every((k) => k in idle.doc.vars), "declares the schedule vars");
    assert.equal(idle.byId.get("schedCard"), undefined, "no countdown before a schedule");
    assert.equal(idle.byId.get("schedBtn")?.text, "⏰ 시작 시간 정하기");
    assert.equal(idle.byId.get("startBtn")?.text, "시작하기 🚀");
    laidOut(id, idle, "host idle");
    idle.app.tap("schedBtn");
    assert.deepEqual(idle.emits.at(-1), { name: "scheduleOpen", payload: undefined }, "the shell's event");

    const r = await render(id, hostVars(id, SCHEDULED));
    const main = r.byId.get("schedMain")!;
    assert.equal(main.text, "2:05 뒤 시작!");
    assert.equal(main.lines, 1);
    assert.equal(r.byId.get("schedSub")?.text, "오후 8:30 시작 · 지금 2명");
    assert.equal(r.byId.get("schedBtn")?.text, "예약 취소");
    assert.equal(r.byId.get("startBtn")?.text, "지금 시작 🚀");
    assert.equal(r.byId.get("schedCard")!.inst.style!.fill, "#16181c", "over a minute: the plain card");
    laidOut(id, r, "host scheduled");
    r.app.tap("schedBtn");
    assert.deepEqual(r.emits.at(-1), { name: "unschedule", payload: undefined });
  });

  test(`${id}: the last minute — lime card (black text), pulsing unless reduced motion; a guest sees it too`, async () => {
    for (const startIn of [42, 41]) {
      const r = await render(id, hostVars(id, { ...SCHEDULED, startIn, iAmHost: false }));
      const c = r.byId.get("schedCard")!;
      assert.equal(c.inst.style!.fill, "#d9ff00");
      assert.equal(r.byId.get("schedMain")!.inst.style!.color, "#0b0c0e", "black on lime");
      assert.equal(c.inst.style!.opacity, startIn % 2 ? 0.78 : 1, "a 1 s pulse");
      assert.equal(r.byId.get("schedMain")!.text, `0:${startIn} 뒤 시작!`);
      assert.equal(r.byId.get("schedBtn"), undefined, "a guest has no host controls");
      laidOut(id, r, "guest hot");
      const still = await render(id, hostVars(id, { ...SCHEDULED, startIn, iAmHost: false, reduceMotion: true }));
      assert.equal(still.byId.get("schedCard")!.inst.style!.opacity, 1, "reduced motion: no pulse");
    }
  });

  test(`${id}: a guest's wait line; the time came alone → "친구가 오면 바로 시작해요"`, async () => {
    const guest = await render(id, hostVars(id, { ...SCHEDULED, iAmHost: false }));
    const wait = guest.byId.get(isQuiz(id) ? "waitBtn" : "startWaitMain")?.text ?? "";
    assert.equal(wait, "시간이 되면 저절로 시작해요");
    laidOut(id, guest, "guest scheduled");
    const due = await render(id, hostVars(id, { ...SCHEDULED, startIn: 0, roster: ["하늘"], participants: 1 }));
    assert.equal(due.byId.get("schedMain")?.text, "친구가 오면 바로 시작해요");
    assert.equal(due.byId.get("schedSub")?.text, "한 명 더 오면 3·2·1 바로 시작");
    laidOut(id, due, "host due alone");
  });

  test(`${id}: public rooms never show it (and the #143 subtitle stays)`, async () => {
    for (const mode of ["auto", ""]) {
      const r = await render(id, hostVars(id, { ...SCHEDULED, roomMode: mode, iAmHost: false }));
      assert.equal(r.byId.get("schedCard"), undefined, mode);
      assert.equal(r.byId.get("schedBtn"), undefined, mode);
      assert.equal(r.byId.get("sub")?.text, mode === "auto" ? "🌐 누구나 함께하는 방 · 2명 모이면 시작" : "대기실");
    }
  });
}

test("나 맞히기: the quiz subject is the host — they get the controls, the room's host does not", async () => {
  const quiz = { title: "하늘 퀴즈", count: 5, custom: true, about: "하늘", answerMs: 9000, packId: "p", subjectHere: true };
  const subject = await render("speed-trivia-score", hostVars("speed-trivia-score", { ...SCHEDULED, quizInfo: quiz, iAmSubject: true, iAmHost: false }));
  assert.equal(subject.byId.get("schedBtn")?.text, "예약 취소");
  assert.equal(subject.byId.get("startBtn")?.text, "지금 시작 🚀");
  laidOut("speed-trivia-score", subject, "subject scheduled");
  const host = await render("speed-trivia-score", hostVars("speed-trivia-score", { ...SCHEDULED, quizInfo: quiz, iAmSubject: false, iAmHost: true }));
  assert.equal(host.byId.get("schedBtn"), undefined);
  assert.equal(host.byId.get("waitBtn")?.text, "시간이 되면 저절로 시작해요");
  laidOut("speed-trivia-score", host, "host (not subject) scheduled");
});
