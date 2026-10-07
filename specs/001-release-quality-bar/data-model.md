# Data Model — 출시 품질 바 (Phase 1)

데이터 모델은 (a) 도메인 엔티티(기존 레거시 엔진 기반)와 (b) 신규 게이트 리포트 스키마로 나뉜다.
도메인 모델은 새로 만들지 않는다(헌법 II) — 레거시 엔진 문서가 앱 정의다.

## 도메인 엔티티 (기존)

### Snack (Template/App)
레거시 엔진 문서. `snack-server/data/bite/<id>.bite.json`.
- `id`, `포맷 버전`(1.14.0), `variables[]`, `scene.states{}`, `aspectRatio`(픽셀 "390:844").
- 카테고리: worldcup/vote/quiz/psych/game/random/counter (index.json 메타).
- **구조(검증 블록)** + **콘텐츠 슬롯**(텍스트/이미지/보기) 분리.

### ContentSlot
스낵 내 채워지는 콘텐츠. AI/`/api/content`가 채움.
- 텍스트(라벨/힌트/정답/보기), 이미지URL(Wikipedia-first), 보기 세트.
- 검사 대상: 진실성, 힌트↔정답↔보기 정합, 라벨 대비, 이미지 존재, dedup.

### LiveRoom (실시간, 인메모리)
`room(slug)` — `index.mjs`.
- `sockets:Set`, `coop:number`, per-player best(leaderboard), vote tally(`votesByOption`).
- 공유 var: `votesByOption | coopTotal | leaderboard` 중 보유 → 멀티플레이어 스낵으로 분류.

## 게이트 리포트 스키마 (신규 — 모든 게이트 공통 형태)

모든 게이트 도구는 stdout JSON + exit code(0 pass / 1 fail)를 낸다. 공통:

```jsonc
{
  "gate": "oracle | content-quality | multiclient-sim | gen-battery | layout",
  "ok": true,                      // 전체 통과 여부
  "total": 29, "passed": 29, "failed": 0,
  "results": [ /* per-item, 아래 게이트별 */ ],
  "summary": "사람이 읽는 한 줄"
}
```

### OracleResult (기존 e2e-audit, 형태 정합화)
```jsonc
{ "id": "vote-balance", "verdict": "PASS|FAIL", "reason": "...",
  "statesReached": 4, "deadControls": 0, "timerCountsDown": true }
```

### ContentQualityResult (신규)
```jsonc
{ "id": "quiz-chosung", "ok": false,
  "violations": [
    { "type": "label-contrast", "ratio": 1.1, "min": 4.5, "where": "option row 'A'" },
    { "type": "chosung-mismatch", "answer": "고난도", "answerChosung": "ㄱㄴㄷ",
      "option": "고양이", "optionChosung": "ㄱㅇㅇ" },
    { "type": "missing-image", "where": "candidate 2" },
    { "type": "filler-name", "value": "민준" },
    { "type": "dedup", "otherId": "worldcup-food", "jaccard": 0.92 }
  ] }
```
violation `type`: `label-contrast | chosung-mismatch | hint-answer-mismatch | missing-image | filler-name | dedup | awkward-content`.

### MultiClientSimResult (신규)
```jsonc
{ "id": "vote-balance", "clients": 6, "ok": true,
  "converged": true, "maxConvergeMs": 40, "desyncEvents": 0,
  "tallyError": 0, "participantsAccurate": true }
```

### GenBatteryResult (신규)
```jsonc
{ "promptId": "p07-worldcup-idol", "category": "worldcup",
  "generated": true, "repairs": 1, "oracle": "PASS",
  "layout": { "valid": true, "runnable": true, "fits": true, "badBindings": 0 } }
// 집계: { "n": 20, "passRate": 0.95, "avgRepairs": 0.3 }
```

## 검증 규칙 (요구사항 → 데이터 제약)

| FR | 제약 |
|----|------|
| FR-001/002 | OracleResult.verdict == PASS, deadControls == 0 (전 스낵) |
| FR-004 | label-contrast.ratio ≥ 4.5 |
| FR-005 | chosung/hint-answer mismatch == 0 |
| FR-006/007 | missing-image == 0, 타깃 가시성 확보 |
| FR-008 | dedup.jaccard < 0.8 (모든 쌍), filler-name == 0 |
| FR-010/011 | timerCountsDown == true; reaction false-fail == 0 |
| FR-013/014 | converged==true, desyncEvents==0, tallyError==0 |
| FR-016/017/018 | gen passRate ≥ 0.90, 각 항목 layout 전부 true·badBindings 0 |
