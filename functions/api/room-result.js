// Cloudflare Pages Function for /api/room-result — the same handler as Vercel's
// api/room-result.js, through the Pages adapter (api/_lib/pages.js, docs/cloudflare-pages.md).
import { createHandler } from '../../api/room-result.js';
import { pagesFunction } from '../../api/_lib/pages.js';
import appList from '../../snack-server/data/bite/index.json' with { type: 'json' };

export const onRequest = pagesFunction(createHandler, { appList });
