// The result screen → telemetry path (ResultExtras.tsx reportResultEvent): the
// controller hands each report with this game's key; telemetry.ts turns it into
// ask_shown / ask_answer / share events, once per game, without the key or room code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_DELAY_MS, createResultController, type ResultEvent } from "../src/resultController.ts";
import { configureTelemetry, flush, trackResultEvent } from "../src/telemetry.ts";
import { duo } from "./fixtures/quizResult.ts";

const ROOM = "tpl-speed-trivia-score~ABCDEFGH23";

test("result screen reports reach the wire as ask_shown / ask_answer / share, keyed per game", async () => {
  const bodies: string[] = [];
  Object.defineProperty(globalThis, "navigator", { value: { sendBeacon: (_u: string, b: string) => (bodies.push(b), true) }, configurable: true, writable: true });
  configureTelemetry({ enabled: true });
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 1;
  const keys: string[] = [];
  const ctrl = createResultController({
    roomId: ROOM,
    myNick: () => "지은",
    canMake: () => false,
    setVar: () => {},
    report: (e: ResultEvent, gameKey: string) => { keys.push(gameKey); trackResultEvent(e, ROOM, gameKey); },
    store: () => ({ asked: () => false, markAsked: () => {} }),
    makeImage: async () => new Blob(["png"]),
    shareImage: async () => "shared",
    showPreview: () => {},
    say: () => {},
    invite: () => {},
    makeQuiz: () => false,
    setTimer: (fn, ms) => { const h = id++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  const result = (sessionNo: number) => ({ sessionPhase: "result", quizRecap: duo.quizRecap, raceBoard: duo.raceBoard, roster: duo.roster, quizInfo: duo.quizInfo, sessionNo });

  ctrl.update(result(1));
  advance(ASK_DELAY_MS);
  ctrl.event("reactionAnswer", { answer: "no" });
  ctrl.event("reactionReason", { reason: "laggy" });
  ctrl.event("resultShare");
  await new Promise((r) => setImmediate(r));
  ctrl.update({ sessionPhase: "lobby" });
  ctrl.update(result(2)); // the next game asks again
  advance(ASK_DELAY_MS);
  ctrl.event("reactionAnswer", { answer: "skip" });
  ctrl.dispose();
  flush();

  assert.deepEqual(keys, [`${ROOM}#1`, `${ROOM}#1`, `${ROOM}#1`, `${ROOM}#2`, `${ROOM}#2`]);
  const evs = bodies.flatMap((b) => JSON.parse(b).events);
  assert.deepEqual(evs, [
    { k: "ask_shown", app: "speed-trivia-score" },
    { k: "ask_answer", app: "speed-trivia-score", a: "no", why: "laggy" },
    { k: "share", method: "web", what: "result", app: "speed-trivia-score" },
    { k: "ask_shown", app: "speed-trivia-score" },
    { k: "ask_answer", app: "speed-trivia-score", a: "skip" },
  ]);
  assert.ok(!bodies.some((b) => b.includes("ABCDEFGH23")), "room code never sent");
});
