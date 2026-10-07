# Research — 출시 품질 바 (Phase 0)

Technical Context의 미해결 지점을 결정으로 정리한다. 형식: Decision / Rationale / Alternatives.

## R1. 4개 open 스낵 오라클 PASS

**Decision**: 각 open 스낵의 실패 원인을 오라클이 지목한 가설대로 분류해 수정한다 — race-trivia/race-trivia류는 **그리드 내부 컴포넌트 히트**(`__snackHit`이 grid child의 rect를 못 잡음), game-tap-target은 **작은 타깃의 히트영역 부족**, game-reaction/race-reaction은 **wait-then-flip을 오라클이 false-fail**. 우선 오라클(`e2e-audit.mjs`)의 히트/게임루프 판정을 reaction·grid에 맞게 보정하고, 그래도 남는 실제 결함은 해당 `.bite.json`(또는 렌더러 layout grid 경로)에서 고친다.

**Rationale**: 헌법 I — 오라클이 정상 동작을 false-fail 하면 오라클을 고쳐야지 스낵을 억지로 통과시키면 안 된다(spec Edge Case). 실제 결함과 오라클 결함을 먼저 분리해야 한다.

**Alternatives**: (a) 스낵을 오라클에 맞춰 단순화 — 거부(콘텐츠 손상). (b) open 스낵 출시 제외 — 거부(SC-001 전수 PASS 목표).

## R2. 라벨 가독성 정량 기준

**Decision**: 텍스트-배경 명도 대비 **≥ 4.5:1**(WCAG AA 본문 기준)을 라벨 가독성 합격선으로 한다. 디자인 토큰(블랙+라임)은 유지하되, 라임 바 위 텍스트는 다크 색으로(또는 그 반대) 대비를 확보한다. 체커는 렌더된 라벨의 전경/배경 색을 추출해 대비를 계산한다.

**Rationale**: audit의 "라임 글자 on 라임 바" = 대비 ~1:1. 정량 임계(4.5)로 자동 판정 가능. 새 디자인 시스템 도입 아님(Assumptions).

**Alternatives**: 3:1(AA large) — 거부(작은 라벨 다수라 본문 기준이 안전). 수동 눈검수 — 거부(헌법 I 자동 게이트).

## R3. 초성 퀴즈 정합 검증

**Decision**: 한글 자모 분해로 **정답의 초성 시퀀스**를 계산하고, (a) 힌트가 가리키는 정답과 (b) 모든 보기의 초성 패턴 일치를 검사한다. 불일치(예: 정답 "고난도"=ㄱㄴㄷ인데 보기 "고양이"=ㄱㅇㅇ, 힌트 "동물 사는 곳") → FAIL.

**Rationale**: audit이 지목한 결함이 정확히 초성-정답-힌트 3자 불일치. 자모 분해는 결정적(유니코드 한글 음절 분해)이라 자동화 가능.

**Alternatives**: LLM 판정 — 보조로만(정합은 결정적 규칙 우선, 의미/사실성은 LLM). 

## R4. 콘텐츠 dedup

**Decision**: 각 스낵의 보기/후보 세트를 정규화(소문자·공백·이미지URL 제거)해 **세트 해시**를 만들고, 두 스낵이 동일/과도 중첩(예: Jaccard ≥ 0.8) 세트를 공유하면 FLAG. 필러 이름("민준","서연" 등 placeholder 사전)도 별도 FLAG.

**Rationale**: SC-003 중복 0쌍, FR-008. 해시/Jaccard는 가볍고 결정적.

**Alternatives**: 완전 동일만 검사 — 거부(거의-중복 놓침).

## R5. 멀티클라이언트 sim

**Decision**: Node `ws` 클라이언트 2–8개를 같은 slug 룸에 접속시켜, 한 클라가 `action`(vote/coop/score) 송신 → 모든 클라가 `setVar` 브로드캐스트로 같은 값에 **수렴**하는지, 참가자 수가 맞는지, 재투표/동시 변동 시 집계 오차·desync가 없는지 어서트한다. 서버 실시간 경로(`index.mjs`의 tally/coop/board broadcast)를 그대로 검증.

**Rationale**: FR-014, SC-005. 기존 오라클은 단일 클라. 서버는 이미 `votesByOption/coopTotal/leaderboard/participants`를 브로드캐스트하므로 클라 측 수렴만 어서트하면 됨.

**Alternatives**: 브라우저 N개(Playwright) — 거부(무겁고 느림; 동기화 본질은 WS 레벨이라 소켓 sim으로 충분). 멀티플레이어 스낵 식별은 doc에 `votesByOption/coopTotal/leaderboard` 공유 var 유무로 자동 분류.

## R6. 생성 배터리 & 신뢰성 목표

**Decision**: 대표 프롬프트 **N=20**(카테고리 커버: vote/quiz/worldcup/game/random/psych/counter)을 builder로 생성 → verify-layout + 오라클 → 1회-수리 허용 → `%pass` 리포트. 잠정 목표 **≥90%**(메모리: 프롬프트 수정 후 10/10). 실측 후 SC-006 확정.

**Rationale**: FR-018, SC-006. N=20은 카테고리 편향 없이 비율의 의미를 주는 최소 규모.

**Alternatives**: N=5 — 거부(비율 신뢰구간 너무 넓음). N=100 — 거부(OpenAI 비용/시간, 알파엔 과함).

## R7. 엔진 수정 정책

**Decision**: 게이트 통과를 막는 근본 원인이 렌더러/런타임일 때만 `레거시 렌더러 `(또는 runtime)를 수정하고, `엔진 수정 로그` 스타일(변경 파일·스코프·상태·호환성)로 로그를 남긴다. upstream(원본 엔진 레포) 반영 시 신규 브랜치·main push 금지·studio 빌드 무손상.

**Rationale**: 사용자 승인 + 헌법 II + FR-020. 기존 로그 컨벤션이 layout.ts 수정 사례로 확립돼 있음.

**Alternatives**: 엔진 절대 불변 — 거부(grid 히트 같은 결함은 엔진이 근본 원인일 수 있음).
