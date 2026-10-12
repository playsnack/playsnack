// Official app ids (snack-server/data/bite/index.json). Any other id is counted as
// "other", so arbitrary client strings never become storage keys.
import { readFileSync } from 'node:fs';
import path from 'node:path';

let cached = null;

function tryRead(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return null;
    return new Set(list.map((t) => t && t.id).filter((id) => typeof id === 'string'));
  } catch {
    return null;
  }
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

/** Normalize an optional app field: undefined if absent, the id if official, else "other". */
export function normApp(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return 'other';
  return appIds().has(v) ? v : 'other';
}
