# Contract — e2e-audit 오라클 (기존, 형태 정합화)

**Tool**: `snack-server/tools/e2e-audit.mjs` (기존)
**Run**: `node snack-server/tools/e2e-audit.mjs [id ...]`
**Pre**: 서버 + prod 빌드(`/p/tpl-<id>`), Playwright.
**Exit**: 0 = 전 스낵 PASS, 1 = 실패

## 판정 (FR-001/002/010/011)
- `__snackHit`(정확 버튼 rect) + `__snackRuntime`(state/vars) 노출 확인.
- 도달 모든 state에 **응답하는** 탭 컨트롤(탭 → state/vars 변화). 죽은/숨겨진/겹친 = FAIL.
- timer var 있는 게임 = 벽시계 동안 카운트다운해야 PASS.

## 이번 feature의 변경 (R1)
- **grid 내부 컴포넌트 히트 보정** — race-trivia 류: grid child rect 인식.
- **작은 타깃 히트영역** — game-tap-target.
- **wait-then-flip false-fail 제거** — game-reaction/race-reaction: reaction 게임의 "대기 후 반응"을 데드로 오판하지 않도록 게임-루프 판정 보정.
- 출력 형태를 data-model.md OracleResult로 정합(다른 게이트와 합산 가능하게).
