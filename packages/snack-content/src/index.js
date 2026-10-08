// Keyless content: turns the seed pools (real chart / reputation snapshots) and
// the hand-curated bank into exactly the JSON a template's `data.url` expects.
// Pure — callers pass the data in, so the server (as its fallback) and the
// serverless player (as its only source) share one implementation.

export const sample = (arr, n, random = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

// Deterministic Hangul 초성 — computed from the answer, never guessed.
const LEAD = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
export const hangulInitials = (w) =>
  [...String(w || "")]
    .map((ch) => {
      const c = ch.charCodeAt(0) - 0xac00;
      return c >= 0 && c < 11172 ? LEAD[Math.floor(c / 588)] : "";
    })
    .join("");

/** 초성 item {answer, hint, distractors} → puzzle with a code-computed chosung and exact answer index. */
export function toChoseong(q, random = Math.random) {
  if (!q || typeof q.answer !== "string" || typeof q.hint !== "string" || !Array.isArray(q.distractors)) return null;
  const answer = q.answer.trim();
  const distractors = [...new Set(q.distractors.filter((d) => typeof d === "string" && d.trim() && d.trim() !== answer).map((d) => d.trim()))].slice(0, 3);
  if (!answer || distractors.length < 3) return null;
  const options = sample([answer, ...distractors], 4, random);
  return { chosung: hangulInitials(answer), hint: q.hint.trim(), options, answer: options.indexOf(answer) };
}

/** 음원 월드컵: today's chart songs (title + artist). */
export function songCup(songs, random = Math.random) {
  if (!Array.isArray(songs) || songs.length < 2) return null;
  const current = sample(songs, Math.min(16, songs.length), random).map((x) => ({ name: x.song, q: x.artist, artist: x.artist }));
  return { current, seed: current.slice(), title: "오늘의 음원 월드컵" };
}

/** 인물 월드컵 (idols / singers pools): top-16 by reputation for a gender, ≥1 rookie. */
export function personCup(pool, gender, label, random = Math.random) {
  if (!Array.isArray(pool)) return null;
  const g = gender === "m" ? "m" : "f";
  const ranked = pool.filter((x) => x.gender === g).sort((a, b) => (a.rank || 999) - (b.rank || 999));
  if (ranked.length < 4) return null;
  const picked = ranked.slice(0, 16);
  if (!picked.some((x) => x.rookie)) {
    const r = ranked.find((x) => x.rookie);
    if (r) picked[picked.length - 1] = r;
  }
  const current = sample(picked, picked.length, random).map((x) => ({ name: x.name, q: `${x.name}|가수`, group: x.group, rookie: !!x.rookie }));
  return { current, seed: current.slice(), title: `${g === "m" ? "남자" : "여자"} ${label} 월드컵` };
}

/** Curated bank → worldcup / ox / choseong content. */
export function bankContent(bank, kind, theme = "", random = Math.random) {
  if (!bank) return null;
  if (kind === "worldcup") {
    const pool = bank.worldcup?.[theme];
    if (!Array.isArray(pool) || pool.length < 16) return null;
    const picked = sample(pool, 16, random).map((c) => ({ q: c.name, emoji: "", ...c }));
    return { candidates: picked, current: picked, seed: picked, title: `${theme} 월드컵` };
  }
  if (kind === "ox" && Array.isArray(bank.ox) && bank.ox.length >= 5) {
    const items = sample(bank.ox, 5, random);
    return { questions: items.map((x) => x.s), answers: items.map((x) => x.a) };
  }
  if (kind === "choseong" && Array.isArray(bank.choseong)) {
    const questions = sample(bank.choseong, 5, random).map((q) => toChoseong(q, random)).filter(Boolean);
    return questions.length >= 3 ? { questions } : null;
  }
  return null;
}

/**
 * Content for a template's data.url (`/api/content?kind=…&theme=…`) without any
 * server: seed pools for the chart / person cups, the bank for the rest.
 * @param {{ bank?: object, pools?: { songs?: any[], idols?: any[], singers?: any[] } }} data
 */
export function contentFor(kind, theme = "", data = {}, random = Math.random) {
  const pools = data.pools ?? {};
  if (kind === "songcup") return songCup(pools.songs, random);
  if (kind === "idolcup") return personCup(pools.idols, theme, "아이돌", random);
  if (kind === "singercup") return personCup(pools.singers, theme, "가수", random);
  return bankContent(data.bank, kind, theme, random);
}

/** Parse a template's data.url → { kind, theme } (or null if it isn't a content URL). */
export function parseContentUrl(url) {
  try {
    const u = new URL(url, "http://x");
    if (!u.pathname.endsWith("/api/content")) return null;
    return { kind: u.searchParams.get("kind") || "", theme: u.searchParams.get("theme") || "" };
  } catch {
    return null;
  }
}
