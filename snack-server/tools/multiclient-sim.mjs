// multiclient-sim gate (E). Spins 2–8 WS clients into the same room and asserts
// live state converges across clients with no desync / tally error (FR-013/014).
// PRE: server running. stdout JSON + exit 0/1. See contracts/multiclient-sim.md.
//   Usage: node snack-server/tools/multiclient-sim.mjs [id ...] [--clients N]
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listIds, loadDoc, TPL_DIR, varNames, findEmit } from "./_doc.mjs";
import { SimClient, sleep, WS_URL, MESH, EDGE, EDGE_ROOM, prepareMesh, stopMesh, localEdgeHub } from "./_wsclient.mjs";
import { emit } from "./_gate.mjs";

// A broker (SIM_MESH; lossy by default) adds up to ~300ms per hop, host → peer, and a
// lost message is repaired by an action resend (~0.7s) or a resync beat (≤1s) — so a
// mesh change may take ~2.5s to reach everyone.
const SETTLE_MS = Number(process.env.SIM_SETTLE_MS || (MESH ? 3000 : 250));
const VOTES_DIR = join(TPL_DIR, "..", "votes");
// Unique-per-run prefix so each run uses ISOLATED throwaway rooms — never the
// canonical tpl-<id> rooms — so the sim neither pollutes real shared votes nor
// accumulates stale tallies across runs. Cleaned up at the end.
const RUN = Date.now().toString(36);
const SLUG_PREFIX = `simrun-${RUN}-`;

function kindOf(doc) {
  const v = varNames(doc);
  if (v.includes("sessionPhase")) return "session"; // lobby→countdown→play→result + tap race
  if (v.includes("votesByOption")) return "vote";
  if (v.includes("coopTotal")) return "coop";
  if (v.includes("leaderboard")) return "score";
  return null;
}

// option keys for a vote template (votesByOption initial is an object of keys)
function voteKeys(doc) {
  return Object.keys(doc.vars?.votesByOption ?? {});
}

// extract the app's own `start` host-event payload (game/quiz/rounds) so the sim
// can launch the session in its real mode (e.g. quiz) instead of a generic start.
function startPayload(doc) {
  return findEmit(doc, "start")?.payload ?? null;
}

// Every client shows the same view (and, if given, the expected value) within the
// settle window. Polled, not sampled once: over a broker clients see a change
// ~100ms apart, and round games keep changing (a single late sample can land
// mid-transition and look like a desync).
// Poll `fn` until true (or `ms` passes); resolves to its final value.
async function until(fn, ms, step = 100) {
  for (let w = 0; w < ms; w += step) {
    if (fn()) return true;
    await sleep(step);
  }
  return Boolean(fn());
}

async function settle(clients, view, done = () => true) {
  const deadline = Date.now() + SETTLE_MS + clients.length * 30;
  let diff = 0;
  do {
    await sleep(MESH ? 100 : SETTLE_MS + clients.length * 30);
    const ref = JSON.stringify(view(clients[0]));
    diff = clients.filter((c) => JSON.stringify(view(c)) !== ref).length;
    if (!diff && done(view(clients[0]))) return { converged: true, desyncEvents: 0 };
  } while (Date.now() < deadline);
  return { converged: diff === 0, desyncEvents: diff };
}

async function simOne(id, n) {
  const doc = loadDoc(id);
  const kind = kindOf(doc);
  if (!kind) return { id, skipped: true, reason: "not multiplayer" };
  // isolated throwaway room per (id, clientCount) — tests the same room LOGIC
  // (sync/tally/participants) without touching the canonical tpl-<id> room.
  const slug = `${SLUG_PREFIX}${id}-${n}`;
  const clients = Array.from({ length: n }, (_, i) => new SimClient(slug, `${slug}-c${i}`, `c${i}`));
  await Promise.all(clients.map((c) => c.ready));
  await sleep(SETTLE_MS);
  for (let w = 0; MESH && w < 6000 && !clients.every((c) => c.participants === n); w += 200) await sleep(200);

  // Synchronized session game: anyone starts → server-timed countdown → play →
  // result. The within-play contract varies by app, so sub-detect it and test
  // the RIGHT shared state: tap-race (raceBoard) / co-op (coopTotal) / round-vote
  // (votesByOption). Assert every client transitions together AND the live state
  // converges + sums correctly across all clients.
  if (kind === "session") {
    const sv = varNames(doc);
    const sp = startPayload(doc) || {};
    const sub = sv.includes("nunchiNum") ? "nunchi" : sv.includes("reactionGo") ? "reaction" : sp.mode === "guess" ? "guess" : sv.includes("roundAnswer") ? "quiz" : sv.includes("coopTotal") ? "tally" : sv.includes("votesByOption") ? "vote" : "tap";
    const device = sub === "reaction" ? Boolean(findEmit(doc, "reaction")) : sub === "tap" ? Boolean(findEmit(doc, "taps")) : undefined; // MP-08: device-measured
    const ACT = 4;
    // Every client must be SHOWN each phase, in order: a start that never happened (or a
    // session that never finished) cannot pass on convergence alone.
    const everyClient = (fn) => clients.every(fn);
    const everyPhase = (ph) => everyClient((c) => c.phases.includes(ph));
    const first = (c) => c.shared;
    const reachedPlay = until(() => everyPhase("play"), 8000); // polling from before the start
    let view, expected, exact = true, expectResult = true, check = null, quizCheck = null;
    if (sub === "guess") {
      // 눈치 배틀, one round: everyone predicts o0 → o0 IS the majority → the reveal says 0
      // and every player scores +100. Then the result screen.
      clients[0].start({ ...sp, roundMs: 3000, revealMs: 1500, rounds: 1 });
      await reachedPlay;
      clients.forEach((c) => c.vote("o0"));
      await until(() => (first(clients[0]).roundAnswer ?? -1) >= 0, 6000); // the reveal
      view = (c) => ({ ans: c.shared.roundAnswer, board: c.shared.raceBoard, votes: c.shared.votesByOption }); exact = false;
      check = (v) => v.ans === 0 && (v.board || []).length === n && (v.board || []).every((e) => e.score === 100) ? null : `guess: ans=${v.ans} board=${JSON.stringify(v.board)}`;
    } else if (sub === "nunchi") {
      clients[0].start(sp.mode ? sp : { mode: "nunchi" });
      await reachedPlay;
      clients.forEach((c) => c.tap()); // simultaneous → collision → elimination (a tap resent after a loss claims solo)
      // Every tap is counted exactly once — a solo claim (nunchiNum − 1 of them) or an
      // elimination — unless ≤1 survivor already ended the game (a tap resent after a loss
      // can land on the result screen; the engine rightly ignores it).
      const ended = (v) => v.phase === "result" && n - (v.elim ?? 0) <= 1;
      const counted = (v) => (v.num ?? 1) - 1 + (v.elim ?? 0) === n || ended(v);
      view = (c) => ({ phase: c.shared.sessionPhase, elim: c.shared.eliminatedCount, num: c.shared.nunchiNum }); exact = false; // iAmOut (per-client) checked below
      await until(() => counted(view(clients[0])), 5000);
      expectResult = n - (view(clients[0]).elim ?? 0) <= 1; // ≤1 survivor ends the game
      check = (v) => (counted(v) ? null : `nunchi: ${n} taps, ${(v.num ?? 1) - 1} claimed + ${v.elim ?? 0} out, phase ${v.phase}`);
    } else if (sub === "reaction") {
      clients[0].start(sp.mode ? sp : { mode: "reaction" });
      await reachedPlay;
      await until(() => first(clients[0]).reactionGo === true, 7000); // green
      if (findEmit(doc, "reaction")) {
        // MP-08 proof: each device reports the reaction time IT measured. The fastest
        // claim is sent LAST (a slow network), so the host hears the slowest one first —
        // host-arrival scoring would rank them backwards. Score must be 2000 − device ms.
        const claim = (i) => 120 + 60 * i; // c0 fastest … c(n−1) slowest, all inside the window
        const sendAt = (i) => claim(i) + (n - 1 - i) * 80; // leaves after the reaction, later for faster claims
        await Promise.all(clients.map((c, i) => sleep(sendAt(i)).then(() => c.reaction(claim(i)))));
        const want = clients.map((c, i) => [c.nick, 2000 - claim(i)]); // ranked by claimed ms, c0 first
        view = (c) => (c.shared.raceBoard || []).map((e) => [e.nick, e.score]); exact = false;
        check = (v) => JSON.stringify(v) === JSON.stringify(want) ? null : `reaction (device ms): board=${JSON.stringify(v)} want=${JSON.stringify(want)}`;
      } else {
        await sleep(90); // react
        clients.forEach((c) => c.tap());
        view = (c) => c.shared.raceBoard || []; exact = false; // reaction ms vary → convergence + everyone on the board, after green
        check = (v) => v.length === n && v.every((e) => e.score > 0) ? null : `reaction: board=${JSON.stringify(v)}`;
      }
    } else if (sub === "quiz") {
      // 나 맞히기: c0 sends its own one-question pack (the subject); everyone else answers with
      // the time THEIR device measured. The fastest claim is sent LAST (host-arrival order is
      // backwards); the subject's own answer must be ignored. Score = f(device ms), not arrival.
      const ANSWER_MS = 4000;
      const pack = { title: "sim 퀴즈", questions: [{ q: "c0가 좋아하는 숫자는?", options: ["하나", "둘", "셋", "넷"], answer: 2 }], settings: { rounds: 1, answerMs: ANSWER_MS } };
      clients[0].quizPack(pack);
      await until(() => everyClient((c) => c.shared.quizInfo?.custom === true && c.shared.quizInfo?.about === clients[0].nick), 8000);
      clients[0].start({ ...sp, revealMs: 1500 });
      await reachedPlay;
      await until(() => everyClient((c) => c.shared.roundContent?.q === pack.questions[0].q), 4000);
      const right = (clients[1].shared.roundContent?.options ?? []).indexOf("셋");
      const answerers = clients.slice(1);
      const claim = (i) => 200 + 150 * i; // c1 fastest … slowest, all inside the window
      const sendAt = (i) => claim(i) + (answerers.length - 1 - i) * 80; // after the tap; later for faster claims
      clients[0].answer(right, 10); // the subject: ignored
      await Promise.all(answerers.map((c, i) => sleep(sendAt(i)).then(() => c.answer(right, claim(i)))));
      await until(() => (first(clients[0]).roundAnswer ?? -1) >= 0, 6000);
      const pts = (ms) => Math.max(100, 1000 - Math.round((ms / ANSWER_MS) * 800));
      const want = answerers.map((c, i) => [c.nick, pts(claim(i))]).slice(0, 8);
      view = (c) => ({ ans: c.shared.roundAnswer, board: (c.shared.raceBoard || []).map((e) => [e.nick, e.score]) }); exact = false;
      check = (v) => v.ans === right && JSON.stringify(v.board) === JSON.stringify(want) ? null : `quiz (device ms): ans=${v.ans}/${right} board=${JSON.stringify(v.board)} want=${JSON.stringify(want)}`;
      // …and the recap reaches everyone: subject c0, each answerer's own ms (picks in roster order)
      const recapOk = () => everyClient((c) => c.shared.quizRecap?.subject === clients[0].nick && JSON.stringify((c.shared.quizRecap.rounds?.[0]?.picks || []).map((p) => [p.nick, p.ms, p.correct]).sort()) === JSON.stringify(answerers.map((a, i) => [a.nick, claim(i), true])));
      quizCheck = async () => ((await until(recapOk, SETTLE_MS + 3000)) ? null : `quizRecap: ${JSON.stringify(clients[1].shared.quizRecap)}`);
    } else {
      clients[0].start(3000); // single play window
      await reachedPlay;
      if (sub === "tally") {
        for (let k = 0; k < ACT; k++) { clients.forEach((c) => c.tally(1)); await sleep(40); }
        view = (c) => c.shared.coopTotal ?? 0; expected = n * ACT;
      } else if (sub === "vote") {
        const opt = voteKeys(doc)[0] || "o0";
        clients.forEach((c) => c.vote(opt));
        view = (c) => (c.shared.votesByOption || {})[opt] ?? 0; expected = n;
      } else if (findEmit(doc, "taps")) {
        // MP-08: each device sends its running total in batches (plus one stale resend);
        // every device's card must equal its row on the board — exactly.
        const finalOf = (i) => 3 + i;
        for (let k = 1; k <= 3 + n; k++) {
          clients.forEach((c, i) => k <= finalOf(i) && c.taps(k));
          await sleep(60);
        }
        clients[0].taps(1); // an old batch arriving late: never rolls the count back
        const want = clients.map((c, i) => [c.nick, finalOf(i)]).sort((a, b) => b[1] - a[1]);
        view = (c) => (c.shared.raceBoard || []).map((e) => [e.nick, e.score]); exact = false;
        check = (v) => JSON.stringify(v) === JSON.stringify(want) ? null : `taps (device counts): board=${JSON.stringify(v)} want=${JSON.stringify(want)}`;
      } else {
        for (let k = 0; k < ACT; k++) { clients.forEach((c) => c.tap()); await sleep(40); }
        view = (c) => c.shared.raceBoard || []; expected = n * ACT;
      }
    }
    const total = (v) => (sub === "tap" ? (v || []).reduce((s, e) => s + (e.score || 0), 0) : v);
    const { converged, desyncEvents } = await settle(clients, view, (v) => (exact ? total(v) === expected : !check?.(v)));
    const tallyError = exact ? Math.abs(total(view(clients[0])) - expected) : 0;
    const failure = check ? check(view(clients[0])) : null;
    // The session must run to its end: every client shown play, then result (polled —
    // a timed phase reaches clients up to ~300 ms apart over a broker).
    const playSeen = await reachedPlay;
    const resultSeen = expectResult ? await until(() => everyClient((c) => c.sawInOrder("play", "result")), 12000) : null;
    const samePhase = () => everyClient((c) => c.shared.sessionPhase === clients[0].shared.sessionPhase);
    for (let w = 0; MESH && !samePhase() && w < SETTLE_MS; w += 100) await sleep(100);
    const phaseSynced = samePhase();
    const recapFailure = quizCheck ? await quizCheck() : null;
    const participantsAccurate = everyClient((c) => c.participants === n);
    // MP-07: exactly the eliminated players see iAmOut — still true after the resync beats.
    let outAccurate = true;
    if (sub === "nunchi") {
      await sleep(MESH ? 3500 : 300);
      outAccurate = clients.filter((c) => c.shared.iAmOut === true).length === (clients[0].shared.eliminatedCount ?? 0);
    }
    const phases = clients.map((c) => c.phases.join(">"));
    clients.forEach((c) => c.close());
    await sleep(60);
    const ok = converged && desyncEvents === 0 && tallyError === 0 && !failure && !recapFailure && playSeen && resultSeen !== false && participantsAccurate && phaseSynced && outAccurate;
    return {
      id, kind: `session:${sub}${device ? ":device-measured" : ""}`, clients: n, ok, converged, desyncEvents, tallyError, participantsAccurate, phaseSynced,
      reachedPlay: playSeen, reachedResult: resultSeen, phases: [...new Set(phases)],
      ...(device ? { deviceMeasured: true, board: view(clients[0]) } : {}),
      ...(failure ? { failure } : {}), ...(recapFailure ? { recapFailure } : {}), ...(sub === "nunchi" ? { outAccurate } : {}),
      ...(sub === "quiz" ? { deviceMeasured: true, customPack: true, board: view(clients[0]).board } : {}),
    };
  }

  let expected;
  if (kind === "vote") {
    const keys = voteKeys(doc);
    const opt = keys[0] || "q0A";
    clients.forEach((c) => c.vote(opt)); // distinct anonIds → N tallied
    expected = { key: opt, count: n };
  } else if (kind === "coop") {
    const base = clients[0].shared.coopTotal ?? 0;
    clients.forEach((c) => c.tally(1));
    expected = base + n;
  } else { // score
    const scores = clients.map((_, i) => (i + 1) * 10);
    clients.forEach((c, i) => c.score(scores[i]));
    expected = Math.max(...scores);
  }
  // assert convergence across clients
  let tallyError = 0;
  const view = (c) => c.shared[kind === "vote" ? "votesByOption" : kind === "coop" ? "coopTotal" : "leaderboard"];
  const { converged, desyncEvents } = await settle(clients, view, (v) => {
    if (kind === "vote") return ((v || {})[expected.key] ?? 0) === expected.count;
    if (kind === "coop") return (v ?? 0) === expected;
    return ((v || [])[0] ?? 0) === expected;
  });

  if (kind === "vote") {
    const got = (view(clients[0]) || {})[expected.key] ?? 0;
    tallyError = Math.abs(got - expected.count);
  } else if (kind === "coop") {
    tallyError = Math.abs((view(clients[0]) ?? 0) - expected);
  } else {
    const top = (view(clients[0]) || [])[0] ?? 0;
    tallyError = Math.abs(top - expected);
  }
  const participantsAccurate = clients.every((c) => c.participants === n);
  clients.forEach((c) => c.close());
  await sleep(60);

  const ok = converged && desyncEvents === 0 && tallyError === 0 && participantsAccurate;
  return { id, kind, clients: n, ok, converged, desyncEvents, tallyError, participantsAccurate };
}

// Spectator row (나 맞히기): c0 (subject) + c1, c2 play; c3 opens the link mid-round. c3 is
// told it is watching (iAmSpectator, spectators = 1 everywhere), its fastest-of-all answer is
// refused, the round is still revealed early once c1 and c2 answered (not at the window's
// end), the board and recap hold only c1 and c2, and c3 sees the result like everyone else.
const SPECTATE_ID = "speed-trivia-score";
async function simSpectator(id) {
  const doc = loadDoc(id);
  const sp = startPayload(doc) || {};
  const slug = `${SLUG_PREFIX}${id}-spectate`;
  const players = Array.from({ length: 3 }, (_, i) => new SimClient(slug, `${slug}-c${i}`, `c${i}`));
  await Promise.all(players.map((c) => c.ready));
  await sleep(SETTLE_MS);
  for (let w = 0; MESH && w < 6000 && !players.every((c) => c.participants === 3); w += 200) await sleep(200);
  const ANSWER_MS = 10000;
  const pack = { title: "sim 관전", questions: [{ q: "c0가 좋아하는 과일은?", options: ["사과", "배", "감", "귤"], answer: 3 }], settings: { rounds: 1, answerMs: ANSWER_MS } };
  players[0].quizPack(pack);
  await until(() => players.every((c) => c.shared.quizInfo?.custom === true), 8000);
  players[0].start({ ...sp, revealMs: 1500 });
  const reachedPlay = await until(() => players.every((c) => c.shared.sessionPhase === "play" && c.shared.roundContent?.q === pack.questions[0].q), 8000);
  const playAt = Date.now();
  const late = new SimClient(slug, `${slug}-c3`, "c3"); // opens the link mid-round
  await late.ready;
  const all = [...players, late];
  const flagged = await until(() => late.shared.iAmSpectator === true && all.every((c) => c.shared.spectators === 1), SETTLE_MS + 3000);
  const playersUnflagged = players.every((c) => c.shared.iAmSpectator !== true);
  const right = (late.shared.roundContent?.options ?? []).indexOf("귤");
  late.answer(right, 30); // would top the board if it counted
  await sleep(400);
  const claim = { c1: 300, c2: 450 };
  players[1].answer(right, claim.c1);
  players[2].answer(right, claim.c2);
  const revealed = await until(() => (players[0].shared.roundAnswer ?? -1) >= 0, ANSWER_MS);
  const revealAfter = Date.now() - playAt;
  const early = revealed && revealAfter < ANSWER_MS - 1500; // early reveal: not held up by the spectator
  const pts = (ms) => Math.max(100, 1000 - Math.round((ms / ANSWER_MS) * 800));
  const want = [["c1", pts(claim.c1)], ["c2", pts(claim.c2)]];
  const view = (c) => ({ ans: c.shared.roundAnswer, board: (c.shared.raceBoard || []).map((e) => [e.nick, e.score]) });
  const { converged, desyncEvents } = await settle(all, view, (v) => v.ans === right && JSON.stringify(v.board) === JSON.stringify(want));
  const boardOk = JSON.stringify(view(players[0]).board) === JSON.stringify(want);
  const progressOk = players[0].shared.quizProgress?.of === 2;
  const resultSeen = await until(() => all.every((c) => c.phases.includes("play") && c.sawInOrder("play", "result")), 12000);
  const recapOk = await until(() => all.every((c) => JSON.stringify((c.shared.quizRecap?.rounds?.[0]?.picks || []).map((p) => p.nick).sort()) === JSON.stringify(["c1", "c2"])), SETTLE_MS + 3000);
  all.forEach((c) => c.close());
  await sleep(60);
  const ok = reachedPlay && flagged && playersUnflagged && early && converged && desyncEvents === 0 && boardOk && progressOk && resultSeen && recapOk;
  return {
    id: `${id}:spectator`, kind: "session:quiz:spectator", clients: 4, ok, reachedPlay, flagged, playersUnflagged, revealAfterMs: revealAfter, earlyReveal: early,
    converged, desyncEvents, boardOk, progressOk, reachedResult: resultSeen, recapOk, board: view(players[0]).board,
    ...(ok ? {} : { want, progress: players[0].shared.quizProgress, recap: players[0].shared.quizRecap?.rounds?.[0]?.picks }),
  };
}

// SIM_EDGE with the local hub: messages each room's players published (docs/edge-relay.md §3).
// Room slugs are SLUG_PREFIX + id + "-" + clients (or "-spectate").
function edgeAccounting(hub) {
  const rows = [];
  for (const [key, st] of hub.history()) {
    const room = key.slice(key.indexOf(":") + 1);
    if (!room.startsWith(SLUG_PREFIX)) continue;
    const m = /^(.*)-(\d+|spectate)$/.exec(room.slice(SLUG_PREFIX.length));
    if (!m) continue;
    const players = m[2] === "spectate" ? 4 : Number(m[2]);
    const seconds = Math.max(1, (st.last - st.first) / 1000);
    rows.push({ id: m[1] + (m[2] === "spectate" ? ":spectator" : ""), players, seconds: Math.round(seconds * 10) / 10, in: st.in, out: st.out, perPlayer: Math.round(st.in / players), perPlayerPerMin: Math.round((st.in / players / seconds) * 60), byType: st.byType, conns: st.conns });
  }
  return rows;
}

async function main() {
  const broker = await prepareMesh();
  const argv = process.argv.slice(2);
  const ci = argv.indexOf("--clients");
  const n = ci >= 0 ? Number(argv[ci + 1]) : 0;
  const ids = argv.filter((a, i) => !a.startsWith("--") && (ci < 0 || i !== ci + 1));
  const targets = (ids.length ? ids : listIds()).filter((id) => kindOf(loadDoc(id)));

  const results = [];
  for (const id of targets) {
    try {
      // sweep 2..8 unless a fixed --clients given
      const counts = n ? [n] : [2, 5, 8];
      let merged = null;
      for (const c of counts) {
        const r = await simOne(id, c);
        // keep every failing sweep's details (the merged row shows only the last one)
        const failedSweeps = [...(merged?.failedSweeps ?? []), ...(r.ok ? [] : [r])];
        merged = merged ? { ...r, sweep: [...(merged.sweep || [merged.clients]), c], ok: merged.ok && r.ok, failedSweeps } : { ...r, sweep: [c], failedSweeps };
      }
      results.push(merged);
    } catch (e) {
      results.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  if (targets.includes(SPECTATE_ID)) {
    try {
      results.push(await simSpectator(SPECTATE_ID));
    } catch (e) {
      results.push({ id: `${SPECTATE_ID}:spectator`, ok: false, error: String(e?.message ?? e) });
    }
  }
  // clean up this run's throwaway persisted vote files (best-effort)
  try {
    for (const f of readdirSync(VOTES_DIR)) {
      if (f.startsWith(SLUG_PREFIX) && f.endsWith(".json")) rmSync(join(VOTES_DIR, f), { force: true });
    }
  } catch { /* best-effort */ }

  // Lossy evidence from the local broker (mesh mode): loss was requested AND happened.
  // With an external SIM_BROKER nothing is known about it → nulls.
  const stats = EDGE || EDGE_ROOM
    ? { relay: localEdgeHub() ? "edge hub (node, same core as the DO)" : process.env.SIM_EDGE_URL, ...(localEdgeHub() ? { accounting: edgeAccounting(localEdgeHub()) } : {}) }
    : MESH
    ? broker
      ? { lossy: broker.lossy, dropped: broker.stats.dropped, delivered: broker.stats.delivered, publishes: broker.stats.publishes, bytes: broker.stats.bytes, seconds: Math.round((Date.now() - broker.stats.startedAt) / 1000) }
      : { lossy: null, dropped: null, delivered: null }
    : null;
  const lossOk = !stats?.lossy || stats.dropped > 0;
  const where = EDGE_ROOM ? `edge room (DO engine) @ ${stats.relay}` : EDGE ? `edge relay @ ${stats.relay}` : MESH ? `mqtt mesh @ local broker${stats?.lossy ? ` (lossy: ${stats.dropped} dropped / ${stats.delivered} delivered)` : ""}` : WS_URL;
  await stopMesh();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = failed === 0 && lossOk;
  emit({
    gate: "multiclient-sim",
    ok,
    total: results.length,
    passed,
    failed,
    ...(stats ?? {}),
    results,
    summary: `multiclient-sim @ ${where}: ${passed}/${results.length} synced${failed ? ` — ${failed} FAIL` : ""}${lossOk ? "" : " — lossy mode requested but nothing was dropped"}`,
  });
  process.exitCode = ok ? 0 : 1;
}

main();
