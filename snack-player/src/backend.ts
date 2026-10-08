// The one place the player talks to "the backend". Two modes:
//  - serverless (default): everything is static files + the browser — templates
//    and content from ./data, rooms on a public MQTT broker with a player as host,
//    shared apps carried inside the link itself. Deployable to any static host.
//  - server (VITE_SERVER_URL set): the snack-server API as before. "same-origin" =
//    the server serves this build itself (what the oracle gate plays).
import type { BiteDoc } from "@snack/bite";
import { contentFor, parseContentUrl, type ContentData } from "@snack/content";
import { RelayTransport, ServerTransport, type Identity, type RoomMessage, type RoomTransport } from "./roomTransport";

const SERVER_ENV = (import.meta.env.VITE_SERVER_URL as string | undefined) || "";
export const SERVERLESS = !SERVER_ENV;
export const SERVER_URL = SERVER_ENV === "same-origin" ? "" : SERVER_ENV.replace(/\/$/, "");
const DATA = `${import.meta.env.BASE_URL}data`;
const json = async <T>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json() as Promise<T>;
};

// ── routes (hash routes when serverless: static hosts can't serve /p/… paths) ──
export type Route = { name: "home" | "create" | "live" | "bite"; slug?: string; params: URLSearchParams };
export function currentRoute(): Route {
  const search = new URLSearchParams(location.search);
  if (search.has("bite")) return { name: "bite", params: search };
  const [hashPath, hashQuery = ""] = location.hash.replace(/^#/, "").split("?");
  const path = hashPath.startsWith("/") ? hashPath : location.pathname;
  const params = new URLSearchParams(hashPath.startsWith("/") ? hashQuery : location.search);
  const live = path.match(/^\/p\/([^/]+)/);
  if (live) return { name: "live", slug: decodeURIComponent(live[1]), params };
  if (path.startsWith("/create")) return { name: "create", params };
  return { name: "home", params };
}
export const hrefTo = (path: string) => (SERVERLESS ? `#${path}` : path);

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
    return `${location.origin}/p/${slug}`;
  }
  const data = await encodeDoc(doc);
  return `${location.origin}${location.pathname}#/p/app-${shortHash(data)}?d=${data}`;
}

/** The app a live room plays: a template, a link-carried app, or (server) a saved app. */
export async function loadRoomDoc(slug: string, params: URLSearchParams): Promise<{ doc: BiteDoc; sharedState?: Record<string, unknown> }> {
  if (!SERVERLESS) return json(`${SERVER_URL}/api/apps/${slug}`);
  if (slug.startsWith("tpl-")) return { doc: await getTemplateDoc(slug.slice(4)) };
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
export function createRoom(me: Identity, params: URLSearchParams): RoomTransport {
  if (SERVERLESS) return new MeshTransport(me);
  const ws = (SERVER_URL || location.origin).replace(/^http/, "ws");
  return params.has("host") ? new RelayTransport(`${ws}/relay`, me, `${SERVER_URL}/api/pack`, `${SERVER_URL}/api/events`) : new ServerTransport(`${ws}/ws`, me);
}

/** Serverless room: players meet on a public MQTT broker; one of them hosts. */
class MeshTransport implements RoomTransport {
  private conn: { sendAction(n: string, p: unknown, id: string): void; sendReaction(e: string): void; handoff(): void; close(): void } | null = null;
  private listeners = new Set<(m: RoomMessage) => void>();
  private closed = false;
  private onHidden = () => {
    if (document.visibilityState === "hidden") this.conn?.handoff();
  };
  constructor(private me: Identity) {}
  connect() {
    void Promise.all([import("@snack/room/mesh-client"), import("@snack/room/mqtt-bus")]).then(([{ connectMesh }, { mqttBus }]) => {
      if (this.closed) return;
      this.conn = connectMesh({
        createBus: mqttBus({ room: this.me.slug }),
        me: this.me,
        getPack: (game, opts) => getPack(game, opts),
        onMessage: (m) => this.listeners.forEach((fn) => fn(m as RoomMessage)),
      });
      document.addEventListener("visibilitychange", this.onHidden);
    });
  }
  close() {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onHidden);
    this.conn?.close();
    this.conn = null;
  }
  sendAction(name: string, payload?: unknown) {
    this.conn?.sendAction(name, payload, crypto.randomUUID());
  }
  sendReaction(emoji: string) {
    this.conn?.sendReaction(emoji);
  }
  onMessage(fn: (m: RoomMessage) => void) {
    this.listeners.add(fn);
  }
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
