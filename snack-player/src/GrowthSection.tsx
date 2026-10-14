// /stats top section "지금까지": the totals so far (since the first recorded month), the
// unique-device estimate, and a cumulative line chart (inline SVG, no library) of one
// headline number — one point a day, or a month when the record is long (statsView.ts).
import { useState } from "react";
import { TOKENS, C, S } from "./tokens.gen";
import {
  GROWTH_METRICS, firstMonth, fmtInt, growthSeries, monthLabel, niceTicks,
  type GrowthBody, type GrowthMetric, type GrowthSeries,
} from "./statsView";

export function GrowthSection({ g, today }: { g: GrowthBody | null; today: string }) {
  const [metric, setMetric] = useState<GrowthMetric>("games_finished");
  const all = (g && g.allTime) || {};
  const since = firstMonth(g);
  const devices = g && g.devices;
  const series = growthSeries(g, metric, today);
  const meta = GROWTH_METRICS.find((x) => x.key === metric)!;
  return (
    <section aria-label="지금까지">
      <h2 style={h2}>지금까지</h2>
      <p style={help}>{since ? `기록 시작: ${monthLabel(since)}` : "아직 기록이 없어요. 첫 판이 끝나면 여기서부터 쌓여요."}</p>
      <div style={tiles}>
        <Tile label="끝난 판" value={fmtInt(all.games_finished || 0)} />
        <Tile label="만들어진 퀴즈" value={fmtInt(all.quizzes_created || 0)} />
        <Tile label="같이 논 사람" value={fmtInt(all.players_in_finished_games || 0)} note="연인원 · 한 사람이 5판 하면 5" />
        <Tile
          label="함께한 기기"
          value={devices && devices.counting ? `약 ${fmtInt(devices.allTime)}대` : "—"}
          note={devices && devices.counting ? "(추정)" : "아직 세지 않아요"}
        />
      </div>
      <p style={{ ...help, marginTop: S.s2 }}>
        함께한 기기는 추정이에요 — 같은 사람이 폰과 PC를 쓰면 2대로 세요 · 오차 약 1%.
      </p>

      <div role="tablist" aria-label="그래프로 볼 숫자" style={{ display: "flex", gap: S.s2, flexWrap: "wrap", margin: `${S.s4}px 0 ${S.s2}px` }}>
        {GROWTH_METRICS.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === metric} onClick={() => setMetric(x.key)}
            style={{ ...chip, ...(x.key === metric ? chipOn : null) }}>
            {x.label}
          </button>
        ))}
      </div>
      <GrowthChart series={series} unit={meta.unit} label={meta.label} />
    </section>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={tile}>
      <div style={{ color: C.inkMuted, fontSize: TOKENS.size.bodySm }}>{label}</div>
      <div style={tileNum}>{value}</div>
      {note && <div style={{ color: C.inkMuted, fontSize: TOKENS.size.caption }}>{note}</div>}
    </div>
  );
}

// ── the chart ──
const W = 340;
const H = 190;
const PAD = { l: 40, r: 14, t: 14, b: 26 };

export function GrowthChart({ series, unit, label }: { series: GrowthSeries; unit: string; label: string }) {
  const pts = series.points;
  const [hover, setHover] = useState<number | null>(null);
  if (!pts.length) {
    return <div style={{ ...frame, ...emptyBox }}>아직 기록이 없어요</div>;
  }
  const ticks = niceTicks(pts[pts.length - 1].value);
  const top = ticks[ticks.length - 1];
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${x(0).toFixed(1)},${y(0)} ${line} ${x(pts.length - 1).toFixed(1)},${y(0)}`;
  const at = hover ?? pts.length - 1;
  const xLabels = pts.length === 1 ? [0] : pts.length === 2 ? [0, 1] : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    const i = pts.length === 1 ? 0 : Math.round(((vx - PAD.l) / iw) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  return (
    <div style={frame}>
      <div style={readout} aria-live="polite">
        <span style={{ color: C.inkMuted }}>{pts[at].label}{series.by === "month" ? "까지" : ""}</span>{" "}
        누적 <b style={{ color: C.ink }}>{fmtInt(pts[at].value)}{unit}</b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${label} 누적 그래프, ${pts[0].label}부터 ${pts[pts.length - 1].label}까지 ${fmtInt(pts[pts.length - 1].value)}${unit}`}
        style={{ display: "block", touchAction: "pan-y" }}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={C.hairline} strokeWidth={1} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={C.inkMuted}>{fmtInt(t)}</text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} x={x(i)} y={H - 8} fontSize={11} fill={C.inkMuted}
            textAnchor={pts.length === 1 ? "middle" : i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}>{pts[i].label}</text>
        ))}
        {pts.length > 1 && <polygon points={area} fill={C.accent} opacity={0.12} />}
        {pts.length > 1 && <polyline points={line} fill="none" stroke={C.accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {hover !== null && <line x1={x(at)} x2={x(at)} y1={PAD.t} y2={PAD.t + ih} stroke={C.inkMuted} strokeWidth={1} strokeDasharray="3 3" />}
        <circle cx={x(at)} cy={y(pts[at].value)} r={5} fill={C.accent} stroke={C.surface} strokeWidth={2} />
      </svg>
      {pts.length === 1 && <p style={{ ...help, margin: `${S.s1}px 0 0` }}>첫 기록이에요 — 다음 날부터 선으로 이어져요.</p>}
      <details style={{ marginTop: S.s2 }}>
        <summary style={{ color: C.inkMuted, fontSize: TOKENS.size.bodySm, cursor: "pointer", minHeight: 32 }}>표로 보기</summary>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: TOKENS.size.bodySm }}>
          <tbody>
            {[...pts].reverse().map((p) => (
              <tr key={p.key}>
                <td style={{ padding: "4px 0", color: C.inkMuted }}>{p.label}</td>
                <td style={{ padding: "4px 0", textAlign: "right" }}>{fmtInt(p.value)}{unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: TOKENS.size.titleMd - 2, fontWeight: TOKENS.weight.display, margin: `${S.s5}px 0 ${S.s1}px`, lineHeight: 1.3 };
const help: React.CSSProperties = { color: C.inkMuted, fontSize: TOKENS.size.bodySm, margin: `0 0 ${S.s2}px` };
const tiles: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.s2 };
const tile: React.CSSProperties = { padding: S.s3, background: C.surface, border: `2px solid ${C.borderBlock}`, boxShadow: "0 5px 0 #000000", minWidth: 0 };
const tileNum: React.CSSProperties = {
  fontFamily: TOKENS.font.displayLatin, fontSize: 22, color: C.accent, lineHeight: 1.3, margin: `${S.s1}px 0`,
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
const frame: React.CSSProperties = { padding: S.s3, background: C.surface, border: `2px solid ${C.borderBlock}`, boxShadow: "0 5px 0 #000000" };
const emptyBox: React.CSSProperties = { minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center", color: C.inkMuted, fontSize: TOKENS.size.bodyMd };
const readout: React.CSSProperties = { fontSize: TOKENS.size.bodyMd, marginBottom: S.s1, fontVariantNumeric: "tabular-nums" };
const chip: React.CSSProperties = {
  minHeight: TOKENS.layout.tap, padding: `0 ${S.s3}px`, background: C.surface2, color: C.inkMuted, border: `2px solid ${C.borderBlock}`,
  font: `700 ${TOKENS.size.bodySm}px ${TOKENS.font.body}`, cursor: "pointer",
};
const chipOn: React.CSSProperties = { background: C.accent, color: C.accentInk, borderColor: C.accentInk };
