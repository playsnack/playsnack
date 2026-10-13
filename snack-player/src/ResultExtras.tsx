// Result-screen extras for a template that declares `resultView` (speed-trivia-
// score, "나 맞히기 퀴즈"): the shell keeps the result view, the reaction
// question and the share image in step with the room's result vars, and handles
// the result buttons' taps (shell-local events, never sent to the room).
// The template lays every button and the question card out itself, so nothing
// here floats over them; the DOM parts are a status note and the image preview.
import { useEffect, useRef, useState } from "react";
import type { BiteApp, BiteDoc } from "@snack/bite";
import { fontFamily, loadFonts } from "@snack/bite-pixi";
import { getNick } from "./identity";
import { buildResultView, EMPTY_VIEW, type ResultView } from "./quizResult";
import { renderResultImage, shareResultImage } from "./resultImage";
import { reactionStore, stepReaction, type ReactionInput, type ReactionReport, type ReactionStage } from "./reactionQuestion";
import { BLOCK_CSS, pill, primaryBtn, secondaryBtn } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";

/** Taps from the result screen that the shell handles (the room never sees them). */
export const RESULT_EVENTS = new Set(["resultShare", "resultInvite", "resultMake", "reactionAnswer", "reactionReason"]);
const RESULT_KEYS = ["sessionPhase", "quizRecap", "raceBoard", "roster", "quizInfo", "iAmSubject"];

type MakeEntry = (ctx: { slug: string; params: URLSearchParams }) => void;
/**
 * "나도 만들기" entry — lane B (question editor) fills `makeQuiz` with the call
 * that opens the editor and sends the new pack into this room. While it is
 * null the button is not shown (no button that does nothing).
 */
export const resultHooks: { makeQuiz: MakeEntry | null } = { makeQuiz: null };

export type ResultEvent =
  | ReactionReport
  | { k: "result_share"; outcome: "shared" | "cancelled" | "preview" | "failed" }
  | { k: "result_invite" }
  | { k: "result_make" };
/**
 * The one place result-screen events would be reported (reaction answers,
 * share, invite, 나도 만들기). The metrics lane wires this — until then it does
 * nothing: no counting, no network.
 */
export function reportResultEvent(_e: ResultEvent): void {
  // metrics lane wires this
}

const ASK_DELAY_MS = 1500; // let the result land before asking
const THANKS_MS = 1600;
const IMAGE_FONTS: BiteDoc = {
  bite: 1, frame: [390, 844], vars: {}, start: "s", phases: { s: {} },
  view: { box: "column", children: [{ text: "가", weight: 500 }, { text: "가", weight: 800 }, { text: "가", font: "display", weight: 700 }] },
} as unknown as BiteDoc;

type Note = { text: string; sticky?: boolean } | null;

export function useResultExtras({ doc, slug, params, onInvite }: {
  doc: BiteDoc | null;
  slug: string;
  params: URLSearchParams;
  /** Q1's invite helper (share sheet → clipboard → shown to copy). */
  onInvite: () => void;
}) {
  const active = Boolean(doc && doc.vars && "resultView" in doc.vars);
  const rtRef = useRef<BiteApp | null>(null);
  const viewRef = useRef<ResultView>(EMPTY_VIEW);
  const viewJson = useRef("");
  const stageRef = useRef<ReactionStage>("");
  const askPending = useRef(false);
  const store = useRef(reactionStore(slug));
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const image = useRef<{ key: string; blob: Promise<Blob> } | null>(null);
  const [inResult, setInResult] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [preview, setPreview] = useState<string | null>(null); // object URL of the picture to save

  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const say = (text: string, sticky = false) => {
    setNote({ text, sticky });
    if (!sticky) later(() => setNote((n) => (n?.text === text ? null : n)), 3000);
  };

  // ── reaction question ──
  const react = (input: ReactionInput) => {
    const r = stepReaction(stageRef.current, input);
    if (r.report) reportResultEvent(r.report);
    if (r.stage === stageRef.current) return;
    stageRef.current = r.stage;
    rtRef.current?.setVar("reactionStage", r.stage === "done" ? "" : r.stage);
    if (r.stage === "thanks") later(() => react({ t: "thanksDone" }), THANKS_MS);
  };

  // ── the picture: drawn once per result, in the background ──
  const imageFor = (view: ResultView) => {
    const key = JSON.stringify(view);
    if (image.current?.key !== key) {
      const blob = renderResultImage(view, {
        families: { body: fontFamily("body"), display: fontFamily("display") },
        appName: "PlaySnack",
        link: `${location.host}/p/${slug}`,
        ready: () => loadFonts(IMAGE_FONTS, `${import.meta.env.BASE_URL}fonts`),
      });
      blob.catch((e) => console.warn("[result] image failed", e));
      image.current = { key, blob };
    }
    return image.current.blob;
  };

  const recompute = () => {
    const rt = rtRef.current;
    if (!rt) return;
    const vars = rt.vars as Record<string, unknown>;
    const nowResult = vars.sessionPhase === "result";
    setInResult(nowResult);
    if (!nowResult) {
      if (stageRef.current !== "" && stageRef.current !== "done") react({ t: "resultLeft" });
      return;
    }
    const view = buildResultView({ ...(vars as object), myNick: getNick() });
    const json = JSON.stringify(view);
    if (json !== viewJson.current) {
      viewJson.current = json;
      viewRef.current = view;
      rt.setVar("resultView", view);
    }
    if (view.mode === "") return;
    // Pre-draw so "결과 공유" can open the share sheet inside the tap.
    later(() => { if (viewRef.current === view) void imageFor(view).catch(() => {}); }, 400);
    if (stageRef.current === "" && !askPending.current) {
      if (store.current.asked()) {
        stageRef.current = "done"; // asked earlier in this browser session
        return;
      }
      askPending.current = true;
      later(() => {
        askPending.current = false;
        // Still on the result and not yet asked: ask (once — remembered from now on).
        if ((rtRef.current?.vars as Record<string, unknown> | undefined)?.sessionPhase !== "result" || stageRef.current !== "") return;
        store.current.markAsked();
        react({ t: "resultShown" });
      }, ASK_DELAY_MS);
    }
  };

  const attach = (rt: BiteApp) => {
    if (!active) return;
    rtRef.current = rt;
    rt.setVar("canMake", resultHooks.makeQuiz !== null);
    rt.on("change", (changed: string[]) => {
      if (changed.some((k) => RESULT_KEYS.includes(k))) recompute();
    });
    recompute();
  };

  const share = async () => {
    const view = viewRef.current;
    if (view.mode === "") return;
    let blob: Blob;
    try {
      blob = await imageFor(view);
    } catch {
      reportResultEvent({ k: "result_share", outcome: "failed" });
      say("결과 이미지를 만들지 못했어요. 화면을 캡처해 주세요.");
      return;
    }
    const outcome = await shareResultImage(blob, { fileName: "playsnack-result.png", title: view.title, text: view.headline });
    reportResultEvent({ k: "result_share", outcome });
    if (outcome === "preview") setPreview(URL.createObjectURL(blob));
  };

  /** True when the event was a result-screen tap (handled here, not for the room). */
  const handleEvent = (e: { name: string; payload?: unknown }): boolean => {
    if (!active || !RESULT_EVENTS.has(e.name)) return false;
    const p = (e.payload ?? {}) as { answer?: string; reason?: string };
    if (e.name === "resultShare") void share();
    else if (e.name === "resultInvite") {
      reportResultEvent({ k: "result_invite" });
      onInvite();
    } else if (e.name === "resultMake") {
      if (resultHooks.makeQuiz) {
        reportResultEvent({ k: "result_make" });
        resultHooks.makeQuiz({ slug, params });
      }
    } else if (e.name === "reactionAnswer") {
      if (p.answer === "yes" || p.answer === "no" || p.answer === "skip") react({ t: "answer", answer: p.answer });
    } else if (e.name === "reactionReason") {
      react(p.reason === "skip" ? { t: "skipReasons" } : { t: "reason", reason: String(p.reason) });
    }
    return true;
  };

  const overlay = active ? (
    <>
      {note && (
        <div style={noteDock} role="status">
          <div style={{ ...pill, ...noteBox }}>{note.text}</div>
        </div>
      )}
      {preview && (
        <div style={dim} onClick={() => setPreview(null)}>
          <div style={sheet} role="dialog" aria-label="결과 이미지" onClick={(e) => e.stopPropagation()}>
            <style>{BLOCK_CSS}</style>
            <img src={preview} alt="결과 이미지" style={previewImg} />
            <p style={sheetText}>이미지를 길게 눌러 저장하거나, 아래 버튼으로 내려받을 수 있어요.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: S.s3 }}>
              <a className="blk" style={{ ...primaryBtn, display: "block", textDecoration: "none", boxSizing: "border-box" }} href={preview} download="playsnack-result.png">
                이미지 내려받기
              </a>
              <button className="blk" style={secondaryBtn} onClick={() => setPreview(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </>
  ) : null;

  return { active, inResult: active && inResult, attach, handleEvent, overlay };
}

// Under the top pills, left of the reaction button column (which sits at the
// top-right during the result).
const noteDock: React.CSSProperties = {
  position: "fixed", top: "calc(var(--snack-safe-top) + 64px)", left: 12, right: 70, zIndex: 14,
  display: "flex", justifyContent: "flex-start", pointerEvents: "none",
};
const noteBox: React.CSSProperties = { minHeight: 0, padding: "10px 12px", whiteSpace: "normal", wordBreak: "keep-all", fontWeight: 600 };
const dim: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 30, background: "rgba(0,0,0,0.7)",
  display: "flex", alignItems: "flex-end", justifyContent: "center",
};
const sheet: React.CSSProperties = {
  width: "100%", maxWidth: 520, maxHeight: "100%", overflowY: "auto", boxSizing: "border-box",
  background: C.surface, color: C.ink, textAlign: "center",
  borderTop: `${TOKENS.border.heavy}px solid ${C.accent}`, borderRadius: R.block, boxShadow: blockShadow,
  padding: `${S.s5}px 16px calc(var(--snack-safe-bottom) + ${S.s5}px)`, font: `16px ${TOKENS.font.body}`,
};
const previewImg: React.CSSProperties = { display: "block", width: "auto", maxWidth: "100%", maxHeight: "55vh", margin: "0 auto", border: `2px solid ${C.borderBlock}` };
const sheetText: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodyMd, lineHeight: 1.5, margin: `${S.s4}px 0`, wordBreak: "keep-all" };
