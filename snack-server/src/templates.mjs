// Template store: official starter templates (snack-server/data/bite/*.bite.json
// + index.json) that the Create landing shows below the prompt box. Users pick
// one, then refine it with their own prompt (reuses the builder refine path).
// Ratings (5-star, anonymous) accumulate into index.json; ranking is a Bayesian
// average so a single 5★ can't top a well-rated, much-rated template.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data/bite");
const INDEX = resolve(DIR, "index.json");

const PRIOR_MEAN = 3.6; // m — assumed mean rating for unrated/under-rated items
const PRIOR_WEIGHT = 5;  // C — how many "prior" votes the mean is worth

let templates = [];
try { templates = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : []; }
catch { templates = []; }
// Stable creation order for "recent" (official set has no real timestamps yet).
templates.forEach((t, i) => { t.order ??= i; t.createdAt ??= 0; });

const bayesian = (t) =>
  (PRIOR_WEIGHT * PRIOR_MEAN + (t.ratingSum || 0)) / (PRIOR_WEIGHT + (t.ratingCount || 0));

const persist = () => { try { writeFileSync(INDEX, JSON.stringify(templates, null, 2)); } catch { /* best-effort */ } };

const publicView = (t) => ({
  id: t.id, title: t.title, category: t.category, emoji: t.emoji, accent: t.accent,
  mode: t.mode, official: t.official, usesPhoto: !!t.usesPhoto,
  avg: t.ratingCount ? Math.round((t.ratingSum / t.ratingCount) * 10) / 10 : 0,
  ratingCount: t.ratingCount || 0, useCount: t.useCount || 0,
  rank: Math.round(bayesian(t) * 100) / 100,
});

const SORTERS = {
  rank:    (a, b) => bayesian(b) - bayesian(a) || (b.useCount||0) - (a.useCount||0),
  rating:  (a, b) => (b.ratingCount ? b.ratingSum/b.ratingCount : 0) - (a.ratingCount ? a.ratingSum/a.ratingCount : 0) || (b.ratingCount||0)-(a.ratingCount||0),
  popular: (a, b) => (b.useCount||0) - (a.useCount||0) || bayesian(b) - bayesian(a),
  recent:  (a, b) => (b.createdAt||0) - (a.createdAt||0) || (b.order||0) - (a.order||0),
};

export function listTemplates({ sort = "rank", category } = {}) {
  let list = templates.slice();
  if (category && category !== "all") list = list.filter((t) => t.category === category);
  list.sort(SORTERS[sort] || SORTERS.rank);
  const categories = [...new Set(templates.map((t) => t.category))];
  return { templates: list.map(publicView), categories, total: templates.length };
}

// All templates as { id, doc } — for registering each as a canonical live room.
export function allTemplateDocs() {
  const out = [];
  for (const t of templates) {
    const doc = getTemplateDoc(t.id);
    if (doc) out.push({ id: t.id, doc });
  }
  return out;
}

// Lightweight metadata lookup (id → {title,emoji,category,...}) for live tickers.
export function templateMeta(id) {
  return templates.find((t) => t.id === id) || null;
}

export function getTemplateDoc(id) {
  if (!templates.some((t) => t.id === id)) return null;
  const p = resolve(DIR, `${id}.bite.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function rateTemplate(id, stars) {
  const t = templates.find((x) => x.id === id);
  const s = Math.round(Number(stars));
  if (!t || !(s >= 1 && s <= 5)) return null;
  t.ratingSum = (t.ratingSum || 0) + s;
  t.ratingCount = (t.ratingCount || 0) + 1;
  persist();
  return publicView(t);
}

export function markUsed(id) {
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  t.useCount = (t.useCount || 0) + 1;
  persist();
}
