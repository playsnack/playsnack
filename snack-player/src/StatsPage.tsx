// /stats — the anonymous counts from GET /api/ev, in plain Korean, for anyone.
// Counts only (no people, no names); error messages are the ones /api/ev already
// cleaned (docs/telemetry.md §4). Leads with the growth so far (GrowthSection), then
// the last 7 days. The numbers and words: statsView.ts.
import { useEffect, useState } from "react";
import { TOKENS, C, S } from "./tokens.gen";
import { BLOCK_CSS, pill } from "./ui";
import {
  DAY_COLUMNS, buildModel, budgetLine, fmtInt, fmtPct, kstDay, last7Days, regulars, weeksFor,
  type DayBody, type GrowthBody, type StatsModel, type WeekBody,
} from "./statsView";
import { GrowthSection } from "./GrowthSection.tsx";

const API = "/api/ev";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: "omit", cache: "no-store" });
    const body = await r.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

export type Loaded = { m: StatsModel; g: GrowthBody | null };

/** Read the growth so far, this week (+ last week when the 7 days cross a Monday) and today's errors. */
export async function loadStats(now = Date.now()): Promise<Loaded | null> {
  const today = kstDay(now);
  const weeks = weeksFor(last7Days(today));
  const [g, day, ...weekBodies] = await Promise.all([
    getJson<GrowthBody>(`${API}?growth=1`),
    getJson<DayBody>(`${API}?day=${today}`),
    ...weeks.map((w) => getJson<WeekBody>(`${API}?week=${w}`)),
  ]);
  if (!day && !g && weekBodies.every((w) => !w)) return null;
  return { m: buildModel(weekBodies, day, now), g: g && g.ok ? g : null };
}

export function StatsPage({ onHome }: { onHome: () => void }) {
  const [model, setModel] = useState<Loaded | null | "loading">("loading");
  const [at, setAt] = useState<Date | null>(null);
  const load = () => {
    setModel("loading");
    loadStats().then((m) => {
      setModel(m);
      setAt(new Date());
    });
  };
  useEffect(() => {
    document.title = "PlaySnack 통계";
    load();
  }, []);

  return (
    <div style={page}>
      <style>{BLOCK_CSS}</style>
      <main style={column}>
        <button className="blk" style={{ ...pill, marginBottom: S.s4 }} onClick={onHome} aria-label="홈으로">← 홈</button>
        <div style={brand}>PLAYSNACK STATS</div>
        <h1 style={h1}>익명 통계</h1>
        <p style={intro}>PlaySnack에서 일어난 일을 익명 숫자로 보여 줘요 · 누가 했는지는 저장하지 않아요</p>
        <p style={muted}>한국 시간 기준 · 판·퀴즈·입장은 사람 수가 아니라 <b style={{ color: C.ink }}>횟수</b>예요(한 사람이 5판 하면 5).</p>
        {model === "loading" && <p style={muted} aria-busy="true">불러오는 중…</p>}
        {model === null && (
          <Note warn>
            통계를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.
            <div style={{ marginTop: S.s3 }}><button style={btn} onClick={load}>다시 불러오기</button></div>
          </Note>
        )}
        {model && model !== "loading" && <StatsBody m={model.m} g={model.g} at={at} onReload={load} />}
      </main>
    </div>
  );
}

export function StatsBody({ m, g = null, at, onReload }: { m: StatsModel; g?: GrowthBody | null; at: Date | null; onReload: () => void }) {
  const w = m.week;
  const b = budgetLine(m.budget);
  const reg = regulars(m.days[0] ? m.days[0].s : null);
  // Join numbers count room-server joins only ("지금 입장 방식" — the page never says 서버); the
  // old way is not shown at all (owner, 2026-10-15). Said once, under 방 입장: when counting began.
  const edgeNote = m.join.since ? `지금 입장 방식만 ${m.join.since}부터 센 숫자예요.` : null;
  return (
    <>
      {!m.wired && (
        <Note warn>
          <b>아직 연결 전</b> — 아직 판·퀴즈 숫자를 세기 전이라, 0은 "0번"이 아니라 "아직 안 셈"이에요.
        </Note>
      )}
      {m.store === "memory" && (
        <Note warn>지금은 시험 중이라 이 숫자는 잠깐만 남는 임시 숫자예요.</Note>
      )}
      {m.budgetReached && (
        <Note warn>이번 달 무료로 셀 수 있는 양을 다 써서 다음 달 1일까지 새로 세지 않아요(게임은 그대로 돼요).</Note>
      )}
      {m.stale && <Note>조금 전에 읽은 숫자를 보여 주고 있어요.</Note>}

      <GrowthSection g={g} today={m.today} />

      <H2>최근 7일</H2>
      {m.empty && <Note>최근 7일은 아직 기록이 없어요. 친구들과 한 판 하면 여기에 숫자가 생겨요.</Note>}
      <section style={card} aria-label="최근 7일 핵심 숫자">
        <div style={muted}>최근 7일, 3명 이상이 끝까지 한 판</div>
        <div style={bigNum}>{fmtInt(w.sessionsDone3)}</div>
        <div style={muted}>끝난 판 전체 {fmtInt(w.sessionsDone)} · 퀴즈 만들어짐 {fmtInt(w.gamesCreated)} · 친구 방 {fmtInt(w.roomsCreated)}</div>
      </section>

      <H2>날마다</H2>
      <p style={help}>끝난 판 = 결과 화면까지 간 판 · 나도 만들기 = 결과를 보고 만든 퀴즈</p>
      <div style={tableBox} role="region" aria-label="날마다 숫자 표" tabIndex={0}>
        <table style={table}>
          <thead>
            <tr>
              <th style={{ ...thL, ...stick, background: C.surface }} scope="col">날짜</th>
              {DAY_COLUMNS.map((c) => (
                <th key={c.key} scope="col" style={c.strong ? { ...th, color: C.accent } : th}>
                  {c.head[0]}<br /><span style={c.strong ? undefined : { fontWeight: TOKENS.weight.muted }}>{c.head[1]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.days.map((d) => {
              const bg = d.isToday ? C.surface2 : C.surface;
              return (
                <tr key={d.day} style={{ background: bg }}>
                  <th scope="row" style={{ ...tdL, ...stick, background: bg, fontWeight: TOKENS.weight.body }}>
                    {d.label}{d.isToday && <span style={todayTag}>오늘</span>}
                  </th>
                  {d.empty ? (
                    <td style={{ ...td, color: C.inkMuted, textAlign: "left" }} colSpan={DAY_COLUMNS.length}>아직 기록이 없어요</td>
                  ) : DAY_COLUMNS.map((c) => (
                    <td key={c.key} style={c.strong ? { ...td, color: C.accent, fontWeight: 800, fontSize: TOKENS.size.bodyMd } : td}>{c.value(d.s)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <H2>자주 쓰는 사람</H2>
      <p style={help}>오늘 들어온 기기(브라우저)들이 하루 한 번 보내는 대략적인 구간으로 세요. 기기 = 브라우저라서, 같은 사람이 폰과 PC를 쓰면 2대예요. 누가 누구인지는 알 수 없어요.</p>
      <section style={card}>
        {reg.seen === 0 ? (
          <p style={{ ...muted, margin: 0 }}>오늘은 아직 기록이 없어요.</p>
        ) : (
          <>
            <Row label="오늘 들어온 기기" value={`${fmtInt(reg.seen)}대`} />
            <Row label="처음 온 기기" value={reg.firstPct} small />
            <Row label="다시 온 기기" value={reg.returningPct} small />
            <Row label="지금까지 10판 이상 한 기기" value={reg.tenPlusPct} small />
            <Row label="퀴즈를 5개 이상 만든 기기" value={`${fmtInt(reg.madeFivePlus)}대`} small />
          </>
        )}
      </section>

      <H2>방 입장</H2>
      {edgeNote && <p style={help}>{edgeNote}</p>}
      <section style={card}>
        {m.join.has ? (
          <Row label="입장 성공률" value={m.join.successRate} sub={`성공 ${fmtInt(m.join.ok)} · 실패 ${fmtInt(m.join.fail)}`} />
        ) : (
          <p style={{ ...muted, margin: 0 }}>지금 입장 방식으로 들어간 기록이 아직 없어요.</p>
        )}
        {m.join.reasons.length > 0 && (
          <>
            <div style={{ ...muted, marginTop: S.s3 }}>실패 이유</div>
            {m.join.reasons.map((r) => <Row key={r.key} label={r.label} value={fmtInt(r.n)} small />)}
          </>
        )}
      </section>
      <H2>입장까지 걸린 시간</H2>
      <p style={help}>링크를 열고 방에 들어가기까지 걸린 시간이에요(잘 들어간 경우만). 목표: 4번 중 3번은 2초 안에.</p>
      <section style={card}>
        {m.join.total === 0 ? (
          <p style={{ ...muted, margin: 0 }}>{m.join.has ? "아직 시간을 잰 입장이 없어요." : "지금 입장 방식으로 들어간 기록이 아직 없어요."}</p>
        ) : (
          <>
            {m.join.buckets.map((bk) => (
              <Bar key={bk.key} label={bk.label} n={bk.n} total={m.join.total} hot={bk.key === "0-1s" || bk.key === "1-2s"} />
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: S.s2, marginTop: S.s3 }}>
              <Stat label="절반은" value={m.join.p50} />
              <Stat label="4번 중 3번은" value={m.join.p75} strong />
              <Stat label="20번 중 19번은" value={m.join.p95} />
            </div>
            <p style={{ ...help, marginTop: S.s3, marginBottom: 0 }}>
              2초 안에 들어온 비율 <b style={{ color: C.ink }}>{m.join.within2s}</b> —{" "}
              {m.join.meetsBar ? <b style={{ color: C.accent }}>목표 달성</b> : <b style={{ color: C.roster1 }}>목표 미달</b>}
              {m.join.total < 20 && " (아직 횟수가 적어 대략값이에요)"}
            </p>
            <p style={{ ...help, marginBottom: 0 }}>위 세 숫자는 시간 구간으로만 세서 짐작한 값이에요(이 시간 안에 들어왔다는 뜻).</p>
          </>
        )}
      </section>

      <H2>공유</H2>
      <section style={card}>
        <Row label="공유한 횟수" value={fmtInt(m.shares.total)} />
        {m.shares.what.map((r) => <Row key={r.key} label={r.label} value={fmtInt(r.n)} small />)}
      </section>

      <H2>"다음에도 하고 싶나요?"</H2>
      <p style={help}>게임이 끝나고 결과 화면에서 물어본 질문이에요. 답하지 않은 사람의 생각은 알 수 없어요.</p>
      <section style={card}>
        <Row label="물어본 횟수" value={fmtInt(m.ask.shown)} />
        <Row label="좋아요" value={fmtInt(m.ask.yes)} sub={fmtPct(m.ask.yes, m.ask.shown)} small />
        <Row label="아니요" value={fmtInt(m.ask.no)} sub={fmtPct(m.ask.no, m.ask.shown)} small />
        <Row label="건너뜀" value={fmtInt(m.ask.skip)} sub={fmtPct(m.ask.skip, m.ask.shown)} small />
        <Row label="응답 없음" value={fmtInt(m.ask.noAnswer)} sub={fmtPct(m.ask.noAnswer, m.ask.shown)} small />
        {m.ask.reasons.length > 0 && (
          <>
            <div style={{ ...muted, marginTop: S.s3 }}>"아니요" 이유</div>
            {m.ask.reasons.map((r) => <Row key={r.key} label={r.label} value={fmtInt(r.n)} small />)}
          </>
        )}
      </section>

      <H2>앱에서 난 문제</H2>
      <p style={help}>최근 7일 {fmtInt(w.errors)}건. 아래는 오늘 가장 많이 난 5개의 원래 문구예요(이름·주소·숫자는 지움).</p>
      <section style={card}>
        {m.errorsToday.length === 0 ? (
          <p style={{ ...muted, margin: 0 }}>오늘은 기록된 문제가 없어요.</p>
        ) : (
          m.errorsToday.map((e, i) => (
            <div key={i} style={errRow}>
              <code style={code}>{e.msg}</code>
              <span style={{ color: C.ink, fontWeight: 700 }}>{fmtInt(e.count)}</span>
            </div>
          ))
        )}
        {m.rejected.length > 0 && (
          <p style={{ ...help, marginBottom: 0 }}>
            잘못된 모양으로 들어와 세지 않은 기록: {m.rejected.map((r) => `${r.label} ${fmtInt(r.n)}`).join(" · ")} (고칠 거리예요)
          </p>
        )}
      </section>

      <H2>이번 달 무료 한도</H2>
      <section style={card}>
        <Row label="이번 달 기록·읽기 횟수" value={b.used} sub={`/ ${b.limit}`} />
        <div style={track} aria-hidden="true"><div style={{ ...fill, width: `${b.pct ?? 0}%` }} /></div>
        <p style={{ ...help, marginBottom: 0 }}>
          숫자를 모아 두는 곳(Upstash)은 한 달 50만 번까지 무료예요. 40만 번에 닿으면 그달은 스스로 세기를 멈춰서 돈이 들지 않아요.
          {b.pct === null && " 이번 달 사용량은 아직 알 수 없어요."}
        </p>
      </section>

      <p style={{ ...help, marginTop: S.s5 }}>
        숫자는 최대 30초 늦을 수 있어요.{at && ` 마지막으로 읽은 시각 ${at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}.`}
      </p>
      <button style={btn} onClick={onReload}>새로 읽기</button>
    </>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={h2}>{children}</h2>;
}
function Note({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div role={warn ? "status" : undefined} style={{ ...note, borderColor: warn ? C.roster3 : C.hairline }}>
      {children}
    </div>
  );
}
function Row({ label, value, sub, small = false }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div style={row}>
      <span style={{ color: small ? C.inkMuted : C.ink, fontSize: small ? TOKENS.size.bodySm : TOKENS.size.bodyMd }}>{label}</span>
      <span>
        <b style={{ color: C.ink, fontSize: small ? TOKENS.size.bodyMd : TOKENS.size.titleMd }}>{value}</b>
        {sub && <span style={{ color: C.inkMuted, fontSize: TOKENS.size.caption, marginLeft: 6 }}>{sub}</span>}
      </span>
    </div>
  );
}
function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ background: C.surface2, padding: S.s2, border: `1px solid ${strong ? C.accent : C.hairline}` }}>
      <div style={{ color: C.inkMuted, fontSize: TOKENS.size.caption }}>{label}</div>
      <div style={{ color: strong ? C.accent : C.ink, fontWeight: 800, fontSize: TOKENS.size.bodyMd }}>{value}</div>
    </div>
  );
}
function Bar({ label, n, total, hot }: { label: string; n: number; total: number; hot: boolean }) {
  const pct = total ? (n / total) * 100 : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 64px", alignItems: "center", gap: S.s2, minHeight: 28 }}>
      <span style={{ color: C.inkMuted, fontSize: TOKENS.size.bodySm }}>{label}</span>
      <div style={track}><div style={{ ...fill, width: `${pct}%`, background: hot ? C.accent : C.borderBlock }} /></div>
      <span style={{ textAlign: "right", fontSize: TOKENS.size.bodySm }}>{fmtInt(n)} <span style={{ color: C.inkMuted }}>{fmtPct(n, total)}</span></span>
    </div>
  );
}

// ── styles (Mini-Block Arcade tokens) ──
const page: React.CSSProperties = {
  height: "100%", overflowY: "auto", WebkitOverflowScrolling: "touch", background: C.bg, color: C.ink,
  font: `${TOKENS.weight.muted} ${TOKENS.size.bodyMd}px/1.5 ${TOKENS.font.body}`,
};
const column: React.CSSProperties = {
  maxWidth: 520, margin: "0 auto",
  padding: `calc(${S.s5}px + var(--snack-safe-top)) ${S.s4}px calc(${S.s6}px + var(--snack-safe-bottom))`,
};
const brand: React.CSSProperties = { fontFamily: TOKENS.font.displayLatin, fontSize: 11, color: C.accent, letterSpacing: 1 };
const h1: React.CSSProperties = { fontSize: TOKENS.size.titleLg, fontWeight: TOKENS.weight.display, margin: `${S.s2}px 0 ${S.s1}px`, lineHeight: 1.3 };
const h2: React.CSSProperties = { fontSize: TOKENS.size.titleMd - 2, fontWeight: TOKENS.weight.display, margin: `${S.s5}px 0 ${S.s2}px`, lineHeight: 1.3 };
const intro: React.CSSProperties = { color: C.ink, fontSize: TOKENS.size.bodyMd, margin: `0 0 ${S.s2}px`, lineHeight: 1.5 };
const muted: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodySm, margin: 0 };
const help: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodySm, margin: `0 0 ${S.s2}px` };
const note: React.CSSProperties = {
  marginTop: S.s3, padding: S.s3, background: C.surface, border: `2px solid ${C.hairline}`, fontSize: TOKENS.size.bodySm, color: C.ink,
};
const card: React.CSSProperties = { marginTop: S.s3, padding: S.s4, background: C.surface, border: `2px solid ${C.borderBlock}`, boxShadow: "0 5px 0 #000000" };
const bigNum: React.CSSProperties = { fontFamily: TOKENS.font.displayLatin, fontSize: TOKENS.size.displayLg, color: C.accent, lineHeight: 1.2, margin: `${S.s3}px 0` };
/** The box border sits on the scroll box, not the table, so it stays put while the table scrolls sideways. */
const tableBox: React.CSSProperties = { overflowX: "auto", background: C.surface, border: `2px solid ${C.borderBlock}` };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: TOKENS.size.bodySm, background: C.surface };
const th: React.CSSProperties = { textAlign: "right", padding: `${S.s2}px 6px`, color: C.inkMuted, fontWeight: TOKENS.weight.strong, borderBottom: `2px solid ${C.borderBlock}`, whiteSpace: "nowrap" };
const thL: React.CSSProperties = { ...th, textAlign: "left" };
const td: React.CSSProperties = { textAlign: "right", padding: `${S.s2}px 6px`, borderBottom: `1px solid ${C.hairline}`, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const tdL: React.CSSProperties = { ...td, textAlign: "left" };
/** The date column stays put while the numbers scroll sideways on a narrow phone. */
const stick: React.CSSProperties = { position: "sticky", left: 0, zIndex: 1, borderRight: `1px solid ${C.hairline}` };
/** Under the date (keeps the date column narrow on a phone). */
const todayTag: React.CSSProperties = { display: "block", width: "fit-content", marginTop: 2, padding: "0 4px", background: C.accent, color: C.accentInk, fontSize: 11, fontWeight: 800 };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: S.s3, padding: `${S.s1}px 0` };
const track: React.CSSProperties = { height: 10, background: C.surface2, border: `1px solid ${C.hairline}`, marginTop: 2 };
const fill: React.CSSProperties = { height: "100%", background: C.accent };
const errRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: S.s3, padding: `${S.s2}px 0`, borderBottom: `1px solid ${C.hairline}` };
const code: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, color: C.ink, wordBreak: "break-word" };
const btn: React.CSSProperties = {
  minHeight: 44, padding: `0 ${S.s4}px`, background: C.surface2, color: C.ink, border: `2px solid ${C.borderBlock}`,
  boxShadow: "0 5px 0 #000000", font: `700 ${TOKENS.size.bodyMd}px ${TOKENS.font.body}`, cursor: "pointer",
};
