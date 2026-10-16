# Bite 포맷 스펙 v1

> PlaySnack의 자체 엔진 **Bite**가 읽는 앱 문서 포맷. 파일 = `*.bite.json`.
> 엔진 = 런타임(`@snack/bite`) · 레이아웃(`@snack/bite-layout`) · 렌더링(`@snack/bite-pixi`). 셋이 같은 **노드** 트리를 공유한다.

## 0. 설계 원칙
1. **상태는 변수에만 있다.** 화면은 변수의 함수다. 노드를 직접 바꾸는 액션은 없다 — 노드 속성에 식을 걸고 변수를 바꾼다.
2. **식은 어디서나 같은 규칙.** 함수는 전부 bare(`round(x)`)로 쓴다. 틀린 식은 앱을 죽이지 않는다(값 = `undefined`, 경고 로그) — 그리고 검증기가 미리 잡는다.
3. **AI가 틀리기 어려운 모양.** 키 이름은 짧고 하나의 뜻만. 같은 것을 두 가지로 쓰는 방법을 두지 않는다(예외: 호환 별칭은 §4.4에 명시).
4. **결정적 실행.** 시간(`now`)과 난수(`random`)는 호스트가 주입한다 → 시뮬레이션/게이트에서 재현 가능.

## 1. 문서 구조
```json
{
  "bite": 1,
  "meta":  { "name": "두더지 잡기", "multi": false },
  "frame": [390, 844],
  "vars":  { "score": 0, "moleX": 40, "startedAt": 0, "history": [] },
  "data":  { "url": "/api/content?kind=quiz&theme=상식" },
  "components": { "StatCard": { "props": { "label": "", "value": "" }, "view": { } } },
  "start": "ready",
  "phases": { "ready": { }, "play": { }, "result": { } },
  "view":  { }
}
```
| 키 | 필수 | 설명 |
|---|---|---|
| `bite` | ✓ | 포맷 버전. 현재 `1` |
| `meta` | ✓ | `name`(표시 이름), `multi`(멀티플레이 앱 여부, 기본 false) |
| `frame` | ✓ | 논리 해상도 `[너비, 높이]` px. 기본 `[390, 844]`. 기기 화면에 맞춰 균등 스케일 |
| `vars` | ✓ | 변수 → 초기값. 타입은 초기값으로 정해짐(number/string/boolean/array/object) |
| `data` | | 동적 콘텐츠. 호스트가 마운트 시 `url`을 fetch → 응답 JSON의 키 중 `vars`에 있는 것만 덮어씀 |
| `room` | | 같이 하는 앱: `{ start, autoStartMs? }` — 공개 방이 스스로 시작할 때 쓰는 `start` 페이로드와 대기 시간(§6.2) |
| `components` | | 재사용 노드 묶음(§5). 서버가 기본 라이브러리를 주입할 수 있음 |
| `start` | ✓ | 시작 페이즈 이름 |
| `phases` | ✓ | 페이즈(화면 흐름의 단계) 정의(§3) |
| `view` | ✓ | 루트 노드(§2). 크기는 `frame` |

**예약 이름**(변수로 선언 불가): `phase`, `now`, `props`, `item`, `index`, `true`, `false`, `null`, `undefined`, `Math`, 그리고 §4.3의 함수 이름(`min`, `pick`, `sum` 등).

## 2. 노드
노드는 **종류 키 하나**로 구분한다. 종류 키가 없으면 `box`(레이아웃 `column`).

| 종류 | 형태 | 용도 |
|---|---|---|
| box | `{ "box": "column", "children": [...] }` | 컨테이너·사각형·원. 값은 레이아웃 방향(§2.2) |
| text | `{ "text": "{score}점" }` | 텍스트. 값은 템플릿 문자열(§4.1) |
| image | `{ "image": "{item.img}" }` | 이미지. 값은 URL 템플릿 |
| use | `{ "use": "StatCard", "props": { ... } }` | 컴포넌트 인스턴스(§5) |

공통 키: `id`(선택, 문서 내 유일 — 편집·테스트·디버깅용, 없으면 경로로 자동 부여), `show`(식, 기본 true), `onTap`(액션 배열, §3.2), `each`(반복, §2.5).

### 2.1 크기·위치
| 키 | 값 | 설명 |
|---|---|---|
| `width`, `height` | 숫자 \| `"fill"` \| `"hug"` | fill = 부모의 남은 공간, hug = 항상 내용 크기. 미지정 = 주축은 내용 크기, 교차축은 부모 `align`이 stretch면 늘어남(기본) |
| `minWidth`, `minHeight`, `maxWidth`, `maxHeight` | 숫자 | |
| `grow` | 숫자 | 부모 방향으로 남는 공간 비율(flex-grow) |
| `x`, `y` | 숫자 | **`free` 부모 안에서만** 의미 있음(부모 기준 좌상단 좌표) |

### 2.2 레이아웃 (box의 값)
| 값 | 자식 배치 |
|---|---|
| `"column"` | 세로로 쌓기 |
| `"row"` | 가로로 쌓기 |
| `"grid"` | 격자. `columns`(열 수) 필수 |
| `"free"` | 자식을 각자의 `x`,`y`로 절대 배치(게임 필드 등) |

| 키 | 값 | 설명 |
|---|---|---|
| `gap` | 숫자 | 자식 사이 간격 |
| `pad` | 숫자 \| `[세로, 가로]` \| `[위, 오른쪽, 아래, 왼쪽]` | 안쪽 여백 |
| `align` | `start` `center` `end` `stretch` | 교차축 정렬. 기본 `stretch` |
| `justify` | `start` `center` `end` `between` | 주축 정렬. 기본 `start` |
| `columns` | 숫자 | grid 전용 |
| `scroll` | boolean | 넘치면 주축 방향 스크롤 (손가락 드래그 + 놓으면 관성으로 이어짐; PC는 마우스 휠·트랙패드·클릭 드래그 — 끝에 닿은 휠은 바깥 스크롤/페이지로 넘어감) |

### 2.3 모양·스타일
| 키 | 대상 | 값 |
|---|---|---|
| `fill` | box | 색 `"#rrggbb"` / `"#rrggbbaa"` |
| `gradient` | box | `{ "colors": ["#..", "#.."], "angle": 135 }` (선형, 각도 deg, 기본 180=위→아래) |
| `radius` | box, image | 숫자 \| `"full"`(원/알약) |
| `stroke` | box, image | `{ "color": "#..", "width": 1 }` |
| `shadow` | box, image | `{ "x": 0, "y": 4, "blur": 16, "color": "#d9ff0040" }` |
| `opacity` | 모두 | 0–1 |
| `rotate` | 모두 | deg |
| `scale` | 모두 | 숫자 |
| `origin` | 모두 | `[0–1, 0–1]` 회전/스케일 기준점, 기본 `[0.5, 0.5]` |
| `clip` | box | `true`(사각/radius로 자르기) \| `"circle"` |

### 2.4 텍스트·이미지 전용
| 키 | 값 |
|---|---|
| `font` | `body`(기본, Pretendard — 읽는 글, 한글 제목은 `weight: 700`) \| `display`(Galmuri11 픽셀 — 영문·숫자만 있는 텍스트: 점수·카운터·라틴 뱃지. 한글이 들어가거나 들어올 수 있는 텍스트엔 쓰지 않는다. 공식 템플릿은 `snack-player/test/displayFont.test.ts`가 검사) |
| `size` | 글자 크기 px. 기본 15 |
| `weight` | 100–900. 기본 500 (가까운 굵기로: body 400–900, display 400/700) |
| `color` | 글자 색. 기본 `#ffffff` |
| `align` (text) | `left` `center` `right` — text 노드에선 문단 정렬 의미 |
| `lines` | 최대 줄 수(넘치면 말줄임) |

텍스트 규칙: 줄바꿈은 공백 단위(한국어 keep-all), 한 단어가 줄보다 길면 글자 단위로 끊는다. `\n`은 강제 줄바꿈. 줄 높이 = 글자 크기 × 1.35(body) / 1.3(display). 폭 계산은 엔진에 포함된 폰트 메트릭으로 하므로 서버와 모든 기기에서 같다.
| `fit` (image) | `cover` `contain` |
| `focus` (image) | `center` `top` — cover로 자를 때 기준 |

### 2.5 반복 (`each`)
배열 변수를 노드로 펼친다.
```json
{ "box": "row", "gap": 6, "each": "history",
  "children": [ { "text": "{item.emoji}", "size": 17 } ] }
```
- `each`의 값 = 배열을 내는 식. 해당 box의 `children`이 **항목마다** 복제된다.
- 안쪽에서 `item`(현재 항목), `index`(0부터)를 쓸 수 있다.
- `onTap`도 항목별 `item`/`index`를 받는다.

### 2.6 터치 규칙
- 탭은 **`onTap`이 있는 노드만** 받는다. 손가락 위치를 포함하는 노드 중 화면 맨 위(나중에 그려진 것)에 있는, `onTap`을 가진 노드가 받는다.
- `onTap` 없는 노드는 터치를 통과시킨다 → 별도의 "터치 무시" 표시가 필요 없다.
- `show`가 false인 노드와 그 자식은 탭 대상이 아니다.

## 3. 페이즈와 액션
### 3.1 페이즈
```json
"phases": {
  "ready":  { "enter": [ { "set": "score", "to": "0" } ] },
  "play":   { "enter": [ { "set": "startedAt", "to": "now" } ],
              "tick":  [ { "if": "now - startedAt >= 20000", "then": [ { "go": "result" } ] } ] },
  "result": { }
}
```
| 키 | 실행 시점 |
|---|---|
| `enter` | 그 페이즈로 들어올 때 1회 |
| `tick` | 그 페이즈에 있는 동안 매 프레임 |

- 현재 페이즈 이름은 식에서 `phase`로 읽는다. 화면 전환은 보통 `"show": "phase == 'play'"`.
- `go`로 **현재와 같은 페이즈**를 지정하면 아무 일도 없다(enter 재실행 없음). 그래서 `tick`에서 조건 라우팅을 반복해도 안전하다.

### 3.2 액션
액션은 배열로 순서대로 실행된다. 한 액션 = 키 하나로 종류 구분.

| 액션 | 형태 | 설명 |
|---|---|---|
| set | `{ "set": "score", "to": "score + 1" }` | 변수에 식 결과 대입 |
| set (리터럴) | `{ "set": "picked", "value": [1, 2] }` | 식이 아닌 JSON 값을 그대로 대입 |
| go | `{ "go": "result" }` | 페이즈 전환. 남은 액션은 계속 실행된 뒤 전환 |
| if | `{ "if": "score >= 10", "then": [...], "else": [...] }` | 조건 분기, `else` 선택 |
| emit | `{ "emit": "vote", "payload": { "option": "{index}" } }` | 호스트(서버)로 이벤트 송신(§6). payload 문자열은 템플릿 |

- `set`의 대상은 `vars`에 선언된 변수만. 점 경로(`"set": "board.a"`)는 v1에서 지원하지 않음 — 배열/객체는 통째로 새 값으로 대입한다(`concat`, `with` 함수 사용).
- 한 프레임 안의 액션 결과는 즉시 다음 액션에 보인다. 화면 반영은 프레임 끝에 한 번.

## 4. 식
### 4.1 어디에 식이 들어가나
| 위치 | 해석 |
|---|---|
| `show`, `if`, `set.to`, `each` | **항상 식** (따옴표 없는 그대로) |
| 그 외 문자열 값 (`text`, `image`, `fill`, `color`, …) | **템플릿**: `{ }` 안만 식, 나머지는 글자 그대로. `"{score}점"` |
| 숫자/불리언 속성에 식이 필요할 때 | 값 전체를 `"{...}"` 하나로: `"width": "{progress * 300}"` → 결과를 숫자 그대로 사용 |

- 템플릿이 정확히 `{식}` 하나뿐이면 결과 타입을 유지한다(숫자는 숫자, 색은 문자열). 아니면 문자열로 이어붙인다.
- 글자 `{`를 쓰려면 `{{`.
- `set.to`에서 문자열을 넣을 땐 식 안의 따옴표: `"to": "'정답!'"`. 헷갈리면 `value`를 쓴다.

### 4.2 문법
jsep 기반의 JS 식 부분집합.
- 리터럴: 숫자, `'문자열'`/`"문자열"`, `true` `false` `null`, 배열 `[1, 2]`
- 이름: 변수, `phase`, `now`(ms), `props`, `item`, `index`
- 접근: `a.b`, `a[0]`, `a['k']`
- 연산: `+ - * / %`, `== != === !==`(둘 다 엄격 비교), `< <= > >=`, `&& || !`, `? :`
- 화살표 함수: `map`/`filter`/`find`/`some`/`every` 인자로만 — `scores.filter(s => s > 3)`
- **없음:** 대입, `new`, `this`, 전역 접근, 함수 정의, 임의 메서드 호출. 화이트리스트 밖은 검증 실패.

### 4.3 함수 (bare)
| 분류 | 함수 |
|---|---|
| 수학 | `round(x, 자리?)` `floor` `ceil` `abs` `min(...)` `max(...)` `pow` `sqrt` `clamp(x, lo, hi)` `lerp(a, b, t)` `remap(x, a1, b1, a2, b2)` |
| 난수 | `random()`(0–1) `randint(lo, hi)`(양끝 포함) `pick(arr)` `shuffle(arr)` |
| 배열 | `len(x)` `range(n)` `sum(arr)` `with(arr, i, v)`(i번째를 바꾼 새 배열) |
| 문자열 | `str(x)` `num(x)` `fmt(n)`(천 단위 콤마) `pad(n, 자리)` |
| 시간 | `elapsed(t)` = `now - t` |
| 해시 | `hash(x)` — 텍스트의 안정적인 32비트 정수(같은 이름 → 같은 아바타·색) |

### 4.4 메서드 화이트리스트
- 배열: `length` `concat` `slice` `join` `includes` `indexOf` `map` `filter` `find` `some` `every` `reverse`(복사본 반환) `sort`(복사본 반환)
- 문자열: `length` `slice` `includes` `split` `toUpperCase` `toLowerCase` `trim` `padStart`
- 숫자: `toFixed` `toLocaleString`
- **호환 별칭:** `Math.round` 등 `Math.`이 붙은 형태도 bare 함수와 같게 동작한다(AI가 습관적으로 붙여도 안 죽게). 검증기는 경고만 낸다.

### 4.5 오류 규칙
- 실행 중 식 오류 → 값 `undefined`, 콘솔 경고 1회(같은 식 반복 경고 없음). 앱은 계속 돈다.
- `undefined`인 `show`는 false, `text`는 빈 문자열, 숫자 속성은 그 속성의 기본값.

## 5. 컴포넌트
```json
"components": {
  "StatCard": {
    "props": { "label": "", "value": "" },
    "view": { "box": "column", "pad": 12, "radius": 14, "fill": "#16181c",
              "children": [ { "text": "{props.label}", "size": 13, "color": "#9aa3af" },
                            { "text": "{props.value}", "size": 22, "weight": 800 } ] }
  }
}
```
```json
{ "use": "StatCard", "width": "fill", "props": { "label": "점수", "value": "{score}" } }
```
- `props`의 기본값이 타입을 정한다. 인스턴스의 `props` 값은 템플릿 — **사용하는 쪽**의 스코프(vars, item 등)에서 평가된 뒤 넘어간다.
- 인스턴스에 준 크기/위치/`show`/`onTap`은 컴포넌트 루트에 적용된다.
- 컴포넌트 안에서는 `props`와 전역(`vars`, `phase`, `now`)만 보인다. 컴포넌트는 변수를 선언하지 않는다.

## 6. 호스트 연결 (멀티플레이·데이터)
런타임은 화면·네트워크를 모른다. 호스트(플레이어 앱)가 연결한다.

| 방향 | 방법 |
|---|---|
| 앱 → 서버 | `emit` 액션 → 런타임 `emit` 이벤트 `{ name, payload }` → 호스트가 WebSocket으로 송신 |
| 서버 → 앱 | 호스트가 `setVar(id, value)` / `setVars({ ... })` 호출 → 다음 프레임 화면 반영 |
| 동적 콘텐츠 | 호스트가 `data.url` fetch → `setVars(응답 중 vars에 있는 키)` |

- 서버가 쓰는 변수도 `vars`에 선언해야 한다(초기값 = 서버 응답 전 표시값). 선언 안 된 키는 무시.
- 멀티 앱의 페이즈 동기화는 서버가 변수(예: `session`)를 쓰고, 앱이 `tick`에서 `if` → `go`로 따라가는 방식.

### 6.1 방 액션 페이로드 계약 (`@snack/room/actions`)
`emit`의 `name`이 방 액션이면 `payload`는 방 엔진(`packages/snack-room/src/room.js`)이 읽는 모양이어야 한다 — 틀리면 방은 조용히 버린다(ack 없음). 계약의 단일 소스는 `packages/snack-room/src/actions.js`의 `HOST_ACTIONS`이고, `validate(doc, { hostActions: HOST_ACTIONS })`가 문서를 그 계약에 대조한다(§8). 계약과 방 엔진이 어긋나면 `packages/bite/test/contract.test.js`가 잡는다(모든 항목을 실제 `createRoom`에 통과시키고, 공식 템플릿 전부를 계약으로 검증).

| 액션 | 페이로드 | 필드 (`type`, 필수 여부) |
|---|---|---|
| `vote` | 객체 | `option` string·number **필수** — 선택지 키(예 `"o0"`) |
| `tally` | 객체 | `delta` number (없으면 +1) — `coopTotal`에 더한다. 협동 연타(coop-tap-goal)는 탭마다가 아니라 `taps`처럼 묶어서 보낸다(#190): 탭은 `myTaps`만 올리고(게이지는 `shownTotal`로 그 자리에서 움직임), `tick`에서 `myTaps > sentTaps && now - sentAt >= tapBatchMs`면 `delta = myTaps - sentTaps`, 결과 화면에 들어가면 남은 것을 한 번 더. 받는 때: 단일 플레이 창 판이면 `play` 중과 결과 뒤 `LATE_GRACE_MS`(2.5 s)까지만 — 카운트다운이나 그 뒤(대기실·다음 판)에 온 묶음은 `actionAck {accepted: false, reason: "closed"}`(지난 판 탭이 다음 판 합계에 섞이지 않음); 시간제 판을 한 번도 안 한 방은 언제든. `delta`는 정수로 내리고 메시지당 0–30(`TALLY_MAX_DELTA` = `TAP_RATE_MAX` × 2)으로 잘리며, 0이면 `reason: "invalid_delta"` |
| `score` | 객체 | `score` number **필수** (유한수가 아니면 버림) |
| `answer` | 객체 | `option` number **필수** — 0부터 세는 보기 번호(**그 라운드에 보인 순서**) · `ms` number — 이 기기가 잰 "문제 표시 → 탭" 시간(`tick`에서 새 `roundIdx`가 `roundAnswer < 0`으로 보이면 `seenAt = now`를 기록 → 탭 때 `now - seenAt`). 방장 검증: 숫자·0 이상·`answerMs + 500` 이하가 아니거나 없으면 **방장이 잰 경과 시간**을 쓴다(위조로 더 빨라질 수 없음), 방장이 본 경과 시간 + 50ms보다 느린 주장은 그 값으로 잘림, 소수는 반올림. 라운드당 1명 **선택 1개**, **라운드가 열려 있는 `play` 중에만**(로비·카운트다운의 답은 무시), 보기 범위 밖 `option`은 답으로 치지 않음, 퀴즈 주인공(`quizPack`을 보낸 사람)의 답은 무시. **바꾸기(#211)**: 첫 선택을 방이 받은 때부터 **`CHANGE_WINDOW_MS`(3초)** 동안은 다른 보기로 다시 보내면 선택이 바뀐다 — **방(서버) 시계**로 재고, 답 시간(`answerMs`)을 넘지 않는다(남은 시간이 3초 미만이면 그만큼). 그 뒤(또는 공개 뒤)의 바꾸기는 `actionAck {accepted: false, reason: "locked"}`이고 지금 선택(`myPick`)을 그 기기에 다시 보낸다. `n` number — 이 기기가 이번 라운드에 고른 횟수(1, 2, …); 방이 본 마지막 `n` 이하(늦게 다시 보낸 옛 선택)이거나 같은 보기면 `reason: "duplicate"`. 바꾼 선택의 `ms`는 **마지막 탭**의 시간이고(같은 검증), 바꾸기 전 선택보다 빠를 수 없다 — "아무거나 빨리 누르고 정답으로 바꾸기"는 이득이 없다. 바꾸기는 답한 수(`quizProgress`)·활동 점수를 다시 세지 않는다. `round` `sessionNo` number — 이 답이 어느 라운드(`roundIdx`)·어느 판(`sessionNo`)의 것인지; 다르면(늦게 다시 보낸 답) `actionAck {accepted: false, reason: "stale_round"}`. 받아들인 답(바꾸기 포함)은 그 사람의 모든 연결에 `myPick {sessionNo, round, option, ms, n, lockMs}`(플레이어별; `lockMs` = 보낸 때 방 시계로 남은 바꾸기 시간, 0 = 확정)로 돌려준다 — 새로고침·재입장·호스트 교대·방 서버 동면 뒤의 입장 `state`에는 **그때 남은** `lockMs`가 실린다(바꾸기 창은 라운드 시작 기준 상대 시각이라 스냅샷에 그대로 남는다). 점수 = 정답일 때 `max(100, 1000 − round(ms / answerMs × 800))`, 오답 0. 점수판(`raceBoard`)은 공개(reveal) 때 갱신. 공개 전에는 누구의 선택·바꾸기도 다른 사람에게 가지 않는다(자기 `myPick`만) |
| `quizPack` | 객체 | 나 맞히기 퀴즈. `questions` array **필수** — `{q, options, answer}` 1–20개(`q` ≤80자, `options` 2–4개 각 ≤30자, `answer` 0부터; 길이는 글자(grapheme) 기준, 빈 보기는 빠지고 `answer`가 따라감, 못 쓰는 문항은 버림) · `title` string ≤40자 · `about` string(주인공 표시 이름, 닉네임 규칙대로 10자; 없으면 보낸 사람 닉네임) · `settings` object `{rounds 1–20, answerMs 3000–20000}`(있으면 `start`의 값보다 우선). 보낸 사람이 **주인공**이 된다. 받는 때: `lobby`(이미 저장된 팩이 있으면 그 주인공만 — 주인공이 **30초 넘게** 방에 없으면 누구나)와 `result`(누구나 = "나도 만들기", 단 그 결과 화면에서 **먼저 받아들인 한 명**의 팩이 다음 시작까지 유지 — 그 사람의 재전송만 받음). 거절은 `actionAck {accepted: false, reason}`: `invalid_pack`(쓸 문항 0개) · `not_subject` · `pack_waiting` · `not_in_lobby`. 글자 수 상한에 더해 문자열마다 UTF-16 길이도 상한의 4배까지(넘치는 글자는 잘림), 결합 문자가 기본 글자당 2개를 넘는 문자열은 버린다(용량 폭탄 방지). 팩은 세션 상태라 스냅샷·호스트 교대 뒤에도 남고, 새 팩이 오면 통째로 바뀐다 |
| `rename` | 객체 | `nick` string **필수** — 이 사람의 새 닉네임(#104: 링크로 들어와 자동 이름을 받은 사람이 대기실에서 이름을 정할 때 셸이 보냄). 입장 닉네임과 같은 규칙으로 정리(앞뒤 공백 제거, 10글자(grapheme))하고, 비면 `actionAck {accepted: false, reason: "invalid_nick"}`. **대기실(`lobby`)·결과(`result`)에서만** 받고 카운트다운·플레이 중이면 `reason: "not_in_lobby"`(게임 중엔 이름이 바뀌지 않는다). 바뀌는 것: `roster`의 그 사람 이름, 점수 주인 이름(`raceBoard` 행 — 점수가 있을 때), 같은 anonId의 모든 연결. 그대로인 것: 플레이어별 변수, `pid`, 이미 저장된 `quizPack`의 주인공 표시 이름(`quizInfo.about` — 팩을 보내기 **전에** 바꾸면 새 이름이 쓰인다), 끝난 판의 `quizRecap`. 이름은 스냅샷(`nicks`)에 실려 호스트 교대·방 서버 재기동 뒤에도 남는다(방 서버는 소켓 첨부에도 새 이름을 적는다) |
| `start` | 객체 **또는 숫자**(= `duration` ms) | `duration` `rounds` `roundMs` `answerMs` `revealMs` `matchupMs` number · `goal` number(협동 목표 — 단일 플레이 창에서 각자 `taps` 누적 수의 합이 `coopTotal`, 플레이 중 합이 `goal`에 닿으면 바로 결과로 가고 `coopTimeMs` = 플레이 시작→달성 ms(못 채우면 0); 다같이 300번 클릭) · `game` `theme` string(자유 텍스트) · `mode` `reaction`\|`nunchi`\|`guess` · `bracket` `quiz` `hidden` boolean |
| `tap` | 없음 | 보낸 페이로드는 무시 (경주 +1 · 눈치 선점 · 반응 탭, 세션 모드에 따라) |
| `taps` | 객체 | `count` number **필수** — 이 기기의 **누적** 탭 수. 탭 배틀은 매 탭마다가 아니라 ~250ms마다, 그리고 끝나고 한 번 더 보낸다(`tick`에서 `myTaps > sentTaps && now - sentAt >= tapBatchMs`). 방장은 최대값을 채택하므로 늦게 오거나 다시 온 묶음이 수를 되돌리지 않는다. 상한 초당 15탭(`TAP_RATE_MAX`, 넘치면 잘림). 결과 전환 뒤 2.5초(`LATE_GRACE_MS`)까지 마지막 묶음을 받는다 |
| `reaction` | 객체 | `ms` number **필수** — 이 기기가 잰 "초록 표시 → 탭" 시간(`tick`에서 `reactionGo`가 켜진 `now`를 기록 → 탭 때 `now - goSeenAt`). 초록 전 탭이면 `-1`. 방장은 범위만 본다: 80ms 미만·초록 전 = 부정출발(0점), 창(4초) 밖 = 순위 제외, 그 외 `2000 − ms`(방장이 직접 잰 시간보다 빠른 주장은 그 값으로 잘림). 점수는 **기기 측정값**이지 방장 수신 시각이 아니다(MP-08) |
| `lobby` | 없음 | 세션 종료 → 대기실 |

- **탭 묶음 간격 `tapBatchMs`** (#179, 방 변수, number ms): 시간제 탭 게임(tap-battle·coop-click·coop-tap-goal)이 `taps`/`tally`를 보내는 최소 간격. 템플릿은 `"tapBatchMs": 250`을 **선언**하고 `tick` 조건에서 읽는다(선언 안 하면 셸이 넘겨도 무시). 방은 매 판 카운트다운이 시작될 때 그때 인원으로 정한다: **20명 이하 = 250 ms**(작은 방은 아예 보내지 않음 — 템플릿 기본값 그대로, 손맛 불변), **21명 이상 = 1,000 ms**(엣지에선 수신 메시지 1개 = DO 요청 1, `docs/edge-rooms.md` §6). 1 s를 받았던 방이 줄면 다음 판에 250을 다시 보낸다. 엔진 상수 `TAP_BATCH_MS` · `TAP_BATCH_BIG_MS` · `TAP_BATCH_BIG_ROOM`, `tapBatchMsFor(players)`(`packages/snack-room/src/room.js`). 카운트다운·플레이 타이머는 그대로이고, 마지막 묶음은 결과 화면 진입 즉시 나가 1 s 간격이어도 `LATE_GRACE_MS`(2.5 s) 안에 닿는다.

`start`·`lobby`를 누가 보낼 수 있는지(친구 방 = 방장만, 공개 방 = 자동 시작)는 §6.2.

- **퀴즈(`start {quiz: true}`)**: 저장된 `quizPack`이 있으면 그 팩을 **만든 사람의 문항 순서대로**(최대 `settings.rounds`, 없으면 전부) 내고, 없으면 `getPack(game, opts)`의 기본 팩(배열 또는 `{title, questions}`)을 섞어 `rounds`개 낸다. 어느 쪽이든 **보기 순서는 라운드마다 섞고** 정답 번호를 다시 매긴다. 팩이 있는 방에서는 어떤 `start`(퀴즈가 아닌 페이로드도)와 `lobby`든 **그 주인공만** 보낼 수 있고(주인공이 30초 넘게 방에 없으면 누구나 — 앱 전환으로 잠깐 빠진 건 떠난 게 아니다; 아니면 `reason: "not_subject"`), 주인공 말고 1명 이상이 필요하다(없으면 `actionAck {accepted: false, reason: "need_answerer"}`, 1:1 = 주인공 + 친구 1명). 팩 없는 기본 퀴즈는 누구나 시작·재시작한다.
- **조기 공개(early reveal)**: 라운드는 `answerMs` 창이 끝나면 공개(`roundAnswer` = 정답, `raceBoard` 갱신)되고 `revealMs` 뒤 다음 라운드다. 단 **지금 방에 있는 답할 사람 전원**(`quizProgress`와 같은 규칙 — 주인공·나간 사람·관전자 제외, 엔진 roster에 있는 사람만)이 답하면 **그 사람들의 바꾸기 창(3초, #211)이 모두 닫힌 뒤 300ms**(`EARLY_REVEAL_MS`)에 공개하고(창이 답 시간 끝까지 가면 조기 공개 없음 — 창 끝에 공개; 나간 사람의 열린 창은 기다리지 않는다), 그다음은 똑같이 `revealMs` → 다음 라운드. 전원을 채우는 건 답 또는 **아직 안 낸 마지막 사람의 퇴장**뿐이고, 입장은 채우지 못한다(호스트 교대 뒤 재입장, 같은 사람 새로고침 포함). 그 기다림 사이에 이 판의 참가자 중 답 안 한 사람이 돌아오면 공개는 **원래 창 끝으로 되돌아간다**(새로 온 사람은 관전자라 되돌리지 않는다; 답할 사람이 아직 아무도 없을 때의 입장 — 호스트 교대 뒤 주인공이 먼저 돌아온 경우 등 — 은 되돌리지 않는다). 공개 타이머는 세션 데이터라 스냅샷에 남은 ms(`timers[].remaining`)로 실려 호스트가 바뀌어도 같은 때 공개된다. 템플릿은 `quizProgress.round === roundIdx && quizProgress.sessionNo === sessionNo && quizProgress.of > 0 && quizProgress.answered >= quizProgress.of`로 이 순간을 알 수 있다(라운드·판 확인을 빼면 지난 라운드의 "전원 답함"이 새 라운드 시작 때 잠깐 보인다)(speed-trivia-score: 타이머 바·초를 바로 비우고 주인공·관전자는 "다 골랐어요! 곧 공개 (n/n)", 답한 사람은 자기 창이 열려 있으면 "N초 안에 바꿀 수 있어요"(고른 칸에 흰 테두리), 닫히면 "확정! 곧 공개 (n/n)" — 기기는 첫 탭 때 `myLockAt = now + min(3000, 남은 답 시간)`을 재고, 새로고침 뒤엔 `myPick.lockMs`로 되살린다; 방이 이 기기의 마지막 선택(`myPick.n >= myPickN`)을 보고도 다른 보기를 들고 있으면(거절된 바꾸기) 그 보기로 되돌린다. 카운트다운엔 "한 번 고르면 3초 뒤 확정돼요 · 빠를수록 점수 UP", 첫 문제엔 "고르고 3초 뒤 확정 · 빠를수록 점수 UP"). 채점(기기 측정 `ms`)과 `stale_round` 판정은 그대로다.
- **숨긴 선택(`start {hidden: true}`, 라운드 투표 전용 — 밸런스게임, #126)**: 콘텐츠 라운드 투표(`mode`·`bracket`·`quiz` 없는 `start`)에서 켜면 라운드가 **공개될 때까지 누구의 선택도, 중간 집계도 방 밖으로 나가지 않는다**(방송 `setVar`·입장/재동기화 `state` 모두 — `votesByOption`은 라운드 시작 때의 0만). 공개 전에 보내는 것: `voteProgress` `{voted, of, round, sessionNo}`(지금 방에 있는 이 판 참가자 중 이번 라운드에 고른 수 / 인원 — 관전자·나간 사람 제외, `quizProgress`와 같은 규칙; `round` = `roundIdx`) · `myPick` `{sessionNo, round, option}`(**플레이어별**, 퀴즈의 `myPick`과 같은 모양 — 고른 사람의 연결에만, 새로고침해도 입장 `state`에 실림; `round === roundIdx && sessionNo === voteProgress.sessionNo`일 때만 이번 라운드 것 — 라운드 시작 때 `voteProgress`가 `roundIdx`보다 먼저 간다). 공개: `roundMs`가 끝나거나, 지금 방의 참가자 **전원이 고르면 `EARLY_REVEAL_MS`(300ms) 뒤**(조기 공개 규칙은 퀴즈와 같다 — 고르기 또는 아직 안 고른 마지막 사람의 퇴장만 채우고, 그 사이 안 고른 참가자가 돌아오면 원래 창 끝으로) `votesByOption`(최종 집계) → `roundPicks` `{o0: [닉…], o1: [닉…]}`(선택지마다 최대 8명, 나간 사람의 선택도 포함) → `revealRound` = 그 `roundIdx` 순서로 보내고, `revealMs`(기본 3000, 1500–8000) 뒤 다음 라운드(`revealRound: -1`). 템플릿은 `revealRound === roundIdx`로 공개를 안다. 다시 고르기는 공개 전까지 되고, 공개 뒤의 `vote`는 `actionAck {accepted: false, reason: "closed"}`. 공개 타이머·선택은 세션 데이터라 스냅샷(서버 저장)·방 서버 재기동 뒤에도 같은 때 공개된다. 이 옵션을 쓰지 않는 템플릿(우리 중 누가?·월드컵)은 그대로 매 투표마다 `votesByOption`을 보낸다(새 변수도 안 감, MP-13). **한계(정직 고지)**: 숨김은 서버가 방을 돌리는 방(edge/room)에서만 완전하다 — 기기가 방장인 옛 방식(mesh/host)에서는 방장 기기와 MQTT로 가는 스냅샷에 선택이 들어 있다.
- **관전자(spectator)**: 모든 세션 모드에서, 이 판에 **처음 들어온 때가 카운트다운·플레이 중**인 사람은 다음 `start`까지 관전자다. "이 판의 참가자" = 카운트다운이 시작될 때 roster에 있던 사람(+ 퀴즈 주인공)이라 참가자의 새로고침·재입장은 관전자가 아니다. 관전자는 진행을 그대로 보지만 `vote` `tally` `score` `tap` `taps` `reaction` `answer`가 `actionAck {accepted: false, reason: "spectator"}`로 거절되고(대기실에선 거절 없음), `quizProgress.of`·조기 공개·월드컵 "전원 투표"·눈치 생존자·`quizRecap`·`S.acted`(지표 `players`)에서 빠진다. 결과도 모두와 같이 보고 다음 `start`부터 일반 참가자다. 변수: `iAmSpectator` boolean(**플레이어별** — 관전자가 될 때 `true`(입장 `state`에 실림), 다음 `start`에 `false`; 관전자가 한 번도 없던 방은 보내지 않음) · `spectators` number(지금 방에 있는 관전자 수; 처음 관전자가 생길 때부터 보내고 `start`마다 0). 둘 다 세션 데이터(배열)라 스냅샷·호스트 교대 뒤에도 남는다. 이 변수를 선언하지 않은 템플릿은 셸(`LiveApp`)이 "진행 중인 판이에요 · 다음 판부터 같이 해요"를 위에 띄운다.
- 퀴즈 변수: `quizInfo` `{title, count, custom, about, answerMs, packId, subjectHere}`(`subjectHere` = 주인공이 방에 있거나 떠난 지 30초 안 — `false`면 템플릿이 친구에게 시작 버튼을 보여 준다)(답 없음; `packId` = 받아들인 팩마다 새 id; 기본 팩이면 `custom: false`, `about: null`, `packId: null`, `title` = 팩 제목 또는 `"상식"`) · `quizProgress` `{answered, of, round, sessionNo}`(지금 방에 있는 사람 중 이번 라운드에 답한 수 / 주인공 뺀 현재 인원; `round` `sessionNo` = 이 수가 어느 라운드(`roundIdx`)·어느 판(`sessionNo`)의 것인지 — 변수는 하나씩 도착하므로 새 라운드 값이 먼저 오고 새 `quizProgress`가 늦을 수 있다) · `iAmSubject` boolean · `myPid` string(둘 다 **플레이어별** — 그 기기에만 보냄, 재접속해도 유지) · `sessionNo` number(`start`마다 +1) · `quizRecap` `{subject: 닉|null, about, title, packId, rounds: [{q, options(보인 순서), answer, picks: [{nick, pid, option, ms, correct, points}]}]}`(시작 때 빈 값, 결과로 넘어가기 직전에 그 판의 퀴즈로 설정 — `quizInfo.packId !== quizRecap.packId`면 새 퀴즈가 기다리는 중; 주인공 제외 답한 사람 전원(최대 20명), 안 낸 사람은 `option: -1, ms: -1`, 나간 사람도 남음). 퀴즈 시작 때 주인공 뺀 참가자는 모두 0점으로 `raceBoard`에 오르고, 라운드가 열려 있는 동안 누가 들어오거나 나가도 `raceBoard`는 **직전 공개 때 점수**로만 나간다. `quizRecap`은 스냅샷에 넣지 않고 복원 때 라운드·답으로 다시 만든다.
- `pid`: 방 안에서 사람마다 붙는 키(`"p1"`, `"p2"`… 입장 순서, anonId 아님, 스냅샷에 실려 호스트가 바뀌어도 같음). 모든 `raceBoard` 행 `{nick, score, pid, left?}`과 `quizRecap` 답에 들어가므로 닉네임이 같은 두 사람도 두 줄이다. 내 줄은 `pid === myPid`. 동점은 닉네임 순, 그다음 입장 순으로 늘 같은 순서다.
- 방 변수가 아닌 셸 변수 `packPending` string(나 맞히기 템플릿이 선언): 이 기기가 이 방에 보낼 퀴즈를 갖고 있는데 방이 아직 받지 않았으면 그 제목, 아니면 `""`(`snack-player/src/quiz.ts` `packPending` — 방이 새 `packId`로 이 기기를 주인공으로 만들거나, 거절·포기하면 `""`). 그동안 대기실은 "<제목> · 준비 중…"을 보이고 시작 버튼(대기실·결과의 다시 하기·내 퀴즈 시작·나도 만들기)을 모두 숨긴다 — 방이 지금 가진 퀴즈(대개 기본 퀴즈)를 만든 사람이 실수로 시작하지 못하게. 방금 만든 방 코드(만들기 완료·친구끼리)는 첫 접속에서 기존 방장을 1.5초 대신 150ms만 기다린다(아무도 있을 수 없다).
- **정직 고지(되는 척 금지):** 정답은 화면용 변수(`roundContent`)에는 공개 전까지 없지만, **호스트 스냅샷**(세션 상태: 저장된 `quizPack`, 섞인 `rounds`)에는 들어 있고 서버리스 방에서는 이 스냅샷이 **공개 MQTT 브로커**로 방 전체에 간다. 개발자 도구로 방 메시지를 보는 사람은 답을 미리 볼 수 있다. 또 `ms`는 기기가 재서 보내므로 0에 가까운 값을 위조하면 실제보다 빠른 점수를 받을 수 있다(방장은 방장이 본 시간보다 *느린* 주장만 잡는다 — 반응속도와 같은 한계). 둘 다 인증된 방(사업 계획 4단계) 전까지의 알려진 한계이며, 친구끼리의 놀이 전제다.
- 카운트다운: 방장은 `sessionCountdown: 3` 직전에 `countdown {n: 3, stepMs: 1000, endsIn: 3000}` 메시지("N ms 뒤 시작")를 보내고, 클라이언트(`@snack/room` mesh·relay 클라이언트의 `countdown.js`)가 자기 시계로 3·2·1을 `sessionCountdown`에 흘려 넣는다. 방장이 보내는 2·1은 추정치를 다듬는 데만 쓰인다(가장 빨리 도착한 메시지가 진짜에 가장 가깝다). 템플릿은 그대로 `sessionCountdown`만 읽으면 된다.
- 동점: 월드컵 대결이 동점이면 `bracketLabel`에 `· 동점 🎲`가 붙고 동전으로 정한다(왼쪽 승 아님). 눈치 배틀 라운드가 동점이면 `roundAnswer = 2`(다수파 없음, 아무도 득점 없음). 결과 화면의 공동 우승은 템플릿이 `raceBoard[0].score === raceBoard[1].score`로 판단한다.
- 나간 사람: `raceBoard` 항목은 `{nick, score, pid}`이고, 방을 나간 사람은 `{nick: "닉 (나감)", score, pid, left: true}`로 남는다(순위에서 빠지지 않고 표시만 된다).
- 방장은 그 방이 한 번이라도 보낸 변수만 다시 보낸다(예: 투표 앱은 `raceBoard`를 받지 않는다). 모든 공식 템플릿은 `packages/snack-room/test/declared.test.js`가 "선언 안 한 변수 수신 0건"을 검사한다(MP-13).

- **페이로드 문자열은 템플릿이다.** `"score"`는 글자 그대로 `score`라는 텍스트를 보내고, `"{score}"`가 변수 값을 보낸다. 변수 이름과 똑같은 리터럴은 거의 항상 버그라 검증기가 오류로 잡는다(자유 텍스트 필드 `game`·`theme`에서만 경고).
- 필드의 타입은 보낼 값의 JSON 타입이다: 리터럴 → string(숫자 필드엔 `"3"` 같은 숫자 텍스트만 허용), `{변수}` → 그 변수 초기값의 타입, 식 → 정적으로 판정 안 함.

#### 선택 제한시간 표시 (#170)

- 선택·응답 단계는 서버가 정한 제한시간 안에 끝내고, 화면에는 남은 초와 진행 상태를 표시한다. 전원 응답 시에는 조기 공개, 만료 시에는 받은 응답만 집계하고 미응답자를 기다리지 않는다. 참가자를 모으는 대기실의 최소 인원 정책(§6.2)과는 별개이며, 시간이 지났다고 인원 조건을 무시하고 시작하지 않는다.
- **밸런스게임 적용:** 기존 `roundMs: 10000`(10초), 전원 선택 후 300ms 조기 공개, `revealMs: 3500` 후 다음 문제를 유지한다. 선택 중에는 남은 초·진행 바, 전원 선택 시에는 "곧 공개", 공개 뒤에는 "공개"를 표시한다. 아무도 고르지 않아도 제한시간 뒤 결과를 공개한다.
- 숨긴 선택의 `voteClock` = `{round, sessionNo, ms, leftMs}`. 서버는 라운드 시작·공개 시 보내고, 입장/재동기화 `state`에서는 실제 남은 ms를 다시 계산한다. 클라이언트는 샘플을 자기 시계에 맞춰 감소시키며, 새로고침으로 10초를 다시 부여하지 않는다. 전송 지연만큼 표시 오차는 가능하지만 마감 판정은 항상 서버가 한다. 매초 서버 메시지·저장 작업을 추가하지 않는다. 다른 게임의 타이머 UI 적용은 별도 점검 대상이다.

### 6.2 누가 시작하나 — 방장 · 자동 시작 (#135 · #136)
방 엔진의 `startRule`(엣지 방 `edge/room/src/game.js`가 방 id로 정함)에 따라 `start`·`lobby`를 받는 사람이 다르다. 판정은 **방(서버)이 한다** — 화면에서 버튼을 숨기는 건 보조일 뿐이다.

| 방 | 링크 | `startRule` | 누가 시작 |
|---|---|---|---|
| 친구 방 | `/p/<slug>?room=<code>` (방 id `slug~CODE`) · 주최 방(`organize`) | `"host"` | **방장만**. 방장 = 방을 만든 사람(엣지: 주최자 토큰의 주인 = 첫 입장자). 나머지의 `start`·`lobby`는 `actionAck {accepted: false, reason: "not_host"}` |
| 공개 방 | `/p/<slug>` (방 id `slug`, 다음 판 방 `slug.g2`, `slug.g3`, …) | `"auto"` | **아무도 안 누른다** — 대기실에 **2명**(`AUTO_START_MIN`)이 모이면 그때부터 `autoStartMs`(기본 10초) 세고 스스로 시작. 혼자면 기다린다(#141) |
| 그 외 | 메시 공개 방 · snack-server `/ws`(개발) | `"any"` | 누구나(예전 그대로) |

- **방장 교대**: 방장이 방에 없는 지 **30초**(`HOST_GRACE_MS` = 퀴즈 주인공 유예와 같음)가 지나면, 지금 방에 있는 사람 중 **가장 먼저 들어온 사람**(입장 순서 = `pid`)이 방장이 된다. 30초 안에 돌아오면(공유 시트·새로고침) 그대로 방장. 교대 뒤에 원래 방장이 돌아와도 **되찾지 않는다**(단순하게). 방이 완전히 비면 방이 사라지고, 다음에 처음 들어오는 사람이 방장.
- **시작 시간 예약**(#218, 친구 방만): 방장(저장된 나 맞히기 퀴즈는 그 **주인공**)이 대기실에서 시작 시간을 정한다 — 셸의 시트(`snack-player/src/ScheduleSheet.tsx`, 템플릿 버튼의 셸 이벤트 `scheduleOpen`)에서 1/3/5/10분 뒤 또는 시각(오늘, 지났으면 내일 — 최대 24시간, 기기 로캘로 표시)을 고르면 `schedule {in, start}`(in = 지금부터 ms, **방의 시계**; `SCHEDULE_MIN_MS` 10초 … `SCHEDULE_MAX_MS` 24시간, 아니면 `invalid_time`; start = 앱의 `room.start`, 1 KB 이하, 아니면 `invalid_start`). 다시 보내면 바뀌고, `unschedule`(예약 취소)로 지운다. 방장 아님 `not_host`(퀴즈 `not_subject`), 대기실 아님 `not_in_lobby`, 공개 방 `auto_start`, 그 외 방 `not_friends_room`. 방은 `{t: "schedule", d: {on, endsIn, due}}`를 모두에게(늦게 온 사람에겐 입장 때) 보내고 기기가 자기 시계로 센다(매초 메시지 없음). 시간이 되면 **2명 이상**(관전자 제외; 퀴즈는 맞힐 사람 1명 이상)이면 그 페이로드로 스스로 `start`(평소처럼 3·2·1), **혼자면 기다렸다가**(`due: true`) 다음 사람이 들어오는 순간 시작한다. 어떤 시작이든(방장의 "지금 시작" 포함) 예약은 끝난다. 방장 교대·스냅샷/동면 복구에도 남고(남은 시간이 스냅샷에), 방이 비면 사라진다. 세션 타이머가 아니다 — 엣지 방에선 방의 **스토리지 알람 하나**(자리 비움 마감 #213과 같은 알람: 둘 중 이른 쪽으로 걸고, 울리면 둘 다 확인하고 다음 것으로 다시 건다)로 깨우므로 기다리는 동안 DO가 잠들 수 있다(엔진 옵션 `scheduleWake`/`wake()`; 없으면 엔진 자체 타이머). 링크 미리보기는 `GET /room/<id>/result`의 `startAt`으로 "오후 8:30 시작"(한국 시간, PIN 방 제외)을 말한다(docs/link-previews.md).
- **나 맞히기 퀴즈**(`quizPack`이 저장된 방): 그 판은 **주인공이 방장**이다 — `start`·`lobby`는 §6.1의 주인공 규칙만 본다(방장 규칙은 건너뜀). 저장된 팩이 없는 기본 퀴즈는 방장 규칙.
- **자동 시작**: 클라이언트가 입장 때 앱의 `room.start`(아래 문서 키)를 방에 보낸다(엣지 hello `autoStart: {start, ms}`, 처음 받은 값이 방이 빌 때까지 유지). 그때부터 대기실은 플레이어가 **`autoStartMin`명(기본 `AUTO_START_MIN` = 2, 관전자 제외) 이상**이면 카운트다운 1개를 돌리고(그 사이 들어온 사람은 모두 같이 플레이), 끝나면 그 페이로드로 `start`한다. **혼자면 시작하지 않는다**(#141): 두 번째 사람이 들어온 순간부터 세고, 세는 중에 2명 아래로 줄면 카운트다운을 멈추고(`autoStart {endsIn: -1}`) 다시 기다린다. 동면 복구 뒤 카운트다운이 끝났을 때 돌아온 사람이 모자라도 시작하지 않고 기다린다. `autoStartMin`은 엔진 옵션(`createRoom({autoStartMin})`, 기본 2, 1 = 예전 "첫 사람부터" 규칙) — 템플릿 문구(아래)는 기본 2를 가정한다. **결과 화면은 그대로 머문다**(#212 — 예전엔 8초 뒤 대기실로 돌아와 다시 세서 판이 끝없이 돌았다): 저절로 대기실로 가거나 다음 판을 시작하지 않고, 엔진 타이머도 남기지 않는다(방 DO가 잠들 수 있다; 결과 뒤 들어온 사람도 아무것도 다시 시작하지 않음). 결과에서 **누구든**(공개 방의 아무 플레이어) **"한 판 더"**(`start`)를 누르면 대기실로 돌아가고 카운트다운을 다시 건다 — 2명 이상일 때만(혼자면 `actionAck {accepted: true, waiting: "need_players"}`로 대기실에서 두 번째 사람을 기다리고, 그 사람이 들어오면 센다; 세는 동안 들어온 사람은 같이 플레이). 첫 판의 "2명 모이면 10초 뒤 자동 시작"은 그대로. 대기실에서 `start`는 멈춘 대기실을 깨우기만 하고(혼자면 `reason: "need_players"`, 이미 세는 중이면 `reason: "auto_start"`), `lobby`는 `auto_start`, `quizPack`은 `auto_room`으로 거절(공개 방은 앱 기본 퀴즈). 예전 스냅샷에 남은 `autoLobby` 타이머는 아무것도 하지 않는다.
- **늦게 온 사람 → 다음 방**: 공개 방에서 판이 카운트다운(3·2·1)·플레이 중일 때 처음 온 사람(이 판의 참가자가 아닌 사람 — 참가자의 새로고침은 그대로)에게 방은 `{t: "moveTo", d: {room: "<slug>.g<N+1>"}}`를 보내고 4010으로 닫는다. 클라이언트(`EdgeRoomTransport`)는 화면을 그대로 둔 채 그 방으로 다시 접속한다. 다음 방 id는 결정적이라 같은 판에 늦은 사람들은 모두 **같은 방**에 모여 거기서 10초 카운트다운 후 같이 한다 — 그 방도 같은 규칙이라 먼저 옮겨 간 사람이 혼자면 두 번째 사람(다음에 옮겨 오는 사람 포함)을 기다린다(그 방도 진행 중이면 한 번 더 다음 방으로). 옮겨 간 방에서 판 없이 **혼자**인 채로 `LONE_RETURN_MS`(20초, 화면에 보이는 시간)가 지나면 클라이언트가 링크의 방(`<slug>`)으로 조용히 돌아간다 — 방끼리는 대화하지 않아 `.gN`은 링크의 방이 다시 대기실이 된 걸 모르고, 링크를 연 친구는 그때 링크의 방으로 가기 때문이다(링크의 방이 아직 진행 중이면 같은 `.gN`으로 다시 옮겨진다; 돌아가다 거절되면 그 `.gN`에서 계속 기다린다). 새 방은 무료 한도 가드(70 % 넘으면 새 방 거절)를 그대로 거친다 — 거절되면(`room_full_today`) 클라이언트는 원래 방에 `stay: true`로 돌아가 관전한다. `autoStart`를 보내지 않는 옛 클라이언트는 옮기지 않는다(예전처럼 관전).
- **변수**(선언한 템플릿에만 — 셸이 거른다, `snack-player/src/spectate.ts SHELL_ROOM_VARS`): `roomMode` string `"host"`\|`"auto"`(선언 안 하면 안 옴; 예전 방 = `""`) · `hostNick` string(방장 닉) · `iAmHost` boolean(**플레이어별**) · `autoStartIn` number — **셸 변수**: 방의 `autoStart {endsIn, ms}` 메시지를 셸(`snack-player/src/autoStart.ts`)이 이 기기 시계로 돌려 남은 **초**(올림)를 넣는다. 0 = 카운트다운 없음. · `roomPin` boolean — **셸 변수**(#143): 이 친구방에 비밀번호가 걸려 있으면(20자 코드, 방 서버) `true`. 선언한 템플릿에만 앱이 준비될 때 넣는다. · `startAt` number · `startIn` number · `startAtText` string — **셸 변수**(#218, `snack-player/src/schedule.ts`): 방의 `schedule` 메시지를 이 기기 시계로 — 시작 시각(기기 epoch ms, 0 = 예약 없음), 남은 **초**(올림, 0 = 안 세는 중: 없음 또는 시간이 와서 기다리는 중), 기기 로캘의 시각("오후 8:30", 오늘이 아니면 "내일 …"). · `reduceMotion` boolean — **셸 변수**: 기기의 "동작 줄이기"(마지막 1분 깜빡임을 멈춘다).
- **방 종류 한 줄**(#143, 세션 템플릿 10종 대기실 NavBar 부제): `roomMode == 'auto'` → "🌐 누구나 함께하는 방 · 2명 모이면 시작", `roomMode == 'host'` → "🤝 초대받은 친구만 들어오는 방 · 방장이 시작"(`roomPin`이면 "🤝🔒 …"), `""`(예전 방·메시 공개방) → "대기실". **방장은 친구방(과 나 맞히기 주인공)에만 있다** — 공개방(`auto`·`""`)의 대기실·결과에는 "방장"이라는 말이 나오지 않는다(`snack-player/test/roomType.test.ts`가 템플릿마다 렌더해 확인). 셸의 상단 칩 "🌐 공개방 / 🤝 친구방"은 대기실·결과에서만 보이고 탭하면 방 종류를 바꾼다(`snack-player/src/roomType.ts`).
- **템플릿 패턴**(세션 템플릿 10종): 시작 버튼 `show` = `roomMode == '' || (roomMode == 'host' && iAmHost) || (roomMode == 'auto' && autoStartIn <= 0 && roster.length >= 2)`(`onTap`의 `if`에도 같은 조건), 그 자리에 같은 높이(56)의 안내 박스 `startWait`(반대 조건): 방장 방 "방장이 시작하길 기다리는 중" + "방장 · <닉>", 자동 방 2명 이상 "10초 뒤 시작 · n명" + "지금 들어온 사람 모두 같이 시작해요", 혼자(`roster.length < 2`) "한 명 더 오면 시작해요" + "링크를 친구에게 보내도 돼요". 결과 화면의 다시 하기(`againBtn`)는 `show` = `roomMode == '' || roomMode == 'auto' || (roomMode == 'host' && iAmHost)`(나 맞히기 퀴즈는 `quizInfo.custom`도) — 자동 방에서는 라벨이 "한 판 더 🔁"(`{roomMode == 'auto' ? '한 판 더 🔁' : '다시 하기 🔁'}`)이고 누구나 누른다(#212); 그 자리의 `againWait`는 방장 방의 다른 사람만: "방장이 다시 시작하길 기다리는 중" + "방장 · <닉>". 시작 시간 예약(#218): 시작 버튼 위에 `schedCard`(`show` = `roomMode == 'host' && startAt > 0`, 높이 84 — 퀴즈 76) "m:ss 뒤 시작!"(`floor(startIn / 60) + ':' + pad(startIn % 60, 2)`) + "<startAtText> 시작 · 지금 n명", 마지막 1분(`startIn > 0 && startIn < 60`)은 라임 면·검정 글자에 1초 간격 깜빡임(`opacity`, `reduceMotion`이면 멈춤), 시간이 와서 혼자면 "친구가 오면 바로 시작해요" + "한 명 더 오면 3·2·1 바로 시작". 방장(퀴즈는 `quizInfo.custom ? iAmSubject : iAmHost`)에게만 `schedBtn`(GhostButton 50) "⏰ 시작 시간 정하기"(→ `scheduleOpen`) / 예약 중엔 "예약 취소"(→ `unschedule`), 시작 버튼 라벨은 예약 중 "지금 시작 🚀". 다른 사람의 `startWait`(퀴즈 `waitBtn`)는 예약 중 "시간이 되면 저절로 시작해요".

문서 키 `room`(§1, 선택): `{ "start": <lobby 시작 버튼과 같은 start 페이로드 — 리터럴만>, "autoStartMs": 3000–60000 }`. `validate`가 `start`를 §6.1 계약으로 검사한다.

## 7. 런타임 API (`@snack/bite`)
```ts
const app = createBite(doc, { now?: () => number, random?: () => number });
app.start();                       // start 페이즈 enter 실행
app.tick();                        // 페이즈 tick 실행 + 변경분 반환 (시간은 주입된 now 기준)
app.tap(nodeId, { item, index });  // 렌더러가 호출
app.setVar(id, v); app.setVars(o); // 호스트 입력
app.phase; app.vars;               // 읽기 전용 스냅샷
app.on("emit" | "phase" | "change", fn);  // change = 이번 프레임에 바뀐 변수 목록
app.eval(expr, scope?);            // 식 평가 (show / if / each 형태)
app.value(template, scope?);       // 템플릿 평가 (text / fill / width 형태)
```
- `tap(id)`는 노드나 조상의 `show`가 false면 아무것도 하지 않고 false를 돌려준다.
- 렌더러는 `change`를 받아 **그 변수에 의존하는 노드만** 다시 평가·배치·그린다.
- 같은 문서 + 같은 `now`/`random` 주입 → 같은 결과 (Node에서 headless 시뮬레이션 가능).

## 8. 검증 (`validate(doc, { hostActions? })`)
```js
import { validate } from "@snack/bite";
import { HOST_ACTIONS } from "@snack/room/actions";
const { errors, warnings } = validate(doc, { hostActions: HOST_ACTIONS }); // [{ path, message }]
```
`hostActions`를 주면 §6.1 계약도 검사한다. 안 주면 계약 검사만 빠지고 나머지(변수 이름 리터럴 포함)는 그대로다.

오류(재생 불가):
- 스키마 위반, 알 수 없는 노드 종류/키, `start`/`go` 대상 페이즈 없음, 없는 컴포넌트 `use`
- 식 파싱 실패, 선언 안 된 변수 참조/대입, 화이트리스트 밖 함수·메서드, 예약 이름이나 **내장 함수 이름**(`clamp` 등)을 변수로 선언
- 중복 `id`, `free` 밖의 `x`/`y`와 `grid`의 `columns` 누락
- **범위**: `opacity` 0–1 · `weight` 100–900 · `origin` 각 축 0–1(노드 크기의 비율 — `[0.5, 0.5]`가 중심, `[1, 0.5]`가 오른쪽 가운데; 백분율 `[50, 50]`은 오류)
- **`emit` 페이로드의 변수 이름 리터럴**: `"score"`처럼 변수 이름과 같은 글자 그대로의 문자열 → `"{score}"`를 뜻했을 것이므로 오류 (`hostActions` 없이도 검사; 자유 텍스트 필드 `start.game`·`theme`에서는 경고)
- **계약 위반**(`hostActions` 있을 때): 필수 필드 누락(`'vote' needs 'option'`), 타입 불일치(리터럴 또는 `{변수}` 초기값으로 판정 — 식은 판정하지 않음), 객체(또는 `start`의 숫자)여야 할 페이로드가 아님, `enum` 밖의 값

경고(재생 가능):
- `Math.` 접두 사용, 어떤 페이즈에서도 보이지 않는 노드, 아무 데서도 안 쓰는 변수
- 계약(`hostActions` 있을 때): 방 액션이 아닌 `emit` 이름(방이 무시함), 페이로드를 안 읽는 액션(`tap`·`lobby`)에 보낸 페이로드, 방이 읽지 않는 필드, 숫자 필드에 보낸 텍스트 템플릿(`"{a}-{b}"`는 항상 문자열)
- 레이아웃 검사(`@snack/bite-layout` headless): 텍스트가 박스를 넘침, 형제 노드 겹침, 화면 밖으로 나감

## 9. 전체 예시 — 반응속도 테스트
```json
{
  "bite": 1,
  "meta": { "name": "반응속도 테스트" },
  "frame": [390, 844],
  "vars": { "bestMs": 0, "lastMs": 0, "greenAt": 0, "delayMs": 1800 },
  "start": "ready",
  "phases": {
    "ready": { },
    "wait":  { "enter": [ { "set": "delayMs", "to": "randint(1200, 3500)" },
                          { "set": "greenAt", "to": "now + delayMs" } ],
               "tick":  [ { "if": "now >= greenAt", "then": [ { "go": "green" } ] } ] },
    "green": { },
    "fail":  { },
    "done":  { "enter": [ { "set": "bestMs", "to": "bestMs == 0 ? lastMs : min(bestMs, lastMs)" } ] }
  },
  "view": {
    "box": "column", "pad": [59, 16, 34, 16], "gap": 16, "fill": "#0b0c0e",
    "children": [
      { "text": "반응속도 테스트", "size": 28, "weight": 800, "color": "#ffffff" },
      { "id": "pad", "box": "column", "height": "fill", "radius": 24, "justify": "center", "align": "center",
        "fill": "{phase == 'green' ? '#d9ff00' : phase == 'fail' ? '#ff5a5f' : '#16181c'}",
        "onTap": [
          { "if": "phase == 'ready' || phase == 'done' || phase == 'fail'", "then": [ { "go": "wait" } ] },
          { "if": "phase == 'wait'",  "then": [ { "go": "fail" } ] },
          { "if": "phase == 'green'", "then": [ { "set": "lastMs", "to": "now - greenAt" }, { "go": "done" } ] }
        ],
        "children": [
          { "text": "{phase == 'wait' ? '기다리세요…' : phase == 'green' ? '지금!' : phase == 'fail' ? '너무 빨라요' : phase == 'done' ? lastMs + 'ms' : '탭해서 시작'}",
            "size": 34, "weight": 800, "color": "{phase == 'green' ? '#0b0c0e' : '#ffffff'}" },
          { "text": "최고 기록 {bestMs}ms", "show": "bestMs > 0", "size": 15, "color": "#9aa3af" }
        ] }
    ]
  }
}
```
