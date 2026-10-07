// Integration gate runner (SC-007). Runs every quality gate and reports a
// combined pass/fail. Exits non-zero if ANY runnable gate fails.
//   node snack-server/tools/gate-all.mjs            (content offline; oracle/sim if server up)
//   node snack-server/tools/gate-all.mjs --battery  (also run gen-battery; needs OpenAI)
// "되는 척" 금지: this is the single command that proves release quality (헌법 I).
import { spawnSync } from "node:child_process";

const BASE = process.env.SNACK_BASE || `http://localhost:${process.env.PORT || 4399}`;
const wantBattery = process.argv.includes("--battery");

async function serverUp() {
  try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

function run(name, cmd, args) {
  process.stdout.write(`\n▶ ${name}: ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  // surface the gate's summary line
  let summary = "";
  try { const j = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop()); summary = j.summary || ""; }
  catch { summary = out.trim().split("\n").slice(-2).join(" "); }
  const ok = r.status === 0;
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${summary}`);
  return { name, ok, status: r.status, summary };
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
// Engine unit tests (offline, always): runtime + layout engine.
results.push(run("engine-tests", "pnpm", ["-s", "bite:test"]));

if (up) {
  // The oracle plays the PROD build the server serves — rebuild it first so a
  // stale bundle (older engine than the templates) can never fake a result.
  results.push(run("player-build", "pnpm", ["-s", "player:build"]));
  // A — interaction oracle (needs server + prod build)
  results.push(run("oracle", "node", ["snack-server/tools/e2e-audit.mjs"]));
  // E — multiplayer sync
  results.push(run("multiclient-sim", "node", ["snack-server/tools/multiclient-sim.mjs"]));
  // F — generation battery (optional; OpenAI)
  if (wantBattery) results.push(run("gen-battery", "node", ["snack-server/tools/gen-battery.mjs"]));
  else console.log("\n⏭  gen-battery skipped (pass --battery + OpenAI key to run)");
} else {
  console.log(`\n⏭  oracle + multiclient-sim skipped (server not up at ${BASE}; run \`pnpm server:dev\` + \`pnpm player:build\`)`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n━━━ GATES: ${results.length - failed.length}/${results.length} pass${failed.length ? ` — FAIL: ${failed.map((f) => f.name).join(", ")}` : " — ALL PASS"} ━━━`);
process.exit(failed.length ? 1 : 0);
