// Event schema for POST /api/ev. Turns a client batch into counter increments.
// Only whitelisted kinds/values survive; unknown fields are ignored; nothing that
// identifies a person (IP, UA, nickname, cookie, device/session id) is ever read.
import { normApp } from './apps.js';

export const VERSION = 1;
export const MAX_BODY_BYTES = 4096;
export const MAX_EVENTS = 20;
export const MAX_MS = 10 * 60 * 1000;
export const MS_EDGES = [100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

export const ROUTES = new Set(['home', 'app', 'room', 'create', 'other']);
export const SHARE_METHODS = new Set(['web', 'kakao', 'copy', 'save', 'other']);
export const KINDS = ['open', 'first_tap', 'result', 'share', 'room_join', 'err'];
/** Why a room join failed (client: LiveApp / roomTransport reasons). Anything else -> "other". */
export const JOIN_FAIL_REASONS = new Set(['timeout', 'silence', 'broker', 'refused', 'subscribe', 'load', 'unreachable', 'disconnected', 'other']);

/** "refused: Server unavailable" -> "refused"; unknown -> "other"; absent -> undefined. */
export function joinReason(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return 'other';
  const head = v.split(':')[0].trim();
  return JOIN_FAIL_REASONS.has(head) ? head : 'other';
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
 * Shape: { kind, fields: string[], err?: string, where?: string, build?: string }
 */
export function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const k = ev.k;
  const fields = [];
  let err;
  let where;
  let build;
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
      fields.push(`share|method|${ev.method}`);
      withApp();
      break;
    case 'room_join': {
      if (typeof ev.ok !== 'boolean') return null;
      const res = ev.ok ? 'ok' : 'fail';
      fields.push(`room_join|${res}`);
      if (validMs(ev.ms)) fields.push(`room_join_ms|${res}|${msBucket(ev.ms)}`);
      const reason = ev.ok ? undefined : joinReason(ev.reason);
      if (reason) fields.push(`room_join|reason|${reason}`);
      withApp();
      break;
    }
    case 'err': {
      if (typeof ev.msg !== 'string' || !ev.msg.trim()) return null;
      err = sanitizeErr(ev.msg) || '(empty)';
      where = ident(ev.where, 24);
      build = ident(ev.build, 16);
      if (where) fields.push(`err|where|${where}`);
      if (build) fields.push(`err|build|${build}`);
      break;
    }
    default:
      return null;
  }
  fields.unshift(`${k}|n`);
  return err === undefined ? { kind: k, fields } : { kind: k, fields, err, where, build };
}

/**
 * Parse a raw body string. Returns { status, error } on rejection, or
 * { status: 200, incr: Map<field,count>, errs: Map<sample,count>, errLines, accepted, dropped }
 * where errLines = [{ msg, where?, build? }] — the accepted error events, already sanitized.
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
  const errLines = [];
  let accepted = 0;
  for (const ev of body.events) {
    const n = normalizeEvent(ev);
    if (!n) continue;
    accepted++;
    for (const f of n.fields) incr.set(f, (incr.get(f) || 0) + 1);
    if (n.err) {
      errs.set(n.err, (errs.get(n.err) || 0) + 1);
      errLines.push({ msg: n.err, where: n.where, build: n.build });
    }
  }
  return { status: 200, incr, errs, errLines, accepted, dropped: body.events.length - accepted };
}
