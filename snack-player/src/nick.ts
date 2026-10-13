// Nickname length cap, counted in graphemes (one Korean syllable or one emoji =
// one), so the name fits the ranking rows of the together apps. Pure, so it is
// unit-tested in Node (snack-player/test/nick.test.ts).
//
// Measured with the layout engine's font metrics (packages/bite-layout, body
// 17px/700 — the ranking-row name slot, 190–210px wide across the four race
// apps): 10 Hangul syllables = 147px, 10 "W" = 170px, so a 10-grapheme name fits
// every slot; the slot's `lines: 1` ellipsis catches the rare wider cases (emoji-
// only names, 20px each). The result-card title fits a 10-syllable winner in
// tap-battle and speed-trivia; see docs/audit T-22.
export const NICK_MAX = 10;
/** The input's maxLength (UTF-16 units): a far guard only — a ZWJ emoji is up to
    11 units, so NICK_MAX of them still fit; the real cap is capGraphemes. */
export const NICK_INPUT_MAX_UNITS = NICK_MAX * 11;

// Intl.Segmenter (Safari 14.1+, Chrome 87+; typed from ES2022, the player
// targets ES2020) — without it, code points are the fallback unit.
type Segmenter = { segment(s: string): Iterable<{ segment: string }> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale: string, o: { granularity: "grapheme" }) => Segmenter }).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor("ko", { granularity: "grapheme" }) : null;

/** The first `n` graphemes of `s` (code points when the browser has no Segmenter). */
export function capGraphemes(s: string, n: number): string {
  if (n <= 0) return "";
  if (segmenter) {
    let out = "";
    let i = 0;
    for (const { segment } of segmenter.segment(s)) {
      if (i++ >= n) break;
      out += segment;
    }
    return out;
  }
  return Array.from(s).slice(0, n).join("");
}

/** The nickname as it is stored and sent: trimmed, at most NICK_MAX graphemes. */
export function clampNick(raw: string): string {
  return capGraphemes(String(raw ?? "").trim(), NICK_MAX).trimEnd();
}
