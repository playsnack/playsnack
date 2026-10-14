// Host-mode hand-over gate (H3). Real relay, real room engines in the clients:
//   A. the host leaves mid-game      → next player resumes from the snapshot, scores kept
//   B. the host hands off (backgrounded) during the countdown → game runs to the result,
//      the old host keeps playing as a normal player
//   C. the host goes silent (connected, no heartbeat) → the relay's watchdog hands over
//   D. global stats: the host reports player points / activity, the server accepts them
//   E. (MP-06) 눈치 배틀: hidden votes, the host leaves before the reveal → every peer
//      reveals the SAME full tally and the same scores (the host's own vote included)
//   F. (MP-06) best-score board: the host leaves → the same leaderboard on every peer
//   G. 나 맞히기 퀴즈: the host leaves mid-quiz → same pack, subject, recap and device-ms
//      scores on every peer; the pack is still there for the next game
// PRE: server running.   node snack-server/tools/host-handover-sim.mjs
// SIM_EDGE=1 → the same scenarios serverless over the edge room relay (no snack-server):
// a local Node hub (edge/room core.js), or SIM_EDGE_URL=ws://127.0.0.1:4551 (wrangler dev).
// The mesh has no relay-chosen host, so the first client joins alone first (it founds the
// room and hosts); C's silent host is a socket that announced itself and then stopped
// beating; D checks what the host engine reported (there is no /api/events to post to).
import { WebSocket } from "ws";
import { runGate } from "./_gate.mjs";

const EDGE_MODE = Boolean(process.env.SIM_EDGE);
if (!EDGE_MODE) process.env.SIM_RELAY = "1";
const { SimClient, sleep, WS_URL, prepareMesh, stopMesh, engineEvents } = await import("./_wsclient.mjs");
await prepareMesh();
// Clients for one room. Edge mode: the first one joins alone (so it is the host), then the rest.
async function joinRoom(slug, n, nick) {
  const mk = (i) => new SimClient(slug, `${slug}-c${i}`, nick ? `${nick}${i}` : undefined);
  if (!EDGE_MODE) {
    const c = Array.from({ length: n }, (_, i) => mk(i));
    await Promise.all(c.map((x) => x.ready));
    return c;
  }
  const first = mk(0);
  await first.ready;
  const c = [first, ...Array.from({ length: n - 1 }, (_, i) => mk(i + 1))];
  await Promise.all(c.map((x) => x.ready));
  await until(() => c.every((x) => x.participants === n), 6000);
  return c;
}
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
  const c = await joinRoom(slug, 3);
  const hostLeft = c[0].relay.isHost;
  c[1].start({ duration: 6000 });
  await until(() => c[1].shared.sessionPhase === "play", 6000);
  c[1].tap(); c[1].tap(); c[1].tap(); c[2].tap(); c[2].tap(); c[0].tap();
  await sleep(700); // let the host snapshot land at the relay
  c[0].close(); // host leaves
  await sleep(1200);
  c[1].tap(); // the new host (c1) keeps counting
  const done = await until(() => c[1].shared.sessionPhase === "result" && c[2].shared.sessionPhase === "result", 9000);
  const board = (x) => (x.shared.raceBoard || []).map((r) => r.score).sort((a, b) => b - a);
  const ok = done && (hostLeft || !EDGE_MODE) && same(board(c[1]), board(c[2])) && same(board(c[1]), [4, 2, 1]);
  results.push({ id: "A host leaves mid-game", ok, detail: { done, hostLeft, board1: board(c[1]), board2: board(c[2]) } });
  c.forEach((x) => x.close());
}

// B — host hands off (went to the background) during the countdown
{
  const slug = `handover-${RUN}-b`;
  const c = await joinRoom(slug, 3);
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
if (EDGE_MODE) {
  // A peer announces itself as the host, then stays connected without another heartbeat
  // (a frozen tab): the others adopt it, notice the silence and take over.
  const slug = `handover-${RUN}-c`;
  const silent = new WebSocket(`${process.env.SIM_EDGE_URL}/relay/${encodeURIComponent(slug)}`);
  await new Promise((r) => silent.on("open", r));
  const sid = "silent0000000000";
  silent.send(JSON.stringify({ t: "auth", peer: sid }));
  const here = () => silent.send(JSON.stringify({ from: sid, t: "here", anonId: `${slug}-silent`, nick: "", ack: 1, line: [sid], term: 1 }));
  await sleep(200);
  const beats = setInterval(here, 300);
  const c = [1, 2].map((i) => new SimClient(slug, `${slug}-c${i}`));
  await sleep(1500); // they hear the "host"…
  clearInterval(beats); // …which then goes silent, connected
  const joined = await until(() => c.every((x) => x.participants > 0), 9000);
  c[0].start({ duration: 3000 });
  const done = await until(() => c.every((x) => x.shared.sessionPhase === "result"), 9000);
  const ok = joined && done && (c[0].relay.isHost || c[1].relay.isHost);
  results.push({ id: "C silent host → watchdog", ok, detail: { joined, done, silentStillOpen: silent.readyState === 1 } });
  c.forEach((x) => x.close());
  silent.close();
} else {
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
if (EDGE_MODE) {
  const slug = `handover-${RUN}-d`;
  const c = await joinRoom(slug, 2);
  engineEvents.length = 0;
  c[1].vote("o0"); // peer action → host engine → +1 for c1
  c[0].score(42); // host's own action → +2 (record)
  await until(() => engineEvents.filter((e) => e.k === "pts").length >= 2, 4000);
  const pts = (id) => engineEvents.filter((e) => e.k === "pts" && e.anonId === id).reduce((n, e) => n + e.pts, 0);
  const ok = c[0].relay.isHost && pts(`${slug}-c0`) === 2 && pts(`${slug}-c1`) === 1 && engineEvents.some((e) => e.k === "act" && e.kind === "vote");
  results.push({ id: "D host-run stats are reported", ok, detail: { events: engineEvents.length, pts0: pts(`${slug}-c0`), pts1: pts(`${slug}-c1`), note: "edge: engine hooks checked (no snack-server /api/events here)" } });
  c.forEach((x) => x.close());
} else {
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
  const c = await joinRoom(slug, 3, "E");
  c[1].start({ game: "majority", mode: "guess", rounds: 1, roundMs: 5000, revealMs: 1500 });
  await until(() => c.every((x) => x.shared.sessionPhase === "play"), 6000);
  c[0].vote("o1"); c[1].vote("o1"); c[2].vote("o0"); // nothing is broadcast until the reveal
  await sleep(700);
  const hosted = c.findIndex((x) => x.relay.isHost); // who ran the room before the leave
  c[0].close(); // the host leaves mid-round
  const done = await until(() => c[1].shared.sessionPhase === "result" && c[2].shared.sessionPhase === "result", 12000);
  const votes = (x) => [(x.shared.votesByOption || {}).o0 ?? 0, (x.shared.votesByOption || {}).o1 ?? 0];
  const board = (x) => (x.shared.raceBoard || []).map((e) => [e.nick, e.score]);
  const ok = done && same(votes(c[1]), [1, 2]) && same(votes(c[2]), [1, 2]) && same(board(c[1]), board(c[2])) && same(board(c[1]), [["E0 (나감)", 100], ["E1", 100]]) /* MP-11 tie order: by nickname, then join order */ && c[1].shared.roundAnswer === 1 && c[2].shared.roundAnswer === 1;
  results.push({ id: "E hidden votes survive the host leaving", ok, detail: { hosted, done, votes1: votes(c[1]), votes2: votes(c[2]), board1: board(c[1]), board2: board(c[2]) } });
  c.forEach((x) => x.close());
}

// F — best-score leaderboard: the host leaves, a peer scores again → same board everywhere.
{
  const slug = `handover-${RUN}-f`;
  const c = await joinRoom(slug, 3, "F");
  c[0].score(10); c[1].score(30); c[2].score(50);
  await until(() => c.every((x) => same(x.shared.leaderboard, [50, 30, 10])), 4000);
  await sleep(700); // let the host snapshot (200 ms debounce) land at the relay — as in A
  c[0].close(); // host leaves
  await sleep(1200);
  c[1].score(40); // the new host (c1) keeps the old scores and takes new ones
  const done = await until(() => same(c[1].shared.leaderboard, [50, 40, 10]) && same(c[2].shared.leaderboard, [50, 40, 10]), 6000);
  results.push({ id: "F best-score board survives the host leaving", ok: done, detail: { board1: c[1].shared.leaderboard, board2: c[2].shared.leaderboard } });
  c.forEach((x) => x.close());
}

// G — 나 맞히기 퀴즈: G1 stored its own pack (the subject); the host (G0, an answerer) leaves
// mid-quiz after answering. Every peer must end with the same pack, subject, recap and
// board — scores from each device's ms, the old host's answer included — and the pack must
// still be there for the next game on the new host.
{
  const slug = `handover-${RUN}-g`;
  const c = await joinRoom(slug, 4, "G");
  const ANSWER_MS = 5000;
  const pack = {
    title: "G1 맞히기",
    questions: [
      { q: "G1이 좋아하는 계절은?", options: ["봄", "여름", "가을", "겨울"], answer: 3 },
      { q: "G1의 최애 음식은?", options: ["피자", "치킨", "떡볶이"], answer: 1 },
    ],
    settings: { answerMs: ANSWER_MS },
  };
  c[1].quizPack(pack);
  const packed = await until(() => c.every((x) => x.shared.quizInfo?.custom === true && x.shared.quizInfo?.about === "G1"), 6000);
  c[1].start({ game: "trivia", quiz: true, rounds: 6, answerMs: 9000, revealMs: 1500 });
  const playing = await until(() => c.every((x) => x.shared.sessionPhase === "play" && x.shared.roundContent?.q === pack.questions[0].q), 8000);
  const right = (x) => (x.shared.roundContent?.options ?? []).indexOf("겨울");
  await sleep(700);
  c[0].answer(right(c[0]), 300); // the host answers on its own engine
  c[2].answer(right(c[2]), 600);
  c[1].answer(right(c[1]), 10); // the subject: ignored
  await sleep(700); // let the host snapshot land at the relay
  c[0].close(); // host leaves mid-round
  await sleep(1200);
  c[3].answer(right(c[3]), 900); // answered on the new host
  const rest = c.slice(1);
  const done = await until(() => rest.every((x) => x.shared.sessionPhase === "result"), 20000);
  await sleep(1000); // the last resync beats
  const pts = (ms) => Math.max(100, 1000 - Math.round((ms / ANSWER_MS) * 800));
  const board = (x) => (x.shared.raceBoard || []).map((e) => [e.nick, e.score]);
  const recap = (x) => x.shared.quizRecap;
  const picks0 = (x) => (recap(x)?.rounds?.[0]?.picks || []).map((p) => [p.nick, p.ms, p.correct]).sort();
  const wantBoard = [["G0 (나감)", pts(300)], ["G2", pts(600)], ["G3", pts(900)]];
  const same3 = (f) => rest.every((x) => same(f(x), f(c[1])));
  const ok1 = packed && playing && done && same3(board) && same3(recap) && same3((x) => x.shared.quizInfo) && same(board(c[1]), wantBoard) && recap(c[1])?.subject === "G1" && same(picks0(c[1]), [["G0", 300, true], ["G2", 600, true], ["G3", 900, true]]) && recap(c[1])?.rounds?.length === 2;
  const detail = { packed, playing, done, board1: board(c[1]), board2: board(c[2]), board3: board(c[3]), subject: recap(c[1])?.subject, picks: picks0(c[1]) };
  // the stored pack survived the hand-over: the next game on the new host plays it again
  c[1].start({ game: "trivia", quiz: true, rounds: 6, answerMs: 9000, revealMs: 1500 }); // the subject starts again
  const again = await until(() => rest.every((x) => x.shared.sessionPhase === "play" && x.shared.roundContent?.q === pack.questions[0].q && x.shared.quizInfo?.about === "G1"), 8000);
  results.push({ id: "G quiz: custom pack + device-ms scores survive the host leaving", ok: ok1 && again, detail: { ...detail, again } });
  c.forEach((x) => x.close());
}

for (const r of results) console.error(`${r.ok ? "✅" : "❌"} ${r.id}  ${JSON.stringify(r.detail)}`);
await stopMesh();
runGate("host-handover", results, (r) => r.ok, ({ passed, total, ok }) => `host-handover${EDGE_MODE ? ` (edge relay @ ${process.env.SIM_EDGE_URL})` : ""}: ${passed}/${total} pass${ok ? "" : " — FAIL"}`);
