// Host-action payload contract: what each room action (an app's `emit`) must
// carry for room.js `action()` to act on it. Mirrors room.js exactly — the
// drift test packages/bite/test/contract.test.js runs every entry through the
// real createRoom (and validates every template against this contract), so a
// change on either side that breaks the other fails there. Documented in
// docs/bite-format.md §6.1.
//
// Shape (consumed by @snack/bite validate(doc, { hostActions })):
//   payload: "none"     — no payload is read (anything sent is ignored)
//            "object"   — a JSON object with `fields`
//   number:  true       — a bare number is also accepted (start: duration ms)
//   fields:  { key: { type, required?, enum?, text? } }
//            type ∈ "string" | "number" | "boolean" | "array" | "object"; an array = any of them
//            text: true  — free text (a content/game id), so a string that
//                          happens to equal a variable name only warns

/** @type {import("./actions").HostActions} */
export const HOST_ACTIONS = Object.freeze({
  // r.voters.set(anonId, String(payload.option)); dropped when option == null
  vote: {
    payload: "object",
    fields: { option: { type: ["string", "number"], required: true } },
    description: "cast / change this player's vote — option key such as \"o0\"",
  },
  // r.coop += Number(payload.delta) (non-finite → +1)
  tally: {
    payload: "object",
    fields: { delta: { type: "number" } },
    description: "add to the shared co-op total (default +1)",
  },
  // Number(payload.score) must be finite, else the action is dropped (no ack)
  score: {
    payload: "object",
    fields: { score: { type: "number", required: true } },
    description: "submit this player's score (best one is kept on the leaderboard)",
  },
  // payload unused: tap race +1 / nunchi claim / reaction tap, by session mode
  tap: { payload: "none", description: "one tap in the running session (race · nunchi · reaction)" },
  // Math.floor(Number(payload.count)) must be finite and ≥ 0, else dropped (no ack).
  // Fair tap race (MP-08): the device counts, sends its running total every ~250 ms and
  // once more at the end; the room keeps the max (≤ 15 taps/s of play — TAP_RATE_MAX).
  taps: {
    payload: "object",
    fields: { count: { type: "number", required: true } },
    description: "this player's cumulative tap count so far (tap race; send every ~250 ms and at the end — the room keeps the max)",
  },
  // Number(payload.ms) must be finite, else dropped (no ack).
  // Fair reaction duel (MP-08): "green shown → tap" measured on the device; < 80 ms or
  // before green = 부정출발 (0), after the window = not ranked, else 2000 − ms.
  reaction: {
    payload: "object",
    fields: { ms: { type: "number", required: true } },
    description: "reaction time this device measured (green → tap, ms; −1 = tapped before green)",
  },
  // Number(payload.option) === round.answer (0-based choice index, in the order shown).
  // ms = "question shown → tap" measured on the device; missing / not a number / < 0 /
  // past the window + 0.5 s → the host's own measurement; never above what the host saw
  // + 50 ms. One answer per player per round, only while a round is open; the quiz's subject
  // (pack sender) is ignored. round / sessionNo = what the device answered (roundIdx /
  // sessionNo): another round or game → actionAck {accepted:false, reason:"stale_round"}.
  // Change (#211): a later answer is a switch, taken only within CHANGE_WINDOW_MS (3 s, never
  // past the answer window) of the room taking the first one — scored from the last pick's ms
  // (never faster than the pick it replaces); else actionAck {accepted:false, reason:"locked"}
  // and myPick (what stands) goes back. n = the device's pick count this round: n at or below
  // the last one seen (a resend), or the same option → reason "duplicate".
  // Early reveal: once every present answerer (the subject excluded) has answered AND their
  // change windows have closed, EARLY_REVEAL_MS (300 ms) later; the leave of the last one still
  // to answer can complete it. A join never does — a newcomer reopens it to the window's end.
  answer: {
    payload: "object",
    fields: { option: { type: "number", required: true }, ms: { type: "number" }, round: { type: "number" }, sessionNo: { type: "number" }, n: { type: "number" } },
    description: "quiz answer — 0-based choice index, the answer time this device measured (ms), n = this device's pick count this round (switch within 3 s)",
  },
  // 나 맞히기: sanitizeQuizPack(payload) — title ≤40, 1–20 questions {q ≤80, options 2–4
  // each ≤30, answer}, settings {rounds 1–20, answerMs 3000–20000}; invalid questions are
  // dropped, none valid → actionAck {accepted:false, reason:"invalid_pack"}. Lobby/result
  // only (else "not_in_lobby"); in the lobby only the current subject may replace it (else
  // "not_subject", unless that subject has been gone 30 s); in a result the first new pack
  // wins until the next start (else "pack_waiting"). The sender becomes the subject, shown as
  // `about` (cleaned like a nickname) or else their nickname.
  quizPack: {
    payload: "object",
    fields: {
      title: { type: "string", text: true },
      about: { type: "string", text: true },
      questions: { type: "array", required: true },
      settings: { type: "object" },
    },
    description: "store this player's own quiz (they become its subject) — used by the next quiz start",
  },
  // #104: cleanNick(payload.nick) — trimmed, ≤ NICK_MAX (10) graphemes; empty → actionAck
  // {accepted:false, reason:"invalid_nick"}. Lobby/result only (else "not_in_lobby"). Updates
  // this player's roster entry, score owner name (raceBoard rows) and every connection of the
  // same anonId; per-player vars, pids and a stored quiz's `about` stay as they are.
  rename: {
    payload: "object",
    fields: { nick: { type: "string", required: true, text: true } },
    description: "change this player's nickname in the room (lobby / result only)",
  },
  // startSession(payload): a bare number = { duration }; getPack(game, opts) reads theme.
  // In a room with a stored quiz pack any start comes only from its subject (anyone once the
  // subject has been gone 30 s; else actionAck reason "not_subject"); a quiz start needs one
  // more player ("need_answerer"). `lobby` follows the same subject rule.
  start: {
    payload: "object",
    number: true,
    fields: {
      duration: { type: "number" },
      game: { type: "string", text: true },
      theme: { type: "string", text: true },
      mode: { type: "string", enum: ["reaction", "nunchi", "guess"] },
      bracket: { type: "boolean" },
      quiz: { type: "boolean" },
      rounds: { type: "number" },
      roundMs: { type: "number" },
      answerMs: { type: "number" },
      revealMs: { type: "number" },
      matchupMs: { type: "number" },
      goal: { type: "number" }, // co-op goal: taps add up to one total; reaching it ends play early
    },
    description: "start a synced session (countdown 3·2·1 → play → result)",
  },
  // payload unused: back to the lobby
  lobby: { payload: "none", description: "end the session and return to the lobby" },
});
