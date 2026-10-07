# Contract — 실시간 WS (기존, 변경 없음 / 검증 대상)

**Endpoint**: `ws://<host>/ws` — `snack-server/src/index.mjs` (`wss`)
**Message envelope**: `{ t, d }` (type, data)

## 클라 → 서버
- `hello` `{ slug }` — 룸 입장. 응답으로 `state` 수신.
- `action` `{ slug, kind, ... }` — kind: vote(option)/coop(inc)/score(value)/reaction(emoji). rate-limit: 1초 15회.

## 서버 → 클라 (broadcast)
- `state` `{ sharedState:{ votesByOption, coopTotal, leaderboard }, participants }` — 입장 시.
- `setVar` `{ id: "votesByOption"|"coopTotal"|"leaderboard", value }` — 변동 시 전체 동기화.
- `participants` `{ count }` — 입장/퇴장 시.
- `reaction` `{ emoji }` — ephemeral(미저장).

## 불변식 (multiclient-sim이 검증)
- 한 클라의 action 후 모든 클라가 같은 sharedState 값에 수렴.
- participants.count == 실제 소켓 수.
- 서버가 진실의 원천(tally/coop/board) — 클라는 setVar로만 갱신(헌법: setVar 서버→전체 동기화).
