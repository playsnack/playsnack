# Contract — content-quality 게이트 (신규)

**Tool**: `snack-server/tools/content-quality.mjs`
**Run**: `node snack-server/tools/content-quality.mjs [id ...]` (id 생략 시 전 템플릿)
**Exit**: 0 = 위반 0건, 1 = 위반 존재
**Output**: stdout JSON — `data-model.md`의 ContentQualityResult 배열 + 집계

## 검사 항목 (FR-004~009)
1. **label-contrast** — 렌더된(또는 doc의 fill/textColor) 라벨 전경/배경 명도 대비 < 4.5:1 → 위반.
2. **chosung-mismatch** — 초성 퀴즈: 한글 자모 분해로 정답 초성 시퀀스 계산, 보기/힌트 정합 검사.
3. **hint-answer-mismatch** — 힌트가 가리키는 정답과 실제 정답 불일치(LLM 보조 판정 허용).
4. **missing-image** — 이미지 슬롯이 비었거나(`""`/null) 깨진 URL → 위반.
5. **filler-name** — placeholder 사전(민준/서연/홍길동/aaa/test 등) 매칭 → 위반.
6. **dedup** — 정규화된 보기 세트 해시; 쌍별 Jaccard ≥ 0.8 → 위반.
7. **awkward-content**(선택) — LLM 판정: 맥락 부적합/어색(가챠 랜덤 이미지 등). 경고 레벨.

## 입력
- `data/bite/*.bite.json` + `index.json`(카테고리). 초성/힌트/보기/이미지 슬롯은 doc의 텍스트/이미지 레이어에서 추출.

## 통과 기준
- 모든 스낵 violations(awkward 제외) == 0 → ok:true.
