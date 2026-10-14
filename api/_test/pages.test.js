// The Cloudflare Pages adapter (api/_lib/pages.js, docs/cloudflare-pages.md) and the Pages
// Functions that use it (functions/api/*.js). The rest of api/_test also runs through the
// adapter: `node --import ./api/_test/pages/register.js --test api/_test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as evHandler } from '../ev.js';
import { pagesFunction, trustedRequest } from '../_lib/pages.js';
import { createLimiter } from '../_lib/ratelimit.js';
import { onRequest as evFunction } from '../../functions/api/ev.js';
import { onRequest as rrFunction } from '../../functions/api/room-result.js';

const BASE = 'https://test.playsnack.pages.dev';
const beacon = (events, headers = {}) =>
  new Request(`${BASE}/api/ev`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers }, body: JSON.stringify({ v: 1, events }) });

test('trustedRequest: client-sent forwarding headers are dropped, cf-connecting-ip is the address', () => {
  const r = trustedRequest(
    new Request(`${BASE}/api/ev`, { headers: { 'x-vercel-forwarded-for': '1.1.1.1', 'x-forwarded-for': '2.2.2.2', 'x-real-ip': '3.3.3.3', 'cf-connecting-ip': '203.0.113.9' } }),
  );
  assert.equal(r.headers.get('x-vercel-forwarded-for'), null);
  assert.equal(r.headers.get('x-real-ip'), null);
  assert.equal(r.headers.get('x-forwarded-for'), '203.0.113.9');
  const none = trustedRequest(new Request(`${BASE}/api/ev`, { headers: { 'x-forwarded-for': '2.2.2.2' } }));
  assert.equal(none.headers.get('x-forwarded-for'), null, 'no Cloudflare address → "unknown", never the forged one');
});

test('a forged x-vercel-forwarded-for cannot dodge the per-client limit on Pages', async () => {
  const limiter = createLimiter({ bucketSize: 2, refillPerSec: 0 });
  const onRequest = pagesFunction(evHandler, { handlerOpts: { limiter } });
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const request = beacon([{ k: 'open', route: 'home' }], { 'cf-connecting-ip': '203.0.113.9', 'x-vercel-forwarded-for': `10.0.0.${i}` });
    statuses.push((await onRequest({ request, env: {} })).status);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});

test('env comes from context.env per request (strings only); in-memory state survives across requests', async () => {
  const onRequest = pagesFunction(evHandler);
  const env = { ASSETS: { fetch() {} }, EV_DAILY_CAP: '1000' };
  for (let i = 0; i < 3; i++) {
    const r = await onRequest({ request: beacon([{ k: 'open', route: 'home' }], { 'cf-connecting-ip': `203.0.113.${i}` }), env });
    assert.equal(r.status, 200);
  }
  const body = await (await onRequest({ request: new Request(`${BASE}/api/ev`), env })).json();
  assert.equal(body.store, 'memory');
  assert.equal(body.counters.page_opens, 3, 'the memory store is the same object across requests');
});

test('functions/api/*.js: onRequest wired to the real handlers, official app ids bundled', async () => {
  const post = await evFunction({ request: beacon([{ k: 'open', route: 'app', app: 'tpl-tap-battle' }], { 'cf-connecting-ip': '198.51.100.7' }), env: {} });
  assert.equal(post.status, 200);
  const day = await (await evFunction({ request: new Request(`${BASE}/api/ev`), env: {} })).json();
  assert.equal(day.ok, true);
  assert.equal(day.store, 'memory');
  assert.ok(day.appsKnown > 40, 'index.json reached apps.js');
  assert.equal(day.counters['page_opens_by_app:tap-battle'], 1, 'an official app is counted under its id, not "other"');
  const miss = await rrFunction({ request: new Request(`${BASE}/api/room-result?room=${encodeURIComponent('tpl-speed-trivia-score~QWERTYZ234')}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } }), env: {} });
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('x-rr-store'), 'memory');
});
