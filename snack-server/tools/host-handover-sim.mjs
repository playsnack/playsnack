// Host-mode hand-over gate (H3). Real relay, real room engines in the clients:
//   A. the host leaves mid-game      → next player resumes from the snapshot, scores kept
//   B. the host hands off (backgrounded) during the countdown → game runs to the result,
//      the old host keeps playing as a normal player
//   C. the host goes silent (connected, no heartbeat) → the relay's watchdog hands over
//   D. global stats: the host reports player points / activity, the server accepts them
//   E. (MP-06) 눈치 배틀: hidden votes, the host leaves before the reveal → every peer
//      reveals the SAME full tally and the same scores (the host's own vote included)
//   F. (MP-06) best-score board: the host leaves → the same leaderboard on every peer
// PRE: server running.   node snack-server/tools/host-handover-sim.mjs
import { WebSocket } from "ws";
import { runGate } from "./_gate.mjs";

process.env.SIM_RELAY = "1";
const { SimClient, sleep, WS_URL } = await import("./_wsclient.mjs");
const RUN = Date.now().toString(36);
const until = async (fn, ms, step = 100) => {
  for (let t = 0; t < ms; t += step) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const results = [];

// A — host leaves mid-game
{
  const slug = `handover-${RUN}-a`;
  const c = [0, 1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`));
  await Promise.all(c.map((x) => x.ready));
  c[1].start({ duration: 6000 });
  await until(() => c[1].shared.sessionPhase === "play", 6000);
  c[1].tap(); c[1].tap(); c[1].tap(); c[2].tap(); c[2].tap(); c[0].tap();
  await sleep(700); // let the host snapshot land at the relay
  c[0].close(); // host leaves
  await sleep(1200);
  c[1].tap(); // the new host (c1) keeps counting
  const done = await until(() => c[1].shared.sessionPhase === "result" && c[2].shared.sessionPhase === "result", 9000);
  const board = (x) => (x.shared.raceBoard || []).map((r) => r.score).sort((a, b) => b - a);
  const ok = done && same(board(c[1]), board(c[2])) && same(board(c[1]), [4, 2, 1]);
  results.push({ id: "A host leaves mid-game", ok, detail: { done, board1: board(c[1]), board2: board(c[2]) } });
  c.forEach((x) => x.close());
}

// B — host hands off (went to the background) during the countdown
{
  const slug = `handover-${RUN}-b`;
  const c = [0, 1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`));
  await Promise.all(c.map((x) => x.ready));
  c[2].start({ duration: 3000 });
  await until(() => c[0].shared.sessionPhase === "countdown", 4000);
  await sleep(400);
  c[0].relay.handoff();
  await sleep(800);
  // Whoever joined right after the old host takes over (join order is racy here).
  const newHost = c[1].relay.isHost !== c[2].relay.isHost;
  const demoted = !c[0].relay.isHost;
  c[0].tap(); // the old host still plays (as a peer now)
  const done = await until(() => c.every((x) => x.shared.sessionPhase === "result"), 9000);
  const ok = newHost && demoted && done && c.every((x) => same(x.shared.raceBoard, c[1].shared.raceBoard));
  results.push({ id: "B hand-off during countdown", ok, detail: { newHost, demoted, done, phases: c.map((x) => x.shared.sessionPhase) } });
  c.forEach((x) => x.close());
}

// C — host stays connected but goes silent → watchdog hand-over
{
  const slug = `handover-${RUN}-c`;
  const silent = new WebSocket(WS_URL);
  await new Promise((r) => silent.on("open", r));
  silent.send(JSON.stringify({ t: "hello", d: { slug, anonId: `${slug}-silent`, nick: "" } }));
  await sleep(200);
  const c = [1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`));
  const joined = await until(() => c.every((x) => x.participants > 0), 6000); // states arrive once someone hosts
  c[0].start({ duration: 3000 });
  const done = await until(() => c.every((x) => x.shared.sessionPhase === "result"), 9000);
  const ok = joined && done && (c[0].relay.isHost || c[1].relay.isHost);
  results.push({ id: "C silent host → watchdog", ok, detail: { joined, done } });
  c.forEach((x) => x.close());
  silent.close();
}

// D — global stats from a host-run room. The host's batches go to a capture
// endpoint (so test players never land on the real leaderboard); the server's
// /api/events is then checked with a nick-less event (nick-less users are not ranked).
{
  const { createServer } = await import("node:http");
  const got = [];
  const capture = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      try { got.push(JSON.parse(body)); } catch { /* ignore */ }
      res.end("{}");
    });
  });
  await new Promise((r) => capture.listen(0, r));
  process.env.SIM_EVENTS_URL = `http://localhost:${capture.address().port}/events`;
  const slug = `handover-${RUN}-d`;
  const c = [new SimClient(slug, `${slug}-c0`, "A"), new SimClient(slug, `${slug}-c1`, "B")];
  await Promise.all(c.map((x) => x.ready));
  c[1].vote("o0"); // peer action → host engine → +1 for c1
  c[0].score(42); // host's own action → +2 (record)
  await sleep(2600); // host flushes every 2s
  const events = got.flatMap((b) => b.events ?? []);
  const pts = (id) => events.filter((e) => e.k === "pts" && e.anonId === id).reduce((n, e) => n + e.pts, 0);
  const sent = pts(`${slug}-c0`) === 2 && pts(`${slug}-c1`) === 1 && events.some((e) => e.k === "act" && e.kind === "vote");
  const r = await fetch(`http://localhost:${process.env.PORT || 4399}/api/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, events: [{ k: "pts", anonId: `${slug}-probe`, nick: "", pts: 9 }, { k: "act", kind: "nope", label: "x" }] }),
  }).then((x) => x.json());
  const ok = sent && r.applied === 1; // pts accepted (clamped), unknown kind rejected
  results.push({ id: "D host-run stats are reported", ok, detail: { sent, events: events.length, applied: r.applied } });
  c.forEach((x) => x.close());
  capture.close();
}

// E — 눈치 배틀 (hidden votes): the host leaves after everyone voted, before the reveal.
// Every peer must reveal the full tally — the old host's vote and the votes it acked
// after its last broadcast included — and the same board (MP-06).
{
  const slug = `handover-${RUN}-e`;
  const c = [0, 1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`, `E${i}`));
  await Promise.all(c.map((x) => x.ready));
  c[1].start({ game: "majority", mode: "guess", rounds: 1, roundMs: 5000, revealMs: 1500 });
  await until(() => c.every((x) => x.shared.sessionPhase === "play"), 6000);
  c[0].vote("o1"); c[1].vote("o1"); c[2].vote("o0"); // nothing is broadcast until the reveal
  await sleep(700);
  c[0].close(); // the host leaves mid-round
  const done = await until(() => c[1].shared.sessionPhase === "result" && c[2].shared.sessionPhase === "result", 12000);
  const votes = (x) => [(x.shared.votesByOption || {}).o0 ?? 0, (x.shared.votesByOption || {}).o1 ?? 0];
  const board = (x) => (x.shared.raceBoard || []).map((e) => [e.nick, e.score]);
  const ok = done && same(votes(c[1]), [1, 2]) && same(votes(c[2]), [1, 2]) && same(board(c[1]), board(c[2])) && same(board(c[1]), [["E0 (나감)", 100], ["E1", 100]]) && c[1].shared.roundAnswer === 1 && c[2].shared.roundAnswer === 1;
  results.push({ id: "E hidden votes survive the host leaving", ok, detail: { done, votes1: votes(c[1]), votes2: votes(c[2]), board1: board(c[1]), board2: board(c[2]) } });
  c.forEach((x) => x.close());
}

// F — best-score leaderboard: the host leaves, a peer scores again → same board everywhere.
{
  const slug = `handover-${RUN}-f`;
  const c = [0, 1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`, `F${i}`));
  await Promise.all(c.map((x) => x.ready));
  c[0].score(10); c[1].score(30); c[2].score(50);
  await until(() => c.every((x) => same(x.shared.leaderboard, [50, 30, 10])), 4000);
  c[0].close(); // host leaves
  await sleep(1200);
  c[1].score(40); // the new host (c1) keeps the old scores and takes new ones
  const done = await until(() => same(c[1].shared.leaderboard, [50, 40, 10]) && same(c[2].shared.leaderboard, [50, 40, 10]), 6000);
  results.push({ id: "F best-score board survives the host leaving", ok: done, detail: { board1: c[1].shared.leaderboard, board2: c[2].shared.leaderboard } });
  c.forEach((x) => x.close());
}

for (const r of results) console.error(`${r.ok ? "✅" : "❌"} ${r.id}  ${JSON.stringify(r.detail)}`);
runGate("host-handover", results, (r) => r.ok);
