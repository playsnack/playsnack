// Dynamic content source for "fresh every time" templates. A template declares
//   "dataSource": { "url": "/api/content?kind=worldcup&theme=간식" }
// and the player fetches it on mount → setVars the returned JSON keys
// into matching variables. The server also calls getContent() directly to
// "thaw" multiplayer game packs (dynamicPack in index.mjs) so every session
// pulls fresh content instead of a frozen JSON pack.
//
// Backed by the LLM (gpt-5.5) so content is themeable + Korean-native (slang /
// 신조어 / 밈 aware), with a per-(kind,theme,KST-hour) cache: content is wiped &
// regenerated every hour on the Korean-time hour boundary, so it feels like a
// live "실시간" feed.
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const POOLS = resolve(dirname(fileURLToPath(import.meta.url)), "../data/pools");
// Real-data seed pools (Melon chart / brikorea reputation), refreshed out-of-band
// by Claude (the server can't call those sources at runtime). Graceful: null → caller falls back.
const loadPool = (name) => {
  try { const j = JSON.parse(readFileSync(resolve(POOLS, `${name}.json`), "utf8")); return Array.isArray(j.items) ? j.items : null; }
  catch { return null; }
};
// "Content day" bucket that rolls at anchorHour KST (default 09:00) — stable within
// the day, fresh once per morning. KST = UTC+9.
const kstDayBucket = (anchorHour = 9) =>
  new Date(Date.now() + (9 - anchorHour) * 3600_000).toISOString().slice(0, 10);

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ── Freshness signals ───────────────────────────────────────────────────────
// MEME_SEED: hand-refreshed every few weeks (meme half-life ~4–8wk). The model's
// Jan-2026 knowledge skews to safe/stale picks; seeding current slang nudges it
// toward "지금 우리 얘기". Keep it natural — the prompt says weave in 1–2, no force.
const MEME_SEED = [
  "중꺾마", "알잘딱깔센", "갓생", "킹받네", "어쩔티비", "스불재", "完", "현타",
  "TMI", "마라맛", "ㅇㅈ", "국룰", "갑분싸", "찐", "억텐", "손민수", "도파민", "추구미",
];
const sample = (arr, n) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};
// Deterministic Hangul 초성 (lead consonants) — so a 초성 puzzle's chosung is
// COMPUTED from the answer word, never an LLM guess that drifts off the answer.
const LEAD = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const hangulInitials = (w) => [...String(w || "")].map((ch) => {
  const c = ch.charCodeAt(0) - 0xAC00;
  return c >= 0 && c < 11172 ? LEAD[Math.floor(c / 588)] : "";
}).join("");
// KST hour → meal/time context so the same prompt costs nothing extra but reads
// as "지금 이 시간 우리 얘기".
const mealContext = (hourNum) => {
  if (hourNum >= 22 || hourNum < 2) return "야식";
  if (hourNum >= 11 && hourNum < 14) return "점심";
  if (hourNum >= 17 && hourNum < 21) return "저녁";
  if (hourNum >= 5 && hourNum < 10) return "아침/출근";
  return "";
};
const systemPrompt = (hourNum) => {
  const meal = mealContext(hourNum);
  return "너는 한국 인터넷 감성·밈·신조어·요즘 트렌드를 잘 아는 큐레이터다. 매번 신선하고 다양하게, 한국어로. " +
    `요즘 유행어/밈을 억지스럽지 않게 1~2개만 자연스럽게 녹여도 좋다(과하면 금지): ${sample(MEME_SEED, 6).join(", ")}. ` +
    (meal ? `지금은 한국 시각 '${meal}' 시간대 — 가능하면 그 맥락을 살짝 반영해. ` : "") +
    "출력은 오직 JSON 객체 하나 (설명 금지).";
};

// kind → instruction returning strict JSON whose top-level keys equal the
// template's variable ids (runtime auto-setVars). dynamicPack(index.mjs) also
// extracts these for multiplayer game packs.
const KINDS = {
  hot: {
    instr: (theme) =>
      `'${theme || "지금"}' 주제로 한국에서 지금 화제가 될 법한 핫 키워드 10개를 신선하게 골라줘. ` +
      `JSON만: {"keywords": ["키워드1", ... 10개], "updatedLabel": "오늘의 ${theme || "핫"} 키워드"}`,
  },
  worldcup: {
    instr: (theme) =>
      `'${theme || "야식"}' 이상형 월드컵 후보 16개를 골라줘. 실제로 존재하고 누구나 알 만한 다양한 대상으로(겹치지 않게). ` +
      `각 후보는 한국어 이름(name), q, 어울리는 이모지 1개(emoji)를 함께. **q는 그 대상의 영어 위키백과 문서 제목을 정확히 그대로** 써(그 문서의 대표 사진이 곧 그 대상 본인/그 음식이 되도록). ` +
      `동명이인은 반드시 구분어 포함. 예: {"name":"카리나","q":"Karina (singer)","emoji":"💃"}, {"name":"떡볶이","q":"Tteokbokki","emoji":"🌶️"}. ` +
      `위키백과에 단독 문서가 없을 만한 애매한 대상은 후보에서 제외. ` +
      `JSON만: {"candidates": [{"name":"...","q":"...","emoji":"..."}, ... 정확히 16개], "title": "${theme || "야식"} 월드컵"}`,
  },
  balance: {
    instr: (theme) =>
      `'${theme || "일상"}' 주제의 밸런스 게임(둘 중 하나 고민되는) 질문 6개를 재치있게 만들어줘. ` +
      `각 선택지(a, b)는 **한 줄, 16자 이내**로 짧고 임팩트 있게(길게 풀어쓰지 마). ` +
      `JSON만: {"dilemmas": [{"a": "선택지A", "b": "선택지B"}, ... 6개]}`,
  },
  // 눈치 배틀: 방 안 다수가 어디로 쏠릴지 예측하는 게임 → 의견이 팽팽한 양자택일 취향/밈.
  majority: {
    instr: (theme) =>
      `${theme ? `'${theme}' 관련 ` : ""}한국에서 의견이 팽팽하게 갈리는 양자택일 취향/밈 질문 8개. ` +
      `각 보기는 짧게(이모지 1개 포함 가능), 정답 없는 취향 대립으로. ` +
      `예: {"a":"민트초코 🟢","b":"반민초 🙅"}, {"a":"부먹 🥢","b":"찍먹 🍶"}. ` +
      `JSON만: {"splits": [{"a":"...","b":"..."}, ... 8개]}`,
  },
  // 우리 중 누가: 방 안 사람을 지목하는 게임 → "가장 ~할 것 같은 사람은?" 프롬프트.
  mostlikely: {
    instr: (theme) =>
      `친구·모임에서 서로를 웃으며 지목하는 "우리 중 가장 ~할 것 같은 사람은?" 형식의 재치있고 가벼운 질문 8개. ` +
      `공격적이거나 무겁지 않게, 빵 터지는 톤으로. ` +
      `JSON만: {"prompts": [{"prompt":"우리 중 가장 ~한 사람은?"}, ... 8개]}`,
  },
  quiz: {
    instr: (theme) =>
      `'${theme || "K-컬처/신조어/밈"}' 주제 4지선다 퀴즈 5문제. 교과서 상식 말고 요즘 한국 화제/문화/신조어 위주로. ` +
      `각 질문(q)은 **한 줄, 20자 이내**로 짧게(예: "'꾸안꾸'의 뜻은?") — 길게 풀어쓰면 카드를 넘친다. 각 보기(choices)도 16자 이내로 짧게. ` +
      `answer는 정답 보기의 0-based 인덱스. ` +
      `JSON만: {"questions": [{"q": "질문", "choices": ["a","b","c","d"], "answer": 0}, ... 5개]}`,
  },
  // OX 퀴즈: 참/거짓이 분명한 진술 (교과서 상식 X, 요즘 K-컬처/신조어/생활 상식 O).
  ox: {
    instr: (theme) =>
      `${theme ? `'${theme}' 관련 ` : ""}한국 사람이 흥미로워할 OX 퀴즈 5문제. 교과서 상식 말고 요즘 K-컬처/신조어/문화/생활 위주로, 명확히 참 또는 거짓인 진술문으로. ` +
      `각 진술문은 **40자 이내 한 문장**으로 짧고 명료하게(길게 늘어뜨리지 마). ` +
      `JSON만: {"questions": ["진술문1", ... 5개], "answers": [true, false, ...]} (answers[i]는 questions[i]가 사실이면 true, 아니면 false)`,
  },
  // 초성 퀴즈: LLM은 {정답단어·힌트·오답3}만 준다. chosung·보기순서·정답인덱스는
  // 서버가 정답에서 계산(hangulInitials) → 구조 정합성 100% 보장(과거 힌트/초성 불일치 버그 차단).
  choseong: {
    instr: () =>
      `초성 퀴즈 5문제. 각 문제: 누구나 아는 한국어 단어 하나를 정답(answer, 2~4글자)으로 정하고, 그 정답만 정확히 가리키는 힌트(hint), 정답과 글자수가 같고 그럴듯한 서로 다른 오답 단어 3개(distractors)를 줘. ` +
      `힌트는 반드시 그 정답 단어 하나만 가리켜야 한다(다른 단어 설명 금지). 초성·보기순서·정답위치는 서버가 정답에서 계산하니 넣지 마. ` +
      `JSON만: {"questions": [{"answer":"기린","hint":"목이 아주 긴 동물","distractors":["사슴","코끼리","하마"]}, ... 5개]}`,
  },
};

// cache: `${kind}:${theme}:${KST-hour}` → parsed JSON (rotates every 정시).
const cache = new Map();
const inflight = new Map(); // singleflight: collapse concurrent same-key requests into one LLM call
const kstParts = () => {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { bucket: `${g("year")}-${g("month")}-${g("day")}T${g("hour")}`, hour: Number(g("hour")) };
};

// 음원 월드컵: no LLM — the Melon seed IS the content. Daily bucket → stable within
// the day, fresh each morning (09 KST). Returns null if no pool → getContent falls back
// to the LLM worldcup path (graceful: seed 사라져도 앱이 빈 채로 깨지지 않음, T010/SC-006).
function buildSongcup() {
  const bucket = kstDayBucket(9);
  const key = `songcup::${bucket}`;
  if (cache.has(key)) return cache.get(key);
  const items = loadPool("songs");
  if (!items || items.length < 2) return null;
  const picked = sample(items, Math.min(16, items.length));
  // name = 곡명(라벨), q = 아티스트(위키 사진 — 기존 strict=1 이미지 카드 구조 그대로 재사용)
  const current = picked.map((x) => ({ name: x.song, q: x.artist, artist: x.artist }));
  const out = { current, seed: current.slice(), title: "오늘의 음원 월드컵", _bucket: bucket };
  for (const k of cache.keys()) if (k.startsWith("songcup::") && k !== key) cache.delete(k);
  cache.set(key, out);
  return out;
}

// 인물 월드컵 공통: brikorea 평판 시드(poolName)에서 성별 필터 → 순위 정렬 → 16강 + 신인 ≥1 보장.
// 월 버킷(천천히 변함). q = 개인 위키 표제 "이름 (가수)" — 본인 사진을 노린다(ko-first 위키 + 상위5 검색).
// 아이돌(idols)·가수(singers) 풀이 동일 스키마({name,rank,gender,rookie?})라 한 함수로 처리.
// 시드 없거나 너무 작으면 null → getContent가 LLM worldcup으로 graceful 폴백(T010/SC-006).
function buildPersonCup(poolName, gender, label, qFn) {
  const g = gender === "m" ? "m" : "f";
  const bucket = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7); // YYYY-MM KST
  const key = `${poolName}:${g}:${bucket}`;
  if (cache.has(key)) return cache.get(key);
  const all = loadPool(poolName);
  if (!all) return null;
  const pool = all.filter((x) => x.gender === g).sort((a, b) => (a.rank || 999) - (b.rank || 999));
  if (pool.length < 4) return null;
  const picked = pool.slice(0, 16);
  if (!picked.some((x) => x.rookie)) { const r = pool.find((x) => x.rookie); if (r) picked[picked.length - 1] = r; } // 신인 ≥1 보장
  const cands = sample(picked, picked.length).map((x) => ({ name: x.name, q: qFn(x.name), group: x.group, rookie: !!x.rookie }));
  const out = { current: cands, seed: cands.slice(), title: `${g === "m" ? "남자" : "여자"} ${label} 월드컵`, _bucket: bucket };
  for (const k of cache.keys()) if (k.startsWith(`${poolName}:${g}:`) && k !== key) cache.delete(k);
  cache.set(key, out);
  return out;
}
// 아이돌: "이름|가수" 컨벤션 — 서버가 "이름 (가수)"(동명이인 핀포인트) 먼저, 실패/429 시
// bare "이름"(본인 문서에 사진 있음)으로 폴백. 과거 "(가수)" 단독은 폴백이 없어, 위키가
// 그 표제를 rate-limit/404하면 카드가 빈 채로 남았다(예: "태연 (가수)"→429인데 "태연"→200).
const buildIdolcup = (gender) => buildPersonCup("idols", gender, "아이돌", (n) => `${n}|가수`);
// 솔로 가수: 위키 표제가 대개 이름 그대로라 "(가수)"는 오히려 404多 → "이름|가수" 컨벤션으로
// 서버(/api/img)가 "이름 (가수)" 먼저, 실패 시 "이름" bare 순으로 시도(disambig→bare 폴백).
const buildSingercup = (gender) => buildPersonCup("singers", gender, "가수", (n) => `${n}|가수`);

// Hand-curated bank (data/seed-content/content.json) served when the LLM can't
// answer — no key, quota, network. Sampled per call so plays still vary.
let BANK = null;
const bank = () => {
  if (BANK) return BANK;
  try { BANK = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../data/seed-content/content.json"), "utf8")); }
  catch { BANK = {}; }
  return BANK;
};
// 초성 item {answer, hint, distractors} → puzzle with code-computed chosung + exact answer index.
const toChoseong = (q) => {
  if (!q || typeof q.answer !== "string" || typeof q.hint !== "string" || !Array.isArray(q.distractors)) return null;
  const answer = q.answer.trim();
  const distractors = [...new Set(q.distractors.filter((d) => typeof d === "string" && d.trim() && d.trim() !== answer).map((d) => d.trim()))].slice(0, 3);
  if (!answer || distractors.length < 3) return null;
  const options = sample([answer, ...distractors], 4);
  return { chosung: hangulInitials(answer), hint: q.hint.trim(), options, answer: options.indexOf(answer) };
};
export function fallbackContent(kind, theme = "") {
  const b = bank();
  if (kind === "worldcup") {
    const pool = b.worldcup?.[theme];
    if (!Array.isArray(pool) || pool.length < 16) return null;
    const picked = sample(pool, 16).map((c) => ({ q: c.name, emoji: "", ...c }));
    return { candidates: picked, current: picked, seed: picked, title: `${theme} 월드컵`, _source: "bank" };
  }
  if (kind === "ox" && Array.isArray(b.ox) && b.ox.length >= 5) {
    const items = sample(b.ox, 5);
    return { questions: items.map((x) => x.s), answers: items.map((x) => x.a), _source: "bank" };
  }
  if (kind === "choseong" && Array.isArray(b.choseong)) {
    const questions = sample(b.choseong, 5).map(toChoseong).filter(Boolean);
    return questions.length >= 3 ? { questions, _source: "bank" } : null;
  }
  return null;
}

export async function getContent(kind, theme = "") {
  const live = await getLiveContent(kind, theme);
  if (!live?.error) return live;
  // LLM unavailable → curated bank (if this kind/theme has one), else the error.
  return fallbackContent(kind, theme) ?? live;
}

async function getLiveContent(kind, theme = "") {
  // Seed-backed worldcups (real data). No seed → null → fall back to the LLM `worldcup`
  // path with an equivalent theme so the app stays playable (graceful, T010/SC-006).
  if (kind === "songcup") return buildSongcup() ?? getContent("worldcup", "요즘 인기 가수");
  if (kind === "idolcup") return buildIdolcup(theme) ?? getContent("worldcup", `${theme === "m" ? "남자" : "여자"} 아이돌`);
  if (kind === "singercup") return buildSingercup(theme) ?? getContent("worldcup", `${theme === "m" ? "남자" : "여자"} 가수`);
  const spec = KINDS[kind];
  if (!spec) return { error: `unknown kind '${kind}'` };
  const { bucket, hour } = kstParts();
  const key = `${kind}:${theme}:${bucket}`;
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key); // stampede guard: share the in-progress call
  if (!client) return { error: "OPENAI_API_KEY not set" };

  const run = (async () => {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt(hour) },
        { role: "user", content: spec.instr(theme) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 2000,
      reasoning_effort: process.env.OPENAI_REASONING || "low",
    });
    const json = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    if (kind === "worldcup" && Array.isArray(json.candidates)) {
      json.current = json.candidates.slice(0, 16);
      json.seed = json.candidates.slice(0, 16);
    }
    // 초성: build the puzzle from the LLM's {answer,hint,distractors} so chosung is
    // CODE-COMPUTED from the answer and the answer index is exact — no drift.
    if (kind === "choseong" && Array.isArray(json.questions)) {
      json.questions = json.questions.map(toChoseong).filter(Boolean);
      if (json.questions.length < 3) return { error: "choseong validation failed (insufficient valid items)" };
    }
    json._bucket = bucket;
    for (const k of cache.keys()) if (k.startsWith(`${kind}:${theme}:`) && k !== key) cache.delete(k);
    cache.set(key, json);
    return json;
  })();

  inflight.set(key, run);
  try { return await run; }
  catch (e) { return { error: String(e?.message ?? e) }; }
  finally { inflight.delete(key); }
}

export const CONTENT_KINDS = Object.keys(KINDS);
