// AI builder: prompt -> gpt-5.5 -> Bite JSON -> validate + runtime smoke +
// layout lint (all in-process) -> repair loop. Grounded on the closest proven
// template (structure-first). No key / repeated failure -> {valid:false} for
// the caller to surface.
import OpenAI from "openai";
import { createBite, validate } from "@snack/bite";
import { initLayout, computeScene, checkLayout } from "@snack/bite-layout";
import { SYSTEM_PROMPT } from "./prompt.mjs";
import { injectLibrary } from "./componentLibrary.mjs";
import { listTemplates, getTemplateDoc } from "./templates.mjs";

const layoutReady = initLayout();

// Numeric style props: a template here must produce a number, or the renderer
// falls back to the default and the element is dead ("looks fine, never moves").
const NUMERIC_KEYS = ["width", "height", "x", "y", "opacity", "rotate", "scale", "size", "grow", "gap", "minWidth", "minHeight", "maxWidth", "maxHeight"];

/**
 * Play the doc headless for a few frames (and tap every tappable node once)
 * and lint the layout of each phase it reaches. Returns repair feedback or null.
 */
export async function lintDoc(doc) {
  await layoutReady;
  const warnings = [];
  let t = 0;
  const app = createBite(doc, { now: () => t, random: () => 0.5, warn: (m) => warnings.push(m) });
  const problems = new Set();
  const seen = new Set();
  const inspect = () => {
    const { root } = computeScene(doc, app);
    if (seen.has(app.phase)) return root;
    seen.add(app.phase);
    for (const i of checkLayout(root, doc.frame)) {
      if (i.kind === "off-frame") problems.add(`"${i.where}" falls outside the 390×844 screen in phase "${app.phase}" (${i.detail})`);
      else if (i.kind === "text-overflow-y" || i.kind === "text-overflow-x") problems.add(`text "${i.where}" does not fit its box in phase "${app.phase}" (${i.detail}) — give it room or shorten it`);
      else if (i.kind === "overflow-parent") problems.add(`"${i.where}" spills out of its parent box in phase "${app.phase}" (${i.detail}) — the parent is too small for its children`);
    }
    const walk = (inst) => {
      for (const k of NUMERIC_KEYS) {
        const v = inst.style[k];
        if (k in inst.node && typeof v !== "number" && !(k === "width" || k === "height" ? ["fill", "hug"].includes(v) : false)) {
          problems.add(`"${inst.node.id ?? inst.key}".${k} evaluates to ${JSON.stringify(v)} — numeric props need a number (use "{expr}" with a numeric expression, no units)`);
        }
      }
      inst.children.forEach(walk);
    };
    walk(root);
    return root;
  };
  try {
    app.start();
    for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
    const root = inspect();
    // Tap each visible tappable node once, in order, linting every phase reached.
    const taps = [];
    const collect = (inst) => { if (inst.tap) taps.push(inst.tap); inst.children.forEach(collect); };
    collect(root);
    for (const tap of taps.slice(0, 12)) {
      app.tap(tap.node, tap.scope);
      for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
      inspect();
    }
  } catch (e) {
    problems.add(`runtime crashed: ${e.message}`);
  }
  for (const w of new Set(warnings)) problems.add(`runtime: ${w}`);
  return problems.size ? [...problems].slice(0, 12).join("\n") : null;
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
// gpt-5.5's default reasoning is heavy (30–90s builds → tunnel timeouts). App
// generation doesn't need deep reasoning; "low" cuts builds to seconds and the
// validate→repair loop catches the occasional miss. Override via env.
const REASONING = process.env.OPENAI_REASONING || "low";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Ask the model and parse its JSON. An API failure is NOT a model mistake: auth
// / permission errors stop the build at once (retrying cannot help) and are
// reported as such instead of masquerading as "invalid JSON".
class ApiError extends Error {}
async function askJson(call) {
  let text;
  try {
    text = await call();
  } catch (e) {
    const status = e?.status;
    if (status === 401 || status === 403) throw new ApiError(`OpenAI 인증 실패 (${status}) — API 키를 확인해주세요`);
    return { error: `OpenAI request failed${status ? ` (${status})` : ""}: ${e?.message ?? e}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (e) {
    return { error: `Output was not valid JSON: ${e.message}` };
  }
}

// ── STEP 1: PLAN + GROUND ────────────────────────────────────────────────────
// Don't one-shot a vague idea into a full app (→ broken prototypes). First write
// a tiny PRD and PICK the closest PROVEN working app from our library; its real
// Bite document becomes the structural template the build COPIES (structure-first). This
// is the single biggest Create-quality lever: the model copies a working
// state-machine/trigger wiring instead of reinventing (and getting it wrong).
async function planAndGround(prompt, mode) {
  try {
    const catalog = listTemplates().templates.map((t) => ({ id: t.id, title: t.title, category: t.category, mode: t.mode }));
    if (!catalog.length) return null;
    const sys = `You are a product planner for a mobile mini-app generator. Given a one-line app idea, write a SHORT build spec and PICK the single closest-matching app from the provided library of PROVEN working apps — its structure will be the template to copy. ` +
      `Output ONLY JSON: {"kind":"quiz|ox|game|worldcup|vote|balance|test|counter|reaction|race|...","multiplayer":boolean,"exemplarId":"<an id from the library>","endCondition":"<for games: how it ends>","notes":"<=25 words: the states and the core interaction loop"}.`;
    const user = `IDEA: ${prompt}\nMODE: ${mode || "(auto-decide)"}\n\nLIBRARY (choose exemplarId from these ids):\n${JSON.stringify(catalog)}`;
    const res = await client.chat.completions.create({
      model: MODEL, response_format: { type: "json_object" }, max_completion_tokens: 1500,
      reasoning_effort: process.env.OPENAI_PLAN_REASONING || "medium",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    const spec = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    const exDoc = spec.exemplarId ? getTemplateDoc(spec.exemplarId) : null;
    if (!exDoc) return { spec, exemplarJson: null };
    const trimmed = { ...exDoc }; delete trimmed.components; // re-injected at build; saves tokens
    console.log(`[builder] plan: kind=${spec.kind} multi=${spec.multiplayer} → exemplar=${spec.exemplarId}`);
    return { spec, exemplarId: spec.exemplarId, exemplarJson: JSON.stringify(trimmed) };
  } catch { return null; } // grounding is best-effort — fall back to plain one-shot
}

// Structural checks: the spec validator plus a runtime smoke run. Missing
// frame is the one thing we fix silently (it has exactly one right value).
function validateDoc(doc) {
  if (doc && typeof doc === "object" && !doc.frame) doc.frame = [390, 844];
  const v = validate(doc);
  if (!v.ok) return { valid: false, errors: v.errors.map((e) => `${e.path}: ${e.message}`) };
  return { valid: true, errors: [] };
}

// Does the doc follow the social contract (so a shared link plays together)?
function isMultiplayerCompliant(doc) {
  const hasShared = doc?.vars && typeof doc.vars.votesByOption === "object" && doc.vars.votesByOption !== null;
  const json = JSON.stringify(doc ?? {});
  const emits = /"emit"\s*:\s*"vote"/.test(json);
  const localSetsShared = /"set"\s*:\s*"votesByOption"/.test(json);
  return Boolean(hasShared && emits && !localSetsShared);
}

const MODE_DIRECTIVE = {
  auto: `DECIDE the mode from the idea: if many people would naturally share it and look at ONE combined live result (votes, polls, this-or-that, reactions, rankings, "who/which is more…"), build it MULTIPLAYER using the SNACK SOCIAL CONTRACT (votesByOption var + emit "vote" {option} + nodes reading votesByOption, never set it yourself). If it's personal/solo (counter, timer, mood check just for me, single-player game), build it SINGLE-PLAYER with local variables only (no emit, no votesByOption).`,
  multi: `BUILD A MULTIPLAYER app: many people open the same link and see ONE shared, live result. You MUST follow the SNACK SOCIAL CONTRACT — a "votesByOption" object var, each choice tap emits "vote" with {option} and sets a local "myVote", and the live result reads votesByOption. NEVER set votesByOption yourself (the server is authoritative). Frame the interaction as picking one of N options.`,
  single: `BUILD A SINGLE-PLAYER app: all state is LOCAL to one player. Do NOT emit and do NOT create a "votesByOption" variable — plain local variables only.`,
  coop: `BUILD A CO-OP TALLY app: everyone's taps ADD to ONE shared total toward a goal. Follow the CO-OP TALLY contract — vars "coopTotal" (0) and "goal", each tap emits "tally" with {delta:1} (NEVER set coopTotal yourself), and a progress bar/text reads coopTotal. No votesByOption.`,
  race: `BUILD A LIVE-LEADERBOARD competitive GAME: same game, players compete on score, "누가 1등". Follow BOTH the GAME LOOP and the LIVE LEADERBOARD contract — on run end emit "score" with {score:"{score}"}; the result screen lists the "leaderboard" array (each) plus your own score. No votesByOption.`,
};

async function generate(prompt, feedback, current, mode, ground) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (mode && MODE_DIRECTIVE[mode]) messages.push({ role: "system", content: MODE_DIRECTIVE[mode] });
  // STEP 2: ground the build in the proven exemplar (structure-first; copy its wiring).
  if (ground?.exemplarJson) messages.push({ role: "system", content:
    `STRUCTURAL EXEMPLAR — a PROVEN, working app of the same kind${ground.spec?.kind ? ` (${ground.spec.kind})` : ""}. COPY its phases, tap wiring, variable pattern and layout structure; change ONLY the content/theme/text/options to fit the new idea. Do NOT invent a different structure. (components are auto-injected — omit them.)\nPRD: ${JSON.stringify(ground.spec)}\nEXEMPLAR Bite document:\n${ground.exemplarJson}` });
  if (current) {
    // Refine mode: edit the existing app, preserving everything not mentioned.
    messages.push({ role: "user",
      content: `Here is the CURRENT app as a Bite document:\n${JSON.stringify(current)}\n\n` +
        `Apply ONLY the change below. Keep EVERYTHING else byte-for-byte identical — same node ids, text, colors, sizes, variables, phases, actions — change just what the instruction asks (and the minimum needed for it to make sense). Return the COMPLETE updated Bite document (not a diff).\n\nCHANGE: ${prompt}` });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  if (feedback) messages.push({ role: "user",
    content: `Your previous attempt failed validation:\n${feedback}\nReturn a corrected, COMPLETE JSON document that fixes these issues.` });
  const res = await client.chat.completions.create({
    // Generous budget: gpt-5.5 reasoning + re-emitting a full doc (fresh build or
    // a mode-conversion rebuild) must not truncate → invalid JSON → worse repair.
    model: MODEL, messages, response_format: { type: "json_object" }, max_completion_tokens: 24000, reasoning_effort: REASONING,
  });
  return res.choices[0]?.message?.content ?? "";
}

// ── Smart (targeted) refine ─────────────────────────────────────────────────
// The model returns either small PATCH ops (applied to a deep copy of the
// current doc → unchanged parts are byte-preserved, zero drift) or, only for
// structural changes, a full doc. Plus a Korean summary of what changed.
function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}
function applyPatches(doc, patches) {
  let applied = 0;
  for (const p of patches || []) {
    try {
      if (p.op === "setNodeProp") {
        const n = findNode(doc.view, p.id);
        if (!n || !p.prop) continue;
        if (p.prop.startsWith("props.")) (n.props ??= {})[p.prop.slice(6)] = p.value;
        else n[p.prop] = p.value;
        applied++;
      } else if (p.op === "setVarInitial") {
        if (doc.vars && Object.hasOwn(doc.vars, p.id)) { doc.vars[p.id] = p.value; applied++; }
      } else if (p.op === "setName") {
        (doc.meta ??= {}).name = p.value; applied++;
      }
    } catch { /* skip bad op */ }
  }
  return applied;
}

const REFINE_SYSTEM = `You edit an existing Bite app with MINIMAL changes. Output ONE JSON object — either:
A) PATCHES (PREFER THIS for text/color/size/position/title/value changes):
   {"mode":"patch","summary":"<one short Korean sentence of what changed>","patches":[ ops ]}
   Allowed ops (reference REAL node ids / variable names from the current app):
   {"op":"setNodeProp","id":"<nodeId>","prop":"text|fill|color|size|weight|width|height|x|y|radius|opacity|image|show|gap|pad|props.<name>","value":<v>}
   {"op":"setVarInitial","id":"<varName>","value":<v>}
   {"op":"setName","value":"<app name>"}
   (Values follow the Bite rules: templates like "{score}점", expressions for "show".)
B) FULL document (ONLY when the change is structural — add/remove nodes or options, change phases or actions):
   {"mode":"full","summary":"<…>","doc":{ ...complete updated Bite document, following all the rules... }}
Change ONLY what the instruction asks. Keep all other ids/values identical. Korean summary, ≤ 20 words.`;

async function generateRefine(current, prompt, feedback) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: REFINE_SYSTEM },
    { role: "user", content: `CURRENT app (Bite document):\n${JSON.stringify(current)}\n\nCHANGE: ${prompt}` },
  ];
  if (feedback) messages.push({ role: "user", content: `Previous attempt problem: ${feedback}\nReturn corrected output.` });
  const res = await client.chat.completions.create({
    model: MODEL, messages, response_format: { type: "json_object" }, max_completion_tokens: 16000, reasoning_effort: REASONING,
  });
  return res.choices[0]?.message?.content ?? "";
}

async function refineApp(prompt, current, mode) {
  let feedback = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const asked = await askJson(() => generateRefine(current, prompt, feedback));
    if (asked.error) { feedback = asked.error; continue; }
    const parsed = asked.json;
    let doc, summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
    if (parsed.mode === "patch" && Array.isArray(parsed.patches)) {
      doc = structuredClone(current);
      if (applyPatches(doc, parsed.patches) === 0) { feedback = "no patches applied (wrong ids?). Return mode:full or correct ids."; continue; }
    } else if (parsed.doc && typeof parsed.doc === "object") {
      doc = parsed.doc;
    } else { feedback = "bad format — use {mode:'patch',patches:[…]} or {mode:'full',doc:{…}}"; continue; }
    doc = injectLibrary(doc);
    const v = validateDoc(doc);
    if (!v.valid) { feedback = v.errors.join("\n"); continue; }
    const lint = await lintDoc(doc);
    if (lint && /runtime/.test(lint)) { feedback = lint; continue; }
    if (mode === "multi" && !isMultiplayerCompliant(doc)) { feedback = "must keep the social contract (votesByOption + emit \"vote\")."; continue; }
    return { doc, valid: true, source: "openai", attempt, summary, multiplayer: isMultiplayerCompliant(doc) };
  }
  return { doc: null, valid: false, source: "openai", error: feedback };
}

export async function buildApp(prompt, current, mode, opts = {}) {
  if (!client) return { doc: null, valid: false, source: "no-key", error: "OPENAI_API_KEY not set" };
  try {
    return await buildAppInner(prompt, current, mode, opts);
  } catch (e) {
    if (e instanceof ApiError) return { doc: null, valid: false, source: "openai", error: e.message };
    throw e;
  }
}

async function buildAppInner(prompt, current, mode, opts) {
  // Targeted-patch edit for small tweaks. A mode-conversion (opts.rebuild) is
  // structural (add/remove the whole social-contract wiring) → full rebuild,
  // preserving the design via `current`, with the target mode enforced.
  if (current && !opts.rebuild) return refineApp(prompt, current, mode);
  // STEP 1: plan + pick a proven exemplar to ground the build (fresh builds only;
  // a rebuild already has `current` design to preserve). Best-effort — null → plain build.
  const ground = current ? null : await planAndGround(prompt, mode);
  let feedback = null;
  const maxAttempts = mode === "multi" ? 3 : 2; // extra room to enforce the contract
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const asked = await askJson(() => generate(prompt, feedback, current, mode, ground));
    if (asked.error) { feedback = asked.error; continue; }
    let doc = injectLibrary(asked.json);
    const v = validateDoc(doc);
    if (!v.valid) { feedback = v.errors.join("\n"); continue; }
    // Multiplayer lint: a shared link only plays together if the app follows the
    // social contract. If it doesn't, regenerate with explicit repair guidance.
    if (mode === "multi" && !isMultiplayerCompliant(doc)) {
      feedback = `This is a MULTIPLAYER app but it does NOT follow the social contract, so a shared link won't sync. You MUST: (1) declare var "votesByOption" whose initial is the option keys, e.g. {"A":0,"B":0}; (2) on each choice tap: { "set": "myVote", "value": "A" } and { "emit": "vote", "payload": { "option": "A" } } — NEVER set votesByOption yourself; (3) show the live result from votesByOption. Return the full corrected JSON.`;
      continue;
    }
    // Runtime + layout lint. Runtime errors always repair; layout problems repair
    // while attempts remain (a slightly-off layout beats a failed build).
    const lint = await lintDoc(doc);
    if (lint && (/runtime/.test(lint) || attempt < maxAttempts)) {
      feedback = `The app plays but has problems:\n${lint}\nFix them (keep the structure-first layout; for multi-screen apps each screen is its own full page shown by phase) and return the full corrected JSON.`;
      if (attempt < maxAttempts) continue;
    }
    // Report the mode actually built (detected), so "auto" surfaces its choice.
    return { doc, valid: true, source: "openai", attempt, multiplayer: isMultiplayerCompliant(doc), lint: lint ?? undefined };
  }
  return { doc: null, valid: false, source: "openai", error: feedback, mode };
}
