# 방 입장 확인 — 서명된 방 링크와 선택형 PIN (#157)

> 2026-10-16 · 상태: **PR 1(서버, #204) + PR 2(플레이어 · API · 문서) 구현** — 서버 `edge/room/src/admit.js` · `core.js` ·
> `game.js` · `worker.js` · `wrangler.jsonc` · `packages/snack-room/tools/edgeHub.js`; 플레이어 `snack-player/src/roomAdmission.ts` ·
> `roomTransport.ts` · `LiveApp.tsx` · `Screens.tsx`. 플레이어는 `/mint`로 15·20글자 코드를 받고 `organize`를 더 보내지 않는다.
> legacy 기한 2개는 아직 비어 있음(옛 10글자 링크 = 오늘 동작) — 3단계(설정만)에서 켠다.
> 관련: `docs/edge-rooms.md` §3(플레이어 화면 흐름 · 실패 문구 · 비용 표 · 비밀 교체), `docs/room-results.md`(결과 보관).

## 사장님용 요약 (쉬운 말)

- 지금까지는 방 링크만 있으면 누구나 들어올 수 있었고, 서버가 가짜 방 코드를 걸러내지 못했고, 아무나 방을
  무한정 만들 수 있었습니다. 이 구멍을 막습니다.
- 방 링크에 **서버만 만들 수 있는 서명**을 붙입니다. 서버 문지기(Worker)가 가짜 링크와 장난 요청을 방 안까지
  들이지 않고 문 앞에서 돌려보냅니다. 그래서 무료 사용량이 거의 줄지 않습니다.
- 비밀번호(PIN) 없는 방은 지금과 똑같이 **링크 한 번 탭**이면 들어갑니다. 속도와 비용도 그대로입니다.
- 방장은 원하면 **숫자 4자리 비밀번호**를 걸 수 있습니다(방장이 아직 혼자일 때만, 새 링크로 바뀜). 비밀번호
  방은 링크와 비밀번호를 둘 다 알아야 들어오고, 한 번 들어오면 그 기기는 12시간 동안 다시 묻지 않습니다.
  서버는 비밀번호를 저장하지 않습니다.
- 비밀번호를 여러 번 틀리면 **틀린 그 사람만** 잠깐 잠깁니다(1분부터 두 배씩, 최대 1시간). 다른 친구는 영향이
  없습니다. 한 방에서 모두 합쳐 50번 틀리면 새로 들어오는 사람을 막고 방장에게 알립니다 — 방장은 버튼 한 번으로
  새 링크를 만듭니다. 4자리라도 뚫릴 확률은 방당 0.5% 이하입니다.
- 모두 무료 범위 안입니다. 이미 공유된 옛 링크는 플레이어 새 버전(PR 2)이 나간 뒤 **7일 동안** 그대로 됩니다.
- 이번 PR은 **서버만** 바꿉니다. 지금 화면·링크는 그대로 동작하고(검증함), 비밀번호 화면과 새 링크는 PR 2에서
  나옵니다.

### 사장님 결정 (2026-10-16, 모두 추천안대로)

| # | 질문 | 결정 |
|---|---|---|
| 1 | 비밀번호는 방장이 혼자일 때만 걸거나 바꿀 수 있게? | **네.** 바꾸려면 새 링크. 서버에 비밀번호를 저장하지 않음 |
| 2 | 비밀번호 없는 링크가 하루 넘게 비어 있었으면? | **조용히 새 방을 연다.** 한 번 탭 유지 (구현됨 — 아래 흐름 B) |
| 3 | 옛 링크(10글자 코드)는? | **7일 동안만 받고, 그 뒤엔 "링크가 만료됐어요".** 기한은 PR 2 배포 뒤 설정만 바꿔 켬 |

---

## 1. Threat model

| Threat (today) | What stops it now |
|---|---|
| Anyone guessing / inventing a `slug~CODE` id wakes a Durable Object and creates a room (W1 D2 R2 each) | v2 codes carry a 25-bit tag T over slug + kind, checked in the Worker with no storage: a forged id is refused at the Worker (W1 D0 R0), counted in the meter |
| Any client creates rooms without bound | Meter `admit({ipKey})`: ≤ 20 new rooms per ipKey per hour (memory only, best effort) + Worker `IP_RL` 120 upgrades / min / ipKey |
| A public room "locked" by a prankster's PIN, or organized by whoever came first with `organize: true` | Public ids (`slug`, `slug.gN`) never get a PIN or an organizer |
| `organize: true` on any friends room: the first socket becomes host | v2 codes: the organizer comes only from the `/mint` ticket (`orgt`, 10 min, signed) presented when the room is created |
| PIN brute force (old room-wide lock locked everyone out; no global cap) | Per-ipKey lock + per-code cap of 50 wrong (survives the room's deletion) + Worker rate limits before any DO request |
| A link leaks: PIN guessable offline? | No: V = HMAC(server key, slug, R, PIN) — useless without the key |
| Client-sent `x-room-*` headers impersonating the Worker | Worker deletes every client `x-room-*` header; the DO accepts an upgrade only with a valid signed admit claim (30 s) |
| One socket flooding (react spam = one DO request per frame) | Per-socket budget: burst 30, 4/s refill, 1,800/h; reactions ≤ 3/s from an allowlist; usage stage 3 (≥ 95 %) closes sockets above 1 frame/s |
| `/relay` (MQTT-era mesh relay) as an unchecked side door | Worker answers 410 (the live build uses `/room` only — `deploy-cloudflare.yml` sets no `VITE_ROOM_MODE`) |

Not covered (accepted, see §8): many-IP floods of the Worker's 100k/day (requests are billed before Worker code runs —
the meter stages are the guard; the real fix is a custom domain + WAF, out of scope); a link holder opening many
sockets from one address.

## 2. Room code v2 (the link's `?room=`)

Alphabet: the 32 symbols of `snack-player/src/links.ts` (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), 5 bits each.

| Kind | Length | Layout |
|---|---|---|
| open (no PIN) | 15 | `R(10) + T(5)`, `T = trunc25(HMAC(Kc, "c2\|"+slug+"\|"+R+"\|o"))` |
| pin | 20 | `R(10) + T(5) + V(5)`, `T = trunc25(HMAC(Kc, "c2\|"+slug+"\|"+R+"\|p"))`, `V = trunc25(HMAC(Kv, "v2\|"+slug+"\|"+R+"\|"+pin))` |
| legacy | other 8–32 | codes from before v2 (the player makes 10); accepted until `LEGACY_JOIN_UNTIL` |

- R = 50 random bits (as today). T covers slug and kind: a code moved to another app, or a PIN code with V cut off
  (15 symbols left), fails.
- The player's `roomParamOf` already accepts 8–32 symbols, so today's client opens 15/20-symbol links unchanged.
- Room ids: public `^[A-Za-z0-9-]{1,80}(\.g\d{1,6})?$`; friends `slug~CODE` with the same slug charset. Anything else
  is refused (`bad` 4000, or `expired` 4004 for a `~` id whose code is not a code).

**Keys** — all HKDF-SHA256 (empty salt) from `ROOM_TOKEN_SECRET`:

| Key | info | Use |
|---|---|---|
| Kc | `snack/code/v2` | code tag T |
| Kv | `snack/pin/v2` | PIN tag V |
| Ki | `snack/ip/v1` | ipKey |
| Ka | `snack/admit/v1` | admit claim |
| Kp | `snack/pass/v1` | pass |
| Ko | `snack/orgt/v1` | /mint organizer ticket |

Seat and organizer tokens keep the plain secret and format (open tabs keep working). Rotating the secret voids every
v2 link, pass and token at once — acceptable for ephemeral rooms.

## 3. Tokens

All are `base64url(JSON).base64url(HMAC-SHA256)` (`admit.js signToken`). New kinds carry `k`; a verifier accepts only
its own kind (each kind also has its own key).

| Token | Payload | Lifetime | Kept | Checked by |
|---|---|---|---|---|
| orgt (mint ticket) | `{r, k:"orgt", exp}` | 10 min | `/mint` answer → hello `organizerToken` | DO, only when it creates the room → the usual 12 h organizer token |
| admit (Worker → DO, header `x-room-admit`) | `{r, k:"admit", v, i, a?, c, exp}` — v: `open \| pin \| pass \| seat \| public \| legacy`, i: ipKey, c: may create | 30 s | socket attachment (`adm`) | `Game.fetch`: no valid claim → 403 |
| pass (PIN rooms) | `{r, k:"pass", a:anonId, exp}` | 12 h | client (PR 2: localStorage) | Worker: signature, r, k, exp; DO: `a === hello.anonId` |
| seat (unchanged) | `{r, p:epoch, exp, a}` | 15 min, refreshed on traffic | sessionStorage | DO (epoch); for PIN rooms also as `?k=` at the Worker (signature, r, exp) |
| organizer (unchanged) | `{r, p, exp, o:1}` | 12 h | sessionStorage | DO |
| ipKey | `b64u(HMAC(Ki, IPv4 /32 or IPv6 /64)[0:8])` from `CF-Connecting-IP` | — | rate-limit keys, the room's `pinlock`, the socket attachment | the raw address is never stored |

`?k=` and `?pin=` ride in the WebSocket URL; the Worker removes both before forwarding. Safe while `observability` is
off in `wrangler.jsonc`; turning logging on needs them moved to `Sec-WebSocket-Protocol` first.

## 4. Admission flows

The Worker decides first (`admit.js decideUpgrade`, the hub runs the same function), in this order: path → Origin
(only when the header is present) → `IP_RL` → kind → code tag → (PIN room) `k` → `PIN_RL` / `PINIP_RL` → V.

- **A. Host, no PIN** — `POST /mint {"slug"}` (text/plain, no preflight) → `{code(15), org}`, no DO. Socket
  `/room/slug~CODE` → admit `{v:"open", c:1}` → hello with `organizerToken = org` → DO creates meta `{epoch, org:1}`
  through `Meter.admit({ipKey})`, sends seat + 12 h organizer token.
- **B. Friend, no PIN** — same path as today, no extra round trip: tag checked in the Worker, admit `{v:"open", c:1}`.
  No meta (e.g. the room sat empty > 24 h and was cleaned up) → quietly created again (owner decision 2).
- **C. Host sets a PIN** (PR 2 UI; only while alone) — `POST /mint {slug, pin, anonId}` → `{code(20), org, pass}`. The
  client switches to the new code (nobody else is in yet) and enters with `?k=pass`. The PIN stays on the host's
  device only. Where the host chooses it (#208): the 나 맞히기 maker page's "비밀번호 걸기" row by 완료 (off by default)
  — then 완료's one `/mint` already carries the PIN (no open room first, no switch); the quiz lobby's band next to
  친구 초대하기; the QR invite sheet. The lobby button and the QR row show only while the host is alone.
- **D. Friend, PIN room** — `?k=` pass / seat first; else `?pin=dddd`. Right PIN → forwarded with no RPC; the DO reads
  `pinlock` inside the upgrade: locked ipKey / closed room → the *same* frame a wrong PIN gets (close 4003); otherwise
  this ipKey's wrong-count is cleared. After the hello the DO sends `{t:"pass", d:{token, exp}}`. Wrong PIN → one RPC
  `Game.pinAttempt({roomId, ipKey})` → `pin{left}` / `locked{retryIn}` / `closed`.
- **E. Public room** (`slug`, `slug.gN`) — admit `{v:"public", c:1}`; never an organizer or a PIN (hello `organize`
  / `pin` ignored). Auto-start with 2+ and `moveTo` unchanged.
- **Legacy codes** — admit `{v:"legacy"}`; hello `organize` / `pin` (PBKDF2) work as before on `~` ids.
  `c = now < LEGACY_CREATE_UNTIL`; after `LEGACY_JOIN_UNTIL` → `expired` at the Worker. Both empty = today.

**Refusals at the Worker**: the Worker opens its own `WebSocketPair`, sends `{t:"denied", d:{reason, retryIn?, left?}}`
and closes (a browser hides an upgrade's HTTP status). Close codes: `expired` 4004 · `pin-required` / `pin` / `locked`
/ `closed` 4003 · `slow` 4029 · `origin` / `bad` 4000.

## 5. Limits

| Limit | Where | Value |
|---|---|---|
| `IP_RL` | Worker, per ipKey | 120 upgrades / 60 s (generous: a park's NAT) |
| `PIN_RL` | Worker, per ipKey\|room | 10 PIN tries / 60 s |
| `PINIP_RL` | Worker, per ipKey | 20 PIN tries / 60 s, all rooms |
| `MINT_RL` | Worker, per ipKey | 10 `/mint` / 60 s |
| PIN lock | DO `pinlock`, per ipKey | 5 wrong in a row → 1 min, doubling per lock to 1 h; a right PIN resets it |
| PIN cap | DO `pinlock`, per code | 50 wrong in all → `closed` (pass / seat / organizer still enter); kept 7 days by its own `exp`, through the room's 24 h cleanup |
| Organizer alerts | DO → organizer | `{t:"alert", d:{kind:"pin_failures", n}}` at every 5th wrong in 10 min; `{t:"pinClosed"}` on the close (and at the organizer's next hello) |
| New rooms | Meter DO, per ipKey | 20 / hour (memory; a restarted meter forgets) → `slow` |
| Socket frames | DO, per socket | burst 30, +4/s, ≤ 1,800 / hour → `denied{slow}` + 4029 |
| Reactions | DO, per socket | ≤ 3/s, allowlist ❤️ 🔥 😂 👍 😮 (snack-player `REACTIONS`); extra ones are dropped, not spread |
| Usage stage 3 | DO | at ≥ 95 % of any free limit: a socket above 60 frames / min → 4029 |
| Actions | DO | 15/s as before (`actionAck rate_limited`) |

No per-IP frame budget (200 phones behind one park NAT). A tap game sends ≤ 4 frames/s (`tapBatchMs` 250), within the
refill.

**Rate-limit backend (step 0).** The four limits are Cloudflare Workers Rate Limiting bindings (`ratelimits` in
`wrangler.jsonc`). The pinned wrangler (4.136.3) accepts them in `deploy --dry-run`; whether the **free plan** accepts
them is only known on a real deploy, so they are on the **dev** env only (`snack-room-dev`, deployed from `develop`).
Without a binding (the live Worker now, the Node hub) the Worker counts in its own isolate (`admit.js MemoryLimiter`,
bounded LRU, fixed window) — per isolate only, so weaker; the DO's PIN lock and 50-cap still bound guessing. If the
develop deploy shows the bindings work, copy the block to the top level with other `namespace_id`s.

## 6. Endpoints and messages

| Path | Behaviour |
|---|---|
| `POST /mint` | body `{slug, pin?, anonId?}` (≤ 1 KB; `anonId` required with a PIN — the pass is bound to it) → 200 `{ok, code, org, pass?}` · 400 `bad_request \| bad_slug \| bad_pin \| bad_anon` · 403 `origin` · 429 `slow{retryIn}`. No DO. `OPTIONS` → 204 |
| `GET /room/<id>` (WS) | as §4 |
| `GET /room/<id>/result` | friends ids whose tag checks out (legacy until `LEGACY_JOIN_UNTIL`); a PIN room only with `?k=<pass \| seat \| organizer>` — else 404 with no DO. The stored result of a PIN room carries `pin: 1` and the DO serves it only to a Worker-checked request |
| `/relay/*` | 410, no DO |
| `/usage` | unchanged |

Server → client, new: `pass`, `pinClosed`, `alert`; `denied` reasons `expired`, `slow`, `origin`, `locked`, `closed`
(plus the existing `pin`, `pin-required`, `room_full_today`, `seat_taken`, `full`, `bad`). The current player treats
unknown messages as no-ops; the new reasons only occur for v2 links / limits it does not create yet.

**Vars** (`wrangler.jsonc`, top level and `env.dev`): `ALLOWED_ORIGINS` (live: `https://playsnack.pages.dev,
https://*.playsnack.pages.dev`; dev adds `http://localhost:*`, `http://127.0.0.1:*`; no Origin header = allowed),
`LEGACY_CREATE_UNTIL`, `LEGACY_JOIN_UNTIL` (ISO date or epoch ms; empty = no limit).

## 7. Free-tier cost

W = Worker requests, D = DO requests (incoming WS messages 1:1), R = rows written. No KV.

| Case | Before | Now |
|---|---|---|
| Friend joins, no PIN | W1 D2 R0 | **W1 D2 R0 (same)** |
| Host creates (with or without PIN) | W1 D3 R2 | W2 D3 R2 (`/mint` +1 W, no DO) |
| PIN entry, right first time | — | W1 D2 R0 (+1 R if that ipKey had wrong tries) |
| Re-entry with pass / seat | W1 D2 | W1 D2 |
| Wrong PIN (counted) | D1 R1 | W1 D1 R1 (first one in an empty room: +1 R +1 D for its cleanup alarm) |
| Wrong PIN while locked / closed | D1 R0 | W1 D1 R0 |
| Rate-limited, forged code, bad Origin, `/relay`, PIN-room result without `k` | W1 D1–2+, R2 if it created a room | **W1 D0 R0** |
| Host keepalive (#142): host on screen in lobby / result, `"ping"` every 20 s | — | **W0, GB-s 0** (auto-response); D ≤ 180 / room-hour counted 1:1 in the meter as `pings` (whether CF counts them is undocumented) = 0.18 % of 100k/day per room-hour; a non-matching ping wakes the DO → `pingMiss` (must stay 0) |

The Worker's own refusals are counted in the meter (`workerExtra` → Worker requests, RPCs → `doExtra`, their rows),
batched per isolate: one meter call per 200 counted requests or per 60 s, checked on the next request — no timer,
no DO kept awake (`admit.js WorkerTally`; ≈ 0.5 % overhead; an evicted isolate loses its unsent count).

Worst cases: one PIN room brute-forced = ≤ 50 rows and ~100 D for its lifetime, success ≤ 0.5 %; ids sprayed without
a code = W1 D0 each (≈ 70/min from one IP exhausts 100k W/day — Worker code cannot prevent billing of requests it
receives; the meter's stages 1/2 act first, no charge on the free plan); public-room creation ≤ 20/h per ipKey; one
socket ≤ 1,800 frames/h (≈ 43k D/day) — several sockets from one address remain the largest residual risk (stages 2/3
and the 70 % alert issue).

## 8. Roll-out

| Step | What | State |
|---|---|---|
| PR 1 (server) | admit.js, RoomGate / PinLock / UsageMeter, game.js, worker.js (`/mint`, upgrade check, refusal socket, header strip, `/result`, `/relay` 410, meter tally), results `pin: 1`, wrangler, edgeHub, tests | **this PR** — backward compatible, legacy deadlines empty |
| 0 (verify) | `ratelimits` on the free plan | on the develop deploy (dev env only) |
| PR 2 (player, API, docs) | `/mint` from "🤝 친구끼리" / the quiz maker, PIN sheets (set / enter), pass storage, `denied` reasons in the UI, host PIN notice, telemetry reasons, `CODE_RE` 15/20 in og / functions (no lookup for 20), `docs/edge-rooms.md` | **done** (this doc's companion PR) |
| 3 (config only) | `LEGACY_CREATE_UNTIL` = PR 2 live + 24 h, `LEGACY_JOIN_UNTIL` = PR 2 live + 7 days | after PR 2 is live |
| PR 4 (cleanup) | drop legacy branches, PBKDF2 path, `RoomRelay`, then the `Room` class migration | after `LEGACY_JOIN_UNTIL` |

## 9. Tests (PR 1)

- `packages/snack-room/test/edge-admit.test.js` — in memory: code mint/verify, kinds, tamper / slug swap / V
  stripped, ipKey (/64 grouping), token kinds cannot cross, admit expires in 30 s, header strip, Origin,
  `decideUpgrade` (no RPC for forged codes; legacy deadlines on a fake clock; rate limits), `decideMint`,
  `decideResult`, `WorkerTally`, `PinLock` (per-ipKey lock, reset on success, no write while locked, 50-cap kept
  through `roomAlarm`), GameRoom (orgt only on `~` ids, public ids never organized / PIN-locked, legacy rules,
  pass bound to anonId, organizer alerts / pinClosed, react limit, frame budget 4029, meter per-ipKey rooms and
  stage 3).
- `packages/snack-room/test/edge-admission.test.js` — on the Node hub: costs (friend join D2 R0; forged code no room,
  W1 in the meter), PIN flow (pin-required / wrong 1 row / right + pass / reload with pass / pass bound to device and
  room), per-address lock, 50-cap with pass holders and the organizer's `pinClosed`, the cap through cleanup, 24 h
  re-create, public ids, `/result` with / without pass, legacy deadlines, `/relay` 410, Origin, `IP_RL`.
- Existing edge tests: organize / PIN cases moved to legacy `~` ids (public ids no longer take them).
- workerd smoke (`wrangler dev --local --env dev`): `/relay` 410, forged code 4004, mint + orgt organizer, PIN
  required / wrong (RPC) / right + pass / pass re-entry, header strip, PIN-room result 404, Origin 4000, `MINT_RL`
  binding 429, right PIN while locked = wrong-PIN frame.
- Unchanged player end to end against the new hub: `room-rules-e2e`, `silent-rejoin-e2e`.

## 9b. Tests (PR 2, player)

- `snack-player/test/roomAdmission.test.ts` — `roomKindOf`; `/mint` (text/plain, anonId only with a PIN, refusals / odd answers /
  network / timeout never throw); pass store (expiry, cap 20, host PIN kept, blocked storage → memory); the failure copy table and the
  PIN screen lines; the transport: `?pin=` only in the URL (never the hello), pass kept, PIN wiped after the first state, reload on
  `?k=pass` / seat, open and legacy rooms carry nothing, wrong / locked / pin-required (no reconnect loop, a stale pass dropped, a typed
  PIN not shadowed by an old seat), final reasons and 4003 / 4004 closes, `alert` / `pinClosed` to the screen, `/result?k=`.
- `snack-player/test/shellDocks.test.ts` — the host PIN notice clear of the top-row pills and 😀 at 320–430 px.
- `api/_test/og.test.js` (15 / 20 symbols, no lookup for a PIN room), `api/_test/telemetry-client.test.js` (reasons kept by the ingest).
- `snack-server/tools/pin-room-e2e.mjs` (in gate-all): one-tap join (15), PIN set while alone (20), PIN screen before any socket,
  wrong → tries left, right → in, reload on the pass, locked countdown, host alert, forged → expired, public room unchanged;
  #208 PIN set in the quiz maker → exactly one `/mint` with it, friend gets the PIN screen; default off → plain room, lobby
  "비밀번호 걸기" beside 친구 초대하기 (fits at 320 / 360 px) and gone once a friend joins; #209 a computer (1280×800) →
  친구 초대하기 copies (clipboard read back, "링크를 복사했어요"), `navigator.share` never called.
- `snack-player/test/invite.test.ts` (#208 / #209) — touch vs computer (`(pointer: coarse)`, mobile UA, iPadOS-as-Mac), share only
  on touch, clipboard ok / refused, the copied lines, the lobby PIN rule, the maker's one mint with / without a PIN.

## 10. Residual risks

- Workers Rate Limiting on the free plan: unverified until the develop deploy.
- Many-IP Worker floods and same-address multi-socket floods are not fully stopped (stages hold the line).
- A link holder can close a PIN room to newcomers with 50 wrong tries; the host recovers with a new link (PR 2).
- Tokens in the query string: move them before enabling observability.
- Old tabs (not reloaded) cannot open PIN links; a reload fixes it.
- `IP_RL` 120/min may trip when 200 people on one Wi-Fi join at once — watch `slow` in telemetry (`join_failed_reason:slow`, PR 2).
- The host's PIN sits in its own browser's localStorage (with the pass, 12 h) so the invite sheet can show it again; a shared
  device could reveal it. Accepted for a 4-digit room PIN; it never leaves the device.
