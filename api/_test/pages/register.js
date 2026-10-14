// `node --import ./api/_test/pages/register.js --test api/_test/` — the whole api/_test suite
// against the Cloudflare Pages adapter (adapter.js). A resolve hook sends the tests' imports
// of api/ev.js and api/room-result.js to the adapter-wrapped modules in this folder.
import { register } from 'node:module';

const hooks = `
const API = new URL('../../', ${JSON.stringify(import.meta.url)}).href;
const HERE = new URL('./', ${JSON.stringify(import.meta.url)}).href;
const WRAPPED = { [API + 'ev.js']: HERE + 'ev.js', [API + 'room-result.js']: HERE + 'room-result.js' };
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  const to = WRAPPED[r.url];
  if (to && context.parentURL && !context.parentURL.startsWith(HERE)) return { ...r, url: to };
  return r;
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
