// Integration gate runner (SC-007). Runs every quality gate and reports a
// combined pass/fail. Exits non-zero if ANY runnable gate fails.
//   node snack-server/tools/gate-all.mjs            (content offline; oracle/sim if server up)
//   node snack-server/tools/gate-all.mjs --battery  (also run gen-battery; needs OpenAI)
// "되는 척" 금지: this is the single command that proves release quality (헌법 I).
// Serverless steps (local lossy broker, never a public one) always run; server-mode
// steps run only when a snack-server answers at SNACK_BASE.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isLocalBroker } from "../../packages/snack-room/tools/localBroker.js";

const BASE = process.env.SNACK_BASE || `http://localhost:${process.env.PORT || 4399}`;
const wantBattery = process.argv.includes("--battery");
process.env.SNACK_BASE = BASE; // child gates (e2e-audit) read SNACK_BASE, not PORT

async function serverUp() {
  try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

// The last JSON object a gate printed to stdout (the runGate envelope), or null.
function lastJson(stdout) {
  const s = stdout.trimEnd();
  const i = s.lastIndexOf("\n{");
  try { return JSON.parse(i === -1 ? s : s.slice(i + 1)); } catch { return null; }
}

// opts.env: extra environment (set explicitly — never rely on what the shell inherited).
// opts.lossy: the step was asked for a lossy broker; the gate must PROVE drops happened
//   via `{lossy, dropped, delivered}` (top level, or on a result item). Missing → warn only.
function run(name, cmd, args, opts = {}) {
  process.stdout.write(`\n▶ ${name}: ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, ...(opts.env || {}) } });
  const out = (r.stdout || "") + (r.stderr || "");
  // surface the gate's summary line
  const j = lastJson(r.stdout || "");
  let summary = j?.summary || "";
  if (!summary) {
    const t = /ℹ pass (\d+)[\s\S]*ℹ fail (\d+)/.exec(out); // node --test
    summary = t ? `${t[1]} pass, ${t[2]} fail` : out.trim().split("\n").slice(-2).join(" ");
  }
  let ok = r.status === 0;
  if (opts.lossy) {
    const info = j && (j.lossy !== undefined ? j : (j.results || []).find((x) => x && x.lossy !== undefined));
    if (!info) console.log(`  ⚠  ${name} did not report {lossy, dropped, delivered} — drops not verified`);
    else if (info.lossy !== true || !(info.dropped > 0)) { ok = false; summary += ` — lossy NOT proven (lossy=${info.lossy}, dropped=${info.dropped}, delivered=${info.delivered})`; }
    else summary += ` [lossy: ${info.dropped} dropped / ${info.delivered} delivered]`;
  }
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${summary}`);
  return { name, ok, status: r.status, summary };
}

// No gate may talk to a public broker: broker overrides in the environment must be
// local, and no gate tool may name a public broker host.
function noPublicBroker() {
  process.stdout.write(`\n▶ no-public-broker\n`);
  const bad = [];
  for (const k of ["SIM_BROKER", "VITE_BROKER_URL"]) if (process.env[k] && !isLocalBroker(process.env[k])) bad.push(`${k}=${process.env[k]}`);
  const dir = new URL(".", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".mjs") || f === "gate-all.mjs") continue;
    if (/broker\.(hivemq|emqx)|mosquitto\.org/.test(readFileSync(new URL(f, dir), "utf8"))) bad.push(`tools/${f} names a public broker`);
  }
  const ok = bad.length === 0;
  const summary = ok ? "sims + oracle use a local broker only" : bad.join("; ");
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${summary}`);
  return { name: "no-public-broker", ok, summary };
}

const up = await serverUp();
const results = [];

// B — content quality (offline, always)
results.push(run("content-quality", "node", ["snack-server/tools/content-quality.mjs"]));
// Design tokens SSOT drift guard (offline, always): tokens.gen.ts must match tokens.mjs
results.push(run("tokens-ssot", "node", ["snack-server/tools/check-tokens.mjs"]));
// Seed pools (offline, always): a present-but-broken songs/idols/singers seed would
// ship a dead/wrong worldcup (gender, 신인, schema) — fail before it does (SC-002/SC-004).
results.push(run("seed-pools", "node", ["snack-server/tools/validate-pools.mjs"]));
// Release consistency (offline, always): every template color must be on the token
// roster (∪ documented allowlist) — catches design-token drift across the 44 apps.
results.push(run("consistency", "node", ["snack-server/tools/check-consistency.mjs"]));
// Layout + liveness (offline, always): every template validates, plays headless
// (each tappable once) and lays out cleanly in every phase reached.
results.push(run("verify-layout", "node", ["snack-server/tools/verify-layout.mjs"]));
// Engine unit tests (offline, always): runtime + layout engine + room.
results.push(run("engine-tests", "pnpm", ["-s", "bite:test"]));
// Player shell (links, room codes, nicknames) and server (room ids) unit tests (offline, always).
results.push(run("player-tests", "pnpm", ["-s", "player:test"]));
results.push(run("server-tests", "pnpm", ["-s", "server:test"]));
// /api/ev telemetry function (offline, always): schema, limits, privacy, client.
results.push(run("api-tests", "node", ["--test", "api/_test/"]));
// Link previews (offline, always): every catalog app has its 1200×630 og image, index.html meta current (#106).
results.push(run("og-images", "node", ["scripts/og-images.mjs", "--check"]));
// "되는 척" 문구 검사 (offline, always): Q0 merge criterion = 0 hits (master-plan §4).
results.push(run("honesty", "node", ["snack-server/tools/check-honesty.mjs"]));

// Serverless (the deployed mode) — always: the sync sim and two real browsers, both on a
// LOCAL broker in lossy mode (~5% drop, 50–300 ms jitter → reordering).
results.push(noPublicBroker());
// Lossy is set EXPLICITLY here (an inherited SIM_LOSSY=0 / ORACLE_DROP=0 must not
// silently switch it off), and each step must prove drops happened (opts.lossy).
const lossyEnv = { SIM_LOSSY: "1", ORACLE_DROP: "", ORACLE_MAX_DELAY: "" };
results.push(run("serverless-sim", "node", ["snack-server/tools/multiclient-sim.mjs"], { env: { ...lossyEnv, SIM_MESH: "1" }, lossy: true }));
results.push(run("serverless-oracle", "node", ["snack-server/tools/serverless-oracle.mjs"], { env: lossyEnv, lossy: true }));
// Saved room results (docs/room-results.md): a 1:1 quiz → both leave → a third browser sees the ranking.
results.push(run("room-result-e2e", "node", ["snack-server/tools/room-result-e2e.mjs"]));
// A slow broker (no CONNACK for the first tries — live 2026-10-14): two browsers still meet,
// "연결이 느려요" after ~6 s, the failed sheet only at the deadline, 다시 시도 joins (~1.5 min).
results.push(run("slow-broker-e2e", "node", ["snack-server/tools/slow-broker-e2e.mjs"]));

if (up) {
  console.log(`\nℹ  server mode at ${BASE}: the player is rebuilt below — if the oracle answers "Cannot GET", (re)start snack-server AFTER this build (it only serves a dist that existed when it started).`);
  // The oracle plays the PROD build the server serves — rebuild it first so a
  // stale bundle (older engine than the templates) can never fake a result.
  // Server mode, same origin: the player the server serves talks to that server.
  results.push(run("player-build", "env", ["VITE_SERVER_URL=same-origin", "pnpm", "-s", "player:build"]));
  // A — interaction oracle (needs server + prod build)
  results.push(run("oracle", "node", ["snack-server/tools/e2e-audit.mjs"]));
  // E — multiplayer sync
  results.push(run("multiclient-sim", "node", ["snack-server/tools/multiclient-sim.mjs"]));
  // E′ — same sync checks in host mode (a client runs the room, the server only relays)
  results.push(run("multiclient-sim-host", "env", ["SIM_RELAY=1", "node", "snack-server/tools/multiclient-sim.mjs"]));
  // H3 — host leaves / hands off / goes silent → the room continues from its snapshot
  results.push(run("host-handover", "node", ["snack-server/tools/host-handover-sim.mjs"]));
  // F — generation battery (optional; OpenAI)
  if (wantBattery) results.push(run("gen-battery", "node", ["snack-server/tools/gen-battery.mjs"]));
  else console.log("\n⏭  gen-battery skipped (pass --battery + OpenAI key to run)");
} else {
  console.log(`\n⏭  server-mode steps skipped (no snack-server at ${BASE}): oracle, multiclient-sim (+host), host-handover.`);
  console.log(`   To run them: VITE_SERVER_URL=same-origin pnpm player:build, THEN start snack-server (PORT=… pnpm server:dev) and re-run with SNACK_BASE/PORT.`);
  console.log(`   Order matters: a server started before the build serves no player (oracle → 0/44 "Cannot GET").`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n━━━ GATES: ${results.length - failed.length}/${results.length} pass${failed.length ? ` — FAIL: ${failed.map((f) => f.name).join(", ")}` : " — ALL PASS"} ━━━`);
process.exit(failed.length ? 1 : 0);
