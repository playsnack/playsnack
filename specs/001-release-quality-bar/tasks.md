# Tasks v2 — 출시 품질 (PRD/QA-driven, ralph backlog)

**Feature**: `specs/001-release-quality-bar/` | **Spec**: [spec.md](./spec.md) | **Baseline**: [docs/project-spec.md](../../docs/project-spec.md) v2 | **PRDs**: [specs/apps/INDEX.md](../apps/INDEX.md)

> **v2 재작성:** 자동 게이트는 green이었으나 실제 폰에서 다수 앱이 깨짐. done의 기준을 각 앱
> **PRD의 QA 검증 시나리오 통과 + 시각(스크린샷) 검증**으로 바꿈. "에러 없음 = done" 금지.

## ralph-loop 완료 조건 (promise gate)
`<promise>ALL-APPS-QA-PASS</promise>` 는 **다음이 전부 참일 때만** 출력:
1. 아래 모든 task `[X]`,
2. 각 앱이 `specs/apps/<id>.md`의 QA 시나리오를 **시각 검증으로** 통과(capture-shots 스크린샷 + 오라클),
3. `node snack-server/tools/gate-all.mjs` green.
매 반복: 다음 미완료 task → 구현 → **앱 실행+스크린샷으로 실제 확인** → 통과 시에만 `[X]`.

경로: 엔진 `레거시 렌더러 `, 서버 `snack-server/src/`, 콘텐츠 `snack-server/data/bite/*.bite.json`, 도구 `snack-server/tools/`.

---

## Phase E — 시스템 결함 (P0, 다수 앱 동시 영향 · 먼저 한다)

- [X] E1 **컴포넌트 인스턴스 propValue 바인딩 런타임 재전파** — `scoreCard.value`/`optN.label`/`ResultBar.label` 등 인스턴스 prop 바인딩 변경이 확장된 `$props.X` sub-layer(텍스트/이미지)에 반영되도록 렌더러 수정(`레거시 렌더러 sceneRenderer.ts` applyBinding / 컴포넌트 확장 경로 + `eventBridge`/binding flush). 검증: counter-tap 점수, gacha 횟수, quiz-choseong 보기라벨이 **화면에서** 갱신. (C1 — ★최대 레버리지)
- [X] E2 **이미지 텍스처 리로드 — (코드리뷰 결과 이미 정상, 엔진 수정 불필요)** `makeImageNode.applyProp("imageUrl")`가 `loadUrl()`+loadId 가드로 이미 재로드함(layerFactory.ts:968). 월드컵 "사진 고정/고양이" 진짜 원인은 **q→/api/img 위키 해결 실패**(q="Jang Wonyoung IVE"인데 위키 문서명은 "Jang Won-young"). → **E4로 이관.** (C2 재분류)
- [X] E3 **레이아웃 collapse 수정** — `height:"fill"/"hug"` 컨테이너가 0으로 줄지 않게 yoga fill/hug 분배 보정(`레거시 렌더러 layout.ts`), + 절대좌표 자식을 담는 컨테이너는 비-flex로(콘텐츠 측). 검증: simon 패드/reaction 대기영역/whackamole 보드/colororder가 영역을 채움. (C3)
- [X] E4 **이미지 신뢰도 (★월드컵 핵심 — E2서 이관)** — `/api/img`가 명명 인물 q("Jang Wonyoung IVE")를 못 찾고 스톡(고양이)로 폴백하는 문제 수정: **위키백과 SEARCH API로 해결**(exact-title summary 대신 search→best title→thumbnail), 인물은 위키 only(없으면 이름 플레이스홀더, 랜덤/생성 금지), 사물은 위키→스톡→image-gen fallback, **yelp 등 워터마크 소스 배제**; **emoji/glyph는 이미지 검색 금지**(gacha 🪙→동전사진). content.mjs q는 위키 검색에 잘 걸리는 형태. `snack-server/src/index.mjs`(`/api/img` wikipediaUrl)+`content.mjs`. 검증: 장원영/카리나 카드=실제 본인 사진. (C2+C5/§5)
- [X] E5 **state-bound 대비 + 렌더-결과 오라클 보강** — lime-on-lime 잔여(mood-slider/wheel-menu pct) 해소; 오라클(`e2e-audit.mjs`)에 **렌더 텍스트/이미지가 실제 갱신되는지** 체크 추가(prop 바인딩·텍스처). (C4 + §7 보강)

## Phase A — 앱별 QA 통과 (각 `specs/apps/<id>.md` QA 시나리오 + 시각 검증)
> Phase E 이후 대부분의 점수/라벨/이미지 결함이 사라짐 → 잔여 레이아웃/콘텐츠/대비만 앱별로.

### broken (우선)
> **wheel 2종 정밀진단(2026-06-24):** ready 화면은 정상. spinning에서 휠이 과대/위치어긋나 HUD·우측 침범 + 섹터선 없음 + 포인터 분리. 휠 회전 자체는 작동. 수정: spin-state 휠 크기를 ready와 동일/중앙 pivot, 8섹터 구분선, 포인터를 휠 상단으로. (구조 재작업)
- [X] A-coop-cheer · [X] A-quiz-choseong · [X] A-race-trivia · [X] A-this-or-that · [X] A-wheel-menu · [X] A-worldcup-ideal · [X] A-wheel-fortune

### needs-fix
- [X] A-worldcup-bias · [X] A-worldcup-food · [X] A-balance-game · [X] A-best-award · [X] A-who-most-likely · [X] A-mood-vote · [X] A-quiz-ox · [X] A-test-mbti(채점 균형+코드↔닉네임 정합) · [X] A-test-animal · [X] A-game-whackamole · [X] A-game-reaction · [X] A-game-clicker · [X] A-game-simon · [X] A-game-colororder · [X] A-game-tap-target · [X] A-gacha-draw · [X] A-ladder-game · [X] A-counter-tap · [X] A-mood-slider · [X] A-race-tap · [X] A-race-reaction · [X] A-coop-click

## Phase V — 최종 검증
- [X] V1 전 앱 capture-shots 재촬영(29/29 montage clean) + 시각 통과 + 타임드게임 E7 인터랙티브 검증(colororder/clicker/reaction)
- [X] V2 `gate-all.mjs` **GREEN 3/3** — content-quality 29/29 · oracle 29/29 · multiclient-sim 10/10 (W2 닉네임게이트가 oracle /p/ 로드 차단하던 회귀 발견·수정: 홈/Create만 게이트, /p/ 직접진입은 게스트 닉 자동배정). gen-battery **90% of 20 (target 90%) PASS** (rateLimited:false = 진짜 측정, exit 0). → 4개 자동게이트 전부 green.
- [X] V3 랜딩 스크롤 버벅임 수정 — `Discover.tsx` 폴링 데이터 무변경 시 setState 스킵 + FLIP을 rank-order 변경시에만(3초마다 전체 getBoundingClientRect 강제 reflow 제거)

## Phase W — 신규 기능 (2026-06-24 EOD 사용자 요청)
- [X] W1 가로로 흐르는 ticker UI 제거 (`Discover.tsx`) — 사용자 "별로"
- [X] W2 닉네임 온보딩 + **브라우저별 독립 사용자** 인식 — `identity.ts`(anonId+nick), `NicknameGate.tsx`(첫방문 게이트+랜덤닉), App.tsx 게이트, LiveApp hello에 nick 전송. 검증: 첫방문 게이트→입력→Discover, 리로드 시 스킵(localStorage 지속).
- [X] W3 메인 **유저 랭크 리더보드** — 서버 userStore(anonId→nick, 실활동 +1/play·+2/record, data/users.json 지속) + `/api/leaderboard` + `/api/live`에 포함; Discover에 🏆 플레이어 랭킹 섹션(top5, 본인 (나) 라임 하이라이트, 🥇🥈🥉) + 🔥 지금 뜨는 게임. 검증: 2유저 실투표→라임두더지 2점#1/번개수달#2 스크린샷. (실데이터, 목업 아님)
- [X] W4 게임 소팅 = **제거된 적 없음(정정)**: Create 갤러리에 인기순/별점순/많이쓴순/최신순 + 카테고리 필터 그대로 존재(스크린샷 확인). 메인은 라이브 트렌드 자동정렬(설계). 메인 수동정렬 추가는 선택(미요청 시 보류).

## Phase X — 2차 제품 리뷰 피드백 (2026-06-25, 사용자 실사용)
**버그/명확한 수정:**
- [X] X1 글자 불필요한 줄바꿈 (hug 칩 "LIVE CO-OP"이 하이픈에서 깨짐) — layout.ts 측정 대문자 latin advance 0.66 보정. 검증: coop-click 1줄.
- [X] X2 ★CRITICAL 월드컵 이미지↔이름 불일치 — /api/img strict 모드(랜덤 폴백 금지→404), content.mjs q=정확 위키문서명(뷔→"V (singer)" 등), 월드컵 3종 strict 적용. 검증: 정국/뷔=실인물, 떡볶이/치킨=실음식 스크린샷. — 최애월드컵(장원영/카리나) + 야식월드컵, 이름 밑 얼굴이 안 맞음. /api/img(위키검색) 신뢰도 문제. 수정: 정확 해상 안 되면 출력 금지(플레이스홀더/로딩), 얼굴 한번 확인 후 출력.
- [X] X3 사진 못 불러올 때 = strict 404 → 이미지 투명 → 카드의 이름+어두운배경이 플레이스홀더로 보임(엉뚱사진 대신). (별도 스피너는 추후)
- [X] X4 game-simon ready 텍스트 정렬 — 중앙 정렬 일관화 + 카피 정돈(스크린샷 확인).
- [X] X5 game-simon → 이름 "색깔 기억하기"(nav+index.json) + 라운드마다 seq 새 랜덤(concat→map 재생성, 누적X), v1.14.0. 런타임 에러 없음 확인.
- [X] X6 게임 순위 30초마다 갱신 — /api/live trendOrderCache(30s 윈도우)로 랭크 순서 고정, 라이브 카운트는 계속 갱신.

- [X] X10 game-colororder: 2-col 그리드→세로 1열(slot 60, showCard top-align) + 매 라운드 sequence 새 랜덤(map 재생성, 시작+레벨업 4곳) + 카피 "위에서 아래로". 검증: 세로 3카드 랜덤색 스크린샷.

- [X] X11 wheel-fortune StatCard 높이 동일 — timerCard/speedCard height:118 고정 + 상태값 단축(빠름/감속/정지). 검증 스크린샷.
- [X] X12 wheel-fortune 룰렛 섹터 구분선 — 8 radial spoke(중앙 pivot rotation i*45) ready+spin 휠에 추가. 검증: 8섹터 시각 분리 스크린샷.
- [X] X13 wheel-fortune 멈춘 위치=결과 일치 — finalAngle 2160+finalIndex*45 → 2160-finalIndex*45 (라벨이 휠과 함께 회전하므로 부호 반전이 label[finalIndex]를 상단 포인터에 위치, result content[finalIndex]와 정합). 기하 분석 검증.
- [X] X14 counter-tap: off-by-one 수정(캡션 ${count+1}→${count}, 현재/누적/캡션 모두 일치) + 상태카드→경과 시간(startedAt+onFrame). 검증: 5탭→현재5/총5회/누적5회/경과3초 스크린샷.

- [X] X15 test-animal 흰 타원(resultAura 깨진 gradient rect) 제거. 검증 스크린샷.
- [X] X16 coop-cheer 제거 — coop-click과 메커닉 중복·의미약함, index.json(35→34)+파일 삭제. coop-click이 co-op tally 니치 커버. 카탈로그 품질 향상.

**제품 설계 결정 (사용자 확정):**
- [X] X7 월드컵 6종 테마앱 신설: worldcup-actor-m/actor-f/singer/talent/anime/uschar (worldcup-bias 복제+theme/title 변경, index.json 등록). content.mjs 테마별 정확위키q. 검증: 남자배우(이민호/공유)·일본캐릭터(나루토/루피) 이름↔사진 일치+제목 스크린샷.
- [X] X8 best-award→투표형 시상식: 서버 room.roster(닉네임 join/leave setVar 브로드캐스트) + 옵션을 roster[i] 멤버로 바인딩(빈 슬롯 숨김) + 제목 변경 + 투표 라임 하이라이트. 검증: 3닉네임 접속→멤버 후보 라이브 집계 스크린샷.
- [X] X9 mood-slider→단체 컨디션 멀티: 5 컨디션버튼(방전~최상)이 emitHostEvent vote(o0~o4)→votesByOption, 미터가 가중평균(0/25/50/75/100) 그룹 평균 표시(빈상태 가드), 'N명 참여', mode→multi. 검증: 3클라 0/100/50→평균 50 스크린샷.

## Phase Y — 신규 게임 추가 (2026-06-25 사용자 요청)
- [X] Y1 경마 게임(horse-race.bite.json 신규): 4마리 베팅(색상별 번호)→onFrame 말 이동→결승선 도달시 winner 판정→결과(우승말+내 베팅 적중여부)+다시 걸기(GhostButton). 검증: 베팅→레이스 이동→결과→다시 걸기 복귀 전체 루프 스크린샷.
- [X] Y2 블랙잭(blackjack.bite.json 신규): 딜 시작→2장씩 분배→히트/스테이→스테이시 딜러 onFrame 17까지 자동 드로우→버스트/숫자 비교 승패+다시. PrimaryButton 컴포넌트 def 추가(raw 컨테이너 column stretch 회피). ★E10 렌더러 수정: applyState 재구성 후 applied 캐시 clear(안 바뀐 바인딩값 재렌더). 검증: 딜→히트(13→20)→스테이→딜러24 버스트→나11 승리→다시→ready 전체 루프 스크린샷(+버스트 26 경로).
- [X] Y3 가위바위보(rps.bite.json 신규): 가위/바위/보 탭→봇 랜덤→승무패 판정→연승/최고 추적, index.json 등록. 검증: 바위 vs 가위→이겼다 1연승 스크린샷.

## Phase M — 멀티 (별도, 추후)
- [ ] M1 single 앱 중 멀티로 재밌는 것(각 PRD multiVariantIdea)을 **별도 멀티 앱**으로 신설(자동 변환 금지). single/multi 완전 분리.
