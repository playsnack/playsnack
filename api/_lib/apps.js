// Official app ids (snack-server/data/bite/index.json). Any other id is counted as
// "other", so arbitrary client strings never become storage keys.
import { readFileSync } from 'node:fs';
import path from 'node:path';

let cached = null;

const idSet = (list) => (Array.isArray(list) ? new Set(list.map((t) => t && t.id).filter((id) => typeof id === 'string')) : null);

function tryRead(file) {
  try {
    return idSet(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Use an already-parsed index.json (Cloudflare Pages: no file system at run time, api/_lib/pages.js). */
export function primeAppIds(list) {
  const ids = idSet(list);
  if (ids && ids.size) cached = ids;
}

/** Set of official template ids (empty set if the list could not be read). */
export function appIds() {
  if (cached) return cached;
  // Relative to this module first (statically traceable), then the cwd.
  cached =
    tryRead(new URL('../../snack-server/data/bite/index.json', import.meta.url)) ||
    tryRead(path.join(process.cwd(), 'snack-server/data/bite/index.json')) ||
    new Set();
  return cached;
}

/**
 * Normalize an optional app field: undefined if absent, the id if official, "custom"
 * for a made app, else "other". A room id or play slug is reduced to the app first —
 * `quiz-ox~CODE` / `tpl-quiz-ox` → `quiz-ox`, `app-<hash>` → `custom` — so a friends
 * room code or a made app's hash never becomes a counter.
 */
export function normApp(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return 'other';
  const id = v.replace(/~.*$/s, '').replace(/^tpl-/, '');
  if (appIds().has(id)) return id;
  return /^app-/.test(id) || id === 'custom' ? 'custom' : 'other';
}
