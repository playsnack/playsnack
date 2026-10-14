// Result-screen extras for a template that declares `resultView` (speed-trivia-
// score, "나 맞히기 퀴즈"): the React/DOM side of resultController.ts — the
// picture, the share sheet / preview, the status note. The template lays every
// button and the question card out itself, so nothing here floats over them.
import { useEffect, useRef, useState } from "react";
import type { BiteApp, BiteDoc } from "@snack/bite";
import { fontFamily, loadFonts } from "@snack/bite-pixi";
import { getNick } from "./identity";
import { roomIdFor } from "./links";
import { createResultController, isKakaoInApp, kakaoExternalUrl, makerLink, RESULT_KEYS, type ResultEvent } from "./resultController";
export { makerLink } from "./resultController";
import { reactionStore } from "./reactionQuestion";
import { trackResultEvent } from "./telemetry";
import { renderResultImage, shareResultImage } from "./resultImage";
import { BLOCK_CSS, pill, primaryBtn, secondaryBtn } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";


type MakeEntry = (ctx: { slug: string; params: URLSearchParams }) => void;
/**
 * "나도 만들기" (the template's host event `makeQuiz`) — lane B's
 * openQuizMaker() (snack-player/src/quiz.ts on claude/g1-b) opens the maker over
 * this room and sends the new pack into it. At merge: `resultHooks.makeQuiz =
 * () => openQuizMaker(…)` (or let LiveApp's bridge handle `makeQuiz` and set
 * canMake). While it is null the button is hidden (no button that does
 * nothing) and `makeQuiz` is left to any other handler.
 */
export const resultHooks: { makeQuiz: MakeEntry | null } = { makeQuiz: null };

/**
 * The one place result-screen events are reported (telemetry.md §9.1):
 * `ask_shown` / `ask_answer` (once per game on this device — `gameKey` guards it
 * and is never sent) and a result `share` that really happened (share sheet
 * completed). `slug` may be the room id; only the app part goes out.
 */
export function reportResultEvent(e: ResultEvent, slug: string, gameKey: string): void {
  trackResultEvent(e, slug, gameKey); // telemetry.ts (Node-tested: api/_test/telemetry-client.test.js)
}


const IMAGE_FONTS: BiteDoc = {
  bite: 1, frame: [390, 844], vars: {}, start: "s", phases: { s: {} },
  view: { box: "column", children: [{ text: "가", weight: 500 }, { text: "가", weight: 800 }, { text: "가", font: "display", weight: 700 }] },
} as unknown as BiteDoc;

export function useResultExtras({ doc, slug, params, onInvite }: {
  doc: BiteDoc | null;
  slug: string;
  params: URLSearchParams;
  /** Q1's invite helper (share sheet → clipboard → shown to copy). */
  onInvite: () => void;
}) {
  const active = Boolean(doc && doc.vars && "resultView" in doc.vars);
  const [inResult, setInResult] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null); // object URL of the picture to save
  // The tap on "결과 공유" happens on the canvas; its trailing compatibility
  // click lands on whatever the sheet put under the finger ("닫기"). The sheet
  // only takes clicks after a pointerdown inside it.
  const armed = useRef(false);
  const inviteRef = useRef(onInvite);
  inviteRef.current = onInvite;

  const rtRef = useRef<BiteApp | null>(null);
  const ctrlRef = useRef<ReturnType<typeof createResultController> | null>(null);
  if (active && !ctrlRef.current) {
    const roomId = roomIdFor(slug, params);
    ctrlRef.current = createResultController({
      roomId,
      myNick: getNick,
      canMake: () => resultHooks.makeQuiz !== null,
      setVar: (id, v) => rtRef.current?.setVar(id, v),
      report: (e, gameKey) => reportResultEvent(e, slug, gameKey),
      store: (key) => reactionStore(key),
      makeImage: (view) => renderResultImage(view, {
        families: { body: fontFamily("body"), display: fontFamily("display") },
        appName: "PlaySnack",
        link: `${location.host} · 나도 만들어 보기`,
        ready: () => loadFonts(IMAGE_FONTS, `${import.meta.env.BASE_URL}fonts`),
      }),
      shareImage: (blob, view) => shareResultImage(blob, {
        fileName: "playsnack-result.png",
        title: view.title,
        text: `${view.headline}\n나도 만들어 보기 👉 ${makerLink(location.origin)}`,
        url: makerLink(location.origin),
      }),
      showPreview: (blob) => {
        armed.current = false;
        setPreview(URL.createObjectURL(blob));
      },
      say: (text) => {
        setNote(text);
        setTimeout(() => setNote((n) => (n === text ? null : n)), 3000);
      },
      invite: () => inviteRef.current(),
      makeQuiz: () => {
        if (!resultHooks.makeQuiz) return false;
        resultHooks.makeQuiz({ slug, params });
        return true;
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  }
  useEffect(() => () => ctrlRef.current?.dispose(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const attach = (rt: BiteApp) => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    rtRef.current = rt;
    rt.setVar("canMake", resultHooks.makeQuiz !== null);
    const sync = () => {
      ctrl.update(rt.vars as Record<string, unknown>);
      setInResult(ctrl.inResult);
    };
    rt.on("change", (changed: string[]) => {
      if (changed.some((k) => RESULT_KEYS.includes(k))) sync();
    });
    sync();
  };

  /** True when the event was a result-screen tap (handled here, not for the room). */
  const handleEvent = (e: { name: string; payload?: unknown }) => Boolean(ctrlRef.current?.event(e.name, e.payload));

  const kakao = typeof navigator !== "undefined" && isKakaoInApp(navigator.userAgent);
  const overlay = active ? (
    <>
      {note && (
        <div style={noteDock} role="status">
          <div style={{ ...pill, ...noteBox }}>{note}</div>
        </div>
      )}
      {preview && (
        <div style={dim}
          onPointerDownCapture={() => { armed.current = true; }}
          onClickCapture={(e) => { if (!armed.current) { e.preventDefault(); e.stopPropagation(); } }}
          onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div style={sheet} role="dialog" aria-label="결과 이미지">
            <style>{BLOCK_CSS}</style>
            <img src={preview} alt="결과 이미지" style={previewImg} />
            <p style={sheetText}>
              {kakao
                ? "카카오톡 안에서는 저장이 안 될 수 있어요. 화면을 캡처하거나 다른 브라우저로 열어 주세요."
                : "이미지를 길게 눌러 저장하거나, 아래 버튼으로 내려받을 수 있어요."}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: S.s3 }}>
              {kakao ? (
                <a className="blk" style={linkBtn} href={kakaoExternalUrl(location.href)}>다른 브라우저로 열기</a>
              ) : (
                <a className="blk" style={linkBtn} href={preview} download="playsnack-result.png">이미지 내려받기</a>
              )}
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
const linkBtn: React.CSSProperties = { ...primaryBtn, display: "block", textDecoration: "none", boxSizing: "border-box" };
const previewImg: React.CSSProperties = { display: "block", width: "auto", maxWidth: "100%", maxHeight: "55vh", margin: "0 auto", border: `2px solid ${C.borderBlock}` };
const sheetText: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodyMd, lineHeight: 1.5, margin: `${S.s4}px 0`, wordBreak: "keep-all" };
