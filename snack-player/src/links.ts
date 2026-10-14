// The link shapes the player reads and writes. Pure (no DOM, no build env), so
// the rules are unit-tested in Node (snack-player/test/links.test.ts).
//
//   /p/<slug>                 the app's public room (one per app)
//   /p/<slug>?room=<code>     a friends-only room: the code names the room
//   /p/app-<hash>#d=<doc>     a made app, carried in the fragment (never sent
//                             to a server; no URL length limit on the request)
//   #/p/<slug>?…              the old hash form — read like the path form and
//                             rewritten to it (parseRoute → canonical)
//   ?bite=<name>              the Bite dev player (unchanged)
//   /stats                    the anonymous stats page (StatsPage.tsx)

export type Route = { name: "home" | "create" | "live" | "bite" | "stats"; slug?: string; params: URLSearchParams };
export type ParsedRoute = {
  route: Route;
  /** For an old hash link: the same route as a path link (the URL to replace it with). */
  canonical: string | null;
};

/** The made-app document param: always carried in the fragment. */
export const DOC_PARAM = "d";

const splitQuery = (s: string): [string, string] => {
  const i = s.indexOf("?");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
};
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed escape (e.g. /p/100%) → the raw slug, which no app has
  }
};

function routeOf(path: string, params: URLSearchParams): Route {
  const live = path.match(/^\/p\/([^/?#]+)/);
  if (live) return { name: "live", slug: decode(live[1]), params };
  if (path.startsWith("/create")) return { name: "create", params };
  if (path === "/stats" || path === "/stats/") return { name: "stats", params };
  return { name: "home", params };
}

/** Parse a location (path or old hash form) into a route. */
export function parseRoute(loc: { pathname: string; search: string; hash: string }): ParsedRoute {
  const search = new URLSearchParams(loc.search);
  if (search.has("bite")) return { route: { name: "bite", params: search }, canonical: null };
  const hash = loc.hash.replace(/^#/, "");
  if (!hash.startsWith("/")) {
    // Path link. A fragment that is not a route carries params (#d=…, #k=v);
    // the query wins over the fragment for the same key.
    const params = new URLSearchParams(search);
    if (hash) for (const [k, v] of new URLSearchParams(hash)) if (!params.has(k)) params.set(k, v);
    return { route: routeOf(loc.pathname, params), canonical: null };
  }
  // Old hash link: `#/p/slug?room=…`. Its own query wins over one before the `#`.
  const [hashPath, hashQuery] = splitQuery(hash);
  const params = new URLSearchParams(hashQuery);
  for (const [k, v] of search) if (!params.has(k)) params.set(k, v);
  const route = routeOf(hashPath, params);
  const q = params.toString();
  return { route, canonical: route.name === "live" ? playPath(route.slug!, params) : hashPath + (q ? `?${q}` : "") };
}

/** Path + query (+ `#d=` fragment for a made app) for a play link, no origin. */
export function playPath(slug: string, params?: URLSearchParams): string {
  const q = new URLSearchParams(params);
  const d = q.get(DOC_PARAM);
  q.delete(DOC_PARAM);
  const query = q.toString();
  return `/p/${encodeURIComponent(slug)}${query ? `?${query}` : ""}${d ? `#${DOC_PARAM}=${d}` : ""}`;
}

// ── friends-only room codes ──
// A code makes a room unlisted: only people holding the link meet there.
// It is NOT private — serverless rooms ride a public MQTT broker where the
// room id is the topic (packages/snack-room/src/mqttBus.js), so anyone
// subscribing to the prefix sees codes and traffic. Real protection is U1
// (token auth), see docs/master-plan.md §4 Q1.
// 32 symbols — no 0/O or 1/I, so a code read aloud or typed is never ambiguous.
// 32 = 2^5, so one random byte masked to 5 bits is uniform (no modulo bias).
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 10 symbols × 5 bits = 50 bits: not guessable, which is all a code gives. */
export const ROOM_CODE_LENGTH = 10;
/** A link must carry at least this many symbols to count as a room code (40 bits). */
export const ROOM_CODE_MIN = 8;
export const ROOM_CODE_MAX = 32;
export const ROOM_PARAM = "room";
/** Joins the app slug and the code into the room id (MQTT-topic and file-name safe). */
const ROOM_SEP = "~";
/** `?room=` values from before codes existed: they only force a room (catalog.ts needsRoom). */
const LEGACY_ROOM_VALUES = new Set(["", "1", "true"]);

export function newRoomCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/**
 * What a link's `?room=` means:
 *   none    — no param: the app's public room
 *   legacy  — `room=` / `room=1`: a forced room (public), the pre-code semantics
 *   code    — a valid code (case and `-`/space separators are forgiven, nothing else)
 *   invalid — present but not a code (truncated by a chat app, wrong symbols):
 *             never silently the public room — the screen says the link is bad
 */
export type RoomParam = { kind: "none" } | { kind: "legacy" } | { kind: "code"; code: string } | { kind: "invalid"; raw: string };
export function roomParamOf(params: URLSearchParams): RoomParam {
  const raw = params.get(ROOM_PARAM);
  if (raw === null) return { kind: "none" };
  if (LEGACY_ROOM_VALUES.has(raw.trim())) return { kind: "legacy" };
  const code = raw.toUpperCase().replace(/[-\s]/g, "");
  const ok = code.length >= ROOM_CODE_MIN && code.length <= ROOM_CODE_MAX && [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));
  return ok ? { kind: "code", code } : { kind: "invalid", raw };
}

/** The room code a link carries (normalized), or null when it has none / an invalid one. */
export function roomCodeOf(params: URLSearchParams): string | null {
  const r = roomParamOf(params);
  return r.kind === "code" ? r.code : null;
}

/**
 * The room a link lands in, as the transport sees it: the app's public room
 * (`slug`), or `slug~CODE` for a friends-only link. The room engine only ever
 * sees this id (mesh topic / server room key), so it needs no change.
 * Callers must not join on an invalid `?room=` (roomParamOf → "invalid").
 */
export function roomIdFor(slug: string, params: URLSearchParams): string {
  const code = roomCodeOf(params);
  return code ? `${slug}${ROOM_SEP}${code}` : slug;
}

/** Server mode: the app request names the room, so its state is that room's (not the public one's). */
export function appApiPath(slug: string, params: URLSearchParams): string {
  const roomId = roomIdFor(slug, params);
  return `/api/apps/${encodeURIComponent(slug)}${roomId === slug ? "" : `?room=${encodeURIComponent(roomId)}`}`;
}

/** `?make=1`: open the quiz maker (quiz.ts). Only for the device that has it —
    never carried into a link handed to someone else. */
export const MAKE_PARAM = "make";
/** Params that act on this device only (dropped from every shared/derived link). */
const DEVICE_ONLY_PARAMS = [MAKE_PARAM];

/** A link's params without the device-only ones, safe to hand out. */
export function shareableParams(params: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(params);
  for (const k of DEVICE_ONLY_PARAMS) p.delete(k);
  return p;
}

/** The same link, in a friends-only room named by `code` (other params kept, device-only ones dropped). */
export function friendLink(origin: string, slug: string, params: URLSearchParams, code: string): string {
  const p = shareableParams(params);
  p.set(ROOM_PARAM, code);
  return `${origin}${playPath(slug, p)}`;
}

/** The same link without any room param (the public room; device-only params dropped). */
export function publicLink(slug: string, params: URLSearchParams): string {
  const p = shareableParams(params);
  p.delete(ROOM_PARAM);
  return playPath(slug, p);
}
