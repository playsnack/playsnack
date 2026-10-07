# snackapp

Make small interactive apps — games, polls, quizzes, "world cup" brackets — by
chatting, and share them as a link that plays live with everyone who opens it.

Apps are JSON documents for **Bite**, a small engine built for this project:

```json
{
  "bite": 1,
  "meta": { "name": "Tap counter" },
  "frame": [390, 844],
  "vars": { "count": 0 },
  "start": "idle",
  "phases": { "idle": {} },
  "view": {
    "box": "column", "pad": [59, 16, 34, 16], "gap": 16,
    "children": [
      { "text": "{count} taps", "font": "display", "size": 40 },
      { "use": "Button", "props": { "label": "+1" }, "onTap": [{ "set": "count", "to": "count + 1" }] }
    ]
  }
}
```

The full format is specified in [`docs/bite-format.md`](docs/bite-format.md).

## Architecture

| Package | What it does |
|---|---|
| [`packages/bite`](packages/bite) | Runtime: variables, phases, a sandboxed expression language, actions, host events. No rendering; runs in Node and browsers. |
| [`packages/bite-layout`](packages/bite-layout) | Expands a document and lays it out with Yoga (flexbox). Text is measured from bundled font metrics, so a server computes exactly the layout a phone shows. Hit-testing and layout lint. |
| [`packages/bite-pixi`](packages/bite-pixi) | Renderer on Pixi v8: drawing, taps, scrolling. |
| [`snack-player`](snack-player) | React app: home, live player (`/p/:slug`), chat builder with in-place text editing. |
| [`snack-server`](snack-server) | Express + WebSocket: templates, rooms (an app `emit`s → the server decides → `setVar` to everyone), fresh content, the AI builder. |

The AI builder asks an OpenAI model for a Bite document, grounds it on the
closest proven template, then validates it, plays it headless (tapping every
control once) and lints the layout of every phase it reaches, repairing until
it passes.

## Run

```bash
pnpm install
cp snack-server/.env.example snack-server/.env   # set OPENAI_API_KEY, PORT=4399
pnpm server:dev      # http://localhost:4399
pnpm player:dev      # http://localhost:5290  (or `pnpm player:build` and let the server serve it)
```

Try a sample without the server: `http://localhost:5290/?bite=showcase`.

## Quality gates

```bash
pnpm bite:test                                   # engine unit tests
pnpm bite:check                                  # browser: layout == Node layout, real taps, scrolling
node snack-server/tools/gate-all.mjs             # templates: layout, content, consistency, oracle, multiplayer sync
node snack-server/tools/gate-all.mjs --battery   # + AI generation reliability (needs an OpenAI key)
```

## Third-party

Code: [jsep](https://github.com/EricSmekens/jsep) (MIT), [yoga-layout](https://github.com/facebook/yoga) (MIT),
[pixi.js](https://github.com/pixijs/pixijs) (MIT), React (MIT), Express (MIT), ws (MIT).
Fonts (bundled in `snack-player/public/fonts`): [Pretendard](https://github.com/orioncactus/pretendard) and
[Galmuri](https://github.com/quiple/galmuri), both SIL Open Font License 1.1 — license texts alongside the font files.
