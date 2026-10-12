// Bite doc loader + content-slot extraction. Shared by content-quality.mjs,
// multiclient-sim.mjs, etc. Content lives in `vars` initial arrays (questions,
// seedItems, options) and in node text/colors, NOT in plain text nodes.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TPL_DIR = join(HERE, "..", "data", "bite");

// Templates merged into another (index.json `mergedInto`) only redirect old
// links now, so the gates skip them.
export function listIds() {
  return readdirSync(TPL_DIR)
    .filter((f) => f.endsWith(".bite.json"))
    .map((f) => f.replace(/\.bite\.json$/, ""))
    .filter((id) => !loadIndex().get(id)?.mergedInto);
}

export function loadDoc(id) {
  return JSON.parse(readFileSync(join(TPL_DIR, `${id}.bite.json`), "utf8"));
}

export const varNames = (doc) => Object.keys(doc.vars ?? {});

// First `emit` action with this event name anywhere in the doc (phases + nodes).
export function findEmit(doc, name) {
  let hit = null;
  const visit = (v) => {
    if (hit || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (v.emit === name) {
      hit = v;
      return;
    }
    Object.values(v).forEach(visit);
  };
  visit(doc.phases);
  visit(doc.view);
  return hit;
}

let _index = null;
export function loadIndex() {
  if (_index) return _index;
  const raw = JSON.parse(readFileSync(join(TPL_DIR, "index.json"), "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.templates || raw.items || Object.values(raw));
  _index = new Map(arr.map((t) => [t.id, t]));
  return _index;
}

export function categoryOf(id) {
  return loadIndex().get(id)?.category || loadIndex().get(id)?.cat || "?";
}

// All variable initial values (the content pool).
export function varInitials(doc) {
  return { ...(doc.vars ?? {}) };
}

// Deep-collect every string leaf under a value.
export function stringLeaves(val, acc = []) {
  if (typeof val === "string") acc.push(val);
  else if (Array.isArray(val)) val.forEach((x) => stringLeaves(x, acc));
  else if (val && typeof val === "object") Object.values(val).forEach((x) => stringLeaves(x, acc));
  return acc;
}

// Question-style sets in variable initials: arrays of objects that have `options`
// (and usually `answer`). Returns [{varId, idx, chosung?, hint?, options, answer}].
export function questionSets(doc) {
  const out = [];
  for (const [varId, val] of Object.entries(varInitials(doc))) {
    if (!Array.isArray(val)) continue;
    val.forEach((q, idx) => {
      if (q && typeof q === "object" && Array.isArray(q.options)) {
        out.push({ varId, idx, chosung: q.chosung, hint: q.hint, options: q.options, answer: q.answer });
      }
    });
  }
  return out;
}

// Option/candidate string-sets for dedup: arrays of strings, and `options`/`name`
// arrays inside object arrays. Returns array of {label, set:string[]}.
export function optionSets(doc, id) {
  const sets = [];
  for (const [varId, val] of Object.entries(varInitials(doc))) {
    if (!Array.isArray(val) || val.length === 0) continue;
    if (val.every((x) => typeof x === "string")) {
      sets.push({ label: `${id}.${varId}`, set: val.slice() });
    } else if (val.every((x) => x && typeof x === "object")) {
      // candidate arrays (worldcup seedItems: {name}) and question options
      const names = val.map((x) => x.name).filter((s) => typeof s === "string");
      if (names.length) sets.push({ label: `${id}.${varId}[name]`, set: names });
      for (const q of val) if (Array.isArray(q.options)) sets.push({ label: `${id}.${varId}.options`, set: q.options.slice() });
    }
  }
  return sets;
}

// Walk the node tree (view + component views) yielding text nodes with their
// fg and every plausible bg: the nearest ancestor fill, plus — inside a "free"
// box, where pieces are stacked — the fills of earlier siblings it may sit on
// (a label on a lime bar or disc). Emoji-only text is skipped (drawn in color).
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F\u200D\s]+$/u;
// Literal fill, or every hex a templated fill can produce ("{won ? '#d9ff00' : '#1e2127'}").
const fillsOf = (node) => {
  const f = node.fill;
  if (typeof f !== "string") return [];
  if (HEX.test(f)) return [f];
  return f.includes("{") ? (f.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? []) : [];
};
export function textColorPairs(doc) {
  const pairs = [];
  const walk = (node, bgs) => {
    if (!node || typeof node !== "object") return;
    const own = !("text" in node) && !("image" in node) ? fillsOf(node) : [];
    const here = own.length ? own : bgs;
    if ("text" in node && HEX.test(node.color ?? "") && !EMOJI_ONLY.test(String(node.text))) {
      pairs.push({ id: node.id, fg: node.color, bg: here[0], bgs: here, content: node.text });
    }
    const stacked = node.box === "free";
    const under = [];
    for (const c of node.children || []) {
      walk(c, stacked && under.length ? [...here, ...under] : here);
      if (stacked && !("text" in c)) under.push(...fillsOf(c));
    }
  };
  walk(doc.view, ["#000000"]);
  for (const def of Object.values(doc.components ?? {})) walk(def.view, ["#000000"]);
  return pairs;
}

// Image-bearing fields anywhere in the doc: {imageUrl, src, image, photo,...}.
export function imageFields(doc) {
  const out = [];
  const walk = (o, path) => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (/^(image|imageUrl|img|src|photo|thumb|picture|avatar)$/i.test(k)) out.push({ path: `${path}.${k}`, value: v });
      walk(v, `${path}.${k}`);
    }
  };
  walk(doc, "doc");
  return out;
}
