# 친구 방 결과 저장 (`/api/room-result`) — G3 레인 R

**제품 결정(주인):** 친구 방 링크(`/p/<slug>?room=<CODE>`)는 방이면서 **그 방의 결과 페이지**다. 모두 나간 뒤 누가 링크를 열면, 그 방에서 **마지막으로 끝난 판의 결과 + 순위**를 본다(서버에 **7일** 보관). 버튼 **"이 방에서 한 판 더"**로 로비로 간다.

## 1. 흐름
1. **방장 기기**(방 엔진을 돌리는 기기)에서 판이 결과로 넘어가는 순간 엔진 훅 `onResult(result)`가 한 번 불린다 — `packages/snack-room/src/room.js` `toResult()` → `savedResult()`. 같은 판(`S.sid`)은 한 엔진에서 한 번; 결과 화면에서 넘겨받은 방장은 다시 부르지 않는다(`first` 조건). 점수판(`raceBoard`)을 한 번도 보여 주지 않은 판(투표 · 협동)은 보내지 않는다.
2. 셸(`snack-player/src/roomResult.ts` `engineResults`)이 친구 방이면 `app`을 붙여 `POST /api/room-result`로 보낸다(`fetch keepalive`, 응답 안 기다림, 실패는 조용히 무시). 공개 방은 보내지 않는다.
3. 누가 친구 방 링크를 열고 **혼자 로비에 있으면**(방의 첫 `state`: 단계 `lobby`, 참가자 1명 — 빈 방의 방장이 된 것) `GET /api/room-result?room=<방 id>`. 결과가 있고 그때도 혼자면 **"지난 판 결과"** 화면(`LastResult.tsx`): 순위, 퀴즈면 문제별 정답 · 각자 고른 답, "결과 공유"(같은 결과 이미지 `resultImage.ts`), **"이 방에서 한 판 더"**(닫고 로비), 안내 문구 "이 결과는 7일 동안 링크로 볼 수 있어요". 다른 사람이 이미 있으면 보여 주지 않는다.

## 2. API
### POST `/api/room-result`
본문 `{ room, sid, result }` (JSON, ≤ **24 KB** — 넘으면 413). `result = { v:1, sid?, endedAt?, title?, about?, board:[{pid, nick, score, left?}], quizRecap? }`.
- `room`: 친구 방 id만 — `^(tpl-<template>|app-<hash>)~<코드 8–32자>$` (코드 알파벳은 `links.ts`와 같음). `~` 없는 공개 방 → 400 `not_friends_room`.
- `sid`: 엔진의 판 id(`[A-Za-z0-9_-]{16,32}`), `result.sid`가 있으면 같아야 함.
- 엄격 검증(`api/_lib/roomResult.js`): 플레이어 ≤ 20, 문제 ≤ 20, 보기 2–4, 글자 수 상한은 엔진과 같음(닉네임 10 · 제목 40 · 문제 80 · 보기 30 grapheme, grapheme당 UTF-16 4 이하, 제어문자 금지), 점수 · 시간 · 선택지 번호 범위. 하나라도 어긋나면 400(잘라서 받지 않음).
- 저장되는 레코드는 **허용 필드로 새로 만든다** — 클라이언트가 더 보낸 필드(anonId 등)는 저장에 닿지 않는다. `endedAt`은 서버 시각(저장 시각).
- **판마다 한 번만 쓴다**: `SET results:once:<sha256(room, sid)> 1 NX EX 7일`이 성공할 때만 결과를 쓴다. 호스트 교대로 같은 판이 두 번 와도 `{ok:true, saved:false}`. 다른 판(새 sid)은 덮어쓴다 = **방의 마지막 판**.
- 응답: `200 {ok:true, saved:true|false}` · 400/413 · 429(`rate_limited`, `daily_cap`) · 503(`budget_reached`, `store_unavailable`).

### GET `/api/room-result?room=<방 id>`
`200 {ok:true, result}` 또는 `404 {ok:false, error:"not_found"}`. 같은 방 규칙(아니면 400, KV 명령 없음). `cache-control: public, max-age=10, s-maxage=10` + 인스턴스 메모리 캐시 10초.

## 3. 저장 키 (Upstash Redis, `api/_lib/store.js`)
| 키 | 값 | 만료 |
|---|---|---|
| `results:room:<sha256("rr\0"+방 id)>` | 결과 JSON | **7일**(마지막 판 저장 시각부터) |
| `results:once:<sha256(방 id, sid) 앞 40자>` | `1` | 7일 |
| `results:saves:<KST 날짜>` / `results:reads:<KST 날짜>` | 그날 저장 / 읽기 수(일일 상한용) | 2일 |

KV가 없으면(로컬 · 테스트) 함수 인스턴스 메모리(같은 만료).

## 4. 무엇을 저장하나 (개인정보)
- **저장함(제품 데이터):** 앱 slug(예: `tpl-speed-trivia-score`), 저장 시각, 순위(닉네임 · 점수 · 방 안 번호 `p1, p2…` · 나감 표시), 퀴즈면 제목 · 대상 닉네임 · 문제 · 보기 · 정답 · 각자 고른 답 · 걸린 시간 · 점수. **닉네임과 점수가 곧 이 기능의 내용**이다.
- **저장 안 함:** 방 id · 방 코드(해시만 키로), 판 id(해시만, write-once 키로), anonId, IP, user agent, 쿠키. IP는 속도 제한에서 메모리 안에서만 해시(`api/_lib/ratelimit.js`, `/api/ev`와 같음).
- **비공개가 아니라 "목록에 없음"(unlisted):** 링크(방 코드)를 가진 사람은 누구나 7일 동안 결과를 본다 — 친구가 링크를 단톡방에 올리면 그 방 사람 모두. 링크는 50비트 무작위 코드라 추측은 어렵다(`links.ts`).
- **덮어쓰기 위험(인증된 방 전까지):** 링크를 가진 사람은 같은 방에 다른 결과를 POST할 수 있다(검증된 모양이면 받아들임) — 방장 인증이 없기 때문. 인증된 방(사업 계획의 "인증 방")이 생기면 방장 토큰으로 막는다. 그 전까지 이 결과는 "그 방에서 마지막으로 보고된 판"이지 증명된 기록이 아니다.
- 7일이 지나면 Redis 만료로 사라진다(복구 없음). 지우기 요청 경로는 아직 없다 — 같은 방에서 한 판 더 하면 덮어쓴다.

## 5. 무료 보장 (`docs/telemetry.md` §5a와 같은 예산)
- 모든 KV 파이프라인이 `/api/ev`와 **같은** 월 예산 카운터(`budgetKey()` — 지금 `ev:budget:<KST 연-월>`; stats 레인이 키 이름을 바꾸면 그대로 따라감)에 `INCRBY <n>`으로 시작(`metered()`, `n` = 그 파이프라인의 명령 수 정확히). 예산(`EV_MONTHLY_BUDGET`, 기본 400000) 도달 후엔 KV 명령 0개: POST · GET 모두 503 `budget_reached`. 셸은 결과 화면을 안 띄우고 그냥 로비.
- 명령 수: 첫 저장 = claim(`INCRBY` + `SET NX` [+`EXPIRE`]) 2–3 + 쓰기(`INCRBY` + `SET` + `INCR` [+`EXPIRE`]) 3–4 = **5–7**; 같은 판 중복 = **2–3**; 읽기(캐시 안 맞음) = `INCRBY` + `GET` + `INCR` [+`EXPIRE`] = **3–4**; 검증 실패 · 캐시 맞음 · 예산 후 = **0**.
- 일일 상한: 저장 `RR_DAILY_SAVES`(기본 200) → 429 `daily_cap`, 읽기 `RR_DAILY_READS`(기본 1000) → 503 `daily_cap`. 최악(매일 둘 다 채움) ≈ 200×7 + 1000×4 = 5.4K/일 ≈ **월 162K**. `/api/ev` 최악과 합치면 400K를 넘을 수 있다 → 그때 월 예산이 멈춘다(무료 유지가 우선). 실제 베타 규모는 하루 수십 판.
- 속도 제한(클라이언트당 10회 버스트, 6초에 1회 회복, 인스턴스당 분당 300).

## 6. 셸의 크기 맞추기
엔진의 결과는 20명 × 20문제면 24 KB를 넘을 수 있다. `roomResult.ts` `fitResult`가 보낼 때 줄인다: ① 문제별 답을 순위표 상위 8명으로 ② 그래도 크면 문제 회고를 빼고 순위만.

## 7. 미검증
- Vercel 프리뷰에서 실제 Upstash로 POST/GET(로컬은 메모리 저장소 + 가짜 Upstash 테스트로만 확인).
- 방장 탭이 결과 직후 바로 닫힐 때 `keepalive` 전송이 끝까지 가는지(브라우저마다 다름).
