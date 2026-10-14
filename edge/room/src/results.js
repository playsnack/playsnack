// What the host phone did in mesh mode, done by the room's Durable Object instead (#96):
//   1. saved room results — a friends room's last scored game, kept 7 days in the DO's own
//      storage, the same record GET /api/room-result returns (docs/room-results.md), read by
//      the player at GET /room/<id>/result (docs/edge-rooms.md §결과 · 통계);
//   2. game stats — the engine's hooks (session_done · rematch · game_created) posted
//      server-to-server to the stats API (/api/ev, docs/telemetry.md §9), batched, never
//      blocking the game, failures dropped and counted.
// Platform-free (fetch + timers are injected), so the Node hub runs it too.

export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The stats API's body cap (api/_lib/schema.js MAX_BODY_BYTES 4096, MAX_EVENTS 20). */
const EV_MAX_BYTES = 4000;
const EV_MAX_EVENTS = 20;
/** The player's limits (snack-player/src/roomResult.ts fitResult = api/_lib/roomResult.js). */
const RR_MAX_BYTES = 24 * 1024;
const RR_MAX_PLAYERS = 20;
const RR_MAX_ROUNDS = 20;
const RR_TRIM_PICKS_TO = 8;

// A friends-room id, as the API accepts it (api/_lib/roomResult.js FRIEND_ROOM_RE; the code
// alphabet of snack-player/src/links.ts). Public rooms never save a result.
const CODE = "[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8,32}";
export const FRIEND_ROOM_RE = new RegExp(`^(tpl-[a-z0-9][a-z0-9-]{0,63}|app-[a-z0-9]{1,16})~${CODE}$`);
export const isFriendRoom = (roomId) => typeof roomId === "string" && FRIEND_ROOM_RE.test(roomId);

/**
 * The app part of a room id, so a friends-room code or a made app's hash is never sent:
 * `tpl-quiz-ox~CODE` → `quiz-ox`, `app-<hash>~CODE` → `custom` (snack-player telemetry.ts appOf).
 */
export function appOf(roomId) {
  const id = String(roomId ?? "").replace(/~.*$/s, "").replace(/^tpl-/, "");
  return id.startsWith("app-") ? "custom" : id;
}

const boardRow = ({ pid, nick, score, left }) => (left ? { pid, nick, score, left: true } : { pid, nick, score });
const pickRow = ({ pid, nick, option, ms, correct, points }) => ({ pid, nick, option, ms: ms ?? -1, correct: Boolean(correct), points: points ?? 0 });

/**
 * The stored record for an engine result (room.js savedResult): only whitelisted fields
 * (the API's record shape), fitted under the same 24 KB the API takes — the full game;
 * else each round's picks cut to the board's top 8; else the ranking alone. null = nothing.
 */
export function resultRecord(roomId, r, now = Date.now()) {
  if (!isFriendRoom(roomId) || !r || r.v !== 1 || !Array.isArray(r.board)) return null;
  const board = r.board.slice(0, RR_MAX_PLAYERS).map(boardRow);
  const base = {
    v: 1,
    app: roomId.slice(0, roomId.indexOf("~")),
    endedAt: now, // as the API: when the game was saved
    ...(r.title ? { title: String(r.title) } : {}),
    ...(r.about ? { about: String(r.about) } : {}),
    board,
  };
  const rc = r.quizRecap && Array.isArray(r.quizRecap.rounds) && r.quizRecap.rounds.length ? r.quizRecap : null;
  if (!board.length && !rc) return null;
  const tries = [];
  if (rc) {
    const recap = (keep) => ({
      subject: rc.subject ?? null,
      about: rc.about ?? null,
      title: rc.title ?? "",
      packId: rc.packId ?? null,
      rounds: rc.rounds.slice(0, RR_MAX_ROUNDS).map((rd) => ({ q: rd.q, options: [...rd.options], answer: rd.answer, picks: (rd.picks ?? []).filter(keep).slice(0, RR_MAX_PLAYERS).map(pickRow) })),
    });
    tries.push({ ...base, quizRecap: recap(() => true) });
    const top = new Set(board.slice(0, RR_TRIM_PICKS_TO).map((b) => b.pid));
    tries.push({ ...base, quizRecap: recap((p) => top.has(p.pid)) });
  }
  if (board.length) tries.push(base);
  const enc = new TextEncoder();
  return tries.find((t) => enc.encode(JSON.stringify(t)).length <= RR_MAX_BYTES) ?? null;
}

export const STATS_UA = "PlaySnack-RoomServer/1";

/**
 * Game stats, server to server. Events are the player's (telemetry.ts engineMetrics) with the
 * same fields only: session_done{app, p, sid, about?, ans?} · rematch{app, p, sid} ·
 * game_created{app, source, gid}. Once per kind+id here (the API dedupes by id as well), queued
 * and POSTed every `flushMs` (or at 20 events, or when the room empties). A failed POST is
 * dropped and counted — never retried, so a dead API cannot loop.
 */
export class StatsSender {
  /**
   * @param {{url?: string, secret?: string, fetch?: (u: string, i: object) => Promise<any>, flushMs?: number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (h: any) => void, waitUntil?: (p: Promise<any>) => void}} [o]
   */
  constructor({ url = "", secret = "", fetch: fetchImpl = (u, i) => fetch(u, i), flushMs = 10000, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h), waitUntil = () => {} } = {}) {
    this.url = url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.flushMs = flushMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.waitUntil = waitUntil;
    this.queue = [];
    this.seen = new Set(); // "k|id" (bounded)
    this.timer = null;
    this.counts = { queued: 0, posts: 0, sent: 0, failed: 0, dropped: 0, dupes: 0 };
  }

  add(ev) {
    if (!this.url) return;
    const key = `${ev.k}|${ev.sid ?? ev.gid}`;
    if (this.seen.has(key)) {
      this.counts.dupes += 1;
      return;
    }
    if (this.seen.size >= 500) this.seen.clear();
    this.seen.add(key);
    this.queue.push(ev);
    this.counts.queued += 1;
    if (this.queue.length >= EV_MAX_EVENTS) this.flush();
    else this.timer ??= this.setTimer(() => this.flush(), this.flushMs);
  }

  /** The engine hooks (createRoom options) for a room. */
  hooks(roomId) {
    const app = appOf(roomId);
    const p = (n) => Math.max(1, Math.floor(Number(n) || 0));
    return {
      onSessionStart: (e) => {
        if (e.again) this.add({ k: "rematch", app, p: p(e.players), sid: e.sid });
      },
      onSessionEnd: (e) => {
        if (!(e.players >= 1)) return; // nobody took part: not a played game (as the player)
        const ev = { k: "session_done", app, p: p(e.players), sid: e.sid };
        if (e.quiz) Object.assign(ev, { about: Boolean(e.about), ans: Math.max(0, Math.floor(Number(e.answerers) || 0)) });
        this.add(ev);
      },
      onGameCreated: (e) => this.add({ k: "game_created", app, source: e.source, gid: e.gid }),
    };
  }

  /** POST what is queued (batches under the API's caps). Never throws; the promise is for tests. */
  flush() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    const posts = [];
    while (this.queue.length) {
      const batch = [];
      while (this.queue.length && batch.length < EV_MAX_EVENTS && JSON.stringify({ v: 1, events: [...batch, this.queue[0]] }).length <= EV_MAX_BYTES) batch.push(this.queue.shift());
      if (!batch.length) batch.push(this.queue.shift()); // cannot happen (events are ~100 B); never loop
      posts.push(this.post(batch));
    }
    const all = Promise.all(posts).then(() => {});
    this.waitUntil(all);
    return all;
  }

  post(events) {
    this.counts.posts += 1;
    const headers = { "content-type": "application/json", "user-agent": STATS_UA, ...(this.secret ? { "x-room-server": this.secret } : {}) };
    const fail = () => {
      this.counts.failed += 1;
      this.counts.dropped += events.length;
    };
    try {
      return Promise.resolve(this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify({ v: 1, events }) }))
        .then((res) => {
          if (res && res.ok) this.counts.sent += events.length;
          else fail();
          try {
            res?.body?.cancel?.()?.catch?.(() => {}); // the reply is not needed
          } catch {
            /* already read */
          }
        })
        .catch(fail);
    } catch {
      fail();
      return Promise.resolve();
    }
  }
}
