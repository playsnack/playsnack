<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 2.0.0
Bump rationale: MAJOR — Principle II redefined. The app model and engine are no
longer reused from an external engine; snackapp owns its engine (Bite) and
reuses maintained open-source libraries instead (decided 2026-10-07).

Modified principles:
  II.  (was) build on an external engine, reuse over rebuild
       → 자체 엔진 Bite, 관리되는 오픈소스 재사용 (Own Engine, Reuse Maintained OSS)
  V.   binding rule replaced by the Bite rule (state lives in variables only)
Modified sections:
  - 기술 & 보안 제약: stack + verification assets updated to Bite tooling
  - 개발 워크플로우: external-repo branch rule removed; engine-change log rule added
Templates: plan/spec/tasks templates need no change (principle names are not templated).
-->

# Social Snack-App Player Constitution

## Core Principles

### I. 실제-인터랙션 증명 (Proof-by-Real-Interaction) — NON-NEGOTIABLE

"되는 척" 금지. 어떤 스낵·생성앱·기능도 **실제 터치 플레이스루 증명** 없이는 "done"이라
부르지 않는다. 렌더 스크린샷, 격리된 런타임 로직 통과, "validate() 통과"는 증명이 아니다.

- 모든 스낵은 prod 빌드에서 `tools/e2e-audit.mjs` 오라클을 통과해야 한다(MUST): 도달 가능한
  모든 state에 응답하는(state/vars가 실제로 바뀌는) 탭 가능한 컨트롤이 있어야 하며,
  죽은/숨겨진/겹치는 버튼이 없어야 한다. 게이트는 실패 시 exit 1.
- "되는 척"이 의심되면 통과로 간주하지 않는다. 증거(오라클 PASS, 멀티클라이언트 sim,
  콘텐츠 체크 결과)가 없으면 미완으로 본다.

**Rationale**: 이 프로젝트는 과거에 "validate는 통과하는데 런타임에서 조용히 깨지는"
사례로 반복 실패했다. 실증 게이트가 유일한 신뢰원이다.

### II. 자체 엔진 Bite, 관리되는 오픈소스 재사용 (Own Engine, Reuse Maintained OSS)

앱 정의 = **Bite 문서**(`docs/bite-format.md`가 단일 소스). 엔진 = 3분할 —
런타임(`packages/bite`) · 레이아웃(`packages/bite-layout`, Yoga) · 렌더러(`packages/bite-pixi`, Pixi).

- 이미 풀린 어려운 문제(레이아웃·그리기·히트테스트·줄바꿈·스키마·물리·트윈)는 **관리되는
  오픈소스**에 맡긴다(MUST). 선정 기준: MIT/Apache/BSD(폰트는 OFL), 활발히 관리됨, **버전 고정**.
- 직접 만드는 것은 차별점뿐이다: 런타임·포맷·AI 생성·멀티플레이 연결.
- 외부(회사) 엔진 코드·명칭을 쓰지 않는다(MUST). 렌더러·런타임은 스펙만 보고 작성한다.
- 엔진을 고칠 땐 회귀 테스트를 함께 추가한다(MUST) — `pnpm bite:test` / `pnpm bite:check`.

**Rationale**: 엔진을 소유해야 공개·확장·검증이 가능하다(서버 = 실기기 레이아웃). 바퀴는
재발명하지 않되, 그 바퀴는 관리되는 오픈소스에서 가져온다.

### III. 휘발성 스낵 정체성 (Ephemeral by Design)

제품은 **순간적·휘발성·일회성**(snack)이다. Duolingo식 리텐션의 정반대다.

- micro-feel(즉시 플레이, 즉시 공유)은 취하되, **streak·league·XP-meta·계정·푸시 알림은
  거부**한다(MUST NOT).
- 피드백은 snappy해야 한다(MUST): 정답 공개·진행은 즉시, 데드타임 금지(한국 사용자는 성급함).
- 익명 세션이 기본.

**Rationale**: 정체성 혼동은 retention 기능을 끌어들여 제품을 무겁게 만든다. 휘발성이 차별점.

### IV. 콘텐츠 진실성 & 신선도 (Content Truth & Freshness)

콘텐츠는 **사실 정확·문화적으로 현재(KR)·비중복**이어야 한다.

- 실제 엔티티 + 올바른 이미지(MUST): 필러("민준/서연") 금지, 이미지는 Wikipedia-first → 관련성.
- 퀴즈는 **힌트↔정답↔보기가 정합**해야 한다(MUST): 초성 힌트와 정답 초성이 불일치하면 실패.
- 두 스낵이 동일 필러/보기 세트를 공유하지 않는다(MUST NOT) — 콘텐츠 품질·de-dup 체크로 강제.
- 동적 콘텐츠는 신선해야 한다: dataSource → `/api/content`(KST 정시 갱신), 실제 신조어 인지.

**Rationale**: audit이 드러낸 핵심 결함(엉터리 퀴즈, 누락 이미지, 어색한 랜덤)이 모두 이
원칙 위반이었다. 콘텐츠 정확성은 인터랙션 작동만큼 중요하다.

### V. 구조-우선 블록 모델 (Structure-First Blocks)

각 카테고리는 **손으로 만들어 검증한 단일 블록(구조)** + **AI/콘텐츠 슬롯(내용)**으로 구성한다.

- 구조와 콘텐츠를 분리한다(MUST): 레이아웃·인터랙션은 검증된 블록이 보장하고, 텍스트/이미지만
  슬롯으로 채운다.
- 생성·렌더 결과는 **화면 내(in-bounds)**, **겹침 없음**, **죽은/문자열 바인딩 없음**,
  한 화면에 맞아야 한다(MUST). 라이브 빌더는 overflow/dead-binding을 거부하고 재생성한다.
- 상태는 변수에만 둔다(MUST): 노드는 식으로 변수를 읽고, 노드를 직접 바꾸는 액션은 없다.

**Rationale**: 프롬프트가 레이아웃 엔진을 안 써서 overflow가 났던 실패(layout-engine-structure-first)
를 구조-우선 블록 라이브러리로 봉합했다. 신뢰성은 구조 고정에서 나온다.

### VI. 함께는 본질에 맞게 + 실증 (Multiplayer Fits the Snack, Proven)

멀티플레이어가 moat다. 단, "함께" 메커닉은 **스낵의 본질에 맞아야** 한다.

- together 메커닉은 vote/co-op tally/live-race/turn/spectate 중 앱 성격에 맞는 것을 쓴다(MUST);
  아무 앱이나 forced-vote로 강제하지 않는다(MUST NOT).
- 같은 링크 → 한 방, **라이브 상태가 클라이언트 간 한 프레임 내 동기화**되어야 한다(MUST):
  votes %, co-op total, leaderboard, reactions, participant count.
- 멀티플레이어 스낵은 **멀티클라이언트 sim(2–8 소켓)**으로 cross-client 동기화·무-desync·
  정확한 집계를 실증해야 한다(MUST) — 단일 클라이언트 오라클만으로는 불충분.

**Rationale**: 실시간 컨트랙트는 격리 검증됐지만 multi-client 부드러움은 미검증이다(spec E).
"함께"가 본질에 안 맞으면 휘발성 스낵의 매력을 해친다.

## 기술 & 보안 제약 (Technical & Security Constraints)

- **스택(고정)**: 앱 정의 = Bite 문서(`"bite": 1`); 엔진 = `@snack/bite` + `@snack/bite-layout`(Yoga)
  + `@snack/bite-pixi`(Pixi v8); 셸 = React; 실시간 = 로컬 Node 서버(Express + ws) + SQLite;
  AI 빌더 = OpenAI(gpt-5.5 계열).
- **AI 키는 서버사이드 전용**(MUST): 키는 사용자 제공, 클라이언트에 노출 금지.
- **세션은 익명**. 계정 시스템 없음(Principle III).
- **알파 배포 = LAN까지만**. 공개(터널/Fly)는 이후. 단, 회사 Mac은 admin 없음 → 폰 테스트는
  cloudflared quick tunnel 사용(LAN 아님).
- **검증 자산**: `tools/e2e-audit.mjs`(실증 오라클, `window.__bite`로 화면 위 컨트롤을 실제 터치),
  `tools/verify-layout.mjs`(validate + 헤드리스 플레이 + 페이즈별 레이아웃 린트),
  `tools/multiclient-sim.mjs`(VI), `tools/content-quality.mjs`(IV), `tools/gen-battery.mjs`(생성 신뢰성 %),
  `pnpm bite:test` / `pnpm bite:check`(엔진). 통합: `tools/gate-all.mjs`.

## 개발 워크플로우 & 품질 게이트 (Development Workflow & Quality Gates)

- **게이트(머지 전 통과 MUST)**:
  1. 변경된/영향받는 모든 스낵이 `tools/e2e-audit.mjs` 오라클 PASS (Principle I).
  2. 레이아웃: in-bounds, no overlap, no dead/string binding (`verify-layout`) (Principle V).
  3. 콘텐츠 변경 시: 진실성·정합·de-dup 체크 통과 (Principle IV).
  4. 멀티플레이어 변경 시: 멀티클라이언트 sim 통과 (Principle VI).
- **작업 방식(사용자 선호)**: 단언 말고 **실제 소스로 전제 검증**(file:line), 가정은 명시.
  "최종"은 배포·실현가능성·폴백까지 덮였을 때만.
- **엔진 규칙**: 엔진 변경은 회귀 테스트 동반, 외부 엔진 코드·명칭 금지 (Principle II).
- spec-driven 흐름: constitution → specify → plan → tasks → implement. 각 단계 산출물은
  `.specify/`(또는 `specs/`)에 기록한다.

## Governance

- 이 헌법은 다른 관행보다 **우선**한다. 충돌 시 헌법이 이긴다.
- **개정 절차**: 변경은 (a) 이유 문서화, (b) 영향받는 템플릿(plan/spec/tasks)·게이트 동기화,
  (c) 버전 범프와 함께 커밋. NON-NEGOTIABLE 원칙(I)의 약화는 명시적 사용자 승인 필요.
- **버전 정책(semver)**: MAJOR = 원칙 제거/하위호환 깨는 재정의; MINOR = 원칙/섹션 추가 또는
  실질 확장; PATCH = 문구·오타·비의미 정정.
- **준수 검토**: 모든 변경(PR/리뷰)은 위 품질 게이트로 헌법 준수를 검증한다. 복잡성은 정당화돼야
  한다. 런타임 개발 가이드는 `CLAUDE.md`와 `docs/project-spec.md`를 따른다.

**Version**: 2.0.0 | **Ratified**: 2026-06-24 | **Last Amended**: 2026-10-07
