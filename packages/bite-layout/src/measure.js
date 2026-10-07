// Text measurement and line breaking from shipped font metrics — no canvas,
// no DOM — so Node (gates) and every phone lay text out identically.
import METRICS from "./metrics.js";

export const TEXT_DEFAULTS = { font: "body", size: 15, weight: 500 };
export const LINE_HEIGHT = { body: 1.35, display: 1.3 };
const EMOJI_EM = 1.2; // system color-emoji advance, slightly generous
const FALLBACK_CJK_EM = 1;
const FALLBACK_EM = 0.6;
const ELLIPSIS = "…";

const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Nearest shipped weight for a family (ties go heavier). */
export function faceFor(font, weight) {
  const faces = METRICS[font] ?? METRICS.body;
  const w = Number(weight) || TEXT_DEFAULTS.weight;
  let best = null;
  for (const k of Object.keys(faces).map(Number)) {
    if (best === null || Math.abs(k - w) < Math.abs(best - w) || (Math.abs(k - w) === Math.abs(best - w) && k > best)) best = k;
  }
  return { weight: best, metrics: faces[best] };
}

function graphemeWidth(g, m, size) {
  const em = size / m.unitsPerEm;
  if (g.length > 1 && PICTOGRAPHIC.test(g)) return EMOJI_EM * size;
  const cp = g.codePointAt(0);
  if (cp >= 0xac00 && cp <= 0xd7a3) return m.hangul * em;
  const w = m.glyphs[cp];
  if (w !== undefined) return w * em;
  if (PICTOGRAPHIC.test(g)) return EMOJI_EM * size;
  return (cp >= 0x2e80 ? FALLBACK_CJK_EM : FALLBACK_EM) * size;
}

function widthOf(str, m, size) {
  let w = 0;
  for (const { segment } of graphemes.segment(str)) w += graphemeWidth(segment, m, size);
  return w;
}

// Break one over-long word into pieces that fit (grapheme granularity).
function breakWord(word, max, m, size) {
  const out = [];
  let cur = "";
  let curW = 0;
  for (const { segment } of graphemes.segment(word)) {
    const gw = graphemeWidth(segment, m, size);
    if (cur && curW + gw > max) {
      out.push({ text: cur, width: curW });
      cur = "";
      curW = 0;
    }
    cur += segment;
    curW += gw;
  }
  if (cur) out.push({ text: cur, width: curW });
  return out;
}

function truncate(line, max, m, size) {
  const ell = widthOf(ELLIPSIS, m, size);
  const parts = [...graphemes.segment(line.text)].map((s) => s.segment);
  let w = line.width;
  while (parts.length && w + ell > max) w -= graphemeWidth(parts.pop(), m, size);
  const text = parts.join("").trimEnd() + ELLIPSIS;
  return { text, width: widthOf(text, m, size) };
}

/**
 * Lay out text: words wrap at spaces (Korean keep-all style), a word longer
 * than the line breaks between graphemes, `\n` forces a break, and `lines`
 * caps the count with an ellipsis.
 * @returns {{ lines: {text: string, width: number}[], width: number, height: number, lineHeight: number, weight: number }}
 */
export function measureText(text, style = {}, maxWidth = Infinity) {
  const font = style.font === "display" ? "display" : "body";
  const size = Number(style.size) || TEXT_DEFAULTS.size;
  const { weight, metrics: m } = faceFor(font, style.weight);
  const lineHeight = Math.round(size * LINE_HEIGHT[font]);
  const max = maxWidth > 0 ? maxWidth : Infinity;
  const space = widthOf(" ", m, size);

  const lines = [];
  for (const para of String(text ?? "").split("\n")) {
    let cur = "";
    let curW = 0;
    const flush = () => {
      lines.push({ text: cur, width: curW });
      cur = "";
      curW = 0;
    };
    for (const word of para.split(" ")) {
      if (word === "") {
        // consecutive spaces collapse to one
        continue;
      }
      const ww = widthOf(word, m, size);
      const lead = cur ? space : 0;
      if (curW + lead + ww <= max) {
        cur += (cur ? " " : "") + word;
        curW += lead + ww;
        continue;
      }
      if (cur) flush();
      if (ww <= max) {
        cur = word;
        curW = ww;
        continue;
      }
      const pieces = breakWord(word, max, m, size);
      pieces.slice(0, -1).forEach((p) => lines.push(p));
      ({ text: cur, width: curW } = pieces.at(-1));
    }
    flush();
  }

  const limit = Number(style.lines) || 0;
  if (limit > 0 && lines.length > limit) {
    lines.length = limit;
    lines[limit - 1] = truncate(lines[limit - 1], max, m, size);
  }
  const width = lines.reduce((w, l) => Math.max(w, l.width), 0);
  return { lines, width, height: lines.length * lineHeight, lineHeight, weight };
}
