// Park-event crowd sim (docs/edge-rooms.md §scale): an organizer opens a server-authoritative
// edge room, N strangers join at once, the organizer runs a 10-question quiz, everyone
// answers, #1 wins. Measures messages in/out, fan-out spread at every question / reveal,
// the room's handling time per message and per fan-out (local hub only — workerd freezes
// timers inside a request), and checks every phone ends with the same board.
//   node snack-server/tools/edge-crowd-sim.mjs [--clients 50,100,200] [--questions 10]
//   SIM_EDGE_URL=ws://127.0.0.1:4551 …   → the real Worker under `wrangler dev --local`
//   --hub-proc   run the hub in its OWN process (clean CPU numbers: no client work in it)
// Local only (ports 4550–4555): a public relay URL is refused.
import { startEdgeHub, isLocalRelay } from "../../packages/snack-room/tools/edgeHub.js";
import { emit } from "./_gate.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const SIZES = arg("--clients", "50,100,200").split(",").map(Number);
const QUESTIONS = Number(arg("--questions", 10));
const ANSWER_MS = 8000;
const REVEAL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 20) => {
  for (let t = 0; t < ms; t += step) {
    if (fn()) return true;
    await sleep(step);
  }
  return Boolean(fn());
};

let hub = null;
let hubProc = null;
let BASE = process.env.SIM_EDGE_URL;
if (BASE && !isLocalRelay(BASE)) throw new Error(`SIM_EDGE_URL must be local, not ${BASE}`);
if (!BASE && process.argv.includes("--hub-proc")) {
  const { spawn } = await import("node:child_process");
  const port = Number(process.env.SIM_EDGE_PORT || 4550);
  const src = `import("${new URL("../../packages/snack-room/tools/edgeHub.js", import.meta.url).href}").then(m => m.startEdgeHub({ port: ${port}, limits: { maxSockets: 400 } })).then(() => console.log("ready"))`;
  hubProc = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => hubProc.stdout.once("data", r));
  BASE = `ws://127.0.0.1:${port}`;
} else if (!BASE) {
  hub = await startEdgeHub({ port: Number(process.env.SIM_EDGE_PORT || 4550), limits: { maxSockets: 400 } });
  BASE = hub.url;
}

function client(room, anonId, counters, hello = {}) {
  const ws = new WebSocket(`${BASE}/room/${room}`);
  const c = { anonId, vars: {}, frames: 0, firstAt: {}, closed: null };
  ws.onmessage = (ev) => {
    const at = performance.now();
    counters.recv += 1;
    counters.recvBytes += ev.data.length;
    c.frames += 1;
    const m = JSON.parse(ev.data);
    if (m.t === "state") Object.assign(c.vars, m.d.sharedState, { participants: m.d.participants });
    else if (m.t === "participants") c.vars.participants = m.d.count;
    else if (m.t === "organizer") c.organizer = m.d.token;
    else if (m.t === "setVar") {
      c.vars[m.d.id] = m.d.value;
      // first time this phone saw question i / reveal i
      if (m.d.id === "roundContent" && m.d.value?.q) c.firstAt[`q:${m.d.value.q}`] ??= at;
      if (m.d.id === "roundAnswer" && m.d.value >= 0) c.firstAt[`a:${c.vars.roundIdx}`] ??= at;
    }
  };
  ws.onclose = (ev) => (c.closed = ev.code);
  const opened = new Promise((r) => (ws.onopen = r));
  let n = 0;
  c.send = async (m) => {
    await opened;
    counters.sent += 1;
    ws.send(JSON.stringify(m));
  };
  c.hello = () => c.send({ t: "hello", d: { slug: room, anonId, nick: anonId, ...hello } });
  c.act = (name, payload) => c.send({ t: "action", d: { name, payload, clientMsgId: `${anonId}-${++n}` } });
  c.close = () => ws.close();
  return c;
}

const spread = (clients, key) => {
  const ts = clients.map((c) => c.firstAt[key]).filter((x) => x !== undefined);
  return ts.length === clients.length ? Math.round(Math.max(...ts) - Math.min(...ts)) : null;
};

async function run(N) {
  const room = `crowd-${Date.now().toString(36)}-${N}`;
  const counters = { sent: 0, recv: 0, recvBytes: 0 };
  const org = client(room, "organizer", counters, { organize: true });
  await org.hello();
  await until(() => org.organizer, 5000);
  // Everyone scans the QR at once.
  const t0 = performance.now();
  const players = Array.from({ length: N }, (_, i) => client(room, `p${i}`, counters));
  await Promise.all(players.map((p) => p.hello()));
  const all = [org, ...players];
  const joined = await until(() => all.every((c) => c.vars.participants === N + 1), 30000);
  const joinMs = Math.round(performance.now() - t0);
  const lobbyStart = { ...counters };
  await sleep(10000); // idle lobby: what does waiting cost?
  const lobby = { sent: counters.sent - lobbyStart.sent, recv: counters.recv - lobbyStart.recv };

  const questions = Array.from({ length: QUESTIONS }, (_, i) => ({ q: `문제 ${i + 1}: ${i} 더하기 1은?`, options: [`${i}`, `${i + 1}`, `${i + 2}`, `${i + 3}`], answer: 1 }));
  await org.act("quizPack", { title: "공원 퀴즈", questions, settings: { answerMs: ANSWER_MS } });
  await until(() => all.every((c) => c.vars.quizInfo?.custom), 10000);
  const g0 = { ...counters, at: performance.now() };
  const statsUrl = `${BASE.replace(/^ws/, "http")}/_stats?room=${room}`;
  const serverStats = async (reset) => (hub || hubProc ? fetch(statsUrl + (reset ? "&reset=1" : "")).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null);
  await serverStats(true);
  await org.act("start", { game: "trivia", quiz: true, answerMs: ANSWER_MS, revealMs: REVEAL_MS });
  const rounds = [];
  for (let i = 0; i < QUESTIONS; i++) {
    const q = questions[i].q;
    const shown = await until(() => players.every((p) => p.vars.roundContent?.q === q), 15000);
    // Each phone answers 0.3–3 s after its question appeared, claiming that time honestly.
    await Promise.all(
      players.map(async (p, k) => {
        const wait = 300 + ((k * 997 + i * 131) % 2700);
        await sleep(Math.max(0, p.firstAt[`q:${q}`] + wait - performance.now()));
        const right = p.vars.roundContent.options.indexOf(`${i + 1}`);
        const pick = k % 4 === 0 ? (right + 1) % 4 : right; // a quarter get it wrong
        await p.act("answer", { option: pick, ms: wait, round: i });
      }),
    );
    const revealed = await until(() => all.every((c) => c.firstAt[`a:${i}`] !== undefined), 15000);
    rounds.push({ i, shown, revealed, questionSpreadMs: spread(all, `q:${q}`), revealSpreadMs: spread(all, `a:${i}`) });
  }
  const done = await until(() => all.every((c) => c.vars.sessionPhase === "result" && c.vars.quizRecap?.rounds?.length === QUESTIONS), 20000);
  const gameSec = (performance.now() - g0.at) / 1000;
  const board = JSON.stringify(org.vars.raceBoard);
  const sameBoard = all.every((c) => JSON.stringify(c.vars.raceBoard) === board);
  const winner = org.vars.raceBoard?.[0];
  const sent = counters.sent - g0.sent;
  const recv = counters.recv - g0.recv;
  const got = await serverStats(false);
  const st = got?.stats;
  const pct = (a, p) => {
    if (!a?.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3);
  };
  const server = st
    ? {
        handled: st.handled,
        handleAvgMs: +(st.handleMs / Math.max(1, st.handled)).toFixed(3),
        handleP50Ms: pct(got.samples?.handle, 50),
        handleP99Ms: pct(got.samples?.handle, 99),
        handleMaxMs: +st.handleMaxMs.toFixed(2),
        handleMaxWhat: st.handleMaxWhat,
        fanouts: st.broadcasts,
        fanoutAvgMs: +(st.fanoutMs / Math.max(1, st.broadcasts)).toFixed(3),
        fanoutMaxMs: +st.fanoutMaxMs.toFixed(2),
        fanoutMaxBytes: st.fanoutMaxBytes,
        fanoutMaxTo: st.fanoutMaxTo,
        sendChunks: st.chunks,
        sendChunkAvgMs: +(st.chunkMs / Math.max(1, st.chunks)).toFixed(3),
        sendChunkP50Ms: pct(got.samples?.chunk, 50),
        sendChunkP99Ms: pct(got.samples?.chunk, 99),
        sendChunkMaxMs: +st.chunkMaxMs.toFixed(2),
        snapWrites: st.snapWrites ?? 0,
      }
    : null;
  all.forEach((c) => c.close());
  await sleep(300);
  const sp = (k) => rounds.map((r) => r[k]).filter((x) => x !== null);
  const ok = joined && rounds.every((r) => r.shown && r.revealed) && done && sameBoard;
  return {
    clients: N,
    ok,
    joinMs,
    lobby10s: lobby,
    game: { seconds: +gameSec.toFixed(1), in: sent, out: recv, inPerSec: +(sent / gameSec).toFixed(1), outPerSec: +(recv / gameSec).toFixed(1), outMB: +(counters.recvBytes / 1e6).toFixed(2), inPerPlayer: +(sent / N).toFixed(1) },
    questionSpreadMs: { max: Math.max(...sp("questionSpreadMs")), avg: Math.round(sp("questionSpreadMs").reduce((a, b) => a + b, 0) / Math.max(1, sp("questionSpreadMs").length)) },
    revealSpreadMs: { max: Math.max(...sp("revealSpreadMs")), avg: Math.round(sp("revealSpreadMs").reduce((a, b) => a + b, 0) / Math.max(1, sp("revealSpreadMs").length)) },
    sameBoard,
    winner,
    ...(server ? { server } : {}),
  };
}

const results = [];
for (const N of SIZES) {
  try {
    results.push(await run(N));
  } catch (e) {
    results.push({ clients: N, ok: false, error: String(e?.stack ?? e) });
  }
  console.error(JSON.stringify(results.at(-1)));
}
await hub?.close();
hubProc?.kill();
const passed = results.filter((r) => r.ok).length;
const where = hub ? "node hub (same process)" : hubProc ? "node hub (own process)" : BASE;
emit({ gate: "edge-crowd-sim", ok: passed === results.length, where, results, summary: `edge-crowd-sim @ ${where}: ${passed}/${results.length} crowds ok` });
process.exitCode = passed === results.length ? 0 : 1;
