// Cloudflare Pages Function for /p/* (#106, docs/link-previews.md): serves the same index.html as
// the static rewrite did (_redirects `/p/* / 200`), with its link-preview meta (og:* / twitter:*,
// <title>) set for this link by HTMLRewriter — a streaming pass, well under the Workers Free
// 10 ms CPU limit. The logic is api/_lib/og.js (Node-tested); this file only wires it.
//
// The quiz room's subject name (`?room=` on the quiz app) and any friends room's scheduled start
// (#218, "오후 8:30 시작") are looked up from the room server — one request — only for link-preview
// crawlers, at most 300 ms, cached per isolate; a person's browser never waits on it. Any failure →
// the app's own preview. Never for a PIN room. ROOM_HTTP_URL (env) overrides the room server address.
import catalog from '../../snack-server/data/bite/index.json' with { type: 'json' };
import manifest from '../../snack-player/public/og/manifest.json' with { type: 'json' };
import { entryFor, isPinCode, isPreviewBot, lookupRoom, metaHandlers, ogMeta, roomCode, slugOf } from '../../api/_lib/og.js';

export const ROOM_HTTP_URL = 'https://snack-room.playsnack.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') return context.next();
  const url = new URL(request.url);
  // The app shell ("/" — Pages answers "/index.html" with a redirect to "/").
  const page = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: request.headers, method: request.method }));
  if (!page.ok || !(page.headers.get('content-type') ?? '').includes('text/html')) return page;

  let room = { about: null, startAt: null };
  const code = roomCode(url.href);
  const slug = slugOf(url.pathname);
  // A PIN room (20-symbol code) is never looked up: its result needs a pass, and its name stays private.
  // Only a catalog app's room (the room id is the link's own slug).
  if (code && !isPinCode(code) && entryFor(slug, catalog) && isPreviewBot(request.headers.get('user-agent'))) {
    const roomBase = typeof env.ROOM_HTTP_URL === 'string' && env.ROOM_HTTP_URL ? env.ROOM_HTTP_URL : ROOM_HTTP_URL;
    room = await lookupRoom({ roomBase, app: slug.slice('tpl-'.length), code });
  }

  const meta = ogMeta({ url: url.href, catalog, manifest, about: room.about, startAt: room.startAt });
  const headers = new Headers(page.headers);
  headers.delete('etag'); // the body differs per link
  headers.delete('content-length');
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.append('vary', 'user-agent');
  const out = new Response(page.body, { status: 200, headers });
  if (request.method === 'HEAD') return out;
  let rw = new HTMLRewriter();
  for (const [sel, h] of metaHandlers(meta)) rw = rw.on(sel, h);
  return rw.transform(out);
}
