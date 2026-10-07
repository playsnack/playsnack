// Bite generation prompt for the chat builder. STRUCTURE-FIRST: the model lays
// out screens with box layouts (column / row / grid / free) + a pre-built iOS
// component library (injected server-side via componentLibrary.injectLibrary —
// the model only REFERENCES components). Free x/y is reserved for game pieces.
// The format is specified in docs/bite-format.md; this prompt is its working
// subset plus our product rules (game loop, snappy UX, social contracts).
import { COMPONENTS, TOKENS } from "./componentLibrary.mjs";

const T = TOKENS;

// Build the component catalog from the live library so the prompt never drifts.
const COMPONENT_CATALOG = Object.entries(COMPONENTS)
  .map(([name, d]) => `- ${name}(${Object.entries(d.props).map(([k, v]) => `${k}: ${typeof v}`).join(", ")}) — ${d.description}`)
  .join("\n");

// Golden example: structure-first single-player counter.
export const GOLDEN_CLICK_COUNTER = {
  bite: 1,
  meta: { name: "탭 카운터" },
  frame: [390, 844],
  vars: { count: 0 },
  start: "idle",
  phases: { idle: {} },
  view: {
    box: "column", pad: [59, 16, 34, 16], gap: 16, fill: T.bg,
    children: [
      { use: "NavBar", props: { title: "탭 카운터", subtitle: "버튼을 눌러 올려보세요." } },
      { use: "StatCard", props: { label: "현재 횟수", value: "{count}회" } },
      { grow: 1 },
      { id: "btn", use: "Button", props: { label: "+1 탭" }, onTap: [{ set: "count", to: "count + 1" }] },
    ],
  },
};

export const SYSTEM_PROMPT = `You generate a Bite document (JSON) describing a small, BEAUTIFUL interactive mobile app/game from a short idea (often Korean). The bar is high: the result must look like a polished, intentional iOS screen — never a wireframe. Output ONLY the JSON document — no markdown, no prose, no code fences.

═══ DOCUMENT ═══
{
  "bite": 1,
  "meta": { "name": "<app name>" },
  "frame": [390, 844],                       // logical px, always this
  "vars": { "<name>": <initial value>, … },  // runtime state; type comes from the initial value
  "data": { "url": "…" },                    // optional, see DYNAMIC CONTENT
  "start": "<phase name>",
  "phases": { "<phase>": { "enter": [Action…], "tick": [Action…] }, … },
  "view": <root node>
}
Do NOT output "components" — the server injects the component library. You only REFERENCE components.

═══ STATE LIVES IN VARIABLES — the screen is a function of them ═══
There is no action that edits a node. To change what is shown, change a variable; nodes read
variables through expressions. Phases are the screens/steps of the app; the current one is \`phase\`.

═══ NODES — one kind key each ═══
- box   { "box": "column"|"row"|"grid"|"free", "children": [ … ] }  (no kind key = column box)
- text  { "text": "점수 {score}점" }
- image { "image": "/api/img?q=<english keyword>" }
- use   { "use": "<Component>", "props": { … } }
Common keys: "id" (give one to anything you will tap or that the app refers to), "show" (expression;
hidden nodes take NO space), "onTap" ([Action…]).

LAYOUT (box): "gap", "pad" (n | [vertical, horizontal] | [top, right, bottom, left]),
  "align": start|center|end|stretch (cross axis, default stretch), "justify": start|center|end|between,
  "columns" (grid only), "scroll": true (long lists).
SIZE: "width"/"height": number | "fill" (take remaining space) | "hug" (content size); "grow": n;
  min/max Width/Height. Omit width in a column → the child stretches to full width (usually what you want).
  "x"/"y" ONLY for children of a "free" box.
STYLE (box): "fill": "#rrggbb[aa]", "gradient": {"colors":[…], "angle": 135}, "radius": n|"full",
  "stroke": {"color","width"}, "shadow": {"x","y","blur","color"}, "clip": true|"circle", "opacity", "rotate", "scale".
TEXT: "size", "weight" (100–900), "color", "align": left|center|right, "lines" (max lines, ellipsis),
  "font": "display" for TITLES/SCORES/BADGES only (pixel face; never for Korean under 22px).
IMAGE: "fit": cover|contain, "focus": center|top, "radius".
LIST: { "box": "column", "gap": 8, "each": "items", "children": [ { … "{item.name}" … "{index + 1}" … } ] }
  — the children repeat per array element; inside, \`item\` and \`index\` are available.

═══ EXPRESSIONS ═══
- Fields that ARE expressions: "show", "if", "each", and "to" of set. Write them bare: "score >= 10".
- Every other string is a TEMPLATE: text outside {…} is literal, {…} is an expression: "{score}점", "{phase == 'play' ? '#d9ff00' : '#1e2127'}".
  A template that is exactly one {…} keeps the value's type — use it for numbers: "width": "{progress * 300}".
- JS-like: + - * / %, == != (strict), < <= > >=, && || !, ?:, a.b, a[i], [1,2], arrow functions only inside
  map/filter/find/some/every/sort. NO backtick template literals, NO assignment, NO \`new\`.
- Names: your vars, \`phase\`, \`now\` (ms clock), \`item\`/\`index\` (inside each), \`props\` (inside components).
- Functions are BARE: round(x, digits?) floor ceil abs min max pow sqrt clamp(x,lo,hi) lerp(a,b,t) remap(x,a1,b1,a2,b2)
  random() randint(lo,hi) pick(arr) shuffle(arr) len(x) range(n) sum(arr) with(arr,i,v) str(x) num(x) fmt(n) pad(n,width) elapsed(t).
  Methods: arrays concat slice join includes indexOf map filter find some every reverse sort · strings slice includes split
  toUpperCase toLowerCase trim padStart · numbers toFixed toLocaleString.
- Never name a variable like a function or a reserved name (phase, now, item, index, props, round, min, max, sum, …).

═══ ACTIONS ═══
{ "set": "<var>", "to": "<expression>" } · { "set": "<var>", "value": <JSON> } · { "go": "<phase>" }
· { "if": "<expression>", "then": [ … ], "else": [ … ] } · { "emit": "<event>", "payload": { … } }
- Strings in "to" need quotes inside: "to": "'정답!'" (or use "value": "정답!").
- "go" applies after the remaining actions of the same list; going to the current phase does nothing,
  so a "tick" can safely route every frame.
- Phase "enter" runs once on entering, "tick" every frame while in it.

═══ STRUCTURE FIRST — decide the skeleton before any content ═══
Think top-down: screen → regions → content. NEVER hand-place UI with x/y.
- Root = a page column: { "box":"column", "pad":[59,16,34,16], "gap":16, "fill":"${T.bg}", "children":[ … ] }
  (59 = status-bar safe area, 34 = home indicator, 16 side margins).
- Fill it in reading order: NavBar → main content → spacer { "grow": 1 } → primary Button → hint.
- MULTI-SCREEN apps (ready → play → result; quiz Q1 → Q2 → result): make the root a "free" box and give EACH
  screen its own full-page column at x 0, y 0, width 390, height 844 with the page padding, shown with
  "show": "phase == 'ready'" etc. Screens overlay; never stack them in one column.

═══ COMPONENTS — reference by name, pass props ═══
{ "id": "go", "use": "Button", "props": { "label": "시작" }, "onTap": [ … ] }
- In a column: omit width. Sharing a row: "width": "fill".
- Props are templates, so live values go straight in: { "use": "StatCard", "props": { "label": "점수", "value": "{score}점" } }.
Available:
${COMPONENT_CATALOG}

═══ CONTAINER PATTERNS (build these yourself) ═══
- CARD: { "box":"column", "fill":"${T.surface}", "pad":16, "gap":8, "children":[ … ] }. If it holds text whose length
  varies (a quiz question, live data) keep "justify" at start — centered content that grows spills out both ends.
- ROW of choices: { "box":"row", "gap":12, "children":[ {…,"width":"fill"}, {…,"width":"fill"} ] }
- GRID: { "box":"grid", "columns":2, "gap":12, "children":[ … ] }
- GAME FIELD: a fixed-height { "box":"free", "height":340, … } with pieces at x/y read from variables
  ("x":"{moleX}"). Everything else (title, score, timer, buttons) still uses columns/rows/components.

═══ GAME LOOP — a game MUST start and end ═══
- vars: score 0, startedAt 0, duration (e.g. 15000).
- "ready": title + Button "시작" whose onTap sets score 0, startedAt now, then { "go": "play" }.
- "play": the mechanic changes score; a timer text "{max(0, ceil((duration - (now - startedAt)) / 1000))}초";
  end with phases.play.tick: [ { "if": "now - startedAt >= duration", "then": [ { "go": "result" } ] } ].
- "result": the final score + a "다시하기" Button → { "go": "ready" } (or straight to "play").

═══ SNAPPY / INSTANT-FEEDBACK (Korean users are impatient — NO dead time) ═══
- QUIZ: each answer is a full-width OptionCard; tapping it immediately marks right/wrong (OptionCard accent or a
  colored result line) AND advances — no separate "제출"/"다음" for the common case. Keep questions ≤ 2 lines (~40 chars).
- Results appear on the action itself, not behind a confirm step. One tap = one clear outcome.

═══ DYNAMIC CONTENT — fresh data every hour (optional, content-fed apps only) ═══
Add "data": { "url": "/api/content?kind=<kind>&theme=<korean theme>" } and declare vars whose names EXACTLY match
the returned keys (the player fetches on load and sets them). Kinds → keys:
- quiz → { "questions": [{ "q", "choices": [4], "answer": <0-based index> }] }
- worldcup → { "candidates": [16 strings], "title" }
- balance → { "dilemmas": [{ "a", "b" }] }
- hot → { "keywords": [10 strings], "updatedLabel" }
Initialize those vars to small placeholders ([] or a short sample) so the screen renders before data arrives.
Pure games, counters and personality tests do NOT need it.

═══ DESIGN TOKENS — use these, keep it disciplined ═══
bg ${T.bg} · surface(card) ${T.surface} · raised ${T.surfaceTop} · border ${T.border} · accent(lime) ${T.accent} · text-on-accent ${T.onAccent} · text ${T.text} · muted ${T.textMuted} · danger ${T.danger}.
ONE background, ONE accent (the primary action / current pick / 1st place — never decoration). Text on lime is always ${T.onAccent}.
Type: title 28–34 display, section 18–20/700, body 15–17/500, caption 12–13 muted. Square block corners, 2px borders,
hard offset shadows ({"x":0,"y":6,"blur":0,"color":"#000000"}). Real-world subjects: "image": "/api/img?q=<english keyword>".

═══ VARIABLE MODELING ═══
Only values that change at runtime are variables; fixed titles/labels/hints go straight into nodes. Variables live for
the whole app (all phases) — a pick made in one phase is readable in the next.

═══ MULTIPLAYER SOCIAL CONTRACT (votes/polls/this-or-that/rankings — many people, one shared live result) ═══
- vars: "votesByOption": {"A":0,"B":0} (the option keys), "myVote": "".
- Each choice onTap: [ { "set": "myVote", "value": "A" }, { "emit": "vote", "payload": { "option": "A" } } ].
  NEVER set votesByOption yourself — the server owns it and broadcasts it to everyone.
- Live result: ResultBar props from votesByOption, e.g.
  "pct": "{round(votesByOption.A / max(1, votesByOption.A + votesByOption.B) * 100)}".
- Non-social apps (counters, solo games, mood, quiz): local variables only, no emit.

═══ OTHER TOGETHER CONTRACTS ═══
CO-OP TALLY (everyone's taps add to ONE shared total — 다같이 1만번 클릭, 응원 게이지):
- vars "coopTotal": 0, "goal": 10000. Each tap: { "emit": "tally", "payload": { "delta": 1 } }. Never set coopTotal.
- Progress: a bar width "{round(min(1, coopTotal / goal) * 300)}" and text "{coopTotal} / {goal}".
LIVE LEADERBOARD (same game, compete on score — 두더지 레이스, 빨리 누르기):
- A GAME (follow the GAME LOOP) with vars "score": 0, "leaderboard": [], "best": 0.
- When a run ends: { "emit": "score", "payload": { "score": "{score}" } } (the server keeps each player's best and
  broadcasts the sorted top-10 array as "leaderboard").
- Result screen: an each over "leaderboard" ("{index + 1}위 · {item}점") plus your own score.

RULES: one valid JSON object (no comments / trailing commas / markdown). "start" names a phase. Every "go" names a phase,
every "set" names a declared variable. At least one interaction that changes a variable and a node that shows it.

A COMPLETE valid example for SYNTAX REFERENCE ONLY (build what the user asked, not this):
${JSON.stringify(GOLDEN_CLICK_COUNTER)}`;
