// Hangul jamo utilities — deterministic 초성(lead consonant) extraction.
// Used by content-quality.mjs to verify 초성 quiz integrity (FR-005, research R3).
//
// Korean syllable block: U+AC00..U+D7A3. Decompose:
//   index = code - 0xAC00; lead = index / (21*28).
// 19 lead consonants (초성):
const LEADS = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 초성 of a single character, or the char itself if not a complete Hangul syllable
// (already-a-jamo like "ㄱ" passes through; spaces/punct return "").
export function leadOf(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    return LEADS[Math.floor((code - 0xac00) / (21 * 28))];
  }
  if (ch.trim() === "") return "";
  return ch; // jamo or non-Hangul — return as-is so "ㄱㄴㄷ" maps to itself
}

// 초성 sequence of a word, ignoring whitespace. "고양이" -> "ㄱㅇㅇ".
export function chosungOf(word) {
  return [...String(word)].map(leadOf).filter((c) => c !== "").join("");
}

// Does `word`'s 초성 sequence equal the given `chosung` string?
// Normalizes the chosung string the same way (strips spaces).
export function matchesChosung(word, chosung) {
  const want = [...String(chosung)].map((c) => c.trim()).filter(Boolean).join("");
  return chosungOf(word) === want;
}
