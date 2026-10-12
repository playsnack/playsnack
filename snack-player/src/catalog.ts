// The official app lineup, read from the static index (data/bite/index.json —
// shipped in every build, serverless or not). Two flags shape it:
//   hidden: true        → not on the home screen, but old links still open it
//   mergedInto: "<id>"  → old links redirect to that app instead
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

/** Apps shown on the home screen, in catalog order. */
export async function homeApps(): Promise<CatalogEntry[]> {
  const all = await loadCatalog();
  return all
    .map((t, i) => ({ ...t, order: t.order ?? i }))
    .filter((t) => !t.hidden && !t.mergedInto)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
