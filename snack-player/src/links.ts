// The link shapes the player reads and writes. Pure (no DOM, no build env), so
// the rules are unit-tested in Node (snack-player/test/links.test.ts).
//
//   /p/<slug>                 the app's public room (one per app)
//   /p/<slug>?room=<code>     a friends-only room: the code names the room
//   /p/app-<hash>?d=<doc>     a made app, carried inside the link
//   #/p/<slug>?…              the old hash form — read like the path form and
//                             rewritten to it (parseRoute → canonical)
//   ?bite=<name>              the Bite dev player (unchanged)

export type Route = { name: "home" | "create" | "live" | "bite"; slug?: string; params: URLSearchParams };
export type ParsedRoute = {
  route: Route;
  /** For an old hash link: the same route as a path link (the URL to replace it with). */
  canonical: string | null;
};

const splitQuery = (s: string): [string, string] => {
  const i = s.indexOf("?");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
};

function routeOf(path: string, params: URLSearchParams): Route {
  const live = path.match(/^\/p\/([^/?#]+)/);
  if (live) return { name: "live", slug: decodeURIComponent(live[1]), params };
  if (path.startsWith("/create")) return { name: "create", params };
  return { name: "home", params };
}

/** Parse a location (path or old hash form) into a route. */
export function parseRoute(loc: { pathname: string; search: string; hash: string }): ParsedRoute {
  const search = new URLSearchParams(loc.search);
  if (search.has("bite")) return { route: { name: "bite", params: search }, canonical: null };
  const hash = loc.hash.replace(/^#/, "");
  if (!hash.startsWith("/")) return { route: routeOf(loc.pathname, search), canonical: null };
  // Old hash link: `#/p/slug?room=…`. Its own query wins over one before the `#`.
  const [hashPath, hashQuery] = splitQuery(hash);
  const params = new URLSearchParams(hashQuery);
  for (const [k, v] of search) if (!params.has(k)) params.set(k, v);
  const q = params.toString();
  return { route: routeOf(hashPath, params), canonical: `${hashPath}${q ? `?${q}` : ""}` };
}

/** Path + query for a play link (no origin). */
export function playPath(slug: string, params?: URLSearchParams): string {
  const q = params?.toString();
  return `/p/${encodeURIComponent(slug)}${q ? `?${q}` : ""}`;
}

// ── friends-only room codes ──
// 32 symbols — no 0/O or 1/I, so a code read aloud or typed is never ambiguous.
// 32 = 2^5, so one random byte masked to 5 bits is uniform (no modulo bias).
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 10 symbols × 5 bits = 50 bits: not guessable (the room's only protection in Q1). */
export const ROOM_CODE_LENGTH = 10;
/** A link must carry at least this many symbols to count as a room code (40 bits). */
export const ROOM_CODE_MIN = 8;
export const ROOM_PARAM = "room";
/** Joins the app slug and the code into the room id (MQTT-topic and file-name safe). */
const ROOM_SEP = "~";

export function newRoomCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/** The room code a link carries, normalized (upper-case, alphabet only), or null. */
export function roomCodeOf(params: URLSearchParams): string | null {
  const raw = params.get(ROOM_PARAM);
  if (!raw) return null;
  const code = raw.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 32);
  return code.length >= ROOM_CODE_MIN ? code : null;
}

/**
 * The room a link lands in, as the transport sees it: the app's public room
 * (`slug`), or `slug~CODE` for a friends-only link. The room engine only ever
 * sees this id (mesh topic / server room key), so it needs no change.
 */
export function roomIdFor(slug: string, params: URLSearchParams): string {
  const code = roomCodeOf(params);
  return code ? `${slug}${ROOM_SEP}${code}` : slug;
}

/** The same link, in a friends-only room named by `code` (other params kept). */
export function friendLink(origin: string, slug: string, params: URLSearchParams, code: string): string {
  const p = new URLSearchParams(params);
  p.set(ROOM_PARAM, code);
  return `${origin}${playPath(slug, p)}`;
}
