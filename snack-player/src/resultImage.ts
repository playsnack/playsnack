// The shareable result picture (1080×1350 PNG) for "나 맞히기 퀴즈", drawn from
// the same ResultView the result screen shows — not a screenshot of the canvas.
// Split so the layout math runs in Node with a fake measurer
// (snack-player/test/resultImage.test.ts):
//   planResultImage(view, measure, opts) → draw ops (pure)
//   drawOps(ctx, ops)                     → paints them on any 2D context
//   renderResultImage(view, opts)         → browser: fonts ready → canvas → PNG Blob
//   shareResultImage(blob, opts)          → Web Share with the file, else a preview to save
// Fonts: the canvas uses the player's own faces (Pretendard / Galmuri11 subsets,
// with the full faces behind them by unicode-range, then system fonts), and
// waits for every glyph it draws, so a rare syllable in a nickname is drawn
// with the full face and never as tofu.
import { highlightQuestions, type ResultView } from "./quizResult.ts";

export const IMG_W = 1080;
export const IMG_H = 1350;
const PAD = 80;
const INNER = IMG_W - PAD * 2;

// Design system (snack-server/src/tokens.mjs): black + lime as the single hero
// colour, pixel face (display) only for the title, scores and brand.
const COL = { bg: "#0B0C0E", surface: "#16181C", surface2: "#1E2127", ink: "#FFFFFF", muted: "#9AA3AF", accent: "#D9FF00", accentInk: "#0B0C0E", ok: "#22C55E", hairline: "#2A2D33" };

export type FontKind = "body" | "display";
export type TextStyle = { font: FontKind; weight: number; size: number };
/** Width of `text` in px for a style (the browser: ctx.measureText). */
export type Measure = (text: string, style: TextStyle) => number;

export type Op =
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string }
  | { kind: "text"; text: string; x: number; y: number; style: TextStyle; color: string; align: "left" | "center" | "right"; maxW: number };

export type PlanOpts = { appName?: string; link?: string };

const graphemes = (s: string): string[] => {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? Array.from(new Seg("ko", { granularity: "grapheme" }).segment(s), (x) => x.segment) : Array.from(s);
};

/** Cut `text` to fit `maxW`, adding "…" when anything was dropped. */
export function ellipsize(text: string, maxW: number, style: TextStyle, measure: Measure): string {
  if (measure(text, style) <= maxW) return text;
  const g = graphemes(text);
  while (g.length > 0 && measure(g.join("").trimEnd() + "…", style) > maxW) g.pop();
  return g.length ? g.join("").trimEnd() + "…" : "";
}

/** Word-wrap (Korean keep-all: break at spaces; a too-long word breaks by grapheme), at most `maxLines`. */
export function wrapText(text: string, maxW: number, style: TextStyle, measure: Measure, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  const push = (l: string) => lines.push(l);
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const tryLine = cur ? `${cur} ${word}` : word;
    if (measure(tryLine, style) <= maxW) {
      cur = tryLine;
      continue;
    }
    if (cur) push(cur);
    cur = "";
    if (measure(word, style) <= maxW) {
      cur = word;
      continue;
    }
    let piece = "";
    for (const ch of graphemes(word)) {
      if (measure(piece + ch, style) > maxW && piece) {
        push(piece);
        piece = "";
      }
      piece += ch;
    }
    cur = piece;
  }
  if (cur) push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, maxW, style, measure);
  return kept;
}

const lineH = (s: TextStyle) => Math.round(s.size * (s.font === "display" ? 1.3 : 1.35));

/** Lay out the picture. Every text op carries maxW and is already cut to fit it. */
export function planResultImage(view: ResultView, measure: Measure, opts: PlanOpts = {}): Op[] {
  const ops: Op[] = [{ kind: "rect", x: 0, y: 0, w: IMG_W, h: IMG_H, color: COL.bg }];
  const text = (t: string, x: number, y: number, style: TextStyle, color: string, align: "left" | "center" | "right" = "left", maxW = INNER) =>
    ops.push({ kind: "text", text: ellipsize(t, maxW, style, measure), x, y, style, color, align, maxW });
  const para = (t: string, y: number, style: TextStyle, color: string, maxLines: number, align: "left" | "center" = "left") => {
    const lines = wrapText(t, INNER, style, measure, maxLines);
    lines.forEach((l, i) => text(l, align === "center" ? IMG_W / 2 : PAD, y + i * lineH(style), style, color, align));
    return y + lines.length * lineH(style);
  };

  // Footer first: it is pinned to the bottom and everything else stops above it.
  const footTop = IMG_H - PAD - 100;
  ops.push({ kind: "rect", x: PAD, y: footTop, w: INNER, h: 4, color: COL.hairline });
  text(opts.appName ?? "PlaySnack", PAD, footTop + 28, { font: "display", weight: 700, size: 44 }, COL.accent);
  if (opts.link) text(opts.link, PAD, footTop + 84, { font: "body", weight: 500, size: 30 }, COL.muted);
  const limit = footTop - 32;

  let y = PAD + 8;
  text(view.subject ? "나 맞히기 퀴즈 결과" : "퀴즈 결과", PAD, y, { font: "body", weight: 700, size: 32 }, COL.muted);
  y += 56;
  y = para(view.title || "스피드 퀴즈", y, { font: "display", weight: 700, size: 76 }, COL.accent, 2);
  y += 16;
  y = para(view.headline, y, { font: "body", weight: 800, size: 44 }, COL.ink, 2);
  y += 36;

  if (view.mode === "duo") {
    const big = { font: "display" as const, weight: 700, size: 144 };
    text(view.duo.score, IMG_W / 2, y, big, COL.accent, "center");
    y += lineH(big) + 8;
    y = para(view.duo.line, y, { font: "body", weight: 700, size: 44 }, COL.ink, 2, "center");
    if (view.duo.tier) {
      y += 20;
      const tier = { font: "body" as const, weight: 800, size: 52 }; // a label, not a score: body face
      text(view.duo.tier, IMG_W / 2, y, tier, COL.ink, "center");
      y += lineH(tier);
    }
    y += 40;
  } else if (view.mode === "rank") {
    const rowH = 84;
    const maxRows = 5;
    const rows = view.ranks.slice(0, maxRows);
    for (const r of rows) {
      const top = r.top;
      ops.push({ kind: "rect", x: PAD, y, w: INNER, h: rowH - 10, color: top ? COL.accent : COL.surface });
      const ink = top ? COL.accentInk : COL.ink;
      const sub = top ? COL.accentInk : COL.muted;
      const rankStyle = { font: "body" as const, weight: 800, size: 34 };
      const nickStyle = { font: "body" as const, weight: 700, size: 40 };
      const scoreStyle = { font: "display" as const, weight: 700, size: 40 };
      const ty = y + (rowH - 10 - lineH(nickStyle)) / 2;
      text(r.rankLabel, PAD + 28, ty + 4, rankStyle, sub, "left", 170);
      const scoreW = Math.min(300, measure(r.scoreLabel, scoreStyle));
      text(r.scoreLabel, PAD + INNER - 28, ty, scoreStyle, ink, "right", 300);
      const nickX = PAD + 28 + 180;
      const leftTag = r.left ? " (나감)" : "";
      text(r.nick + leftTag, nickX, ty, nickStyle, ink, "left", PAD + INNER - 28 - scoreW - 24 - nickX);
      y += rowH;
    }
    if (view.ranks.length > maxRows) {
      text(`외 ${view.ranks.length - maxRows}명`, PAD, y + 4, { font: "body", weight: 600, size: 30 }, COL.muted);
      y += 52;
    }
    y += 24;
  } else if (view.mode === "empty") {
    y = para(view.emptyText, y, { font: "body", weight: 700, size: 40 }, COL.muted, 2);
    y += 40;
  }

  // Highlighted questions, as many as fit above the footer (at most 3).
  // Each: the question, then "정답 · X" (green) and who got it (muted) on one line.
  const qStyle = { font: "body" as const, weight: 700, size: 32 };
  const aStyle = { font: "body" as const, weight: 700, size: 30 };
  const sStyle = { font: "body" as const, weight: 500, size: 28 };
  const picks = highlightQuestions(view, 3);
  const cardW = INNER - 48;
  if (picks.length && y + 60 < limit) {
    text("이런 문제였어요", PAD, y, { font: "body", weight: 700, size: 30 }, COL.muted);
    y += 52;
    for (const q of picks) {
      const qLines = wrapText(`Q${q.n}. ${q.q}`, cardW, qStyle, measure, 2);
      const h = 20 + qLines.length * lineH(qStyle) + 6 + lineH(aStyle) + 20;
      if (y + h > limit) break;
      ops.push({ kind: "rect", x: PAD, y, w: INNER, h, color: COL.surface });
      let cy = y + 20;
      for (const l of qLines) {
        text(l, PAD + 24, cy, qStyle, COL.ink, "left", cardW);
        cy += lineH(qStyle);
      }
      cy += 6;
      const answer = ellipsize(`정답 · ${q.answer}`, cardW * 0.6, aStyle, measure);
      text(answer, PAD + 24, cy, aStyle, COL.ok, "left", cardW * 0.6);
      const who = q.chips.filter((c) => c.state === "ok").map((c) => c.nick);
      const restX = PAD + 24 + measure(answer, aStyle) + 16;
      const restW = PAD + 24 + cardW - restX;
      text(who.length ? `맞힌 친구 ${who.join(" · ")}` : q.summary, restX, cy + (lineH(aStyle) - lineH(sStyle)) / 2, sStyle, COL.muted, "left", restW);
      y += h + 12;
    }
  }
  return ops;
}

// ── drawing ──
export type Families = { body: string; display: string };
export const cssFont = (s: TextStyle, families: Families) => `${s.weight} ${s.size}px ${s.font === "display" ? families.display : families.body}`;

/** The 2D-context surface drawOps needs (a real CanvasRenderingContext2D, or a fake in tests). */
export type Ctx2D = {
  fillStyle: unknown;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
};

export function drawOps(ctx: Ctx2D, ops: Op[], families: Families): void {
  ctx.textBaseline = "top";
  for (const op of ops) {
    if (op.kind === "rect") {
      ctx.fillStyle = op.color;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else {
      ctx.fillStyle = op.color;
      ctx.font = cssFont(op.style, families);
      ctx.textAlign = op.align;
      ctx.fillText(op.text, op.x, op.y);
    }
  }
}

export const measureWith = (ctx: Ctx2D, families: Families): Measure => (t, s) => {
  ctx.font = cssFont(s, families);
  return ctx.measureText(t).width;
};

/** Every (face, text) the picture will draw — what must be loaded first. */
export function glyphsNeeded(ops: Op[], families: Families): Map<string, string> {
  const by = new Map<string, string>();
  for (const op of ops) {
    if (op.kind !== "text") continue;
    const font = cssFont({ ...op.style, size: 16 }, families);
    by.set(font, (by.get(font) ?? "") + op.text);
  }
  return by;
}

/** Load the faces for every glyph: `load(font, text)` is document.fonts.load. A failed load only logs — the system fallback draws it. */
export async function ensureGlyphs(texts: Map<string, string>, load: (font: string, text: string) => Promise<unknown>): Promise<void> {
  await Promise.all([...texts].map(([font, text]) => load(font, text).catch((e) => console.warn("[result-image] font load failed", font, e))));
}

/**
 * Draw the picture: plan with the real measurer, wait for the glyphs, then plan
 * again (metrics can change once a full face arrives) and paint.
 */
export async function paintResultImage(
  ctx: Ctx2D,
  view: ResultView,
  opts: PlanOpts & { families: Families; load: (font: string, text: string) => Promise<unknown> },
): Promise<Op[]> {
  const first = planResultImage(view, measureWith(ctx, opts.families), opts);
  await ensureGlyphs(glyphsNeeded(first, opts.families), opts.load);
  const ops = planResultImage(view, measureWith(ctx, opts.families), opts);
  drawOps(ctx, ops, opts.families);
  return ops;
}

/** Browser: the PNG as a Blob. Rejects when the canvas cannot be made or encoded. */
export async function renderResultImage(view: ResultView, opts: PlanOpts & { families: Families; ready?: () => Promise<unknown> }): Promise<Blob> {
  await opts.ready?.();
  const canvas = document.createElement("canvas");
  canvas.width = IMG_W;
  canvas.height = IMG_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  await paintResultImage(ctx as unknown as Ctx2D, view, { ...opts, load: (f, t) => document.fonts.load(f, t) });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
}

export type ShareOutcome = "shared" | "cancelled" | "preview";

/**
 * Hand the picture out: the share sheet with the file when the browser can
 * share files, otherwise "preview" (the caller shows the image to save by long
 * press / a download link). Only "shared" means the sheet completed.
 */
export async function shareResultImage(blob: Blob, opts: { fileName: string; title: string; text?: string; url?: string; nav?: Navigator }): Promise<ShareOutcome> {
  const nav = opts.nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const file = typeof File !== "undefined" ? new File([blob], opts.fileName, { type: "image/png" }) : null;
  if (file && nav && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: opts.title, text: opts.text, ...(opts.url ? { url: opts.url } : {}) });
      return "shared";
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return "cancelled";
      // NotAllowedError (the tap's activation ran out) or a share target failure: offer the picture instead.
    }
  }
  return "preview";
}
