# 익명 측정 (`/api/ev`) — Q0 레인 D

> 마스터 플랜 §4 Q0 레인 D(측정 기반) · §6 개인정보. Q2 레인 D(공유 ID `?s=`, 이벤트 10개 이하, 대시보드, 안내 페이지)가 이 위에 붙는다.
> 상태: 엔드포인트 + 클라이언트 + 테스트 완료. 앱 연결(2026-10-13 핫픽스): `main.tsx`가 오류 비컨(`window.error`·`unhandledrejection`)을 켜고, `LiveApp`이 방 입장 시도마다 `room_join` 1건을 보낸다(`roomJoin.ts` → `trackJoin`). `open`·`first_tap`·`result`는 아직 호출부 없음.
> 무료 베타 지표(§9)는 **연결됨(2026-10-14, `claude/wire-metrics`)** — 엔진 훅(판 완료 · 재경기 · 게임 생성), 방 생성, 초대 · 결과 공유, 반응 문항. `WIRED = true`(§9.5).
> **무료 전용**: Upstash 월 명령 예산을 KV 안에 두고 넘으면 멈춘다 — §5a.

## 1. 구성
| 파일 | 역할 |
|---|---|
| `api/ev.js` | Vercel 함수(Web 표준 `export default { fetch }`). POST 수집 · GET 집계 |
| `api/_lib/schema.js` | 이벤트 화이트리스트 · 정규화 · 오류 문구 정화 · ms 히스토그램 |
| `api/_lib/store.js` | Upstash Redis REST(`/pipeline`) 어댑터 + 메모리 대체 |
| `api/_lib/ratelimit.js` | 저장 없는 속도 제한 |
| `api/_lib/apps.js` | 공식 앱 ID 목록(`snack-server/data/bite/index.json`) |
| `api/_lib/day.js` | KST 날짜 |
| `api/_test/*.test.js` | `node --test api/_test/` (46개 · gate-all의 `api-tests` 단계. 무료 베타 지표는 `metrics.test.js`, 월 예산은 `budget.test.js`) |
| `snack-player/src/telemetry.ts` | 브라우저 클라이언트 |

`_`로 시작하는 파일은 함수가 되지 않는다 — Vercel 문서 "Adding utility files to the /api directory": *"Vercel ignores … Files that start with an underscore"* (https://vercel.com/docs/functions/configuring-functions/advanced-configuration). 문서 문구는 "파일"이며 `_lib/` 같은 **디렉터리**에도 적용되는지는 문서에 명시가 없다(→ §8 미검증). 같은 문서는 공용 코드를 `api/` 밖에 두라고 권장한다; 소유 범위 때문에 `api/_lib`에 두었다. `vercel.json`은 건드리지 않았다(`framework: null`이면 루트 `api/`를 자동 인식 — 문서 "Vercel will deploy any file in the /api directory as a function").

## 2. API
### POST `/api/ev`
본문(콘텐츠 타입 무관 — `sendBeacon`의 `text/plain` 포함):
```json
{ "v": 1, "events": [ { "k": "open", "route": "app", "app": "quiz-ox" } ] }
```
| k | 필드 | 저장되는 카운터 |
|---|---|---|
| `open` | `route`: home·app·room·create·other, `app?` | `open|n`, `open|route|<route>`, `open|app|<app>` |
| `first_tap` | `ms`(0–600000), `app?` | `first_tap|n`, `first_tap_ms|<bucket>`, `first_tap|app|<app>` |
| `result` | `app?` | `result|n`, `result|app|<app>` |
| `share` | `method`: web·kakao·copy·save·other, `what?`(§9), `app?` | `share|n`, `share|method|<m>`, `share|what|<w>`, `share|app|<app>` |
| `room_join` | `ok`: bool, `ms?`, `app?`, `room?` · `reason?`(§9) | `room_join|n`, `room_join|ok`/`fail`, `room_join_ms|ok|<bucket>`, `room_join|room|<r>|<ok/fail>`, `room_join|reason|<r>`, `room_join|app|<app>` |
| `err` | `msg`, `where?`, `build?` | `err|n`, `err|where|<w>`, `err|build|<b>` + 정화된 문구 1건(`ev:<day>:err`) |

- 무료 베타 종류(`session_done` · `rematch` · `room_create` · `game_created` · `ask_shown` · `ask_answer`)는 §9.
- 모르는 종류 · 잘못된 값의 이벤트는 버림(`dropped`로 개수만 응답). 모르는 필드는 위 6종은 무시, §9 종류는 **이벤트째 버림**. 값이 `null`인 필드는 없는 것으로 본다.
- **아는 종류**가 검증에서 버려지면 `<종류>|bad`로 센다(값은 저장 안 함) — 연결 버그(예: 11자 `sid`)가 조용한 0이 아니라 `summary.bad`에 보인다.
- `app`은 먼저 앱 부분만 남긴다(`quiz-ox~CODE`·`tpl-quiz-ox` → `quiz-ox`, `app-<hash>` → `custom`) — 친구방 코드 · 만든 앱 해시는 카운터가 되지 않는다. 그 뒤 공식 템플릿 목록에 없으면 `other`. `where`(≤24자)·`build`(≤16자)는 `[A-Za-z][A-Za-z0-9_.-]*` 아니면 `other`.
- `room_join`의 `reason`(실패 때만, 목록 밖이면 이벤트째 `bad`): `bad_link` · `not_found` · `network` · `timeout`(전송 15초) · `unreachable` · `disconnected` · `refused` · `subscribe`(브로커에는 붙었지만 방 토픽 구독 실패 — 2026-10-13 실기기 테스트에서 찾은 실패) · `silence`(LiveApp이 15초 동안 방 소식을 못 들음) · `other`. 클라이언트 `joinFailReason()`이 전송 쪽 원인을 이 목록으로 바꾼다(`broker` → `unreachable`, `load` → `network`, `"refused: …"` → `refused`).
- `err` 이벤트가 받아들여지면 서버가 **한 줄**을 `console.error`로 남긴다: `[ev] err where=<w> build=<b>: <정화된 문구>`(요청당 최대 5줄). Vercel 프로젝트 → Logs 탭에서 실시간으로 보인다(Hobby 보관 1시간). 그 줄에는 정화된 문구 · where · build 말고 요청의 어떤 것도 들어가지 않는다(privacy 테스트가 콘솔 전체를 검사). KV를 쓰지 않으므로 일일 상한 · 월 예산을 넘어도 계속 남는다(속도 제한 `429` · 개인정보 신호 `204` 요청은 제외).
- ms 버킷: `le100 le250 le500 le1000 le2000 le4000 le8000 le15000 le30000 gt30000`.
- 응답: `200 {ok, accepted, dropped}` · `204` 요청에 `Sec-GPC: 1` 또는 `DNT: 1`(아무것도 세지 않음) · `204` 월 예산 도달(§5a, 본문 없음, `x-ev-budget: reached`) · `413` 본문 >4096바이트(스트림도 4096에서 끊음) · `400` JSON 오류/`v≠1`/이벤트 >20개 · `429` 속도 제한(`rate_limited`/`daily_cap`) · `503` KV 실패 · `405` 기타 메서드.

### GET `/api/ev?day=YYYY-MM-DD`
기본값 = 오늘(KST). 읽기 전용, 인스턴스 메모리 **날짜별** 30초 캐시 + `cache-control: public, max-age=30, s-maxage=30`. (지난 날도 30초만 둔다 — 본문의 `cumulative`(누적 `ev:all`)는 계속 바뀌므로.)
받는 날짜는 보존 기간 안만: **오늘−90일 … 오늘+1일**(KST, +1은 시계가 앞선 클라이언트용). 그 밖(`1999-01-01`, `2999-01-01`…)은 `400 day_out_of_range`, 날짜 형식/달력 오류는 `400 bad_day` — 날짜를 바꿔 가며 캐시를 비켜 Upstash 명령을 무한히 쓰게 하는 길을 막는다(받는 키 = 날짜 ≤ 92 + 주 ≤ 15, 캐시 상한 128이라 다 들어감).
```json
{ "ok": true, "v": 1, "day": "2026-10-12", "store": "kv", "appsKnown": 44, "total": 8,
  "counters": { "open": { "n": 2, "route": { "app": 1 }, "app": { "quiz-ox": 1 } },
                "room_join_ms": { "ok": { "le2000": 1 } } },
  "errors": { "distinct": 1, "top": [ { "msg": "TypeError: x is undefined", "count": 1 } ] },
  "budget": { "month": "2026-10", "used": 1234, "limit": 400000 } }
```
`budget.used` = 이 읽기 파이프라인의 `INCRBY` 응답(추가 명령 없음, 메모리 저장소면 `null`). 월 예산을 넘은 뒤엔 KV를 건드리지 않고 이 인스턴스가 마지막으로 읽은 본문(`"stale": true`) 또는 `{ "ok": false, "error": "budget_reached", "budget": {…} }`를 준다.
모든 응답에 `x-ev-store: kv|memory` 헤더. `appsKnown`이 0이면 함수 번들에 `index.json`이 안 들어간 것(§8).
응답에는 `wired`(§9 이벤트를 앱이 보내는지 — 2026-10-14 연결 커밋부터 `true`; 그 전 날짜의 0은 "안 잼"), `summary`(§9 숫자 요약), `cumulative`(누적 `ev:all`)도 들어 있다(위 예시는 생략). `wired: false`인 동안 0은 "0판"이 아니라 "안 잼"이다.

### GET `/api/ev?week=YYYY-Www`
ISO 주(월–일, KST 날짜) 7일의 카운터를 더해 `{week, days, total, summary, counters, cumulative}`로 돌려준다(오류 문구는 날짜별 `?day=`로). 빈 값 = 이번 주. 읽을 수 있는 날짜(오늘−90 … 오늘+1)만 읽으므로 받는 주는 최대 15개, 한 번 = `/pipeline` 1요청(`HGETALL` ≤ 8개), 같은 30초 캐시. 형식 오류·없는 주(`2025-W53`) → `400 bad_week`, 범위 밖 → `400 week_out_of_range`.

## 3. 저장 키 (Upstash Redis)
- `ev:<KST날짜>` 해시: 위 카운터 + `_total`(그날 받은 이벤트 수 + `bad` 수, 일일 상한용).
- `ev:<KST날짜>:err` 해시: 정화된 오류 문구 → 횟수.
- `ev:all` 해시: 누적 카운터 — 정해진 필드만(`session_done|n`·`session_done|p3`·`rematch|n`·`room_create|n`·`game_created|n`·`game_created|source|<s>`). **만료 없음**, 배포 시점부터 센다(소급 없음). 잘못 부풀면 날짜 키와 달리 저절로 사라지지 않으므로 §9.6 절차로 고친다.
- `ev:once:<해시>` 문자열: "이 판/이 퀴즈는 이미 셌다" 표시. 키 = SHA-256(`종류\0sid|gid`) 앞 32자, `SET NX EX 21600`(6시간). 원래 id는 저장 · 전송하지 않는다(§9.3).
- `ev:budget:<KST 연-월>` 정수: 그달 이 배포가 Upstash에 보낸 명령 수(§5a). 40일 만료.
- 날짜 키는 90일 만료(`EXPIRE`, 인스턴스당 키별 하루 1회만 보내 명령 절약). **원시 이벤트 로그 없음.**
- 모든 `/pipeline` 요청은 맨 앞에 `INCRBY ev:budget:<월> <n>`(+ 인스턴스의 그달 첫 요청이면 그 키의 `EXPIRE`)을 단다(§5a). 쓰기 1회 = `/pipeline` 1요청(`HINCRBY` 여러 개 + 필요 시 `EXPIRE`), §9 판 · 퀴즈 이벤트가 있으면 그 앞에 `SET NX` 요청 1개 더. 읽기 = `HGETALL` 3개(날짜 · 오류 · 누적), 주간은 ≤ 8개.
- **claim → 집계 순서:** Upstash 파이프라인은 조건부 증가를 못 하므로 `SET NX`(claim) 다음에 `HINCRBY`(집계)를 보낸다. 집계가 실패(503)하면 이번에 잡은 claim을 `DEL`로 풀어(최선 노력) 다른 호스트의 같은 판 보고가 세어지게 한다. 풀기마저 실패하면 그 판은 6시간 동안 `dup`로만 세어진다(과소). 파이프라인이 일부 명령만 적용하고 실패하는 경우는 가짜로만 시험했다(§8).
- 환경변수가 없으면 인스턴스별 메모리(재시작 · 인스턴스 간 공유 안 됨, 개발 · 미설정 상태용).

## 4. 개인정보 보장 (마스터 플랜 §6)
- 서버는 IP · UA · 쿠키 · 닉네임 · 사람/기기/브라우저 세션 ID를 **저장 · 기록 · 전송하지 않는다.** §9 판 · 퀴즈 이벤트는 **판 하나에 붙는 무작위 id(`sid`/`gid`)를 보낸다** — 서버는 그 해시만 6시간 둔다(중복 제거용). 저장되는 건 위 화이트리스트 카운터, 정화된 오류 문구, 그 해시뿐.
- 요청에 `Sec-GPC: 1` 또는 `DNT: 1`이 있으면 서버도 세지 않는다(`204`) — 클라이언트가 이미 안 보내지만, 다른 경로로 온 요청까지 막는다.
- 오류 문구 정화(`sanitizeErr`): 따옴표 문자열 → `<str>`, URL → `<url>`, 이메일 → `<email>`, `key=value`의 값 → `=<v>`, `/`가 든 토큰(경로 · UA 제품 토큰) → `<path>`, 비ASCII(한글 닉네임 등) → `?`, 8자 이상 hex → `#`, 글자+숫자 섞인 토큰(`user42`, `scott123`) → `?`, 숫자 → `#`, 100자 제한.
- **닉네임의 정확한 보장:** 닉네임은 어떤 카운터 · 키 · 필드에도 들어가지 않는다(이벤트의 `nickname` 같은 필드는 읽지 않음). 유일한 자유 문자열인 오류 `msg`는 위 정화를 거치므로 한글이 하나라도 든 닉네임(기본 랜덤 닉 포함) · 따옴표로 감싼 닉 · 글자+숫자 닉은 항상 지워진다. 한계: **영문자만으로 된 닉네임**(예 `scott`)이 따옴표 없이 오류 문구에 섞이면 일반 단어와 구별할 수 없어 정화된 문구 안에 남을 수 있다 — 그 문구는 횟수만 세는 상위 20개 샘플이고, 클라이언트(`telemetry.ts`)는 `window.error` · `unhandledrejection`의 메시지만 보내며 닉네임을 문구에 넣는 코드는 없다(앱 코드가 닉을 넣어 `throw`하면 이 한계에 걸린다).
- 클라이언트: 쿠키 · localStorage · 사람/기기/브라우저 세션 ID 없음(§9 판 이벤트의 무작위 판 id만 있음), fetch 대체 경로는 `credentials: 'omit'`. DNT · GPC가 켜져 있으면 강제 활성화(`enabled: true`)도 무시하고 꺼짐.
- 테스트(`api/_test/privacy.test.js`): 가짜 IP · UA · 닉네임 · 쿠키 · 기기 ID를 헤더와 이벤트 필드 · 오류 문구에 넣어 보내고, **가짜 Upstash가 받은 URL · 헤더 · 명령 전부, 저장 내용, 메모리 저장소, 제한기 키, 콘솔 출력, GET 응답** 어디에도 없음을 확인. (이 테스트가 UA 문자열이 오류 문구에 섞이면 새는 문제를 실제로 잡았고, `<path>` · `=<v>` 규칙으로 고쳤다.)
- 한계: `sendBeacon`은 브라우저 규칙상 같은 출처 쿠키를 붙일 수 있다 — 사이트가 쿠키를 만들지 않고 서버가 `Cookie` 헤더를 읽지 않는다. Vercel 플랫폼 자체의 요청 로그(IP 포함 가능)는 이 코드 밖이다(§8).

## 5. 속도 제한 (아무것도 저장 안 함)
1. 클라이언트별 토큰 버킷(인스턴스 메모리): 키 = `SHA-256(인스턴스 랜덤 솔트 + KST날짜 + 주소)` 앞 24자. 주소(`x-vercel-forwarded-for` → `x-forwarded-for` 첫 값 → `x-real-ip`)는 메모리에서 해시만 하고 저장 · 기록하지 않는다. `x-vercel-forwarded-for`를 **그대로 신뢰**한다 — Vercel이 자기 프록시에서 채우는 헤더라 Vercel 위에서는 클라이언트가 위조할 수 없다(다른 호스팅으로 옮기면 이 헤더는 위조 가능 → 그 환경의 신뢰 헤더로 바꿔야 함). 날짜가 바뀌면 솔트 재생성 + 버킷 비움. 기본 버스트 20, 초당 0.5 충전(분당 30). 최대 1만 키.
2. 인스턴스 분당 600요청.
3. 일일 이벤트 상한 `EV_DAILY_CAP`(기본 **1500**): 쓰기마다 돌려받는 `_total`(KV에 있는 그날 전체 합계)로 판단 → 넘으면 그날 `429 daily_cap`. 인스턴스별로 마지막 본 값을 쓰므로 새 인스턴스마다 첫 쓰기 1회(≤20 이벤트)만큼 넘칠 수 있다. **무료 보장은 이 상한이 아니라 아래 월 예산이다.**

## 5a. 무료 보장 (Upstash Free, 카드 없음)
**규칙: Upstash에 결제 카드를 절대 등록하지 않는다.** Upstash 가격 페이지 FAQ(https://upstash.com/pricing/redis, 2026-10-13 확인): *"Once you enter your credit card, your database will be upgraded to the pay-as-you-go plan and limits will be updated."* — 카드가 없으면 과금될 수단이 없고, 카드를 넣는 순간 사용량 과금 DB가 된다. 같은 페이지의 Free: **월 500K 명령, 데이터 250MB, 대역폭 월 10GB**. Free 한도를 넘으면 어떻게 되는지는 그 페이지에 쓰여 있지 않다(유료 플랜 FAQ에만 "rate limiting / rejected requests") → 그래서 넘기 전에 우리가 멈춘다.

**월 명령 예산(`EV_MONTHLY_BUDGET`, 기본 400000 = 500K의 80%)** — `api/_lib/store.js` `metered()`:
- KV로 가는 **모든** `/pipeline` 요청(집계 `apply`, 판 중복 제거 `claim`의 `SET NX`, 실패 시 `release`의 `DEL`, 읽기 `read` · `readDays`)의 **첫 명령**이 `INCRBY ev:budget:<KST 연-월> <n>`이다. `n` = 그 파이프라인이 보내는 명령 수 **정확히**(INCRBY 자신과 EXPIRE 포함). 같은 파이프라인에 예산 키 `EXPIRE 40일`(인스턴스당 그달 1회).
- 응답의 INCRBY 값 = 그달 사용량. 이 값이 예산 이상이면 그 인스턴스는 그달 **KV 명령을 하나도 보내지 않는다**: POST → `204`(저장 안 함 — claim도 안 보냄), GET(`?day` · `?week`) → 그 인스턴스가 마지막으로 읽은 본문(`"stale": true`) 또는 `{ "ok": false, "error": "budget_reached", "budget": {…} }`. 달이 바뀌면(KST 1일 0시) 새 키로 다시 시작.
- GET 응답의 `budget: { month, used, limit }` — `used`는 그 읽기 파이프라인의 INCRBY 응답(추가 명령 없음, 메모리 저장소면 `null`).
- 파이프라인 안 명령이 하나씩 과금되는지 Upstash 문서에 명시가 없다("pricing is based on per command/request") → **하나씩 센다고 가정**(보수적). Upstash 콘솔의 실제 사용량이 우리 카운터보다 크면 이 가정이 틀린 것. 실패한 파이프라인(HTTP 오류)은 우리 카운터에 안 들어가지만 Upstash가 셌을 수 있다(작은 과소 계산).
- 넘침 한계: 예산 도달을 아직 모르는 인스턴스(콜드 스타트)는 첫 요청 1회만큼 더 쓴다 — 요청 1회 ≤ 약 110 명령(아래). 인스턴스가 수십 개여도 수천 명령 = 남은 100K 여유 안.

**최악 계산** (이벤트 1개의 날짜 `HINCRBY` 필드 최대: 실패한 `room_join` 6개(n·fail·ms·room·reason·app), `session_done` 7개 + 누적 `ev:all` 2개 + claim `SET` 1개 ≈ 10개; `err`는 필드 3 + 문구 1):
| 요청 | 명령 수 |
|---|---|
| POST, 판 이벤트 없음 (이벤트 k개) | `INCRBY` 1 + `_total` 1 + 필드 ≤ 6k(같은 필드는 합쳐짐) + `EXPIRE` ≤ 3(예산 · 날짜 · 오류 키, 인스턴스당 처음만). 보통 이벤트 1개 = 3–8 |
| POST, 서로 다른 판 20개 (최악) | claim: `INCRBY` 1 + `EXPIRE` ≤ 1 + `SET` 20 = 22 · 집계: `INCRBY` 1 + `_total` 1 + `HINCRBY` ≤ 60 + `EXPIRE` ≤ 2 = 64 → **≈ 86** (집계가 실패하면 release `INCRBY` 1 + `DEL` ≤ 20 더 → ≈ 107) |
| GET `?day` (캐시 안 맞음) | `INCRBY` 1 + `HGETALL` 3 (+`EXPIRE` 1) = **4–5** |
| GET `?week` (캐시 안 맞음) | `INCRBY` 1 + `HGETALL` ≤ 8 (+`EXPIRE` 1) = **≤ 10** |
| GET 캐시 맞음 · 개인정보 신호 · 예산 도달 후 모든 요청 · 유효 이벤트 0개 POST | **0** |

- 쓰기: 일일 상한 1500 이벤트를 매일 채운다고 하면 — 오류 · 입장 위주(이벤트당 ≈ 5 + 요청당 2)면 ≈ 10–12K/일 → 월 ≈ 330–370K, **전부 판 이벤트**(요청당 판 1개: claim 2 + 집계 11 ≈ 13)면 ≈ 19.5K/일 → 월 ≈ 600K. 즉 일일 상한만으로는 무료가 보장되지 않고, **월 예산 400K가 실제 멈춤 장치**다. 실제 베타 규모(테스트 세션 = 이벤트 수십 개 = 명령 수백 개)는 이보다 훨씬 작다.
- 읽기: 인스턴스당 날짜 · 주 키마다 30초 캐시 → 오늘을 쉬지 않고 한 달 내내 폴링하면 2,880 × 4 ≈ 11.5K/일(≈ 357K/월). Vercel CDN `s-maxage=30`이 반복 GET을 대부분 흡수할 것(미검증).
- 합친 최악은 400K를 넘는다 → 그때 예산이 멈춘다(그달 나머지 수집 중단 — 무료 유지가 우선). 평소 사용량은 GET의 `budget.used`로 본다.

**멈춘 뒤**: 앱에는 아무 영향 없음(텔레메트리는 응답을 기다리지 않는다). 오류 줄은 Vercel Logs에 계속 남는다(KV 안 씀). 다음 달 1일(KST)에 자동 재개. 예산을 바꾸려면 `EV_MONTHLY_BUDGET`(500000 미만으로).

## 6. 클라이언트 `snack-player/src/telemetry.ts`
연결: `main.tsx` — `telemetryEnabled()`일 때만 `configureTelemetry({ build })` + `installErrorBeacon(build)` (build id = `g` + 커밋 7자, `vite.config.ts`가 `VERCEL_GIT_COMMIT_SHA` → 로컬 git 커밋 → `dev` 순으로 정함; 서버의 `build` 형식 `[A-Za-z]…`에 맞추려고 `g`를 붙임). `LiveApp` — `roomJoin.ts`의 `joinTracker`가 시도마다 `trackJoin()`으로 `room_join {ok, ms, room, reason?, app}` 1건(ms = `connect()`/`retry()` 호출 → 첫 `connected`, 실패면 → `failed`; 결과 전에 화면을 떠나면 안 보냄).
```ts
import { track, trackError, installErrorBeacon, configureTelemetry, flush } from './telemetry';
installErrorBeacon(BUILD_ID);                       // window error + unhandledrejection
track({ k: 'open', route: 'app', app: slug });
track({ k: 'room_join', ok: true, ms: 1800 });
```
- 5초마다 / 20개 쌓이면 / 페이지 숨김(`visibilitychange` · `pagehide`) 시 전송. `sendBeacon` 실패 시 `fetch(..., {keepalive: true, credentials: 'omit'})`.
- 본문은 4000바이트 이하로 쪼갬(혼자서도 넘는 이벤트는 버림). 오류는 `msg+where`로 중복 제거, 페이지당 10개, 전체 200개.
- 꺼지는 조건: Vite 개발 모드(`import.meta.env.DEV`), `VITE_TELEMETRY=off`, `navigator.doNotTrack === '1'`, `globalPrivacyControl === true`, `configureTelemetry({enabled:false})`.
- Node에서 바로 실행되는 TS(타입 제거 가능한 문법만) — 테스트는 Node 22.18+/23.6+ 필요(이 기계 Node 26.8에서 확인).

## 7. 주인 설정
1. Upstash 무료 계정 → Redis DB 생성(리전: 한국과 가까운 곳) → REST URL · 토큰 복사.
2. Vercel 프로젝트 `playsnack` → Settings → Environment Variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (Vercel 마켓플레이스 연동이 만드는 `KV_REST_API_URL` / `KV_REST_API_TOKEN`도 인식). 선택: `EV_DAILY_CAP`(기본 1500), `EV_MONTHLY_BUDGET`(기본 400000). **Upstash에 카드 등록 금지**(§5a).
3. 재배포 후 `curl -i https://<배포>/api/ev` → `x-ev-store: kv`, `appsKnown: 44`, `budget.used`가 숫자인지 확인. Upstash 콘솔의 그달 명령 수와 `budget.used`가 비슷한지 가끔 비교(§5a 가정 확인).
4. 빌드에서 끄려면 `VITE_TELEMETRY=off`.

## 8. 미검증 (프리뷰 배포가 있어야 확인 가능)
- **`/api` 자동 인식**: `framework: null` + `outputDirectory: snack-player/dist`에서 루트 `api/ev.js`가 함수로 배포되는지, `api/_lib/` · `api/_test/` **디렉터리**가 함수로 안 잡히는지(문서는 `_` 파일만 명시).
- **`index.json` 번들 포함**: `readFileSync(new URL('../../snack-server/data/bite/index.json', import.meta.url))`가 파일 추적에 잡히는지. 안 잡히면 모든 앱이 `other`가 되고 GET의 `appsKnown`이 0 — 그때 `vercel.json`의 `functions["api/ev.js"].includeFiles` 추가 필요(레인 범위 밖).
- **실제 Upstash 응답**: `/pipeline` 응답 형식(`[{result}|{error}]`)과 `HGETALL` 결과(평탄 배열)는 문서 기준 가짜로만 테스트했다.
- **Upstash 명령 과금**: 무료 월 500K(가격 페이지 확인). pipeline 안 명령을 하나씩 세는지는 문서에 없음 → 하나씩 센다고 보고 KV 안 월 예산(§5a)으로 막았다(claim · release 포함 모든 파이프라인). 콘솔 수치와 `budget.used` 비교로 확인할 것.
- Vercel 요청 로그의 IP 보관 정책, 함수 리전(KST 사용자 기준 지연), 인스턴스 수에 따른 메모리 제한기의 실효성.

## 9. 무료 베타 지표 — 연결됨

> 출처: [사업 계획](business-plan-2026.md) "무료 베타에서 볼 숫자" · 표 3단계(측정), [제품 기획서](product-brief-live-party-game.md) "사용자 반응 확인". 첫 게임 = **나 맞히기 퀴즈**(`speed-trivia-score`).
> **상태: 연결됨(2026-10-14).** 엔진 훅 → `telemetry.ts engineMetrics` → 메시 · 릴레이 전송, 화면(방 생성 · 초대 공유 · 결과 화면)에서 보낸다. GET 응답 `wired: true`. 연결 위치는 §9.5 끝 "연결 결과". **서버 모드 방(`ServerTransport`, snack-server가 엔진을 돌림)은 판 이벤트를 보내지 않는다** — 기본인 서버리스 메시 · `?host` 릴레이만 센다.

### 9.1 이벤트
공통: `app` = 앱 id(§2 정규화, 공식 44개 · `custom` · `other`), 인원 버킷 `p` = `1 · 2 · 3 · 4-5 · 6-8 · 9+`(서버가 정수 1–1000을 버킷으로 바꿈). 아래 종류는 **필드 목록 밖의 키가 하나라도 있으면 이벤트째 버리고** `<종류>|bad`로 센다.

| `k` | 필드 | 보내는 곳 · 정확히 언제 | 한 번만 세는 방법 |
|---|---|---|---|
| `session_done` | `p`(참여 인원), `sid`, `app?`, 퀴즈만 `about?`: bool, `ans?`: 0–1000 | **호스트 엔진만**, 판이 결과로 넘어가는 순간(`play`/`countdown`→`result` 첫 전환). **`p` = 이 판에 참여한 사람 수** = 이번 판에 점수 · 답 · 투표 · 탭 액션을 1번 이상 보낸 anonId 수(엔진의 `S.acted`), 퀴즈 주인공은 참여로 친다. 마지막 몇 초에 링크만 연 사람 · 구경꾼은 안 들어간다. `about` = 누군가에 대한 만든 퀴즈(true) / 기본 퀴즈(false). `ans` = 주인공을 뺀, 이 판에서 답을 1번 이상 낸 사람 수(1 = 1:1). 서버 검사: `ans ≤ p`(`about: true`면 `ans ≤ p − 1`), 어기면 `bad`. | 서버 `ev:once`(종류+`sid`) + 엔진 상태 `S.done`(§9.3) |
| `rematch` | `p`, `sid`(새 판), `app?` | **호스트 엔진만**, 이 방에서 앞 판이 결과까지 간 뒤 새 판이 시작될 때(콘텐츠 로딩 후 카운트다운 직전). 여기 `p`는 시작 순간 **방에 있는** 인원(아직 아무도 참여 전). | 서버 `ev:once`(종류+`sid`) |
| `game_created` | `source`: `editor`·`remake`, `gid`, `app?` | **호스트 엔진만**, 유효한 `quizPack` 액션을 받아들인 순간(검증 실패 · 거절된 팩은 안 셈 = "플레이 가능한 것만"). `remake` = 결과 화면(`S.phase === "result"`)에서 **직전 주인공이 아닌** 참가자가 보낸 팩(직전 판이 기본 퀴즈면 주인공 없음 → 누구든 remake), 그 밖은 `editor`. | 서버 `ev:once`(종류+`gid`) |
| `room_create` | `app?` | 친구방 코드를 새로 만든 기기, 코드 생성 순간 1번. **코드는 보내지 않는다.** | 코드 생성이 그 탭에서만 일어남(서버 중복 제거 없음) |
| `room_join` (확장) | `ok`, `ms?`, `room?`: `public`·`friend`, 실패 시 `reason?`: `bad_link`·`not_found`·`network`·`timeout`·`unreachable`·`disconnected`·`refused`·`subscribe`·`silence`·`other` | 입장 **시도** 1번(연결 1회 · 재시도 1회)마다 그 기기. 성공 = 첫 방 상태 수신, 실패 = 위 이유 중 먼저 난 것 1개. | 시도마다 1번(클라이언트 가드) |
| `share` (확장) | `method`, `what?`: `invite`·`result`·`app`·`other`, `app?` | 실제로 일어난 공유만: 공유 시트가 끝남(취소 `AbortError` 제외) → `web`, 클립보드 쓰기 성공 → `copy`, 링크를 화면에만 보여줌 → `other`. | 탭마다 1번 |
| `ask_shown` | `app?` | 결과 화면에 "다음에도 하고 싶나요?"를 보여준 **각 기기**, 판마다 1번. | 페이지 안 `gameKey` 가드(서버로 안 보냄) |
| `ask_answer` | `a`: `yes`·`no`·`skip`, `no`일 때만 `why?`: `boring`·`hard`·`laggy`·`few`·`other`, `app?` | 응답하거나 "건너뛰기"를 누른 기기, 판마다 1번. 무응답 = `ask_shown − (yes+no+skip)`. | 같은 가드 |

`sid` · `gid` 형식: `[A-Za-z0-9_-]{16,32}`. 둘 다 엔진이 그 판/팩을 만든 **액션의 `clientMsgId`**(`crypto.randomUUID()`, 하이픈 제거 = 32자)에서 만든다 — 같은 액션을 어느 호스트가 처리해도 같은 값(§9.3). 카메라 · 마이크 · 사진은 쓰지 않는다.

### 9.2 저장 키와 하루 집계 (`ev:<KST날짜>` 해시)
| 지표 | 필드 |
|---|---|
| 끝낸 판 | `session_done|n`, `session_done|p|<버킷>`, **`session_done|p3`**(참여 3명 이상, 퀴즈면 `ans ≥ 1`도 — 아무도 답하지 않은 퀴즈는 끝낸 판으로 치지 않음), `session_done|app|<app>`, `session_done|app3|<app>`, `session_done|about|true/false`, `session_done|ans|<0·1·2·3·4-5·6-8·9+>`, 중복 `session_done|dup` |
| 재경기 | `rematch|n`, `rematch|p|<버킷>`, `rematch|app|<app>`, `rematch|dup` |
| 방 생성 | `room_create|n`, `room_create|app|<app>` |
| 커스텀 게임 생성 | `game_created|n`, `game_created|source|editor/remake`, `game_created|app|<app>`, `game_created|dup` |
| 입장 실패 | `room_join|fail`, `room_join|reason|<r>`, `room_join|room|<public/friend>|<ok/fail>` |
| 공유 | `share|n`, `share|method|<m>`, `share|what|<w>` |
| 반응 문항 | `ask_shown|n`, `ask_shown|app|<app>`, `ask_answer|a|<a>`, `ask_answer|why|<why>`, `ask_answer|app|<app>|<a>` |

- 누적 = `ev:all`(§3, 만료 없음). 주간 = `GET ?week=YYYY-Www`의 `summary` — 또는 `?day=` 7번을 더하면 같다.
- `summary` 필드: `sessionsDone`, **`sessionsDone3`**(핵심), `sessionsDup`, `sessionsAbout`, `rematch`, `roomsCreated`, `gamesCreated`, `gamesRemade`, `joinOk`, `joinFail`, `share`, `askShown`, `askYes`, `askNo`, `askSkip`, `bad`(종류 → 검증에서 버린 수, 0이면 빠짐 — 연결 뒤 0이 아니면 버그).
- 필드 수 상한: 앱 값 ≤ 46개 × 정해진 열거값뿐이라, 임의 문자열 · id가 필드를 늘리지 않는다(`metrics.test.js` "bounded keys"). 명령 수는 §8.

### 9.3 호스트 교대가 두 번 세지 못하는 이유
1. **엔진 안:** `session_done`은 `setPhase("result")`가 결과가 아닌 단계에서 처음 넘어갈 때만 나가고, 그때 `S.done += 1`. `S.sid` · `S.done` · `S.subject` · `S.answerers` · `S.acted`는 세션 상태 `S`에 있어 스냅샷에 실려 다음 호스트로 간다(room.js `snapshot()`이 `S`의 나머지를 그대로 담음). 결과 뒤 스냅샷으로 이어받은 호스트는 이미 `result`라 다시 보내지 않는다.
2. **경합 창:** 옛 호스트가 결과로 넘어가 보낸 직후, 그 스냅샷(≤400 ms 주기)이 닿기 전에 사라지면 새 호스트가 결과 전 스냅샷에서 이어받아 결과를 한 번 더 낸다. 이때 `sid`가 같다 — 시작 액션의 `clientMsgId`로 만들고, 그 액션이 다시 적용돼도(meshClient의 `acked` 재전송 · `seen` 중복 제거) 같은 값이기 때문. **서버가 `SET ev:once:<hash(종류+sid)> NX EX 21600`으로 두 번째를 `session_done|dup`로만 센다.** `quizPack`(→ `gid`)도 같다.
3. 한계: 두 보고가 6시간 넘게 벌어지면 두 번 센다(브라우저 비콘은 5초 · 페이지 숨김 때 나가므로 드묾). 호스트 기기가 DNT/GPC를 켰거나 측정이 꺼진 빌드면 **그 판은 아예 세지 않는다**(참가자 기기는 판 완료를 보내지 않음). 호스트 탭이 비콘 전에 죽으면 빠진다 — 과대보다 과소 쪽으로 틀린다.

### 9.4 이 숫자로 알 수 없는 것 (가명 ID 없음 — 이번 변경 범위)
- **MAU · 이용자 수:** 사람을 구별하지 않는다. `p` · `ans`는 판마다의 인원이고, 같은 사람이 5판 하면 5번 들어간다. 방문 · 입장 횟수를 유저 수라고 부르지 않는다.
- **같은 모임의 재방문:** 다른 날 같은 사람들이 다시 왔는지 모른다. `rematch`는 **같은 방, 같은 접속 안**의 다시 하기만 센다.
- **참가자→개설 전환:** `game_created|source|remake`가 **한 방 · 한 접속 안의** 전환("결과 화면에서 직전 주인공이 아닌 참가자가 새 퀴즈를 보냄")만 식별자 없이 센다. 참가자가 다음 날 직접 새 방을 여는 **날짜를 넘는 전환은 여전히 알 수 없다.**
- 만든 방이 실제로 쓰였는지(`room_create`는 코드 생성 수; 쓰인 정도는 `session_done`과 함께 본다), 응답하지 않은 사람의 생각(긍정률만으로 재미를 판정하지 않는다).
- **DNT/GPC:** 그런 기기는 자기 이벤트(입장 · 공유 · 반응 문항)를 보내지 않는다. 하지만 판 이벤트는 **호스트가** 보내므로, 호스트가 측정 중이면 GPC를 켠 참가자도 `p` · `ans` **숫자 하나에 합산되어** 들어간다(그 사람에 대한 어떤 값도 따로 가지 않음). 호스트 자신이 DNT/GPC면 그 판은 통째로 빠진다.

### 9.5 연결 계획 (제품 레인용 · `origin/claude/q1` 기준 file:line)
엔진(`packages/snack-room`)은 플레이어 코드를 가져올 수 없으므로 **훅만 추가**하고, 헬퍼 호출은 전송 계층에서 한다.
1. `room.js:58-59,74-75` — 훅 3개 추가: `onSessionEnd({sid, players, about, answerers})`, `onSessionStart({sid, players, again})`, `onGameCreated({gid, source})`(기본값 no-op).
2. `room.js:89` — `session`에 `sid: "", done: 0, subject: "", answerers: undefined, acted: undefined` 추가.
3. `room.js:543-544` — `start` 액션이 `d.clientMsgId`를 `startSession`에 넘김. `room.js:349-353`에서 `S.sid = idOf(clientMsgId)`(하이픈 제거, 없으면 `random()`으로 32자), `S.answerers = new Set()`, `S.acted = new Set(S.subject ? [S.subject] : [])`(주인공은 참여로 침).
4. `room.js:369` 뒤(콘텐츠 로딩 성공 후) — `onSessionStart({sid: S.sid, players: r.roster.size, again: S.done > 0})` → `again`이면 `trackRematch`.
5. `room.js:173-180` `setPhase` — `phase === "result" && S.phase !== "result"`일 때 `S.done += 1` 후 `onSessionEnd(...)`. 결과로 가는 길 3곳(`toResult` :181, `endNunchi` :245, `finishBracketRound` :290)이 모두 여기를 지난다. `players = S.acted.size`(참여 인원 — 로스터 인원이 아님; 0이면 헬퍼가 보내지 않음), 퀴즈면 `about = Boolean(S.subject)`, `answerers = S.answerers.size`.
6. 참여 기록 — 이번 판 창 안(`S.phase === "play"` 또는 `inWindow()`)에서 **받아들인** 액션마다 `S.acted.add(anonId)`: `vote` :460-468, `tally` :469-475, `score` :476-486, `tap` :487-506, `taps` :507-513, `reaction` :514-527, `answer` :528-542. `answer`는 추가로 `anonId !== S.subject`일 때 `S.answerers.add(anonId)`. `start` · `lobby`는 참여가 아니다.
7. `room.js:455` `action()` — 새 `quizPack` 분기(제품 레인이 추가): 검증 통과 시 `source = S.phase === "result" && anonId !== S.subject ? "remake" : "editor"`, `S.subject = anonId`, `onGameCreated({gid: idOf(d.clientMsgId), source})`. 결과 화면이 아니라 로비를 거쳐 보내는 흐름이면 조건을 `S.done > 0`으로 바꾼다.
8. `room.js:628,639,663,665` — `answerers` · `acted`(Set)를 `answered`처럼 배열로 스냅샷 · 복원(그대로 두면 JSON에서 `{}`가 되어 새 호스트의 `p`가 0이 됨). `sid` · `done` · `subject`는 손댈 필요 없음(`...rest`).
9. `roomTransport.ts:253` `connectMesh({…})`와 `:222` `connectRelay({…})` — `engine: { onSessionEnd: (e) => trackSessionDone(this.me.slug, e.players, e.sid, quiz ? {about: e.about, answerers: e.answerers} : undefined), onSessionStart: (e) => e.again && trackRematch(this.me.slug, e.players, e.sid), onGameCreated: (e) => trackGameCreated(this.me.slug, e.source, e.gid) }`. `this.me.slug`는 방 id(`slug~CODE`)지만 헬퍼의 `appOf()`가 코드를 잘라낸다. 엔진 옵션 통로: `meshClient.js:77,250-251`, `relayClient.js:33,94`.
10. `LiveApp.tsx:173-177` `openFriendRoom` — `trackRoomCreate(slug)`(코드 생성 직후, `navigate` 전).
11. **연결됨(2026-10-13 핫픽스, `roomJoin.ts`):** 시도(`room.connect()` 또는 다시 시도) 1번마다 첫 `connected`에 `trackJoin(slug, true, {ms, room})`, 첫 `failed`에 `trackJoin(slug, false, {ms, room, reason: joinFailReason(m.d.reason)})`; LiveApp 15초 무응답은 `silence`. 아직 안 됨: 연결 전 실패(잘린 코드 → `bad_link`, 앱 로드 실패 → `not_found`/`network`).
12. `LiveApp.tsx:178-195` `shareInvite` — 공유 시트 성공 `trackShare("web", "invite", slug)`, 클립보드 성공 `"copy"`, 화면 표시 `"other"`. 결과 공유 · 앱 공유는 버튼이 생기는 곳에서 `what: "result"`/`"app"`.
13. 결과 화면 문항(새 UI) — 표시 때 `trackAskShown(slug, gameKey)`, 응답 때 `trackAskAnswer(slug, gameKey, a, why)`. `gameKey` = 이 기기에서 본 결과 화면 순번 등(보내지 않음).
14. 위가 들어가는 커밋에서 `api/_lib/schema.js`의 `WIRED`를 `true`로 바꾼다.
15. `telemetry.ts`의 `installErrorBeacon` · 측정 켜기 자체는 이 계획 밖(별도 결정).

**연결 결과 (2026-10-14, 위 계획과 다른 점만):**
- 엔진(`packages/snack-room/src/room.js`): `createRoom` 옵션 `onSessionStart` · `onSessionEnd` · `onGameCreated`(기본 no-op, 던지면 로그만). `onSessionEnd`는 `setPhase`에서 결과로 처음 넘어갈 때(`S.sid`가 있을 때만) `{sid, players: S.acted.size, quiz, about?, answerers?}`. `onGameCreated`의 `remake` 조건은 **`S.done > 0 && 보낸 사람 ≠ 직전 판 주인공(S.quizSubject)`**(결과 화면 · 로비 어디서 보내도 같음 — 7번의 대안 조건). 테스트: `packages/snack-room/test/metrics.test.js`.
- 전송: 엔진 옵션 통로는 이미 있었다(`meshClient`/`relayClient`의 `engine`). `roomTransport.ts`가 `engine: engineMetrics(this.me.slug)`를 넘기고, `telemetry.ts engineMetrics`가 `again`일 때만 `trackRematch`, 퀴즈일 때만 `about` · `ans`를 붙인다.
- 화면: `LiveApp.tsx` `openFriendRoom` → `trackRoomCreate`; `shareInvite` → `trackShare(web|copy|other, 친구방이면 "invite" · 공개방(만들기 링크)이면 "app")`. 결과 화면: `resultController`가 보고마다 `gameKey`(방 + `sessionNo`)를 같이 넘기고 `ResultExtras.reportResultEvent` → `telemetry.ts trackResultEvent`(`ask_shown` · `ask_answer` 판마다 1번, 결과 공유는 공유 시트 완료만).
- 끝에서 끝: `api/_test/wiring.test.js`(메모리 버스 위 실제 메시 방 → 엔진 → 헬퍼 → 실제 `/api/ev` 핸들러; 1:1 퀴즈 = `session_done` 1건, 호스트가 판 중간에 나가도 1건).

### 9.6 누적(`ev:all`) 바로잡기
날짜 키는 90일이면 사라지지만 `ev:all`은 영원하므로, 버그 · 시험 트래픽으로 부푼 누적은 손으로 고친다(단순함 우선, 기준선 계산 없음).
1. 부푼 양을 날짜 키로 확인: `GET /api/ev?day=<날짜>`의 해당 필드(예: `counters.room_create.n`)를 그 기간 동안 더한다.
2. Upstash 콘솔(CLI)에서 같은 양을 뺀다: `HINCRBY ev:all room_create|n -<N>` (필드마다).
3. 아래 기록표에 한 줄 남긴다 — 고친 날, 필드, 양, 이유. 누적을 인용할 때는 이 표를 함께 본다.

| 날짜 | 필드 | 변경 | 이유 |
|---|---|---|---|
| (아직 없음) | | | |
