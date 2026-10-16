# 링크 미리보기 (Open Graph · #106)

카카오톡·iMessage·Slack·Discord 등에 `https://playsnack.pages.dev/...` 링크를 붙이면 보이는 카드(제목·설명·그림).

## 1. 무엇이 어디에

| 위치 | 역할 |
|---|---|
| `snack-player/index.html` `<!-- og:begin … og:end -->` | 사이트 기본 메타(`/`, `/create`, `/stats`, 모르는 링크). **손으로 고치지 않는다** — `scripts/og-images.mjs`가 쓴다 |
| `snack-player/public/og/default.png` | 1200×630 기본 카드(검정 + 라임 "PlaySnack" 픽셀 마크 + Pretendard 700 "친구랑 바로 한 판" + 게임 이모지 5개) |
| `snack-player/public/og/square.png` | 600×600 정사각 대체 그림(두 번째 `og:image`, 기본 카드에만) |
| `snack-player/public/og/app/<id>.png` | 앱마다 1200×630(카탈로그 44개: 이모지 블록 · 카테고리 칩 · 제목 · 라임 CTA). 합계 약 2.2 MB |
| `snack-player/public/og/manifest.json` | 그림마다 `v`(그림을 만든 입력의 해시) → 이미지 주소 `?v=`(카카오는 이미지를 URL로 캐시) |
| `scripts/og-images.mjs` | 그림 생성(Playwright Chromium으로 HTML 템플릿 캡처, 번들 폰트 `pretendard-700-full`·`galmuri11-bold-full`). `--check` = 모든 카탈로그 앱에 그림·manifest 항목·크기·index.html 블록이 맞는지(gate-all `og-images` 단계) |
| `functions/p/[[path]].js` | Pages Function: `/p/*`에 같은 `index.html`(`ASSETS.fetch("/")`)을 주되 HTMLRewriter로 `<title>`·`og:*`·`twitter:*`·canonical을 그 링크 것으로 바꿈 |
| `api/_lib/og.js` | 순수 로직(슬러그 → 메타, 방 조회, 이름 정리, 핸들러). 테스트 `api/_test/og.test.js` |
| `scripts/og-check-url.mjs` | 떠 있는 사이트를 카카오 UA로 `/` + 앱 44개 점검(제목, 이미지 200 PNG 1200×630) |
| `cloudflare/pages/_routes.json` | `include`에 `/p/*` 추가(HTML만; `/og/*`·`/assets/*` 등 정적 파일은 그대로 함수 0) |

그림 다시 만들기(카탈로그 제목·이모지·카테고리·모드가 바뀌거나 디자인을 고쳤을 때 — 디자인을 고치면 스크립트의 `DESIGN` 값을 올린다):

```bash
node scripts/og-images.mjs          # 그림 + manifest + index.html 블록
node scripts/og-images.mjs --check  # 확인만
```

**Mac에서 만든다.** 이모지는 OS 이모지 폰트(Apple Color Emoji)로 그려진다 — 카드를 가장 많이 볼 iPhone과 같은 모양. 그림은 커밋해 두므로 배포 빌드는 브라우저가 필요 없다.

## 2. 링크별 메타

| 링크 | og:title | og:description | og:image |
|---|---|---|---|
| `/` (정적) | PlaySnack · 친구랑 바로 한 판 | 설치·가입 없이 링크만 열면 바로 시작하는 월드컵·퀴즈·게임. … | `default.png` (+ `square.png`) |
| `/p/tpl-worldcup-food` | 야식 월드컵 — 친구랑 같이 골라 봐요 | 설치·가입 없이 링크만 열면 바로 시작해요. … | `og/app/worldcup-food.png` |
| `/p/tpl-tap-battle` (같이) | 탭 배틀 — 한 판 붙어 볼래? | 링크를 받은 친구들과 같은 방에서 바로 시작해요. … | `og/app/tap-battle.png` |
| `/p/<앱>?room=<코드>` | (앱 제목) | 친구가 방에 초대했어요. 링크를 열면 같은 방으로 바로 들어가요. | 앱 그림 |
| `/p/tpl-speed-trivia-score?room=<코드>` (나 맞히기) | 나 맞히기 퀴즈 — 나를 얼마나 알까? | 친구가 방에 초대했어요. … | `og/app/speed-trivia-score.png` |
| `/p/tpl-speed-quiz` (스피드 퀴즈: 같은 템플릿·기본 문제, #210) · 코드 없는 `/p/tpl-speed-trivia-score`도 이 카드(앱이 이리로 보냄) | 스피드 퀴즈 — 한 판 붙어 볼래? | 링크를 받은 친구들과 같은 방에서 바로 시작해요. … | `og/app/speed-quiz.png` |
| `/p/tpl-speed-trivia-score?room=<코드>` + 방에 지난 판 결과 있음 | 민수 맞히기 · 나를 얼마나 알까? | 민수님에 대한 퀴즈예요. … | 앱 그림 |
| `/p/tpl-race-tap` (합쳐진 앱) | 탭 배틀 — … | | `tap-battle.png` |
| `/p/app-<hash>`, 모르는 슬러그 | 기본값 | 기본값 | `default.png` |

- 태그라인은 카테고리별 한 줄(`api/_lib/og.js` `TAGLINE`). 카탈로그에 설명 필드가 없어서다.
- `og:url`은 요청 주소의 origin + `/p/<slug>` + (유효한 방 코드면) `?room=` — 다른 쿼리는 버린다. 방 코드를 버리면 Facebook류가 og:url을 정식 주소로 써 친구 방이 아닌 공개 방으로 보낼 수 있어서 남긴다. 이미지도 요청 origin 기준이라 `test.playsnack.pages.dev` 미리보기 배포는 자기 그림을 가리킨다.
- **이름 이스케이프**: `<title>`은 `setInnerContent`(텍스트 모드)가 `& < >`를 이스케이프. `setAttribute`는 workerd에서 `"`만 이스케이프함을 확인(`<b>"x"&` → `<b>&quot;x&quot;&`) → `attrValue()`가 `& < >`를 먼저 이스케이프. 이름은 한 줄·제어/양방향 문자 제거·20자.

### 친구 방 퀴즈 제목 (crawler 전용, 막지 않음)
- 조건: 앱 = `speed-trivia-score`, `?room=`이 유효한 코드, User-Agent가 미리보기 크롤러(`PREVIEW_BOT_RE`: facebookexternalhit·kakaotalk-scrap·Slackbot·Twitterbot·Discordbot·TelegramBot·WhatsApp…). 사람 브라우저는 조회하지 않는다(방 서버 요청을 쓰지 않음, 페이지 지연 0).
- `GET https://snack-room.playsnack.workers.dev/room/tpl-speed-trivia-score~<CODE>/result`(docs/edge-rooms.md) — **300 ms** 안에 안 오면 포기(앱 기본 카드), isolate 메모리에 60초 캐시(없음도 캐시, 시간 초과는 캐시 안 함). 환경 변수 `ROOM_HTTP_URL`로 주소 변경 가능(로컬 시험용).
- 결과 본문에서 **`about`만** 읽는다. 문제·보기·정답·고른 답(quizRecap)·점수판은 메타에 절대 안 들어간다(가짜 방 서버가 `SECRET` 문제/정답을 줘도 HTML에 0건 — 아래 4).
- 한계: 방에 **한 판이 끝난 뒤에만** 결과가 있다(엣지 방, 7일). 퀴즈를 만들고 첫 판 전에 보낸 링크는 앱 기본 카드("스피드 퀴즈 — …")다. 메시 방(`PAGES_ROOM_URL=` 빌드)의 결과(`/api/room-result`, Upstash)는 조회하지 않는다.
- 방별 그림은 만들지 않는다(런타임 렌더링 = Workers Free CPU 10 ms 초과 위험).

## 3. 카카오톡

**권장 크기·자르기** — 카카오 데브톡(공식 운영 포럼)의 스크랩 점검 목록: "이미지는 800X400 사이즈에 최적화 되었습니다. 가로:세로 = 2:1", "스크랩 시, 스마트 크롭이라는 내부 API가 800X400사이즈로 변환합니다", "인물이 포함된 경우, 스마트 크롭이 크롭 위치를 따로 선정하는 경우도 있습니다", "해당 기능을 조절하는 별도 옵션은 없습니다". 스크랩 가능한 이미지는 JPG/PNG. 출처: https://devtalk.kakao.com/t/scrap-url/116202
→ 우리 그림은 1200×630(1.905:1). 2:1로 자르면 위아래 15 px씩만 잘린다 — 모든 글자·블록은 위아래 50 px 이상 안쪽에 있다. 사람 얼굴이 없어 스마트 크롭이 위치를 바꿀 일도 없다. 정사각 대체(`square.png`)는 두 번째 `og:image`로만 넣었다(카카오는 첫 번째를 쓴다; 정사각 썸네일을 쓰는 다른 앱용).

**캐시** — "같은 URL은 최소 1시간 캐시", 이미지는 카카오 서버에 수 시간 + 기기에도 캐시(https://devtalk.kakao.com/t/scrap/33984). 스크랩 UA: `facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984`.

**미리보기 새로고침(주인이 할 일, 필요할 때만)**
1. 카카오계정으로 https://developers.kakao.com 로그인 → [도구] → **공유 디버거** / 카카오톡 URL 메타정보 관리(https://developers.kakao.com/tool/debugger/sharing) → URL 입력 → [메타 정보 조회] → [캐시 초기화](https://developers.kakao.com/docs/ko/tool/common: "URL의 OG 태그를 변경한 경우, 카카오 서버에 캐시된 스크랩 미리보기 정보를 초기화해야 이후 공유 시 변경 내용이 반영됩니다.").
2. 주소 변형마다 따로 캐시된다(끝 `/` 유무, 프로토콜 생략 — https://devtalk.kakao.com/t/url-og/151203). 바꾼 주소 변형을 모두 초기화.
3. **그림**은 `?v=`가 바뀌므로(manifest) 새 그림은 새 URL — 서버 이미지 캐시 문제 없음(데브톡이 권하는 cache busting, https://devtalk.kakao.com/t/topic/33298). 기기에 남은 옛 그림은 카카오톡 설정 > 데이터 및 저장공간 > 임시 데이터 삭제.

**앱 키 필요?** 아니요(평범한 URL 미리보기). 스크랩은 "사용자가 카카오톡 채팅방에 URL을 입력하거나 공유 기능을 사용할 때" 카카오 스크랩 서버가 원 페이지를 직접 방문해 OG 태그를 읽는 방식이다(https://devtalk.kakao.com/t/scrap/33984) — 우리 쪽 SDK·앱 키가 끼지 않는다. 앱 키는 카카오톡 공유(Kakao SDK `Share`) 버튼을 붙일 때만 필요하다. (문서가 "앱 키 불필요"를 문장으로 말하지는 않음 — 위 동작 설명에서 나온 결론. 공유 디버거 도구 자체는 개발자 사이트 로그인이 필요.)

## 4. 검증 (2026-10-14, 로컬)

- `node --test api/_test/og.test.js` 12/12 (슬러그→제목/설명/그림, 44개 전부 자기 그림, 합쳐진 앱, 모르는 슬러그·만든 앱·`/` → 기본값, 요청 origin, 방 코드/옛 `?room=`, 퀴즈 방 이름, 이름 정리·이스케이프, 방 조회 캐시/시간 초과(300 ms+여유 안에 포기, 캐시 안 함)/오류/이상한 본문/잘못된 코드, 크롤러 판별, index.html 태그 전부 존재·앱 링크는 정사각 제거).
- `wrangler pages dev`(4630) + 가짜 방 서버(4633, `ROOM_HTTP_URL`)에 `curl -A "facebookexternalhit/1.1"` / 카카오 UA:
  - `/p/tpl-speed-trivia-score?room=ABCDEFGH2345`(가짜 결과 about = `<b>"민수"&</b>`, quizRecap에 `SECRETQ`/`SECRETA`) → `<title>&lt;b&gt;"민수"&amp;&lt;/b&gt; 맞히기 · 나를 얼마나 알까?</title>`, `og:title content="&lt;b&gt;&quot;민수&quot;&amp;&lt;/b&gt; 맞히기 …"`, HTML에 `SECRET` 0건.
  - 같은 링크를 iPhone 카카오톡 인앱 브라우저 UA로 → 방 서버 조회 0건, 앱 기본 카드.
  - 1.5초 걸리는 방 → 응답 0.31 s, 앱 기본 카드.
  - `node scripts/og-check-url.mjs http://127.0.0.1:4630` → 45/45(`/` + 44 앱, 이미지 200 image/png 1200×630).
  - 브라우저(Playwright)로 `/p/tpl-worldcup-food`, `/p/tpl-quiz-ox?room=…` → 앱 캔버스 정상, 페이지 오류 0.
- 실제 카카오톡/iMessage 카드 확인은 배포 뒤(아래 5).

## 5. 배포 메모

- 배포는 평소대로(`node scripts/pages-build.mjs` → `wrangler pages deploy`). 그림은 `public/og`에 커밋돼 있어 빌드에 그대로 들어간다.
- 배포 뒤: `node scripts/og-check-url.mjs https://playsnack.pages.dev` → 공유 디버거에서 `https://playsnack.pages.dev/`, `https://playsnack.pages.dev/p/tpl-worldcup-food` 조회(전에 공유된 적 있으면 캐시 초기화) → 카카오톡 나와의 채팅에 링크 붙여 확인.
- **무료 한도**: `/p/*` HTML 한 번 열 때마다 Function 요청 1건(사람·크롤러 모두; JS·폰트·그림은 정적이라 0). Workers Free 10만/일을 `/api/ev`·엣지 방 서버(`snack-room`)와 계정 단위로 공유. 퀴즈 친구 방 링크를 크롤러가 읽을 때만 방 서버에 +1(60초 캐시). 예: 하루 링크 열기 5천 번 = 5%.
- **한도를 넘으면**: Pages Functions 기본값 "fail open" — 함수를 건너뛰고 정적 파일로 넘긴다(https://developers.cloudflare.com/pages/functions/pricing/). 그래서 `_redirects`의 `/p/* / 200`을 남겨 두었다 → 앱은 그대로 열리고 미리보기만 기본 카드가 된다(이 동작은 문서 기준, 직접 한도를 넘겨 보지는 않음).
- 되돌리기: `_routes.json`의 `include`에서 `/p/*`를 빼고 재배포 → 이전과 똑같은 정적 rewrite(미리보기는 기본 카드).
