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
export const MS_EDGES = [100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

export const ROUTES = new Set(['home', 'app', 'room', 'create', 'other']);
export const SHARE_METHODS = new Set(['web', 'kakao', 'copy', 'save', 'other']);
export const KINDS = [
  'open', 'first_tap', 'result', 'share', 'room_join', 'err',
  // free-beta metrics (docs/telemetry.md §9)
  'session_done', 'rematch', 'room_create', 'game_created', 'ask_shown', 'ask_answer',
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
export const WIRED = false;
const KNOWN = new Set(KINDS);
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

/** Histogram bucket name for a duration, e.g. 730 -> "le1000", 99999 -> "gt30000". */
export function msBucket(ms) {
  for (const e of MS_EDGES) if (ms <= e) return `le${e}`;
  return `gt${MS_EDGES[MS_EDGES.length - 1]}`;
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
 * Normalize one event into counter fields. Returns null when the event is dropped.
 * Shape: { kind, fields: string[], err?: string, all: string[], once?: string }
 * `all` = all-time counters; `once` = de-dup id — such an event is counted only after
 * settleOnce() confirms it is the first with that id (host hand-over, resends).
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // A null field is the same as an absent one (JSON clients often send null).
  const ev = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
  const k = ev.k;
  const fields = [];
  const all = []; // all-time counters (ev:all)
  let err;
  let errAt; // { where, build } of an err event (for the server's live log line)
  let once;
  if (Object.hasOwn(STRICT_KEYS, k) && Object.keys(ev).some((f) => !STRICT_KEYS[k].has(f))) return null;
  const withApp = () => {
    const app = normApp(ev.app);
    if (app) fields.push(`${k}|app|${app}`);
  };
  switch (k) {
    case 'open':
      if (!ROUTES.has(ev.route)) return null;
      fields.push(`open|route|${ev.route}`);
      withApp();
      break;
    case 'first_tap':
      if (!validMs(ev.ms)) return null;
      fields.push(`first_tap_ms|${msBucket(ev.ms)}`);
      withApp();
      break;
    case 'result':
      withApp();
      break;
    case 'share':
      if (!SHARE_METHODS.has(ev.method)) return null;
      if (ev.what !== undefined && !SHARE_WHATS.has(ev.what)) return null;
      fields.push(`share|method|${ev.method}`);
      if (ev.what !== undefined) fields.push(`share|what|${ev.what}`);
      withApp();
      break;
    case 'room_join': {
      if (typeof ev.ok !== 'boolean') return null;
      if (ev.room !== undefined && !ROOM_KINDS.has(ev.room)) return null;
      // A reason only on a failure, and only from the list.
      if (ev.reason !== undefined && (ev.ok || !JOIN_FAIL_REASONS.has(ev.reason))) return null;
      const res = ev.ok ? 'ok' : 'fail';
      fields.push(`room_join|${res}`);
      if (validMs(ev.ms)) fields.push(`room_join_ms|${res}|${msBucket(ev.ms)}`);
      if (ev.room !== undefined) fields.push(`room_join|room|${ev.room}|${res}`);
      if (ev.reason !== undefined) fields.push(`room_join|reason|${ev.reason}`);
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
      fields.push(`${k}|p|${playerBucket(ev.p)}`);
      if (ev.about !== undefined) fields.push(`${k}|about|${ev.about}`);
      if (ev.ans !== undefined) fields.push(`${k}|ans|${ev.ans === 0 ? '0' : playerBucket(ev.ans)}`);
      withApp();
      all.push(`${k}|n`);
      // The headline: 3+ players took part — and, for a quiz, somebody answered.
      if (k === 'session_done' && ev.p >= 3 && ev.ans !== 0) {
        fields.push('session_done|p3');
        const app = normApp(ev.app);
        if (app) fields.push(`session_done|app3|${app}`);
        all.push('session_done|p3');
      }
      once = onceId(k, ev.sid);
      break;
    }
    case 'room_create':
      withApp();
      all.push('room_create|n');
      break;
    case 'game_created':
      // A valid quiz pack the host engine accepted; `remake` = sent from the result
      // screen by someone who was not the previous subject (participant → creator).
      if (!GAME_SOURCES.has(ev.source) || !validId(ev.gid)) return null;
      fields.push(`game_created|source|${ev.source}`);
      withApp();
      all.push('game_created|n', `game_created|source|${ev.source}`);
      once = onceId(k, ev.gid);
      break;
    case 'ask_shown':
      withApp();
      break;
    case 'ask_answer': {
      if (!ASK_ANSWERS.has(ev.a)) return null;
      if (ev.why !== undefined && (ev.a !== 'no' || !ASK_REASONS.has(ev.why))) return null;
      fields.push(`ask_answer|a|${ev.a}`);
      if (ev.why !== undefined) fields.push(`ask_answer|why|${ev.why}`);
      const app = normApp(ev.app);
      if (app) fields.push(`ask_answer|app|${app}|${ev.a}`);
      break;
    }
    case 'err': {
      if (typeof ev.msg !== 'string' || !ev.msg.trim()) return null;
      err = sanitizeErr(ev.msg) || '(empty)';
      const where = ident(ev.where, 24);
      const build = ident(ev.build, 16);
      if (where) fields.push(`err|where|${where}`);
      if (build) fields.push(`err|build|${build}`);
      errAt = { where, build };
      break;
    }
    default:
      return null;
  }
  fields.unshift(`${k}|n`);
  return { kind: k, fields, err, all, once, ...(errAt ? errAt : {}) };
}

const add = (m, f, n = 1) => m.set(f, (m.get(f) || 0) + n);

/**
 * Parse a raw body string. Returns { status, error } on rejection, or
 * { status: 200, incr: Map<field,count>, errs: Map<sample,count>, all: Map<field,count>,
 *   once: [{id, kind, fields, all}], errLines: [{msg, where?, build?}], accepted, badCount, dropped }.
 * errLines = the accepted error events, already sanitized (the server logs one line each).
 * badCount = events of a known kind dropped by validation; they are counted as
 * `<kind>|bad` (in incr) so a wiring bug is visible instead of a silent 0.
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
  const once = [];
  const onceSeen = new Set();
  const errLines = [];
  const bad = new Map(); // known kind, dropped by validation -> count (a wiring bug shows up)
  let accepted = 0;
  for (const ev of body.events) {
    const n = normalizeEvent(ev);
    if (!n) {
      const k = ev && typeof ev === 'object' ? ev.k : undefined;
      if (typeof k === 'string' && KNOWN.has(k)) add(bad, `${k}|bad`);
      continue;
    }
    accepted++;
    if (n.once) {
      if (onceSeen.has(n.once)) add(incr, `${n.kind}|dup`); // same game twice in one batch
      else {
        onceSeen.add(n.once);
        once.push({ id: n.once, kind: n.kind, fields: n.fields, all: n.all });
      }
      continue;
    }
    for (const f of n.fields) add(incr, f);
    for (const f of n.all) add(all, f);
    if (n.err) {
      add(errs, n.err);
      errLines.push({ msg: n.err, where: n.where, build: n.build });
    }
  }
  const badCount = [...bad.values()].reduce((a, b) => a + b, 0);
  for (const [f, c] of bad) add(incr, f, c);
  return { status: 200, incr, errs, all, once, errLines, accepted, badCount, dropped: body.events.length - accepted };
}

/** Count each `once` event whose id was claimed for the first time (fresh[i]); the rest become `<kind>|dup`. */
export function settleOnce(parsed, fresh) {
  parsed.once.forEach((o, i) => {
    if (!fresh[i]) return add(parsed.incr, `${o.kind}|dup`);
    for (const f of o.fields) add(parsed.incr, f);
    for (const f of o.all) add(parsed.all, f);
  });
  return parsed;
}

/** The free-beta numbers (docs/telemetry.md §9) from flat counters (a day or a sum of days). */
export function summarize(c) {
  const n = (f) => c[f] || 0;
  return {
    sessionsDone: n('session_done|n'),
    sessionsDone3: n('session_done|p3'),
    sessionsDup: n('session_done|dup'),
    sessionsAbout: n('session_done|about|true'),
    rematch: n('rematch|n'),
    roomsCreated: n('room_create|n'),
    gamesCreated: n('game_created|n'),
    gamesRemade: n('game_created|source|remake'),
    joinOk: n('room_join|ok'),
    joinFail: n('room_join|fail'),
    share: n('share|n'),
    askShown: n('ask_shown|n'),
    askYes: n('ask_answer|a|yes'),
    askNo: n('ask_answer|a|no'),
    askSkip: n('ask_answer|a|skip'),
    bad: Object.fromEntries(
      Object.entries(c)
        .filter(([f, v]) => f.endsWith('|bad') && v > 0)
        .map(([f, v]) => [f.slice(0, -4), v])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}
