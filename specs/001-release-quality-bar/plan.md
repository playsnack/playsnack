# Implementation Plan: 출시 품질 바 (Release Quality Bar)

**Branch**: `feat/structure-first-templates-dynamic` | **Date**: 2026-06-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-release-quality-bar/spec.md`

## Summary

기존 ~29 스낵 + 채팅→앱 생성 파이프라인을 출시 품질로 끌어올린다. 접근: **자동 품질 게이트(검증 인프라)를 완성**하고, **그 게이트를 통과하도록 콘텐츠/스낵/엔진을 고친다**. 게이트 = (1) 실제-터치 오라클(전수 PASS), (2) 콘텐츠 품질·dedup 체크[신규], (3) 멀티클라이언트 sim[신규], (4) 생성 배터리[신규], (5) 레이아웃 검증[기존]. "되는 척" 없이 모든 done은 게이트 증거로만 인정(헌법 I).

## Technical Context

**Language/Version**: Node.js ESM(`.mjs`), TypeScript(`.mts`/`.tsx`), pnpm workspace (`vendor/* + snack-player + snack-server`)

**Primary Dependencies**: `레거시 런타임`(레거시 런타임, COMMIT 고정), `레거시 렌더러`(레거시 렌더러, Pixi + yoga-wasm-web), React + Vite(snack-player), Express + `ws`(snack-server), Playwright(오라클), OpenAI(builder, 서버사이드)

**Storage**: SQLite + 파일 — `snack-server/data/bite/*.bite.json`(29) + `index.json`, `data/apps`, `data/votes`. 실시간 룸 상태는 인메모리(`room(slug)`)

**Testing**: 기존 `tools/e2e-audit.mjs`(Playwright 실제-터치 오라클), `tools/verify-layout.mts`, `tools/audit-interaction.mjs`. **신규**: 멀티클라이언트 sim(ws 2–8 소켓), 콘텐츠 품질·dedup 체커, 생성 배터리(N 프롬프트→생성→오라클→%)

**Target Platform**: 모바일 웹(iOS Safari 등) + 로컬 Node 서버. 알파 배포 = LAN/cloudflared 터널

**Project Type**: web (frontend `snack-player` + backend `snack-server`) + vendored 엔진(`vendor/`)

**Performance Goals**: 라이브 상태 동기화 = 사용자 체감 즉시(한 프레임 ~16ms 수준); 싱글 피드백 snappy(데드타임 0)

**Constraints**: in-bounds 레이아웃·무overlap·무dead/string-binding; AI 키 서버사이드 전용; 익명 세션; 레거시 엔진 버전·커밋 고정; 엔진 수정 시 로그 md 기록

**Scale/Scope**: ~29 템플릿 + 생성 파이프라인; 룸당 동시 클라 2–8

## Constitution Check

*GATE: Phase 0 전 통과 필수. Phase 1 설계 후 재확인.*

| 원칙 | 게이트/준수 | 상태 |
|------|------------|------|
| I. 실제-인터랙션 증명 (NON-NEGOTIABLE) | 전 스낵 e2e-audit PASS, done은 증거로만 | ✅ 계획이 오라클 전수화로 강제 |
| II. 레거시 엔진 재사용, 엔진수정 로그 | 모델/엔진 재발명 0; 엔진 수정 시 `엔진 수정 로그` 기록 + upstream 규칙 | ✅ FR-020 준수 |
| III. 휘발성 정체성 | retention 기능(streak/계정/푸시) 추가 없음 — 본 feature는 검증·수정만 | ✅ 위반 없음 |
| IV. 콘텐츠 진실성·신선도 | 콘텐츠 품질·dedup 체크[신규] + audit 5결함 수정 | ✅ 계획됨 |
| V. 구조-우선 블록 | verify-layout 게이트(in-bounds/overlap/binding) | ✅ 기존+강화 |
| VI. 함께는 본질·실증 | 멀티클라 sim[신규], forced-vote 강제 금지 | ✅ 계획됨 |

**위반 없음** → Complexity Tracking 비움. (Phase 1 설계 후 재확인: 신규 도구 3종은 기존 tools/ 패턴을 따르므로 새 아키텍처 도입 없음 → 재확인 통과.)

## Project Structure

### Documentation (this feature)

```text
specs/001-release-quality-bar/
├── plan.md              # 이 파일
├── spec.md              # /speckit.specify 산출물
├── research.md          # Phase 0 — 4개 open 근본원인, 가독성 기준, sim/배터리 방식
├── data-model.md        # Phase 1 — 게이트 리포트 스키마 + 스낵/콘텐츠 모델
├── quickstart.md        # Phase 1 — 전 게이트 end-to-end 실행 가이드
├── contracts/           # Phase 1 — 신규 체크 도구 + 기존 실시간 WS 컨트랙트
│   ├── oracle-report.md
│   ├── content-quality.md
│   ├── multiclient-sim.md
│   ├── gen-battery.md
│   └── realtime-ws.md
└── checklists/requirements.md
```

### Source Code (repository root)

```text
vendor/
├── 레거시 런타임/        # 레거시 런타임 (COMMIT 고정) — 실시간 훅
└── 레거시 렌더러/       # Pixi 렌더러 + layout.ts (yoga flex / 커스텀 grid)

snack-server/            # @snack/server (Express + ws + SQLite)
├── src/
│   ├── index.mjs        # HTTP(/api/*) + WS(/ws): votesByOption/coopTotal/leaderboard/reactions/participants 브로드캐스트
│   ├── templates.mjs    # 템플릿 로드/제공
│   ├── builder.mjs      # chat→레거시 엔진 생성 (componentLibrary 주입)
│   ├── prompt.mjs       # 구조-우선 프롬프트
│   ├── componentLibrary.mjs  # iOS HIG 컴포넌트 정의
│   └── content.mjs      # /api/content 동적 콘텐츠
├── data/bite/*.bite.json (29) + index.json
└── tools/
    ├── e2e-audit.mjs        # [기존] 실제-터치 오라클 (A,C)
    ├── verify-layout.mts    # [기존] valid/runnable/fit/badBindings (V,F)
    ├── audit-interaction.mjs# [기존] dead 바인딩
    ├── content-quality.mjs  # [신규] 진실성·정합·가독성·dedup (B)
    ├── multiclient-sim.mjs  # [신규] 2–8 소켓 동기화·desync·집계 (E)
    └── gen-battery.mjs      # [신규] N 프롬프트→생성→오라클→%pass (F)

snack-player/            # @snack/player (React + Vite + Pixi)
└── src/{App,Discover,BitePlayer,LiveApp,CreateApp}.tsx
```

**Structure Decision**: 기존 pnpm 워크스페이스 구조 유지. 신규 작업은 (a) `snack-server/tools/`에 게이트 3종 추가, (b) `data/bite/*.bite.json` + `content.mjs`/`componentLibrary.mjs` 콘텐츠/구조 수정, (c) 필요 시 `레거시 렌더러 `(또는 runtime) 엔진 수정 + 로그. 새 패키지·새 모델 도입 없음(헌법 II).

## Complexity Tracking

> Constitution Check 위반 없음 — 비움.
