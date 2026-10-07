# Contract — gen-battery 게이트 (신규)

**Tool**: `snack-server/tools/gen-battery.mjs`
**Run**: `node snack-server/tools/gen-battery.mjs [--n 20]`
**Pre**: 서버 실행 + OpenAI 키(서버사이드).
**Exit**: 0 = passRate ≥ 목표(0.90), 1 = 미달
**Output**: stdout JSON — GenBatteryResult 배열 + 집계 `{n, passRate, avgRepairs}`

## 절차 (FR-016/017/018, SC-006)
1. 대표 프롬프트 N=20(카테고리 커버) 로드.
2. 각 프롬프트 → `builder.mjs` chat 생성 → 레거시 엔진 doc.
3. `verify-layout`(valid/runnable/fits/badBindings) + 1회 수리 허용(빌더 재생성).
4. 통과 doc → `e2e-audit` 오라클 PASS 여부.
5. 항목별 generated/repairs/oracle/layout 기록, 전체 passRate 집계.

## 통과 기준
- passRate ≥ 0.90(잠정, 실측 후 SC-006 확정). 각 PASS 항목은 layout 전부 true + badBindings 0 + oracle PASS.

## 프롬프트 세트
- vote×3, quiz×3, worldcup×3, game×4, random×3, psych×2, counter×2 (= 20). 한국어, 실제 주제.
