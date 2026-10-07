# Implementation Plan: 실데이터 월드컵 (Live-Data Worldcups)

**Spec**: [spec.md](./spec.md) · **Created**: 2026-06-29

## Architecture (시드파일 방식)

외부 소스(Melon 차트·brikorea 평판)는 **Claude(클라이언트) 측에서만** 접근 가능 → 서버 런타임이 직접 호출 불가. 따라서:

```
[Claude] 소스 fetch (Melon MCP / brikorea WebFetch)
   → 시드 파일 기록: snack-server/data/pools/{songs,idols,singers}.json   (이름·순위·메타)
[server content.mjs] worldcup-song / worldcup(인물) kind:
   시드 로드 → (인물) 성별분류·그룹 펼침·중복제거·톱8+신인8 → LLM은 위키 q 매핑/가공만
   → 일(음원 09시 KST)·월(인물) 캐시 버킷
[builder/templates] 음원 월드컵 .bite.json 신규(기존 worldcup 구조 그라운딩)
[image] 기존 strict=1 + ko-first 위키 + 순차 프리워밍 재사용
[갱신] Claude가 시드 재기록(음원=일 시도/수동폴백, 인물=월). 실패 시 직전 시드 유지.
```

## Tech decisions

- **시드 포맷**: `{ updatedAt, items:[...] }` JSON. 음원 item `{song, artist}`, 인물 item `{name, group, rank, gender?, rookie?}`.
- **캐시 버킷**: content.mjs에 kind별 버킷 함수 — 음원=KST 날짜(09시 앵커), 인물=KST 월. (기존 시간당 버킷과 분리.)
- **폴백**: 시드 없음/파싱 실패 → 기존 LLM-only 경로(graceful). 갱신 실패 → 직전 시드.
- **음원 이미지**: 앨범아트가 이상적이나 v1은 곡명/아티스트 텍스트 카드로도 가능 → 우선 텍스트 카드, 이미지(앨범/아티스트 위키)는 후속.
- **시드 갱신 자동화**: CronCreate 시도 → 헤드리스 MCP 미도달 가능 → 수동/주기 폴백(플레이북·문서화).

## Sequencing

1. **P1 음원 월드컵 수직 슬라이스** (먼저 끝까지 되게): Melon 시드 → `songcup` kind → 음원 .bite.json 앱 → 일 버킷 → 검증.
2. **P2 인물 신선도**: brikorea 시드(idols/singers) → 인물 worldcup kind가 시드 시딩(성별분류·신인) → 월 버킷 → 기존 idol/singer 앱 연결 → 검증.
3. **레이턴시**: 일/월 캐시로 진입 시 LLM 대기 0 + 프리워밍.
4. **폴백·갱신 메커니즘** 문서화 + 검증(시드 제거 시 오라클 PASS).

## Verification

- content kind 단위: 시드→풀 변환 결과 직접 확인(현재 차트 곡 / 신인 포함 / 성별).
- 앱: capture-shots로 음원·인물 월드컵 플레이스루 스크린샷.
- 회귀: gate-all (오라클/sim/content-quality) — 폴백 포함.
