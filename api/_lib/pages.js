// Cloudflare Pages Functions adapter (docs/cloudflare-pages.md). The handlers in api/*.js are
// Web-standard `(Request) => Response` functions built by createHandler(); Vercel calls them
// directly. Pages calls `onRequest(context)` with `context.request` and `context.env` instead,
// and has no `process.env` of its own. This file is the only Pages-specific code: the same
// createHandler (one source of truth) runs behind it, with three differences:
//  1. env comes from context.env (string vars/secrets only; bindings such as ASSETS are skipped),
//     copied into one stable object so the handler's in-memory state (rate limiter, read cache,
//     memory store) survives across requests in an isolate, as it does in a Vercel instance.
//  2. The client address: on Cloudflare only `cf-connecting-ip` is set by the platform; any
//     `x-vercel-forwarded-for` / `x-forwarded-for` / `x-real-ip` came from the client and could be
//     forged to dodge the per-client limit. They are dropped and `x-forwarded-for` is set to the
//     trusted address (still only hashed in memory by ratelimit.js — never stored or logged).
//  3. The official app list: Workers cannot read snack-server/data/bite/index.json from disk at
//     run time, so the function bundles it (a JSON import) and primes apps.js with it.
import { primeAppIds } from './apps.js';

const FORGEABLE = ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip'];

/** The request as the handlers expect it, with the client address taken only from Cloudflare. */
export function trustedRequest(request) {
  const headers = new Headers(request.headers);
  for (const h of FORGEABLE) headers.delete(h);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  return new Request(request, { headers });
}

/** Copy the string values of context.env into `into` (keys that disappeared are removed). */
function syncEnv(into, env) {
  const src = env && typeof env === 'object' ? env : {};
  for (const k of Object.keys(into)) if (typeof src[k] !== 'string') delete into[k];
  for (const [k, v] of Object.entries(src)) if (typeof v === 'string') into[k] = v;
  return into;
}

/**
 * Build a Pages `onRequest` from an api/*.js createHandler.
 * opts.appList = the parsed index.json (array of {id}); opts.handlerOpts = extra createHandler
 * options (tests only: fetch, now, memoryStore, limiter — never env).
 */
export function pagesFunction(createHandler, { appList, handlerOpts = {} } = {}) {
  if (appList) primeAppIds(appList);
  const env = {};
  const handler = createHandler({ ...handlerOpts, env });
  return async function onRequest(context) {
    syncEnv(env, context.env);
    return handler(trustedRequest(context.request));
  };
}
