// Saved room results (docs/room-results.md): validation for POST /api/room-result.
// The stored record is REBUILT from whitelisted fields — nothing the client adds beyond
// them (an anonId, a device id, anything) can reach storage. Text caps follow the room
// engine's (packages/snack-room/src/room.js: NICK_MAX, QUIZ_*_MAX, RECAP_PLAYERS_MAX).
import { createHash } from 'node:crypto';
import { SID_RE } from './schema.js';

export const RR_VERSION = 1;
export const RR_MAX_BODY_BYTES = 24 * 1024;
export const RR_MAX_PLAYERS = 20;
export const RR_MAX_ROUNDS = 20;
export const RR_MAX_OPTIONS = 4;
const NICK_MAX = 10;
const TITLE_MAX = 40;
const Q_MAX = 80;
const OPTION_MAX = 30;
const MAX_SCORE = 10_000_000;
const MAX_POINTS = 1_000_000;
const MAX_MS = 60_000;
const PID_RE = /^p\d{1,4}$/;
// The room code alphabet / length of snack-player/src/links.ts (ROOM_CODE_*).
const CODE = '[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,32}';
/** A friends-room id: `<play slug>~<code>` (tpl-<template> or app-<hash>). Public rooms are never saved. */
export const FRIEND_ROOM_RE = new RegExp(`^(tpl-[a-z0-9][a-z0-9-]{0,63}|app-[a-z0-9]{1,16})~${CODE}$`);

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s)).length : Array.from(s).length);
/** A text field: a string within `max` graphemes (and 4 UTF-16 units each — the engine's size-bomb guard). */
const text = (v, max, { empty = false } = {}) =>
  typeof v === 'string' && (empty || v.trim() !== '') && v.length <= 4 * max && graphemes(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Storage key part for a room id (the id itself — and its code — is never stored). */
export const roomHash = (room) => createHash('sha256').update(`rr\0${room}`).digest('hex');
/** Write-once key part for one game in one room. */
export const sidHash = (room, sid) => createHash('sha256').update(`rr\0${room}\0${sid}`).digest('hex').slice(0, 40);

function cleanBoard(board) {
  if (!Array.isArray(board) || board.length > RR_MAX_PLAYERS) return null;
  const out = [];
  for (const b of board) {
    if (!isObj(b) || !PID_RE.test(b.pid ?? '') || !text(b.nick, NICK_MAX) || !int(b.score, 0, MAX_SCORE)) return null;
    if (b.left !== undefined && typeof b.left !== 'boolean') return null;
    out.push(b.left ? { pid: b.pid, nick: b.nick, score: b.score, left: true } : { pid: b.pid, nick: b.nick, score: b.score });
  }
  return out;
}

const nullableText = (v, max) => v === null || v === undefined || text(v, max);

function cleanRecap(r) {
  if (!isObj(r) || !Array.isArray(r.rounds) || r.rounds.length > RR_MAX_ROUNDS) return null;
  if (!nullableText(r.subject, NICK_MAX) || !nullableText(r.about, NICK_MAX)) return null;
  if (r.title !== undefined && !text(r.title, TITLE_MAX, { empty: true })) return null;
  if (r.packId !== undefined && r.packId !== null && !(typeof r.packId === 'string' && SID_RE.test(r.packId))) return null;
  const rounds = [];
  for (const rd of r.rounds) {
    if (!isObj(rd) || !text(rd.q, Q_MAX) || !Array.isArray(rd.options)) return null;
    if (rd.options.length < 2 || rd.options.length > RR_MAX_OPTIONS || !rd.options.every((o) => text(o, OPTION_MAX))) return null;
    if (!int(rd.answer, 0, rd.options.length - 1) || !Array.isArray(rd.picks) || rd.picks.length > RR_MAX_PLAYERS) return null;
    const picks = [];
    for (const p of rd.picks) {
      if (!isObj(p) || !PID_RE.test(p.pid ?? '') || !text(p.nick, NICK_MAX)) return null;
      if (!int(p.option, -1, rd.options.length - 1) || !int(p.ms ?? -1, -1, MAX_MS) || typeof p.correct !== 'boolean' || !int(p.points ?? 0, 0, MAX_POINTS)) return null;
      picks.push({ pid: p.pid, nick: p.nick, option: p.option, ms: p.ms ?? -1, correct: p.correct, points: p.points ?? 0 });
    }
    rounds.push({ q: rd.q, options: [...rd.options], answer: rd.answer, picks });
  }
  return { subject: r.subject ?? null, about: r.about ?? null, title: r.title ?? '', packId: r.packId ?? null, rounds };
}

/**
 * Parse a POST body `{room, sid, result}` into what is stored, or an error.
 * @returns {{status: 200, room: string, sid: string, record: object} | {status: number, error: string}}
 */
export function parseRoomResult(textBody, now = Date.now()) {
  let body;
  try {
    body = JSON.parse(textBody);
  } catch {
    return { status: 400, error: 'bad_json' };
  }
  if (!isObj(body)) return { status: 400, error: 'bad_body' };
  const { room, sid, result } = body;
  if (typeof room !== 'string' || !room.includes('~')) return { status: 400, error: 'not_friends_room' };
  if (!FRIEND_ROOM_RE.test(room)) return { status: 400, error: 'bad_room' };
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return { status: 400, error: 'bad_sid' };
  if (!isObj(result) || result.v !== RR_VERSION) return { status: 400, error: 'bad_result' };
  if (result.sid !== undefined && result.sid !== sid) return { status: 400, error: 'sid_mismatch' };
  const board = cleanBoard(result.board);
  if (!board) return { status: 400, error: 'bad_board' };
  if (result.title !== undefined && !text(result.title, TITLE_MAX)) return { status: 400, error: 'bad_title' };
  if (result.about !== undefined && result.about !== null && !text(result.about, NICK_MAX)) return { status: 400, error: 'bad_about' };
  let quizRecap;
  if (result.quizRecap !== undefined && result.quizRecap !== null) {
    quizRecap = cleanRecap(result.quizRecap);
    if (!quizRecap) return { status: 400, error: 'bad_recap' };
  }
  if (!board.length && !quizRecap) return { status: 400, error: 'empty' }; // nothing to show
  const record = {
    v: RR_VERSION,
    app: room.slice(0, room.indexOf('~')),
    endedAt: now, // the server's clock: when the game was saved
    ...(result.title ? { title: result.title } : {}),
    ...(result.about ? { about: result.about } : {}),
    board,
    ...(quizRecap ? { quizRecap } : {}),
  };
  return { status: 200, room, sid, record };
}

/** GET ?room= — the same friends-room rule (anything else is 400, never a KV command). */
export const validRoomQuery = (room) => typeof room === 'string' && FRIEND_ROOM_RE.test(room);
