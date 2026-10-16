# PlaySnack — Project Flow & Quality Spec (the "done" definition) · v2 (2026-06-24 재작성)

> **현재 역할:** 이 문서는 2026-06-24 기준 품질 기준과 spec-driven 작업 방식의 참고자료다. 현재 제품 계획의 원본은 `docs/business-plan-2026.md`, 실제 실행 상태는 GitHub Project / Issues다. 여기의 항목을 바로 작업하지 말고, 필요한 경우 최신 범위와 검증 기준을 Issue로 다시 작성한다.

이 문서는 spec-driven 작업(`/speckit-specify`)의 baseline이자 "good"의 단일 기준이다.
**v2 재작성 이유:** 자동 게이트(oracle/layout/sim/battery)는 전부 green이었는데 실제 폰
테스트에서 다수 앱이 여전히 깨져 있었다. 원인 = 게이트가 *"에러 없음 / 바인딩 값이 바뀜"*
만 봤고 *"화면에 제대로 렌더되고 의도한 경험이 되는가"* 를 안 봤다. 그래서 v2는
**앱별 PRD + QA 검증 시나리오 + 시각(스크린샷) 검증**을 done의 정의로 삼는다.

---

## 1. 제품 (무엇인가)
빠르고 **휘발성(ephemeral)** 인 소셜 "스낵" 플랫폼 — 즉석에서 플레이하고 공유하는 bite-size
인터랙티브 미니앱(투표/퀴즈/월드컵/탭게임/리액션). 소비 우선. **소비자 >> 창작자** — 그래서
**앱 하나하나가 최고 품질**이어야 하고, 이 템플릿들은 AI가 새 앱을 생성할 때의 **본보기**라
모범이어야 한다. 레거시 엔진 엔진(선언적 상태머신 + flex 렌더러) + 실시간 서버(Express/WS) 위에 구현.

**설계 원칙 (v2 확정):**
- **검증된 인기 포맷 100% 모방**: 각 앱은 그 장르의 *이미 대박난* 게임/앱의 **로직·룰·구조**를
  그대로 따른다(예: 이상형 월드컵, 표준 reflex-test, 유명 초성게임). 콘텐츠는 새로 잘 채우고
  디자인은 우리 톤(블랙 #0b0c0e + 라임 #d9ff00). **구조는 같되 콘텐츠·비주얼은 우리 것.**
- **혼자/여럿 완벽 분리**: 각 앱은 본질적으로 single 또는 multi 하나로 확정. 애매한 하이브리드
  금지. 싱글을 함부로 멀티로 바꾸면 깨진다 — multi는 *별도 앱*으로 신설(고도화), 자동 변환 금지.
- **snappy**: 데드타임 0, 즉시 피드백.

## 2. 파이프라인 (흐름)
1. **Discover(홈) = 라이브 아케이드 대시보드** — 실시간 stats 카드(🟢 N명·🔥 랭크·⭐), FLIP
   재정렬. (현재 결함: 3초 폴링이 전체 리렌더 → 스크롤 중 깜빡임. 수정 대상.)
2. **Play(`/p/tpl-<id>`)** — 풀스크린 레거시 엔진 플레이어. 각 템플릿은 canonical 공유 룸.
3. **Create(`/create`)** — chat → AI 빌더(gpt-5.5) → 레거시 엔진 → 렌더 → 저장/공유.
4. **Content** — (a) **구조** = 손으로 만들어 검증한 블록(카테고리별 1개), (b) **콘텐츠** = 슬롯을
   AI/`/api/content`(KST-hourly 캐시지만 **mount 시 즉시 fetch**, "정시"는 캐시 갱신 주기일 뿐)로
   채움 + 이미지 `/api/img`.
5. **실시간 컨트랙트** — votesByOption / coopTotal / leaderboard / reactions / participants.

## 3. 앱별 기획서(PRD)가 단일 소스
각 앱은 `specs/apps/<id>.md`에 PRD를 가진다: **주제매력도 · 레퍼런스(모방대상) · 목적 · 핵심루프
· 시나리오 · 성공기준 · QA 검증 시나리오 · 현재 깨짐 · single/multi**. 29개 작성 완료
(`specs/apps/INDEX.md`). **이 PRD의 QA 시나리오 통과 = 그 앱의 done.** "에러 안 나면 OK" 금지.

**2026-06-24 PRD 진단 (정직):** verdict **ship 0 / needs-fix 22 / broken 7**, high 결함 47개.
즉 현재 출시 가능한 앱이 하나도 없다.

---

## 4. 시스템 근본 결함 (P0 — 엔진/인프라, 다수 앱 동시 영향)
PRD 47개 high 결함은 5개 시스템 원인으로 수렴. 이걸 먼저 고치면 다수 앱이 동시에 산다.

- **C1. 컴포넌트 인스턴스 propValue 바인딩이 런타임에 sub-layer로 재전파 안 됨 (★최대).**
  `scoreCard.value`/`optN.label`/`ResultBar.label` 같은 인스턴스 prop 바인딩이 바뀌어도 확장된
  `$props.X` 텍스트 레이어에 반영 안 됨 → 점수·진행·보기라벨이 0/리터럴('A','0회','대기')로 고정.
  영향: counter-tap, coop-click, coop-cheer, gacha-draw, quiz-choseong, race-trivia,
  balance-game, game-clicker, ladder-game, worldcup 등 10+개. **"점수가 안 오른다"의 진짜 원인.**
  (직접 text-layer 바인딩은 동작 → 렌더러의 prop→sub-layer 전파 경로가 버그.)
- **C2. 이미지 텍스처가 imageUrl 바인딩이 바뀌어도 첫 텍스처에 고정.** 월드컵 후보 사진이 첫
  쌍에 멈춤(이름만 바뀜) → 사진-이름 불일치. 렌더러 image 레이어가 URL 변경 시 재로드 안 함.
- **C3. 레이아웃 collapse — `height:"fill"/"hug"` 컨테이너가 0으로 줄고, flex 부모 속 절대좌표
  자식이 뭉침.** → 게임판 빈 검정/구멍 뭉침/패드 알약화/텍스트 겹침(simon·reaction·whackamole·
  tap-target·colororder). (hitArea prune은 1차 수정함; 시각적 collapse는 layout 엔진 잔여.)
- **C4. lime-on-lime / 저대비.** 선택 막대(라임) 위 라임/검정 텍스트가 사라짐(mood-slider pct,
  wheel-menu 결과 등). 정적 색은 일부 수정, state-bound 색은 남음.
- **C5. 콘텐츠/로직 + 이미지 파이프라인 오용.** 예: **emoji('🪙')를 이미지 검색 쿼리로 오인해
  스톡 동전 사진으로 치환**(gacha), MBTI 채점 불균형/코드-닉네임 불일치, this-or-that stale 표
  키 불일치, 룰렛 휠 미렌더/섹터 없음.

## 5. 이미지 정책 (신뢰도 — "엉뚱한 사진 금지")
- **명명된 인물(아이돌/배우 등)**: 실제 그 인물 사진만(위키백과/위키미디어 1차, 단독 포트레이트).
  못 구하면 **랜덤/스톡/생성 금지** → 이름 플레이스홀더 카드. (가짜 얼굴 생성은 더 나쁨.)
- **사물/음식/개념**: 위키 → 키드 스톡 → **그래도 없으면 이미지 생성(image-gen) fallback**.
  워터마크(yelp 등) 박힌 소스 배제.
- **emoji는 절대 이미지 검색에 넣지 않는다**(C5). 콘텐츠 `q`는 위키 해결형 영어 키워드.

## 6. ACCEPTANCE CRITERIA (객관 검증)
### A. 실제로 작동 + 렌더된다 (척 금지)
- 모든 컨트롤이 응답하고(oracle), **화면에 의도대로 렌더**된다(점수/진행/라벨/이미지가 실제로
  갱신·표시; 시각 스크린샷으로 확인). 죽은/숨김/겹침 0.
### B. 콘텐츠 품질·진실성·무중복
- 사실 정확, KR 현재성, 비중복; 이미지=실제 그 대상(§5); 퀴즈 정합; 필러 0.
### C. 게임 루프 (의도대로 보임)
- start→play→end→result→replay; 타이머가 **화면에서** 카운트다운, 점수가 **화면에서** 증가,
  조각이 보드 안에서 반응. (바인딩 값만이 아니라 렌더 결과로 판정.)
### D. 싱글 — 서버 무의존, 즉시 피드백.
### E. 멀티 — 같은 링크→한 방, 라이브 동기화, 무desync; '함께'가 본질에 맞음(forced-vote 금지);
  single과 완벽 분리.
### F. 신규 생성 — valid·runnable·in-bounds·무overlap·무dead-binding, 1회/1수리, %pass≥90.
### G. (횡단) **"되는 척" 금지** — done의 유일 기준 = 그 앱의 **PRD QA 시나리오 통과 + 시각 검증**.

## 7. 검증 자산 (게이트)
- `tools/e2e-audit.mjs` — 실제-터치 오라클(A/C, 바인딩/상태 레벨). **단독으론 불충분**(렌더 결과를
  못 봄 — 이번에 "통과했는데 깨짐"의 원인). 반드시 **시각 검증과 병행**.
- `tools/content-quality.mjs`(B) · `tools/multiclient-sim.mjs`(E) · `tools/gen-battery.mjs`(F) · `tools/gate-all.mjs`(통합).
- `tools/capture-shots.mjs` — **앱별 스크린샷(초기+플레이)**. 시각 검증의 근거. (이번 PRD가 이걸로 진단.)
- **보강 필요:** (1) 렌더-결과 검증을 오라클에 추가(인스턴스 prop 바인딩 텍스트가 실제 픽셀로 갱신되나,
  이미지 텍스처가 교체되나), (2) 앱별 QA 시나리오 자동 러너.

## 8. 실행 방식
- 앱별 PRD(`specs/apps/`) → project-spec(이 문서) → `/speckit.specify`→`plan`→`tasks`(feature
  `specs/001-release-quality-bar` 업데이트) → **implement는 ralph-loop**(앱별 QA 통과까지 자율 반복,
  완료 신고는 gate-all green + 전 앱 QA pass + 시각 검증일 때만).
- 순서: **C1~C5 시스템 결함 먼저(레버리지 큼)** → 앱별 콘텐츠/레이아웃/대비 수정 → 재검증.
- 레거시 엔진 엔진 수정 시 `엔진 수정 로그`에 로그(이미 hitArea·nested-yoga 기록됨).

## 9. 현재 스코어카드 (2026-06-24)
- 자동 게이트 1차: oracle 29/29, content-quality 29/29, sim 10/10, gen 95% — **그러나 실제
  렌더/경험은 미달**(PRD 진단: ship 0). v2의 교훈: 게이트 green ≠ done. 시각·QA 검증이 필수.
- PRD: 29/29 작성(`specs/apps/`). 다음 = C1~C5 엔진 수정 → 앱별 수정(ralph) → 전수 재검증.
