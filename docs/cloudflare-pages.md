# Cloudflare Pages — 사이트 + 통계 API 이전 (#75)

상태: **전환 완료 (2026-10-14, #100)**. 라이브 = `https://playsnack.pages.dev` (Cloudflare Pages + Pages Functions, 방 = 방 서버 `snack-room.playsnack.workers.dev`). `playsnack.vercel.app`은 2026-10-15 Vercel 프로젝트 삭제로 내려갔다(#107, `vercel.json` 제거). 배포는 **자동**: main에 머지되면 GitHub Actions(`.github/workflows/deploy-cloudflare.yml`)가 방 서버 → 사이트 순서로 배포하고 간단히 확인한다(#103). 수동 실행은 Actions 탭의 'Deploy to Cloudflare' → Run workflow.
시험 주소: **https://test.playsnack.pages.dev** (Pages 프로젝트 `playsnack`의 Preview 브랜치 `test`). 프로덕션(`playsnack.pages.dev`)은 아직 비어 있다(404).

## 1. 무엇이 어디에

| 위치 | 역할 |
|---|---|
| `wrangler.jsonc` (루트) | Pages 프로젝트 설정: `pages_build_output_dir = snack-player/dist`, `nodejs_compat`(api가 `node:crypto`·`Buffer` 사용). 비밀값은 여기 없음 |
| `scripts/pages-build.mjs` | `pnpm player:build` + 이 빌드에만 `VITE_ROOM_URL=wss://snack-room.playsnack.workers.dev` + `cloudflare/pages/*`를 `dist`에 복사. `PAGES_ROOM_URL=`(빈 값)이면 방 = 기존 MQTT 메시 |
| `cloudflare/pages/_redirects` | `vercel.json` rewrites와 같은 SPA 경로: `/p/*`, `/create`, `/stats` → 앱(200 rewrite, 주소 유지). 대상은 `/` — `/index.html`로 쓰면 Pages의 `.html` 제거 리다이렉트와 맞물려 무한 루프(wrangler가 경고하고 규칙을 버림) |
| `cloudflare/pages/_routes.json` | Functions는 `/api/ev`, `/api/room-result`, `/p/*`(링크 미리보기 메타, #106 — docs/link-previews.md)만. 정적 파일(JS·폰트·그림)은 Functions를 거치지 않아 Workers 무료 10만 요청/일을 안 쓴다 |
| `functions/p/[[path]].js` | `/p/*` HTML: 같은 index.html에 그 링크의 og:/twitter: 메타(HTMLRewriter). 한도 초과 시 fail open → `_redirects` 정적 rewrite로 앱은 그대로 |
| `functions/api/ev.js`, `functions/api/room-result.js` | Pages Functions. 로직 없음 — `api/ev.js` · `api/room-result.js`의 `createHandler`를 그대로 `api/_lib/pages.js` 어댑터로 감쌈 (Vercel과 한 소스) |
| `api/_lib/pages.js` | 어댑터: ① env = `context.env`의 문자열 값만(바인딩 제외), 한 객체에 복사해 isolate 안에서 제한기·캐시·메모리 저장소 상태 유지 ② 클라이언트 주소 = `cf-connecting-ip`만 신뢰 — 클라이언트가 보낸 `x-vercel-forwarded-for`/`x-forwarded-for`/`x-real-ip`는 지움(Vercel 밖에선 위조 가능, telemetry.md §5) — 여전히 메모리에서 해시만 ③ 공식 앱 목록: Workers는 런타임에 `index.json`을 못 읽으므로 함수가 번들(JSON import)해 `apps.js`의 `primeAppIds()`로 넣음 |
| `api/_test/pages.test.js` | 어댑터 단위 테스트(위조 헤더로 제한 회피 불가, env/상태, 함수 배선, appsKnown) |
| `api/_test/pages/register.js` | `node --import ./api/_test/pages/register.js --test api/_test/` = **기존 api/_test 전체를 어댑터 경유로** 재실행(resolve 훅이 `../ev.js`·`../room-result.js`를 감싼 모듈로 바꿈) |
| `snack-server/tools/pages-e2e.mjs` | 배포된 주소 점검(경로·API·두 브라우저 친구 방 입장 ×N·1:1 퀴즈 결과까지) |

개인정보·예산·봇 규칙은 핸들러 코드 그대로라 바뀌지 않는다(GPC/DNT 무시, 자동화 UA 무시, 일일 상한, 월 예산 `EV_MONTHLY_BUDGET`, 6h de-dup, 기기 HMAC). Upstash는 Vercel과 **같은 DB**를 쓴다 → 이전해도 숫자가 이어진다.

## 2. 배포 명령

wrangler는 `edge/room`에 4.136.3으로 고정돼 있다(`cd edge/room && pnpm install --ignore-workspace`). **반드시 저장소 루트에서** 실행(`functions/`와 `wrangler.jsonc`를 거기서 찾는다).

```bash
node scripts/pages-build.mjs                                    # dist + _redirects/_routes.json, 방 = 엣지
edge/room/node_modules/.bin/wrangler pages deploy --project-name playsnack --branch test      # 시험(Preview) → test.playsnack.pages.dev
node snack-server/tools/pages-e2e.mjs https://test.playsnack.pages.dev --joins 5            # 점검
```

프로덕션은 `--branch main`(프로젝트의 production 브랜치. 배포 뒤 `wrangler pages deployment list --project-name playsnack`에서 Environment = **Production**인지 확인). `--force`는 쓰지 않는다.

로컬: `edge/room/node_modules/.bin/wrangler pages dev --port 4570 --ip 127.0.0.1 --inspector-port 4571` (workerd에서 함수까지 실행; 확인됨: appsKnown 44, POST 200).

## 3. 1단계 검증 결과 (2026-10-14, 배포 `6902e900` = 커밋 c572a2d)

`node snack-server/tools/pages-e2e.mjs https://test.playsnack.pages.dev --joins 5` → **14/14**.

- `/`, `/p/tpl-tap-battle`, `/p/tpl-tap-battle?room=K7MNP2QRS4`, `/create`, `/stats` → 200 앱 · `/data/bite/index.json` → 200 JSON(44개)
- `GET /api/ev` → 200 `store: memory`, `appsKnown: 44` (비밀값이 없어 메모리 — 1단계는 이게 정상) · `GET /api/room-result`(없는 방) → 404 · 유효한 `POST` → 200 `{saved:true}`
- 친구 방 입장 ×5, 두 Chromium, 방 = `snack-room.playsnack.workers.dev`(WebSocket 호스트가 그것뿐임을 확인). 링크 열기 → 방에 들어감(ms):

| 회 | 방장(링크→방) | 친구(링크→방) | 친구(페이지 준비→방) |
|---|---|---|---|
| 1 | 1839 | 1337 | 1090 |
| 2 | 1183 | 1166 | 940 |
| 3 | 1038 | 1266 | 1026 |
| 4 | 945 | 1253 | 982 |
| 5 | 1288 | 1248 | 951 |
| 중앙값 | 1183 | 1253 | 982 |

  (앞선 배포 `d12bface`의 두 실행 10회: 방장 1054–2262, 친구 1125–1748. 첫 실행은 엣지 방이 결과를 POST할 거라 가정한 검사 탓에 13/14 → 검사를 아래 사실대로 고친 뒤 14/14.) 사무실 Mac의 headless Chromium 수치이며 폰/LTE 수치는 아니다.
- 1:1 기본 퀴즈를 실제 탭으로 결과 화면까지(두 브라우저 모두 `result`).
- 자동화 표시: Playwright가 `navigator.webdriver`를 켜 플레이어가 텔레메트리를 안 보냄 — 두 브라우저에서 `POST /api/ev` **0건** 확인. 서버도 자동화 UA를 버린다. 시험 주소는 비밀값이 없어 어차피 Upstash에 안 닿는다.

### ⚠ 이전 전에 정해야 할 것: 엣지 방은 결과 저장·게임 통계가 없다
엣지 방(`VITE_ROOM_URL`)에서는 엔진이 방 서버에서 돌고 엔진 훅이 연결돼 있지 않다(docs/edge-rooms.md "엣지 방에는 결과 저장·통계 비콘이 원래 없음"). 그래서 위 퀴즈에서 `/api/room-result` POST는 **0건**이었고, 메시 방이 방장 기기에서 보내던 `session_done`·`rematch`·`room_create`·`game_created`도 안 간다. 즉 지금 엣지 방으로 바꾸면 ① 친구 방 링크의 "지난 판 결과"가 사라지고 ② /stats의 "끝난 판" 숫자가 멈춘다. 방 서버가 결과를 직접 저장·보고하는 일은 이 이슈 범위 밖(#75 지시 3).

**추천: 사이트+API 이전과 방 전환을 나눈다.** 프로덕션 첫 배포는 `PAGES_ROOM_URL= node scripts/pages-build.mjs`(방 = 지금과 같은 메시, 결과·통계 그대로)로 하고, 방 서버가 결과·게임 통계를 보고하게 된 뒤 엣지 빌드로 다시 배포한다. (지금 그대로 엣지로 가도 되면 이 단계만 건너뛰면 된다.)

## 4. 주인이 할 일

### 4a. 비밀값 3개 (Vercel과 같은 값)
Vercel 비밀값은 읽을 수 없으니 Vercel → Settings → Environment Variables에서 값을 복사하거나 Upstash 콘솔에서 가져온다. **EV_DEVICE_SALT는 Vercel과 같은 값이어야 한다**(다르면 기기 수가 처음부터 다시 세어짐). 루트에서:

```bash
edge/room/node_modules/.bin/wrangler pages secret put UPSTASH_REDIS_REST_URL   --project-name playsnack
edge/room/node_modules/.bin/wrangler pages secret put UPSTASH_REDIS_REST_TOKEN --project-name playsnack
edge/room/node_modules/.bin/wrangler pages secret put EV_DEVICE_SALT           --project-name playsnack
```

각 명령이 값을 물어본다(화면·셸 기록에 안 남음). 선택: `EV_DAILY_CAP`, `EV_MONTHLY_BUDGET`(Vercel에 넣어 둔 게 있으면 같은 값).
- 이 wrangler(4.136.3)의 `pages secret put`에는 환경 선택이 없어 **Production에만** 들어간다. 그래서 `test` 같은 Preview 배포는 계속 `store: memory` — 시험 트래픽이 진짜 통계에 섞이지 않으니 **이대로 두는 걸 추천**.
- 비밀값은 다음 배포부터 적용된다 → 넣은 뒤 프로덕션 배포(아래 5) 후 `curl -s https://playsnack.pages.dev/api/ev | grep -o '"store":"[a-z]*"'` → `"store":"kv"`.
- 무료 한도: 같은 Upstash 월 예산(`stats:budget:<월>`)을 Vercel과 **함께** 센다(키가 같음). 이전 기간에 두 사이트가 동시에 받아도 예산 가드는 하나.

### 4b. 자동 배포 — 추천: GitHub Actions + wrangler
`playsnack` 프로젝트는 Direct Upload(wrangler)로 만들어졌다. Cloudflare 문서상 Direct Upload 프로젝트는 나중에 Git 연동으로 바꿀 수 없고 새 프로젝트를 만들어야 한다("Direct Upload … you cannot switch to Git integration later" — 문서 기준, 직접 시험 안 함). 그래서 Git 연동 대신 **main 머지 때 GitHub Actions가 `scripts/pages-build.mjs` + `wrangler pages deploy --branch main`을 돌리는 것**을 추천한다(공개 저장소 Actions 무료, Pages 무료 빌드 횟수도 안 씀).
필요한 것(주인): Cloudflare → My Profile → API Tokens → "Cloudflare Pages: Edit" 권한 토큰 생성 → GitHub 저장소 Settings → Secrets → `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`(= `d9a206950fe989949f6031fc4fb49812`). 워크플로 파일은 2단계에서 추가(비밀값 없이 main에 넣으면 매 머지마다 실패하므로 지금은 안 넣음). 그 전까지는 위 2의 수동 명령.

## 5. 전환(cut-over) 계획

1. 4a 비밀값 → `node scripts/pages-build.mjs`(3의 추천대로면 `PAGES_ROOM_URL=` 붙여서) → `wrangler pages deploy --project-name playsnack --branch main` → `pages-e2e.mjs https://playsnack.pages.dev`(+ `/api/ev` `store: kv` 확인) → 폰으로 친구 방 1판.
2. **엣지 방 콘텐츠 주소**: `edge/room/wrangler.jsonc`의 `PACK_BASE_URL`이 `https://playsnack.vercel.app/data/multi-content`다. Vercel을 리다이렉트로 바꾸기 **전에** `https://playsnack.pages.dev/data/multi-content`로 바꿔 `wrangler deploy`(edge/room). 안 하면 엣지 방 라운드 콘텐츠가 리다이렉트를 타거나 끊긴다.
3. Vercel → 리다이렉트: `vercel.json`을 `{"redirects":[{"source":"/(.*)","destination":"https://playsnack.pages.dev/$1","permanent":false}]}`로(쿼리 `?room=`은 Vercel이 그대로 붙임 → `/p/<slug>?room=<code>` 공유 링크 유지). 처음엔 `permanent:false`(307)로 두고 1–2주 문제 없으면 308. 이미 열린 옛 탭의 `/api/ev` 비콘은 리다이렉트를 따라가지 않을 수 있다(sendBeacon) — 몇 건 손실, 허용.
4. 확인: `curl -sI https://playsnack.vercel.app/p/tpl-tap-battle?room=K7MNP2QRS4` → `location: https://playsnack.pages.dev/p/tpl-tap-battle?room=K7MNP2QRS4`; /stats 숫자가 이전과 이어지는지.

**되돌리기**
- 방만 문제: `PAGES_ROOM_URL= node scripts/pages-build.mjs` → 프로덕션 재배포(방 = 메시). 수 분.
- Pages 배포 자체가 문제: 대시보드 → Pages → playsnack → Deployments → 이전 배포 "Rollback"(무료), 또는 이전 커밋에서 빌드해 재배포.
- 전부: `vercel.json` 리다이렉트 커밋을 되돌리면 Vercel 사이트가 그대로 돌아온다(Vercel 쪽 비밀값·함수는 지우지 않고 둔다). Upstash가 같아 통계는 끊기지 않는다.

## 6. 무료 한도 메모
- Pages 정적: 요청 무제한. `_routes.json` 덕분에 정적 파일은 함수 호출 0.
- `/p/*` 페이지 열기 1번 = 함수 요청 1건(#106 링크 미리보기; 사람·크롤러 모두). 하루 5천 번 열면 5%. 넘으면 fail open(정적 rewrite, 미리보기만 기본) — docs/link-previews.md §5.
- Functions = Workers 요청 **10만/일**, **엣지 방 서버(snack-room)와 공유**(edge-rooms.md 무료 표). `/api/ev`는 페이지당 비콘 몇 건 + /stats 읽기; 지금 규모에선 여유지만, 방 서버 사용량(`GET https://snack-room.playsnack.workers.dev/usage`)과 합쳐서 본다. 넘으면 그날 함수가 에러 → 텔레메트리는 응답을 안 기다리므로 앱 동작엔 영향 없음.
- Cloudflare 자체 요청 로그(IP 포함 가능)는 이 코드 밖이다(Vercel과 같은 성격, telemetry.md §8).
