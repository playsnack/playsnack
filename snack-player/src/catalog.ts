// The official app lineup, read from the static index (data/bite/index.json —
// shipped in every build, serverless or not). These flags shape it:
//   hidden: true        → not on the home screen, but old links still open it
//   mergedInto: "<id>"  → old links redirect to that app instead
//   flagship: true      → the home "대표작" card, above 추천 (exactly one app;
//                         it is never listed again in 추천 or 검토 전)
//   featured: n         → in the home "추천" section, rank n (1 = first). Set it
//                         only after the owner has reviewed + fixed the game on a
//                         real phone; everything else lists under "검토 전 게임".
import type { BiteDoc } from "@snack/bite";

export type CatalogEntry = {
  id: string;
  title: string;
  category: string;
  emoji: string;
  mode: string;
  order?: number;
  hidden?: boolean;
  mergedInto?: string;
  featured?: number;
  flagship?: boolean;
};

let cache: Promise<CatalogEntry[]> | null = null;

export function loadCatalog(): Promise<CatalogEntry[]> {
  cache ??= fetch(`${import.meta.env.BASE_URL}data/bite/index.json`).then((r) => {
    if (!r.ok) throw new Error(`catalog ${r.status}`);
    return r.json() as Promise<CatalogEntry[]>;
  });
  cache.catch(() => (cache = null)); // a failed load can be retried
  return cache;
}

export type HomeSections = { flagship: CatalogEntry | null; featured: CatalogEntry[]; unreviewed: CatalogEntry[] };

/**
 * Split the home lineup: the 대표작 (flagship — the first shown one if the data
 * ever marks more), then 추천 (featured, by rank), then the rest (검토 전) in
 * catalog order. Every shown app lands in exactly one place.
 */
export function splitHome(all: CatalogEntry[]): HomeSections {
  const shown = all
    .map((t, i) => ({ ...t, order: t.order ?? i }))
    .filter((t) => !t.hidden && !t.mergedInto)
    .sort((a, b) => a.order! - b.order!);
  const flagship = shown.find((t) => t.flagship === true) ?? null;
  const rest = shown.filter((t) => t !== flagship);
  const isFeatured = (t: CatalogEntry) => typeof t.featured === "number" && t.featured > 0;
  return {
    flagship,
    featured: rest.filter(isFeatured).sort((a, b) => a.featured! - b.featured! || a.order! - b.order!),
    unreviewed: rest.filter((t) => !isFeatured(t)),
  };
}

export async function homeSections(): Promise<HomeSections> {
  return splitHome(await loadCatalog());
}

/** For a template link (`tpl-<id>`): the template it now lives in, if it was merged. */
export async function redirectFor(slug: string): Promise<string | null> {
  if (!slug.startsWith("tpl-")) return null;
  const all = await loadCatalog().catch(() => [] as CatalogEntry[]);
  const target = all.find((t) => t.id === slug.slice(4))?.mergedInto;
  return target ? `tpl-${target}` : null;
}

// A together app's nearest one-person app, offered when its room can't be joined.
const SOLO_ALTERNATIVE: Record<string, string> = {
  "tap-battle": "game-tap-target",
  "coop-tap-goal": "game-tap-target",
  "coop-click": "game-tap-target",
  "speed-trivia-score": "quiz-ox",
  "reaction-duel-score": "game-reaction",
  "nunchi-tap": "game-reaction",
  "worldcup-group-vote": "worldcup-food",
  "majority-guess": "quiz-ox",
};

/** The closest app to play alone instead of `slug`, or null (→ pick one at home). */
export async function soloAlternative(slug: string): Promise<CatalogEntry | null> {
  const id = SOLO_ALTERNATIVE[slug.replace(/^tpl-/, "")];
  if (!id) return null;
  const all = await loadCatalog().catch(() => [] as CatalogEntry[]);
  return all.find((t) => t.id === id && !t.hidden) ?? null;
}

/** True when any action in the document sends an event to the room (`emit`). */
function emitsToRoom(doc: BiteDoc): boolean {
  let hit = false;
  const visit = (v: unknown) => {
    if (hit || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof (v as { emit?: unknown }).emit === "string") {
      hit = true;
      return;
    }
    Object.values(v).forEach(visit);
  };
  visit(doc);
  return hit;
}

/**
 * Whether this app needs a shared room. Decided by the app's content, not the
 * catalog's mode label: a together app (meta.multi), any app that sends events
 * to a room (e.g. a shared counter), or a link that names a room.
 */
export function needsRoom(doc: BiteDoc, params: URLSearchParams): boolean {
  const meta = (doc as { meta?: { multi?: unknown } }).meta;
  return Boolean(meta?.multi) || emitsToRoom(doc) || params.has("room") || params.has("host");
}
