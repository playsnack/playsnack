// One live room: who is here, shared tallies, and the synchronized game session
// (lobby → countdown 3·2·1 → play → result). Pure logic — clock, timers, random,
// content, persistence and transport are injected, so the same engine runs on the
// server today and in the host player's browser (host mode).
//
// Input: join / leave / action / react from peers. Output: `broadcast(t, d)` to
// everyone and `send(peerId, t, d)` to one peer, using the wire messages the
// player already speaks ("state", "setVar", "participants", "reaction", "actionAck").

export const cleanNick = (n) => String(n ?? "").trim().slice(0, 16);

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
  } = o;

  const r = {
    voters,
    peers: new Map(), // peerId → { anonId, nick }
    coop: 0,
    scores: new Map(), // anonId → score
    roster: new Map(), // anonId → nick (live participants, insertion order)
    nicks: new Map(), // anonId → nick (score owner names)
    session: { phase: "lobby", round: 0, num: 0, timers: [], rounds: [], bracket: null, gen: 0 },
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
  const raceBoard = () =>
    [...r.scores.entries()]
      .map(([id, score]) => ({ nick: r.nicks.get(id) || r.roster.get(id) || "게스트", score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  const rosterArr = () => [...r.roster.values()].slice(0, 8);
  const rosterPhotosArr = () => [...r.roster.keys()].slice(0, 8).map((id) => photoUrl(id) || "");

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
  const setPhase = (phase, extra = {}) => {
    S.phase = phase;
    setVar("sessionPhase", phase);
    for (const [k, v] of Object.entries(extra)) {
      if (k === "sessionCountdown") S.num = v;
      setVar(k, v);
    }
  };
  const toResult = () => setPhase("result", { raceBoard: raceBoard(), leaderboard: board() });

  // Round-based (vote / content) — each round is a fresh vote.
  const startRound = (i) => {
    if (i >= S.rounds.length) return toResult();
    r.voters.clear();
    S.roundIdx = i;
    setPhase("play", { roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: S.rounds[i], votesByOption: tally() });
    later("startRound", i + 1, S.roundMs);
  };

  // Quiz: answer window (answer hidden) → reveal (answer + scores).
  const startQuizRound = (i) => {
    if (i >= S.rounds.length) return toResult();
    S.roundIdx = i;
    S.answered = new Set();
    S.accepting = true;
    S.roundStart = now();
    const { answer, ...pub } = S.rounds[i]; // clients must not see the answer
    void answer;
    setPhase("play", { roundIdx: i, roundTotal: S.rounds.length, roundNum: i + 1, roundContent: pub, roundAnswer: -1 });
    later("revealQuizRound", i, S.answerMs);
  };
  const revealQuizRound = (i) => {
    S.accepting = false;
    setVar("roundAnswer", S.rounds[i].answer);
    setVar("raceBoard", raceBoard());
    setVar("leaderboard", board());
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
  const nunchiAlive = () => [...r.roster.entries()].filter(([id]) => !S.eliminated.has(id)).map(([, n]) => n);
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
    r.voters.clear();
    const [a, b] = bk.matchups[i];
    setPhase("play", {
      roundContent: { a, b },
      votesByOption: tally(),
      matchWinner: -1,
      bracketLabel: `${roundNameFor(bk.roundCands.length)} · ${i + 1}/${bk.matchups.length}`,
    });
    later("resolveMatchup", i, S.matchupMs);
  };
  const resolveMatchup = (i) => {
    const bk = S.bracket;
    if (!bk) return;
    const t = tally();
    const winIdx = (t.o0 || 0) >= (t.o1 || 0) ? 0 : 1;
    bk.winners.push(bk.matchups[i][winIdx]);
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
    const majority = (t.o0 || 0) >= (t.o1 || 0) ? 0 : 1; // tie → o0
    for (const [anonId, opt] of r.voters) {
      if (opt === `o${majority}`) {
        r.scores.set(anonId, (r.scores.get(anonId) ?? 0) + 100);
        r.nicks.set(anonId, r.roster.get(anonId) || r.nicks.get(anonId) || "게스트");
      }
    }
    setVar("votesByOption", t);
    setVar("roundAnswer", majority);
    setVar("raceBoard", raceBoard());
    setVar("leaderboard", board());
    later("startGuessRound", i + 1, S.revealMs);
  };

  const STEPS = {
    countdown: (n) => setPhase("countdown", { sessionCountdown: n }),
    play: (extra) => setPhase("play", extra),
    green: () => {
      if (S.phase !== "play") return;
      S.goAt = now();
      setVar("reactionGo", true);
    },
    result: () => toResult(),
    startRound,
    startQuizRound,
    revealQuizRound,
    resolveNunchi: () => resolveNunchi(),
    endNunchi: () => endNunchi(),
    startMatchup,
    resolveMatchup,
    startGuessRound,
    revealGuessRound,
  };

  const startSession = async (opts) => {
    if (S.phase === "countdown" || S.phase === "play") return; // already running
    if (typeof opts === "number") opts = { duration: opts };
    opts = opts || {};
    clearSessionTimers();
    S.round += 1;
    S.mode = "";
    S.rounds = []; // a stale timer from a torn-down session sees [] → result
    S.bracket = null;
    const myGen = ++S.gen; // older sessions' timers/awaits become no-ops
    r.scores.clear();
    r.coop = 0;
    r.voters.clear();
    setVar("raceBoard", []);
    setVar("leaderboard", []);
    setVar("coopTotal", 0);
    setVar("votesByOption", tally());
    onActivity("start", "게임 시작");
    // Fetch content first — the lobby stays up meanwhile, so every timer below is
    // scheduled from one sync point and clients stay in step.
    const pack = await getPack(opts.game, opts);
    if (r.destroyed || S.gen !== myGen) return; // room gone or superseded during the fetch
    setPhase("countdown", { sessionCountdown: 3 });
    later("countdown", 2, 1000);
    later("countdown", 1, 2000);
    if (opts.mode === "reaction") {
      // Red WAIT → green at a synced random moment; fastest tap after green wins.
      S.mode = "reaction";
      S.reacted = new Set();
      S.goAt = 0;
      setVar("reactionGo", false);
      const delay = 1500 + Math.floor(random() * 3000);
      const playWindow = 4000;
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
    } else if (pack && pack.length && opts.quiz) {
      S.rounds = shuffled(pack).slice(0, Math.min(pack.length, Math.max(1, Number(opts.rounds) || 6)));
      S.answerMs = Math.min(20000, Math.max(3000, Number(opts.answerMs) || 8000));
      S.revealMs = Math.min(8000, Math.max(1500, Number(opts.revealMs) || 3000));
      S.quiz = true;
      later("startQuizRound", 0, 3000);
    } else if (pack && pack.length) {
      S.rounds = shuffled(pack).slice(0, Math.min(pack.length, Math.max(1, Number(opts.rounds) || 5)));
      S.roundMs = Math.min(20000, Math.max(3000, Number(opts.roundMs) || 8000));
      S.quiz = false;
      later("startRound", 0, 3000);
    } else {
      // Single play window (tap race / co-op).
      const dur = Math.min(60000, Math.max(3000, Number(opts.duration) || 12000));
      S.rounds = [];
      later("play", { sessionCountdown: 0 }, 3000);
      later("result", null, 3000 + dur);
    }
  };

  // ── peers ──
  const ack = (peerId, clientMsgId, extra = { accepted: true }) => send(peerId, "actionAck", { clientMsgId, ...extra });
  const peerNick = (peer) => cleanNick(peer.nick);

  function action(peerId, d) {
    const peer = r.peers.get(peerId);
    if (!peer) return;
    const { anonId, nick } = peer;
    const name = d?.name;
    if (name === "vote" && d?.payload?.option != null) {
      r.voters.set(anonId, String(d.payload.option)); // one vote per person, re-vote allowed
      onVotersChanged();
      onPoints(anonId, nick, 1);
      // 눈치 배틀 keeps the tally hidden until the reveal.
      if (S.mode !== "guess") setVar("votesByOption", tally());
      onActivity("vote", "투표함");
      ack(peerId, d.clientMsgId);
    } else if (name === "tally") {
      const delta = Number(d?.payload?.delta);
      r.coop += Number.isFinite(delta) ? delta : 1;
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
          if (S.pending.length === 1) later("resolveNunchi", null, 350); // collision window
        }
      } else if (S.mode === "reaction") {
        if (S.phase === "play" && S.reacted && !S.reacted.has(anonId)) {
          S.reacted.add(anonId);
          r.nicks.set(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
          const score = S.goAt > 0 ? Math.max(1, 2000 - (now() - S.goAt)) : 0; // 0 = 부정출발
          r.scores.set(anonId, score);
          setVar("raceBoard", raceBoard());
        }
      } else if (S.phase === "play") {
        r.scores.set(anonId, (r.scores.get(anonId) ?? 0) + 1);
        r.nicks.set(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
        setVar("raceBoard", raceBoard());
        setVar("leaderboard", board());
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "answer") {
      if (S.quiz && S.accepting && S.answered && !S.answered.has(anonId)) {
        S.answered.add(anonId);
        const round = S.rounds[S.roundIdx];
        if (round && Number(d?.payload?.option) === round.answer) {
          const elapsed = now() - S.roundStart;
          const pts = Math.max(100, 1000 - Math.round((elapsed / S.answerMs) * 800)); // faster = more
          r.scores.set(anonId, (r.scores.get(anonId) ?? 0) + pts);
          r.nicks.set(anonId, peerNick(peer) || r.nicks.get(anonId) || "게스트");
          onPoints(anonId, nick, 2);
          setVar("raceBoard", raceBoard());
          setVar("leaderboard", board());
        } else onPoints(anonId, nick, 1);
      }
      ack(peerId, d?.clientMsgId);
    } else if (name === "start") {
      startSession(d?.payload).catch((e) => console.error("[snack-room] startSession failed", e));
      onPoints(anonId, nick, 1);
      ack(peerId, d?.clientMsgId);
    } else if (name === "lobby") {
      clearSessionTimers();
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
      r.roster.set(anonId, cleanNick(nick) || "게스트");
      r.nicks.set(anonId, cleanNick(nick) || "게스트");
      send(peerId, "state", this.stateFor(peerId));
      broadcast("participants", { count: r.peers.size });
      setVar("roster", rosterArr());
      setVar("rosterPhotos", rosterPhotosArr());
      onActivity("join", "입장");
    },
    /** A peer leaves. Returns true when the room is now empty (and torn down). */
    leave(peerId) {
      const peer = r.peers.get(peerId);
      if (!peer) return r.peers.size === 0;
      r.peers.delete(peerId);
      // A reload overlaps its old connection (same anonId): the person is still here.
      if (![...r.peers.values()].some((p) => p.anonId === peer.anonId)) r.roster.delete(peer.anonId);
      broadcast("participants", { count: r.peers.size });
      setVar("roster", rosterArr());
      setVar("rosterPhotos", rosterPhotosArr());
      if (r.peers.size === 0) this.destroy();
      return r.peers.size === 0;
    },
    action,
    /** Ephemeral emoji reaction — relayed to everyone, never stored. */
    react(emoji) {
      const e = String(emoji ?? "").slice(0, 8);
      if (e) broadcast("reaction", { emoji: e });
    },
    /** Shared variables: computed defaults, then every value broadcast so far. */
    sharedState() {
      return {
        votesByOption: tally(),
        coopTotal: r.coop,
        leaderboard: board(),
        sessionPhase: S.phase,
        sessionCountdown: S.num,
        raceBoard: raceBoard(),
        ...Object.fromEntries(r.vars), // e.g. a hidden 눈치 배틀 tally stays as last shown
        roster: rosterArr(),
        rosterPhotos: rosterPhotosArr(),
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
    /**
     * Everything needed to resume this room elsewhere. Times are RELATIVE
     * (ms remaining / ms ago) — devices' clocks differ, so no absolute times.
     */
    snapshot() {
      const t = now();
      const { timers, answered, eliminated, reacted, pending, roundStart, goAt, ...rest } = S;
      return {
        v: 1,
        voters: [...r.voters],
        coop: r.coop,
        scores: [...r.scores],
        nicks: [...r.nicks],
        vars: [...r.vars],
        mine: [...r.mine].map(([anonId, own]) => [anonId, [...own]]),
        session: {
          ...rest,
          answered: answered ? [...answered] : undefined,
          eliminated: eliminated ? [...eliminated] : undefined,
          reacted: reacted ? [...reacted] : undefined,
          pending: pending?.map(({ anonId, nick, peerId }) => ({ anonId, nick, peerId })),
          roundStartAgo: roundStart ? t - roundStart : undefined,
          goAtAgo: goAt ? t - goAt : undefined,
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
      r.vars = new Map(snap.vars ?? []);
      r.mine = new Map((snap.mine ?? []).map(([anonId, own]) => [anonId, new Map(own)]));
      const { answered, eliminated, reacted, pending, roundStartAgo, goAtAgo, ...rest } = snap.session;
      Object.assign(S, rest, { timers: [] });
      if (answered) S.answered = new Set(answered);
      if (eliminated) S.eliminated = new Set(eliminated);
      if (reacted) S.reacted = new Set(reacted);
      if (pending) S.pending = pending;
      if (roundStartAgo !== undefined) S.roundStart = t - roundStartAgo - age;
      if (goAtAgo !== undefined) S.goAt = t - goAtAgo - age;
      for (const x of snap.timers) later(x.step, x.arg, Math.max(0, x.remaining - age));
      return true;
    },
    destroy() {
      r.destroyed = true;
      clearSessionTimers();
    },
    /** Internal state, for tests and (later) host snapshots. */
    _state: r,
  };
}
