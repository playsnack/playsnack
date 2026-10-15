// One live room: who is here, shared tallies, and the synchronized game session
// (lobby → countdown 3·2·1 → play → result). Pure logic — clock, timers, random,
// content, persistence and transport are injected, so the same engine runs on the
// server today and in the host player's browser (host mode).
//
// Input: join / leave / action / react from peers. Output: `broadcast(t, d)` to
// everyone and `send(peerId, t, d)` to one peer, using the wire messages the
// player already speaks ("state", "setVar", "participants", "reaction", "actionAck")
// plus "countdown" {n, stepMs, endsIn}: "play starts in endsIn ms" — a client runs
// the 3·2·1 on its own clock from it (see countdown.js).

// Nicknames are capped at NICK_MAX graphemes (one Korean syllable or one emoji = one),
// the same cap as the player's input (snack-player/src/nick.ts) — the engine cannot
// import player code, so the rule lives here too. Code points when there is no Segmenter.
export const NICK_MAX = 10;
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;
export const capGraphemes = (s, n) => {
  if (n <= 0) return "";
  if (!segmenter) return Array.from(s).slice(0, n).join("");
  let out = "";
  let i = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (i++ >= n) break;
    out += segment;
  }
  return out;
};
export const cleanNick = (n) => capGraphemes(String(n ?? "").trim(), NICK_MAX).trimEnd();

// Fair judging (MP-08): devices measure their own reaction time / tap count; the host
// only checks plausibility.
export const TAP_RATE_MAX = 15; // taps per second a count may grow by (clamped beyond)
const TAP_BURST = 5; // slack for a first batch that lands before the clock has run
export const MIN_REACTION_MS = 80; // faster than this is a foul (anticipation)
const REACTION_TOLERANCE_MS = 50; // a claim slower than the host's own measurement is clamped to it
// A final count / reaction still lands this long after the window: two lost sends
// (resend every 700 ms) plus the broker's worst delay (300 ms) still make it.
const LATE_GRACE_MS = 2500;
const COUNTDOWN_STEP_MS = 1000;
export const LEFT_MARK = "(나감)"; // ranking mark for a player who left the room (MP-12)

// Quiz pack (나 맞히기 퀴즈): a player's own questions, sent from the lobby/result. Lengths
// are graphemes (one Korean syllable or one emoji = one), like nicknames.
export const QUIZ_MAX_QUESTIONS = 20;
const QUIZ_TITLE_MAX = 40;
const QUIZ_Q_MAX = 80;
const QUIZ_OPTION_MAX = 30;
const QUIZ_ANSWER_MS = [3000, 20000]; // answer window bounds (ms)
// A device starts its answer clock when the question reaches it — after the host's —
// so an honest claim never exceeds the window by much; beyond this it is not believed.
const ANSWER_GRACE_MS = 500;
// Early reveal: once every present answerer has answered, the round is revealed this long
// later instead of at the end of the window (a beat to see "모두 골랐어요" — not a dead wait; 600 felt slow, #116).
export const EARLY_REVEAL_MS = 300;
const RECAP_PLAYERS_MAX = 20; // answerers listed per round in quizRecap (snapshot size)
// The subject switching apps (e.g. to share the invite in KakaoTalk) drops out of the
// roster after ~3.5 s of silence; only this long away counts as "left" for the quiz rules.
export const SUBJECT_GRACE_MS = 30000;
// 방장 (#135): a friends room's host away this long (the same grace as a quiz subject's) hands
// the host role to the earliest-joined player still here. Back later, they do not take it back.
export const HOST_GRACE_MS = SUBJECT_GRACE_MS;
// 공개 방 자동 시작 (#136): the lobby counts down this long from the first person in, then the
// game starts by itself (the template's `room.autoStartMs` within AUTO_START_RANGE overrides it).
export const AUTO_START_MS = 10000;
export const AUTO_START_RANGE = [3000, 60000];
// …and after a game the result stays up this long, then the lobby (and its countdown) again.
export const RESULT_HOLD_MS = 8000;
const AUTO_OPTS_MAX = 1024; // bytes of a start payload kept for auto-start (JSON)
// Also at most 4 UTF-16 units per allowed grapheme: one "grapheme" can carry thousands of
// combining marks (a size bomb in every snapshot). Text with more than 2 marks per base
// character is dropped (an emoji's variation selector / keycap is 1–2).
const MARKS = /\p{M}/gu;
const capText = (s, n) => {
  let out = capGraphemes(s, n);
  if (out.length > 4 * n) {
    let cut = "";
    for (const g of segmenter ? Array.from(segmenter.segment(out), (x) => x.segment) : Array.from(out)) {
      if (cut.length + g.length > 4 * n) break;
      cut += g;
    }
    out = cut;
  }
  const marks = (out.match(MARKS) || []).length;
  return marks > 2 * Math.max(1, Array.from(out).length - marks) ? "" : out;
};
const clip = (s, n) => capText(String(s).trim(), n).trimEnd();
const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};
/** One question {q, options[2..4], answer} cleaned up, or null when it can't be played. */
export const cleanQuestion = (x) => {
  if (!x || typeof x !== "object" || !Array.isArray(x.options)) return null;
  const q = typeof x.q === "string" ? clip(x.q, QUIZ_Q_MAX) : "";
  const answer = Number(x.answer);
  if (!q || !Number.isInteger(answer) || answer < 0 || answer >= x.options.length) return null;
  const options = [];
  let a = -1;
  x.options.forEach((o, i) => {
    const t = typeof o === "string" || (typeof o === "number" && Number.isFinite(o)) ? clip(o, QUIZ_OPTION_MAX) : "";
    if (!t) return; // a blank choice is dropped (the answer index follows)
    if (i === answer) a = options.length;
    options.push(t);
  });
  return a >= 0 && options.length >= 2 && options.length <= 4 ? { q, options, answer: a } : null;
};
/** A `quizPack` payload cleaned up: {title, questions (1–20), settings}, or null (nothing playable). */
export const sanitizeQuizPack = (p) => {
  const questions = [];
  for (const x of Array.isArray(p?.questions) ? p.questions : []) {
    if (questions.length >= QUIZ_MAX_QUESTIONS) break;
    const q = cleanQuestion(x);
    if (q) questions.push(q);
  }
  if (!questions.length) return null;
  const s = p.settings && typeof p.settings === "object" ? p.settings : {};
  const settings = {};
  const rounds = s.rounds == null ? undefined : clampInt(s.rounds, 1, QUIZ_MAX_QUESTIONS);
  const answerMs = s.answerMs == null ? undefined : clampInt(s.answerMs, ...QUIZ_ANSWER_MS);
  if (rounds !== undefined) settings.rounds = rounds;
  if (answerMs !== undefined) settings.answerMs = answerMs;
  return { title: typeof p.title === "string" ? clip(p.title, QUIZ_TITLE_MAX) : "", questions, settings };
};

const roundNameFor = (n) => (n >= 16 ? "16강" : n >= 8 ? "8강" : n >= 4 ? "4강" : "결승");
const buildMatchups = (cands) => {
  const m = [];
  for (let i = 0; i + 1 < cands.length; i += 2) m.push([cands[i], cands[i + 1]]);
  return m;
};

/**
 * @param {object} o
 * @param {(t: string, d: object) => void} o.broadcast
 * @param {(peerId: string, t: string, d: object) => void} o.send
 * @param {object | (() => object)} [o.defaults]   votesByOption keys (e.g. {A:0,B:0})
 * @param {Map<string, string>} [o.voters]         persisted votes anonId → option
 * @param {() => void} [o.onVotersChanged]         persist hook (after a vote)
 * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack] round content
 * @param {(anonId: string) => string} [o.photoUrl]
 * @param {(anonId: string, nick: string, points: number) => void} [o.onPoints]
 * @param {(kind: string, label: string) => void} [o.onActivity]
 * @param {() => number} [o.now]
 * @param {() => number} [o.random]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {(handle: any) => void} [o.clearTimer]
 * @param {number} [o.claimWindowMs]  server-authoritative rooms (edge/room): the engine's clock IS the
 *   referee, so a device-measured time (answer / reaction ms) is believed only within
 *   [server-observed elapsed − claimWindowMs, server-observed elapsed]. Unset (a player hosts,
 *   whose own elapsed is no better than the device's) → only the upper bound applies.
 * Free-beta metrics hooks (docs/telemetry.md §9.5) — fired on the engine that runs the
 * room (the host), at most once per game / pack on that engine; ids come from the
 * triggering action's clientMsgId, so a host hand-over that replays it reports the same id.
 * @param {(e: {sid: string, players: number, again: boolean}) => void} [o.onSessionStart]
 *   content loaded, countdown about to start; players = on the roster now; again = a game in this room reached its result before
 * @param {(e: {sid: string, players: number, quiz: boolean, about?: boolean, answerers?: number}) => void} [o.onSessionEnd]
 *   first move into "result"; players = took part (S.acted, a quiz subject counts); quiz only: about, answerers (subject excluded)
 * @param {(e: {gid: string, source: "editor" | "remake"}) => void} [o.onGameCreated]
 *   a valid quiz pack was accepted; remake = sent after a finished game by someone who was not its subject
 * @param {(result: {v: 1, sid: string, endedAt: number, title?: string, about?: string, board: {pid: string, nick: string, score: number, left?: boolean}[], quizRecap?: object}) => void} [o.onResult]
 *   saved room results (docs/room-results.md): a scored game reached its result (board = raceBoard order,
 *   nick without the left mark); once per sid on this engine; the shell adds `app` and posts it
 * @param {"any" | "host" | "auto"} [o.startRule]  who starts a game (docs/bite-format.md §6.1 "방장 · 자동 시작"):
 *   "any" (default) anyone; "host" (friends room, #135) only the host (방장) — the first person in,
 *   handed on after HOST_GRACE_MS away; "auto" (public room, #136) nobody: once a client sent the app's
 *   start payload (`configureAuto`) the lobby counts down and starts by itself, and returns after the result.
 * @param {number} [o.autoStartMs]   "auto": default lobby countdown (AUTO_START_MS)
 * @param {number} [o.resultHoldMs]  "auto": how long the result stays before the lobby (RESULT_HOLD_MS)
 */
export function createRoom(o) {
  const {
    broadcast: broadcastOut,
    send: sendOut,
    defaults = {},
    voters = new Map(),
    onVotersChanged = () => {},
    getPack = async () => null,
    photoUrl = () => "",
    onPoints = () => {},
    onActivity = () => {},
    now = () => Date.now(),
    random = Math.random,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    onSessionStart = () => {},
    onSessionEnd = () => {},
    onGameCreated = () => {},
    onResult = () => {},
    claimWindowMs = null,
    startRule = "any",
    autoStartMs = AUTO_START_MS,
    resultHoldMs = RESULT_HOLD_MS,
  } = o;
  const rule = startRule === "host" || startRule === "auto" ? startRule : "any";
  // A claim never better than the referee's own elapsed time minus the window (network + render).
  const floorClaim = (ms, elapsed) => (claimWindowMs == null ? ms : Math.max(ms, Math.round(elapsed - claimWindowMs)));
  // A metrics hook must never break the room.
  const report = (hook, e) => {
    try {
      hook(e);
    } catch (err) {
      console.error("[snack-room] metrics hook failed", err);
    }
  };

  const r = {
    voters,
    peers: new Map(), // peerId → { anonId, nick }
    coop: 0,
    scores: new Map(), // anonId → score
    roster: new Map(), // anonId → nick (live participants, insertion order)
    nicks: new Map(), // anonId → nick (score owner names)
    pids: new Map(), // anonId → "p1", "p2"… (join order; a stable per-room key — two players may share a nick)
    session: { phase: "lobby", round: 0, num: 0, timers: [], rounds: [], bracket: null, gen: 0, quizPack: null, sid: "", done: 0, subject: "", answerers: undefined, acted: undefined, subjectAwayAt: null, packDone: -1, host: "", hostAwayAt: null, autoOpts: null, autoMs: 0 },
    destroyed: false,
    // Variable stores — what a (re)joining player needs to see the room as it is:
    vars: new Map(), // shared: id → latest broadcast value (round content too)
    mine: new Map(), // per player: anonId → Map(id → value) sent only to them (e.g. iAmOut)
  };
  const S = r.session;
  // Every outgoing setVar also lands in a store, so join/resync can resend it.
  const broadcast = (t, d) => {
    if (t === "setVar") {
      r.vars.set(d.id, d.value);
      for (const own of r.mine.values()) own.delete(d.id); // a broadcast overrides per-player values
    }
    broadcastOut(t, d);
  };
  const send = (peerId, t, d) => {
    const peer = r.peers.get(peerId);
    if (t === "setVar" && peer) {
      let own = r.mine.get(peer.anonId);
      if (!own) r.mine.set(peer.anonId, (own = new Map()));
      own.set(d.id, d.value);
    }
    sendOut(peerId, t, d);
  };
  const setVar = (id, value) => broadcast("setVar", { id, value });
  const shuffled = (a) => {
    const x = [...a];
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  };

  // ── shared state views ──
  const tally = () => {
    const out = { ...(typeof defaults === "function" ? defaults() : defaults) };
    for (const opt of r.voters.values()) out[opt] = (out[opt] ?? 0) + 1;
    return out;
  };
  // Live leaderboard: top-10 per-player scores, sorted desc (numbers only).
  const board = () => [...r.scores.values()].sort((a, b) => b - a).slice(0, 10);
  // Named race board: top-8 {nick, score} — lets results say WHO won.
  // A player who left stays ranked, marked (MP-12) — the same on every screen.
  const pidOf = (anonId) => {
    if (!r.pids.has(anonId)) r.pids.set(anonId, `p${r.pids.size + 1}`);
    return r.pids.get(anonId);
  };
  // While a quiz round is open, a join/leave must not publish this round's points early.
  const shownScores = () => (S.quiz && S.accepting && S.revealed ? S.revealed : [...r.scores.entries()]);
  const raceBoard = () =>
    shownScores()
      .map(([id, score]) => {
        const nick = r.nicks.get(id) || r.roster.get(id) || "게스트";
        const pid = pidOf(id);
        return r.roster.has(id) ? { nick, score, pid } : { nick: `${nick} ${LEFT_MARK}`, score, pid, left: true };
      })
      // MP-11: a tie stays a tie — listed by nickname, then join order, the same on every host
      .sort((a, b) => b.score - a.score || (a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0) || Number(a.pid.slice(1)) - Number(b.pid.slice(1)))
      .slice(0, 8);
  const rosterArr = () => [...r.roster.values()].slice(0, 8);
  const rosterPhotosArr = () => [...r.roster.keys()].slice(0, 8).map((id) => photoUrl(id) || "");
  // Photos go out only once there is one (most hosts have none — MP-13).
  const setPhotos = () => {
    const photos = rosterPhotosArr();
    if (photos.some(Boolean) || r.vars.has("rosterPhotos")) setVar("rosterPhotos", photos);
  };

  // ── session ──
  // Timers are DATA ({step, arg, at}) rather than closures, so the whole session
  // can be snapshotted on one device and resumed on another (host hand-over).
  const later = (step, arg, ms) => {
    const t = { step, arg, at: now() + ms };
    t.handle = setTimer(() => {
      S.timers = S.timers.filter((x) => x !== t);
      STEPS[step](arg);
    }, ms);
    S.timers.push(t);
  };
  const clearSessionTimers = () => {
    for (const t of S.timers) clearTimer(t.handle);
    S.timers = [];
  };
  const cancel = (step) => {
    for (const t of S.timers) if (t.step === step) clearTimer(t.handle);
    S.timers = S.timers.filter((t) => t.step !== step);
  };
  // Only re-broadcast a generic variable this room has already shown (MP-13: a template
  // that never declared it would get "host set undeclared variable" on every reset).
  const setKnown = (id, value) => {
    if (r.vars.has(id)) setVar(id, value);
  };
  const setPhase = (phase, extra = {}) => {
    const ended = phase === "result" && S.phase !== "result";
    if (ended) S.done += 1; // sessions finished in this room (telemetry §9.3)
    S.phase = phase;
    if (ended && S.sid) report(onSessionEnd, sessionEnded());
    if (ended && autoOn()) later("autoLobby", null, resultHoldMs); // a public room goes on by itself
    setVar("sessionPhase", phase);
    for (const [k, v] of Object.entries(extra)) {
      if (k === "sessionCountdown") S.num = v;
      setVar(k, v);
    }
  };
  const toResult = () => {
    const first = S.phase !== "result" && S.sid; // a hand-over restored in the result never reports again
    S.lateUntil = now() + LATE_GRACE_MS; // a last tap batch / reaction may still be in flight
    if (S.quiz) setVar("quizRecap", quizRecap());
    setPhase("result");
    setKnown("raceBoard", raceBoard()); // a vote / co-op session has no board to show
    setKnown("leaderboard", board());
    if (first && r.vars.has("raceBoard")) report(onResult, savedResult());
  };
  // The finished game for the room link's result page (docs/room-results.md).
  const savedResult = () => {
    const m = S.quizMeta ?? {};
    const res = { v: 1, sid: S.sid, endedAt: now(), board: raceBoard().map(({ nick, score, pid, left }) => (left ? { pid, nick: nick.slice(0, -LEFT_MARK.length - 1), score, left } : { pid, nick, score })) };
    if (S.quiz) Object.assign(res, { quizRecap: r.vars.get("quizRecap") }, m.title ? { title: m.title } : {}, m.about ? { about: m.about } : {});
    return res;
  };
  // session_done (telemetry §9.1): who took part, and for a quiz whether it was about someone + who answered.
  const sessionEnded = () => {
    const e = { sid: S.sid, players: S.acted ? S.acted.size : 0, quiz: Boolean(S.quiz) };
    if (S.quiz) Object.assign(e, { about: Boolean(S.quizSubject), answerers: S.answerers ? S.answerers.size : 0 });
    return e;
  };
  const inWindow = () => S.phase === "play" || (S.phase === "result" && now() <= (S.lateUntil ?? 0));

  // Spectators: someone whose first join in this session comes during its countdown / play
  // watches it — no answers, taps, votes or scores, not counted for early reveal / progress /
  // "everyone voted" — and plays from the next start. S.members = who was on the roster when
  // the countdown began (plus a quiz's subject), so a member's reload or return is never a
  // spectator. Both are data (arrays in the snapshot): a hand-over keeps them.
  const isMember = (anonId) => !S.members || S.members.has(anonId) || isSubject(anonId);
  const isSpectator = (anonId) => Boolean(S.spectators?.has(anonId)) && S.phase !== "lobby";
  const spectatorsHere = () => [...r.roster.keys()].filter((id) => S.spectators?.has(id)).length;
  const publishSpectators = () => {
    const n = spectatorsHere();
    if (n > 0 || r.vars.has("spectators")) setVar("spectators", n); // MP-13: only once a room has had one
  };
  // The per-player flag goes out only to spectators (true) and back to them (false) at the next start.
  const setSpectatorFlag = (anonId, value, notify = true) => {
    let own = r.mine.get(anonId);
    if (!own) r.mine.set(anonId, (own = new Map()));
    own.set("iAmSpectator", value);
    if (notify) for (const [id, p] of r.peers) if (p.anonId === anonId) sendOut(id, "setVar", { id: "iAmSpectator", value });
  };
  // Players of this session who are here (spectators excluded).
  const playersHere = () => [...r.roster.keys()].filter((id) => !S.spectators?.has(id));

  // ── 방장 (host, #135) ──
  // A "host" room (friends room): the first person in hosts — on the edge that is the room's
  // organizer, who created it. Only the host starts a game / goes back to the lobby (a stored
  // 나 맞히기 quiz keeps its own rule: its subject starts it). Away past HOST_GRACE_MS, the role
  // goes to the earliest-joined player still here (join order = pid); coming back later does not
  // take it back. Vars: hostNick (shared), iAmHost (per player), roomMode "host" | "auto".
  const setMine = (anonId, id, value) => {
    let own = r.mine.get(anonId);
    if (!own) r.mine.set(anonId, (own = new Map()));
    own.set(id, value);
  };
  const hostHere = () => !S.host || r.roster.has(S.host) || (S.hostAwayAt != null && now() - S.hostAwayAt < HOST_GRACE_MS);
  const nickOfId = (anonId) => r.roster.get(anonId) || r.nicks.get(anonId) || "게스트";
  let hostTimer = null;
  const setHost = (anonId) => {
    S.host = anonId;
    S.hostAwayAt = null;
    watchHostAway();
    // whoever is not here gets the new value when they come back (join sends theirs)
    for (const [id, own] of r.mine) if (id !== anonId && own.get("iAmHost")) own.set("iAmHost", false);
    setVar("hostNick", nickOfId(anonId));
    for (const [id, p] of r.peers) send(id, "setVar", { id: "iAmHost", value: p.anonId === anonId });
  };
  // The host is gone (past the grace): the earliest-joined player here takes over.
  const handOver = () => {
    if (rule !== "host" || hostHere()) return false;
    const next = [...r.roster.keys()].sort((a, b) => Number(pidOf(a).slice(1)) - Number(pidOf(b).slice(1)))[0];
    if (!next) return false;
    setHost(next);
    return true;
  };
  const watchHostAway = () => {
    if (hostTimer != null) clearTimer(hostTimer);
    hostTimer = null;
    if (S.hostAwayAt == null) return;
    hostTimer = setTimer(() => {
      hostTimer = null;
      if (!r.destroyed) handOver();
    }, Math.max(0, HOST_GRACE_MS - (now() - S.hostAwayAt)));
  };
  // May this player NOT start / end a game here? (a stored quiz keeps its subject rule — checked by the caller)
  const notHost = (anonId) => {
    if (rule !== "host" || S.quizPack) return false;
    handOver();
    if (!S.host && r.roster.has(anonId)) setHost(anonId); // a room restored without one
    return S.host !== anonId;
  };

  // ── 자동 시작 (auto-start, #136) ──
  // An "auto" room (public room) starts by itself once a client told it the app's start payload
  // (configureAuto — the template's `room.start`): the lobby counts down S.autoMs from the first
  // person in (one timer — everyone who joins meanwhile plays), and after a game the result holds
  // resultHoldMs, then the lobby again — counting down only if someone played (a phone left open
  // alone does not loop games), else idle until someone joins or taps start. The countdown goes out
  // as {t: "autoStart", d: {endsIn, ms}} (endsIn −1 = none): a client runs it on its own clock.
  // The timer is session data (S.timers), so a snapshot / hand-over / hibernation keeps it.
  const autoOn = () => rule === "auto" && S.autoOpts != null;
  const autoTimer = () => S.timers.find((x) => x.step === "autoStart");
  const autoMsg = () => {
    const t = autoTimer();
    return { endsIn: t ? Math.max(0, t.at - now()) : -1, ms: S.autoMs };
  };
  const armAuto = () => {
    if (!autoOn() || S.phase !== "lobby" || !r.roster.size || autoTimer()) return false;
    later("autoStart", null, S.autoMs);
    broadcastOut("autoStart", autoMsg());
    return true;
  };

  // Round-based (vote / content) — each round is a fresh vote.
  const startRound = (i) => {
    if (i >= S.rounds.length) return toResult();
    r.voters.clear();
    S.roundIdx = i;
    if (S.hidden) return startHiddenRound(i);
    setPhase("play", { roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: S.rounds[i], votesByOption: tally() });
    later("startRound", i + 1, S.roundMs);
  };

  // Hidden picks (start {hidden: true} — 밸런스게임, #126): nobody sees anyone else's pick
  // or a running tally until the round is revealed. Before the reveal only the count goes
  // out (voteProgress) and each player gets their own pick back (myPick {sessionNo, round,
  // option}, per player — the quiz's shape); at the reveal the split (votesByOption) and who
  // picked what (roundPicks) go out at once.
  // Revealed at the end of roundMs, or EARLY_REVEAL_MS after everyone present picked (the
  // quiz's rule: spectators and leavers don't count; only a pick or a leave completes a round).
  const ROUND_PICKS_MAX = 8; // names listed per option at the reveal
  const voteProgress = () => {
    const here = playersHere();
    return { voted: here.filter((id) => r.voters.has(id)).length, of: here.length, round: S.roundIdx, sessionNo: S.round };
  };
  const roundPicks = () => {
    const out = {};
    for (const k of Object.keys(tally())) out[k] = [];
    for (const [anonId, opt] of r.voters) {
      const list = (out[opt] ??= []);
      if (list.length < ROUND_PICKS_MAX) list.push(r.nicks.get(anonId) || r.roster.get(anonId) || "게스트");
    }
    return out;
  };
  const startHiddenRound = (i) => {
    S.accepting = true;
    S.early = false;
    S.roundStart = now();
    // voteProgress first: a device that has the new roundIdx already has this round's count
    // and sessionNo (a last game's myPick for the same round index is not mine any more).
    setPhase("play", { voteProgress: voteProgress(), roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: S.rounds[i], revealRound: -1, votesByOption: tally(), roundPicks: {} });
    later("revealVoteRound", i, S.roundMs);
  };
  const revealVoteRound = (i) => {
    if (!S.hidden || S.roundIdx !== i) return; // stale timer
    S.accepting = false;
    S.early = false;
    // The split and the names land before revealRound, so a device that sees revealRound === roundIdx has both.
    setVar("votesByOption", tally());
    setVar("roundPicks", roundPicks());
    setVar("revealRound", i);
    later("startRound", i + 1, S.revealMs);
  };
  const syncVoteReveal = ({ mayPull = true } = {}) => {
    if (!S.hidden || S.phase !== "play" || !S.accepting) return;
    if (!S.timers.some((x) => x.step === "revealVoteRound")) return;
    const p = voteProgress();
    const allIn = p.of > 0 && p.voted >= p.of;
    const fullIn = S.roundStart + S.roundMs - now();
    if (allIn && !S.early && mayPull && fullIn > EARLY_REVEAL_MS) {
      S.early = true;
      cancel("revealVoteRound");
      later("revealVoteRound", S.roundIdx, EARLY_REVEAL_MS);
    } else if (!allIn && S.early) {
      S.early = false;
      cancel("revealVoteRound");
      later("revealVoteRound", S.roundIdx, Math.max(0, fullIn));
    }
  };
  const hiddenOpen = () => Boolean(S.hidden) && S.phase === "play" && Boolean(S.accepting);

  // Quiz: answer window (answer hidden) → reveal (answer + scores).
  // 나 맞히기: the player whose pack is playing (the subject) watches; everyone else answers.
  const isSubject = (anonId) => Boolean(S.quizSubject) && S.quizSubject.anonId === anonId;
  const answerersHere = () => [...r.roster.keys()].filter((id) => !(S.quizPack && S.quizPack.subject.anonId === id));
  // Is the stored pack's subject (still) here? Away less than SUBJECT_GRACE_MS still counts.
  const subjectHere = () =>
    !S.quizPack || r.roster.has(S.quizPack.subject.anonId) || (S.subjectAwayAt != null && now() - S.subjectAwayAt < SUBJECT_GRACE_MS);
  let awayTimer = null;
  const publishSubjectHere = () => {
    const cur = r.vars.get("quizInfo");
    if (S.quizPack && cur && cur.subjectHere !== subjectHere()) setVar("quizInfo", { ...cur, subjectHere: subjectHere() });
  };
  const watchSubjectAway = () => {
    if (awayTimer != null) clearTimer(awayTimer);
    awayTimer = null;
    if (S.subjectAwayAt == null) return;
    awayTimer = setTimer(() => {
      awayTimer = null;
      if (!r.destroyed) publishSubjectHere();
    }, Math.max(0, SUBJECT_GRACE_MS - (now() - S.subjectAwayAt)));
  };
  // Who else may act for the quiz: only the subject, unless they are gone (past the grace).
  const notSubject = (anonId) => Boolean(S.quizPack) && S.quizPack.subject.anonId !== anonId && subjectHere();
  // An answerer of this session: listed in the recap and on the board (0 until they score).
  const addQuizPlayer = (anonId, nick) => {
    if (isSubject(anonId) || S.players.some((x) => x.anonId === anonId)) return;
    S.players.push({ anonId, nick });
    if (!r.scores.has(anonId)) r.scores.set(anonId, 0);
    if (S.revealed && !S.revealed.some(([id]) => id === anonId)) S.revealed.push([anonId, r.scores.get(anonId)]);
    r.nicks.set(anonId, nick);
  };
  const quizProgress = () => {
    const here = playersHere().filter((id) => !isSubject(id));
    const picks = S.picks?.[S.roundIdx] ?? {};
    // round / sessionNo: which round this count is for — a device that has the new round's
    // values but not yet its fresh count must not read the last round's "everyone answered".
    return { answered: here.filter((id) => picks[id]).length, of: here.length, round: S.roundIdx, sessionNo: S.round };
  };
  // Early reveal: everyone present (quizProgress — the subject and leavers excluded) has
  // answered → reveal in EARLY_REVEAL_MS. Only an answer or a leave can complete a round;
  // a join (someone new, or back without an answer) can only reopen it, back to the
  // window's own end. The reveal timer is data, so the beat survives a hand-over
  // (timers[].remaining); S.early says it was pulled in.
  const syncReveal = ({ mayPull = true } = {}) => {
    if (!S.quiz || S.phase !== "play" || !S.accepting) return;
    const t = S.timers.find((x) => x.step === "revealQuizRound");
    if (!t) return;
    const p = quizProgress();
    const allIn = p.of > 0 && p.answered >= p.of;
    const fullIn = S.roundStart + S.answerMs - now();
    if (allIn && !S.early && mayPull && fullIn > EARLY_REVEAL_MS) {
      S.early = true;
      cancel("revealQuizRound");
      later("revealQuizRound", S.roundIdx, EARLY_REVEAL_MS);
    } else if (!allIn && S.early) {
      S.early = false;
      cancel("revealQuizRound");
      later("revealQuizRound", S.roundIdx, Math.max(0, fullIn));
    }
  };
  const quizInfo = (count, answerMs) => {
    const p = S.quizPack;
    const n = count ?? Math.min(p.questions.length, p.settings.rounds ?? p.questions.length);
    return { title: p.title || `${p.subject.nick} 퀴즈`, count: n, custom: true, about: p.subject.nick, answerMs: answerMs ?? p.settings.answerMs ?? null, packId: p.id, subjectHere: subjectHere() };
  };
  // Each player's own "am I the subject?" — per player (keyed by anonId, survives a reload).
  const sendSubjectFlag = (peerId, anonId) => send(peerId, "setVar", { id: "iAmSubject", value: Boolean(S.quizPack) && S.quizPack.subject.anonId === anonId });
  // Options are shuffled every round (a creator tends to put the answer first).
  const shuffleOptions = ({ q, options, answer }) => {
    const order = shuffled(options.map((_, i) => i));
    return { q, options: order.map((k) => options[k]), answer: order.indexOf(answer) };
  };
  // The time an answer took, as the DEVICE measured it ("question shown → tap"). A missing
  // or implausible claim (not a number, negative, past the window) gets the host's own
  // measurement — never better; a claim slower than the host itself saw is clamped to it.
  const answerTime = (claim) => {
    const host = Math.max(0, now() - S.roundStart);
    const m = claim === null || claim === undefined || claim === "" ? NaN : Number(claim);
    const ok = Number.isFinite(m) && m >= 0 && m <= S.answerMs + ANSWER_GRACE_MS;
    return Math.min(ok ? floorClaim(Math.min(Math.round(m), host + REACTION_TOLERANCE_MS), host) : host, S.answerMs);
  };
  const quizRecap = () => {
    const players = S.players.slice(0, RECAP_PLAYERS_MAX);
    const m = S.quizMeta ?? {};
    return {
      subject: S.quizSubject ? S.quizSubject.nick : null,
      about: m.about ?? null,
      title: m.title ?? "",
      packId: m.packId ?? null,
      rounds: S.rounds.map((rd, i) => ({
        q: rd.q,
        options: rd.options,
        answer: rd.answer,
        picks: players.map(({ anonId, nick }) => {
          const p = S.picks[i]?.[anonId];
          const pid = pidOf(anonId);
          return p ? { nick, pid, ...p } : { nick, pid, option: -1, ms: -1, correct: false, points: 0 };
        }),
      })),
    };
  };
  const startQuizRound = (i) => {
    if (i >= S.rounds.length) return toResult();
    S.roundIdx = i;
    S.answered = new Set();
    S.accepting = true;
    S.early = false;
    S.roundStart = now();
    const { answer, ...pub } = S.rounds[i]; // clients must not see the answer
    void answer;
    setPhase("play", { roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: pub, roundAnswer: -1, quizProgress: quizProgress() });
    later("revealQuizRound", i, S.answerMs);
  };
  const revealQuizRound = (i) => {
    S.accepting = false;
    S.revealed = [...r.scores.entries()];
    setVar("roundAnswer", S.rounds[i].answer);
    setVar("raceBoard", raceBoard());
    later("startQuizRound", i + 1, S.revealMs);
  };

  // Nunchi: claim the next number; near-simultaneous taps collide → all out.
  const resolveNunchi = () => {
    const p = S.pending || [];
    S.pending = [];
    if (p.length === 0) return;
    if (p.length === 1) {
      const claimed = S.nunchiNum;
      S.nunchiNum += 1;
      setVar("nunchiNum", S.nunchiNum);
      setVar("lastEvent", `${p[0].nick} 님이 ${claimed} 선점 ✋`);
    } else {
      for (const x of p) {
        S.eliminated.add(x.anonId);
        send(x.peerId, "setVar", { id: "iAmOut", value: true });
      }
      setVar("eliminatedCount", S.eliminated.size);
      setVar("lastEvent", `💥 충돌! ${p.map((x) => x.nick).join(" · ")} 탈락`);
    }
    if (nunchiAlive().length <= 1 || S.nunchiNum > 20) endNunchi();
  };
  // Still in the game: here AND not knocked out (an eliminated player who left is neither).
  const nunchiAlive = () => [...r.roster.entries()].filter(([id]) => !S.eliminated.has(id) && !S.spectators?.has(id)).map(([, n]) => n);
  const endNunchi = () => {
    if (S.phase === "result") return;
    clearSessionTimers();
    const alive = nunchiAlive();
    const winner =
      alive.length === 0 ? "전멸 😂 아무도 못 살아남았어요" : alive.length === 1 ? `${alive[0]} 최후의 1인! 🏆` : `${alive.join(" · ")} 공동 생존 🎉`;
    setPhase("result", { nunchiWinner: winner });
  };

  // Worldcup bracket: each matchup the room votes A/B; more votes advance.
  const startMatchup = (i) => {
    const bk = S.bracket;
    if (!bk) return; // stale timer after teardown
    if (i >= bk.matchups.length) return finishBracketRound();
    bk.matchupIdx = i;
    bk.early = -1;
    r.voters.clear();
    const [a, b] = bk.matchups[i];
    bk.label = `${roundNameFor(bk.roundCands.length)} · ${i + 1}/${bk.matchups.length}`;
    setPhase("play", { roundContent: { a, b }, votesByOption: tally(), matchWinner: -1, bracketLabel: bk.label });
    later("resolveMatchup", i, S.matchupMs); // per-matchup timer
  };
  // T-21: everyone here has voted → don't sit out the rest of the matchup timer.
  // "Everyone here": players on the roster; a vote from someone who left still counts
  // in the tally but is not a present voter (so a leaver can't trigger the advance).
  const maybeAdvanceMatchup = () => {
    const bk = S.bracket;
    if (!bk || S.mode !== "bracket" || S.phase !== "play" || bk.early === bk.matchupIdx) return;
    const here = playersHere();
    const present = here.filter((id) => r.voters.has(id)).length;
    if (here.length === 0 || present < here.length) return;
    bk.early = bk.matchupIdx;
    cancel("resolveMatchup");
    later("resolveMatchup", bk.matchupIdx, 600); // the last vote's percentage is seen first
  };
  const resolveMatchup = (i) => {
    const bk = S.bracket;
    if (!bk) return;
    const t = tally();
    const a = t.o0 || 0;
    const b = t.o1 || 0;
    // MP-11: a tie is called a tie and settled by a coin toss — never "the left one wins".
    const tie = a === b;
    const winIdx = tie ? (random() < 0.5 ? 0 : 1) : a > b ? 0 : 1;
    bk.winners.push(bk.matchups[i][winIdx]);
    if (tie) setVar("bracketLabel", `${bk.label} · 동점 🎲`);
    setVar("matchWinner", winIdx); // brief reveal of who advances
    later("startMatchup", i + 1, 2200);
  };
  const finishBracketRound = () => {
    const bk = S.bracket;
    if (!bk) return;
    if (bk.winners.length <= 1) return setPhase("result", { champion: bk.winners[0] || null });
    bk.roundCands = bk.winners;
    bk.matchups = buildMatchups(bk.winners);
    bk.winners = [];
    startMatchup(0);
  };

  // Majority guess (눈치 배틀): blind-predict the room's majority; hits score +100.
  const startGuessRound = (i) => {
    if (i >= S.rounds.length) return toResult();
    r.voters.clear();
    S.roundIdx = i;
    setPhase("play", { roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: S.rounds[i], roundAnswer: -1, votesByOption: tally() });
    later("revealGuessRound", i, S.roundMs);
  };
  const revealGuessRound = (i) => {
    const t = tally();
    // MP-11: a tie has no majority (roundAnswer 2 = "동점") and nobody scores.
    const majority = (t.o0 || 0) === (t.o1 || 0) ? 2 : (t.o0 || 0) > (t.o1 || 0) ? 0 : 1;
    for (const [anonId, opt] of r.voters) {
      if (opt === `o${majority}`) {
        r.scores.set(anonId, (r.scores.get(anonId) ?? 0) + 100);
        r.nicks.set(anonId, r.roster.get(anonId) || r.nicks.get(anonId) || "게스트");
      }
    }
    setVar("votesByOption", t);
    setVar("roundAnswer", majority);
    setVar("raceBoard", raceBoard());
    later("startGuessRound", i + 1, S.revealMs);
  };

  const STEPS = {
    countdown: (n) => setPhase("countdown", { sessionCountdown: n }),
    play: (extra) => {
      S.playAt = now();
      setPhase("play", extra);
    },
    green: () => {
      if (S.phase !== "play") return;
      S.goAt = now();
      setVar("reactionGo", true);
    },
    result: () => toResult(),
    startRound,
    revealVoteRound,
    startQuizRound,
    revealQuizRound,
    resolveNunchi: () => resolveNunchi(),
    endNunchi: () => endNunchi(),
    startMatchup,
    resolveMatchup,
    startGuessRound,
    revealGuessRound,
    autoStart: () => {
      if (!autoOn() || S.phase !== "lobby" || !r.roster.size) return;
      startSession(S.autoOpts, null).catch((e) => console.error("[snack-room] auto start failed", e));
    },
    autoLobby: () => {
      if (S.phase !== "result") return;
      S.accepting = false;
      S.playAt = 0;
      S.lateUntil = 0;
      setPhase("lobby", { sessionCountdown: 0 });
      if (S.acted?.size) armAuto();
    },
  };

  // A session / pack id that is the same whichever host applies the action (telemetry §9.3).
  let idSeq = 0;
  const idOf = (mid) => {
    const x = String(mid ?? "").replace(/-/g, "");
    if (/^[A-Za-z0-9_]{16,32}$/.test(x)) return x;
    const tail = (++idSeq).toString(36); // distinct even if `random` repeats
    return Array.from({ length: 32 - tail.length }, () => Math.floor(random() * 36).toString(36)).join("") + tail;
  };
  const startSession = async (opts, clientMsgId) => {
    if (S.phase === "countdown" || S.phase === "play") return; // already running
    if (typeof opts === "number") opts = { duration: opts };
    opts = opts || {};
    S.sid = idOf(clientMsgId);
    S.hidden = false;
    S.accepting = false; // no answer counts until a round opens (a lobby/countdown answer never scores)
    S.revealed = null;
    S.answerers = new Set(); // quiz: who answered at least once (the subject never does)
    S.acted = new Set(); // who took part in this session (telemetry: "판을 끝낸 인원")
    // Last game's spectators play this one (their flag goes back to false).
    for (const id of S.spectators ?? []) setSpectatorFlag(id, false);
    S.spectators = new Set();
    S.members = null; // set when the countdown starts (a join during the content fetch is a player)
    clearSessionTimers();
    S.round += 1;
    S.mode = "";
    S.rounds = []; // a stale timer from a torn-down session sees [] → result
    S.bracket = null;
    const myGen = ++S.gen; // older sessions' timers/awaits become no-ops
    S.quiz = false;
    S.quizSubject = null;
    S.players = [];
    S.picks = [];
    S.playAt = 0;
    S.playMs = 0;
    S.lateUntil = 0;
    S.goal = 0;
    r.scores.clear();
    r.coop = 0;
    r.voters.clear();
    setKnown("raceBoard", []);
    setKnown("leaderboard", []);
    setKnown("coopTotal", 0);
    setKnown("votesByOption", tally());
    setKnown("revealRound", -1);
    onActivity("start", "게임 시작");
    // Fetch content first — the lobby stays up meanwhile, so every timer below is
    // scheduled from one sync point and clients stay in step.
    const custom = opts.quiz ? S.quizPack : null; // a player's own quiz: nothing to fetch
    let pack = custom ? null : await getPack(opts.game, opts);
    if (r.destroyed || S.gen !== myGen) return; // room gone or superseded during the fetch
    report(onSessionStart, { sid: S.sid, players: r.roster.size, again: S.done > 0 });
    // A themed pack may come as {title, questions}.
    const packTitle = pack && !Array.isArray(pack) && typeof pack.title === "string" ? pack.title : "";
    if (pack && !Array.isArray(pack)) pack = Array.isArray(pack.questions) ? pack.questions : null;
    S.members = new Set(r.roster.keys()); // this session's players: everyone here now
    setKnown("spectators", 0);
    // "Play starts in N ms": a client runs 3·2·1 on its own clock from this (the
    // numbers below still go out — for clients that don't, and to refine the estimate).
    broadcast("countdown", { n: 3, stepMs: COUNTDOWN_STEP_MS, endsIn: 3 * COUNTDOWN_STEP_MS });
    setPhase("countdown", { sessionCountdown: 3 });
    later("countdown", 2, COUNTDOWN_STEP_MS);
    later("countdown", 1, 2 * COUNTDOWN_STEP_MS);
    if (opts.mode === "reaction") {
      // Red WAIT → green at a synced random moment; fastest tap after green wins.
      S.mode = "reaction";
      S.reacted = new Set();
      S.goAt = 0;
      setVar("reactionGo", false);
      const delay = 1500 + Math.floor(random() * 3000);
      const playWindow = 4000;
      S.playWindow = playWindow;
      later("play", { sessionCountdown: 0, reactionGo: false }, 3000);
      later("green", null, 3000 + delay);
      later("result", null, 3000 + delay + playWindow);
    } else if (opts.mode === "nunchi") {
      S.mode = "nunchi";
      S.nunchiNum = 1;
      S.eliminated = new Set();
      S.pending = [];
      setVar("nunchiNum", 1);
      setVar("eliminatedCount", 0);
      setVar("lastEvent", "1번부터! 겹치면 다 같이 탈락 😬");
      setVar("iAmOut", false);
      setVar("nunchiWinner", "");
      later("play", { sessionCountdown: 0 }, 3000);
      later("endNunchi", null, 3000 + 25000); // overall cap
    } else if (opts.bracket && pack && pack.length >= 2) {
      const size = [16, 8, 4, 2].find((s) => s <= pack.length) || 2;
      const cands = shuffled(pack).slice(0, size);
      S.mode = "bracket";
      S.matchupMs = Math.min(15000, Math.max(4000, Number(opts.matchupMs) || 8000));
      S.bracket = { roundCands: cands, matchups: buildMatchups(cands), matchupIdx: 0, winners: [] };
      later("startMatchup", 0, 3000);
    } else if (opts.mode === "guess" && pack && pack.length) {
      S.rounds = shuffled(pack).slice(0, Math.min(pack.length, Math.max(1, Number(opts.rounds) || 6)));
      S.roundMs = Math.min(20000, Math.max(3000, Number(opts.roundMs) || 7000));
      S.revealMs = Math.min(8000, Math.max(1500, Number(opts.revealMs) || 3500));
      S.mode = "guess";
      later("startGuessRound", 0, 3000);
    } else if (opts.quiz && (custom || (pack && pack.length))) {
      // A stored pack plays in its creator's order (its settings win over start's);
      // otherwise the default pack, shuffled. Options are shuffled every round either way.
      const set = custom ? custom.settings : {};
      const src = custom ? custom.questions : shuffled(pack.map(cleanQuestion).filter(Boolean));
      const want = custom ? (set.rounds ?? src.length) : Math.max(1, Number(opts.rounds) || 6);
      S.rounds = src.slice(0, Math.min(src.length, want)).map(shuffleOptions);
      S.answerMs = Math.min(20000, Math.max(3000, set.answerMs ?? (Number(opts.answerMs) || 8000)));
      S.revealMs = Math.min(8000, Math.max(1500, Number(opts.revealMs) || 3000));
      S.quiz = true;
      S.quizSubject = custom ? { ...custom.subject } : null;
      if (S.quizSubject) S.acted.add(S.quizSubject.anonId); // the subject takes part by being guessed
      for (const [id, n] of r.roster) addQuizPlayer(id, n);
      S.picks = S.rounds.map(() => ({}));
      S.revealed = [...r.scores.entries()]; // everyone at 0 until the first reveal
      const info = custom ? quizInfo(S.rounds.length, S.answerMs) : { title: packTitle || "상식", count: S.rounds.length, custom: false, about: null, answerMs: S.answerMs, packId: null, subjectHere: true };
      S.quizMeta = { title: info.title, about: info.about, packId: info.packId };
      setVar("quizInfo", info);
      setVar("sessionNo", S.round); // one number per game (start), for per-game UI
      for (const [id, peer] of r.peers) send(id, "setVar", { id: "myPid", value: pidOf(peer.anonId) });
      setKnown("quizRecap", { subject: null, about: null, title: "", packId: null, rounds: [] });
      setKnown("raceBoard", raceBoard());
      later("startQuizRound", 0, 3000);
    } else if (pack && pack.length) {
      S.rounds = shuffled(pack).slice(0, Math.min(pack.length, Math.max(1, Number(opts.rounds) || 5)));
      S.roundMs = Math.min(20000, Math.max(3000, Number(opts.roundMs) || 8000));
      S.quiz = false;
      if (opts.hidden === true) {
        S.hidden = true;
        S.revealMs = Math.min(8000, Math.max(1500, Number(opts.revealMs) || 3000));
      }
      later("startRound", 0, 3000);
    } else {
      // Single play window (tap race / co-op).
      const dur = Math.min(60000, Math.max(3000, Number(opts.duration) || 12000));
      S.rounds = [];
      S.playMs = dur;
      // Co-op goal (다같이 300번 클릭, opts.goal): everyone's device-counted taps add up to
      // one total; reaching the goal ends the play early and records how long it took.
      const goal = Math.floor(Number(opts.goal));
      if (goal > 0) {
        S.goal = Math.min(100000, goal);
        setVar("coopTotal", 0);
        setVar("coopTimeMs", 0);
      }
      later("play", { sessionCountdown: 0 }, 3000);
      later("result", null, 3000 + dur);
    }
  };

  // ── peers ──
  const ack = (peerId, clientMsgId, extra = { accepted: true }) => send(peerId, "actionAck", { clientMsgId, ...extra });
  const peerNick = (peer) => cleanNick(peer.nick);
  // Tap race: adopt a count, never above TAP_RATE_MAX per second of play so far.
  const tapCount = (peer, n) => {
    const elapsed = Math.min(now() - S.playAt, S.playMs || Infinity);
    const v = Math.min(n, Math.floor((TAP_RATE_MAX * elapsed) / 1000) + TAP_BURST);
    if (v <= (r.scores.get(peer.anonId) ?? 0)) return;
    r.scores.set(peer.anonId, v);
    r.nicks.set(peer.anonId, peerNick(peer) || r.nicks.get(peer.anonId) || "게스트");
    setVar("raceBoard", raceBoard());
    if (S.goal) coopGoal();
  };
  // Co-op goal: the shared total is the sum of every player's count (so it is as
  // loss-proof and rate-capped as the counts); the first count that reaches the goal
  // in play ends the game with the time it took.
  const coopGoal = () => {
    r.coop = [...r.scores.values()].reduce((a, b) => a + b, 0);
    setVar("coopTotal", r.coop);
    if (S.phase !== "play" || r.coop < S.goal) return;
    setVar("coopTimeMs", Math.max(0, now() - S.playAt));
    cancel("result");
    toResult();
  };
  // Reaction: 0 = 부정출발 (before green, or faster than a human can), null = after the
  // window (not ranked); otherwise 2000 − ms, clamped to what the host itself measured.
  const reactionScore = (ms) => {
    if (!(S.goAt > 0) || ms < MIN_REACTION_MS) return 0;
    if (ms > S.playWindow) return null;
    const m = floorClaim(Math.min(ms, now() - S.goAt + REACTION_TOLERANCE_MS), now() - S.goAt);
    return Math.max(1, 2000 - Math.round(m));
  };

  // Took part in this session (telemetry §9.5): an action the session accepted in its play window.
  const SCORED_ACTIONS = new Set(["vote", "tally", "score", "tap", "taps", "reaction", "answer"]);
  const took = (anonId) => {
    if (S.acted && inWindow()) S.acted.add(anonId);
  };
  function action(peerId, d) {
    const peer = r.peers.get(peerId);
    if (!peer) return;
    const { anonId, nick } = peer;
    const name = d?.name;
    // A spectator watches this session: nothing they send scores or counts.
    if (SCORED_ACTIONS.has(name) && isSpectator(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "spectator" });
    if (name === "vote" && d?.payload?.option != null) {
      // Hidden picks: only while the round is open (a pick after the reveal would change a shown split).
      if (S.hidden && !hiddenOpen()) return ack(peerId, d.clientMsgId, { accepted: false, reason: "closed" });
      const option = String(d.payload.option);
      r.voters.set(anonId, option); // one vote per person, re-vote allowed
      took(anonId);
      onVotersChanged();
      onPoints(anonId, nick, 1);
      if (S.hidden) {
        // Only the count goes out; the pick goes back to this player only (all their connections).
        for (const [id, p] of r.peers) if (p.anonId === anonId) send(id, "setVar", { id: "myPick", value: { sessionNo: S.round, round: S.roundIdx, option } });
        setVar("voteProgress", voteProgress());
        syncVoteReveal();
      }
      // 눈치 배틀 / hidden picks keep the tally hidden until the reveal.
      else if (S.mode !== "guess") setVar("votesByOption", tally());
      if (S.mode === "bracket") maybeAdvanceMatchup();
      onActivity("vote", "투표함");
      ack(peerId, d.clientMsgId);
    } else if (name === "tally") {
      const delta = Number(d?.payload?.delta);
      r.coop += Number.isFinite(delta) ? delta : 1;
      took(anonId);
      onPoints(anonId, nick, 1);
      setVar("coopTotal", r.coop);
      onActivity("tally", "힘 보탬");
      ack(peerId, d?.clientMsgId);
    } else if (name === "score") {
      const s = Number(d?.payload?.score);
      if (Number.isFinite(s)) {
        const wasTop = board()[0] ?? 0;
        const isRecord = s > (r.scores.get(anonId) ?? -Infinity);
        if (isRecord) r.scores.set(anonId, s);
        took(anonId);
        onPoints(anonId, nick, isRecord ? 2 : 1);
        setVar("leaderboard", board());
        onActivity("score", s >= wasTop && s > 0 ? "신기록 🏆" : "점수 갱신");
        ack(peerId, d?.clientMsgId);
      }
    } else if (name === "tap") {
      if (S.mode === "nunchi") {
        if (S.phase === "play" && !S.eliminated.has(anonId) && !(S.pending || []).some((x) => x.anonId === anonId)) {
          S.pending = S.pending || [];
          S.pending.push({ anonId, nick: peerNick(peer) || r.roster.get(anonId) || "게스트", peerId });
          took(anonId);
          if (S.pending.length === 1) later("resolveNunchi", null, 350); // collision window
        }
      } else if (S.mode === "reaction") {
        // Legacy client (no device measurement): the host's clock decides.
        if (S.phase === "play" && S.reacted && !S.reacted.has(anonId)) {
          S.reacted.add(anonId);
          r.nicks.set(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
          const score = S.goAt > 0 ? Math.max(1, 2000 - (now() - S.goAt)) : 0; // 0 = 부정출발
          r.scores.set(anonId, score);
          took(anonId);
          setVar("raceBoard", raceBoard());
        }
      } else if (S.phase === "play") {
        took(anonId);
        tapCount(peer, (r.scores.get(anonId) ?? 0) + 1);
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "taps") {
      // MP-08: cumulative count measured on the device (sent every ~250 ms, once more at
      // the end) — the host keeps the max, so a lost or late batch never loses taps.
      const n = Math.floor(Number(d?.payload?.count));
      if (!Number.isFinite(n) || n < 0) return;
      if (S.mode === "" && S.playAt && inWindow()) {
        took(anonId);
        tapCount(peer, n); // the single play window (tap race)
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "reaction") {
      // MP-08: "green shown → tap" measured on the device; the host checks plausibility only.
      const ms = Number(d?.payload?.ms);
      if (!Number.isFinite(ms)) return;
      if (S.mode === "reaction" && S.reacted && !S.reacted.has(anonId) && inWindow()) {
        S.reacted.add(anonId);
        took(anonId);
        r.nicks.set(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
        const score = reactionScore(ms);
        if (score !== null) {
          r.scores.set(anonId, score);
          setVar("raceBoard", raceBoard());
        }
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "answer") {
      // One answer per player per round; the subject only watches. Scores show at the reveal.
      // A late resend (mesh resends for up to 10 s, a new host replays) names the round it
      // answered: another round or game is refused, so it never lands in the next one.
      const said = (k) => d?.payload?.[k] != null && d.payload[k] !== "";
      if (S.quiz && ((said("round") && Number(d.payload.round) !== S.roundIdx) || (said("sessionNo") && Number(d.payload.sessionNo) !== S.round))) {
        return ack(peerId, d?.clientMsgId, { accepted: false, reason: "stale_round" });
      }
      const round = S.rounds[S.roundIdx];
      const option = Number(d?.payload?.option);
      const valid = round && Number.isInteger(option) && option >= 0 && option < round.options.length;
      if (S.quiz && S.phase === "play" && S.accepting && valid && S.answered && !S.answered.has(anonId) && !isSubject(anonId)) {
        S.answered.add(anonId);
        S.answerers?.add(anonId);
        took(anonId);
        addQuizPlayer(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
        const ms = answerTime(d.payload.ms);
        const correct = option === round.answer;
        const points = correct ? Math.max(100, 1000 - Math.round((ms / S.answerMs) * 800)) : 0; // faster = more
        S.picks[S.roundIdx][anonId] = { option, ms, correct, points };
        // the device's own record of what the room took (a reload mid-round restores it)
        send(peerId, "setVar", { id: "myPick", value: { sessionNo: S.round, round: S.roundIdx, option, ms } });
        r.scores.set(anonId, (r.scores.get(anonId) ?? 0) + points);
        onPoints(anonId, nick, correct ? 2 : 1);
        setVar("quizProgress", quizProgress());
        syncReveal();
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "quizPack") {
      // 나 맞히기: the sender becomes the subject. In the lobby only the subject may update
      // their quiz (or anyone, when none is stored or its subject has left the room); from
      // the result anyone may send one ("나도 만들기").
      if (S.phase !== "lobby" && S.phase !== "result") return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_in_lobby" });
      if (autoOn()) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "auto_room" }); // a public room plays the app's own quiz
      if (S.phase === "lobby" && notSubject(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_subject" });
      // 나도 만들기: the first new pack in this result wins until the next game starts.
      if (S.phase === "result" && S.packDone === S.done && notSubject(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "pack_waiting" });
      const pack = sanitizeQuizPack(d?.payload);
      if (!pack) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "invalid_pack" });
      const about = typeof d.payload.about === "string" ? capText(cleanNick(d.payload.about), NICK_MAX) : ""; // a display name, capped like a nickname
      // 참가자→개설 (telemetry §9.1): after a finished game, from anyone but that game's subject.
      const source = S.done > 0 && anonId !== S.quizSubject?.anonId ? "remake" : "editor";
      S.quizPack = { ...pack, id: idOf(d.clientMsgId), subject: { anonId, nick: about || peerNick(peer) || "게스트" } };
      S.subject = anonId;
      S.packDone = S.phase === "result" ? S.done : -1;
      report(onGameCreated, { gid: S.quizPack.id, source });
      S.subjectAwayAt = null;
      watchSubjectAway();
      setVar("quizInfo", quizInfo());
      for (const [id, p] of r.peers) {
        sendSubjectFlag(id, p.anonId);
        send(id, "setVar", { id: "myPid", value: pidOf(p.anonId) });
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "rename") {
      // A guest who picked a real name in the lobby (#104): the room shows it at once.
      // Lobby / result only — a name never changes under a game in progress. Cleaned like a
      // join's nickname; the roster, the score owner name (raceBoard rows) and this person's
      // other connections follow. Per-player vars, pids and a stored quiz's `about` do not.
      if (S.phase !== "lobby" && S.phase !== "result") return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_in_lobby" });
      const next = typeof d?.payload?.nick === "string" ? cleanNick(d.payload.nick) : "";
      if (!next) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "invalid_nick" });
      for (const p of r.peers.values()) if (p.anonId === anonId) p.nick = next;
      if (r.roster.has(anonId)) r.roster.set(anonId, next);
      r.nicks.set(anonId, next);
      onPoints(anonId, next, 0); // register the new name (no points)
      setVar("roster", rosterArr());
      if (rule === "host" && S.host === anonId) setVar("hostNick", next);
      if (r.scores.has(anonId)) setKnown("raceBoard", raceBoard());
      ack(peerId, d?.clientMsgId);
    } else if (name === "start") {
      // 나 맞히기 (lobby or result): the subject starts their quiz — anyone if they left the
      // room — and needs someone to guess: the subject plus at least one friend.
      // Any start payload: a crafted {} or number must not start another game in this room.
      const p = d?.payload;
      // A public room starts by itself: a tap only wakes an idle lobby's countdown.
      if (autoOn()) return armAuto() ? ack(peerId, d?.clientMsgId) : ack(peerId, d?.clientMsgId, { accepted: false, reason: "auto_start" });
      if (notHost(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_host" });
      if (S.quizPack && S.phase !== "countdown" && S.phase !== "play") {
        if (notSubject(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_subject" });
        if (p && typeof p === "object" && p.quiz && !answerersHere().length) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "need_answerer" });
      }
      startSession(d?.payload, d?.clientMsgId).catch((e) => console.error("[snack-room] startSession failed", e));
      onPoints(anonId, nick, 1);
      ack(peerId, d?.clientMsgId);
    } else if (name === "lobby") {
      // With a stored quiz only its subject (or anyone, once they are gone) ends a game.
      if (notSubject(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_subject" });
      if (autoOn()) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "auto_start" });
      if (notHost(anonId)) return ack(peerId, d?.clientMsgId, { accepted: false, reason: "not_host" });
      clearSessionTimers();
      S.accepting = false;
      S.playAt = 0;
      S.lateUntil = 0;
      setPhase("lobby", { sessionCountdown: 0 });
      ack(peerId, d?.clientMsgId);
    }
  }

  return {
    /** A peer enters: it gets the full state, everyone gets the new roster. */
    join(peerId, { anonId, nick }) {
      anonId = String(anonId ?? "");
      nick = String(nick ?? "");
      onPoints(anonId, nick, 0); // register the nickname (no points yet)
      r.peers.set(peerId, { anonId, nick });
      pidOf(anonId); // keys go out in join order
      r.roster.set(anonId, cleanNick(nick) || "게스트");
      r.nicks.set(anonId, cleanNick(nick) || "게스트");
      // First join in this session during its countdown / play: a spectator until the next
      // start (the flag rides in this state; a reload already has it in r.mine).
      const live = S.phase === "countdown" || S.phase === "play";
      const newSpectator = live && !isMember(anonId) && !S.spectators?.has(anonId);
      if (newSpectator) {
        S.spectators.add(anonId);
        setSpectatorFlag(anonId, true, false); // goes out in the state below
      }
      // 방장 / 자동 시작: the room's mode, and who hosts (all in the state below).
      if (rule !== "any" && r.vars.get("roomMode") !== rule) setVar("roomMode", rule);
      if (rule === "host") {
        if (!S.host) setHost(anonId); // the first person in (on the edge: the organizer, who made the room)
        else if (S.host === anonId && S.hostAwayAt != null) {
          S.hostAwayAt = null; // back within the grace: still the host
          watchHostAway();
        }
        setMine(anonId, "iAmHost", S.host === anonId);
      }
      send(peerId, "state", this.stateFor(peerId));
      if (S.quizPack) sendSubjectFlag(peerId, anonId);
      if (S.quizPack && anonId === S.quizPack.subject.anonId && S.subjectAwayAt != null) {
        S.subjectAwayAt = null; // back in time (or late): the quiz is theirs again
        watchSubjectAway();
        publishSubjectHere();
      }
      if (S.quizPack || S.quiz) send(peerId, "setVar", { id: "myPid", value: pidOf(anonId) }); // which board row / pick is mine
      broadcast("participants", { count: r.peers.size });
      setVar("roster", rosterArr());
      setPhotos();
      if (live && S.spectators?.has(anonId)) publishSpectators();
      if (S.quiz && live && !S.spectators?.has(anonId)) {
        addQuizPlayer(anonId, r.roster.get(anonId)); // a member back (reload / flap) answers again
        if (S.phase === "play") {
          setVar("quizProgress", quizProgress());
          syncReveal({ mayPull: false }); // a newcomer who has not answered reopens the round
        }
      }
      if (hiddenOpen() && !S.spectators?.has(anonId)) {
        setVar("voteProgress", voteProgress()); // a member back (reload / flap) counts again
        syncVoteReveal({ mayPull: false });
      }
      if (r.scores.has(anonId)) setKnown("raceBoard", raceBoard()); // back after a flap: unmarked (MP-12)
      if (autoOn() && !armAuto() && autoTimer()) sendOut(peerId, "autoStart", autoMsg()); // the lobby's countdown, on their clock
      onActivity("join", "입장");
    },
    /**
     * Re-attach a peer to an engine restored from a snapshot (a Durable Object woke from
     * hibernation): no messages — the peer already shows this state.
     */
    rejoin(peerId, { anonId, nick }) {
      anonId = String(anonId ?? "");
      nick = String(nick ?? "");
      r.peers.set(peerId, { anonId, nick });
      pidOf(anonId);
      r.roster.set(anonId, cleanNick(nick) || "게스트");
      if (!r.nicks.has(anonId)) r.nicks.set(anonId, cleanNick(nick) || "게스트");
      if (rule === "host" && S.host === anonId && S.hostAwayAt != null) {
        S.hostAwayAt = null;
        watchHostAway();
      }
    },
    /** A peer leaves. Returns true when the room is now empty (and torn down). */
    leave(peerId) {
      const peer = r.peers.get(peerId);
      if (!peer) return r.peers.size === 0;
      r.peers.delete(peerId);
      // A reload overlaps its old connection (same anonId): the person is still here.
      const gone = ![...r.peers.values()].some((p) => p.anonId === peer.anonId);
      if (gone) r.roster.delete(peer.anonId);
      broadcast("participants", { count: r.peers.size });
      setVar("roster", rosterArr());
      setPhotos();
      if (gone && r.scores.has(peer.anonId)) setKnown("raceBoard", raceBoard()); // now marked as left
      if (gone) maybeAdvanceMatchup(); // everyone still here may already have voted
      if (gone && S.spectators?.has(peer.anonId)) publishSpectators();
      if (gone && S.quiz && S.phase === "play") {
        setVar("quizProgress", quizProgress());
        syncReveal(); // the last one still to answer left: everyone here has
      }
      if (gone && hiddenOpen()) {
        setVar("voteProgress", voteProgress());
        syncVoteReveal(); // the last one still to pick left: everyone here has
      }
      if (gone && S.quizPack && peer.anonId === S.quizPack.subject.anonId) {
        S.subjectAwayAt = now(); // counts as left only after SUBJECT_GRACE_MS
        watchSubjectAway();
      }
      if (gone && rule === "host" && peer.anonId === S.host) {
        S.hostAwayAt = now(); // hands over only after HOST_GRACE_MS
        watchHostAway();
      }
      if (gone && autoOn() && !r.roster.size && autoTimer()) cancel("autoStart"); // nobody left to start for
      if (r.peers.size === 0) this.destroy();
      return r.peers.size === 0;
    },
    action,
    /**
     * "auto" rooms (#136): the app's start payload (its template's `room.start`) and countdown ms,
     * sent by a client; the first one kept wins (until the room empties). Arms the lobby countdown.
     */
    configureAuto(opts, ms) {
      if (rule !== "auto" || S.autoOpts != null) return false;
      const ok = typeof opts === "number" ? Number.isFinite(opts) : Boolean(opts) && typeof opts === "object" && !Array.isArray(opts);
      if (!ok) return false;
      const json = JSON.stringify(opts);
      if (json.length > AUTO_OPTS_MAX) return false;
      S.autoOpts = JSON.parse(json);
      S.autoMs = (ms == null ? undefined : clampInt(ms, ...AUTO_START_RANGE)) ?? clampInt(autoStartMs, ...AUTO_START_RANGE) ?? AUTO_START_MS;
      armAuto();
      return true;
    },
    /** Would this player only watch the game in progress? (an auto room moves them on instead, #136) */
    wouldSpectate(anonId) {
      return (S.phase === "countdown" || S.phase === "play") && !isMember(String(anonId ?? ""));
    },
    /** Who starts a game here: "any" | "host" | "auto". */
    get startRule() {
      return rule;
    },
    /** Ephemeral emoji reaction — relayed to everyone, never stored. */
    react(emoji) {
      const e = String(emoji ?? "").slice(0, 8);
      if (e) broadcast("reaction", { emoji: e });
    },
    /**
     * Shared variables: every value broadcast so far, plus the live tally / total when
     * there is one. A variable this room never used is left out (MP-13): the app keeps
     * its own initial value instead of a "host set undeclared variable" warning.
     */
    sharedState() {
      // No live tally while picks are hidden (눈치 배틀 / hidden picks): only what was broadcast.
      const t = S.hidden || S.mode === "guess" ? {} : tally();
      const photos = rosterPhotosArr();
      return {
        ...(Object.keys(t).length ? { votesByOption: t } : {}),
        ...(r.coop ? { coopTotal: r.coop } : {}),
        ...Object.fromEntries(r.vars), // e.g. a hidden 눈치 배틀 tally stays as last shown
        roster: rosterArr(),
        ...(photos.some(Boolean) || r.vars.has("rosterPhotos") ? { rosterPhotos: photos } : {}),
      };
    },
    /** Values sent to this player only (keyed by anonId — survives a reload). */
    playerVars(peerId) {
      const peer = r.peers.get(peerId);
      return Object.fromEntries((peer && r.mine.get(peer.anonId)) || []);
    },
    /** What a joining / resyncing player gets: shared state + its own values. */
    stateFor(peerId) {
      return { sharedState: { ...this.sharedState(), ...this.playerVars(peerId) }, participants: r.peers.size };
    },
    get size() {
      return r.peers.size;
    },
    /** The nickname this connection goes by now (its hello's, or a later `rename`'s). */
    nickOf(peerId) {
      return r.peers.get(peerId)?.nick;
    },
    /**
     * Everything needed to resume this room elsewhere. Times are RELATIVE
     * (ms remaining / ms ago) — devices' clocks differ, so no absolute times.
     */
    snapshot() {
      const t = now();
      const { timers, answered, answerers, acted, eliminated, reacted, pending, members, spectators, roundStart, goAt, playAt, lateUntil, subjectAwayAt, hostAwayAt, ...rest } = S;
      return {
        v: 1,
        voters: [...r.voters],
        coop: r.coop,
        scores: [...r.scores],
        nicks: [...r.nicks],
        pids: [...r.pids],
        // quizRecap is rebuilt from rounds + picks on restore (the questions are already here twice)
        vars: [...r.vars].filter(([id]) => id !== "quizRecap"),
        recap: r.vars.has("quizRecap"),
        mine: [...r.mine].map(([anonId, own]) => [anonId, [...own]]),
        session: {
          ...rest,
          answered: answered ? [...answered] : undefined,
          answerers: answerers ? [...answerers] : undefined,
          acted: acted ? [...acted] : undefined,
          members: members ? [...members] : undefined,
          spectators: spectators ? [...spectators] : undefined,
          eliminated: eliminated ? [...eliminated] : undefined,
          reacted: reacted ? [...reacted] : undefined,
          pending: pending?.map(({ anonId, nick, peerId }) => ({ anonId, nick, peerId })),
          roundStartAgo: roundStart ? t - roundStart : undefined,
          goAtAgo: goAt ? t - goAt : undefined,
          playAtAgo: playAt ? t - playAt : undefined,
          lateLeft: lateUntil ? Math.max(0, lateUntil - t) : undefined,
          subjectAwayAgo: subjectAwayAt != null ? t - subjectAwayAt : undefined,
          hostAwayAgo: hostAwayAt != null ? t - hostAwayAt : undefined,
        },
        timers: timers.map((x) => ({ step: x.step, arg: x.arg, remaining: Math.max(0, x.at - t) })),
      };
    },
    /** Resume from a snapshot taken `age` ms ago (call before peers re-join). */
    restore(snap, age = 0) {
      if (!snap || snap.v !== 1) return false;
      clearSessionTimers();
      const t = now();
      r.voters.clear();
      for (const [k, v] of snap.voters) r.voters.set(k, v);
      r.coop = snap.coop;
      r.scores = new Map(snap.scores);
      r.nicks = new Map(snap.nicks);
      r.pids = new Map(snap.pids ?? []);
      r.vars = new Map(snap.vars ?? []);
      r.mine = new Map((snap.mine ?? []).map(([anonId, own]) => [anonId, new Map(own)]));
      const { answered, answerers, acted, members, spectators, eliminated, reacted, pending, roundStartAgo, goAtAgo, playAtAgo, lateLeft, subjectAwayAgo, hostAwayAgo, ...rest } = snap.session;
      Object.assign(S, rest, { timers: [] });
      if (answered) S.answered = new Set(answered);
      if (answerers) S.answerers = new Set(answerers);
      if (acted) S.acted = new Set(acted);
      S.members = members ? new Set(members) : null;
      S.spectators = new Set(spectators ?? []);
      if (eliminated) S.eliminated = new Set(eliminated);
      if (reacted) S.reacted = new Set(reacted);
      if (pending) S.pending = pending;
      if (roundStartAgo !== undefined) S.roundStart = t - roundStartAgo - age;
      if (goAtAgo !== undefined) S.goAt = t - goAtAgo - age;
      if (playAtAgo !== undefined) S.playAt = t - playAtAgo - age;
      if (lateLeft !== undefined) S.lateUntil = t + Math.max(0, lateLeft - age);
      // Nobody has joined this engine yet: the subject's grace runs from now unless it already ran.
      S.subjectAwayAt = subjectAwayAgo !== undefined ? t - subjectAwayAgo - age : S.quizPack ? t : null;
      watchSubjectAway();
      // The host's grace likewise (a join / rejoin of the host clears it).
      S.host ??= "";
      S.hostAwayAt = hostAwayAgo !== undefined ? t - hostAwayAgo - age : rule === "host" && S.host ? t : null;
      watchHostAway();
      if (snap.recap) r.vars.set("quizRecap", S.quiz && S.phase === "result" ? quizRecap() : { subject: null, about: null, title: "", packId: null, rounds: [] });
      for (const x of snap.timers) later(x.step, x.arg, Math.max(0, x.remaining - age));
      return true;
    },
    destroy() {
      r.destroyed = true;
      clearSessionTimers();
      if (awayTimer != null) clearTimer(awayTimer);
      if (hostTimer != null) clearTimer(hostTimer);
    },
    /** Internal state, for tests and (later) host snapshots. */
    _state: r,
  };
}
