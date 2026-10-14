// Cloudflare Pages Function for /api/ev — the same handler as Vercel's api/ev.js, through
// the Pages adapter (api/_lib/pages.js, docs/cloudflare-pages.md). No logic lives here.
import { createHandler } from '../../api/ev.js';
import { pagesFunction } from '../../api/_lib/pages.js';
import appList from '../../snack-server/data/bite/index.json' with { type: 'json' };

export const onRequest = pagesFunction(createHandler, { appList });
