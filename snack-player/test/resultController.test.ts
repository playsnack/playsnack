// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_DELAY_MS, THANKS_MS, createResultController, isKakaoInApp, kakaoExternalUrl, makerLink, type ResultEvent } from "../src/resultController.ts";
import type { ResultView } from "../src/quizResult.ts";
import type { ShareOutcome } from "../src/resultImage.ts";
import { duo, group } from "./fixtures/quizResult.ts";

const flush = () => new Promise((r) => setImmediate(r));

function harness(opts: { outcome?: ShareOutcome; failImages?: number; makeQuiz?: boolean; storage?: Map<string, string> } = {}) {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const vars: Record<string, unknown> = {};
  const reports: ResultEvent[] = [];
  const said: string[] = [];
  const previews: Blob[] = [];
  const shared: ResultView[] = [];
  let images = 0;
  let failImages = opts.failImages ?? 0;
  let invites = 0;
  let makes = 0;
  const storage = opts.storage ?? new Map<string, string>();
  const ctrl = createResultController({
    roomId: "tpl-speed-trivia-score~ABCDEFGH23",
    myNick: () => "지은",
    canMake: () => Boolean(opts.makeQuiz),
    setVar: (id, v) => { vars[id] = v; },
    report: (e) => reports.push(e),
    store: (key) => ({ asked: () => storage.get(key) === "1", markAsked: () => void storage.set(key, "1") }),
    makeImage: async () => {
      images++;
      if (failImages > 0) { failImages--; throw new Error("canvas"); }
      return new Blob(["png"]);
    },
    shareImage: async (_b, v) => { shared.push(v); return opts.outcome ?? "shared"; },
    showPreview: (b) => previews.push(b),
    say: (s) => said.push(s),
    invite: () => { invites++; },
    makeQuiz: () => { if (!opts.makeQuiz) return false; makes++; return true; },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
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
  return { ctrl, vars, reports, said, previews, shared, advance, storage, get images() { return images; }, get invites() { return invites; }, get makes() { return makes; } };
}
const resultVars = (input: typeof duo, extra: Record<string, unknown> = {}) => ({
  sessionPhase: "result", quizRecap: input.quizRecap, raceBoard: input.raceBoard, roster: input.roster, quizInfo: input.quizInfo, sessionNo: 1, ...extra,
});

test("result → view set; the question shows after the delay, ask_shown once", () => {
  const h = harness();
  h.ctrl.update(resultVars(duo));
  assert.equal((h.vars.resultView as ResultView).mode, "duo");
  assert.equal(h.vars.reactionStage, undefined);
  h.advance(ASK_DELAY_MS);
  assert.equal(h.vars.reactionStage, "ask");
  assert.deepEqual(h.reports, [{ k: "ask_shown" }]);
});

test("per game: the same game is not asked twice (also after a reload); the next game asks again", () => {
  const storage = new Map<string, string>();
  const h = harness({ storage });
  h.ctrl.update(resultVars(duo));
  h.advance(ASK_DELAY_MS);
  h.ctrl.event("reactionAnswer", { answer: "yes" });
  h.advance(THANKS_MS);
  // a reload in the same game
  const h2 = harness({ storage });
  h2.ctrl.update(resultVars(duo));
  h2.advance(ASK_DELAY_MS * 2);
  assert.deepEqual(h2.reports, [], "not asked again for game 1");
  // game 2 in the same room
  h2.ctrl.update(resultVars(duo, { sessionPhase: "play", sessionNo: 2 }));
  h2.ctrl.update(resultVars(duo, { sessionNo: 2 }));
  h2.advance(ASK_DELAY_MS);
  assert.equal(h2.vars.reactionStage, "ask");
  assert.deepEqual(h2.reports, [{ k: "ask_shown" }]);
});

test("leaving the result after 👎 without a reason reports ask_answer no once", () => {
  const h = harness();
  h.ctrl.update(resultVars(duo));
  h.advance(ASK_DELAY_MS);
  h.ctrl.event("reactionAnswer", { answer: "no" });
  assert.equal(h.vars.reactionStage, "reasons");
  h.ctrl.update(resultVars(duo, { sessionPhase: "countdown", sessionNo: 2 }));
  assert.deepEqual(h.reports, [{ k: "ask_shown" }, { k: "ask_answer", a: "no" }]);
  assert.equal(h.vars.reactionStage, "");
});

test("leaving before the question appears: never shown, never counted", () => {
  const h = harness();
  h.ctrl.update(resultVars(duo));
  h.ctrl.update(resultVars(duo, { sessionPhase: "countdown" }));
  h.advance(ASK_DELAY_MS * 2);
  assert.deepEqual(h.reports, []);
});

test("latched: a new quiz arriving during the result keeps the finished quiz's labels; the next control changes", () => {
  const h = harness();
  h.ctrl.update(resultVars(group, { iAmSubject: true }));
  const before = h.vars.resultView as ResultView;
  assert.equal(before.headline, "나를 제일 잘 아는 친구는?");
  // 하늘 sends a new quiz: the room now says I am not the subject, quizInfo describes 하늘's quiz.
  h.ctrl.update(resultVars(group, { iAmSubject: false, quizInfo: { title: "하늘 맞히기", count: 5, custom: true, about: "하늘", packId: "pack-haneul" } }));
  const after = h.vars.resultView as ResultView;
  assert.equal(after.headline, before.headline);
  assert.equal(after.title, before.title);
  assert.equal(after.next, "waiting");
  assert.equal(after.nextText, "하늘님이 새 퀴즈를 만들었어요 · 곧 시작해요");
});

test("share: a completed share is reported as share{what:result}; nothing else is", async () => {
  for (const [outcome, report, preview] of [["shared", true, false], ["cancelled", false, false], ["preview", false, true]] as const) {
    const h = harness({ outcome });
    h.ctrl.update(resultVars(duo));
    assert.equal(h.ctrl.event("resultShare"), true);
    await flush();
    const shares = h.reports.filter((r) => r.k === "share");
    assert.deepEqual(shares, report ? [{ k: "share", method: "web", what: "result" }] : [], outcome);
    assert.equal(h.previews.length, preview ? 1 : 0, outcome);
    assert.deepEqual(h.said, []);
  }
});

test("share (#118): busy / retry / failed never open the save-image preview", async () => {
  for (const outcome of ["busy", "retry", "failed"] as const) {
    const h = harness({ outcome });
    h.ctrl.update(resultVars(duo));
    h.advance(400); // the picture is drawn ahead
    await flush();
    h.ctrl.event("resultShare");
    h.ctrl.event("resultShare"); // a repeat tap while the first is in flight
    await flush();
    assert.equal(h.shared.length, 1, outcome);
    assert.equal(h.images, 1, outcome);
    assert.equal(h.previews.length, 0, outcome);
  }
});

test("share: a failed drawing says so honestly and is retried on the next tap", async () => {
  const h = harness({ failImages: 1 });
  h.ctrl.update(resultVars(duo));
  h.ctrl.event("resultShare");
  await flush();
  assert.deepEqual(h.said, ["결과 이미지를 만들지 못했어요. 화면을 캡처해 주세요."]);
  assert.equal(h.reports.filter((r) => r.k === "share").length, 0);
  h.ctrl.event("resultShare");
  await flush();
  assert.equal(h.images, 2, "not served from a failed cache entry");
  assert.equal(h.shared.length, 1);
});

test("share before any result data does nothing", async () => {
  const h = harness();
  h.ctrl.update({ sessionPhase: "result" });
  h.ctrl.event("resultShare");
  await flush();
  assert.equal(h.images, 0);
});

test("invite and 나도 만들기: handled here only when wired", () => {
  const h = harness();
  assert.equal(h.ctrl.event("resultInvite"), true);
  assert.equal(h.invites, 1);
  assert.equal(h.ctrl.event("makeQuiz"), false, "not wired → left to LiveApp's bridge");
  const w = harness({ makeQuiz: true });
  assert.equal(w.ctrl.event("makeQuiz"), true);
  assert.equal(w.makes, 1);
  assert.equal(h.ctrl.event("start"), false, "a room action is not a result event");
});

test("maker link (share text/url, public-room invite) and KakaoTalk helpers", () => {
  assert.equal(makerLink("https://playsnack.vercel.app"), "https://playsnack.vercel.app/p/tpl-speed-trivia-score?make=1");
  assert.ok(isKakaoInApp("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 KAKAOTALK 10.4.5"));
  assert.ok(!isKakaoInApp("Mozilla/5.0 (iPhone) Safari/604.1"));
  assert.equal(kakaoExternalUrl("https://playsnack.vercel.app/p/x?room=AB&y=1"), "kakaotalk://web/openExternal?url=https%3A%2F%2Fplaysnack.vercel.app%2Fp%2Fx%3Froom%3DAB%26y%3D1");
});

test("timers: fired ones are pruned, one pending pre-draw at a time, dispose clears the rest", () => {
  const h = harness();
  for (let i = 0; i < 10; i++) h.ctrl.update(resultVars(duo, { raceBoard: [...duo.raceBoard!] }));
  assert.ok(h.ctrl.pendingTimers <= 2, `pending ${h.ctrl.pendingTimers}`);
  h.advance(ASK_DELAY_MS + THANKS_MS);
  assert.equal(h.ctrl.pendingTimers, 0);
  h.ctrl.update(resultVars(duo, { sessionNo: 3, sessionPhase: "play" }));
  h.ctrl.update(resultVars(duo, { sessionNo: 3 }));
  h.ctrl.dispose();
  assert.equal(h.ctrl.pendingTimers, 0);
});
