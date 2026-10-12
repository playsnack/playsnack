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
| [`packages/snack-room`](packages/snack-room) | The room engine (lobby → countdown → play → result, votes, tallies) and the ways to run it: on a server, on a host player behind a thin relay, or with no server at all (players meet on a public MQTT broker and elect a host). |
| [`packages/snack-content`](packages/snack-content) | Keyless content: curated banks and seed pools for quizzes and brackets. |
| [`snack-player`](snack-player) | React app: home, live player (`#/p/<slug>`), chat builder with in-place text editing. |
| [`snack-server`](snack-server) | Optional. Express + WebSocket: templates, rooms (an app `emit`s → the server decides → `setVar` to everyone), fresh content, the AI builder. |

The AI builder asks an OpenAI model for a Bite document, grounds it on the
closest proven template, then validates it, plays it headless (tapping every
control once) and lints the layout of every phase it reaches, repairing until
it passes.

## Run

**Serverless (default)** — a static site. Content ships with it, rooms run on one of
the players (the others reach it through a public MQTT broker), and a shared app
travels inside its link. The AI builder needs a server, so it is off here.

```bash
pnpm install
pnpm player:dev      # http://localhost:5290
pnpm player:build    # → snack-player/dist, host it anywhere static
```

Deployed on Vercel from this repo (`vercel.json`): a push to `main` rebuilds the site
when the commit's author is the repo owner (see [Contributing](#contributing)).

**With the server** — adds the AI builder, fresh hourly content, ratings and global stats.

```bash
cp snack-server/.env.example snack-server/.env   # set OPENAI_API_KEY, PORT=4399
pnpm server:dev      # http://localhost:4399
VITE_SERVER_URL=http://localhost:4399 pnpm player:dev   # http://localhost:5290
```

Try a sample without the server: `http://localhost:5290/?bite=showcase`.

## Quality gates

```bash
pnpm bite:test                                   # engine unit tests
pnpm bite:check                                  # browser: layout == Node layout, real taps, scrolling
node snack-server/tools/gate-all.mjs             # templates: layout, content, consistency, oracle, multiplayer sync
node snack-server/tools/gate-all.mjs --battery   # + AI generation reliability (needs an OpenAI key)
SIM_MESH=1 node snack-server/tools/multiclient-sim.mjs   # multiplayer sync over the public broker, no server
```

## Contributing

`main` is what the live site serves, so changes reach it only through a pull request
that the owner merges.

1. Branch off the latest `main` — never commit or push to `main` directly.
   ```bash
   git switch main && git pull
   git switch -c <your-name>/<short-topic>      # e.g. moonjong/quiz-timer
   ```
2. Commit, push the branch, and open a pull request into `main`. Describe what changed
   and how you checked it (which gates you ran, what you tried on a phone).
3. Keep pushing to the same branch while it's reviewed; pull in `main` if it moves on.
4. The owner (@seukwoo) reviews and merges with **Create a merge commit**.

Why the merge method matters: the site runs on Vercel's free plan, which deploys a commit
only when its author is the account owner. A merge commit is authored by whoever merges,
so the merge goes live. *Squash and merge* and *Rebase and merge* keep the contributor as
author, and Vercel blocks the deploy. A commit pushed straight to `main` by anyone else is
blocked the same way — it won't show up on the site, but it ships unreviewed with the
owner's next push, so don't.

## License

© 2026 seukwoo. All rights reserved — the source is public to read, not to use, copy,
modify, redistribute or host. See [`LICENSE`](LICENSE).

## Third-party

Code: [jsep](https://github.com/EricSmekens/jsep) (MIT), [yoga-layout](https://github.com/facebook/yoga) (MIT),
[pixi.js](https://github.com/pixijs/pixijs) (MIT), React (MIT), Express (MIT), ws (MIT), [MQTT.js](https://github.com/mqttjs/MQTT.js) (MIT).
Fonts (bundled in `snack-player/public/fonts`): [Pretendard](https://github.com/orioncactus/pretendard) and
[Galmuri](https://github.com/quiple/galmuri), both SIL Open Font License 1.1 — license texts alongside the font files.
