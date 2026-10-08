import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getNick } from "./identity";
import { SERVERLESS, hrefTo, listTemplates, loadLive } from "./backend";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";

// Home = LIVE ARCADE DASHBOARD. The whole board is dynamic: cards reorder (FLIP)
// as live trending shifts, "🟢 N playing" ticks, a global-pulse header + activity
// ticker run, and tapping a card ENTERS that snack's live shared room (/p/tpl-<id>).
// Static metadata from /api/templates; live pulse polled from /api/live.
// Skin = "Mini-Block Arcade": chunky blocks (radius 4 + 2px border + blur:0 hard
// shadow), lime is the single hero color, mono display labels. Tokens from SSOT.

type Tpl = { id: string; title: string; emoji: string; category: string; accent: string; avg: number; ratingCount: number; mode: string; usesPhoto?: boolean };
type LiveSnack = { id: string; slug: string; playing: number; recent: number; trendRank: number };
type Player = { rank: number; nick: string; points: number; plays: number };
type Live = { globalOnline: number; top: LiveSnack | null; snacks: LiveSnack[]; leaderboard: Player[] };

const CAT: Record<string, string> = { worldcup: "월드컵", vote: "투표", quiz: "퀴즈", psych: "테스트", game: "게임", random: "랜덤", reaction: "반응", counter: "카운터" };

export function Discover() {
  const [tpls, setTpls] = useState<Record<string, Tpl>>({});
  const [live, setLive] = useState<Live | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const liveSig = useRef<string>("");

  useEffect(() => {
    listTemplates().then((j) => {
      const m: Record<string, Tpl> = {};
      for (const t of j.templates || []) m[t.id] = t as Tpl;
      setTpls(m);
      // No live pulse without a server: show every snack in catalog order.
      if (SERVERLESS) setLive({ globalOnline: 0, top: null, leaderboard: [], snacks: (j.templates || []).map((t, i) => ({ id: t.id, slug: `tpl-${t.id}`, playing: 0, recent: 0, trendRank: i + 1 })) });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    // Only re-render when the live data ACTUALLY changed — an unconditional
    // setState every 3s re-rendered the whole grid and (via the FLIP effect
    // below) force-reflowed every card, stuttering any in-progress scroll.
    if (SERVERLESS) return;
    const poll = () => loadLive().then((res) => {
      const j = res as unknown as Live | null;
      if (!alive || !j) return;
      const sig = `${j.globalOnline}|` + (j.snacks || []).map((s: LiveSnack) => `${s.id}:${s.trendRank}:${s.playing}`).join(",")
        + "|" + (j.leaderboard || []).map((u: Player) => `${u.nick}:${u.points}`).join(",");
      if (sig !== liveSig.current) { liveSig.current = sig; setLive(j); }
    }).catch(() => {});
    poll();
    const iv = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const snacks = (live?.snacks || []).map((s) => ({ ...s, meta: tpls[s.id] })).filter((s) => s.meta);
  const online = live?.globalOnline ?? 0;
  const topMeta = live?.top ? tpls[live.top.id] : undefined;
  const players = live?.leaderboard || [];
  const me = getNick();
  // FLIP only when the card ORDER changes. Keyed on the rank sequence so the
  // expensive getBoundingClientRect measurement is skipped on plain count
  // updates — no forced reflow during scroll, smooth reorder animation on rank
  // shifts (which the user wants to keep).
  const orderKey = snacks.map((s) => s.id).join(",");
  useLayoutEffect(() => {
    for (const [id, el] of cardRefs.current) {
      const prev = prevRects.current.get(id);
      const now = el.getBoundingClientRect();
      if (prev) {
        const dx = prev.left - now.left, dy = prev.top - now.top;
        if (dx || dy) {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }],
            { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)" },
          );
        }
      }
      prevRects.current.set(id, now);
    }
  }, [orderKey]);

  return (
    <div style={shell}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 520, margin: "0 auto", width: "100%" }}>
        {/* Global pulse header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={brand}>SNACK · LIVE</div>
          {!SERVERLESS && (
            <div style={pulseChip}>
              <span style={dot} /> 지금 <b style={{ color: C.ink, margin: "0 3px" }}>{online}</b>명 접속 중
            </div>
          )}
        </div>
        <h1 style={h1}>{SERVERLESS ? "골라서 바로 한 판 🔥" : "지금 뜨는 스낵 🔥"}</h1>
        <p style={{ color: C.inkMuted, margin: `0 0 ${S.s4}px`, fontSize: TOKENS.size.bodyMd }}>
          {topMeta ? <>이번 시간 1위 <b style={{ color: C.ink }}>{topMeta.emoji} {topMeta.title}</b> · 매시간 갈려요</> : "탭하면 바로 같이 플레이"}
        </p>

        {/* Global player ranking (real activity points, by nickname) */}
        {players.length > 0 && (
          <>
            <h2 style={lbTitle}>🏆 플레이어 랭킹</h2>
            <div style={lbCard}>
              {players.slice(0, 5).map((p) => (
                <div key={p.rank} style={{ ...lbRow, ...(p.nick === me ? lbRowMe : {}) }}>
                  <span style={{ ...lbRank, ...(p.rank <= 3 ? lbRankTop : {}) }}>
                    {p.rank <= 3 ? ["🥇", "🥈", "🥉"][p.rank - 1] : p.rank}
                  </span>
                  <span style={lbNick}>{p.nick}{p.nick === me ? " (나)" : ""}</span>
                  <span style={lbPts}>{p.points.toLocaleString()}점</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Live ranked card grid (FLIP-reordered) */}
        <h2 style={lbTitle}>{SERVERLESS ? "🎮 스낵 게임" : "🔥 지금 뜨는 게임"}</h2>
        <div style={grid}>
          {snacks.map((s) => {
            const m = s.meta!;
            const live1 = s.playing > 0;
            return (
              <button key={s.id} className="blk" ref={(el) => { if (el) cardRefs.current.set(s.id, el); else cardRefs.current.delete(s.id); }}
                style={{ ...card, ...(!SERVERLESS && s.trendRank === 1 ? cardHot : {}) }}
                onClick={() => { location.href = hrefTo(`/p/tpl-${s.id}`); }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 34 }}>{m.emoji}</span>
                  {!SERVERLESS && <span style={{ ...rankBadge, ...(s.trendRank === 1 ? rankBadgeHot : {}) }}>#{s.trendRank}</span>}
                </div>
                <div style={cardTitle}>{m.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: S.s2, marginTop: S.s2, flexWrap: "wrap" }}>
                  {live1
                    ? <span style={playingBadge}><span style={dotSm} />{s.playing}명 플레이중</span>
                    : <span style={{ color: C.inkMuted, fontSize: TOKENS.size.caption }}>{CAT[m.category] || m.category}</span>}
                  {m.mode === "multi" && <span style={tag}>같이</span>}
                  {m.usesPhoto && <span style={photoTag}>📸 사진</span>}
                  {m.ratingCount > 0 && <span style={starBadge}>★{m.avg}</span>}
                </div>
              </button>
            );
          })}
        </div>

        <button className="blk" style={makeCta} onClick={() => { location.href = hrefTo("/create"); }}>➕ 나도 하나 만들어 공유</button>
      </div>
    </div>
  );
}

// Press = the single signature motion: tap collapses the hard shadow (block sinks).
const BEVEL = "inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.45)";
const CSS = `
@keyframes snackPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.8)} }
.blk{ transition: transform .06s ease, box-shadow .06s ease; }
.blk:hover{ transform: translateY(2px); box-shadow: ${BEVEL}, 0 4px 0 ${C.shadow}; }
.blk:active{ transform: translateY(6px); box-shadow: ${BEVEL}, 0 0 0 ${C.shadow}; }
.blk:focus-visible{ outline: 3px solid ${C.ink}; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce){ .blk{ transition: none; } }
`;
const shell: React.CSSProperties = {
  position: "fixed", inset: 0, background: C.bg, color: C.ink, overflowY: "auto",
  // CRT scanlines — subtle arcade-cabinet texture over the black ground.
  backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px)",
  padding: `calc(env(safe-area-inset-top,0) + ${S.s5}px) 18px 40px`, font: `16px ${TOKENS.font.body}`,
};
const brand: React.CSSProperties = { fontFamily: TOKENS.font.displayLatin, fontSize: 11, color: C.accent, letterSpacing: 1, textShadow: "0 0 10px rgba(217,255,0,0.5)" };
const h1: React.CSSProperties = { fontFamily: TOKENS.font.display, fontSize: 22, fontWeight: 800, margin: `${S.s3}px 0 ${S.s2}px`, lineHeight: 1.4 };
const pulseChip: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 2, background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  borderRadius: R.full, padding: "5px 11px", fontSize: TOKENS.size.caption, color: C.inkMuted,
};
const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: R.full, background: C.live, marginRight: 5, animation: "snackPulse 1.4s infinite" };
const dotSm: React.CSSProperties = { width: 6, height: 6, borderRadius: R.full, background: C.live, marginRight: 5, animation: "snackPulse 1.4s infinite" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.s3 };
const card: React.CSSProperties = {
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
  boxShadow: blockShadow, padding: S.s4, textAlign: "left", cursor: "pointer", color: C.ink,
};
const cardTitle: React.CSSProperties = { fontFamily: TOKENS.font.display, fontWeight: 800, fontSize: TOKENS.size.bodyMd, marginTop: S.s2, lineHeight: 1.35 };
const cardHot: React.CSSProperties = { border: `${TOKENS.border.block}px solid ${C.accent}`, boxShadow: `${blockShadow}, 0 0 28px rgba(217,255,0,0.16)` };
const rankBadge: React.CSSProperties = { fontFamily: TOKENS.font.display, fontSize: TOKENS.size.caption, fontWeight: 800, color: C.inkMuted, background: C.bg, borderRadius: R.bar, padding: "3px 8px" };
const rankBadgeHot: React.CSSProperties = { color: C.accentInk, background: C.accent };
const playingBadge: React.CSSProperties = { display: "flex", alignItems: "center", fontSize: TOKENS.size.caption, fontWeight: 700, color: C.live };
const tag: React.CSSProperties = { background: "rgba(180,108,255,0.18)", color: "#c9b4ff", borderRadius: R.chip, padding: "2px 8px", fontSize: 11, fontWeight: 700 };
const photoTag: React.CSSProperties = { background: C.surface2, color: C.inkMuted, borderRadius: R.chip, padding: "2px 8px", fontSize: 11, fontWeight: 700 };
const starBadge: React.CSSProperties = { color: C.ink, fontSize: TOKENS.size.caption, fontWeight: 800 };
const lbTitle: React.CSSProperties = { fontFamily: TOKENS.font.display, fontSize: 22, fontWeight: 800, margin: `${S.s5}px 0 ${S.s3}px`, lineHeight: 1.4 };
const lbCard: React.CSSProperties = { background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, boxShadow: blockShadow, padding: "6px 4px", display: "flex", flexDirection: "column" };
const lbRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: S.s3, padding: "9px 12px", borderRadius: R.bar };
const lbRowMe: React.CSSProperties = { background: "rgba(217,255,0,0.10)" };
const lbRank: React.CSSProperties = { width: 26, textAlign: "center", fontSize: TOKENS.size.bodyMd, fontWeight: 800, color: C.inkMuted, fontFamily: TOKENS.font.display };
const lbRankTop: React.CSSProperties = { fontSize: TOKENS.size.bodyLg };
const lbNick: React.CSSProperties = { flex: 1, fontFamily: TOKENS.font.display, fontSize: TOKENS.size.bodyMd, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const lbPts: React.CSSProperties = { fontFamily: TOKENS.font.display, fontSize: TOKENS.size.bodySm, fontWeight: 800, color: C.ink };
const makeCta: React.CSSProperties = {
  width: "100%", marginTop: S.s5, padding: S.s4, borderRadius: R.block, border: `${TOKENS.border.block}px solid ${C.accentInk}`,
  background: C.accent, color: C.accentInk, boxShadow: blockShadow, fontWeight: 800, fontSize: TOKENS.size.bodyLg, cursor: "pointer",
};
