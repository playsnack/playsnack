import { useEffect, useMemo, useRef, useState } from "react";
import {
  ANSWER_MS, OPTION_MAX, OPTIONS_MAX, OPTIONS_MIN, Q_MAX, QUESTIONS_MAX, QUESTIONS_MIN, TITLE_MAX,
  addOption, addSuggested, blankQuestion, buildQuizPack, capText, deviceQuizStore, draftFromPack, draftProblems, editOption, editQuestion,
  fromTemplate, graphemeLength, nameProblem, newDraft, oneLine, questionProblems, removeOption, setName, swapCandidate, swapNeedsConfirm, tapAnswer,
  type Draft, type DraftQuestion, type QuizPack,
} from "./quiz";
import { setNick } from "./identity";
import { NICK_MAX } from "./nick";
import { BLOCK_CSS, pill, primaryBtn, secondaryBtn } from "./ui";
import { TOKENS, C, S, R, blockShadow } from "./tokens.gen";

// "나 맞히기" maker (no AI, no login). Fast path: 10 suggested questions about
// me, I tap my real answer on each; ✕ drops a card, "다른 질문" swaps it for an
// unused one (asks first if I edited it), "직접 쓰기" adds my own, "고치기"
// edits any text. 5–10 questions, 10 s per question (fixed). "완료" is enabled
// once every kept question has an answer (and, for an auto-assigned guest
// nickname, once I picked the name friends will see). The draft is kept on this
// device (quiz.ts deviceQuizStore); the last quizzes made here can be loaded
// again. Preview = one read-only card of question 1 as friends will see it (a
// faithful mini card, not the Bite game screen).

type Props = {
  nick: string;
  /** The nickname was auto-assigned (identity.isNickAuto): ask for a real name. */
  nickAuto: boolean;
  /** Label of the finish button (e.g. "완료 · 친구 초대"). */
  doneLabel: string;
  /** Close label in the header ("← 홈" on its own page, "✕ 닫기" over a room). */
  closeLabel: string;
  /** A line under the heading (e.g. in a room: "다음 판은 내 퀴즈로 해요"). */
  note?: string;
  onDone: (pack: QuizPack) => void | Promise<void>;
  onClose: () => void;
};

/** A text field that never cuts the text while an IME is composing a syllable
    (Chrome Android / Safari drop the composition); `onText(text, composing)`. */
function Field({ value, onText, multiline, ...rest }: {
  value: string; onText: (text: string, composing: boolean) => void; multiline?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const composing = useRef(false);
  const handlers = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onText(e.target.value, composing.current),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => { composing.current = false; onText(e.currentTarget.value, false); },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => { composing.current = false; onText(e.currentTarget.value, false); },
  };
  return multiline
    ? <textarea {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} {...handlers}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault(); }} />
    : <input {...(rest as React.InputHTMLAttributes<HTMLInputElement>)} {...handlers} />;
}

export function QuizMaker({ nick, nickAuto, doneLabel, closeLabel, note, onDone, onClose }: Props) {
  const store = deviceQuizStore();
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = store.loadDraft();
    if (!saved) return newDraft(nick, { nickAuto });
    // A draft kept from before: still ask for a real name while the nickname is a guest one.
    return nickAuto && !saved.nameNeeded ? { ...saved, name: saved.name ?? nick, nameNeeded: true, nameChosen: false } : saved;
  });
  const [editing, setEditing] = useState<Set<string>>(() => new Set(draft.questions.filter((q) => q.custom && !q.q).map((q) => q.id)));
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [kept, setKept] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent] = useState<QuizPack[]>(() => store.recentPacks());
  const listEnd = useRef<HTMLDivElement>(null);

  // Keep the draft on the device after every change (in memory if storage fails).
  useEffect(() => {
    setKept(store.saveDraft(draft));
  }, [draft]);

  const problems = useMemo(() => draftProblems(draft), [draft]);
  const ready = problems.length === 0;
  const answered = draft.questions.filter((q) => q.answer !== null && q.answer < q.options.length).length;
  const n = draft.questions.length;
  const askName = Boolean(draft.nameNeeded);
  const namePending = nameProblem(draft);

  const update = (id: string, f: (q: DraftQuestion) => DraftQuestion) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((q) => (q.id === id ? f(q) : q)) }));
  const drop = (id: string) => setDraft((d) => ({ ...d, questions: d.questions.filter((q) => q.id !== id) }));
  const swap = (q: DraftQuestion) => {
    if (swapNeedsConfirm(q) && !confirm("직접 고친 질문이에요. 다른 질문으로 바꿀까요?")) return;
    setDraft((d) => {
      const t = swapCandidate(d);
      return t ? { ...d, questions: d.questions.map((x) => (x.id === q.id ? fromTemplate(t) : x)) } : d;
    });
    setEditing((s) => {
      const next = new Set(s);
      next.delete(q.id);
      return next;
    });
  };
  const toggleEdit = (id: string) =>
    setEditing((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const scrollToEnd = () => setTimeout(() => listEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 0);
  const addCustom = () => {
    const q = blankQuestion();
    setDraft((d) => ({ ...d, questions: [...d.questions, q] }));
    setEditing((s) => new Set(s).add(q.id));
    scrollToEnd();
  };
  const addOneSuggested = () => {
    setDraft((d) => addSuggested(d));
    scrollToEnd();
  };
  const restart = () => {
    if (!confirm("지금 만든 내용을 지우고 질문을 새로 뽑을까요?")) return;
    setDraft((d) => ({ ...newDraft(nick, { nickAuto }), ...(d.nameNeeded ? { name: d.name, nameNeeded: true, nameChosen: d.nameChosen } : {}) }));
    setEditing(new Set());
  };
  const loadRecent = (p: QuizPack) => {
    if (answered && !confirm("지금 만든 내용 대신 예전에 만든 퀴즈를 불러올까요?")) return;
    setDraft(draftFromPack(p, nick));
    setEditing(new Set());
  };
  const finish = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const pack = buildQuizPack(draft);
      // The name the creator picked is their nickname from now on (no longer a guest name).
      if (draft.nameNeeded && pack.about) setNick(pack.about);
      await onDone(pack);
    } catch (e) {
      console.warn("[quiz] finish failed", e);
      setError("퀴즈를 넘기지 못했어요. 다시 눌러 주세요.");
      setBusy(false);
    }
  };
  const canSwap = swapCandidate(draft) !== null;

  if (view === "preview") {
    return (
      <div style={shell}>
        <style>{BLOCK_CSS + INPUT_CSS}</style>
        <div style={column}>
          <div style={headerRow}>
            <button className="blk" style={pill} onClick={() => setView("edit")}>← 고치러 가기</button>
          </div>
          <h1 style={h1}>친구 화면 미리보기</h1>
          <p style={muted}>첫 번째 질문이 친구에게 이렇게 보여요. 정답 표시는 친구에게 보이지 않아요.</p>
          <PreviewCard draft={draft} />
          <p style={{ ...muted, marginTop: S.s3 }}>친구 화면에서는 보기 순서가 섞여서 나와요. 실제 게임 화면과 모양은 조금 달라요.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: S.s3, marginTop: S.s5 }}>
            <button className="blk" style={{ ...primaryBtn, ...(ready ? null : disabledBtn) }} disabled={!ready || busy} onClick={() => void finish()}>{doneLabel}</button>
            {!ready && <p style={warn} role="status">{problems[0]}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={shell}>
      <style>{BLOCK_CSS + INPUT_CSS}</style>
      <div style={{ ...column, paddingBottom: 170 }}>
        <div style={headerRow}>
          <button className="blk" style={pill} onClick={onClose}>{closeLabel}</button>
        </div>
        <h1 style={h1}>나 맞히기 만들기</h1>
        <p style={muted}>내 진짜 답을 눌러 주세요. 친구들이 내 답을 맞혀요.{note ? ` ${note}` : ""}</p>

        {askName && (
          <div style={{ ...card, marginTop: S.s4, borderColor: namePending ? C.roster3 : C.accent }}>
            <label style={{ ...label, margin: 0 }} htmlFor="quiz-name">내 이름</label>
            <p style={{ ...muted, margin: 0 }}>친구들이 알아볼 이름으로 정해 주세요. 퀴즈 제목과 순위에 보여요.</p>
            <div style={{ display: "flex", gap: S.s2 }}>
              <Field id="quiz-name" className="qin" style={{ ...input, flex: 1, minWidth: 0 }} value={draft.name ?? ""} placeholder="예: 민지"
                maxLength={NICK_MAX * 11} onText={(s, composing) => setDraft((d) => setName(d, s, { composing }))} />
              {!draft.nameChosen && (draft.name ?? "").trim() && (
                <button style={{ ...miniBtn, minHeight: 44 }} onClick={() => setDraft((d) => setName(d, d.name ?? ""))}>이 이름 그대로</button>
              )}
            </div>
          </div>
        )}

        <label style={label} htmlFor="quiz-title">퀴즈 제목</label>
        <Field id="quiz-title" className="qin" style={input} value={draft.title} maxLength={TITLE_MAX * 11}
          onText={(s, composing) => setDraft((d) => ({ ...d, title: composing ? oneLine(s) : capText(s, TITLE_MAX) }))} />

        {recent.length > 0 && (
          <div style={{ marginTop: S.s3 }}>
            <span style={{ ...muted, display: "block", marginBottom: S.s2 }}>예전에 만든 퀴즈 (이 기기에 7일 동안 보관)</span>
            <div style={{ display: "flex", gap: S.s2, flexWrap: "wrap" }}>
              {recent.map((p, i) => (
                <button key={i} style={miniBtn} onClick={() => loadRecent(p)}>↩︎ {p.title} · {p.questions.length}문제</button>
              ))}
            </div>
          </div>
        )}

        <div style={progressRow} aria-live="polite">
          <span>답 고른 질문 <b style={{ color: C.accent }}>{answered}</b>/{n}</span>
          <span style={{ color: C.inkMuted }}>질문 5~10개 · 한 문제 {ANSWER_MS / 1000}초</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: S.s4 }}>
          {draft.questions.map((q, i) => (
            <QuestionCard key={q.id} q={q} index={i} editing={editing.has(q.id)} canSwap={canSwap}
              onTap={(k) => update(q.id, (x) => tapAnswer(x, k))}
              onChange={(f) => update(q.id, f)}
              onDrop={() => drop(q.id)} onSwap={() => swap(q)} onToggleEdit={() => toggleEdit(q.id)} />
          ))}
        </div>
        <div ref={listEnd} />

        {n < QUESTIONS_MIN && canSwap && (
          <button className="blk" style={{ ...primaryBtn, marginTop: S.s4 }} onClick={addOneSuggested}>＋ 추천 질문 추가 ({n}/{QUESTIONS_MIN}개 이상)</button>
        )}
        <div style={{ display: "flex", gap: S.s3, marginTop: S.s4 }}>
          <button className="blk" style={{ ...secondaryBtn, ...(n >= QUESTIONS_MAX ? disabledBtn : null) }} disabled={n >= QUESTIONS_MAX} onClick={addCustom}>✍️ 직접 쓰기</button>
          <button className="blk" style={secondaryBtn} onClick={restart}>🔄 새로 뽑기</button>
        </div>
        {n >= QUESTIONS_MAX && <p style={muted}>질문은 {QUESTIONS_MAX}개까지예요. 새로 쓰려면 하나를 ✕로 빼 주세요.</p>}
        {!kept && <p style={warn} role="status">이 기기에 보관할 수 없어서, 이 화면을 닫으면 만든 내용이 사라져요.</p>}
      </div>

      <div style={footer}>
        <div style={{ ...column, padding: 0 }}>
          {error ? <p style={warn} role="alert">{error}</p> : !ready && <p style={warn} role="status">{problems[0]}</p>}
          <div style={{ display: "flex", gap: S.s3 }}>
            <button className="blk" style={{ ...secondaryBtn, width: "auto", flex: "none", padding: `0 ${S.s4}px` }} disabled={!n} onClick={() => setView("preview")}>미리보기</button>
            <button className="blk" style={{ ...primaryBtn, ...(ready ? null : disabledBtn) }} disabled={!ready || busy} onClick={() => void finish()} aria-disabled={!ready}>{doneLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ q, index, editing, canSwap, onTap, onChange, onDrop, onSwap, onToggleEdit }: {
  q: DraftQuestion; index: number; editing: boolean; canSwap: boolean;
  onTap: (i: number) => void; onChange: (f: (q: DraftQuestion) => DraftQuestion) => void;
  onDrop: () => void; onSwap: () => void; onToggleEdit: () => void;
}) {
  const problems = questionProblems(q);
  const textProblem = problems.find((p) => p.field !== "answer");
  const needsAnswer = problems.some((p) => p.field === "answer");
  return (
    <section style={{ ...card, borderColor: needsAnswer ? C.borderBlock : C.accent, borderStyle: needsAnswer ? "dashed" : "solid" }} aria-label={`질문 ${index + 1}`}>
      <div style={cardTop}>
        <span style={qNum}>Q{index + 1}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {q.tpl !== undefined && canSwap && <button style={miniBtn} onClick={onSwap}>다른 질문</button>}
          <button style={miniBtn} onClick={onToggleEdit} aria-pressed={editing}>{editing ? "다 고쳤어요" : "✏️ 고치기"}</button>
          <button style={{ ...miniBtn, width: 36, padding: 0 }} onClick={onDrop} aria-label={`질문 ${index + 1} 빼기`}>✕</button>
        </div>
      </div>

      {editing ? (
        <>
          <Field multiline className="qin" style={{ ...input, minHeight: 64, resize: "none" }} value={q.q} placeholder="예: 내가 제일 좋아하는 간식은?"
            aria-label="질문" maxLength={Q_MAX * 11}
            onText={(s, composing) => onChange((x) => (composing ? { ...x, q: oneLine(s), custom: true } : editQuestion(x, s)))} />
          <div style={counter}>{graphemeLength(q.q)}/{Q_MAX}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: S.s2 }}>
            {q.options.map((o, k) => (
              <div key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button style={{ ...answerDot, ...(q.answer === k ? answerDotOn : null) }} onClick={() => onTap(k)}
                  aria-label={`보기 ${k + 1}을 내 답으로`} aria-pressed={q.answer === k}>{q.answer === k ? "✓" : ""}</button>
                <Field className="qin" style={{ ...input, flex: 1, minWidth: 0 }} value={o} placeholder={`보기 ${k + 1}`} aria-label={`보기 ${k + 1}`}
                  maxLength={OPTION_MAX * 11}
                  onText={(s, composing) => onChange((x) => (composing ? { ...x, options: x.options.map((v, j) => (j === k ? oneLine(s) : v)), custom: true } : editOption(x, k, s)))} />
                {q.options.length > OPTIONS_MIN && (
                  <button style={{ ...miniBtn, width: 36, padding: 0 }} onClick={() => onChange((x) => removeOption(x, k))} aria-label={`보기 ${k + 1} 지우기`}>−</button>
                )}
              </div>
            ))}
            {q.options.length < OPTIONS_MAX && (
              <button style={{ ...miniBtn, alignSelf: "flex-start" }} onClick={() => onChange(addOption)}>+ 보기 추가</button>
            )}
          </div>
          <p style={{ ...muted, marginTop: S.s2 }}>왼쪽 칸을 눌러 내 답을 골라요.</p>
        </>
      ) : (
        <>
          <p style={qText}>{q.q || "질문을 적어 주세요"}</p>
          <div style={optGrid}>
            {q.options.map((o, k) => (
              <button key={k} className="blk" style={{ ...optBtn, ...(q.answer === k ? optOn : null) }} onClick={() => onTap(k)} aria-pressed={q.answer === k}>
                {q.answer === k && <span style={mineTag}>내 답</span>}
                {o || `보기 ${k + 1}`}
              </button>
            ))}
          </div>
        </>
      )}
      {textProblem ? <p style={warn}>{textProblem.message}</p> : needsAnswer && <p style={muted}>내 진짜 답을 눌러 주세요</p>}
    </section>
  );
}

/** Question 1 as friends see it: no answer marked, not tappable. */
export function PreviewCard({ draft }: { draft: Draft }) {
  const q = draft.questions[0];
  if (!q) return <p style={muted}>질문이 아직 없어요.</p>;
  return (
    <div style={{ ...card, borderStyle: "solid" }} aria-label="미리보기">
      <div style={cardTop}>
        <span style={qNum}>1/{draft.questions.length}</span>
        <span style={{ color: C.inkMuted, fontSize: TOKENS.size.bodySm, fontWeight: 700 }}>⏱ {ANSWER_MS / 1000}초</span>
      </div>
      <div style={{ color: C.accent, fontWeight: 800, fontSize: TOKENS.size.bodySm }}>{draft.title.trim() || "나 맞히기"}</div>
      <p style={qText}>{q.q.trim() || "질문을 적어 주세요"}</p>
      <div style={optGrid}>
        {q.options.map((o, k) => (
          <div key={k} style={optBtn}>{o.trim() || `보기 ${k + 1}`}</div>
        ))}
      </div>
    </div>
  );
}

const INPUT_CSS = `.qin:focus{ outline: 2px solid ${C.accent}; outline-offset: 0; }`;
const shell: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 50, background: C.bg, color: C.ink, overflowY: "auto",
  padding: `calc(var(--snack-safe-top) + ${S.s3}px) 16px 0`, font: `16px ${TOKENS.font.body}`,
};
const column: React.CSSProperties = { maxWidth: 520, margin: "0 auto", width: "100%" };
const headerRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center" };
// Pixel face only at ≥22px / weight ≥800 (design system rule).
const h1: React.CSSProperties = { fontFamily: TOKENS.font.heading, fontSize: 22, fontWeight: 600, margin: `${S.s4}px 0 ${S.s2}px`, lineHeight: 1.4 };
const muted: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodySm, lineHeight: 1.5, margin: `${S.s1}px 0 0`, wordBreak: "keep-all" };
const warn: React.CSSProperties = { ...muted, color: C.roster3, fontWeight: 700 };
const label: React.CSSProperties = { display: "block", fontWeight: 800, fontSize: TOKENS.size.bodySm, margin: `${S.s4}px 0 ${S.s2}px` };
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", background: C.surface2, color: C.ink,
  border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, font: `600 16px ${TOKENS.font.body}`,
};
const counter: React.CSSProperties = { textAlign: "right", color: C.inkMuted, fontSize: 12, margin: `2px 0 ${S.s2}px` };
const progressRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: S.s2, margin: `${S.s4}px 0 ${S.s3}px`,
  fontSize: TOKENS.size.bodySm, fontWeight: 700,
};
const card: React.CSSProperties = {
  background: C.surface, border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block,
  boxShadow: blockShadow, padding: S.s4, display: "flex", flexDirection: "column", gap: S.s2,
};
const cardTop: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: S.s2 };
const qNum: React.CSSProperties = { color: C.accent, fontWeight: 800, fontSize: TOKENS.size.bodySm };
const qText: React.CSSProperties = { fontWeight: 800, fontSize: TOKENS.size.bodyLg, lineHeight: 1.4, margin: `${S.s1}px 0 ${S.s2}px`, wordBreak: "keep-all" };
const optGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.s2 };
const optBtn: React.CSSProperties = {
  position: "relative", minHeight: 52, padding: "10px 10px", background: C.surface2, color: C.ink, cursor: "pointer",
  border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, textAlign: "center",
  font: `700 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, wordBreak: "keep-all", lineHeight: 1.35,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const optOn: React.CSSProperties = { background: C.accent, color: C.accentInk, borderColor: C.accentInk };
const mineTag: React.CSSProperties = {
  position: "absolute", top: -9, left: 6, background: C.accentInk, color: C.accent, fontSize: 11, fontWeight: 800, padding: "0 5px",
};
const miniBtn: React.CSSProperties = {
  minHeight: 36, padding: "0 10px", background: C.surface2, color: C.ink, cursor: "pointer",
  border: `${TOKENS.border.hairline}px solid ${C.borderBlock}`, borderRadius: R.block, font: `700 13px ${TOKENS.font.body}`, whiteSpace: "nowrap",
};
const answerDot: React.CSSProperties = {
  flex: "none", width: 36, height: 36, padding: 0, background: C.surface2, color: C.accentInk, cursor: "pointer",
  border: `${TOKENS.border.block}px solid ${C.borderBlock}`, borderRadius: R.block, font: `800 16px ${TOKENS.font.body}`,
};
const answerDotOn: React.CSSProperties = { background: C.accent, borderColor: C.accentInk };
const disabledBtn: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed", boxShadow: "none", transform: "none" };
const footer: React.CSSProperties = {
  position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 51, background: C.bg, borderTop: `${TOKENS.border.block}px solid ${C.borderBlock}`,
  padding: `${S.s3}px 16px calc(var(--snack-safe-bottom) + ${S.s3}px)`, display: "flex", flexDirection: "column", gap: S.s2,
};
