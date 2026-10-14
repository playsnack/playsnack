// One-off: delete the OLD anonymous-stats keys (`ev:*`, written 2026-10-13/14 while
// testing) from Upstash. Nothing reads them since the readable `stats:*` scheme
// (docs/telemetry.md §3). Never runs on its own — only when a person runs it by hand.
//
//   UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… node api/_tools/cleanup-old-keys.mjs
//       → lists the `ev:*` keys and how many commands the listing used; changes nothing
//   … node api/_tools/cleanup-old-keys.mjs --yes
//       → deletes exactly those keys, then adds every command it used to this month's
//         stats:budget:<YYYY-MM> counter (so the free-plan guard, §5a, stays exact)
//
// Easier alternative: Upstash console → Data Browser → search `ev:*` → delete.
// Only keys starting with `ev:` are ever deleted (checked per key, not just by the pattern).
import { pathToFileURL } from 'node:url';
import { kstMonth } from '../_lib/day.js';
import { budgetKey, BUDGET_TTL_SECONDS, kvConfig, OLD_KEY_PATTERN } from '../_lib/store.js';

const OLD = /^ev:/;
const SCAN_COUNT = 500; // keys Upstash looks at per SCAN (1 command each)
const DEL_CHUNK = 100; // keys per DEL (1 command each)

/**
 * List (and with yes: delete) the old keys. Returns { keys, commands, deleted }.
 * `commands` = every Redis command this run sent (SCANs, DELs and the budget INCRBY/EXPIRE).
 */
export async function cleanupOldKeys({ cfg, fetch = globalThis.fetch, yes = false, now = Date.now(), log = console.log }) {
  let commands = 0;
  const send = async (cmds) => {
    commands += cmds.length;
    const res = await fetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const out = await res.json();
    if (!Array.isArray(out) || out.length !== cmds.length || out.some((r) => !r || r.error)) throw new Error('Upstash command error');
    return out.map((r) => r.result);
  };

  const keys = new Set();
  let cursor = '0';
  do {
    const [[next, batch]] = await send([['SCAN', cursor, 'MATCH', OLD_KEY_PATTERN, 'COUNT', SCAN_COUNT]]);
    for (const k of batch) if (OLD.test(k)) keys.add(k);
    cursor = String(next);
  } while (cursor !== '0');
  const list = [...keys].sort();
  for (const k of list) log(`  ${k}`);
  log(`old keys (ev:*): ${list.length}`);

  if (!yes) {
    log(`commands used to list: ${commands} (not added to the budget counter; nothing changed)`);
    log('to delete them: run again with --yes');
    return { keys: list, commands, deleted: 0 };
  }
  let deleted = 0;
  for (let i = 0; i < list.length; i += DEL_CHUNK) {
    const [n] = await send([['DEL', ...list.slice(i, i + DEL_CHUNK)]]);
    deleted += Number(n) || 0;
  }
  const bk = budgetKey(kstMonth(now));
  const total = commands + 2; // + the INCRBY and EXPIRE below
  await send([['INCRBY', bk, total], ['EXPIRE', bk, BUDGET_TTL_SECONDS]]);
  log(`deleted: ${deleted} · commands used: ${commands} (added to ${bk})`);
  return { keys: list, commands, deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = kvConfig(process.env);
  if (!cfg) {
    console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash console → REST API).');
    process.exit(2);
  }
  cleanupOldKeys({ cfg, yes: process.argv.includes('--yes') }).catch((e) => {
    console.error(String(e && e.message));
    process.exit(1);
  });
}
