// Event schema for POST /api/ev. Turns a client batch into counter increments.
// Only whitelisted kinds/values survive; nothing that identifies a person (IP, UA,
// nickname, cookie, device id) is ever read. The original six kinds ignore unknown
// fields; the free-beta kinds (docs/telemetry.md §9) drop an event with any field
// outside their list. `sid` / `gid` (host-engine ids for a game / a made quiz) are only
// ever hashed, for de-duplication — never stored or counted as is.
import { createHash } from 'node:crypto';
import { normApp } from './apps.js';

export const VERSION = 1;
export const MAX_BODY_BYTES = 4096;
export const MAX_EVENTS = 20;
export const MAX_MS = 10 * 60 * 1000;
/** Duration histogram edges (ms, upper bound inclusive) and their stored labels; last = above the last edge. */
export const MS_EDGES = [1000, 2000, 3000, 5000, 10000];
export const TIME_BUCKETS = ['0-1s', '1-2s', '2-3s', '3-5s', '5-10s', '10s+'];

export const ROUTES = new Set(['home', 'app', 'room', 'create', 'other']);
export const SHARE_METHODS = new Set(['web', 'kakao', 'copy', 'save', 'other']);
export const KINDS = [
  'open', 'first_tap', 'result', 'share', 'room_join', 'err',
  // free-beta metrics (docs/telemetry.md §9)
  'session_done', 'rematch', 'room_create', 'game_created', 'ask_shown', 'ask_answer',
  // unique-device estimate (docs/telemetry.md §4a): at most once per KST day per browser
  'seen',
];
export const SHARE_WHATS = new Set(['invite', 'result', 'app', 'other']);
export const ROOM_KINDS = new Set(['public', 'friend']);
// subscribe = broker reached but the room topic subscription failed; silence = no room traffic for 15 s.
export const JOIN_FAIL_REASONS = new Set(['bad_link', 'not_found', 'network', 'timeout', 'unreachable', 'disconnected', 'refused', 'subscribe', 'silence', 'other']);
export const GAME_SOURCES = new Set(['editor', 'remake']);
export const ASK_ANSWERS = new Set(['yes', 'no', 'skip']);
export const ASK_REASONS = new Set(['boring', 'hard', 'laggy', 'few', 'other']);
export const MAX_PLAYERS = 1000;
/**
 * Flip to true in the commit that makes the app send the free-beta kinds (§9.5), so a
 * reader of GET /api/ev never takes "0 games" for a measurement while nothing is wired.
 */
export const WIRED = true;
const KNOWN = new Set(KINDS);
/**
 * A browser's own usage, sent only as buckets in its once-a-day `seen` report (the counters stay
 * in that browser — snack-player/src/deviceStats.ts uses the same lists). Event field -> stored prefix.
 */
export const USAGE_BUCKETS = {
  uses: { prefix: 'devices_by_active_days:', values: new Set(['1', '2-3', '4-7', '8-14', '15-30', '31+']) },
  games: { prefix: 'devices_by_games:', values: new Set(['0', '1', '2-4', '5-9', '10-19', '20-49', '50+']) },
  made: { prefix: 'devices_by_made:', values: new Set(['0', '1', '2-4', '5+']) },
  age: { prefix: 'devices_by_age:', values: new Set(['0', '1-6', '7-29', '30-89', '90+']) },
};
/** A browser's random id for the unique-device estimate: 128 bits, base64url, no padding. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** A host-engine id (`sid` game, `gid` made quiz): 16–32 URL-safe chars (docs/telemetry.md §9). */
export const SID_RE = /^[A-Za-z0-9_-]{16,32}$/;

// Strict field lists for the free-beta kinds: any other key drops the event.
const STRICT_KEYS = {
  session_done: new Set(['k', 'app', 'p', 'sid', 'about', 'ans']),
  rematch: new Set(['k', 'app', 'p', 'sid']),
  room_create: new Set(['k', 'app']),
  game_created: new Set(['k', 'app', 'source', 'gid']),
  ask_shown: new Set(['k', 'app']),
  ask_answer: new Set(['k', 'app', 'a', 'why']),
  seen: new Set(['k', 'd', 'uses', 'games', 'made', 'age']),
};

/** Player-count bucket: 1 · 2 · 3 · 4-5 · 6-8 · 9+. */
export function playerBucket(p) {
  if (p <= 3) return String(p);
  if (p <= 5) return '4-5';
  if (p <= 8) return '6-8';
  return '9+';
}

function validPlayers(v, min = 1) {
  return Number.isInteger(v) && v >= min && v <= MAX_PLAYERS;
}
const validId = (v) => typeof v === 'string' && SID_RE.test(v);

/** De-dup id for a host-engine event: hash of kind + sid (the sid itself is never kept). */
export function onceId(k, sid) {
  return createHash('sha256').update(`${k}\0${sid}`).digest('hex').slice(0, 32);
}

/** Histogram bucket for a duration: 730 -> "0-1s", 1000 -> "0-1s", 1001 -> "1-2s", 12000 -> "10s+". */
export function timeBucket(ms) {
  const i = MS_EDGES.findIndex((e) => ms <= e);
  return TIME_BUCKETS[i < 0 ? MS_EDGES.length : i];
}

function validMs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS;
}

/** Short identifier (where/build) or undefined when absent; "other" when malformed. */
function ident(v, max) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return 'other';
  return new RegExp(`^[A-Za-z][A-Za-z0-9_.-]{0,${max - 1}}$`).test(v) ? v : 'other';
}

/**
 * Strip anything that could carry personal or high-cardinality data from an error
 * message: quoted strings, URLs, emails, key=value values, path-like tokens (incl.
 * user-agent product tokens), non-ASCII text (e.g. Korean nicknames), long hex ids,
 * letter+digit tokens (handles like user42) and numbers. Result is ASCII,
 * single-spaced, at most 100 chars. A bare ASCII-letters-only word (a nickname
 * such as "scott" typed unquoted into an error message) is indistinguishable from
 * a word and is NOT removed — see docs/telemetry.md §4.
 */
export function sanitizeErr(msg) {
  let s = String(msg).slice(0, 1000);
  s = s.replace(/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g, '<str>');
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
  s = s.replace(/\bwww\.\S+/gi, '<url>');
  s = s.replace(/[^\s@<>()"']+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>');
  s = s.replace(/=[^\s,;&]+/g, '=<v>'); // key=value data (cookies, query strings, ua=...)
  s = s.replace(/[^\s()<>]*\/[^\s()<>]*/g, '<path>'); // paths and UA product tokens (Foo/1.2)
  s = s.replace(/[^\x00-\x7f]+/g, '?');
  s = s.replace(/\b[0-9a-f]{8,}\b/gi, '#');
  s = s.replace(/\b(?=[A-Za-z_]*\d)(?=\d*[A-Za-z_])[A-Za-z0-9_]{2,}\b/g, '?'); // letter+digit tokens (user42, scott123)
  s = s.replace(/\d+(?:\.\d+)?/g, '#');
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 100);
}

/**
 * Readable stored names (docs/telemetry.md §3). Every kind has a total counter (`n`);
 * `app` = its per-app counter prefix (`<prefix>:<app>`); `p` = per-player-bucket prefix;
 * `dup` = "the same game reported twice" (host hand-over).
 */
export const KIND_FIELDS = {
  open: { n: 'page_opens', app: 'page_opens_by_app' },
  first_tap: { n: 'first_taps', app: 'first_taps_by_app' },
  result: { n: 'results_shown', app: 'results_shown_by_app' },
  share: { n: 'shares', app: 'shares_by_app' },
  room_join: { n: 'join_attempts', app: 'join_attempts_by_app' },
  err: { n: 'errors_total' },
  session_done: { n: 'games_finished', app: 'games_finished_by_app', p: 'games_finished_by_players', dup: 'games_finished_duplicates' },
  rematch: { n: 'rematches', app: 'rematches_by_app', p: 'rematches_by_players', dup: 'rematches_duplicates' },
  room_create: { n: 'rooms_created', app: 'rooms_created_by_app' },
  game_created: { n: 'quizzes_created', app: 'quizzes_created_by_app', dup: 'quizzes_created_duplicates' },
  ask_shown: { n: 'asked_again', app: 'asked_again_by_app' },
  ask_answer: { n: 'answered_again' },
  seen: { n: 'device_checkins' },
};
/**
 * The headline numbers kept per month forever (stats:monthly:<YYYY-MM>, docs/telemetry.md §3):
 * the /stats page's growth chart. players_in_finished_games = sum of `p` over finished games
 * (the same person in 5 games counts 5 — 연인원, not people).
 */
export const MONTHLY_FIELDS = [
  'games_finished', 'games_finished_3plus', 'quizzes_created', 'quizzes_created_remake',
  'rooms_created', 'players_in_finished_games', 'joins_ok',
];
/** A known kind whose event failed validation (value never stored): `rejected_events:<kind>`. */
export const REJECTED_PREFIX = 'rejected_events:';
/** Successful joins by time-to-join bucket — the p75 ≤ 2 s quality bar (docs/telemetry.md §9). */
export const JOIN_MS_PREFIX = 'join_ms_bucket:';

/**
 * Normalize one event into counter fields. Returns null when the event is dropped.
 * Shape: { kind, fields: string[], err?: string, all: [field, n][], monthly: [field, n][], once?: string }
 * `all` = all-time counters; `monthly` = this month's headline counters (MONTHLY_FIELDS,
 * also per day — see store.js); `once` = de-dup id — such an event is counted only after
 * settleOnce() confirms it is the first with that id (host hand-over, resends).
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // A null field is the same as an absent one (JSON clients often send null).
  const ev = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const k = ev.k;
  if (typeof k !== 'string' || !Object.hasOwn(KIND_FIELDS, k)) return null;
  const F = KIND_FIELDS[k];
  const fields = [];
  const all = []; // all-time counters (stats:all_time): [field, n]
  let err;
  let errAt; // { where, build } of an err event (for the server's live log line)
  let once;
  let device;
  const usage = []; // `seen` usage buckets: also kept per month (device-days)
  if (Object.hasOwn(STRICT_KEYS, k) && Object.keys(ev).some((f) => !STRICT_KEYS[k].has(f))) return null;
  const withApp = () => {
    const app = normApp(ev.app);
    if (app) fields.push(`${F.app}:${app}`);
  };
  switch (k) {
    case 'open':
      if (!ROUTES.has(ev.route)) return null;
      fields.push(`page_opens_by_route:${ev.route}`);
      withApp();
      break;
    case 'first_tap':
      if (!validMs(ev.ms)) return null;
      fields.push(`first_tap_ms_bucket:${timeBucket(ev.ms)}`);
      withApp();
      break;
    case 'result':
      withApp();
      break;
    case 'share':
      if (!SHARE_METHODS.has(ev.method)) return null;
      if (ev.what !== undefined && !SHARE_WHATS.has(ev.what)) return null;
      fields.push(`shares_by_method:${ev.method}`);
      if (ev.what !== undefined) fields.push(`shares:${ev.what}`);
      withApp();
      break;
    case 'room_join': {
      if (typeof ev.ok !== 'boolean') return null;
      if (ev.room !== undefined && !ROOM_KINDS.has(ev.room)) return null;
      // A reason only on a failure, and only from the list.
      if (ev.reason !== undefined && (ev.ok || !JOIN_FAIL_REASONS.has(ev.reason))) return null;
      const res = ev.ok ? 'joins_ok' : 'joins_failed';
      fields.push(res);
      if (validMs(ev.ms)) fields.push(`${ev.ok ? JOIN_MS_PREFIX : 'join_failed_ms_bucket:'}${timeBucket(ev.ms)}`);
      if (ev.room !== undefined) fields.push(`${res}_by_room:${ev.room}`);
      if (ev.reason !== undefined) fields.push(`join_failed_reason:${ev.reason}`);
      withApp();
      break;
    }
    case 'session_done':
    case 'rematch': {
      // session_done: p = players who took part (acted at least once this game; a quiz's
      // subject counts). rematch: p = players present when the new game starts.
      if (!validPlayers(ev.p) || !validId(ev.sid)) return null;
      // Quiz games only: about = a made quiz about a person (else the default quiz);
      // ans = players other than that person who answered (1 = the 1:1 case).
      if (ev.about !== undefined && typeof ev.about !== 'boolean') return null;
      if (ev.ans !== undefined && !validPlayers(ev.ans, 0)) return null;
      // Answerers are among the players; the subject is a player but never an answerer.
      if (ev.ans !== undefined && ev.ans > ev.p - (ev.about === true ? 1 : 0)) return null;
      fields.push(`${F.p}:${playerBucket(ev.p)}`);
      if (ev.about !== undefined) fields.push(`${F.n}_quiz_kind:${ev.about ? 'about_someone' : 'default_quiz'}`);
      if (ev.ans !== undefined) fields.push(`${F.n}_by_answerers:${ev.ans === 0 ? '0' : playerBucket(ev.ans)}`);
      withApp();
      all.push([F.n, 1]);
      if (k === 'session_done') all.push(['players_in_finished_games', ev.p]);
      // The headline: 3+ players took part — and, for a quiz, somebody answered.
      if (k === 'session_done' && ev.p >= 3 && ev.ans !== 0) {
        fields.push('games_finished_3plus');
        const app = normApp(ev.app);
        if (app) fields.push(`games_finished_3plus_by_app:${app}`);
        all.push(['games_finished_3plus', 1]);
      }
      once = onceId(k, ev.sid);
      break;
    }
    case 'room_create':
      withApp();
      all.push([F.n, 1]);
      break;
    case 'game_created':
      // A valid quiz pack the host engine accepted; `remake` = sent from the result
      // screen by someone who was not the previous subject (participant → creator).
      if (!GAME_SOURCES.has(ev.source) || !validId(ev.gid)) return null;
      fields.push(`quizzes_created_${ev.source}`);
      withApp();
      all.push([F.n, 1], [`quizzes_created_${ev.source}`, 1]);
      once = onceId(k, ev.gid);
      break;
    case 'seen':
      // `d` = the browser's random id (22 base64url chars = 128 bits). It is only ever
      // salted-hashed into a HyperLogLog (api/ev.js) — never stored, logged or counted as is.
      if (!DEVICE_ID_RE.test(ev.d)) return null;
      for (const [key, b] of Object.entries(USAGE_BUCKETS)) {
        if (ev[key] === undefined) continue;
        if (!b.values.has(ev[key])) return null;
        fields.push(`${b.prefix}${ev[key]}`);
        usage.push([`${b.prefix}${ev[key]}`, 1]);
      }
      device = ev.d;
      break;
    case 'ask_shown':
      withApp();
      break;
    case 'ask_answer': {
      if (!ASK_ANSWERS.has(ev.a)) return null;
      if (ev.why !== undefined && (ev.a !== 'no' || !ASK_REASONS.has(ev.why))) return null;
      fields.push(`answered_again_${ev.a}`);
      if (ev.why !== undefined) fields.push(`answered_again_no_reason:${ev.why}`);
      const app = normApp(ev.app);
      if (app) fields.push(`answered_again_${ev.a}_by_app:${app}`);
      break;
    }
    case 'err': {
      if (typeof ev.msg !== 'string' || !ev.msg.trim()) return null;
      err = sanitizeErr(ev.msg) || '(empty)';
      const where = ident(ev.where, 24);
      const build = ident(ev.build, 16);
      if (where) fields.push(`errors_by_where:${where}`);
      if (build) fields.push(`errors_by_build:${build}`);
      errAt = { where, build };
      break;
    }
    default:
      return null;
  }
  fields.unshift(F.n);
  const monthly = all.filter(([f]) => MONTHLY_FIELDS.includes(f));
  if (fields.includes('joins_ok')) monthly.push(['joins_ok', 1]);
  monthly.push(...usage);
  return { kind: k, fields, err, all, monthly, once, ...(device ? { device } : {}), ...(errAt ? errAt : {}) };
}

const add = (m, f, n = 1) => m.set(f, (m.get(f) || 0) + n);

/**
 * Parse a raw body string. Returns { status, error } on rejection, or
 * { status: 200, incr: Map<field,count>, errs: Map<sample,count>, all: Map<field,count>,
 *   monthly: Map<field,count>, once: [{id, kind, fields, all, monthly}], errLines: [{msg, where?, build?}], accepted, badCount, dropped }.
 * errLines = the accepted error events, already sanitized (the server logs one line each).
 * badCount = events of a known kind dropped by validation; they are counted as
 * `rejected_events:<kind>` (in incr) so a wiring bug is visible instead of a silent 0.
 * `once` events are not in incr/all yet: the caller claims their ids, then settleOnce().
 */
export function parseBatch(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: 'bad_json' };
  }
  if (!body || typeof body !== 'object' || body.v !== VERSION) return { status: 400, error: 'bad_version' };
  if (!Array.isArray(body.events)) return { status: 400, error: 'bad_events' };
  if (body.events.length > MAX_EVENTS) return { status: 400, error: 'too_many_events' };
  const incr = new Map();
  const errs = new Map();
  const all = new Map();
  const monthly = new Map();
  const devices = new Set(); // raw ids, in memory only: api/ev.js hashes them and drops these
  const once = [];
  const onceSeen = new Set();
  const errLines = [];
  const bad = new Map(); // known kind, dropped by validation -> count (a wiring bug shows up)
  let accepted = 0;
  for (const ev of body.events) {
    const n = normalizeEvent(ev);
    if (!n) {
      const k = ev && typeof ev === 'object' ? ev.k : undefined;
      if (typeof k === 'string' && KNOWN.has(k)) add(bad, `${REJECTED_PREFIX}${k}`);
      continue;
    }
    accepted++;
    if (n.once) {
      if (onceSeen.has(n.once)) add(incr, KIND_FIELDS[n.kind].dup); // same game twice in one batch
      else {
        onceSeen.add(n.once);
        once.push({ id: n.once, kind: n.kind, fields: n.fields, all: n.all, monthly: n.monthly });
      }
      continue;
    }
    for (const f of n.fields) add(incr, f);
    for (const [f, c] of n.all) add(all, f, c);
    for (const [f, c] of n.monthly) add(monthly, f, c);
    if (n.device) devices.add(n.device);
    if (n.err) {
      add(errs, n.err);
      errLines.push({ msg: n.err, where: n.where, build: n.build });
    }
  }
  const badCount = [...bad.values()].reduce((a, b) => a + b, 0);
  for (const [f, c] of bad) add(incr, f, c);
  return { status: 200, incr, errs, all, monthly, devices: [...devices], once, errLines, accepted, badCount, dropped: body.events.length - accepted };
}

/** Count each `once` event whose id was claimed for the first time (fresh[i]); the rest count as that kind's `*_duplicates`. */
export function settleOnce(parsed, fresh) {
  parsed.once.forEach((o, i) => {
    if (!fresh[i]) return add(parsed.incr, KIND_FIELDS[o.kind].dup);
    for (const f of o.fields) add(parsed.incr, f);
    for (const [f, c] of o.all) add(parsed.all, f, c);
    for (const [f, c] of o.monthly) add(parsed.monthly, f, c);
  });
  return parsed;
}

/** `{<value>: n}` for every `<prefix><value>` counter (sorted by value), 0s left out. */
export function byPrefix(c, prefix) {
  return Object.fromEntries(
    Object.entries(c)
      .filter(([f, v]) => f.startsWith(prefix) && v > 0)
      .map(([f, v]) => [f.slice(prefix.length), v])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The free-beta numbers (docs/telemetry.md §9) from flat counters (a day or a sum of days). */
export function summarize(c) {
  const n = (f) => c[f] || 0;
  return {
    sessionsDone: n('games_finished'),
    sessionsDone3: n('games_finished_3plus'),
    sessionsDup: n('games_finished_duplicates'),
    sessionsAbout: n('games_finished_quiz_kind:about_someone'),
    rematch: n('rematches'),
    roomsCreated: n('rooms_created'),
    gamesCreated: n('quizzes_created'),
    gamesEditor: n('quizzes_created_editor'),
    gamesRemade: n('quizzes_created_remake'),
    joinOk: n('joins_ok'),
    joinFail: n('joins_failed'),
    joinFailReasons: byPrefix(c, 'join_failed_reason:'),
    // Successful joins per time bucket, every bucket present and in order (for p50/p75/p95).
    joinMs: Object.fromEntries(TIME_BUCKETS.map((b) => [b, n(JOIN_MS_PREFIX + b)])),
    share: n('shares'),
    shareWhat: byPrefix(c, 'shares:'),
    askShown: n('asked_again'),
    askYes: n('answered_again_yes'),
    askNo: n('answered_again_no'),
    askSkip: n('answered_again_skip'),
    askNoReasons: byPrefix(c, 'answered_again_no_reason:'),
    errors: n('errors_total'),
    // Once-a-day browser reports and their usage buckets (devices, not people).
    devicesSeen: n('device_checkins'),
    devicesByAge: byPrefix(c, USAGE_BUCKETS.age.prefix),
    devicesByUses: byPrefix(c, USAGE_BUCKETS.uses.prefix),
    devicesByGames: byPrefix(c, USAGE_BUCKETS.games.prefix),
    devicesByMade: byPrefix(c, USAGE_BUCKETS.made.prefix),
    bad: byPrefix(c, REJECTED_PREFIX),
  };
}
