# 익명 측정 (`/api/ev`) — Q0 레인 D

> 마스터 플랜 §4 Q0 레인 D(측정 기반) · §6 개인정보. Q2 레인 D(공유 ID `?s=`, 이벤트 10개 이하, 대시보드, 안내 페이지)가 이 위에 붙는다.
> 상태: 엔드포인트 + 클라이언트 + 테스트 완료. 앱 연결(2026-10-13 핫픽스): `main.tsx`가 오류 비컨(`window.error`·`unhandledrejection`)을 켜고, `LiveApp`이 방 입장 시도마다 `room_join` 1건을 보낸다(`roomJoin.ts`). 다른 이벤트(`open`·`first_tap`·`result`·`share`)는 아직 호출부 없음.
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
| `api/_test/*.test.js` | `node --test api/_test/` (29개 · gate-all의 `api-tests` 단계) |
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
| `share` | `method`: web·kakao·copy·save·other, `app?` | `share|n`, `share|method|<m>`, `share|app|<app>` |
| `room_join` | `ok`: bool, `ms?`, `reason?`(실패 때만), `app?` | `room_join|n`, `room_join|ok`/`fail`, `room_join_ms|ok|<bucket>`, `room_join|reason|<r>`, `room_join|app|<app>` |
| `err` | `msg`, `where?`, `build?` | `err|n`, `err|where|<w>`, `err|build|<b>` + 정화된 문구 1건(`ev:<day>:err`) |

- 모르는 종류 · 잘못된 값의 이벤트는 버림(`dropped`로 개수만 응답), 모르는 필드는 무시.
- `app`이 공식 템플릿 목록에 없으면 `other`. `where`(≤24자)·`build`(≤16자)는 `[A-Za-z][A-Za-z0-9_.-]*` 아니면 `other`.
- `reason`(실패 이유): `timeout`(전송 15초) · `silence`(LiveApp 15초 무응답) · `broker`·`refused`·`subscribe`(MQTT) · `load`(방 엔진 로드 실패) · `unreachable`·`disconnected`(서버/중계) — 그 밖은 `other`, `"refused: …"`는 `refused`.
- `err` 이벤트가 받아들여지면 서버가 **한 줄**을 `console.error`로 남긴다: `[ev] err where=<w> build=<b>: <정화된 문구>`(요청당 최대 5줄). Vercel 프로젝트 → Logs 탭에서 실시간으로 보인다(Hobby 보관 1시간). 그 줄에는 정화된 문구 · where · build 말고 요청의 어떤 것도 들어가지 않는다(privacy 테스트가 콘솔 전체를 검사). KV를 쓰지 않으므로 일일 상한 · 월 예산을 넘어도 계속 남는다(속도 제한 `429`에 걸린 요청은 제외).
- ms 버킷: `le100 le250 le500 le1000 le2000 le4000 le8000 le15000 le30000 gt30000`.
- 응답: `200 {ok, accepted, dropped}` · `204` 월 예산 도달(§5a, 본문 없음, `x-ev-budget: reached`) · `413` 본문 >4096바이트(스트림도 4096에서 끊음) · `400` JSON 오류/`v≠1`/이벤트 >20개 · `429` 속도 제한(`rate_limited`/`daily_cap`) · `503` KV 실패 · `405` 기타 메서드.

### GET `/api/ev?day=YYYY-MM-DD`
기본값 = 오늘(KST). 읽기 전용, 인스턴스 메모리 **날짜별** 캐시(오늘·내일 30초, **이미 끝난 날은 인스턴스가 살아 있는 동안** — 쓰기는 오늘 키에만 가므로 지난 날은 바뀌지 않는다) + `cache-control: public, max-age=30, s-maxage=30`.
받는 날짜는 보존 기간 안만: **오늘−90일 … 오늘+1일**(KST, +1은 시계가 앞선 클라이언트용). 그 밖(`1999-01-01`, `2999-01-01`…)은 `400 day_out_of_range`, 날짜 형식/달력 오류는 `400 bad_day` — 날짜를 바꿔 가며 캐시를 비켜 Upstash 명령을 무한히 쓰게 하는 길을 막는다(캐시 키 ≤ 92개).
```json
{ "ok": true, "v": 1, "day": "2026-10-12", "store": "kv", "appsKnown": 44, "total": 8,
  "counters": { "open": { "n": 2, "route": { "app": 1 }, "app": { "quiz-ox": 1 } },
                "room_join_ms": { "ok": { "le2000": 1 } } },
  "errors": { "distinct": 1, "top": [ { "msg": "TypeError: x is undefined", "count": 1 } ] },
  "budget": { "month": "2026-10", "used": 1234, "limit": 400000 } }
```
`budget.used` = 이 읽기 파이프라인의 `INCRBY` 응답(추가 명령 없음, 메모리 저장소면 `null`). 월 예산을 넘은 뒤엔 KV를 건드리지 않고 이 인스턴스가 마지막으로 읽은 본문(`"stale": true`) 또는 `{ "ok": false, "error": "budget_reached", "budget": {…} }`를 준다.
모든 응답에 `x-ev-store: kv|memory` 헤더. `appsKnown`이 0이면 함수 번들에 `index.json`이 안 들어간 것(§8).

## 3. 저장 키 (Upstash Redis)
- `ev:<KST날짜>` 해시: 위 카운터 + `_total`(그날 받은 이벤트 수, 일일 상한용).
- `ev:<KST날짜>:err` 해시: 정화된 오류 문구 → 횟수.
- `ev:budget:<KST 연-월>` 정수: 그달 이 배포가 Upstash에 보낸 명령 수(§5a). 40일 만료.
- 90일 만료(`EXPIRE`, 인스턴스당 키별 하루 1회만 보내 명령 절약). **원시 이벤트 로그 없음.**
- 쓰기 1회 = `/pipeline` 1요청(`INCRBY` 예산 + `HINCRBY` 여러 개 + 필요 시 `EXPIRE`). 읽기 = `INCRBY` 예산 + `HGETALL` 2개 (+ 인스턴스의 그달 첫 요청이면 예산 키 `EXPIRE` 1개).
- 환경변수가 없으면 인스턴스별 메모리(재시작 · 인스턴스 간 공유 안 됨, 개발 · 미설정 상태용).

## 4. 개인정보 보장 (마스터 플랜 §6)
- 서버는 IP · UA · 쿠키 · 닉네임 · 기기/세션 ID를 **저장 · 기록 · 전송하지 않는다.** 저장되는 건 위 화이트리스트 카운터와 정화된 오류 문구뿐.
- 오류 문구 정화(`sanitizeErr`): 따옴표 문자열 → `<str>`, URL → `<url>`, 이메일 → `<email>`, `key=value`의 값 → `=<v>`, `/`가 든 토큰(경로 · UA 제품 토큰) → `<path>`, 비ASCII(한글 닉네임 등) → `?`, 8자 이상 hex → `#`, 글자+숫자 섞인 토큰(`user42`, `scott123`) → `?`, 숫자 → `#`, 100자 제한.
- **닉네임의 정확한 보장:** 닉네임은 어떤 카운터 · 키 · 필드에도 들어가지 않는다(이벤트의 `nickname` 같은 필드는 읽지 않음). 유일한 자유 문자열인 오류 `msg`는 위 정화를 거치므로 한글이 하나라도 든 닉네임(기본 랜덤 닉 포함) · 따옴표로 감싼 닉 · 글자+숫자 닉은 항상 지워진다. 한계: **영문자만으로 된 닉네임**(예 `scott`)이 따옴표 없이 오류 문구에 섞이면 일반 단어와 구별할 수 없어 정화된 문구 안에 남을 수 있다 — 그 문구는 횟수만 세는 상위 20개 샘플이고, 클라이언트(`telemetry.ts`)는 `window.error` · `unhandledrejection`의 메시지만 보내며 닉네임을 문구에 넣는 코드는 없다(앱 코드가 닉을 넣어 `throw`하면 이 한계에 걸린다).
- 클라이언트: 쿠키 · localStorage · ID 없음, fetch 대체 경로는 `credentials: 'omit'`. DNT · GPC가 켜져 있으면 강제 활성화(`enabled: true`)도 무시하고 꺼짐.
- 테스트(`api/_test/privacy.test.js`): 가짜 IP · UA · 닉네임 · 쿠키 · 기기 ID를 헤더와 이벤트 필드 · 오류 문구에 넣어 보내고, **가짜 Upstash가 받은 URL · 헤더 · 명령 전부, 저장 내용, 메모리 저장소, 제한기 키, 콘솔 출력, GET 응답** 어디에도 없음을 확인. (이 테스트가 UA 문자열이 오류 문구에 섞이면 새는 문제를 실제로 잡았고, `<path>` · `=<v>` 규칙으로 고쳤다.)
- 한계: `sendBeacon`은 브라우저 규칙상 같은 출처 쿠키를 붙일 수 있다 — 사이트가 쿠키를 만들지 않고 서버가 `Cookie` 헤더를 읽지 않는다. Vercel 플랫폼 자체의 요청 로그(IP 포함 가능)는 이 코드 밖이다(§8).

## 5. 속도 제한 (아무것도 저장 안 함)
1. 클라이언트별 토큰 버킷(인스턴스 메모리): 키 = `SHA-256(인스턴스 랜덤 솔트 + KST날짜 + 주소)` 앞 24자. 주소(`x-vercel-forwarded-for` → `x-forwarded-for` 첫 값 → `x-real-ip`)는 메모리에서 해시만 하고 저장 · 기록하지 않는다. `x-vercel-forwarded-for`를 **그대로 신뢰**한다 — Vercel이 자기 프록시에서 채우는 헤더라 Vercel 위에서는 클라이언트가 위조할 수 없다(다른 호스팅으로 옮기면 이 헤더는 위조 가능 → 그 환경의 신뢰 헤더로 바꿔야 함). 날짜가 바뀌면 솔트 재생성 + 버킷 비움. 기본 버스트 20, 초당 0.5 충전(분당 30). 최대 1만 키.
2. 인스턴스 분당 600요청.
3. 일일 이벤트 상한 `EV_DAILY_CAP`(기본 **1500**): 쓰기마다 돌려받는 `_total`(KV에 있는 그날 전체 합계)로 판단 → 넘으면 그날 `429 daily_cap`. 인스턴스별로 마지막 본 값을 쓰므로 새 인스턴스마다 첫 쓰기 1회(≤20 이벤트)만큼 넘칠 수 있다. 진짜 상한은 아래 월 예산이다.

## 5a. 무료 보장 (Upstash Free, 카드 없음)
**규칙: Upstash에 결제 카드를 절대 등록하지 않는다.** Upstash 가격 페이지 FAQ(https://upstash.com/pricing/redis, 2026-10-13 확인): *"Once you enter your credit card, your database will be upgraded to the pay-as-you-go plan and limits will be updated."* — 카드가 없으면 과금될 수단이 없고, 카드를 넣는 순간 사용량 과금 DB가 된다. 같은 페이지의 Free: **월 500K 명령, 데이터 250MB, 대역폭 월 10GB**. Free 한도를 넘으면 어떻게 되는지는 그 페이지에 쓰여 있지 않다(유료 플랜 FAQ에만 "rate limiting / rejected requests") → 그래서 넘기 전에 우리가 멈춘다.

**월 명령 예산(`EV_MONTHLY_BUDGET`, 기본 400000 = 500K의 80%)** — `api/_lib/store.js` `metered()`:
- KV로 가는 모든 `/pipeline` 요청의 **첫 명령**이 `INCRBY ev:budget:<KST 연-월> <n>`이다. `n` = 그 파이프라인이 보내는 명령 수 **정확히**(INCRBY 자신과 EXPIRE 포함). 같은 파이프라인에 예산 키 `EXPIRE 40일`(인스턴스당 그달 1회).
- 응답의 INCRBY 값 = 그달 사용량. 이 값이 예산 이상이면 그 인스턴스는 그달 **KV 명령을 하나도 보내지 않는다**: POST → `204`(저장 안 함), GET → 캐시 본문 또는 `budget_reached`. 달이 바뀌면(KST 1일 0시) 새 키로 다시 시작.
- 파이프라인 안 명령이 하나씩 과금되는지 Upstash 문서에 명시가 없다("pricing is based on per command/request") → **하나씩 센다고 가정**(보수적). Upstash 콘솔의 실제 사용량이 우리 카운터보다 크면 이 가정이 틀린 것.
- 넘침 한계: 예산 도달을 아직 모르는 인스턴스(콜드 스타트)는 첫 요청 1회만큼 더 쓴다 — 요청 1회 ≤ 105 명령(아래). 인스턴스가 수십 개여도 수천 명령 = 남은 100K 여유 안.

**최악 계산** (이벤트 1개가 만드는 `HINCRBY` 필드 최대 5개 = 실패한 `room_join`: n·fail·ms·reason·app; `err`는 필드 3 + 문구 1):
| 요청 | 명령 수 |
|---|---|
| POST (이벤트 k개) | `INCRBY` 1 + `_total` 1 + 필드 ≤ 5k + `EXPIRE` ≤ 3(예산·날짜·오류 키, 인스턴스당 처음만) → k=20이면 **≤ 105**, 보통 이벤트 1개 = 3–5 |
| GET (캐시 안 맞음) | `INCRBY` 1 + `HGETALL` 2 (+`EXPIRE` 1) = **3–4** |
| GET (캐시 맞음) · 예산 도달 후 모든 요청 · 유효 이벤트 0개 POST | **0** |

- 쓰기: 하루 ≤ 1500 이벤트 × 5 + 요청 ≤ 1500 × 2(INCRBY·_total) ≈ **10,500/일 → 31일 ≈ 326K** (+ 일일 상한 넘침 몇백). 실제 테스트 세션은 이벤트 수십 개 = 명령 수백 개.
- 읽기: 인스턴스당 오늘 30초 캐시 → 쉬지 않고 한 달 내내 폴링하면 2,880 × 3 ≈ 8.6K/일(≈ 268K/월). 지난 날은 인스턴스당 1회. Vercel CDN `s-maxage=30`이 반복 GET을 대부분 흡수할 것(미검증).
- 둘을 합친 최악은 400K를 넘을 수 있다 → 그때 예산이 멈춘다(그달 나머지 수집 중단 — 무료 유지가 우선). 평소 사용량은 GET의 `budget.used`로 본다.

**멈춘 뒤**: 앱에는 아무 영향 없음(텔레메트리는 응답을 기다리지 않는다). 오류 줄은 Vercel Logs에 계속 남는다(KV 안 씀). 다음 달 1일(KST)에 자동 재개. 예산을 바꾸려면 `EV_MONTHLY_BUDGET`(500000 미만으로).

## 6. 클라이언트 `snack-player/src/telemetry.ts`
연결: `main.tsx` — `telemetryEnabled()`일 때만 `configureTelemetry({ build })` + `installErrorBeacon(build)` (build id = `g` + 커밋 7자, `vite.config.ts`가 `VERCEL_GIT_COMMIT_SHA` → 로컬 git 커밋 → `dev` 순으로 정함; 서버의 `build` 형식 `[A-Za-z]…`에 맞추려고 `g`를 붙임). `LiveApp` — `roomJoin.ts`의 `joinTracker`가 시도마다 `room_join {ok, ms, reason?, app}` 1건(ms = `connect()`/`retry()` 호출 → 첫 `connected`, 실패면 → `failed`; 결과 전에 화면을 떠나면 안 보냄).
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
- **Upstash 명령 과금**: 무료 월 500K(가격 페이지 확인). pipeline 안 명령을 하나씩 세는지는 문서에 없음 → 하나씩 센다고 보고 KV 안 월 예산(§5a)으로 막았다. 콘솔 수치와 `budget.used` 비교로 확인할 것.
- Vercel 요청 로그의 IP 보관 정책, 함수 리전(KST 사용자 기준 지연), 인스턴스 수에 따른 메모리 제한기의 실효성.
