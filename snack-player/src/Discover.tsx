import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SERVERLESS, hrefTo, navigate } from "./backend";
import { StatsLink } from "./StatsLink";
import { homeSections, type HomeSections } from "./catalog";
import { MessageScreen } from "./Screens";
import { playPath } from "./links";
import { MAKE_PARAM, QUIZ_APP_ID, QUIZ_SLUG } from "./quiz";
import { BLOCK_CSS } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";

// Home: the 대표작 card (index.json `flagship` — today "나 맞히기", a game of
// its own: make a quiz about yourself, friends guess) as the one lime hero,
// then 추천 (games the owner reviewed + fixed on a real phone — index.json
// `featured`, by rank) as cards, then every other game under "검토 전 게임" as
// a quieter list. The 대표작 card itself is not a button — its buttons are;
// a 추천 card or 검토 전 row opens the app (/p/tpl-<id>). No live numbers
// here until there is real data to show (master plan D0) — only what is
// true: the app, its kind, and whether it's played together.
// Skin = "Mini-Block Arcade": chunky blocks (radius 0 + 2px border + blur:0 hard
// shadow), lime is the single hero color. Pixel font only for Latin/digit-only text (logo, scores); Korean headings are Pretendard 700.

const CAT: Record<string, string> = {
  worldcup: "월드컵", vote: "투표", quiz: "퀴즈", psych: "테스트", game: "게임",
  random: "랜덤", reaction: "반응", counter: "카운터", social: "파티",
};
const SCROLL_KEY = "snack.homeScroll";

export function Discover() {
  const [apps, setApps] = useState<HomeSections | null>(null);
  const [failed, setFailed] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const load = () => {
    setFailed(false);
    homeSections().then(setApps).catch(() => setFailed(true));
  };
  useEffect(load, []);

  // Coming back from an app lands where you left the list.
  useLayoutEffect(() => {
    if (!apps || !shellRef.current) return;
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY) || 0);
      if (y) shellRef.current.scrollTop = y;
    } catch {}
  }, [apps]);

  const go = (path: string) => {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(shellRef.current?.scrollTop ?? 0));
    } catch {}
    location.href = hrefTo(path);
  };
  const open = (id: string) => go(`/p/tpl-${id}`);
  // "나 맞히기 만들기": the quiz link with ?make=1 and no room → App → QuizMaker.
  const makeQuiz = () => go(playPath(QUIZ_SLUG, new URLSearchParams({ [MAKE_PARAM]: "1" })));

  if (failed) return <MessageScreen icon="📡" title="목록을 불러오지 못했어요" body="인터넷 연결을 확인하고 다시 시도해 주세요." primary={{ label: "다시 시도", onClick: load }} />;

  return (
    <div ref={shellRef} style={shell}>
      <style>{BLOCK_CSS}</style>
      <div style={{ maxWidth: 520, margin: "0 auto", width: "100%" }}>
        <div style={brand}>SNACK</div>
        <h1 style={h1}>골라서 바로 한 판 🔥</h1>
        <p style={{ color: C.inkMuted, margin: `0 0 ${S.s4}px`, fontSize: TOKENS.size.bodyMd, lineHeight: 1.5 }}>
          탭하면 바로 시작해요 · <span style={tagInline}>같이</span> 표시는 친구랑 함께 해요
        </p>

        {/* 대표작: one lime card. For the 나 맞히기 quiz: 만들기 (→ QuizMaker) first;
            the second link opens the quiz app's public room, which plays the
            built-in 스피드 퀴즈 questions with whoever is there — so it names
            that game and says "같이" (one player alone may wait, #141). */}
        {apps?.flagship && (() => {
          const f = apps.flagship;
          const quiz = f.id === QUIZ_APP_ID;
          // A non-quiz flagship gets a plain card (its own title + 바로 하기), so
          // moving `flagship` in index.json never drops that game from the home.
          return (
            <section style={hero} data-section="flagship" data-app={f.id} aria-label={`대표작 ${quiz ? "나 맞히기 퀴즈" : f.title}`}>
              <span style={heroKicker}>대표작</span>
              <div style={heroTitle}><span aria-hidden="true">{quiz ? "🙋" : f.emoji} </span>{quiz ? "나 맞히기 퀴즈" : f.title}</div>
              {quiz && <p style={heroBody}>내가 낸 문제를 친구들이 맞혀요</p>}
              <button className="blk" style={heroPrimary} data-action={quiz ? "make" : "play"} onClick={quiz ? makeQuiz : () => open(f.id)}>
                {quiz ? "내 퀴즈 만들기" : "바로 하기"}
              </button>
              {quiz && <button style={heroSecondary} data-action="play" onClick={() => open(f.id)}>스피드 퀴즈로 같이 하기 →</button>}
            </section>
          );
        })()}

        {!!apps?.featured.length && <h2 style={sectionTitle}>⭐ 추천</h2>}
        <div style={grid} data-section="featured">
          {(apps?.featured ?? []).map((m) => (
            <button key={m.id} className="blk" style={card} data-app={m.id} onClick={() => open(m.id)}>
              <span style={{ fontSize: 34 }}>{m.emoji}</span>
              <div style={cardTitle}>{m.title}</div>
              <div style={{ display: "flex", alignItems: "center", gap: S.s2, marginTop: S.s2, flexWrap: "wrap" }}>
                <span style={{ color: C.inkMuted, fontSize: TOKENS.size.caption }}>{CAT[m.category] ?? "스낵"}</span>
                {m.mode === "multi" && <span style={tag}>같이</span>}
              </div>
            </button>
          ))}
        </div>

        {/* Not yet reviewed on a real phone: still playable, deliberately quieter. */}
        {!!apps?.unreviewed.length && (
          <>
            <h2 style={subTitle}>검토 전 게임 <span style={{ fontWeight: 600 }}>· {apps.unreviewed.length}</span></h2>
            <p style={subNote}>아직 다듬는 중이에요. 플레이는 할 수 있어요.</p>
            <div style={list} data-section="unreviewed">
              {apps.unreviewed.map((m) => (
                <button key={m.id} style={row} data-app={m.id} onClick={() => open(m.id)}>
                  <span style={{ fontSize: 20, width: 28, textAlign: "center", flexShrink: 0 }}>{m.emoji}</span>
                  <span style={rowTitle}>{m.title}</span>
                  {m.mode === "multi" && <span style={tagMuted}>같이</span>}
                  <span style={{ color: C.inkMuted, fontSize: TOKENS.size.caption, flexShrink: 0 }}>{CAT[m.category] ?? "스낵"}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Making apps needs the AI builder (server); the static build hides it. */}
        {!SERVERLESS && (
          <button className="blk" style={makeCta} onClick={() => { location.href = hrefTo("/create"); }}>➕ 나도 하나 만들어 공유</button>
        )}

        {/* For everyone: what happened on PlaySnack, as anonymous counts. */}
        <StatsLink onOpen={() => navigate("/stats")} />
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed", inset: 0, background: C.bg, color: C.ink, overflowY: "auto",
  // CRT scanlines — subtle arcade-cabinet texture over the black ground.
  backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px)",
  padding: `calc(var(--snack-safe-top) + ${S.s5}px) 16px 40px`, font: `16px ${TOKENS.font.body}`,
};
const brand: React.CSSProperties = { fontFamily: TOKENS.font.displayLatin, fontSize: 11, color: C.accent, letterSpacing: 1 };
const h1: React.CSSProperties = { fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 600, margin: `${S.s3}px 0 ${S.s2}px`, lineHeight: 1.4 };
const sectionTitle: React.CSSProperties = { fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 600, margin: `${S.s5}px 0 ${S.s3}px`, lineHeight: 1.4 };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.s3 };
const card: React.CSSProperties = {
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
  boxShadow: blockShadow, padding: S.s4, textAlign: "left", cursor: "pointer", color: C.ink,
  display: "flex", flexDirection: "column", alignItems: "flex-start", font: `16px ${TOKENS.font.body}`,
};
// Body font: the pixel face is only for Latin/digit-only text (design system rule).
const cardTitle: React.CSSProperties = { fontWeight: 700, fontSize: TOKENS.size.bodyMd, marginTop: S.s2, lineHeight: 1.35 };
const tag: React.CSSProperties = { border: `1px solid ${C.accent}`, color: C.accent, borderRadius: R.chip, padding: "1px 7px", fontSize: 11, fontWeight: 800 };
const tagMuted: React.CSSProperties = { ...tag, borderColor: C.borderBlock, color: C.inkMuted, flexShrink: 0 };
// 검토 전: smaller muted heading + a flat hairline list (no block shadow, no lime).
const subTitle: React.CSSProperties = { fontFamily: TOKENS.font.heading, fontSize: TOKENS.size.bodyLg, fontWeight: 700, color: C.inkMuted, margin: `${S.s6}px 0 ${S.s1}px`, lineHeight: 1.4 };
const subNote: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.caption, margin: `0 0 ${S.s3}px`, lineHeight: 1.5 };
const list: React.CSSProperties = { display: "flex", flexDirection: "column", border: `${TOKENS.border.hairline}px solid ${C.hairline}`, borderBottom: "none", background: C.bg };
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: S.s3, minHeight: TOKENS.layout.tap, padding: `${S.s2}px ${S.s3}px`,
  background: "transparent", border: "none", borderBottom: `${TOKENS.border.hairline}px solid ${C.hairline}`,
  color: C.ink, textAlign: "left", cursor: "pointer", font: `${TOKENS.size.bodyMd}px ${TOKENS.font.body}`,
};
const rowTitle: React.CSSProperties = { flex: 1, minWidth: 0, fontWeight: 600, color: C.ink, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tagInline: React.CSSProperties = { ...tag, fontSize: 12, padding: "1px 6px" };
// 대표작: the one lime hero on the page — dark ink on lime, chunky block edges.
const hero: React.CSSProperties = {
  marginTop: S.s5, padding: S.s4, background: C.accent, color: C.accentInk, borderRadius: R.block,
  border: `${TOKENS.border.block}px solid ${C.accentInk}`, boxShadow: blockShadow,
  display: "flex", flexDirection: "column", alignItems: "stretch",
};
const heroKicker: React.CSSProperties = {
  alignSelf: "flex-start", background: C.accentInk, color: C.accent, borderRadius: R.chip,
  padding: `2px ${S.s2}px`, fontSize: TOKENS.size.caption, fontWeight: 800, lineHeight: 1.5,
};
const heroTitle: React.CSSProperties = { fontFamily: TOKENS.font.heading, fontSize: TOKENS.size.titleLg, fontWeight: 700, marginTop: S.s3, lineHeight: 1.35 };
const heroBody: React.CSSProperties = { margin: `${S.s1}px 0 0`, fontSize: TOKENS.size.bodyMd, fontWeight: 600, lineHeight: 1.5 };
const heroPrimary: React.CSSProperties = {
  marginTop: S.s4, minHeight: TOKENS.layout.btnH, padding: `0 ${S.s4}px`, borderRadius: R.block,
  border: `${TOKENS.border.block}px solid ${C.accentInk}`, background: C.accentInk, color: C.accent, boxShadow: blockShadow,
  fontFamily: TOKENS.font.heading, fontWeight: 800, fontSize: TOKENS.size.bodyLg, cursor: "pointer",
};
const heroSecondary: React.CSSProperties = {
  marginTop: S.s3, minHeight: TOKENS.layout.tap, background: "transparent", border: "none", color: C.accentInk,
  fontFamily: TOKENS.font.heading, fontWeight: 700, fontSize: TOKENS.size.bodyMd, textDecoration: "underline",
  textUnderlineOffset: 3, cursor: "pointer",
};
// A secondary block (dark surface, not lime) so the 대표작 stays the only lime hero.
const makeCta: React.CSSProperties = {
  width: "100%", marginTop: S.s5, padding: S.s4, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  background: C.surface, color: C.ink, boxShadow: blockShadow, fontWeight: 800, fontSize: TOKENS.size.bodyLg, cursor: "pointer",
};
