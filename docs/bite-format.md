# Bite 포맷 스펙 v1

> snackapp의 자체 엔진 **Bite**가 읽는 앱 문서 포맷. 파일 = `*.bite.json`.
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
| `scroll` | boolean | 넘치면 주축 방향 스크롤 |

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
| `font` | `body`(기본, Pretendard — 읽는 글) \| `display`(Galmuri11 픽셀 — 제목·점수·뱃지) |
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

## 8. 검증 (`validate(doc)`)
오류(재생 불가):
- 스키마 위반, 알 수 없는 노드 종류/키, `start`/`go` 대상 페이즈 없음, 없는 컴포넌트 `use`
- 식 파싱 실패, 선언 안 된 변수 참조/대입, 화이트리스트 밖 함수·메서드, 예약 이름을 변수로 선언
- 중복 `id`, `free` 밖의 `x`/`y`와 `grid`의 `columns` 누락

경고(재생 가능):
- `Math.` 접두 사용, 어떤 페이즈에서도 보이지 않는 노드, 아무 데서도 안 쓰는 변수
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
