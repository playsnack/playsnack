// The official app lineup, read from the static index (data/bite/index.json —
// shipped in every build, serverless or not). These flags shape it:
//   hidden: true        → not on the home screen, but old links still open it
//   mergedInto: "<id>"  → old links redirect to that app instead
// The home has three tiers (rule: docs/template-taxonomy.md "Home tiers"):
//   flagship: true      → 대표작 — the one lime card on top (exactly one app;
//                         it is never listed again in 추천작 or 추천 후보)
//   featured: n         → 추천작, rank n (1 = first) — only together with
//   + reviewedIn: "#k"    reviewedIn, the issue/PR where the game passed a
//                         real-phone check or its fix merged. Neither alone
//                         promotes a game: no evidence, no 추천작.
//   (neither)           → 추천 후보 — still playable, listed quietly below.
//   derivativeOf: "<id>" → a follow-up candidate built on that game (e.g. on
//                         the 나 맞히기 flagship). Data only; stays a 후보
//                         until it is reviewed like any other game.
//   template: "<id>"    → this entry plays another entry's document (data/bite/<id>.bite.json)
//                         as a game of its own: its own card, link (/p/tpl-<this id>),
//                         public room, preview and counts. Today: 스피드 퀴즈 (`speed-quiz`)
//                         = the 나 맞히기 template with its built-in questions (#210,
//                         docs/template-taxonomy.md). Without it, the file is `<id>`.
import type { BiteDoc } from "@snack/bite";
import { MAKE_PARAM, QUIZ_APP_ID, QUIZ_SLUG } from "./quiz";
import { playPath, roomParamOf } from "./links";

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
  reviewedIn?: string;
  flagship?: boolean;
  derivativeOf?: string;
  template?: string;
};

/** 스피드 퀴즈: the quiz template with its built-in questions, as its own game (#210). */
export const SPEED_QUIZ_ID = "speed-quiz";

/** The template file (data/bite/<file>.bite.json) an entry plays. */
export const templateFileOf = (t: Pick<CatalogEntry, "id" | "template">): string => t.template ?? t.id;

/** The template file a `tpl-<id>` link's app plays (its own id when the catalog has no other). */
export async function templateFileFor(id: string): Promise<string> {
  const all = await loadCatalog().catch(() => [] as CatalogEntry[]);
  const t = all.find((x) => x.id === id);
  return t ? templateFileOf(t) : id;
}

/** Where a home card / row goes: the app's own link. */
export const cardPath = (t: Pick<CatalogEntry, "id">): string => `/p/tpl-${t.id}`;

/**
 * The 대표작 card's buttons. The 나 맞히기 quiz has exactly one: 내 퀴즈 만들기 (the quiz
 * link with ?make=1 and no room → App → QuizMaker). 스피드 퀴즈 is not here — it is its own
 * card (SPEED_QUIZ_ID, #210). Any other flagship gets a plain 바로 하기 on its own link.
 */
export type HeroAction = { action: "make" | "play"; label: string; path: string };
export function flagshipActions(f: Pick<CatalogEntry, "id">): HeroAction[] {
  if (f.id === QUIZ_APP_ID) return [{ action: "make", label: "내 퀴즈 만들기", path: playPath(QUIZ_SLUG, new URLSearchParams({ [MAKE_PARAM]: "1" })) }];
  return [{ action: "play", label: "바로 하기", path: cardPath(f) }];
}

let cache: Promise<CatalogEntry[]> | null = null;

export function loadCatalog(): Promise<CatalogEntry[]> {
  cache ??= fetch(`${import.meta.env.BASE_URL}data/bite/index.json`).then((r) => {
    if (!r.ok) throw new Error(`catalog ${r.status}`);
    return r.json() as Promise<CatalogEntry[]>;
  });
  cache.catch(() => (cache = null)); // a failed load can be retried
  return cache;
}

export type HomeSections = { flagship: CatalogEntry | null; featured: CatalogEntry[]; candidates: CatalogEntry[] };

/** 추천작 only when explicitly marked: a positive integer rank AND the review evidence. */
export function isFeatured(t: CatalogEntry): boolean {
  return Number.isInteger(t.featured) && t.featured! > 0 && typeof t.reviewedIn === "string" && t.reviewedIn.trim() !== "";
}

/**
 * Split the home lineup: the 대표작 (flagship — the first shown one if the data
 * ever marks more), then 추천작 (featured + reviewedIn, by rank), then every
 * other shown game as 추천 후보, in catalog order. Hidden / merged games are
 * never shown. Every shown app lands in exactly one place.
 */
export function splitHome(all: CatalogEntry[]): HomeSections {
  const shown = all
    .map((t, i) => ({ ...t, order: t.order ?? i }))
    .filter((t) => !t.hidden && !t.mergedInto)
    .sort((a, b) => a.order! - b.order!);
  const flagship = shown.find((t) => t.flagship === true) ?? null;
  const rest = shown.filter((t) => t !== flagship);
  return {
    flagship,
    featured: rest.filter(isFeatured).sort((a, b) => a.featured! - b.featured! || a.order! - b.order!),
    candidates: rest.filter((t) => !isFeatured(t)),
  };
}

export async function homeSections(): Promise<HomeSections> {
  return splitHome(await loadCatalog());
}

/**
 * A bare 나 맞히기 link — no room code, not the maker (`?make=1`) — has no quiz of anyone's in
 * it: it is the built-in questions, i.e. 스피드 퀴즈 (old links from the 대표작 card's former
 * "스피드 퀴즈로 같이 하기", #210). It opens 스피드 퀴즈's own link, so that game has one public
 * room. A cut/invalid code is left alone (LiveApp says the link is bad).
 */
export function isBareQuizLink(slug: string, params: URLSearchParams): boolean {
  if (slug !== QUIZ_SLUG || params.has(MAKE_PARAM)) return false;
  const kind = roomParamOf(params).kind;
  return kind === "none" || kind === "legacy";
}

/** For a template link (`tpl-<id>`): the app it now lives in, if it was merged (or a bare quiz link). */
export async function redirectFor(slug: string, params: URLSearchParams = new URLSearchParams()): Promise<string | null> {
  if (isBareQuizLink(slug, params)) return `tpl-${SPEED_QUIZ_ID}`;
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
  "speed-quiz": "quiz-ox",
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
