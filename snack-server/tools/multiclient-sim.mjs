// multiclient-sim gate (E). Spins 2–8 WS clients into the same room and asserts
// live state converges across clients with no desync / tally error (FR-013/014).
// PRE: server running. stdout JSON + exit 0/1. See contracts/multiclient-sim.md.
//   Usage: node snack-server/tools/multiclient-sim.mjs [id ...] [--clients N]
import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listIds, loadDoc, TPL_DIR, varNames, findEmit } from "./_doc.mjs";
import { SimClient, sleep, WS_URL, MESH } from "./_wsclient.mjs";
import { runGate } from "./_gate.mjs";

// A public broker (SIM_MESH) adds ~150ms per hop, host → peer.
const SETTLE_MS = Number(process.env.SIM_SETTLE_MS || (MESH ? 1200 : 250));
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
  const clients = Array.from({ length: n }, (_, i) => new SimClient(slug, `${slug}-c${i}`));
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
    const ACT = 4;
    let view, expected, exact = true;
    if (sub === "guess") {
      // 눈치 배틀: all predict o0 → o0 is the majority → roundAnswer reveals 0, scores awarded.
      clients[0].start({ ...sp, roundMs: 3000, revealMs: 1500, rounds: 2 });
      let w = 0; while (clients[0].shared.sessionPhase !== "play" && w < 7000) { await sleep(120); w += 120; }
      clients.forEach((c) => c.vote("o0"));
      let rr = 0; while ((clients[0].shared.roundAnswer ?? -1) < 0 && rr < 6000) { await sleep(150); rr += 150; } // wait reveal
      view = (c) => ({ ans: c.shared.roundAnswer, board: c.shared.raceBoard, votes: c.shared.votesByOption }); exact = false;
    } else if (sub === "nunchi") {
      clients[0].start(startPayload(doc) || { mode: "nunchi" });
      let w = 0; while (clients[0].shared.sessionPhase !== "play" && w < 7000) { await sleep(120); w += 120; }
      clients.forEach((c) => c.tap()); // simultaneous → collision → elimination
      await sleep(700); // 350ms window + resolve + end
      view = (c) => ({ phase: c.shared.sessionPhase, elim: c.shared.eliminatedCount }); exact = false; // broadcast vars converge (iAmOut is per-client, not checked)
    } else if (sub === "reaction") {
      clients[0].start(startPayload(doc) || { mode: "reaction" });
      let w = 0; while (clients[0].shared.sessionPhase !== "play" && w < 7000) { await sleep(120); w += 120; }
      let g = 0; while (!clients[0].shared.reactionGo && g < 7000) { await sleep(80); g += 80; } // wait for green flip
      await sleep(90); // react
      clients.forEach((c) => c.tap());
      view = (c) => c.shared.raceBoard || []; exact = false; // reaction-ms varies → convergence only
    } else if (sub === "quiz") {
      // replay the app's real start (game/quiz params) so the server runs quiz mode; shorten timings
      const p = { ...(startPayload(doc) || {}), answerMs: 3000, revealMs: 1500, rounds: 2 };
      clients[0].start(p);
      let w = 0; while (clients[0].shared.sessionPhase !== "play" && w < 6000) { await sleep(150); w += 150; }
      clients.forEach((c) => c.answer(0)); // all pick option 0 (correct or not — we test sync, not score)
      let r = 0; while ((clients[0].shared.roundAnswer ?? -1) < 0 && r < 5000) { await sleep(150); r += 150; } // wait for reveal
      view = (c) => ({ ans: c.shared.roundAnswer, board: c.shared.raceBoard }); exact = false; // correctness hidden → convergence only
    } else {
      clients[0].start(3000); // single play window
      let waited = 0; while (clients[0].shared.sessionPhase !== "play" && waited < 5000) { await sleep(150); waited += 150; }
      if (sub === "tally") {
        for (let k = 0; k < ACT; k++) { clients.forEach((c) => c.tally(1)); await sleep(40); }
        view = (c) => c.shared.coopTotal ?? 0; expected = n * ACT;
      } else if (sub === "vote") {
        const opt = voteKeys(doc)[0] || "o0";
        clients.forEach((c) => c.vote(opt));
        view = (c) => (c.shared.votesByOption || {})[opt] ?? 0; expected = n;
      } else {
        for (let k = 0; k < ACT; k++) { clients.forEach((c) => c.tap()); await sleep(40); }
        view = (c) => c.shared.raceBoard || []; expected = n * ACT;
      }
    }
    const total = (v) => (sub === "tap" ? (v || []).reduce((s, e) => s + (e.score || 0), 0) : v);
    const { converged, desyncEvents } = await settle(clients, view, (v) => !exact || total(v) === expected);
    const tallyError = exact ? Math.abs(total(view(clients[0])) - expected) : 0;
    const phaseSynced = clients.every((c) => c.shared.sessionPhase === clients[0].shared.sessionPhase);
    const participantsAccurate = clients.every((c) => c.participants === n);
    clients.forEach((c) => c.close());
    await sleep(60);
    const ok = converged && desyncEvents === 0 && tallyError === 0 && participantsAccurate && phaseSynced;
    return { id, kind: `session:${sub}`, clients: n, ok, converged, desyncEvents, tallyError, participantsAccurate, phaseSynced };
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

async function main() {
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
        merged = merged ? { ...r, sweep: [...(merged.sweep || [merged.clients]), c], ok: merged.ok && r.ok } : { ...r, sweep: [c] };
      }
      results.push(merged);
    } catch (e) {
      results.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  // clean up this run's throwaway persisted vote files (best-effort)
  try {
    for (const f of readdirSync(VOTES_DIR)) {
      if (f.startsWith(SLUG_PREFIX) && f.endsWith(".json")) rmSync(join(VOTES_DIR, f), { force: true });
    }
  } catch { /* best-effort */ }

  runGate("multiclient-sim", results, (r) => r.ok,
    ({ failed, total }) => `multiclient-sim @ ${MESH ? "mqtt mesh" : WS_URL}: ${total - failed}/${total} synced${failed ? ` — ${failed} FAIL` : ""}`);
}

main();
