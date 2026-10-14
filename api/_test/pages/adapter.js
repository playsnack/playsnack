// The api/_test suite, run through the Cloudflare Pages adapter (docs/cloudflare-pages.md):
//   node --import ./api/_test/pages/register.js --test api/_test/
// register.js points every test's `import … from '../ev.js'` / `'../room-result.js'` at
// ./ev.js / ./room-result.js, whose createHandler(opts) returns a handler that goes through
// pagesFunction() exactly as functions/api/*.js do: env arrives as context.env on every
// request, and the client address arrives the way Cloudflare's edge sends it
// (cf-connecting-ip; the adapter drops client-sent forwarding headers).
import { pagesFunction } from '../../_lib/pages.js';

/** What Cloudflare's edge does before the function runs: the client address in cf-connecting-ip. */
function atEdge(request) {
  const h = request.headers;
  const ip = (h.get('x-vercel-forwarded-for') || h.get('x-forwarded-for') || h.get('x-real-ip') || '').split(',')[0].trim();
  if (!ip) return request;
  const headers = new Headers(h);
  headers.set('cf-connecting-ip', ip);
  return new Request(request, { headers });
}

export function viaPages(createHandler) {
  return (opts = {}) => {
    const { env, ...handlerOpts } = opts;
    const onRequest = pagesFunction(createHandler, { handlerOpts });
    return (request) => onRequest({ request: atEdge(request), env: env || process.env });
  };
}
