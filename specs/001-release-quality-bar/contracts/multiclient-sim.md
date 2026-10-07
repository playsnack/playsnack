# Contract — multiclient-sim 게이트 (신규)

**Tool**: `snack-server/tools/multiclient-sim.mjs`
**Run**: `node snack-server/tools/multiclient-sim.mjs [id ...] [--clients N]` (기본 2~8 스윕)
**Pre**: 서버 실행 중(`SNACK_BASE`/`/ws`).
**Exit**: 0 = 전 멀티플레이어 스낵 수렴·무desync, 1 = 실패
**Output**: stdout JSON — MultiClientSimResult 배열

## 대상 식별 (FR-015)
- doc.variables에 `votesByOption | coopTotal | leaderboard` 공유 var 보유 → 멀티플레이어 스낵.
- forced-vote 강제 금지: 공유 var 없는 스낵은 sim 대상 아님(본질에 맞는 것만).

## 절차 (FR-013/014, SC-005)
1. N개 `ws` 클라가 같은 slug `/ws`에 `hello{slug}` 송신 → 각자 `state{sharedState,participants}` 수신.
2. 한 클라가 `action`(vote 옵션 / coop inc / score) 송신.
3. 서버가 `setVar{votesByOption|coopTotal|leaderboard}` broadcast → **모든 클라가 같은 값에 수렴**하는지(타임아웃 내) 어서트.
4. 참가자 수(`participants.count`)가 실제 소켓 수와 일치하는지.
5. 동시 변동/재투표 반복 → tallyError(서버 진실값 대비 클라 관측값 차) == 0, desyncEvents == 0.
6. 클라 입장/퇴장 시 participants 정확 갱신.

## 통과 기준
- 모든 대상 스낵: converged && desyncEvents==0 && tallyError==0 && participantsAccurate.
