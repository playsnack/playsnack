# 익명 측정 (`/api/ev`) — Q0 레인 D

> 마스터 플랜 §4 Q0 레인 D(측정 기반) · §6 개인정보. Q2 레인 D(공유 ID `?s=`, 이벤트 10개 이하, 대시보드, 안내 페이지)가 이 위에 붙는다.
> 상태: 엔드포인트 + 클라이언트 + 테스트 완료. **앱에는 아직 연결 안 됨**(`telemetry.ts`는 새 파일, 호출부 없음).

## 1. 구성
| 파일 | 역할 |
|---|---|
| `api/ev.js` | Vercel 함수(Web 표준 `export default { fetch }`). POST 수집 · GET 집계 |
| `api/_lib/schema.js` | 이벤트 화이트리스트 · 정규화 · 오류 문구 정화 · ms 히스토그램 |
| `api/_lib/store.js` | Upstash Redis REST(`/pipeline`) 어댑터 + 메모리 대체 |
| `api/_lib/ratelimit.js` | 저장 없는 속도 제한 |
| `api/_lib/apps.js` | 공식 앱 ID 목록(`snack-server/data/bite/index.json`) |
| `api/_lib/day.js` | KST 날짜 |
| `api/_test/*.test.js` | `node --test api/_test/` (19개) |
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
| `room_join` | `ok`: bool, `ms?`, `app?` | `room_join|n`, `room_join|ok`/`fail`, `room_join_ms|ok|<bucket>`, `room_join|app|<app>` |
| `err` | `msg`, `where?`, `build?` | `err|n`, `err|where|<w>`, `err|build|<b>` + 정화된 문구 1건(`ev:<day>:err`) |

- 모르는 종류 · 잘못된 값의 이벤트는 버림(`dropped`로 개수만 응답), 모르는 필드는 무시.
- `app`이 공식 템플릿 목록에 없으면 `other`. `where`(≤24자)·`build`(≤16자)는 `[A-Za-z][A-Za-z0-9_.-]*` 아니면 `other`.
- ms 버킷: `le100 le250 le500 le1000 le2000 le4000 le8000 le15000 le30000 gt30000`.
- 응답: `200 {ok, accepted, dropped}` · `413` 본문 >4096바이트(스트림도 4096에서 끊음) · `400` JSON 오류/`v≠1`/이벤트 >20개 · `429` 속도 제한(`rate_limited`/`daily_cap`) · `503` KV 실패 · `405` 기타 메서드.

### GET `/api/ev?day=YYYY-MM-DD`
기본값 = 오늘(KST). 읽기 전용, 인스턴스 메모리 30초 캐시 + `cache-control: public, max-age=30, s-maxage=30`.
```json
{ "ok": true, "v": 1, "day": "2026-10-12", "store": "kv", "appsKnown": 44, "total": 8,
  "counters": { "open": { "n": 2, "route": { "app": 1 }, "app": { "quiz-ox": 1 } },
                "room_join_ms": { "ok": { "le2000": 1 } } },
  "errors": { "distinct": 1, "top": [ { "msg": "TypeError: x is undefined", "count": 1 } ] } }
```
모든 응답에 `x-ev-store: kv|memory` 헤더. `appsKnown`이 0이면 함수 번들에 `index.json`이 안 들어간 것(§8).

## 3. 저장 키 (Upstash Redis)
- `ev:<KST날짜>` 해시: 위 카운터 + `_total`(그날 받은 이벤트 수, 일일 상한용).
- `ev:<KST날짜>:err` 해시: 정화된 오류 문구 → 횟수.
- 90일 만료(`EXPIRE`, 인스턴스당 키별 하루 1회만 보내 명령 절약). **원시 이벤트 로그 없음.**
- 쓰기 1회 = `/pipeline` 1요청(`HINCRBY` 여러 개 + 필요 시 `EXPIRE`). 읽기 = `HGETALL` 2개.
- 환경변수가 없으면 인스턴스별 메모리(재시작 · 인스턴스 간 공유 안 됨, 개발 · 미설정 상태용).

## 4. 개인정보 보장 (마스터 플랜 §6)
- 서버는 IP · UA · 쿠키 · 닉네임 · 기기/세션 ID를 **저장 · 기록 · 전송하지 않는다.** 저장되는 건 위 화이트리스트 카운터와 정화된 오류 문구뿐.
- 오류 문구 정화(`sanitizeErr`): 따옴표 문자열 → `<str>`, URL → `<url>`, 이메일 → `<email>`, `key=value`의 값 → `=<v>`, `/`가 든 토큰(경로 · UA 제품 토큰) → `<path>`, 비ASCII(한글 닉네임 등) → `?`, 8자 이상 hex → `#`, 숫자 → `#`, 100자 제한.
- 클라이언트: 쿠키 · localStorage · ID 없음, fetch 대체 경로는 `credentials: 'omit'`. DNT · GPC가 켜져 있으면 강제 활성화(`enabled: true`)도 무시하고 꺼짐.
- 테스트(`api/_test/privacy.test.js`): 가짜 IP · UA · 닉네임 · 쿠키 · 기기 ID를 헤더와 이벤트 필드 · 오류 문구에 넣어 보내고, **가짜 Upstash가 받은 URL · 헤더 · 명령 전부, 저장 내용, 메모리 저장소, 제한기 키, 콘솔 출력, GET 응답** 어디에도 없음을 확인. (이 테스트가 UA 문자열이 오류 문구에 섞이면 새는 문제를 실제로 잡았고, `<path>` · `=<v>` 규칙으로 고쳤다.)
- 한계: `sendBeacon`은 브라우저 규칙상 같은 출처 쿠키를 붙일 수 있다 — 사이트가 쿠키를 만들지 않고 서버가 `Cookie` 헤더를 읽지 않는다. Vercel 플랫폼 자체의 요청 로그(IP 포함 가능)는 이 코드 밖이다(§8).

## 5. 속도 제한 (아무것도 저장 안 함)
1. 클라이언트별 토큰 버킷(인스턴스 메모리): 키 = `SHA-256(인스턴스 랜덤 솔트 + KST날짜 + 주소)` 앞 24자. 주소(`x-vercel-forwarded-for` → `x-forwarded-for` 첫 값 → `x-real-ip`)는 메모리에서 해시만 하고 저장 · 기록하지 않는다. 날짜가 바뀌면 솔트 재생성 + 버킷 비움. 기본 버스트 20, 초당 0.5 충전(분당 30). 최대 1만 키.
2. 인스턴스 분당 600요청.
3. 일일 이벤트 상한 `EV_DAILY_CAP`(기본 20000): 쓰기마다 돌려받는 `_total`로 판단 → 넘으면 그날 `429 daily_cap`. 인스턴스별로 마지막 본 값을 쓰므로 약간 넘칠 수 있다.

## 6. 클라이언트 `snack-player/src/telemetry.ts`
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
2. Vercel 프로젝트 `playsnack` → Settings → Environment Variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (Vercel 마켓플레이스 연동이 만드는 `KV_REST_API_URL` / `KV_REST_API_TOKEN`도 인식). 선택: `EV_DAILY_CAP`.
3. 재배포 후 `curl -i https://<배포>/api/ev` → `x-ev-store: kv`, `appsKnown: 44` 확인.
4. 빌드에서 끄려면 `VITE_TELEMETRY=off`.

## 8. 미검증 (프리뷰 배포가 있어야 확인 가능)
- **`/api` 자동 인식**: `framework: null` + `outputDirectory: snack-player/dist`에서 루트 `api/ev.js`가 함수로 배포되는지, `api/_lib/` · `api/_test/` **디렉터리**가 함수로 안 잡히는지(문서는 `_` 파일만 명시).
- **`index.json` 번들 포함**: `readFileSync(new URL('../../snack-server/data/bite/index.json', import.meta.url))`가 파일 추적에 잡히는지. 안 잡히면 모든 앱이 `other`가 되고 GET의 `appsKnown`이 0 — 그때 `vercel.json`의 `functions["api/ev.js"].includeFiles` 추가 필요(레인 범위 밖).
- **실제 Upstash 응답**: `/pipeline` 응답 형식(`[{result}|{error}]`)과 `HGETALL` 결과(평탄 배열)는 문서 기준 가짜로만 테스트했다.
- **Upstash 명령 과금**: 무료 한도(마스터 플랜 표: 월 50만 명령, 확인 필요)가 pipeline 안 명령 하나하나를 세는지. 이벤트 1개 ≈ 명령 2–3개(배치 내 같은 필드는 합쳐짐)라 기본 상한 20000 이벤트/일을 매일 채우면 월 100만+ 명령이 될 수 있다 → 실제 과금 확인 전에는 `EV_DAILY_CAP=5000` 정도 권장.
- Vercel 요청 로그의 IP 보관 정책, 함수 리전(KST 사용자 기준 지연), 인스턴스 수에 따른 메모리 제한기의 실효성.
