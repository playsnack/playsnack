# 엣지 방 — Cloudflare Workers + Durable Objects (스파이크)

> 2026-10-14 · 브랜치 `claude/edge-relay` · **아직 배포 안 함** (주인 확인 후 §9 명령 한 줄).
> 목표 시나리오: **공원 이벤트** — 주최자가 QR을 띄우면 모르는 사람 30–200명이 한 방에 들어와
> 퀴즈를 풀고, 1등이 상품을 받는다. 그래서 방은 "멍청한 중계"가 아니라 **서버 권한(server-authoritative)**:
> 방 엔진이 방의 Durable Object(DO) 안에서 돈다. 플레이어 기기는 답·시계·점수를 갖지 않는다.

## 1. 구조

```
 폰 ──WebSocket /room/<방 id>──▶ Worker ──idFromName(방 id)──▶ Game DO (방 1개 = DO 1개)
   ◀── state / setVar / participants / actionAck ─────────────  createRoom() = @snack/room 엔진
                                                                 │ 30초마다(묶어서) 사용량 보고
 GET /usage ──▶ Worker ──(60초 캐시)──────────────────────────▶ Meter DO (계정에 1개)
 (옛 메시 방식) 폰 ──/relay/<방 id>──▶ Room DO (중계만, VITE_ROOM_MODE=relay)
```

| 파일 | 역할 |
|---|---|
| `edge/room/src/game.js` | **GameRoom** — 서버 권한 방. 엔진 실행, hello 인증, 주최자, 좌석, 팬아웃 큐, 스냅샷 |
| `edge/room/src/core.js` | RoomGate(방 만들기·PIN·잠금·토큰) · UsageMeter/UsageReporter(무료 한도) · RoomRelay(메시 중계) |
| `edge/room/src/worker.js` | Worker + DO 클래스 3개(Game · Room · Meter). 플랫폼 코드만 |
| `packages/snack-room/tools/edgeHub.js` | 같은 game.js/core.js를 `ws`로 돌리는 Node 허브 — 테스트·시뮬레이션용 |
| `packages/snack-room/src/room.js` | 엔진: `claimWindowMs`(서버 시계 판정) · `rejoin()`(동면 후 복구) 추가 |
| `snack-player/src/roomTransport.ts` | `EdgeRoomTransport` = ServerTransport + 좌석/주최자 토큰. `VITE_ROOM_URL` 있을 때만 |

**기본값은 안 바뀐다**: `VITE_ROOM_URL`이 없으면 지금처럼 MQTT 메시. 있으면 엣지 방(서버 권한),
`VITE_ROOM_MODE=relay`면 메시를 엣지 중계로(`wsBus.js`).

### 와이어 프로토콜 = snack-server `/ws` 그대로
- 폰 → `{t:"hello", d:{slug, anonId, nick, pin?, token?, organize?, organizerToken?}}` (반드시 첫 프레임 — 아니면 4001로 끊음)
- 폰 → `{t:"action", d:{name, payload, clientMsgId}}` · `{t:"react", d:{emoji}}`
- 방 → 엔진 메시지(`state`·`setVar`·`participants`·`reaction`·`actionAck`) + `token`(좌석) · `organizer` · `denied{reason}`
- 개인 변수(`iAmSubject`·`myPid`·`myPick`·`iAmSpectator`·`iAmOut`)는 엔진 `send`로 **그 소켓에만**.
- 메시 하트비트(1초) 없음 — 소켓 닫힘 = 퇴장.

## 2. 공정성 (상품이 걸린 방)
1. **정답은 공개 전 방 밖으로 안 나간다** — 엔진이 `roundContent`에서 `answer`를 빼고, 선택(`picks`)은 방 안에만, 라운드 중 점수판은 라운드 전 점수. 테스트가 공개 전 **모든 소켓의 모든 프레임**을 뒤져 `answer`·`correct`·`points`·`quizRecap`이 없음을 확인 (`edge-room.test.js` "fairness").
2. **서버 시계**: 기기가 잰 응답 시간(ms)은 `[서버가 본 경과 − claimWindowMs, 서버가 본 경과]` 안에서만 믿는다. 기본 **1000 ms** (혼잡한 공원 LTE의 RTT+렌더+지터를 덮는 보수적 시작값). 로컬 RTT는 ~1 ms라 실제 값은 **폰 실측 후 줄인다**(§10). 치터가 얻을 수 있는 이득 = 최대 이 창.
   - 측정: 600 ms 창일 때 multiclient-sim의 "느린 네트워크" 반응속도 행(의도적으로 560 ms+ 늦게 보냄)이 깎였다 → 창 < 실제 지연이면 정직한 사람이 손해. 그래서 1 s.
3. **기기당 좌석 1개**: 같은 `anonId`의 두 번째 소켓은 `seat_taken`(4009). 그 좌석의 토큰(HMAC `{r,p,a:anonId,exp}`)을 보이면 재접속으로 보고 **이전 소켓을 밀어낸다**. 한계: anonId는 기기가 만든 값 → 새 브라우저 = 새 좌석(계정 없이 sybil은 못 막음). 이벤트 상품은 §8의 "우승자 확인 코드"로 보완.

## 3. 주최자 · PIN
- `hello.d.organize = true`로 **방을 만든 사람**이 주최자 → HMAC 주최자 토큰(12시간). 플레이어는 이 기기가 방금 만든 친구 방 코드(`markFreshRoom`)일 때 보낸다. 라운드 진행은 엔진 타이머라 별도 "advance"는 없음(필요하면 다음 단계에서 엔진에 추가).
- **주최자 = 방장(#135)**: 친구 방(`slug~CODE`)과 주최 방은 엔진 `startRule: "host"` — 주최자(= 첫 입장자)가 방장이고 `start`·`lobby`는 방장만(`not_host`, 엔진이 판정 — 예전 `organizer_only` 게이트를 대신). 방장이 30초 넘게 없으면 가장 먼저 들어온 사람에게 넘어가고, 돌아와도 되찾지 않는다. `quizPack`은 엔진 규칙(나 맞히기 주인공) 그대로 — 주최자 전용 아님. 동면 뒤 스냅샷 없이 다시 만들 때는 주최자 소켓을 먼저 넣는다. 자세히: `docs/bite-format.md` §6.2.
- **공개 방 자동 시작(#136)**: 공개 방(`slug`, `slug.gN`)은 `startRule: "auto"`. hello의 `autoStart: {start, ms}`(앱 문서의 `room`)로 대기실이 스스로 세고 시작한다. 판이 진행 중일 때 처음 온 사람(`autoStart`를 보낸 새 클라이언트만)은 `moveTo {room: nextRoomId(id)}` + 4010 — `slug` → `slug.g2` → `slug.g3`(결정적: 늦은 사람들이 같은 방에 모인다). 새 방은 `RoomGate`의 사용량 가드를 그대로 거치고, 거절되면 클라이언트가 원래 방에 `stay: true`로 돌아와 관전. 왜 이 방식: 방(DO)끼리 대화 없이 각 방이 자기 상태만 보고 정할 수 있고(DO 간 호출·저장 0), 클라이언트는 같은 소켓 재접속 경로(#115)를 그대로 쓴다. 대가 = 다음 방도 진행 중이면 한 번 더 이동(판 길이 ≈ 1분이라 보통 0–1번). 결과 뒤에는 같은 방이 대기실로 돌아온다(모두를 새 방으로 옮기는 것보다 재접속 0번이라 단순).
- PIN(선택, 친구 방): PBKDF2-SHA256 · 방별 salt · 50,000회(Free CPU 고려, 해시는 DO 밖으로 안 나가 온라인 시도 제한이 진짜 방어). 틀림 5번 → 1분 잠금(매번 2배, 최대 1시간), 시간당 20회, 연결당 3회 → 끊음. 토큰(15분, 트래픽에 실어 5분마다 갱신)으로 PIN 없이 재접속.

## 4. 저장하는 것 (그 외 없음)
| 키 | 내용 | 언제 지움 |
|---|---|---|
| `meta` | `{epoch, created, org?, salt?, iter?, hash?}` | 마지막 사람이 나가고 24시간 뒤 알람 |
| `lock` | 틀린 PIN 카운터(타임스탬프) | 〃 |
| `snap` | 엔진 스냅샷(닉네임·점수 포함) — **방에 사람이 있는 동안만** | 마지막 사람이 나갈 때 즉시 |
| `result` | 친구 방의 마지막 판 결과 `{sid, exp, rec}`(닉네임·점수·퀴즈 회고 — `docs/room-results.md`의 레코드) | 저장 7일 뒤 알람(24시간 알람은 이것만 남기고 나머지를 지움) |
| Meter `usage` | 오늘 숫자(요청·메시지·GB-s·rows) — 개인정보 없음 | 날짜 바뀌면 덮어씀 |

IP·메시지 내용은 저장 안 함. `snap`은 동면(hibernation) 대비: 진행 중(엔진 타이머가 있으면 DO는 동면 불가)에는 안 쓰고, 한가할 때·바뀌었을 때만 쓴다(200명 퀴즈 1판 = **1회**).

## 5. 측정 — 50 / 100 / 200명 한 방 (10문제 퀴즈)
`node snack-server/tools/edge-crowd-sim.mjs [--hub-proc]` · `SIM_EDGE_URL=ws://127.0.0.1:4551`(wrangler dev).
주최자 1 + N명 동시 입장 → 10초 대기 → 문제 10개(답 시간 8 s, 공개 2 s), 각자 0.3–3 s 뒤 답, 1/4은 오답.

| N | 전원 입장 (허브 / Miniflare) | 대기 10 s 메시지 | 게임 in (폰→방) | 게임 out (방→폰) | in/s | out/s | out 데이터 | 문제 도착 차이 max | 공개 도착 차이 max (허브 / MF) | 점수판 일치 |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | 137 ms / 157 ms | **0** | 501 (1인 10) | 14,414 | 8.5 | 245 | 2.2 MB | 2 ms | 3 / 4 ms | ✅ |
| 100 | 151 ms / 186 ms | **0** | 1,001 | 29,574 | 17 | 502 | 4.5 MB | 2 ms | 3 / 5 ms | ✅ |
| 200 | 144 ms / 406 ms | **0** | 2,001 | 58,874 | 34 | 996 | 8.9 MB | 4 ms | 8 / 10 ms | ✅ |

방 안 처리 시간(허브를 **별도 프로세스**로 — 클라이언트 부하 제외, `--hub-proc`):

| N | 메시지 처리 p50 / p99 / max | 송신 청크(100프레임) p50 / p99 / max | 스냅샷 쓰기 |
|---|---|---|---|
| 50 | 0.11 / 0.43 / 1.67 ms | 0.13 / 2.26 / 3.9 ms | 1 |
| 100 | 0.07 / 0.30 / 0.66 ms | 0.05 / 2.00 / 6.4 ms | 1 |
| 200 | 0.08 / 0.32 / 1.52 ms | 0.05 / 2.41 / 4.5 ms | 1 |

### CPU 한도 (§1 요구: Free 10 ms)
- **출처**: DO 한도 페이지 — "CPU per request: 30 s … (including WebSocket messages)", "Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds" — 플랜별 구분 없음 (developers.cloudflare.com/durable-objects/platform/limits/, 2026-10-14 확인). Workers 한도 페이지는 Free "CPU time per HTTP request: 10 ms"만 적고 DO WebSocket 메시지에 대해선 말이 없음 (developers.cloudflare.com/workers/platform/limits/). → **문서상 DO 메시지는 30 s**지만, 애매하므로 **10 ms를 우리 예산**으로 잡았다.
- workerd 안에서는 요청 중 시계가 멈춰(Spectre 대책) CPU를 직접 잴 수 없다 → 같은 코드를 Node 허브에서 쟀다(V8 동일, 소켓 쓰기는 Node `ws`가 더 무거움 = 보수적).
- 처음 측정에서 200명 `start` 처리 7–8 ms, 200소켓 팬아웃 최대 8.8 ms → **설계 변경**: ① 모든 송신을 FIFO 큐로, 태스크당 100프레임씩(나머지는 다음 태스크) ② `roster`·`participants`·`quizProgress`는 150 ms마다 1번으로 합침(입장 폭주·답 폭주 = 메시지당 200소켓 팬아웃 → O(n²) 방지) ③ 스냅샷은 한가할 때만. 이후 최악 6.4 ms, p99 2.4 ms.

## 6. 메시지 회계 · 무료 한도 계산
Free 한도 (developers.cloudflare.com/durable-objects/platform/pricing/): DO 요청 100,000/일 · 13,000 GB-s/일 · SQLite rows written 100,000/일 · rows read 5M/일; Workers 요청 100,000/일. **WebSocket 수신 1개 = 요청 1로 센다(#151)**, 송신은 무료, 동면 가능한 한가한 DO는 duration 과금 없음, `setAlarm` 1회 = row 1, 매일 00:00 UTC(= **KST 09:00**) 리셋, 넘으면 그 종류 작업이 에러.

**왜 1:1인가 (#151)**: 가격 페이지의 "수신 20개 = 요청 1"은 *유료 과금(compute requests billing)*에 대한 말이고, Free의 100,000/일 한도도 20:1로 세는지는 문서에 없다(무료 플랜이 원시 메시지 2M보다 훨씬 전에 막혔다는 확인 안 된 커뮤니티 글도 있음). 확인될 때까지 가드는 **보수적으로 1:1** — 단계가 늦게가 아니라 일찍 걸리게. DO 요청 = 소켓 연결(WebSocket 업그레이드·방으로 가는 HTTP 요청) + 수신 메시지(인증·거절·형식 오류 포함 전부) + 알람 실행 + Meter 호출. `/usage`의 `doRequestsBy`가 그 내역(`conns`·`msgs`·`alarms`·`meterCalls`).

| 모드 | 1인당 수신 메시지 | 대기실 1인·분 | 비고 |
|---|---|---|---|
| **엣지 방(서버 권한)** · 10문제 퀴즈 | 10–11 /판 (+hello 1) | **0** | 측정(§5) |
| 메시 over 엣지 중계 · 대기 | — | **62–66** (here 1/s + 스냅샷) | 2/4/8명 60 s 측정 |
| 메시 over 엣지 중계 · 짧은 sim 판(2/5/8명) | 17–31 /판 | — | multiclient-sim 계정(허브), 대부분 하트비트 |

**공원 이벤트 (폰 30–200대 × 1시간, 엣지 방 퀴즈) — 1:1로 다시 계산**. 폰이 보내는 것(`snack-player/src/roomTransport.ts` `ServerTransport`): 접속마다 `hello` 1, 탭한 액션마다 `action` 1, 반응마다 `react` 1 — **하트비트·주기 전송 없음**(대기실 0/분). 방 쪽 묶음: Meter 보고 ≤ 30초에 1번(방당 시간당 ≤ 120), 송신 합치기(150 ms)는 송신이라 무료. 가정: 폰당 접속 3번(처음 + 재접속·다음 방 이동 2), 퀴즈 한 판 = 폰당 11(답 10 + 1, §5 측정), `/usage` 캐시 미스 ≤ 60/시간.

| 시나리오 (1시간) | 폰당 수신 | 30대 DO 요청 (1:1, 가드) | 200대 DO 요청 (1:1, 가드) | 200대 / 70 % 선(70,000) | 참고: 200대 과금 추정 (20:1) |
|---|---|---|---|---|---|
| 보통: 6판, 반응 없음 | 3 + 6 × 11 = 69 | 2,070 + 90 + 200 ≈ **2,360 (2.4 %)** | 13,800 + 600 + 200 ≈ **14,600 (14.6 %)** | 들어감 (여유 55k) | 690 + 600 + 200 ≈ 1,490 (1.5 %) |
| 바쁨: 12판 연속, 판마다 반응 10 | 3 + 12 × 21 = 255 | 7,650 + 90 + 200 ≈ **7,900 (7.9 %)** | 51,000 + 600 + 200 ≈ **51,800 (51.8 %)** | 들어감 (여유 18k) | 2,550 + 600 + 200 ≈ 3,350 (3.4 %) |

(DO 요청 = 수신 + 접속(폰당 3) + 방 오버헤드 ~200: 보고 120 · 새 방 입장 판정·알람 판마다 1씩 · `/usage` 60.) 마지막 열(20:1)은 **유료 과금 추정 참고용**일 뿐 — 가드 입력이 아니다. 예전 문서의 "공원 이벤트 ≈ 700 (0.7 %)"는 이 20:1 가정이었고, 같은 행사(200명 × 3판, 판마다 수신 2,200)를 1:1로 세면 300 + 6,600 + 60 ≈ **7,000 (7 %)**. 나머지 한도: Worker ≈ 접속 600 + `/usage` 60 = 660 (0.7 %); GB-s ≈ 깨어 있는 1시간 × 0.128 GB = **461 (3.5 %)**; rows ≈ Meter 호출 ~200 + 방 저장 수십 (0.3 %). → **퀴즈라면 200대 한 시간도 70 % 아래**. 단, 하루 한도를 같이 쓰므로 "바쁨"이면 그날 남는 건 ~18k.

**탭 게임은 다르다** (`taps`를 ~250 ms마다, `snack-server/data/bite/tap-battle`·`coop-click` `tick`): 폰당 초당 최대 4. 200대 한 판 = tap-battle(10 s) ≤ 200 × 41 = **8,200 (8.2 %)**, coop-click(60 s) ≤ 200 × 241 = **48,200 (48 %)** — 200대 coop-click은 한 판으로 무료 하루의 절반. 큰 방에서 탭 묶음 간격을 늘리는 건 후속 이슈.

같은 이벤트를 메시(엣지 중계)로 하면 200 × 63/분 × 30분 = 378k 수신 = **DO 요청 378k (378 %)** + DO가 동면 못 함 + 호스트 폰이 200명 팬아웃 — 불가.

**베타 (월 2,000판 ≈ 하루 67판, 평균 4명, 방 수명 10분 중 실제 진행 3분)**: 접속 ≈ 400 → Worker 400(0.4 %, `/usage` 캐시 미스 최대 1,440 더해도 1.8 %); DO 요청 ≈ 400 + 수신 4,000 + 알람 67 + 보고·입장 470 ≈ **4,900 (4.9 %)**; GB-s ≈ 67 × 180 s × 0.128 = **1,540 (12 %)** — 방이 10분 내내 깨어 있다고 쳐도 5,150(40 %); rows ≈ 67 × 15 ≈ **1,000 (1 %)**.

**200명 동시 접속이 하루 종일**(작은 방 50개가 계속 진행)이면 50 × 86,400 s × 0.128 = 553k GB-s/일 → **무료의 42배**. 과금은 사람 수가 아니라 **깨어 있는 방 수 × 시간**: 무료 70 % 선에서 ≈ **하루 20 방-시간(진행 중)**. 큰 방 하나는 싸고, 오래 도는 작은 방 여러 개가 비싸다.

## 7. 무료 한도 · 가드 (기본값 = 넘지 않고 우아하게)

| 서비스 | 무료 한도 (일) | 우리 가드 | 리셋 (KST) | 사용자가 보는 것 |
|---|---|---|---|---|
| Workers 요청 | 100,000 | 70 %: 새 방 거절 · 90 %: 새 입장 거절(재접속은 허용) | 매일 09:00 | "오늘 준비한 방이 다 찼어요 · 한국 시간 오전 9시에 다시 열려요" + 혼자 하기 |
| DO 요청 (수신 1:1, #151) | 100,000 | 〃 | 09:00 | 〃 |
| DO duration | 13,000 GB-s | 〃 | 09:00 | 〃 |
| DO SQLite rows written | 100,000 | 〃 (+ 70 %부터 스냅샷 쓰기 중단) | 09:00 | 〃 (진행 중 방은 계속) |
| DO SQLite rows read | 5,000,000 | 추적 안 함 (방당 몇 건) | 09:00 | — |
| DO 저장 용량 | 5 GB 합계 | 방 삭제(24 h) · 스냅샷 즉시 삭제 | — | — |
| Workers CPU | 10 ms/요청 (DO 메시지는 문서상 30 s) | 송신 100프레임/태스크, 합치기 | — | — |

- 계량: 방마다 `UsageReporter`가 로컬(메모리)에서 세고 **30초에 한 번(트래픽이 있을 때) + 방이 빌 때** Meter DO에 묶어 보냄 — 메시지마다 저장하지 않음(Meter 쓰기 = 보고 1번에 1 row). Meter 호출·쓰기 자체도 계산에 넣음. DO 요청은 수신 메시지 **1:1**(§6, #151) + 접속 + 알람 + Meter 호출. 단계 판정은 "어느 한도든 가장 높은 %".
- `GET /usage` → `{day, stage, used, percent, doRequestsBy, free, refusedRooms, refusedJoins, resetsAt}` (60초 캐시 — workers.dev에선 Cache API가 안 먹어서 isolate 메모리에도 60초).
- 단계 기준은 `STAGE_NEW_ROOMS`/`STAGE_NEW_JOINS` 변수로 조정. 비필수 작업 먼저 끔: 줄일 첫 대상은 스냅샷 쓰기(동면 시 복구 포기, 진행엔 영향 없음). 결과 저장(판마다 rows 3)·통계 POST(Cloudflare 한도 밖 — 하위 요청, 10초에 1번)는 계속(§12).
- 테스트: `edge-meter.test.js` — 수신 1:1(거절·형식 오류·중계 인증 포함)·70,000/90,000에서 단계·90 %에서도 재접속 허용·메시지마다 저장 없음; `edge-usage.test.js` — 단계 계산·UTC 날짜 리셋·1단계 새 방 거절/진행 중 방 입장 허용·2단계 새 입장 거절/좌석 토큰 재접속 허용·스냅샷 중단·중계 방도 같은 규칙·`/usage`·30초 묶음 보고.

### 업그레이드 기준 (제안 — 자동 업그레이드 절대 안 함)
- 한 달에 **3일 이상 70 %를 넘거나**, 거절(`refusedRooms`+`refusedJoins`)이 하루 50건을 넘는 날이 생기면 → 주인이 검토: Workers Paid **$5/월**(DO 포함, 사용량 과금 — 예산 알림 설정) 또는 대안(Upstash PAYG + 예산 상한).
- 그 전까지는 가드가 막고, 사용자는 내일 아침 9시 안내 + 혼자 하기를 본다.

## 8. 아직 만들지 않은 것 (주최자 UI · 주인 메모)
- **큰 화면(주최자)**: 큰 QR, 실시간 점수판 — **F1 포디움 레이스 느낌**(순위가 미끄러지며 바뀌는 애니메이션), 우승자 확인 코드(1등 폰에 서버가 서명한 짧은 코드 → 큰 화면/주최자가 대조해 상품 지급; anonId만으로는 본인 확인이 안 되므로 필수).
- **관전자 응원·채팅·우승 예측**: 큰 화면에 보이지만 실시간일 필요 없음 → **2–5초마다 묶어서** 한 번 팬아웃. 수신은 1:1로 세므로(§6) 요청을 줄이려면 폰 쪽에서도 묶어 보낸다.
- **낯선 사람 채팅 = 모더레이션 필수**: 1인 속도 제한, 길이 제한, 욕설 필터, 주최자의 숨기기·내보내기(kick). 이게 없으면 채팅을 열지 않는다.
- 주최자 전용 "다음 문제" 수동 진행이 필요하면 엔진에 `advance` 추가.

## 9. 주인 단계 (계정 준비됨 — workers.dev 하위 도메인 `playsnack`)
```bash
cd edge/room
pnpm install --ignore-workspace              # wrangler 4.136.3 고정 (워크스페이스 밖)
npx wrangler whoami                           # 로그인 확인
openssl rand -base64 32 | npx wrangler secret put ROOM_TOKEN_SECRET
npx wrangler deploy                           # → wss://snack-room.playsnack.workers.dev
curl https://snack-room.playsnack.workers.dev/usage
```
- **결과 · 통계(#96) 배포**: ① (권장) `S=$(openssl rand -base64 32)` → Vercel 환경 변수 `ROOM_SERVER_SECRET=$S`(Production · Preview) 넣고 재배포 → ② `cd edge/room && printf %s "$S" | npx wrangler secret put ROOM_SERVER_SECRET` → ③ `npx wrangler deploy`. 순서가 바뀌면(Worker 먼저) API는 비밀이 없어 헤더를 무시하고 보통 클라이언트로 받는다(동작은 함, 주소 버킷 공유). 확인: `curl -i https://snack-room.playsnack.workers.dev/room/tpl-speed-trivia-score~ABCDEFGH/result` → 404 `not_found`(빈 방).
- 사이트를 옮기면 `wrangler.jsonc`의 `STATS_URL` · `PACK_BASE_URL`을 새 주소로(예: `https://playsnack.pages.dev/...`).
- 라운드 콘텐츠는 `wrangler.jsonc`의 `PACK_BASE_URL`(= playsnack.pages.dev의 정적 `data/multi-content`).
- 플레이어 시험 빌드만: `VITE_ROOM_URL=wss://snack-room.playsnack.workers.dev pnpm player:build` (프로덕션 기본값은 그대로 MQTT).
- 되돌리기: `npx wrangler delete snack-room` (방은 휘발성이라 잃을 데이터 없음).

## 10. 실계정에서만 확인 가능한 것
- **한국 → DO 위치 지연**: DO는 처음 요청한 곳 근처에 생김(ICN/NRT 예상). 폰 RTT p50/p99 측정 → `claimWindowMs`(지금 1 s)를 RTT p99 + 렌더 여유로 줄이기.
- **Free에서 DO WebSocket 메시지의 실제 CPU 한도**(10 ms vs 30 s) — 200명 방에서 `start`/공개 시 오류 로그 확인.
- **동면·과금 실제 동작**: 한가한 대기실이 duration을 안 먹는지(대시보드 GB-s), 동면 후 `rehydrate`(테스트는 허브에서 강제 퇴거로만 확인).
- 실제 무료 한도 숫자·리셋 시각이 대시보드와 `/usage` 추정과 맞는지(추정 오차 보정).
- 카드 등록 요구 여부(계정 생성 시), 셀프서브 약관상 상업 이용(이벤트 상품) 문제 없는지.
- workers.dev 도메인이 한국 통신사에서 막히지 않는지(이벤트 현장 LTE/5G).

## 11. 검증 (이 브랜치)
- 단위: `edge-room`(7) · `edge-relay`(11) · `edge-usage`(7) — 허브에서 전부 통과; `EDGE_URL=ws://127.0.0.1:4551`로 wrangler dev(Miniflare)에서 공유 케이스 통과(허브 전용은 skip).
- 시뮬레이션 (2026-10-14, 최종 코드):

| sim | Node 허브 | wrangler dev (Miniflare) |
|---|---|---|
| multiclient-sim `SIM_EDGE_ROOM=1` (DO 엔진) | 11/11 | 11/11 ¹ |
| multiclient-sim `SIM_EDGE=1` (메시 over 중계) | 11/11 | 11/11 |
| host-handover-sim `SIM_EDGE=1` (A–G) | 7/7 | 7/7 |
| edge-crowd-sim 50/100/200 × 10문제 | 3/3 | 3/3 |

¹ 첫 실행에서 majority-guess 8명 행 1개가 countdown에 멈춤 — 그 시각에 `wrangler.jsonc`를 고쳐 wrangler가 핫리로드(DO 재시작)한 탓(로그로 확인), 재실행 11/11.
- 명령: `SIM_EDGE_ROOM=1 node snack-server/tools/multiclient-sim.mjs` (허브 자동) / `+ SIM_EDGE_URL=ws://127.0.0.1:4551`(wrangler dev, 콘텐츠는 `--var PACK_BASE_URL:http://127.0.0.1:4550` + 정적 서버).
- 결과 · 통계(#96): `edge-results`(7) — 허브에서 통과. 포트 `EDGE_TEST_PORT_RESULTS`(기본 4556). 2026-10-14 wrangler dev(Miniflare)에서: 친구 방 퀴즈 → `GET /room/<id>/result` 200(혼자 들어온 사람도), 정적 서버로 받은 통계 POST 1번(`game_created` + `session_done` 각 1, UA · `X-Room-Server` 확인, 방 코드 없음); `SIM_EDGE_ROOM=1` multiclient-sim 허브 11/11 · Miniflare 11/11; `edge-room` EDGE_URL 6/6(+1 허브 전용 skip).
- 포트: 4550 허브(sim) · 4551 wrangler dev · 4552 relay 테스트 · 4553 room 테스트 · 4554 usage 테스트 · 4555 wrangler inspector. wrangler sim 때 콘텐츠 정적 서버는 4550(허브 안 쓸 때).

## 12. 결과 · 통계 — 호스트 폰이 하던 일을 DO가 (#96)
메시 방에서는 방 엔진을 돌리는 **호스트 폰**이 ① 친구 방의 판 결과를 `/api/room-result`에 올리고 ② 판 이벤트를 `/api/ev`에 보냈다. 엣지 방에는 호스트 폰이 없으므로 같은 엔진 훅을 DO에 연결했다(`edge/room/src/results.js`, `game.js`).

| 일 | 어떻게 | 문서 |
|---|---|---|
| 결과 7일 | 엔진 `onResult` → 친구 방만 `result` = `{sid, exp, rec}` 저장(판마다 1번, 같은 `sid`면 안 씀). `GET /room/<id>/result`(CORS, 10초 캐시)로 읽음 — 플레이어는 `VITE_ROOM_URL`이면 여기서(`roomResult.ts roomResultUrl`), 혼자 로비일 때만 보여 줌. 24시간 정리 알람은 `result`만 남기고 `exp`로 알람을 옮김(`roomAlarm`). | `docs/room-results.md` §1 "엣지 방" |
| 판 통계 | 엔진 `onSessionStart`/`onSessionEnd`/`onGameCreated` → `StatsSender` 큐 → 10초마다(또는 20개 · 방이 빌 때) `POST STATS_URL`. `User-Agent: PlaySnack-RoomServer/1`, `X-Room-Server: <ROOM_SERVER_SECRET>`. 실패는 버리고 셈(재시도 없음), 게임은 기다리지 않음(`ctx.waitUntil`). | `docs/telemetry.md` §9.7 |

- **무료 한도**: 결과 저장 = rows 3(쓰기 · 알람 이동 · 나중 삭제), 결과 읽기 = Worker 1 + DO 1 요청 — 방의 `UsageReporter`가 Meter에 보고. 통계 POST는 DO의 하위 요청(Cloudflare 요청 한도에 안 들어감, 10초에 최대 1번).
- **동면**: 통계 큐는 메모리. 대기 중인 10초 타이머가 있는 동안 DO는 동면하지 않고, 방이 비면 바로 보낸다. 그래도 사라지면 그 이벤트만 빠진다(통계, 게임 아님). 결과는 저장소에 있으므로 동면과 무관.
- **변수 · 비밀**: `STATS_URL`(wrangler.jsonc vars, 지금 `https://playsnack.pages.dev/api/ev`, `""` = 끔) · `ROOM_SERVER_SECRET`(Worker와 Pages 프로젝트에 같은 값). §9 배포 순서 참고.
- 테스트: `packages/snack-room/test/edge-results.test.js` · `api/_test/room-server.test.js` · `snack-player/test/roomResult.test.ts`(`roomResultUrl`).
