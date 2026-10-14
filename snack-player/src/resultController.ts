// The result screen's logic for a template that declares `resultView`
// (speed-trivia-score, "나 맞히기 퀴즈"), without React or the DOM so it is
// unit-tested in Node (snack-player/test/resultController.test.ts):
//   · keeps `resultView` in step with the room's result vars, latching who the
//     finished quiz's subject was when the result began;
//   · runs the reaction question once per game (room + sessionNo);
//   · handles the result buttons' taps (shell-local events, never sent to the room);
//   · reports through one function the metrics lane wires (ResultExtras.tsx).
import { buildResultView, EMPTY_VIEW, type ResultView } from "./quizResult.ts";
import { gameKeyOf, stepReaction, type ReactionInput, type ReactionReport, type ReactionStage } from "./reactionQuestion.ts";
import type { ShareOutcome } from "./resultImage.ts";

/** Taps from the result screen that the shell handles (the room never sees them). */
export const RESULT_EVENTS = new Set(["resultShare", "resultInvite", "makeQuiz", "reactionAnswer", "reactionReason"]);
/** Room vars the view depends on. */
export const RESULT_KEYS = ["sessionPhase", "quizRecap", "raceBoard", "roster", "quizInfo", "iAmSubject", "sessionNo", "myPid"];

/** telemetry.md §9.1: the reaction question, and a result share that really happened. */
export type ResultEvent = ReactionReport | { k: "share"; method: "web"; what: "result" };

/** The maker's own link: "나도 만들어 보기" (a result's share and the public room's invite point here). */
export const MAKER_PATH = "/p/tpl-speed-trivia-score?make=1";
export const makerLink = (origin: string) => `${origin}${MAKER_PATH}`;
/** KakaoTalk's in-app browser: downloads and long-press saving may not work there. */
export const isKakaoInApp = (ua: string) => /KAKAOTALK/i.test(ua);
export const kakaoExternalUrl = (href: string) => `kakaotalk://web/openExternal?url=${encodeURIComponent(href)}`;

export const ASK_DELAY_MS = 1500; // let the result land before asking
export const THANKS_MS = 1600;

type Store = { asked(): boolean; markAsked(): void };
export type ResultDeps = {
  roomId: string;
  myNick: () => string | null;
  canMake: () => boolean;
  setVar: (id: string, value: unknown) => void;
  /** `gameKey` = this game's key on this device (room + sessionNo) — a once-per-game guard, never sent. */
  report: (e: ResultEvent, gameKey: string) => void;
  store: (gameKey: string) => Store;
  /** Draws the picture (cached per view by the caller or here). */
  makeImage: (view: ResultView) => Promise<Blob>;
  /** Share sheet with the file, else "preview". */
  shareImage: (blob: Blob, view: ResultView) => Promise<ShareOutcome>;
  showPreview: (blob: Blob) => void;
  say: (text: string) => void;
  invite: () => void;
  /** Opens the maker (lane B); false when it is not wired — the event is then left to others. */
  makeQuiz: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
};

export function createResultController(d: ResultDeps) {
  let vars: Record<string, unknown> = {};
  let inResult = false;
  let latchedSubject = false; // iAmSubject when this result began (the finished quiz's perspective)
  let view: ResultView = EMPTY_VIEW;
  let viewJson = "";
  let gameKey = "";
  let stage: ReactionStage = "";
  let askTimer: unknown = null;
  let predraw: unknown = null;
  const timers = new Set<unknown>();
  let image: { key: string; blob: Promise<Blob> } | null = null;

  const later = (fn: () => void, ms: number) => {
    const h: unknown = d.setTimer(() => {
      timers.delete(h); // fired timers are pruned
      fn();
    }, ms);
    timers.add(h);
    return h;
  };

  const react = (input: ReactionInput) => {
    const r = stepReaction(stage, input);
    if (r.report) d.report(r.report, gameKey);
    if (r.stage === stage) return;
    stage = r.stage;
    d.setVar("reactionStage", stage === "done" ? "" : stage);
    if (stage === "thanks") later(() => react({ t: "thanksDone" }), THANKS_MS);
  };

  const imageFor = (v: ResultView) => {
    const key = JSON.stringify(v);
    if (image?.key !== key) {
      const entry = { key, blob: d.makeImage(v) };
      // A failed drawing is not cached: the next tap tries again.
      entry.blob.catch(() => { if (image === entry) image = null; });
      image = entry;
    }
    return image.blob;
  };

  const update = (next: Record<string, unknown>) => {
    vars = next;
    const nowResult = vars.sessionPhase === "result";
    if (!nowResult) {
      if (inResult) {
        react({ t: "resultLeft" });
        if (askTimer !== null) { d.clearTimer(askTimer); timers.delete(askTimer); askTimer = null; }
      }
      inResult = false;
      return;
    }
    if (!inResult) {
      // Entering a result: latch the finished quiz's perspective and this game's key.
      inResult = true;
      latchedSubject = vars.iAmSubject === true;
      const key = gameKeyOf(d.roomId, vars.sessionNo);
      if (key !== gameKey) {
        gameKey = key;
        stage = "";
      }
    }
    const v = buildResultView({
      quizRecap: vars.quizRecap as never,
      raceBoard: vars.raceBoard as never,
      roster: vars.roster as never,
      quizInfo: vars.quizInfo as never,
      iAmSubject: latchedSubject,
      iAmSubjectNow: vars.iAmSubject === true,
      myNick: d.myNick(),
      myPid: typeof vars.myPid === "string" ? vars.myPid : null,
      canMake: d.canMake(),
    });
    const json = JSON.stringify(v);
    if (json !== viewJson) {
      viewJson = json;
      view = v;
      d.setVar("resultView", v);
    }
    if (v.mode === "") return;
    // Pre-draw so "결과 공유" can open the share sheet inside the tap (one pending draw).
    if (predraw !== null) { d.clearTimer(predraw); timers.delete(predraw); }
    predraw = later(() => {
      predraw = null;
      if (view === v) void imageFor(v).catch(() => {});
    }, 400);
    if (stage === "" && askTimer === null) {
      const store = d.store(gameKey);
      if (store.asked()) {
        stage = "done"; // asked for this game already (a reload)
        return;
      }
      askTimer = later(() => {
        askTimer = null;
        if (!inResult || stage !== "") return;
        store.markAsked();
        react({ t: "resultShown" });
      }, ASK_DELAY_MS);
    }
  };

  const share = async () => {
    const v = view;
    if (v.mode === "") return;
    let blob: Blob;
    try {
      blob = await imageFor(v);
    } catch {
      d.say("결과 이미지를 만들지 못했어요. 화면을 캡처해 주세요.");
      return;
    }
    const outcome = await d.shareImage(blob, v);
    if (outcome === "shared") d.report({ k: "share", method: "web", what: "result" }, gameKey);
    else if (outcome === "preview") d.showPreview(blob);
    // cancelled: the person closed the sheet — nothing happened, nothing to say.
  };

  /** True when the event was a result-screen tap (handled here, not for the room). */
  const event = (name: string, payload?: unknown): boolean => {
    if (!RESULT_EVENTS.has(name)) return false;
    if (name === "makeQuiz") return d.makeQuiz(); // false: not wired here, left to any other handler
    const p = (payload ?? {}) as { answer?: string; reason?: string };
    if (name === "resultShare") void share();
    else if (name === "resultInvite") d.invite();
    else if (name === "reactionAnswer") {
      if (p.answer === "yes" || p.answer === "no" || p.answer === "skip") react({ t: "answer", answer: p.answer });
    } else if (name === "reactionReason") {
      react(p.reason === "skip" ? { t: "skipReasons" } : { t: "reason", reason: String(p.reason) });
    }
    return true;
  };

  return {
    update,
    event,
    share,
    get inResult() { return inResult; },
    get view() { return view; },
    get stage() { return stage; },
    get pendingTimers() { return timers.size; },
    dispose() {
      for (const h of timers) d.clearTimer(h);
      timers.clear();
    },
  };
}
