# Feature Specification: 출시 품질 바 (Release Quality Bar) — A–G 전 기준 충족

**Feature Branch**: `feat/structure-first-templates-dynamic` (spec dir: `specs/001-release-quality-bar`)

**Created**: 2026-06-24

**Status**: Draft · **v2 갱신 2026-06-24**

**Input**: User description: "제품(Social Snack-App Player)의 전체 품질을 출시 가능한 수준으로 끌어올린다 — docs/project-spec.md §4의 수용 기준 A–G 전부를 testable 요구사항으로 만족."

> **v2 갱신 (실제 폰 QA 후):** 자동 게이트(A·B·E·F)는 green이었으나 실제 렌더/경험이 다수 깨짐
> (게이트가 "바인딩 값/에러없음"만 보고 "화면 렌더 결과"를 안 봄). 그래서 done의 기준을
> **앱별 PRD의 QA 검증 시나리오 통과 + 시각(스크린샷) 검증**으로 강화한다.
> - 앱별 PRD: `specs/apps/<id>.md` (29개), 인덱스 `specs/apps/INDEX.md`. **PRD QA 통과 = 그 앱 done.**
> - 시스템 결함 C1~C5(컴포넌트 prop 바인딩 재전파, 이미지 텍스처 리로드, 레이아웃 collapse, 대비,
>   이미지/emoji 오용)는 다수 앱 동시 영향 → P0. 상세: `docs/project-spec.md` v2 §4·§5.
> - single/multi 완벽 분리; 인기 포맷 로직 100% 모방+우리 콘텐츠; 이미지 신뢰도 정책(§5).
> - 백로그/실행: `tasks.md` v2, implement = ralph-loop(앱별 QA 통과까지 자율 반복).
> 아래 v1 FR/SC(A–G)는 여전히 유효하며 v2가 이를 "렌더 결과+앱별 QA"로 강화한 것이다.

---

## User Scenarios & Testing *(mandatory)*

각 스토리는 독립적으로 테스트 가능한 품질 슬라이스다. 하나만 구현해도 그만큼 제품이 "출시 가능"에 가까워진다.

### User Story 1 - 어떤 스낵을 열어도 진짜로 작동한다 (Priority: P1)

플레이어가 홈에서 아무 스낵이나 탭해 들어가면, 도달하는 모든 화면에 **응답하는** 컨트롤이 있다. 죽은 버튼, 숨겨진 버튼, 겹쳐서 못 누르는 버튼이 없다. 누르면 상태/값이 실제로 바뀐다.

**Why this priority**: 헌법 원칙 I("되는 척" 금지)의 핵심. 작동하지 않는 스낵은 다른 어떤 품질보다 먼저 치명적이다. 현재 25/29만 통과(4개 open).

**Independent Test**: 모든 스낵을 prod 빌드에서 실제-터치 플레이스루(오라클)로 돌려 100% PASS인지 확인. 특히 open 4종(race-trivia, game-tap-target, game-reaction, race-reaction)이 PASS로 바뀌는지.

**Acceptance Scenarios**:

1. **Given** 출시 대상 스낵 전체, **When** 각각을 실제-터치 오라클로 끝까지 플레이, **Then** 모든 도달 state에서 컨트롤이 응답하고 죽은/숨겨진/겹친 컨트롤이 0개다.
2. **Given** race-trivia / game-tap-target / game-reaction / race-reaction, **When** 오라클 실행, **Then** 4종 모두 PASS(이전 실패 원인 = 그리드 내 컴포넌트 히트, 작은 타깃 히트영역, wait-then-flip false-fail이 해소됨).
3. **Given** 어떤 스낵이든, **When** "done"으로 표시하려 할 때, **Then** 오라클 PASS 증거 없이는 done으로 인정되지 않는다.

---

### User Story 2 - 콘텐츠가 정확하고, 읽히고, 중복이 없다 (Priority: P1)

플레이어가 보는 텍스트·이미지가 사실 정확하고, 한국 문화 맥락에 맞고, 화면에서 또렷이 읽히며, 스낵끼리 같은 보기/필러를 재탕하지 않는다.

**Why this priority**: 인터랙션은 대체로 도는데(audit) 콘텐츠 정확성·가독성·이미지가 진짜 문제였다. 헌법 원칙 IV 위반들이 그대로 드러났다.

**Independent Test**: audit이 지목한 5개 결함을 고친 뒤, 콘텐츠 품질·정합·de-dup 자동 체크를 전 스낵에 돌려 위반 0건인지 확인.

**Acceptance Scenarios**:

1. **Given** 투표 3종, **When** 선택 행을 본다, **Then** 라벨이 배경 대비 충분해 또렷이 읽힌다(라임 글자 on 라임 바 같은 저대비 없음).
2. **Given** 초성 퀴즈, **When** 문항을 본다, **Then** 힌트 ↔ 정답 ↔ 보기의 초성/의미가 정합한다(예: 힌트가 가리키는 정답의 초성과 정답 초성이 일치, 보기 모두 같은 초성 패턴).
3. **Given** 두더지(및 보드형 게임), **When** 보드를 본다, **Then** 구멍/타깃이 배경과 구분되어 보인다(거의 검정으로 묻히지 않음).
4. **Given** worldcup 전 종목(이상형·음식·아이돌 등), **When** 후보를 본다, **Then** 실제 엔티티 + 올바른 이미지가 표시된다("민준/서연" 류 필러·빈 이미지 없음).
5. **Given** 가챠/룰렛 등 랜덤, **When** 결과/보기를 본다, **Then** 이미지·텍스트가 맥락에 맞고 어색하지 않다.
6. **Given** 출시 대상 스낵 전체, **When** de-dup 체크 실행, **Then** 두 스낵이 동일한 보기 세트/필러를 공유하지 않는다.

---

### User Story 3 - 게임이 막힘없이 한 바퀴 돈다 (Priority: P2)

게임형 스낵은 start → 시간제 플레이 → 종료 조건 → 결과 → 다시하기의 완전한 루프가 매끄럽게 돈다.

**Why this priority**: 게임 카테고리의 본질. 루프가 끊기면 스낵이 "데모"처럼 느껴진다. 핵심 게임은 검증됐고 reaction/tap-target만 확인 남음.

**Independent Test**: 각 게임을 오라클로 플레이 — 타이머가 카운트다운하고, 점수가 갱신되고, 조각이 탭마다 반응하고, 종료 후 결과가 뜨고, 다시하기가 동작하는지.

**Acceptance Scenarios**:

1. **Given** 게임형 스낵, **When** 시작, **Then** 타이머가 실제로 흐르고 종료 조건에서 결과 화면으로 전이한다.
2. **Given** reaction/타이밍 게임(wait-then-flip), **When** 오라클 실행, **Then** 정상 동작이 false-fail로 판정되지 않는다.
3. **Given** 결과 화면, **When** 다시하기, **Then** 초기 상태로 돌아가 재플레이된다.

---

### User Story 4 - 여러 명이 같은 방에서 실시간으로 연결된다 (Priority: P2)

여러 사람이 같은 링크를 열면 한 방에 모이고, 라이브 상태(투표 %, 협동 합계, 리더보드, 리액션, 참가자 수)가 클라이언트 간 즉시 동기화된다. "함께"는 그 스낵의 본질에 맞는 방식이다.

**Why this priority**: 멀티플레이어가 차별점(moat). 단, 실시간 컨트랙트가 격리 검증만 됐고 multi-client 부드러움은 미검증.

**Independent Test**: 멀티플레이어 스낵마다 2–8개 동시 클라이언트를 띄워 cross-client 동기화·무-desync·정확한 집계를 자동 확인.

**Acceptance Scenarios**:

1. **Given** 멀티플레이어 스낵 1개 + 동시 클라이언트 2–8, **When** 한 클라가 투표/탭/점수 갱신, **Then** 모든 클라가 같은 라이브 값을 즉시(한 프레임 수준) 본다.
2. **Given** 동시 N명, **When** 재투표/점수 변동 반복, **Then** 집계가 정확하고 desync가 없으며 참가자 수가 맞다.
3. **Given** 스낵의 성격, **When** "함께" 메커닉을 정한다, **Then** vote/co-op/live-race/turn/spectate 중 본질에 맞는 것이 쓰이고, 아무 앱이나 forced-vote로 강제되지 않는다.

---

### User Story 5 - 채팅으로 만든 새 앱이 첫 시도에 제대로 나온다 (Priority: P3)

사용자가 채팅으로 새 스낵을 만들면, 생성된 앱이 valid·runnable·화면 내(in-bounds)·겹침 없음·죽은 바인딩 없음이고, 1회 또는 1회-수리로 같은 오라클을 통과한다.

**Why this priority**: 제품의 "코드 몰라도 만든다" IR. 단, 생성 신뢰성이 %로 측정된 적 없음.

**Independent Test**: N개 프롬프트를 생성 배터리에 넣어 → 생성 → 오라클 → %pass를 리포트.

**Acceptance Scenarios**:

1. **Given** 신규 프롬프트, **When** 생성, **Then** 결과 앱이 in-bounds·무overlap·무dead/string-binding·한 화면에 맞다.
2. **Given** 첫 생성이 게이트 위반, **When** 라이브 빌더가 거부·재생성, **Then** 1회 수리 내 통과한다.
3. **Given** 생성 배터리(N 프롬프트), **When** 전체 실행, **Then** %pass가 목표치 이상으로 리포트된다.

---

### Edge Cases

- 동적 콘텐츠(`/api/content`)가 비거나 지연될 때 — 스낵은 깨지지 않고 폴백 콘텐츠로 동작해야 한다.
- 이미지 소스(Wikipedia 등)가 이미지를 못 줄 때 — 빈 칸/깨진 이미지 대신 적절한 폴백.
- 멀티플레이어에서 클라가 중간에 들어오거나 끊길 때 — 참가자 수·집계가 정확히 갱신.
- 생성 앱이 1회 수리 후에도 게이트 위반일 때 — done으로 인정하지 않고 실패로 리포트.
- 오라클이 정상 동작을 false-fail 하는 경우 — 오라클 자체를 고쳐야 하며, 스낵을 억지로 통과시키지 않는다.

## Requirements *(mandatory)*

### Functional Requirements

**작동 & 증명 (A, G)**
- **FR-001**: 출시 대상 모든 스낵은 prod 빌드 실제-터치 플레이스루(오라클)를 PASS해야 한다(MUST): 도달 가능한 모든 state에 응답하는 컨트롤, 죽은/숨겨진/겹친 컨트롤 0개.
- **FR-002**: race-trivia, game-tap-target, game-reaction, race-reaction 4종을 PASS로 만들어야 한다(MUST).
- **FR-003**: 어떤 산출물도 실제-인터랙션 증거(오라클 PASS / 멀티클라 sim / 콘텐츠 체크 결과) 없이 "done"으로 표시되지 않는다(MUST NOT).

**콘텐츠 (B)**
- **FR-004**: 화면의 모든 텍스트 라벨은 배경 대비 가독성 기준을 만족해야 한다(MUST) — 저대비(라임 on 라임) 금지.
- **FR-005**: 퀴즈는 힌트·정답·보기의 정합을 만족해야 한다(MUST) — 초성 퀴즈는 힌트가 가리키는 정답과 보기의 초성 패턴이 일치.
- **FR-006**: 보드형 게임의 타깃/구멍은 배경과 시각적으로 구분되어야 한다(MUST).
- **FR-007**: worldcup·랜덤 등 엔티티 기반 콘텐츠는 실제 엔티티 + 올바른 관련 이미지를 써야 한다(MUST) — 필러 이름·빈 이미지 금지.
- **FR-008**: 두 스낵이 동일 보기 세트/필러를 공유하지 않아야 한다(MUST NOT) — de-dup으로 강제.
- **FR-009**: 콘텐츠 진실성·정합·가독성·de-dup을 자동 검사하는 콘텐츠 품질 체크가 있어야 한다(MUST).

**게임 루프 (C)**
- **FR-010**: 게임형 스낵은 start → timed play → end-on-condition → result → replay 루프를 완성해야 한다(MUST): 타이머 카운트다운, 점수 갱신, 탭당 조각 반응, 다시하기 동작.
- **FR-011**: 오라클의 게임-루프 체크는 wait-then-flip(reaction) 게임을 false-fail 하지 않아야 한다(MUST).

**싱글 (D)**
- **FR-012**: 싱글플레이어 로직은 서버 의존 없이 동작하고 즉시 피드백(snappy)을 줘야 한다(MUST) — 정답 공개·진행 즉시, 데드타임 금지.

**멀티 (E)**
- **FR-013**: 멀티플레이어 스낵은 같은 링크 → 한 방, 라이브 상태(투표%/coop/leaderboard/reactions/참가자수)가 클라이언트 간 한 프레임 수준으로 동기화돼야 한다(MUST).
- **FR-014**: 멀티플레이어 스낵마다 2–8 동시 클라이언트 시뮬레이션으로 cross-client 동기화·무-desync·정확 집계를 검증해야 한다(MUST).
- **FR-015**: "함께" 메커닉은 스낵 본질에 맞는 유형(vote/co-op/live-race/turn/spectate)을 써야 하며, forced-vote 강제는 금지(MUST NOT).

**신규 생성 (F)**
- **FR-016**: 신규 생성 앱은 valid·runnable·in-bounds·무overlap·무dead/string-binding·한 화면 fit이어야 한다(MUST).
- **FR-017**: 라이브 빌더는 게이트 위반(overflow/dead-binding)을 거부하고 재생성해야 하며, 생성 앱은 템플릿과 같은 오라클을 통과해야 한다(MUST).
- **FR-018**: 생성 신뢰성을 측정하는 생성 배터리(N 프롬프트 → 생성 → 오라클 → %pass)가 있어야 한다(MUST).

**검증 인프라 (횡단)**
- **FR-019**: 다음 게이트가 머지 전 통과 기준으로 존재해야 한다(MUST): 실제-터치 오라클(A), 레이아웃 검증(V/F), 콘텐츠 품질·dedup(B), 멀티클라이언트 sim(E), 생성 배터리(F).
- **FR-020**: 레거시 엔진 엔진/런타임/렌더러 결함이 게이트 통과를 막는 근본 원인일 때는 엔진을 수정할 수 있다(MAY). 수정 시 **엔진 수정 로그 md**(`엔진 수정 로그` 스타일: 변경 파일·스코프·상태·호환성)에 변경을 기록해야 하고(MUST), 원본 엔진 레포 원본을 함께 고칠(upstream) 땐 신규 브랜치·main push 금지·studio 빌드 무손상을 지켜야 한다(MUST).

### Key Entities

- **스낵(Snack/Template)**: 하나의 인터랙티브 미니앱. 구조(검증된 블록) + 콘텐츠(슬롯). 카테고리(worldcup/vote/quiz/psych/game/random/counter)에 속함.
- **콘텐츠 슬롯**: 스낵의 텍스트/이미지/보기 — AI/`/api/content`로 채워지고 품질·dedup 검사 대상.
- **라이브 룸**: 스낵의 공유 실시간 방. 참가자·집계 상태(votesByOption/coopTotal/leaderboard/reactions) 보유.
- **품질 게이트**: 산출물의 통과/실패를 판정하는 자동 검사 (오라클/레이아웃/콘텐츠/멀티클라/생성배터리).
- **엔진 수정 로그**: 레거시 엔진 엔진을 고칠 때 변경 내역을 기록하는 md (`엔진 수정 로그` — 벤더링된 렌더러 수정 기록 + upstream 규칙).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 출시 대상 스낵의 **100%**가 실제-터치 오라클 PASS (현재 25/29 → 전수).
- **SC-002**: 콘텐츠 품질 체크 위반 **0건** — 저대비 라벨 0, 힌트↔정답 불일치 0, 필러/빈 이미지 0.
- **SC-003**: 보기 세트/필러 중복 **0쌍** (de-dup).
- **SC-004**: 게임형 스낵의 **100%**가 완전 루프(start→play→end→result→replay) 동작; 오라클 false-fail **0건**.
- **SC-005**: 멀티플레이어 스낵의 **100%**가 2–8 동시 클라이언트에서 desync **0**, 집계 오차 **0**, 라이브 갱신이 사용자 체감상 즉시(한 프레임 수준).
- **SC-006**: 신규 생성 배터리에서 **≥90%**가 1회 또는 1회-수리로 오라클 PASS (목표치; 측정 후 조정).
- **SC-007**: 위 모든 게이트가 자동화돼 머지 전 실행 가능하며, 실패 시 명확히 리포트(되는 척 0).

## Assumptions

- **스코프 = 기존 ~29 스낵 세트 + 생성 파이프라인의 출시 품질화.** 새 콘텐츠 카테고리 추가는 이 feature 범위 밖(별도 feature).
- 동시 클라이언트 "smooth" 기준은 2–8 소켓(project-spec E). 그 이상 대규모 부하 테스트는 범위 밖.
- 생성 신뢰성 목표 90%는 기존 측정(프롬프트 수정 후 10/10 성공) 근거의 잠정치 — 배터리 실측 후 확정.
- 배포 범위는 알파(LAN/터널)까지. 공개 배포 인프라는 범위 밖.
- "라벨 가독성 기준"은 디자인 토큰(블랙+라임)을 유지하되 대비를 확보하는 방향 — 새 디자인 시스템 도입 아님.
- 검증 자산 일부(`e2e-audit.mjs`, `verify-layout.mts`, 정밀-탭 하네스)는 이미 존재; 멀티클라 sim·콘텐츠 품질/dedup 체크·생성 배터리는 신규 구축.
