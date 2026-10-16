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
| [`snack-player`](snack-player) | React app: home, live player (`/p/<slug>`, `?room=<code>` for an unlisted friends-only room; old `#/p/<slug>` links still open), chat builder with in-place text editing. |
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
pnpm player:build    # → snack-player/dist; any static host that serves index.html for /p/* (see Links)
```

**Links** are plain paths: `https://<host>/p/tpl-tap-battle` opens an app's public room,
`…/p/tpl-tap-battle?room=K7MNP2QRS4` a friends-only room (the top-row "🌐 공개방 ⇄ 🤝 친구방" chip makes the
code: 10 symbols from a 32-letter alphabet, 50 bits), and a made app travels inside its
link's fragment (`/p/app-<hash>#d=…`, never sent to a server). The static host must serve
`index.html` for `/p/*` (Cloudflare Pages `_redirects`, see `cloudflare/pages/`; snack-server has the same fallback). Old
`#/p/…` links still open and are rewritten to the path form in place.

A friends-only room is **unlisted, not private** unless it has a PIN: the code keeps
strangers from stumbling in. Rooms run on the room server (Cloudflare Durable Objects,
`edge/room/`, `docs/edge-rooms.md`): the server runs the game and judges answers, so
answers never reach phones before the reveal.

Live at **https://playsnack.pages.dev** (Cloudflare Pages + Pages Functions for `/api/*`;
rooms on `snack-room.playsnack.workers.dev`; stats in Upstash). Every merge to `main` deploys automatically
(`.github/workflows/deploy-cloudflare.yml`; see `docs/cloudflare-pages.md`).

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
node snack-server/tools/live-e2e.mjs --base https://develop.playsnack.pages.dev   # released room features on a deployed site, real browsers (live: --base https://playsnack.pages.dev)
```

## Contributing

`main` is what the live site serves and only takes pull requests. Day-to-day work goes to
`develop`, which deploys to a test copy of the site. Full rules: [`docs/git-as-jira.md`](docs/git-as-jira.md).

1. Branch off the latest `develop`: `git switch develop && git pull && git switch -c <your-name>/<issue>-<topic>`.
2. Open a pull request into `develop` (the default) with what changed and how you checked it.
   Merge with **Create a merge commit**. It deploys to `https://develop.playsnack.pages.dev`.
3. Check it there on a phone. A release pull request `develop` → `main` then ships the checked
   work to `https://playsnack.pages.dev`.

## License

© 2026 seukwoo. All rights reserved — the source is public to read, not to use, copy,
modify, redistribute or host. See [`LICENSE`](LICENSE).

## Third-party

Code: [jsep](https://github.com/EricSmekens/jsep) (MIT), [yoga-layout](https://github.com/facebook/yoga) (MIT),
[pixi.js](https://github.com/pixijs/pixijs) (MIT), React (MIT), Express (MIT), ws (MIT), [MQTT.js](https://github.com/mqttjs/MQTT.js) (MIT),
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT, Kazuhiko Arase — the invite QR; "QR Code" is a
registered trademark of DENSO WAVE). Tests only: [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0).
Fonts (bundled in `snack-player/public/fonts`): [Pretendard](https://github.com/orioncactus/pretendard) and
[Galmuri](https://github.com/quiple/galmuri), both SIL Open Font License 1.1 — license texts alongside the font files.
