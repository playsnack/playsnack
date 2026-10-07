# Tasks: 실데이터 월드컵 (Live-Data Worldcups)

**Plan**: [plan.md](./plan.md) · **Spec**: [spec.md](./spec.md)

## Phase 1 — P1 음원 월드컵 (vertical slice, 먼저 끝까지)

- [x] T001 Melon 차트 fetch → `snack-server/data/pools/songs.json` 기록 (Claude/MCP). `{updatedAt, items:[{song,artist,rank,rising}]}`
- [x] T002 `content.mjs`에 `songcup` kind + 시드 로더(`loadPool`) + 일(KST 09시) 캐시 버킷. 시드→16후보 (LLM은 가공만, 시드 없으면 폴백)
- [x] T003 음원 월드컵 `.bite.json` 신규 (기존 worldcup-group-vote/idol 구조 그라운딩; 곡명+아티스트 카드) + index.json 등록
- [x] T004 검증: `/api/content?kind=songcup` 현재 곡 확인 + capture-shots 플레이스루 + 오라클 PASS

## Phase 2 — P2 인물 신선도 (brikorea)

- [x] T005 brikorea 평판 fetch → `data/pools/{idols,singers}.json` (Claude/WebFetch). `{updatedAt, items:[{name,group,rank,rookie}]}`
- [x] T006 인물 worldcup kind가 시드 시딩: 성별분류·그룹 펼침·중복제거·톱8+신인8(신인≥1) + 월 캐시 버킷 (시드 없으면 기존 LLM)
- [x] T007 idol-m/f·singer-m/f 앱이 시드 기반 풀 사용하도록 dataSource/테마 정합 확인
- [x] T008 검증: 후보 신인 포함·성별 정확·사진 정확(strict) + capture-shots

## Phase 3 — 레이턴시 · 폴백 · 갱신

- [x] T009 프리워밍: songcup/idolcup/**singercup** 모두 prewarm 화이트리스트 포함(index.mjs L712), `prewarmImage`도 person-disambig("이름|가수") 인식
- [x] T010 폴백 검증: 시드 없음/파싱실패 → `build*cup` null → `getContent`가 LLM worldcup으로 graceful 폴백. 풀 치우고 singercup/idolcup/songcup 모두 current:16·error없음, **오라클 PASS**(singer-m/song) 확인
- [x] T011 시드 갱신 메커니즘: `tools/validate-pools.mjs`(스키마/성별/신인/사이즈, present-but-broken만 FAIL) + `docs/seed-refresh.md` 런북. CronCreate 자동화는 음원 Melon-MCP 헤드리스 미도달로 보류(문서화), 인터랙티브 주기 갱신 권장

## Phase 4 — 게이트

- [x] T012 `gate-all` **5/5 ALL PASS** (content-quality 44/44 · tokens-ssot · **seed-pools[신규 게이트]** · oracle 44/44 · multiclient-sim 13/13). 음원(곡명+아티스트)·가수(전소미/윤하·정동원/박효신 본인사진)·아이돌 월드컵 스크린샷 검증. 합산-실행 1회 oracle 43/44 flaky 관측 → 단독 재실행 44/44로 교차확인(핸드오프 기록과 일치)

## 완료 기준 (SC 매핑)
SC-001 음원 16강=현재 곡(T004) · SC-002 신인≥1(T008) · SC-003 일/월 안정(T002/T006) · SC-004 성별 100%(T006/T008) · SC-005 빠른 로딩(T009) · SC-006 폴백 오라클 PASS(T010)
