import { useEffect, useRef, useState } from "react";
import type { BiteDoc } from "@snack/bite";
import { BitePlayer } from "./BitePlayer.tsx";
import { AI_UNAVAILABLE, SERVERLESS, buildWithAi, getTemplateDoc, listTemplates, rateTemplate as rateRemote, shareApp } from "./backend";

// The "mobile studio" = chat. Describe an app/game -> server builds a Bite app
// (gpt-5.5 + validate + repair) -> render it live. Refine by sending again.
// Deep-clone the doc and replace one text node's copy (found by id).
// Direct in-app text edit: no AI round-trip, no server call — just a doc patch.
// Braces are escaped so typed text can never become a template expression.
function setNodeText(doc: BiteDoc, id: string, text: string): BiteDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as BiteDoc;
  const walk = (node: Record<string, unknown> | undefined): boolean => {
    if (!node || typeof node !== "object") return false;
    if (node.id === id && "text" in node) {
      node.text = text.replace(/\{/g, "{{");
      return true;
    }
    return ((node.children as Record<string, unknown>[] | undefined) ?? []).some(walk);
  };
  walk(clone.view as Record<string, unknown>);
  return clone;
}

// Phase ids are technical (idle/ready/play/lobby/q1…). Friendly label for the
// edit-mode scene switcher; unknown ids fall back to the raw id.
function stateLabel(id: string): string {
  const q = /^q(\d+)$/.exec(id);
  if (q) return `문제 ${q[1]}`;
  const m: Record<string, string> = {
    idle: "기본", ready: "시작", play: "진행", result: "결과", lobby: "대기",
    countdown: "카운트", spinning: "돌리는 중", spin: "돌리기", quiz: "문제",
    input: "입력", show: "보기", waiting: "대기", intro: "시작",
  };
  return m[id] ?? id;
}

const EXAMPLES = [
  "치킨 vs 피자 투표",
  "탭하면 점수 오르는 두더지 잡기",
  "오늘 기분 이모지 고르기",
  "신호등 색 바꾸기 게임",
];
const BUILD_MSGS = [
  "아이디어를 읽는 중…",
  "화면을 그리는 중…",
  "동작을 연결하는 중…",
  "검증하는 중…",
];

export function CreateApp() {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<"input" | "building" | "done" | "error">("input");
  // Version history: v0 = initial build, each refine appends. currentIdx is
  // the shown version; "되돌리기" just moves the pointer (a later refine
  // branches from wherever you are and appends).
  const [versions, setVersions] = useState<{ label: string; doc: BiteDoc }[]>([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [showHistory, setShowHistory] = useState(false);
  const doc = currentIdx >= 0 ? versions[currentIdx].doc : null;
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false); // only true after the clipboard write resolved
  const [sharing, setSharing] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refining, setRefining] = useState(false);
  const [multiplayer, setMultiplayer] = useState(false); // detected/chosen mode
  const [refineOpen, setRefineOpen] = useState(false); // FAB → refine input
  const [refineSummary, setRefineSummary] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false); // mode-switch confirm modal
  // Direct text editing (✏️ → 직접 편집): tap a static text layer → inline input.
  const [editMode, setEditMode] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false); // ✏️ → 직접/AI choice
  const [textSel, setTextSel] = useState<{ layerId: string; rect: DOMRect; text: string; editable: boolean } | null>(null);
  const [editRects, setEditRects] = useState<Array<{ layerId: string; editable: boolean; rect: { left: number; top: number; width: number; height: number } }>>([]);
  const [editDraft, setEditDraft] = useState("");
  const [editState, setEditState] = useState<string | undefined>(undefined); // which scene/state is shown for editing
  const resetEdit = () => { setEditMode(false); setEditMenuOpen(false); setEditState(undefined); setTextSel(null); setEditRects([]); };
  // Keep editState valid when the doc changes (revert / refine / mode-switch):
  // if the shown state no longer exists in the new doc, snap to its initial state.
  useEffect(() => {
    if (!editMode || !doc) return;
    const st = Object.keys(doc.phases ?? {});
    if (editState && !st.includes(editState)) setEditState(doc.start ?? st[0]);
  }, [doc, editMode, editState]);
  const botRef = useRef<HTMLDivElement>(null);  // 🤖 pulse during build
  const barRef = useRef<HTMLDivElement>(null);  // indeterminate progress shimmer
  const flashSummary = (s?: string) => { setRefineSummary(s || "수정했어요"); setTimeout(() => setRefineSummary(null), 3500); };

  // ── Template gallery (Create landing) ──
  type Tpl = { id: string; title: string; category: string; emoji: string; accent: string; mode: string; avg: number; ratingCount: number; useCount: number; rank: number };
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [tplSort, setTplSort] = useState<"rank" | "rating" | "popular" | "recent">("rank");
  const [tplCat, setTplCat] = useState("all");
  const [rated, setRated] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("snack.rated") || "{}"); } catch { return {}; }
  });
  const [loadingTpl, setLoadingTpl] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "input") return;
    listTemplates({ sort: tplSort, category: tplCat })
      .then((j) => { setTemplates((j.templates || []) as Tpl[]); if (j.categories) setCats(j.categories); })
      .catch(() => { /* gallery is optional */ });
  }, [phase, tplSort, tplCat]);

  // Pick a template → load its doc as v0, drop into the live player (refine/share/rate from there).
  const pickTemplate = async (t: Tpl) => {
    resetEdit();
    setLoadingTpl(t.id);
    try {
      const r = { doc: await getTemplateDoc(t.id) };
      if (r?.doc) {
        setPrompt(t.title);
        setVersions([{ label: `템플릿: ${t.title}`, doc: r.doc }]);
        setCurrentIdx(0);
        setMultiplayer(t.mode === "multi");
        setShareUrl(null); setShowHistory(false); setPhase("done");
      }
    } catch { /* ignore */ } finally { setLoadingTpl(null); }
  };

  const rateTemplate = async (id: string, stars: number) => {
    const next = { ...rated, [id]: stars };
    setRated(next);
    try { localStorage.setItem("snack.rated", JSON.stringify(next)); } catch { /* ignore */ }
    try {
      const v = await rateRemote(id, stars);
      if (v?.id) setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, avg: v.avg, ratingCount: v.ratingCount } : t)));
    } catch { /* ignore */ }
  };

  const SORT_LABELS: Record<string, string> = { rank: "인기순", rating: "별점순", popular: "많이쓴순", recent: "최신순" };
  const CAT_LABELS: Record<string, string> = {
    worldcup: "월드컵", vote: "투표", quiz: "퀴즈", psych: "테스트", game: "게임", random: "랜덤", reaction: "반응", counter: "카운터",
  };

  // Flip between "everyone together" (multiplayer) and "just me" (single) —
  // re-builds the current app in the target mode, keeping the same idea.
  const switchMode = async () => {
    if (!doc) return;
    const target = multiplayer ? "single" : "multi";
    setRefining(true);
    try {
      const r = await buildWithAi({
        current: doc, mode: target, rebuild: true, // structural conversion → full rebuild
        prompt: target === "multi" ? "여럿이 같은 링크로 함께 참여하는 형태로 바꿔줘" : "혼자 쓰는 형태로 바꿔줘",
      });
      if (r.valid && r.doc) {
        const next = r.doc;
        setVersions((prev) => [...prev, { label: target === "multi" ? "👥 같이 참여로" : "👤 나만으로", doc: next }]);
        setCurrentIdx(versions.length);
        setMultiplayer(!!r.multiplayer);
        setShareUrl(null); setShowHistory(false);
        flashSummary(target === "multi" ? "같이 참여하는 형태로 바꿨어요" : "혼자 쓰는 형태로 바꿨어요");
      } else { flashSummary(r.error || "전환 실패 — 다시 시도해주세요"); }
    } catch (e) { flashSummary(String((e as Error).message || e)); } finally { setRefining(false); }
  };

  const refine = async () => {
    const p = refinePrompt.trim();
    if (!p || !doc) return;
    setRefining(true);
    try {
      const r = await buildWithAi({ prompt: p, current: doc, mode: multiplayer ? "multi" : "single" });
      if (r.valid && r.doc) {
        const next = r.doc;
        setVersions((prev) => [...prev, { label: p, doc: next }]);
        setCurrentIdx(versions.length); // append index (no concurrent build)
        setMultiplayer(!!r.multiplayer);
        setShareUrl(null); setShowHistory(false); setRefinePrompt(""); setRefineOpen(false);
        flashSummary(r.summary);
      } else { flashSummary(r.error || "수정 실패 — 다시 시도해주세요"); }
    } catch (e) { flashSummary(String((e as Error).message || e)); } finally { setRefining(false); }
  };

  const share = async () => {
    if (!doc) return;
    setSharing(true);
    try {
      const url = await shareApp(doc);
      setShareUrl(url);
      // The link is shown below either way; "복사됨" only when the write really happened.
      try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
    } catch { /* ignore */ } finally { setSharing(false); }
  };

  // Commit a direct text edit → append as a new version (free undo via history).
  // No-op edits don't spawn a version. Persist rides the existing share() flow.
  const commitText = () => {
    if (!textSel || !doc) return;
    if (editDraft === textSel.text) { setTextSel(null); return; }
    const next = setNodeText(doc, textSel.layerId, editDraft);
    setVersions((prev) => [...prev, { label: `✏️ "${editDraft.slice(0, 10)}"`, doc: next }]);
    setCurrentIdx(versions.length);
    setTextSel(null); setShareUrl(null);
  };

  useEffect(() => {
    if (phase !== "building") return;
    const t0 = Date.now();
    const a = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    const b = setInterval(() => setMsgIdx((i) => (i + 1) % BUILD_MSGS.length), 2200);
    const pulse = botRef.current?.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }],
      { duration: 1200, iterations: Infinity, easing: "ease-in-out" });
    const shimmer = barRef.current?.animate(
      [{ transform: "translateX(-110%)" }, { transform: "translateX(260%)" }],
      { duration: 1300, iterations: Infinity, easing: "ease-in-out" });
    return () => { clearInterval(a); clearInterval(b); pulse?.cancel(); shimmer?.cancel(); };
  }, [phase]);

  const build = async (p: string) => {
    if (!p.trim()) return;
    resetEdit();
    setPhase("building"); setErr(null); setElapsed(0); setMsgIdx(0);
    try {
      const r = await buildWithAi({ prompt: p });
      if (r.valid && r.doc) { setVersions([{ label: p, doc: r.doc }]); setCurrentIdx(0); setMultiplayer(!!r.multiplayer); setPhase("done"); }
      else { setErr(r.error || "생성 실패"); setPhase("error"); }
    } catch (e) { setErr(String(e)); setPhase("error"); }
  };

  if (phase === "done" && doc) {
    const sceneStates = Object.keys(doc.phases ?? {});
    return (
      <div style={{ position: "fixed", inset: 0 }}>
        <BitePlayer doc={doc} editable={editMode} editPhase={editState}
          onSelectText={(s) => { setTextSel(s); setEditDraft(s?.text ?? ""); }}
          onEditableRects={setEditRects} />
        <div style={topBar}>
          <button style={pill} onClick={() => { setVersions([]); setCurrentIdx(-1); setShareUrl(null); setCopied(false); setShowHistory(false); resetEdit(); setPhase("input"); }}>← 새로</button>
          <button style={{ ...pill, background: multiplayer ? "rgba(108,99,255,0.85)" : "rgba(0,0,0,0.6)" }}
            onClick={() => setConfirmSwitch(true)} disabled={refining || editMode} title="혼자 ↔ 같이 전환">
            {multiplayer ? "👥 같이 참여" : "👤 나만"}
          </button>
          <button style={{ ...pill, background: "#D9FF00", color: "#0B0C0E", fontWeight: 800 }} onClick={share} disabled={sharing}>
            {sharing ? "공유 중…" : shareUrl ? (copied ? "✓ 링크 복사됨" : "🔗 링크 아래에") : "🔗 공유"}
          </button>
        </div>
        {editMode && sceneStates.length > 1 && (
          <div style={stateChipBar}>
            {sceneStates.map((s) => (
              <button key={s} data-editstate={s} onClick={() => { setEditState(s); setTextSel(null); }}
                style={{ ...stateChip, ...(editState === s ? stateChipOn : {}) }}>{stateLabel(s)}</button>
            ))}
          </div>
        )}
        {shareUrl && (
          <div style={shareToast}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shareUrl}</span>
            <button style={{ ...pill, background: "#fff", color: "#0B0C0E", padding: "5px 10px" }} onClick={() => (location.href = shareUrl)}>열기 →</button>
          </div>
        )}
        {refineSummary && <div style={summaryToast}>✓ {refineSummary}</div>}
        {refineOpen && showHistory && versions.length > 0 && (
          <div style={historyPanel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>버전 기록 ({versions.length})</span>
              <button style={{ ...pill, padding: "4px 10px" }} onMouseDown={(e) => e.preventDefault()} onClick={() => setShowHistory(false)}>✕</button>
            </div>
            <div style={{ overflowY: "auto", maxHeight: "40vh" }}>
              {versions.map((v, i) => (
                <div key={i} style={historyRow}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
                    <b style={{ color: "#D9FF00" }}>{i === 0 ? "처음" : `수정 ${i}`}</b> · {v.label}
                  </span>
                  {i === currentIdx
                    ? <span style={curBadge}>현재</span>
                    : <button style={revertBtn} onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setCurrentIdx(i); setShareUrl(null); setShowHistory(false); }}>되돌리기</button>}
                </div>
              ))}
            </div>
          </div>
        )}
        {refineOpen ? (
          <div style={refineBar}>
            <button style={{ ...pill, padding: "10px 12px" }} onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setRefineOpen(false); setShowHistory(false); }}>✕</button>
            <input
              autoFocus
              value={refinePrompt} onChange={(e) => setRefinePrompt(e.target.value)}
              onFocus={() => setShowHistory(true)}
              onKeyDown={(e) => { if (e.key === "Enter") refine(); }}
              placeholder="수정 요청… 예: 색을 더 밝게, 선택지 3개로"
              style={refineInput} disabled={refining}
            />
            <button style={{ ...pill, background: "#D9FF00", color: "#0B0C0E", fontWeight: 800 }}
              onMouseDown={(e) => e.preventDefault()} onClick={refine} disabled={refining || !refinePrompt.trim()}>
              {refining ? "…" : "수정"}
            </button>
          </div>
        ) : editMode ? null : editMenuOpen ? (
          <div style={editMenu}>
            <button style={editItem} onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setEditMenuOpen(false); setEditMode(true); setEditState(doc.start ?? sceneStates[0]); }}>✏️ 직접 편집</button>
            {!SERVERLESS && (
              <button style={editItem} onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setEditMenuOpen(false); setRefineOpen(true); setShowHistory(true); }}>💬 AI로 수정</button>
            )}
            <button style={{ ...editItem, color: "#778", fontWeight: 600 }} onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditMenuOpen(false)}>닫기</button>
          </div>
        ) : (
          <button style={fab} onClick={() => setEditMenuOpen(true)} title="수정하기">✏️</button>
        )}
        {/* dashed hints on every editable text — shows what's tappable */}
        {editMode && editRects.filter((r) => r.editable).map((r) => (
          <div key={r.layerId} style={{
            position: "fixed", left: r.rect.left - 3, top: r.rect.top - 3,
            width: r.rect.width + 6, height: r.rect.height + 6,
            border: "1.5px dashed rgba(217,255,0,0.55)", borderRadius: 6, pointerEvents: "none", zIndex: 8,
          }} />
        ))}
        {/* selection box on the tapped text (lime = editable, red = locked) */}
        {editMode && textSel && (
          <div style={{
            position: "fixed", left: textSel.rect.left - 4, top: textSel.rect.top - 4,
            width: textSel.rect.width + 8, height: textSel.rect.height + 8, borderRadius: 7,
            border: `2px solid ${textSel.editable ? "#D9FF00" : "#FF6B6B"}`,
            background: textSel.editable ? "rgba(217,255,0,0.12)" : "rgba(255,107,107,0.12)",
            pointerEvents: "none", zIndex: 9,
          }} />
        )}
        {editMode && !textSel && (
          // pointer-events:none so the bar doesn't cover/block taps on text
          // beneath it (e.g. a hint at the screen bottom); only 완료 is tappable.
          <div style={{ ...editBar, pointerEvents: "none" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>✏️ 편집할 텍스트를 탭하세요</span>
            <button style={{ ...pill, background: "#D9FF00", color: "#0B0C0E", fontWeight: 800, pointerEvents: "auto" }}
              onClick={() => { setEditMode(false); setTextSel(null); }}>완료</button>
          </div>
        )}
        {editMode && textSel && (
          <div style={editSheet}>
            {textSel.editable ? (
              <>
                <div style={sheetTitle}>✏️ 텍스트 편집</div>
                <textarea autoFocus value={editDraft} rows={2}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); } else if (e.key === "Escape") setTextSel(null); }}
                  style={sheetInput} />
                <div style={sheetBtns}>
                  <button style={sheetCancel} onClick={() => setTextSel(null)}>취소</button>
                  <button style={{ ...sheetSave, opacity: editDraft.trim() ? 1 : 0.5 }} onClick={commitText} disabled={!editDraft.trim()}>저장</button>
                </div>
              </>
            ) : (
              <>
                <div style={sheetTitle}>🔒 자동으로 바뀌는 값</div>
                <div style={sheetNote}>점수·시간처럼 앱이 자동으로 채우는 텍스트예요. 직접 수정할 수 없어요.</div>
                <div style={sheetBtns}><button style={sheetCancel} onClick={() => setTextSel(null)}>닫기</button></div>
              </>
            )}
          </div>
        )}
        {refining && <div style={refineOverlay}>✏️ 수정 중…</div>}
        {confirmSwitch && (
          <div style={confirmWrap}>
            <div style={confirmCard}>
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>
                {multiplayer ? "👤 나만 쓰는 형태로 바꿀까요?" : "👥 다 같이 참여하는 형태로 바꿀까요?"}
              </div>
              <div style={{ color: "#9aa", fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}>
                {multiplayer
                  ? "공유 투표 기능을 빼고 혼자 쓰는 앱으로 다시 만들어요."
                  : "여럿이 같은 링크로 참여하는 실시간 앱으로 다시 만들어요."}<br />앱 전체를 다시 만들어요 (약 1분). 지금 버전은 기록에 남아요.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button style={{ ...pill, padding: "10px 18px" }} onClick={() => setConfirmSwitch(false)}>취소</button>
                <button style={{ ...pill, padding: "10px 18px", background: "#D9FF00", color: "#0B0C0E", fontWeight: 800 }}
                  onClick={() => { setConfirmSwitch(false); switchMode(); }}>바꾸기</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={shell}>
      <div style={{ maxWidth: 440, margin: "0 auto", width: "100%" }}>
        <div style={{ fontSize: 13, color: "#D9FF00", fontWeight: 700, letterSpacing: 1 }}>SNACK STUDIO</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: "8px 0 4px", lineHeight: 1.2 }}>뭘 만들까요?</h1>
        <p style={{ color: "#9aa", margin: "0 0 20px", fontSize: 14 }}>{SERVERLESS ? "템플릿을 골라 내 마음대로 바꾸고, 링크로 같이 해요." : "한 줄로 말하면 앱을 만들어 드려요."}</p>

        {phase === "building" ? (
          <div style={buildBox}>
            <div ref={botRef} style={{ fontSize: 46, marginBottom: 14 }}>🤖</div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>{BUILD_MSGS[msgIdx]}</div>
            <div style={progressTrack}><div ref={barRef} style={progressFill} /></div>
            <div style={{ color: "#778", marginTop: 12, font: "13px ui-monospace,monospace" }}>{elapsed}s · 보통 10–40초</div>
            <div style={{ color: "#556", marginTop: 4, fontSize: 12 }}>"{prompt}"</div>
          </div>
        ) : (
          <>
            {SERVERLESS ? (
              <div style={{ ...buildBox, textAlign: "left", fontSize: 14, lineHeight: 1.6, color: "#cfd3da" }}>{AI_UNAVAILABLE}</div>
            ) : (
              <>
                <textarea
                  value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  placeholder="예: 친구들이랑 점심 메뉴 투표하는 화면"
                  style={textarea} rows={3}
                />
                <button style={cta} onClick={() => build(prompt)} disabled={!prompt.trim()}>✨ 만들기</button>
                {phase === "error" && <div style={{ color: "#FF6B6B", marginTop: 12, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{err}</div>}
                <div style={{ marginTop: 24, color: "#778", fontSize: 12, marginBottom: 8 }}>예시</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {EXAMPLES.map((ex) => (
                    <button key={ex} style={chip} onClick={() => { setPrompt(ex); build(ex); }}>{ex}</button>
                  ))}
                </div>
              </>
            )}

            {templates.length > 0 && (
              <div style={{ marginTop: 34 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                  <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>템플릿으로 시작</h2>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["rank", "rating", "popular", "recent"] as const).map((s) => (
                      <button key={s} onClick={() => setTplSort(s)}
                        style={{ ...sortChip, ...(tplSort === s ? sortChipOn : {}) }}>{SORT_LABELS[s]}</button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  <button onClick={() => setTplCat("all")} style={{ ...catChip, ...(tplCat === "all" ? catChipOn : {}) }}>전체</button>
                  {cats.map((c) => (
                    <button key={c} onClick={() => setTplCat(c)} style={{ ...catChip, ...(tplCat === c ? catChipOn : {}) }}>
                      {CAT_LABELS[c] || c}
                    </button>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {templates.map((t) => (
                    <div key={t.id} style={tplCard}>
                      <button style={tplOpen} onClick={() => pickTemplate(t)} disabled={!!loadingTpl}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 26 }}>{t.emoji}</span>
                          {t.mode === "multi" && <span style={multiBadge}>같이</span>}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 14, marginTop: 8, lineHeight: 1.3 }}>
                          {loadingTpl === t.id ? "여는 중…" : t.title}
                        </div>
                        <div style={{ color: "#778", fontSize: 11, marginTop: 3 }}>
                          {CAT_LABELS[t.category] || t.category}{t.ratingCount > 0 ? ` · ★${t.avg} (${t.ratingCount})` : ""}
                        </div>
                      </button>
                      <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button key={n} onClick={() => rateTemplate(t.id, n)} title={`${n}점`}
                            style={{ ...star, color: n <= (rated[t.id] || 0) ? "#D9FF00" : "#3a3d44" }}>★</button>
                        ))}
                        {rated[t.id] && <span style={{ color: "#778", fontSize: 10, alignSelf: "center", marginLeft: 4 }}>평가함</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed", inset: 0, background: "#0B0C0E", color: "#fff",
  padding: "calc(env(safe-area-inset-top,0) + 32px) 22px 22px", overflowY: "auto",
  font: "16px -apple-system, system-ui, sans-serif",
};
const textarea: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", background: "#16181C", color: "#fff",
  border: "1px solid #2A2D33", borderRadius: 14, padding: 14, fontSize: 16, resize: "none", outline: "none",
};
const cta: React.CSSProperties = {
  width: "100%", marginTop: 12, padding: "15px", borderRadius: 14, border: "none",
  background: "#D9FF00", color: "#0B0C0E", fontWeight: 800, fontSize: 16, cursor: "pointer",
};
const chip: React.CSSProperties = {
  background: "#16181C", color: "#cdd", border: "1px solid #2A2D33", borderRadius: 999,
  padding: "8px 14px", fontSize: 13, cursor: "pointer",
};
const sortChip: React.CSSProperties = {
  background: "transparent", color: "#778", border: "none", borderRadius: 999,
  padding: "4px 8px", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const sortChipOn: React.CSSProperties = { background: "#16181C", color: "#D9FF00" };
const catChip: React.CSSProperties = {
  background: "#16181C", color: "#9aa", border: "1px solid #2A2D33", borderRadius: 999,
  padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const catChipOn: React.CSSProperties = { background: "#D9FF00", color: "#0B0C0E", border: "1px solid #D9FF00" };
const tplCard: React.CSSProperties = {
  background: "#16181C", border: "1px solid #2A2D33", borderRadius: 16, padding: 12,
  display: "flex", flexDirection: "column",
};
const tplOpen: React.CSSProperties = {
  background: "transparent", border: "none", color: "#fff", textAlign: "left",
  cursor: "pointer", padding: 0, width: "100%",
};
const multiBadge: React.CSSProperties = {
  background: "rgba(108,99,255,0.22)", color: "#a99dff", borderRadius: 999,
  padding: "2px 8px", fontSize: 10, fontWeight: 700,
};
const star: React.CSSProperties = {
  background: "transparent", border: "none", padding: 0, fontSize: 16, cursor: "pointer", lineHeight: 1,
};
const buildBox: React.CSSProperties = {
  background: "#16181C", borderRadius: 16, padding: "40px 20px", textAlign: "center", border: "1px solid #2A2D33",
};
const progressTrack: React.CSSProperties = {
  position: "relative", width: "70%", height: 4, margin: "18px auto 0", borderRadius: 999,
  background: "#23262C", overflow: "hidden",
};
const progressFill: React.CSSProperties = {
  position: "absolute", top: 0, bottom: 0, width: "40%", borderRadius: 999,
  background: "linear-gradient(90deg, transparent, #D9FF00, transparent)",
};
const topBar: React.CSSProperties = {
  position: "fixed", top: "calc(env(safe-area-inset-top,0) + 10px)", left: 12, right: 12,
  display: "flex", gap: 10, justifyContent: "space-between", zIndex: 10,
};
const pill: React.CSSProperties = {
  background: "rgba(0,0,0,0.6)", color: "#fff", border: "none", borderRadius: 999,
  padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", backdropFilter: "blur(8px)",
  flexShrink: 0, whiteSpace: "nowrap", // never let buttons collapse to "…"
};
const shareToast: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, top: "calc(env(safe-area-inset-top,0) + 56px)",
  display: "flex", gap: 8, alignItems: "center", zIndex: 10,
  background: "rgba(0,0,0,0.72)", color: "#fff", borderRadius: 12, padding: "8px 10px",
  font: "12px ui-monospace,monospace", backdropFilter: "blur(8px)",
};
const refineBar: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom,0) + 12px)",
  display: "flex", gap: 8, alignItems: "center", zIndex: 10,
};
const refineInput: React.CSSProperties = {
  flex: 1, minWidth: 0, boxSizing: "border-box", background: "rgba(20,22,26,0.92)", color: "#fff",
  border: "1px solid #2A2D33", borderRadius: 999, padding: "11px 14px", fontSize: 14, outline: "none",
  backdropFilter: "blur(8px)", // minWidth:0 lets it shrink so the 수정 button keeps its size
};
const historyPanel: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom,0) + 64px)",
  zIndex: 11, background: "rgba(11,12,14,0.96)", border: "1px solid #2A2D33", borderRadius: 14,
  padding: 12, color: "#fff", backdropFilter: "blur(10px)",
};
const historyRow: React.CSSProperties = {
  display: "flex", gap: 8, alignItems: "center", padding: "7px 0", borderTop: "1px solid #1E2127",
};
const revertBtn: React.CSSProperties = {
  background: "#23262C", color: "#fff", border: "1px solid #34383F", borderRadius: 999,
  padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const curBadge: React.CSSProperties = {
  background: "#D9FF00", color: "#0B0C0E", borderRadius: 999, padding: "4px 10px",
  fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
};
const summaryToast: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, top: "calc(env(safe-area-inset-top,0) + 56px)", zIndex: 12,
  background: "rgba(18,183,106,0.92)", color: "#fff", borderRadius: 12, padding: "10px 14px",
  font: "600 14px -apple-system, system-ui, sans-serif", textAlign: "center", backdropFilter: "blur(8px)",
};
const fab: React.CSSProperties = {
  position: "fixed", right: 18, bottom: "calc(env(safe-area-inset-bottom,0) + 18px)", zIndex: 11,
  width: 60, height: 60, borderRadius: "50%", border: "none", cursor: "pointer",
  background: "#D9FF00", color: "#0B0C0E", fontSize: 26, lineHeight: "60px", textAlign: "center",
  boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
};
const confirmWrap: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(0,0,0,0.55)", padding: 22,
};
const confirmCard: React.CSSProperties = {
  width: "100%", maxWidth: 360, background: "#16181C", border: "1px solid #2A2D33",
  borderRadius: 18, padding: 22, color: "#fff",
};
const refineOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(0,0,0,0.45)", color: "#fff", font: "700 18px -apple-system, system-ui, sans-serif", zIndex: 20,
};
const editBar: React.CSSProperties = {
  position: "fixed", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom,0) + 16px)",
  display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", zIndex: 12,
  background: "rgba(0,0,0,0.74)", color: "#fff", borderRadius: 14, padding: "10px 14px", backdropFilter: "blur(8px)",
};
const editMenu: React.CSSProperties = {
  position: "fixed", right: 18, bottom: "calc(env(safe-area-inset-bottom,0) + 18px)", zIndex: 12,
  display: "flex", flexDirection: "column", gap: 8, background: "rgba(11,12,14,0.96)",
  border: "1px solid #2A2D33", borderRadius: 14, padding: 10, backdropFilter: "blur(10px)",
};
const editItem: React.CSSProperties = {
  background: "#16181C", color: "#fff", border: "1px solid #2A2D33", borderRadius: 10,
  padding: "11px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", textAlign: "left",
};
const stateChipBar: React.CSSProperties = {
  position: "fixed", top: "calc(env(safe-area-inset-top,0) + 52px)", left: 0, right: 0, zIndex: 13,
  display: "flex", gap: 6, overflowX: "auto", padding: "6px 12px",
};
const stateChip: React.CSSProperties = {
  flexShrink: 0, background: "rgba(0,0,0,0.6)", color: "#cdd", border: "1px solid #2A2D33",
  borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
  whiteSpace: "nowrap", backdropFilter: "blur(8px)",
};
const stateChipOn: React.CSSProperties = { background: "#D9FF00", color: "#0B0C0E", border: "1px solid #D9FF00" };
const editSheet: React.CSSProperties = {
  position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30,
  background: "rgba(16,18,22,0.98)", borderTop: "1px solid #2A2D33",
  borderRadius: "18px 18px 0 0", padding: "16px 16px calc(env(safe-area-inset-bottom,0) + 16px)",
  color: "#fff", backdropFilter: "blur(10px)", boxShadow: "0 -8px 30px rgba(0,0,0,0.5)",
};
const sheetTitle: React.CSSProperties = { fontSize: 15, fontWeight: 800, marginBottom: 10 };
const sheetInput: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", background: "#0B0C0E", color: "#fff",
  border: "2px solid #D9FF00", borderRadius: 10, padding: "10px 12px", fontSize: 16,
  resize: "none", outline: "none", font: "600 16px -apple-system, system-ui, sans-serif",
};
const sheetNote: React.CSSProperties = { color: "#9aa", fontSize: 13, lineHeight: 1.5, marginBottom: 4 };
const sheetBtns: React.CSSProperties = { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 };
const sheetCancel: React.CSSProperties = {
  background: "#23262C", color: "#fff", border: "1px solid #34383F", borderRadius: 999,
  padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer",
};
const sheetSave: React.CSSProperties = {
  background: "#D9FF00", color: "#0B0C0E", border: "none", borderRadius: 999,
  padding: "10px 22px", fontSize: 14, fontWeight: 800, cursor: "pointer",
};
