// "되는 척" 문구 검사 (master-plan §4 Q0 merge criterion: 0 hits). Scans the
// user-facing surfaces — player sources, index.html, the official templates and a
// built dist when present — for phrases that claim something the product does
// not do (a LIVE badge, "N명 접속 중", "저장되었어요", "서버", 📸, ★ without
// ratings data …). Comments are stripped before matching; legitimate uses are
// listed in ALLOW with a reason. Exit 1 on any hit, printing file:line.
//   node snack-server/tools/check-honesty.mjs            (offline; part of gate-all)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "./_gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// What to scan (relative to the repo root).
const TARGETS = [
  { dir: "snack-player/src", ext: [".ts", ".tsx", ".css"] },
  { file: "snack-player/index.html" },
  { dir: "snack-server/data/bite", ext: [".bite.json"] },
  { dir: "snack-player/dist", ext: [".js", ".html"], optional: true },
];

// Each rule: id, regex (tested per line of comment-stripped source), what it fakes.
const RULES = [
  { id: "live-badge", re: /(?<![A-Za-z_])LIVE(?![A-Za-z_])/, why: "a LIVE badge claims a live feed/broadcast" },
  { id: "online-count", re: /접속\s?중/, why: "'접속 중' claims live presence" },
  { id: "playing-count", re: /플레이\s?중(?=.*명)|명.*플레이\s?중/, why: "'N명 플레이 중' claims live player counts" },
  { id: "realtime-count", re: /실시간(?=.*명)|명.*실시간/, why: "'실시간 N명' claims live counts" },
  { id: "watching-count", re: /명이?\s?(보는|참여)\s?중/, why: "'N명이 보는/참여 중' claims live presence" },
  { id: "saved", re: /저장(되었|됐|돼|했어|했습|되요|해요|할게|완료)/, why: "'저장' claims persistence the product does not have" },
  { id: "server", re: /서버/, why: "'서버' — the product is serverless; the user never talks to a server" },
  { id: "camera", re: /📸/, why: "📸 implies a photo/camera feature" },
  { id: "star-rating", re: /★/, why: "★ ratings must be backed by real data" },
  { id: "people-icon", re: /👥(?!\s*(다\s*)?같이)/, why: "👥 implies a live crowd (the honest use is the '같이' tag)" },
];

// Legitimate uses: { file: regex on the repo-relative path, re: regex on the line, why }.
// A hit is suppressed only when BOTH match. Keep every entry justified.
const ALLOW = [
  {
    file: /^snack-player\/src\/CreateApp\.tsx$/,
    re: /ratingCount > 0 \? ` · ★\$\{t\.avg\}/,
    why: "★ shown only when ratingCount > 0 (real ratings from the templates API)",
  },
  {
    file: /^snack-player\/src\/CreateApp\.tsx$/,
    re: /rated\[t\.id\].*>★<\/button>/,
    why: "★ is the rating INPUT (the user's own tap), not a displayed score",
  },
  {
    file: /^snack-player\/src\/Screens\.tsx$/,
    re: /<>👥 \{people\}명<\/>/,
    why: "RoomChip count = the room's real participant count from the transport (LiveApp participants), shown only once connected",
  },
  {
    file: /^snack-player\/src\/NicknameGate\.tsx$/,
    re: /이 브라우저에만 저장돼요/,
    why: "true: the nickname is kept in this browser's localStorage only",
  },
  {
    file: /^snack-player\/src\/backend\.ts$/,
    re: /서버(가 응답하지 않아요| 응답을 읽지 못했어요)/,
    why: "error shown after a REAL request to the AI builder failed (not a claim of a server feature)",
  },
];

const stripComments = (src, ext) => {
  if (ext === ".bite.json") return src; // JSON has no comments
  // Block comments → same number of newlines (keeps line numbers); line comments → cut
  // unless the `//` is part of a URL (`://`).
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  if (ext === ".html") s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
  return s
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
};

const extOf = (f, exts) => exts.find((e) => f.endsWith(e));
const walk = (dir, exts, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (extOf(f, exts)) out.push(p);
  }
  return out;
};

// Templates merged into another app (index.json `mergedInto`) are unreachable: old
// links redirect (snack-player/src/catalog.ts). `hidden` alone still opens from an
// old link, so those ARE scanned.
const index = JSON.parse(readFileSync(join(ROOT, "snack-server/data/bite/index.json"), "utf8"));
const unreachable = new Set(index.filter((t) => t.mergedInto).map((t) => `${t.id}.bite.json`));

const files = [];
const skipped = [];
for (const t of TARGETS) {
  if (t.file) {
    const p = join(ROOT, t.file);
    if (existsSync(p)) files.push({ path: p, ext: t.file.slice(t.file.lastIndexOf(".")) });
    continue;
  }
  const d = join(ROOT, t.dir);
  if (!existsSync(d)) {
    if (!t.optional) throw new Error(`missing scan target ${t.dir}`);
    continue;
  }
  for (const p of walk(d, t.ext)) {
    if (t.dir === "snack-server/data/bite" && unreachable.has(relative(d, p))) skipped.push(relative(ROOT, p));
    else files.push({ path: p, ext: extOf(p, t.ext) });
  }
}

const results = [];
const allowed = [];
for (const { path, ext } of files) {
  const rel = relative(ROOT, path);
  const lines = stripComments(readFileSync(path, "utf8"), ext).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const allow = ALLOW.find((a) => a.file.test(rel) && a.re.test(line));
      const col = m.index + 1;
      const snippet = line.trim().slice(Math.max(0, m.index - 40 - (line.length - line.trimStart().length)), m.index + 60).trim();
      if (allow) allowed.push({ file: rel, line: i + 1, rule: rule.id, why: allow.why });
      else hits.push({ line: i + 1, col, rule: rule.id, snippet: snippet.length > 120 ? `${snippet.slice(0, 120)}…` : snippet });
    }
  });
  results.push({ id: rel, ok: hits.length === 0, hits });
}

for (const r of results) for (const h of r.hits) console.error(`❌ ${r.id}:${h.line}:${h.col} [${h.rule}] ${h.snippet}`);
for (const a of allowed) console.error(`   allow ${a.file}:${a.line} [${a.rule}] — ${a.why}`);
if (skipped.length) console.error(`   skipped ${skipped.length} merged-away template(s) (unreachable: index.json mergedInto): ${skipped.map((f) => f.split("/").pop()).join(", ")}`);
const total = results.reduce((n, r) => n + r.hits.length, 0);
runGate("honesty", results, (r) => r.ok, () => `honesty: ${total} 되는 척 hit${total === 1 ? "" : "s"} in ${files.length} files (${allowed.length} allowlisted, ${skipped.length} merged-away skipped)${total ? " — FAIL" : ""}`);
