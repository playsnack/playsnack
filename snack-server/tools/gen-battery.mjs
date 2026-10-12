// gen-battery gate (F). Measures chat→app GENERATION reliability: N prompts →
// builder → Bite validate + runtime/layout lint (+1 repair) → %pass. (FR-016/017/018)
// PRE: server running + OpenAI key. stdout JSON + exit 0/1.
//   Usage: node snack-server/tools/gen-battery.mjs [--n 20] [--target 0.9]
//
// IMPORTANT: the builder is rate-limited (BUILD_PER_IP_HR, default 8/hr). A 20-prompt
// battery WILL hit that cap and misread rate-limits as generation failures. Run the
// server with the caps raised, e.g.:
//   BUILD_PER_IP_HR=500 BUILD_GLOBAL_HR=500 pnpm server:dev
// This tool now flags HTTP 429 responses as `rateLimited` (excluded from the failure
// signal) so a capped run is obvious rather than silently scored as 0%.
import { validate } from "@snack/bite";
import { HOST_ACTIONS } from "@snack/room/actions";
import { lintDoc } from "../src/builder.mjs";
import { runGate } from "./_gate.mjs";

const BASE = process.env.SNACK_BASE || `http://localhost:${process.env.PORT || 4399}`;

// 20 representative KR prompts covering every category (research R6).
const PROMPTS = [
  ["vote", "라면 먹을 때 국물부터 vs 면부터, 밸런스 투표 만들어줘"],
  ["vote", "여행 갈 때 바다 vs 산 둘 중 하나 고르는 투표"],
  ["vote", "우리 팀 회식 메뉴 정하는 베스트 투표"],
  ["quiz", "한국 상식 OX 퀴즈 5문제"],
  ["quiz", "초성 퀴즈 만들어줘 (동물 주제)"],
  ["quiz", "영화 트리비아 빨리 맞히기 퀴즈"],
  ["worldcup", "야식 월드컵 16강"],
  ["worldcup", "여름 휴가지 이상형 월드컵"],
  ["worldcup", "분식 최애 월드컵"],
  ["game", "두더지 잡기 30초 게임"],
  ["game", "반응속도 테스트 게임"],
  ["game", "탭 연타 클리커 게임"],
  ["game", "색깔 순서 기억 게임"],
  ["random", "행운의 룰렛 돌리기"],
  ["random", "점심 메뉴 랜덤 뽑기"],
  ["random", "가챠 뽑기 (등급별)"],
  ["psych", "MBTI 빠른 테스트"],
  ["psych", "나는 무슨 동물일까 심리테스트"],
  ["counter", "다같이 1만번 클릭 카운터"],
  ["counter", "응원 떼창 게이지"],
];

async function build(prompt) {
  const res = await fetch(`${BASE}/api/builder/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, mode: "auto" }),
  });
  const body = await res.json().catch(() => ({}));
  return { ...body, _status: res.status, _rateLimited: res.status === 429 };
}

// Same checks the builder runs: spec validation, a headless play-through
// (every tappable node once, runtime warnings), and the layout lint per phase.
async function verifyLayout(doc) {
  const v = validate(doc, { hostActions: HOST_ACTIONS });
  if (!v.ok) return { valid: false, runnable: false, fits: false, errors: v.errors.slice(0, 5) };
  const lint = await lintDoc(doc);
  return { valid: true, runnable: !/runtime/.test(lint ?? ""), fits: !lint, lint: lint ?? undefined };
}
const layoutOk = (v) => v && v.valid && v.runnable && v.fits;

async function main() {
  const argv = process.argv.slice(2);
  const n = argv.includes("--n") ? Number(argv[argv.indexOf("--n") + 1]) : PROMPTS.length;
  const target = argv.includes("--target") ? Number(argv[argv.indexOf("--target") + 1]) : 0.9;
  const set = PROMPTS.slice(0, n);

  const results = [];
  for (const [category, prompt] of set) {
    let repairs = 0, doc = null, layout = null, rateLimited = false;
    try {
      let r = await build(prompt);
      rateLimited = !!r._rateLimited;
      doc = r?.doc ?? null;
      layout = doc ? await verifyLayout(doc) : null;
      if (doc && !layoutOk(layout)) { // one repair attempt
        repairs = 1;
        r = await build(prompt + " (이전 결과가 화면을 벗어났어요. 한 화면에 맞게 다시 만들어줘)");
        rateLimited = rateLimited || !!r._rateLimited;
        doc = r?.doc ?? doc;
        layout = doc ? await verifyLayout(doc) : layout;
      }
    } catch (e) {
      results.push({ category, prompt, ok: false, error: String(e?.message ?? e) });
      continue;
    }
    const ok = !!doc && layoutOk(layout);
    results.push({ category, prompt, generated: !!doc, rateLimited, repairs, layout, ok });
  }

  // Rate-limited attempts are an infrastructure cap, NOT a generation failure —
  // exclude them from the reliability denominator and surface them separately.
  const rl = results.filter((r) => r.rateLimited && !r.generated).length;
  const scored = results.filter((r) => !(r.rateLimited && !r.generated));
  const passRate = scored.length ? scored.filter((r) => r.ok).length / scored.length : 0;
  runGate("gen-battery", results, (r) => r.ok,
    () => `gen-battery: passRate ${(passRate * 100).toFixed(0)}% of ${scored.length} generated (target ${(target * 100).toFixed(0)}%)` +
          (rl ? ` — ⚠ ${rl}/${results.length} RATE-LIMITED (raise BUILD_PER_IP_HR/BUILD_GLOBAL_HR)` : ""));
  // pass only if no rate-limit noise AND rate >= target
  process.exitCode = (rl === 0 && passRate >= target) ? 0 : 1;
}

main();
