// Readable key scheme (docs/telemetry.md §3): key names, the old → new field mapping,
// and the one-off cleanup of the old `ev:*` keys.
// node --test api/_test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_KEY, budgetKey, dayKey, errKey, onceKey, roomResultKey, TOTAL_FIELD, createMemoryStore } from '../_lib/store.js';
import { normalizeEvent, parseBatch, settleOnce } from '../_lib/schema.js';
import { cleanupOldKeys } from '../_tools/cleanup-old-keys.mjs';

test('key names: stats:<what>:<when>, lowercase English', () => {
  assert.equal(dayKey('2026-10-14'), 'stats:daily:2026-10-14');
  assert.equal(errKey('2026-10-14'), 'stats:errors:2026-10-14');
  assert.equal(ALL_KEY, 'stats:all_time');
  assert.equal(budgetKey('2026-10'), 'stats:budget:2026-10');
  assert.equal(onceKey('0123456789abcdef0123456789abcdef'), 'stats:dedupe:0123456789abcdef0123456789abcdef');
  assert.equal(roomResultKey('ab12'), 'results:room:ab12');
  assert.equal(TOTAL_FIELD, 'events_total');
});

// Every field the old scheme could write, with the event that wrote it, and its new name.
// (`<app>` = quiz-ox here; every other enumerated value maps the same way.)
const SID = 'sidAAAAAAAAAAAAAAAA1';
const OLD_TO_NEW = [
  [{ k: 'open', route: 'app', app: 'quiz-ox' }, {
    'open|n': 'page_opens', 'open|route|app': 'page_opens_by_route:app', 'open|app|quiz-ox': 'page_opens_by_app:quiz-ox' }],
  [{ k: 'first_tap', ms: 1500, app: 'quiz-ox' }, {
    'first_tap|n': 'first_taps', 'first_tap_ms|le2000': 'first_tap_ms_bucket:1-2s', 'first_tap|app|quiz-ox': 'first_taps_by_app:quiz-ox' }],
  [{ k: 'result', app: 'quiz-ox' }, { 'result|n': 'results_shown', 'result|app|quiz-ox': 'results_shown_by_app:quiz-ox' }],
  [{ k: 'share', method: 'kakao', what: 'invite', app: 'quiz-ox' }, {
    'share|n': 'shares', 'share|method|kakao': 'shares_by_method:kakao', 'share|what|invite': 'shares:invite', 'share|app|quiz-ox': 'shares_by_app:quiz-ox' }],
  [{ k: 'room_join', ok: true, ms: 1800, room: 'friend', app: 'quiz-ox' }, {
    'room_join|n': 'join_attempts', 'room_join|ok': 'joins_ok', 'room_join_ms|ok|le2000': 'join_ms_bucket:1-2s',
    'room_join|room|friend|ok': 'joins_ok_by_room:friend', 'room_join|app|quiz-ox': 'join_attempts_by_app:quiz-ox' }],
  [{ k: 'room_join', ok: false, ms: 15000, room: 'public', reason: 'silence' }, {
    'room_join|n': 'join_attempts', 'room_join|fail': 'joins_failed', 'room_join_ms|fail|le15000': 'join_failed_ms_bucket:10s+',
    'room_join|room|public|fail': 'joins_failed_by_room:public', 'room_join|reason|silence': 'join_failed_reason:silence' }],
  [{ k: 'err', msg: 'TypeError: x', where: 'room', build: 'g1a2b3c' }, {
    'err|n': 'errors_total', 'err|where|room': 'errors_by_where:room', 'err|build|g1a2b3c': 'errors_by_build:g1a2b3c' }],
  [{ k: 'session_done', p: 4, sid: SID, about: true, ans: 3, app: 'quiz-ox' }, {
    'session_done|n': 'games_finished', 'session_done|p|4-5': 'games_finished_by_players:4-5',
    'session_done|about|true': 'games_finished_quiz_kind:about_someone', 'session_done|ans|3': 'games_finished_by_answerers:3',
    'session_done|app|quiz-ox': 'games_finished_by_app:quiz-ox', 'session_done|p3': 'games_finished_3plus',
    'session_done|app3|quiz-ox': 'games_finished_3plus_by_app:quiz-ox' }],
  [{ k: 'session_done', p: 2, sid: SID, about: false, ans: 0 }, {
    'session_done|n': 'games_finished', 'session_done|p|2': 'games_finished_by_players:2',
    'session_done|about|false': 'games_finished_quiz_kind:default_quiz', 'session_done|ans|0': 'games_finished_by_answerers:0' }],
  [{ k: 'rematch', p: 3, sid: SID, app: 'quiz-ox' }, {
    'rematch|n': 'rematches', 'rematch|p|3': 'rematches_by_players:3', 'rematch|app|quiz-ox': 'rematches_by_app:quiz-ox' }],
  [{ k: 'room_create', app: 'quiz-ox' }, { 'room_create|n': 'rooms_created', 'room_create|app|quiz-ox': 'rooms_created_by_app:quiz-ox' }],
  [{ k: 'game_created', source: 'remake', gid: SID, app: 'quiz-ox' }, {
    'game_created|n': 'quizzes_created', 'game_created|source|remake': 'quizzes_created_remake', 'game_created|app|quiz-ox': 'quizzes_created_by_app:quiz-ox' }],
  [{ k: 'game_created', source: 'editor', gid: SID }, { 'game_created|n': 'quizzes_created', 'game_created|source|editor': 'quizzes_created_editor' }],
  [{ k: 'ask_shown', app: 'quiz-ox' }, { 'ask_shown|n': 'asked_again', 'ask_shown|app|quiz-ox': 'asked_again_by_app:quiz-ox' }],
  [{ k: 'ask_answer', a: 'no', why: 'laggy', app: 'quiz-ox' }, {
    'ask_answer|n': 'answered_again', 'ask_answer|a|no': 'answered_again_no', 'ask_answer|why|laggy': 'answered_again_no_reason:laggy',
    'ask_answer|app|quiz-ox|no': 'answered_again_no_by_app:quiz-ox' }],
  [{ k: 'ask_answer', a: 'yes' }, { 'ask_answer|n': 'answered_again', 'ask_answer|a|yes': 'answered_again_yes' }],
  [{ k: 'ask_answer', a: 'skip' }, { 'ask_answer|n': 'answered_again', 'ask_answer|a|skip': 'answered_again_skip' }],
];

test('field mapping: every old field has exactly one readable new name', () => {
  for (const [ev, map] of OLD_TO_NEW) {
    const n = normalizeEvent(ev);
    assert.ok(n, JSON.stringify(ev));
    assert.deepEqual([...n.fields].sort(), Object.values(map).sort(), JSON.stringify(ev));
    for (const f of n.fields) assert.match(f, /^[a-z0-9_]+(:[A-Za-z0-9_.+-]+)?$/, f);
  }
  // Duplicates, rejected events and the all-time hash.
  const done = { k: 'session_done', p: 3, sid: SID, app: 'quiz-ox' };
  const made = { k: 'game_created', source: 'editor', gid: SID };
  const p = parseBatch(JSON.stringify({ v: 1, events: [done, done, made, { k: 'rematch', p: 3, sid: SID }, { k: 'open', route: 'nope' }] }));
  settleOnce(p, [true, false, false]);
  assert.equal(p.incr.get('games_finished_duplicates'), 1); // old session_done|dup (same batch)
  assert.equal(p.incr.get('quizzes_created_duplicates'), 1); // old game_created|dup
  assert.equal(p.incr.get('rematches_duplicates'), 1); // old rematch|dup
  assert.equal(p.incr.get('rejected_events:open'), 1); // old open|bad
  assert.deepEqual(Object.fromEntries(p.all), { games_finished: 1, games_finished_3plus: 1, players_in_finished_games: 3 }); // old ev:all fields + 연인원
  assert.deepEqual(Object.fromEntries(p.monthly), { games_finished: 1, games_finished_3plus: 1, players_in_finished_games: 3 });
});

test('the memory store uses the same readable keys', async () => {
  const m = createMemoryStore();
  await m.apply('2026-10-14', new Map([['games_finished', 1]]), new Map([['TypeError: x', 1]]), 1, new Map([['games_finished', 1]]));
  await m.claim(['0123456789abcdef0123456789abcdef']);
  assert.deepEqual([...m.data.keys()].sort(), ['stats:all_time', 'stats:daily:2026-10-14', 'stats:errors:2026-10-14']);
  assert.deepEqual([...m.once.keys()], ['stats:dedupe:0123456789abcdef0123456789abcdef']);
  assert.deepEqual(Object.fromEntries(m.data.get('stats:daily:2026-10-14')), { events_total: 1, games_finished: 1 });
});

/** Fake Upstash with SCAN (two pages) and multi-key DEL; counts every command. */
function fakeUpstash(keys) {
  const db = new Map(keys.map((k) => [k, 1]));
  const sent = [];
  const fetch = async (_url, init) => {
    const cmds = JSON.parse(init.body);
    sent.push(...cmds);
    const out = cmds.map(([cmd, ...a]) => {
      if (cmd === 'SCAN') {
        const all = [...db.keys()].filter((k) => k.startsWith('ev:')).sort();
        const half = Math.ceil(all.length / 2);
        return { result: a[0] === '0' ? ['7', all.slice(0, half)] : ['0', all.slice(half)] };
      }
      if (cmd === 'DEL') return { result: a.filter((k) => db.delete(k)).length };
      if (cmd === 'INCRBY') { db.set(a[0], (db.get(a[0]) || 0) + a[1]); return { result: db.get(a[0]) }; }
      if (cmd === 'EXPIRE') return { result: 1 };
      return { error: 'ERR' };
    });
    return new Response(JSON.stringify(out));
  };
  return { db, sent, fetch };
}

test('cleanup-old-keys: lists only without --yes; deletes only ev:* and meters its commands', async () => {
  const OLD = ['ev:2026-10-13', 'ev:2026-10-13:err', 'ev:all', 'ev:budget:2026-10', 'ev:once:abc'];
  const KEEP = ['stats:daily:2026-10-14', 'stats:budget:2026-10', 'results:room:x'];
  const up = fakeUpstash([...OLD, ...KEEP]);
  const cfg = { url: 'https://fake-upstash.test', token: 't' };
  const lines = [];
  const now = Date.parse('2026-10-14T03:00:00Z');
  const dry = await cleanupOldKeys({ cfg, fetch: up.fetch, now, log: (l) => lines.push(l) });
  assert.deepEqual(dry.keys, OLD);
  assert.equal(dry.deleted, 0);
  assert.equal(dry.commands, 2); // two SCAN pages
  assert.ok(up.sent.every(([c]) => c === 'SCAN'), 'a dry run never writes');
  assert.equal(up.db.size, OLD.length + KEEP.length);
  assert.ok(lines.some((l) => l.includes('--yes')));

  up.sent.length = 0;
  const budgetBefore = up.db.get('stats:budget:2026-10');
  const run = await cleanupOldKeys({ cfg, fetch: up.fetch, now, yes: true, log: () => {} });
  assert.equal(run.deleted, OLD.length);
  assert.deepEqual([...up.db.keys()].sort(), [...KEEP].sort());
  assert.equal(run.commands, up.sent.length, 'every command counted');
  assert.equal(up.db.get('stats:budget:2026-10') - budgetBefore, up.sent.length, 'and added to the month budget');
  for (const [c, ...a] of up.sent) if (c === 'DEL') for (const k of a) assert.match(k, /^ev:/);
});
