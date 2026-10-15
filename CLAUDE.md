# PlaySnack — 프로젝트 컨텍스트 (새 세션용)

## 한 줄 요약
코드 몰라도 채팅으로 인터랙션 앱(게임·투표·퀴즈·월드컵…)을 만들고, 숏폼 링크로 실시간 공유하는 "Social Snack-App Player".
앱은 자체 엔진 **Bite**의 JSON 문서로 정의되고, 모바일 웹에서 재생된다.

## 구조
| 위치 | 역할 |
|---|---|
| `packages/bite` | **런타임** — vars·phases·식(jsep 화이트리스트)·액션·호스트 연결. 렌더 의존 0, Node/브라우저 공용 |
| `packages/bite-layout` | **레이아웃** — 문서 펼치기 + Yoga(flex) 배치 + 폰트 메트릭 측정 + 히트테스트·레이아웃 린트. Node에서도 동일 결과 |
| `packages/bite-pixi` | **렌더러** — Pixi v8로 그리기·탭·스크롤 |
| `snack-player` | React 앱: 홈(Discover) · 공유 링크 `/p/:slug`(LiveApp) · 만들기(CreateApp, 직접 텍스트 편집) · 개발 경로 `?bite=<name>` |
| `snack-server` | Express+ws: 템플릿/앱 API, 실시간 방(`emit`→서버→`setVar` 브로드캐스트), 동적 콘텐츠 `/api/content`, AI 빌더 |
| `snack-server/data/bite` | 공식 템플릿 44개(`*.bite.json`) + `index.json` |

포맷 스펙: `docs/bite-format.md` (이게 Bite의 단일 소스).

## 핵심 결정 (확정)
- 엔진 = 3분할(런타임 / Yoga 레이아웃 / Pixi 렌더러). 이미 풀린 어려운 문제는 관리되는 오픈소스(MIT/Apache/BSD, 버전 고정)에 맡기고 런타임·포맷·AI 생성·멀티 연결만 직접 만든다.
- 상태는 변수에만 — 노드는 식으로 변수를 읽는다. 숨긴 노드는 레이아웃에서 빠진다.
- 본문 폰트 Pretendard·픽셀 폰트 Galmuri11(둘 다 OFL, 자체 호스팅) — 폰트 메트릭을 엔진에 내장해 서버 검증 = 실기기 레이아웃.
- AI 빌더 = OpenAI(서버사이드 키) → Bite 문서 생성 → validate + 헤드리스 플레이 + 레이아웃 린트 → 수리 루프. 가장 가까운 검증된 템플릿을 구조 예시로 사용(structure-first).
- 디자인 시스템 "미니 블록 아케이드": 검정+라임, 라임=단일 영웅색, 픽셀 폰트는 제목·점수만(22px 미만 한글 금지). 토큰 SSOT = `snack-server/src/tokens.mjs`.

## 실행
```bash
pnpm install
pnpm server:dev          # :4399
pnpm player:dev          # :5290 (개발) — 또는 pnpm player:build 후 서버가 서빙
```

## 품질 게이트 ("되는 척" 금지 — 게이트 증거 없이는 done 아님)
```bash
pnpm bite:test                                  # 엔진 단위 테스트
node snack-server/tools/gate-all.mjs            # 전체(서버 떠 있으면 오라클·멀티 sim 포함)
node snack-server/tools/gate-all.mjs --battery  # + AI 생성 배터리(OpenAI 키 필요)
pnpm bite:check                                 # 브라우저 레이아웃 일치·탭·스크롤 (player:dev 필요)
```

## 작업 방식 (사용자 선호)
- 단언 말고 **실제 소스로 전제 검증**(file:line). 가정은 명시. "최종"은 배포/실현가능성/폴백까지 덮였을 때만.
- 구조적/큰 작업은 계획부터 세워 논의 후 진행. 결정 요청은 1개 추천 + 단순 확인.

<!-- SPECKIT START -->
Active spec-driven work: **출시 품질 바 (Release Quality Bar)** — `specs/001-release-quality-bar/`.
- Constitution: `.specify/memory/constitution.md` (v1.0.0, 6 principles; I="되는 척" 금지 NON-NEGOTIABLE).
- Plan (tech stack/architecture): `specs/001-release-quality-bar/plan.md`.
- Spec + acceptance criteria A–G: `specs/001-release-quality-bar/spec.md` (+ docs/project-spec.md §4).
- Quality gates (run guide): `specs/001-release-quality-bar/quickstart.md`.
<!-- SPECKIT END -->
