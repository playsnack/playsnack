// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { NICK_INPUT_MAX_UNITS, NICK_MAX, capGraphemes, clampNick } from "../src/nick.ts";
import { measureText } from "../../packages/bite-layout/src/measure.js";

test("NICK_MAX Hangul syllables fit the narrowest ranking-row name slot (190px, body 17/700)", () => {
  // reaction-duel-score rnick* width 190; tap-battle 210; speed-trivia/majority 200.
  const hangul = measureText("뷁".repeat(NICK_MAX), { size: 17, weight: 700 }).width;
  const latin = measureText("W".repeat(NICK_MAX), { size: 17, weight: 700 }).width;
  assert.ok(hangul <= 190, `${NICK_MAX} syllables = ${hangul}px`);
  assert.ok(latin <= 190, `${NICK_MAX} W = ${latin}px`);
  // the old cap (16 UTF-16 units) did not fit: the row overflowed (T-22)
  assert.ok(measureText("뷁".repeat(16), { size: 17, weight: 700 }).width > 210);
});

test("clampNick caps by grapheme: Korean syllables count one each", () => {
  assert.equal(clampNick("가나다라마바사아자차카타파하"), "가나다라마바사아자차");
  assert.equal(clampNick("반짝이는 햄스터"), "반짝이는 햄스터", "default random nicks are untouched");
  assert.equal(clampNick("  라임 "), "라임");
});

test("clampNick keeps emoji and ZWJ sequences whole, and the input's unit guard never blocks them", () => {
  const family = "👨‍👩‍👧‍👦"; // one grapheme, 11 UTF-16 units
  assert.equal(family.length, 11);
  assert.equal(clampNick(family.repeat(3)), family.repeat(3));
  // the <input maxLength> counts UTF-16 units: NICK_MAX family emoji must be typeable
  assert.ok(family.repeat(NICK_MAX).length <= NICK_INPUT_MAX_UNITS, `${family.repeat(NICK_MAX).length} units > maxLength ${NICK_INPUT_MAX_UNITS}`);
  assert.equal(clampNick("😀".repeat(12)), "😀".repeat(NICK_MAX));
  assert.equal(clampNick("a".repeat(9) + family + "b"), "a".repeat(9) + family);
});

test("clampNick never ends in a space after the cut", () => {
  assert.equal(clampNick("아홉글자닉네임이 긴이름"), "아홉글자닉네임이 긴");
  assert.equal(clampNick("abcdefghi jk"), "abcdefghi");
});

test("capGraphemes: edge cases", () => {
  assert.equal(capGraphemes("", 5), "");
  assert.equal(capGraphemes("abc", 0), "");
  assert.equal(capGraphemes("abc", 10), "abc");
});
