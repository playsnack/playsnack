// "지난 판 결과" — a friends-room link opened when nobody is in the room shows the room's
// last finished game (docs/room-results.md): ranking, per-question reveal for the quiz,
// 결과 공유 (the same picture as the live result, resultImage.ts) and "이 방에서 한 판 더"
// (back to the lobby). The view is quizResult.ts's, via roomResult.ts savedResultView.
import { useMemo, useState } from "react";
import type { BiteDoc } from "@snack/bite";
import { fontFamily, loadFonts } from "@snack/bite-pixi";
import { agoLabel, KEEP_NOTE, savedResultView, type SavedResult } from "./roomResult";
import { renderResultImage, shareResultImage } from "./resultImage";
import { makerLink } from "./resultController";
import { trackShare } from "./telemetry";
import { BLOCK_CSS, primaryBtn, secondaryBtn } from "./ui";
import { C, R, S, TOKENS } from "./tokens.gen";

const IMAGE_FONTS: BiteDoc = {
  bite: 1, frame: [390, 844], vars: {}, start: "s", phases: { s: {} },
  view: { box: "column", children: [{ text: "가", weight: 500 }, { text: "가", weight: 800 }, { text: "가", font: "display", weight: 700 }] },
} as unknown as BiteDoc;

export function LastResult({ saved, slug, myNick, onAgain }: { saved: SavedResult; slug: string; myNick: string | null; onAgain: () => void }) {
  const view = useMemo(() => savedResultView(saved, myNick), [saved, myNick]);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const say = (t: string) => {
    setNote(t);
    setTimeout(() => setNote((n) => (n === t ? null : n)), 3000);
  };
  const share = async () => {
    let blob: Blob;
    try {
      blob = await renderResultImage(view, {
        families: { body: fontFamily("body"), display: fontFamily("display") },
        appName: "PlaySnack",
        link: `${location.host} · 나도 만들어 보기`,
        ready: () => loadFonts(IMAGE_FONTS, `${import.meta.env.BASE_URL}fonts`),
      });
    } catch {
      return say("결과 이미지를 만들지 못했어요. 화면을 캡처해 주세요.");
    }
    const out = await shareResultImage(blob, {
      fileName: "playsnack-result.png",
      title: view.title,
      text: `${view.headline}\n나도 만들어 보기 👉 ${makerLink(location.origin)}`,
      url: makerLink(location.origin),
    });
    if (out === "shared") trackShare("web", "result", slug);
    else if (out === "preview") setPreview(URL.createObjectURL(blob));
  };

  return (
    <div style={screen} role="dialog" aria-label="지난 판 결과">
      <style>{BLOCK_CSS}</style>
      <div style={col}>
        <div style={kicker}>지난 판 결과 · {agoLabel(saved.endedAt, Date.now())}</div>
        <h1 style={title}>{view.headline || view.title}</h1>
        {view.title && view.headline !== view.title && <div style={muted}>{view.title}</div>}

        {view.mode === "rank" && (
          <ol style={list} aria-label="순위">
            {view.ranks.map((r) => (
              <li key={r.key} style={{ ...row, ...(r.top ? rowTop : null) }}>
                <span style={rankCell}>{r.rankLabel}</span>
                <span style={nickCell}>{r.nick}{r.left ? <span style={leftMark}> 나감</span> : null}</span>
                <span style={scoreCell}>{r.scoreLabel}</span>
              </li>
            ))}
          </ol>
        )}
        {view.mode === "duo" && (
          <div style={{ ...row, flexDirection: "column", alignItems: "flex-start", gap: S.s2 }}>
            <span style={{ fontWeight: 700 }}>{view.duo.line}</span>
            <span style={bigScore}>{view.duo.score}</span>
            {view.duo.tier && <span style={muted}>{view.duo.tier}</span>}
          </div>
        )}
        {view.mode === "empty" && <p style={muted}>{view.emptyText}</p>}

        {view.questions.length > 0 && (
          <section aria-label="문제별 결과" style={{ display: "flex", flexDirection: "column", gap: S.s3 }}>
            <h2 style={h2}>문제별로 보기</h2>
            {view.questions.map((q) => (
              <div key={q.n} style={card}>
                <div style={muted}>Q{q.n} · {q.summary}</div>
                <div style={{ fontWeight: 700, margin: `${S.s1}px 0 ${S.s2}px` }}>{q.q}</div>
                <div style={answer}>정답 · {q.answer}</div>
                <div style={chips}>
                  {q.chips.map((c, i) => (
                    <span key={i} style={{ ...chip, ...(c.state === "ok" ? chipOk : c.state === "bad" ? chipBad : null) }}>
                      {c.nick} · {c.pick}{c.state === "ok" ? " ✓" : c.state === "bad" ? " ✗" : ""}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        <p style={keep}>{KEEP_NOTE}</p>
        {note && <div role="status" style={{ ...keep, color: C.ink }}>{note}</div>}
      </div>
      <div style={actions}>
        {view.mode !== "" && <button className="blk" style={secondaryBtn} onClick={() => void share()}>결과 공유</button>}
        <button className="blk" style={primaryBtn} onClick={onAgain}>이 방에서 한 판 더</button>
      </div>
      {preview && (
        <div style={dim} onClick={(e) => { if (e.target === e.currentTarget) { URL.revokeObjectURL(preview); setPreview(null); } }}>
          <div style={sheet} role="dialog" aria-label="결과 이미지">
            <img src={preview} alt="결과 이미지" style={{ display: "block", maxWidth: "100%", maxHeight: "55vh", margin: "0 auto" }} />
            <p style={{ ...muted, margin: `${S.s4}px 0` }}>이미지를 길게 눌러 저장하거나, 아래 버튼으로 내려받을 수 있어요.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: S.s3 }}>
              <a className="blk" style={{ ...primaryBtn, display: "block", textDecoration: "none", boxSizing: "border-box", textAlign: "center" }} href={preview} download="playsnack-result.png">이미지 내려받기</a>
              <button className="blk" style={secondaryBtn} onClick={() => { URL.revokeObjectURL(preview); setPreview(null); }}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const F = TOKENS.font.body;
const screen: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 19, background: C.bg, color: C.ink, font: `600 ${TOKENS.size.bodyMd}px ${F}`,
  display: "flex", flexDirection: "column", overflow: "hidden",
};
const col: React.CSSProperties = {
  flex: 1, overflowY: "auto", width: "100%", maxWidth: 520, margin: "0 auto", boxSizing: "border-box",
  padding: `calc(var(--snack-safe-top) + 72px) 16px ${S.s5}px`, display: "flex", flexDirection: "column", gap: S.s4,
};
const kicker: React.CSSProperties = { color: C.accent, fontWeight: 700, fontSize: TOKENS.size.bodySm };
const title: React.CSSProperties = { margin: 0, font: `800 ${TOKENS.size.titleLg}px ${F}`, lineHeight: 1.25, wordBreak: "keep-all" };
const h2: React.CSSProperties = { margin: `${S.s2}px 0 0`, font: `800 ${TOKENS.size.titleMd}px ${F}` };
const muted: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodySm, wordBreak: "keep-all" };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: S.s2 };
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: S.s3, padding: `${S.s3}px ${S.s4}px`,
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
};
const rowTop: React.CSSProperties = { borderColor: C.accent };
const rankCell: React.CSSProperties = { flex: "none", minWidth: 64, color: C.accent, fontWeight: 800 };
const nickCell: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 };
const leftMark: React.CSSProperties = { color: C.inkMuted, fontWeight: 600, fontSize: TOKENS.size.caption };
const scoreCell: React.CSSProperties = { flex: "none", fontWeight: 800, fontVariantNumeric: "tabular-nums" };
const bigScore: React.CSSProperties = { font: `700 ${TOKENS.size.displayMd}px ${TOKENS.font.display}`, color: C.accent };
const card: React.CSSProperties = { ...row, display: "block" };
const answer: React.CSSProperties = { color: C.accent, fontWeight: 700, marginBottom: S.s2, wordBreak: "keep-all" };
const chips: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: S.s2 };
const chip: React.CSSProperties = {
  padding: `${S.s1}px ${S.s2}px`, background: C.surface2, border: `${TOKENS.border.hairline}px solid ${C.hairline}`,
  fontSize: TOKENS.size.bodySm, color: C.inkMuted,
};
const chipOk: React.CSSProperties = { color: C.ink, borderColor: C.live };
const chipBad: React.CSSProperties = { color: C.inkMuted };
const keep: React.CSSProperties = { ...muted, textAlign: "center", margin: 0 };
const actions: React.CSSProperties = {
  flex: "none", width: "100%", maxWidth: 520, margin: "0 auto", boxSizing: "border-box",
  padding: `${S.s3}px 16px calc(var(--snack-safe-bottom) + ${S.s4}px)`, display: "flex", flexDirection: "column", gap: S.s3,
  borderTop: `${TOKENS.border.hairline}px solid ${C.hairline}`, background: C.bg,
};
const dim: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 30, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "flex-end", justifyContent: "center" };
const sheet: React.CSSProperties = {
  width: "100%", maxWidth: 520, maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", background: C.surface, textAlign: "center",
  borderTop: `${TOKENS.border.heavy}px solid ${C.accent}`, padding: `${S.s5}px 16px calc(var(--snack-safe-bottom) + ${S.s5}px)`,
};
