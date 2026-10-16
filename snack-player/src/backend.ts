// The one place the player talks to "the backend". Two modes:
//  - serverless (default): everything is static files + the browser — templates
//    and content from ./data, rooms on an MQTT broker (BROKER_URL) with a player as host,
//    shared apps carried inside the link itself. Deployable to any static host.
//  - server (VITE_SERVER_URL set): the snack-server API as before. "same-origin" =
//    the server serves this build itself (what the oracle gate plays).
import type { BiteDoc } from "@snack/bite";
import { contentFor, parseContentUrl, type ContentData } from "@snack/content";
import { EdgeRoomTransport, MeshTransport, RelayTransport, ServerTransport, rememberOrganizerTicket, type EdgeRoomOptions, type Identity, type RoomTransport } from "./roomTransport";
import { appApiPath, newRoomCode, parseRoute, playPath, type Route } from "./links";
import { mintRoom, passes } from "./roomAdmission";
import { templateFileFor } from "./catalog";

const SERVER_ENV = (import.meta.env.VITE_SERVER_URL as string | undefined) || "";
export const SERVERLESS = !SERVER_ENV;
export const SERVER_URL = SERVER_ENV === "same-origin" ? "" : SERVER_ENV.replace(/\/$/, "");
const DATA = `${import.meta.env.BASE_URL}data`;
const json = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json() as Promise<T>;
};

// ── routes: path links (/p/<slug>) in both modes. The static host rewrites
// /p/* to index.html (Cloudflare Pages _redirects); snack-server has the same fallback. Old
// hash links (#/p/…) still open: they are read as the path form and the
// address bar is rewritten in place (no reload). Rules: links.ts.
export type { Route } from "./links";
export function currentRoute(): Route {
  const { route, canonical } = parseRoute(location);
  if (canonical) history.replaceState(history.state, "", canonical);
  return route;
}
/** Kept for callers: links are plain paths now in both modes. */
export const hrefTo = (path: string) => path;
/** Move to another route without a reload (the app re-reads the route on popstate). */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}) {
  if (replace) history.replaceState(history.state, "", path);
  else history.pushState(history.state, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

// ── templates ──
export type TemplateMeta = {
  id: string; title: string; category: string; emoji: string; accent: string; mode: string;
  avg: number; ratingCount: number; useCount: number; rank: number; order?: number;
};
type Index = Array<TemplateMeta & { ratingSum?: number }>;
let indexCache: Promise<Index> | null = null;
const loadIndex = () => (indexCache ??= json<Index>(`${DATA}/bite/index.json`));
const localRatings = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem("snack.rated") || "{}");
  } catch {
    return {};
  }
};

export async function listTemplates(opts: { sort?: string; category?: string } = {}) {
  if (!SERVERLESS) return json<{ templates: TemplateMeta[]; categories: string[] }>(`${SERVER_URL}/api/templates?${new URLSearchParams(opts as Record<string, string>)}`);
  const all = await loadIndex();
  const mine = localRatings();
  let list = all.map((t, i) => ({ ...t, avg: mine[t.id] ?? 0, ratingCount: mine[t.id] ? 1 : 0, useCount: 0, rank: 0, order: t.order ?? i }));
  if (opts.category && opts.category !== "all") list = list.filter((t) => t.category === opts.category);
  const by: Record<string, (a: TemplateMeta, b: TemplateMeta) => number> = {
    rating: (a, b) => b.avg - a.avg || (a.order ?? 0) - (b.order ?? 0),
    recent: (a, b) => (b.order ?? 0) - (a.order ?? 0),
  };
  list.sort(by[opts.sort ?? ""] ?? ((a, b) => (a.order ?? 0) - (b.order ?? 0)));
  return { templates: list, categories: [...new Set(all.map((t) => t.category))] };
}

export async function getTemplateDoc(id: string): Promise<BiteDoc> {
  if (!SERVERLESS) return (await json<{ doc: BiteDoc }>(`${SERVER_URL}/api/templates/${id}`)).doc;
  return json<BiteDoc>(`${DATA}/bite/${id}.bite.json`);
}

/** Ratings are per-device when serverless (no shared tally without a server). */
export async function rateTemplate(id: string, stars: number) {
  if (SERVERLESS) return null;
  const r = await fetch(`${SERVER_URL}/api/templates/${id}/rate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stars }) });
  return r.json();
}

// ── shared apps: the document travels inside the link ──
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pipe = async (bytes: Uint8Array, stream: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
export async function encodeDoc(doc: BiteDoc) {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(doc)), new CompressionStream("deflate-raw")));
}
export async function decodeDoc(data: string): Promise<BiteDoc> {
  return JSON.parse(new TextDecoder().decode(await pipe(unb64url(data), new DecompressionStream("deflate-raw"))));
}
const shortHash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
};

/** Share a made/edited app → a link anyone can open (and play together in). */
export async function shareApp(doc: BiteDoc): Promise<string> {
  if (!SERVERLESS) {
    const r = await fetch(`${SERVER_URL}/api/apps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc }) });
    const { slug } = await r.json();
    return `${location.origin}${playPath(slug)}`;
  }
  const data = await encodeDoc(doc);
  return `${location.origin}${playPath(`app-${shortHash(data)}`, new URLSearchParams({ d: data }))}`;
}

/** The app a live room plays: a template, a link-carried app, or (server) a saved app.
    Server mode names the room (`?room=`), so the state that comes back is that room's. */
export async function loadRoomDoc(slug: string, params: URLSearchParams): Promise<{ doc: BiteDoc; sharedState?: Record<string, unknown> }> {
  if (!SERVERLESS) return json(`${SERVER_URL}${appApiPath(slug, params)}`);
  // An entry may play another entry's file (catalog `template`, e.g. 스피드 퀴즈 → the quiz template).
  if (slug.startsWith("tpl-")) return { doc: await getTemplateDoc(await templateFileFor(slug.slice(4))) };
  const d = params.get("d");
  if (slug.startsWith("app-") && d) return { doc: await decodeDoc(d) };
  throw new Error("이 링크로는 앱을 찾을 수 없어요");
}

// ── content (data.url) and multiplayer round packs ──
let contentData: Promise<ContentData> | null = null;
const loadContentData = () =>
  (contentData ??= Promise.all([
    json(`${DATA}/seed-content/content.json`),
    ...["songs", "idols", "singers"].map((p) => json<{ items: unknown[] }>(`${DATA}/pools/${p}.json`).then((j) => j.items).catch(() => [])),
  ]).then(([bank, songs, idols, singers]) => ({ bank, pools: { songs, idols, singers } } as ContentData)));

export async function loadAppData(url: string): Promise<Record<string, unknown> | null> {
  const q = parseContentUrl(url);
  if (SERVERLESS || !q) {
    if (!q) return null;
    return contentFor(q.kind, q.theme, await loadContentData());
  }
  const r = await fetch(`${SERVER_URL}${url}`);
  return r.ok ? r.json() : null;
}

export async function getPack(game: string, opts: { theme?: string } = {}): Promise<unknown[] | null> {
  if (!game) return null;
  if (!SERVERLESS) {
    const r = await fetch(`${SERVER_URL}/api/pack?${new URLSearchParams({ game, theme: opts.theme ?? "" })}`).catch(() => null);
    return r?.ok ? ((await r.json()).pack ?? null) : null;
  }
  return json<unknown[]>(`${DATA}/multi-content/${game}.json`).catch(() => null);
}

// ── rooms ──
// Serverless rooms meet on ONE broker per deployment: the room package default
// (hivemq), or VITE_BROKER_URL set at build time (the gate points it at a local broker).
// Never per client — players on different brokers would never meet.
export const BROKER_URL = (import.meta.env.VITE_BROKER_URL as string | undefined) || undefined;
// Edge rooms (edge/room, docs/edge-rooms.md), e.g. wss://snack-room.<account>.workers.dev.
// Set → the room engine runs in a Durable Object per room (server-authoritative);
// VITE_ROOM_MODE=relay instead keeps the player-hosted mesh, over the edge relay.
// Unset (the default) → the MQTT broker above. Build time only, never per client.
export const ROOM_URL = (import.meta.env.VITE_ROOM_URL as string | undefined) || undefined;
const ROOM_MODE = (import.meta.env.VITE_ROOM_MODE as string | undefined) || "game";
/** The room engine runs on the edge room server (not on a player's phone): it saves results itself. */
export const EDGE_ROOM_SERVER = ROOM_URL && ROOM_MODE !== "relay" ? ROOM_URL : undefined;
// Room ids this page has just made a new code for (nobody can be in them yet): their
// first join skips the mesh's wait for an existing host. In memory, used once.
const freshRooms = new Set<string>();
export const markFreshRoom = (roomId: string) => void freshRooms.add(roomId);
/** Whether this page made the room a moment ago (read before createRoom, which uses it up). */
export const isFreshRoom = (roomId: string) => freshRooms.has(roomId);
/**
 * A new friends room for `slug` (🤝 친구끼리, the quiz maker, a PIN): with the room server, the
 * server makes the code (/mint, roomAdmission.ts) — this device keeps the organizer ticket (it
 * hosts, #135) and, with a PIN, its pass and the PIN (shown again in its invite sheet). Without
 * one (dev / mesh), a code made here. Never throws; `error` = mint's reason.
 */
export async function newFriendRoom(slug: string, o: { pin?: string; anonId?: string } = {}): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  if (!EDGE_ROOM_SERVER) {
    const code = newRoomCode();
    markFreshRoom(`${slug}~${code}`);
    return { ok: true, code };
  }
  const r = await mintRoom(EDGE_ROOM_SERVER, slug, o);
  if (!r.ok) return r;
  const roomId = `${slug}~${r.code}`;
  rememberOrganizerTicket(roomId, r.org);
  if (r.pass) passes.set(roomId, r.pass, o.pin);
  markFreshRoom(roomId);
  return { ok: true, code: r.code };
}

/** `edge.pin`: the PIN just typed for a PIN room (edge rooms only; the transport wipes it once in). */
export function createRoom(me: Identity, params: URLSearchParams, edge: EdgeRoomOptions = {}): RoomTransport {
  if (EDGE_ROOM_SERVER) {
    freshRooms.delete(me.slug);
    return new EdgeRoomTransport(EDGE_ROOM_SERVER, me, edge);
  }
  if (SERVERLESS) return new MeshTransport(me, BROKER_URL, (game, opts) => getPack(game, opts), freshRooms.delete(me.slug), ROOM_MODE === "relay" ? ROOM_URL : undefined);
  const ws = (SERVER_URL || location.origin).replace(/^http/, "ws");
  return params.has("host") ? new RelayTransport(`${ws}/relay`, me, `${SERVER_URL}/api/pack`, `${SERVER_URL}/api/events`) : new ServerTransport(`${ws}/ws`, me);
}

// ── server-only features ──
export const AI_UNAVAILABLE = "지금은 AI로 새로 만들기를 쓸 수 없어요. 아래 템플릿을 골라 ✏️ 직접 편집으로 바꿔 보세요.";
export async function buildWithAi(body: unknown): Promise<{ valid: boolean; doc?: BiteDoc; error?: string; summary?: string; multiplayer?: boolean }> {
  if (SERVERLESS) return { valid: false, error: AI_UNAVAILABLE };
  const res = await fetch(`${SERVER_URL}/api/builder/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { valid: false, error: res.ok ? "서버 응답을 읽지 못했어요. 잠시 후 다시 시도해주세요." : `서버가 응답하지 않아요 (${res.status}).` };
  }
}
/** Live platform pulse (server only): who's playing where, the global leaderboard. */
export async function loadLive() {
  if (SERVERLESS) return null;
  return json<Record<string, unknown>>(`${SERVER_URL}/api/live`);
}
