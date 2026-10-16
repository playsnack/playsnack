// Server-authoritative game room: the room engine (@snack/room createRoom — the same
// one snack-server runs for /ws and a host player runs in the mesh) runs HERE, inside
// the room's Durable Object. The DO is the host: no player device is trusted with the
// answers, the clock or the scores. Platform-free, so the Node hub runs it too.
//
// Wire protocol = snack-server's /ws (the player's ServerTransport speaks it):
//   client → {t:"hello", d:{slug, anonId, nick, token?, organizerToken?, autoStart?, stay?, pin?, organize?}}  first
//            (pin / organize: legacy codes only — #157 v2 rooms take the PIN at the Worker and the
//            organizer from the /mint ticket `orgt` in organizerToken; public ids never get either)
//   client → {t:"action", d:{name, payload, clientMsgId}} | {t:"react", d:{emoji}}
//   client → {t:"away"}   the page went to the background (#213) · {t:"here"} back on screen, same socket
//            · {t:"bye"} leaving for good (← 홈, the tab closing): out of the room at once
//   room   → {t:"state"|"setVar"|"participants"|"reaction"|"actionAck", d}   (engine messages)
//   room   → {t:"token", d:{token}}        seat token (reconnect without the PIN, seat takeover)
//   room   → {t:"organizer", d:{token}}    to the room's creator (12 h organizer token)
//   room   → {t:"pass", d:{token, exp}}    PIN room, entered with the PIN: no PIN for 12 h on this device
//   room   → {t:"pinClosed"} · {t:"alert", d:{kind:"pin_failures", n}}   PIN room, to its organizer
//   room   → {t:"denied", d:{reason, retryIn?, left?}}   then usually a close
//   room   → {t:"moveTo", d:{room}}       public room mid-game: play in that room instead (then 4010)
// Each socket arrives with the Worker's admit claim (admit.js decideUpgrade; null on the in-memory
// tests = today's rules). Budget per socket (memory only): burst 30 frames, refilled 4/s, ≤ 1,800 an
// hour; reactions ≤ 3/s from an allowlist (more are dropped, not spread); over → denied slow, 4029.
// Per-player variables (iAmSubject, myPid, myPick, iAmSpectator, iAmOut) go to that socket
// only (engine `send`); answers never leave before the reveal (engine: roundContent has no
// answer, picks stay inside, raceBoard shows pre-round scores while a round is open).
//
// One seat per device (anonId) per room: a second socket with the same anonId is refused
// unless it shows that seat's token (a reconnect) — then it takes the seat over.
// Who starts a game (#135 / #136, engine `startRule`):
//   friends room (`slug~CODE`) or an organized room (created with organize: true) → "host": the
//   organizer — whoever made the room — is the host (방장) and only the host starts / returns to
//   the lobby; away > 30 s, the earliest-joined player still here takes over (engine room.js).
//   public room (`slug`, `slug.gN`) → "auto": a client's hello carries its app's start payload
//   (`autoStart: {start, ms}`, the template's `room`); with 2+ players there (#141, engine
//   AUTO_START_MIN — one alone waits) the lobby counts down and starts by itself. Someone new
//   arriving while a game runs (who would only watch) gets `moveTo` the next generation room
//   (`slug.g2`, `slug.g3`, … — the same for every late arrival, so they play together there:
//   the first one waits there for the next) and is closed 4010. A new room goes through the same
//   usage guard (RoomGate); refused, the client comes back here with `stay: true` and watches.
//
// Leaving (#213): a socket that closes leaves at once (the tab closed, ← 홈 — the client also says
// `bye` first). A phone that only goes to the background keeps its socket open (iOS freezes the
// page; the share sheet comes back), so it says `away`: still here for AWAY_GRACE_MS (no flicker
// for a trip to KakaoTalk); not `here` / back on a new socket by then → the room closes that socket
// (4011) and the person leaves — everyone's count goes down. The deadline is the room's storage
// alarm (not a timer: the room can still hibernate meanwhile); one `away` (+ one `here`) per trip
// to the background, nothing periodic. A phone that loses its network while on screen sends
// nothing — for the host (방장) that matters (#142): see "Host keepalive" below.
//
// Host keepalive (#142): only the host's page, on screen, in the lobby / result, sends the exact
// text "ping" every 20 s (snack-player roomTransport.ts). The DO answers it itself without waking
// (worker.js setWebSocketAutoResponse "ping" → "pong") and keeps the time. No timer / alarm here
// ever polls it: the room reads it (sock.pongAt()) only inside an event that already woke it — a
// hello, a frame, a close, the away alarm. Host in the lobby / result, not away, its last pong,
// frame and the phase change all older than HOST_STALE_MS → the host is gone: closed 4012 and out of
// the roster as a leave whose grace began then (#213), so HOST_GRACE_MS has run — handed over at
// once. No pong yet (null) = unknown, never "dead". A frame that looks like a ping but reached the
// room (wrong text: it woke the DO) is counted in `pingMiss` (/usage; should stay 0).
//
// Hibernation: engine state lives in memory; a pending engine timer (setTimeout) keeps the
// DO awake through a game. Idle (lobby / result), the DO may hibernate and lose memory, so
// the engine snapshot is kept in storage while the room is occupied and deleted when the
// last player leaves (then the 24 h alarm deletes the rest).
//
// What the host phone did in mesh mode, the DO does here (results.js, #96): a friends room's
// scored game is kept 7 days (`result`, write-once per game, GET /room/<id>/result) and the
// engine's game stats go to the stats API server to server (StatsSender), never blocking play.
import { createRoom } from "../../../packages/snack-room/src/room.js";
import { RoomGate, UsageReporter, PinLock, LIMITS, ROOM_FULL_TODAY } from "./core.js";
import { signPass } from "./admit.js";
import { resultRecord, RESULT_TTL_MS } from "./results.js";

/** Close code for a host socket the room called gone (#142: no keepalive for HOST_STALE_MS; the client comes back on its own). */
export const LOST_CLOSE = 4012;
/** The host keepalive frame and its auto-response (#142) — byte for byte (worker.js, snack-player PING_TEXT). */
export const PING = "ping";
export const PONG = "pong";
/** The host's page pings this often (snack-player PING_EVERY_MS) — the meter's estimate of the pings it never sees. */
export const PING_EVERY_MS = 20000;
/** No keepalive / frame from the host this long (two pings missed + slack) → gone. */
export const HOST_STALE_MS = 45000;
/** Something like a ping (wrong case, quotes, spaces, JSON) that reached the room instead of the auto-response. */
const PINGISH = /^\W{0,4}ping\W{0,4}$/i;

/**
 * #142: is the host gone? `pongAt` = the last auto-response to its "ping" (null = it never pinged:
 * unknown → no); `seenAt` = its last frame; `phaseAt` = when the room last changed phase (a ping
 * may only begin then). Only in the lobby / result (no pings in a game) and not while away (#213's
 * alarm handles that).
 */
export function hostStale({ now, phase, away, pongAt, seenAt = null, phaseAt = null, staleMs = HOST_STALE_MS }) {
  if (away || pongAt == null || (phase !== "lobby" && phase !== "result")) return false;
  return now - Math.max(pongAt, seenAt ?? 0, phaseAt ?? 0) > staleMs;
}

export const GAME_LIMITS = {
  ...LIMITS,
  maxSockets: 300,
  actionsPerSec: 15, // as snack-server /ws
  organizerTtlMs: 12 * 60 * 60 * 1000,
  // A device claim must be ≥ server-observed elapsed − this (RTT + render + jitter). 1 s is a
  // conservative start for a crowded park cell network; tighten once phone RTT is measured
  // (docs/edge-rooms.md §fairness). A cheat gains at most this much.
  claimWindowMs: 1000,
  persistMs: 1000,
  coalesceMs: 150, // roster / participants / quizProgress: at most one fan-out per this
  sendChunk: 100, // frames sent per task (the rest follow in the next task, in order)
  // Per-socket budget (#157, free tier: one incoming frame = one DO request). A phone sends ≤ 4/s
  // in a tap game (tapBatchMs 250) and far less otherwise. No per-IP frame budget: a park's NAT.
  frameBurst: 30,
  frameRate: 4, // refill per second
  framesPerHour: 1800,
  reactsPerSec: 3, // more are dropped (not spread to everyone)
  squeezePerMin: 60, // usage stage 3 (≥ 95 %): a socket above 1 frame/s over 60 s is closed
  awayGraceMs: 30000, // #213: in the background this long (no `here`, no new socket) → out of the room
  hostStaleMs: HOST_STALE_MS, // #142
  pingEveryMs: PING_EVERY_MS, // #142: the meter's estimate of the host's auto-answered pings
};
/** Close code for a socket the room let go after AWAY_GRACE_MS in the background (the client comes back on its own). */
export const AWAY_CLOSE = 4011;
/** The reactions the player offers (snack-player LiveApp REACTIONS); anything else is dropped. */
export const REACTIONS = new Set(["❤️", "🔥", "😂", "👍", "😮"]);
// The next generation of a public room: `slug` → `slug.g2` → `slug.g3` … (deterministic, so every
// late arrival of one game lands in the same room). Never a friends room (no `~`).
export const nextRoomId = (roomId) => {
  const m = /^(.*)\.g(\d{1,6})$/.exec(roomId);
  return m ? `${m[1]}.g${Number(m[2]) + 1}` : `${roomId}.g2`;
};
/** A friends room (`slug~CODE`) or an organized one hosts; a public room starts by itself. */
export const startRuleFor = (roomId, meta) => (meta?.org || String(roomId).includes("~") ? "host" : "auto");
const COALESCED = new Set(["roster", "rosterPhotos", "quizProgress", "voteProgress"]);
const ANON_RE = /^[A-Za-z0-9_-]{1,64}$/;
const rid = () => Math.random().toString(36).slice(2, 10);

/**
 * The room's cleanup alarm (also the Worker's, which may run with no GameRoom in memory):
 * nobody came back → delete the room; a saved result and a PIN lock (#157) younger than 7 days
 * stay (everything else goes) and the alarm moves to the earlier expiry. → true when the storage
 * is now empty.
 */
export async function roomAlarm({ store, now = Date.now, setAlarm }) {
  const t = now();
  const keep = [];
  for (const k of ["result", "pinlock"]) {
    const v = await store.get(k);
    if (v && v.exp > t) keep.push(v.exp);
    else if (v) await store.delete(k);
  }
  if (keep.length) {
    for (const k of ["meta", "lock", "snap"]) await store.delete(k);
    await setAlarm(Math.min(...keep));
    return false;
  }
  await store.deleteAll();
  return true;
}

export class GameRoom {
  /**
   * @param {object} o
   * @param {() => Array<{state: object, save(s: object): void, send(s: string): void, close(c?: number, r?: string): void}>} o.sockets  every socket of the room, now
   * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack]
   * @param {import("./results.js").StatsSender | null} [o.statsSender]  game stats to the stats API (null = none)
   * @param {(p: Promise<any>) => void} [o.waitUntil]  keeps the DO alive for a write / POST in flight
   */
  constructor({ roomId, store, secret, usage, setAlarm = () => {}, now = Date.now, limits = {}, sockets, getPack = async () => null, setTimer, clearTimer, statsSender = null, waitUntil = () => {} }) {
    if (!secret) throw new Error("ROOM_TOKEN_SECRET is required");
    Object.assign(this, { roomId, store, secret, usage, setAlarm, now, sockets, getPack, statsSender, waitUntil });
    this.resultChain = Promise.resolve();
    this.L = { ...GAME_LIMITS, ...limits };
    this.timers = { setTimer: setTimer ?? ((fn, ms) => setTimeout(fn, ms)), clearTimer: clearTimer ?? ((h) => clearTimeout(h)) };
    this.meter = this.newMeter();
    this.gate = new RoomGate({ roomId, store, secret, usage, now, limits: this.L, meter: this.meter });
    const L = this.L;
    this.pins = new PinLock({ store, now, limits: { lockAfter: L.lockAfter, lockMs: L.lockMs, maxLockMs: L.maxLockMs, ...(L.pinCap ? { cap: L.pinCap } : {}) } });
    this.budgets = new WeakMap(); // socket → frame budget (memory only)
    this.engine = null;
    this.meta = null;
    this.chain = Promise.resolve(); // every event of the room, in order
    this.persistTimer = null;
    this.rate = new WeakMap();
    // Accounting (memory only): frames in/out, bytes out, engine handling time.
    this.stats = { conns: 0, in: 0, out: 0, bytesOut: 0, broadcasts: 0, byType: {}, handleMs: 0, handled: 0 };
    this.lastSnap = null; // JSON of the last stored snapshot (unchanged → no write)
    this.coalesced = new Map();
    this.outq = []; // [socket, frame, socket, frame, …]
    this.outHead = 0;
    this.draining = false;
    this.coalesceTimer = null;
    this._peers = null;
    Object.assign(this.stats, { fanoutMs: 0, fanoutMaxMs: 0, fanoutMaxBytes: 0, fanoutMaxTo: 0, handleMaxMs: 0, chunks: 0, chunkMs: 0, chunkMaxMs: 0 });
  }

  /**
   * The room's usage counter. Quiet for idleFlushMs and no game running (no engine timer — only
   * then can the DO hibernate, header) → it reports, so a hibernation loses nothing (#191).
   */
  newMeter() {
    return new UsageReporter({
      usage: this.usage,
      now: this.now,
      everyMs: this.L.reportMs,
      everyN: this.L.reportEvery,
      idleMs: this.L.idleFlushMs,
      busy: () => Boolean(this.engine?._state.session.timers.length),
      ...this.timers,
    });
  }

  peers() {
    const m = new Map();
    for (const s of this.sockets()) if (s.state?.joined) m.set(s.state.peer, s);
    return m;
  }

  /** peerId → socket, rebuilt only after a join / leave. */
  peerMap() {
    this._peers ??= this.peers();
    return this._peers;
  }

  /** One message to every joined socket (stringified once). Timed for the CPU budget. */
  fanout(str) {
    const t0 = performance.now();
    let n = 0;
    for (const s of this.peerMap().values()) {
      this.queue(s, str);
      n += 1;
    }
    const ms = performance.now() - t0;
    const st = this.stats;
    st.broadcasts += 1;
    st.out += n;
    st.bytesOut += str.length * n;
    st.fanoutMs += ms;
    if (ms > st.fanoutMaxMs) Object.assign(st, { fanoutMaxMs: ms, fanoutMaxBytes: str.length, fanoutMaxTo: n });
  }

  /**
   * Every outgoing frame goes through one FIFO queue, sent in chunks of `sendChunk` per
   * task: a 200-player fan-out (or a start that tells each player its own row) never runs
   * as one long burst — the CPU per task stays bounded (docs/edge-rooms.md §CPU).
   */
  queue(s, str) {
    this.outq.push(s, str);
    if (!this.draining) {
      this.draining = true;
      this.timers.setTimer(() => this.drain(), 0);
    }
  }

  /** Close after everything already queued for it (e.g. the "denied" just before). */
  closeQ(s, code, reason) {
    this.queue(s, { code, reason });
  }

  drain() {
    const t0 = performance.now();
    const q = this.outq;
    const end = Math.min(q.length, this.outHead + 2 * this.L.sendChunk);
    let i = this.outHead;
    for (; i < end; i += 2) {
      const f = q[i + 1];
      if (typeof f === "string") q[i].send(f);
      else q[i].close(f.code, f.reason);
    }
    const ms = performance.now() - t0;
    this.stats.chunks += 1;
    if (ms > this.stats.chunkMaxMs) this.stats.chunkMaxMs = ms;
    if (this.samples) this.samples.chunk.push(ms);
    this.stats.chunkMs += ms;
    if (i >= q.length) {
      this.outq = [];
      this.outHead = 0;
      this.draining = false;
    } else {
      this.outHead = i;
      this.timers.setTimer(() => this.drain(), 0);
    }
  }

  flushCoalesced() {
    if (this.coalesceTimer != null) this.timers.clearTimer(this.coalesceTimer);
    this.coalesceTimer = null;
    if (!this.coalesced.size) return;
    const items = [...this.coalesced.values()];
    this.coalesced.clear();
    for (const { t, d } of items) this.fanout(JSON.stringify({ t, d }));
  }

  ensureEngine(rejoin) {
    if (this.engine) return this.engine;
    const out = (s, str) => {
      this.queue(s, str);
      this.stats.out += 1;
      this.stats.bytesOut += str.length;
    };
    this.engine = createRoom({
      ...(this.statsSender ? this.statsSender.hooks(this.roomId) : {}),
      onResult: (r) => void this.saveResult(r),
      getPack: this.getPack,
      now: this.now,
      claimWindowMs: this.L.claimWindowMs,
      startRule: startRuleFor(this.roomId, this.meta),
      ...this.timers,
      broadcast: (t, d) => {
        if (t === "setVar" && d?.id === "sessionPhase") this.phaseAt = this.now(); // #142 hostStale
        // Roster-ish updates (a join storm, an answer storm: one per incoming message) are
        // coalesced into one fan-out per tick; anything else first flushes them (order kept).
        const key = t === "participants" ? t : t === "setVar" && COALESCED.has(d?.id) ? d.id : null;
        if (key) {
          this.coalesced.set(key, { t, d });
          this.coalesceTimer ??= this.timers.setTimer(() => this.flushCoalesced(), this.L.coalesceMs);
        } else {
          this.flushCoalesced();
          this.fanout(JSON.stringify({ t, d }));
        }
        this.schedulePersist();
      },
      send: (peerId, t, d) => {
        const s = this.peerMap().get(peerId);
        if (s) out(s, JSON.stringify({ t, d }));
      },
    });
    if (rejoin) {
      this.engine.restore(rejoin.snap.s, this.now() - rejoin.snap.at);
      for (const s of rejoin.sockets) this.engine.rejoin(s.state.peer, s.state);
    }
    return this.engine;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = this.timers.setTimer(() => {
      this.persistTimer = null;
      this.persist();
    }, this.L.persistMs);
  }

  /**
   * Keep the engine snapshot for a hibernation wake-up. Written only when the room is idle
   * (no engine timer pending — while one is, the DO cannot hibernate), only when it changed,
   * and not at all once the day's usage reached stage 1 (rows written are saved first).
   */
  persist() {
    if (!this.engine?.size || this.meter.stage >= 1) return;
    if (this.engine._state.session.timers.length) return this.schedulePersist(); // mid-game: later
    const snap = this.engine.snapshot();
    const key = JSON.stringify(snap.session) + JSON.stringify(snap.scores) + JSON.stringify(snap.vars);
    if (key === this.lastSnap) return;
    this.lastSnap = key;
    this.meter.count("rows");
    this.stats.snapWrites = (this.stats.snapWrites ?? 0) + 1;
    Promise.resolve(this.store.put("snap", { at: this.now(), s: snap })).catch(() => {});
  }

  /**
   * A scored game reached its result (engine onResult): a friends room keeps it 7 days for its
   * link — once per game (a game already stored is not written again), off the game's path.
   */
  saveResult(r) {
    const rec = resultRecord(this.roomId, r, this.now());
    if (!rec) return Promise.resolve();
    const run = this.resultChain.then(async () => {
      const old = await this.store.get("result");
      if (old?.sid === r.sid) {
        this.stats.resultDupes = (this.stats.resultDupes ?? 0) + 1;
        return;
      }
      // pin: 1 — a PIN room's result is read only with a pass / seat token (worker.js /result)
      await this.store.put("result", { sid: r.sid, exp: this.now() + RESULT_TTL_MS, rec, ...(this.meta?.pin ? { pin: 1 } : {}) });
      this.meter.count("rows", 3); // the write, the alarm moved to its expiry, and its delete then
      this.meter.count("alarms"); // that alarm firing at the expiry (a DO request; upper bound — a later game re-arms it)
      this.stats.resultWrites = (this.stats.resultWrites ?? 0) + 1;
    });
    this.resultChain = run.catch((e) => console.error("[edge-room] result", e));
    this.waitUntil(this.resultChain);
    return this.resultChain;
  }

  /**
   * GET /room/<id>/result: the room's last saved game (null = none, or older than 7 days). A PIN
   * room's result (`pin: 1`) only for a request the Worker checked a pass / seat token on (`adm`).
   */
  async readResult(adm = null) {
    this.meter.count("conns"); // one Worker + one DO request
    if (!this.sockets().length) this.meter.flush(true);
    else this.meter.tick();
    await this.resultChain;
    const res = await this.store.get("result");
    if (res?.pin && !(adm && (adm.v === "pass" || adm.v === "seat"))) return null;
    return res && res.exp > this.now() ? res.rec : null;
  }

  /**
   * A right PIN reached the room (Worker admit v "pin"): refused exactly like a wrong one while
   * this ipKey is locked or the room is closed; else its wrong-PIN entry is cleared. → null = in,
   * or the denial {reason, retryIn?} (the Worker sends it on a socket of its own, close 4003).
   */
  async upgradeCheck(adm) {
    if (adm?.v !== "pin") return null;
    const r = await this.pins.right(adm.i);
    if (r.wrote) this.meter.count("rows", r.wrote);
    if (!r.deny) return null;
    this.meter.count("conns"); // this upgrade reached the DO (one Worker + one DO request)
    if (!this.sockets().length) this.meter.flush(true);
    else this.meter.tick();
    return { reason: r.deny, ...(r.retryIn ? { retryIn: r.retryIn } : {}) };
  }

  /**
   * RPC from the Worker, wrong PIN only (admit.js decideUpgrade): count it in the PIN lock.
   * → {deny, left?, retryIn?, wrote, alarms} — the Worker counts this request and its rows in its
   * tally (no timer here). The organizer hears about repeated failures and the room closing.
   */
  async pinAttempt(ipKey) {
    const r = await this.pins.wrong(String(ipKey ?? "?"));
    let wrote = r.wrote;
    let alarms = 0;
    // The first wrong PIN of an empty room: an alarm so the lock is cleaned up after its 7 days
    // (roomAlarm keeps it until then; an occupied room arms its alarm when it empties).
    if (r.created && !this.sockets().length) {
      await this.setAlarm(this.now() + this.L.roomTtlMs);
      wrote += 1;
      alarms += 1;
    }
    if (r.alert || r.closedNow) {
      for (const s of this.peerMap().values()) {
        if (!s.state?.org) continue;
        if (r.alert) this.reply(s, "alert", { kind: "pin_failures", n: r.alert });
        if (r.closedNow) this.reply(s, "pinClosed", {});
      }
    }
    return { deny: r.deny, ...(r.left != null ? { left: r.left } : {}), ...(r.retryIn ? { retryIn: r.retryIn } : {}), wrote, alarms };
  }

  /** Frame budget of one socket: 0 = ok, else ms until it would be (then the socket is closed). */
  overBudget(sock) {
    const t = this.now();
    const L = this.L;
    let b = this.budgets.get(sock);
    if (!b) this.budgets.set(sock, (b = { tokens: L.frameBurst, at: t, hourAt: t, hour: 0, minAt: t, min: 0 }));
    b.tokens = Math.min(L.frameBurst, b.tokens + ((t - b.at) / 1000) * L.frameRate);
    b.at = t;
    if (t - b.hourAt >= 3600000) Object.assign(b, { hourAt: t, hour: 0 });
    if (t - b.minAt >= 60000) Object.assign(b, { minAt: t, min: 0 });
    b.hour += 1;
    b.min += 1;
    if (b.tokens < 1) return Math.max(1, Math.ceil(((1 - b.tokens) / L.frameRate) * 1000));
    b.tokens -= 1;
    if (b.hour > L.framesPerHour) return b.hourAt + 3600000 - t;
    if (this.meter.stage >= 3 && b.min > L.squeezePerMin) return b.minAt + 60000 - t;
    return 0;
  }

  /** A reaction this socket may spread now? (allowlist, ≤ reactsPerSec) */
  reactOk(sock, emoji) {
    if (!REACTIONS.has(emoji)) return false;
    const b = this.budgets.get(sock);
    if (!b) return true;
    const sec = Math.floor(this.now() / 1000);
    if (b.reactSec !== sec) Object.assign(b, { reactSec: sec, reacts: 0 });
    return ++b.reacts <= this.L.reactsPerSec;
  }

  /** After a wake from hibernation: memory is empty but players are still connected. */
  async rehydrate() {
    if (this.engine) return;
    const joined = this.sockets().filter((s) => s.state?.joined);
    this.meta ??= await this.store.get("meta");
    if (!joined.length) return;
    const snap = await this.store.get("snap");
    this.ensureEngine(snap ? { snap, sockets: joined } : null);
    // nothing saved: a fresh room for them — the organizer first (it hosts a "host" room)
    if (!snap) for (const s of [...joined].sort((a, b) => Number(Boolean(b.state.org)) - Number(Boolean(a.state.org)))) this.engine.join(s.state.peer, s.state);
    this.stats.rehydrated = (this.stats.rehydrated ?? 0) + 1;
  }

  /** A socket connected; `adm` = the Worker's admit claim (kept in the attachment for the hello). */
  onOpen(sock, adm = null) {
    const t = this.now();
    sock.save({ openedAt: t, joined: false, wrong: 0, ...(adm ? { adm: { v: adm.v, i: adm.i, c: adm.c, ...(adm.a ? { a: adm.a } : {}) } } : {}) });
    this.stats.conns += 1;
    this.meter.count("conns");
    const all = this.sockets();
    for (const s of all) {
      if (s === sock || s.state?.joined) continue;
      if (t - (s.state?.openedAt ?? t) > this.L.authTimeoutMs) s.close(4008, "hello timeout");
    }
    if (all.length > this.L.maxSockets) {
      sock.send(JSON.stringify({ t: "denied", d: { reason: "full" } }));
      sock.close(4029, "room full");
    }
  }

  onMessage(sock, data) {
    const run = this.chain.then(() => this.handle(sock, data));
    this.chain = run.catch((e) => console.error("[edge-room]", e));
    return run;
  }

  async handle(sock, data) {
    // Every incoming message is a DO request (1:1, #151) — refused and malformed ones too.
    this.meter.count("msgs");
    this.meter.tick();
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (raw.length > this.L.maxFrame) return sock.close(1009, "too big");
    const st = sock.state ?? {};
    if (st.slowed) return; // already refused, closing
    const wait = this.overBudget(sock);
    if (wait) {
      st.slowed = true;
      this.stats.slowed = (this.stats.slowed ?? 0) + 1;
      this.reply(sock, "denied", { reason: "slow", retryIn: wait });
      return this.closeQ(sock, 4029, "slow");
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      if (raw.length <= 16 && PINGISH.test(raw)) this.pingMiss();
      return;
    }
    const t = typeof m?.t === "string" ? m.t : "?";
    if (t === "ping" || (typeof m === "string" && PINGISH.test(m))) return this.pingMiss();
    this.stats.in += 1;
    this.stats.byType[t] = (this.stats.byType[t] ?? 0) + 1;
    if (!st.joined) {
      if (t !== "hello") return sock.close(4001, "hello first");
      return this.hello(sock, m.d ?? {});
    }
    await this.rehydrate();
    await this.hostCheck(sock);
    // Away (#213): anything but `away` from this socket says it is alive and on screen.
    if (t === "away") return this.markAway(sock, st); // (its pings were tallied just above: they stop now)
    if (st.awayAt != null) {
      delete st.awayAt;
      sock.save(st);
    }
    if (t === "here") return;
    if (t === "bye") {
      // Leaving for good: out of the room now (its close then changes nothing).
      this.closeQ(sock, 1000, "bye");
      return this.closed(sock);
    }
    const t0 = performance.now();
    if (t === "action") {
      const sec = Math.floor(this.now() / 1000);
      let r = this.rate.get(st);
      if (!r || r.sec !== sec) this.rate.set(st, (r = { sec, n: 0 }));
      const id = m.d?.clientMsgId;
      if (++r.n > this.L.actionsPerSec) return this.reply(sock, "actionAck", { clientMsgId: id, accepted: false, reason: "rate_limited" });
      this.engine.action(st.peer, m.d);
      // A rename the room took (#104) rides in the socket's attachment too, so a wake from
      // hibernation (rejoin from the attachment) keeps the new name, not the hello's.
      if (m.d?.name === "rename") {
        const nick = this.engine.nickOf(st.peer);
        if (nick && nick !== st.nick) {
          st.nick = nick;
          sock.save(st);
        }
      }
    } else if (t === "react") {
      if (this.reactOk(sock, m.d?.emoji)) this.engine.react(m.d.emoji);
      else this.stats.reactsDropped = (this.stats.reactsDropped ?? 0) + 1;
    }
    const took = performance.now() - t0;
    if (this.samples) this.samples.handle.push(took);
    this.stats.handleMs += took;
    if (took > this.stats.handleMaxMs) Object.assign(this.stats, { handleMaxMs: took, handleMaxWhat: m.d?.name ?? t });
    this.stats.handled += 1;
    // The seat token rides on traffic (no timers while hibernating).
    if (this.now() - (st.issuedAt ?? 0) >= this.L.tokenRefreshMs) await this.issueSeat(sock, st);
  }

  reply(sock, t, d) {
    this.queue(sock, JSON.stringify({ t, d }));
    this.stats.out += 1;
  }

  async issueSeat(sock, st) {
    st.issuedAt = this.now();
    sock.save(st);
    this.reply(sock, "token", { token: await this.gate.tokenFor(this.meta, { a: st.anonId }) });
  }

  async hello(sock, d) {
    const st = sock.state ?? {};
    const anonId = typeof d.anonId === "string" ? d.anonId : "";
    if ((d.slug != null && d.slug !== this.roomId) || !ANON_RE.test(anonId)) {
      this.reply(sock, "denied", { reason: "bad" });
      return this.closeQ(sock, 4000, "bad hello");
    }
    const g = await this.gate.check({ ...d, anonId }, st, st.adm ?? null);
    if (g.deny) {
      sock.save(st);
      this.reply(sock, "denied", { reason: g.deny, ...(g.retryIn ? { retryIn: g.retryIn } : {}) });
      if (g.close) this.closeQ(sock, g.close, g.deny);
      return;
    }
    this.meta = g.meta;
    await this.rehydrate();
    await this.hostCheck(sock, anonId); // (the host itself back on a new socket: not gone)
    // One seat per device: a second socket for this anonId only with the seat's token.
    const holder = this.sockets().find((s) => s !== sock && s.state?.joined && s.state.anonId === anonId);
    // A public room mid-game (#136): someone new would only watch — the next room plays soon.
    // Only clients that sent their app's start payload (they know moveTo); `stay` = refused there.
    const auto = d.autoStart && typeof d.autoStart === "object" ? d.autoStart : null;
    if (auto && !d.stay && !holder && this.engine?.startRule === "auto" && this.engine.wouldSpectate(anonId)) {
      this.stats.moved = (this.stats.moved ?? 0) + 1;
      this.reply(sock, "moveTo", { room: nextRoomId(this.roomId) });
      return this.closeQ(sock, 4010, "moved");
    }
    if (holder) {
      const reconnect = g.claims?.a === anonId || (g.claims?.o === 1 && holder.state.org);
      if (!reconnect) {
        this.reply(sock, "denied", { reason: "seat_taken" });
        return this.closeQ(sock, 4009, "seat taken");
      }
      holder.state.joined = false; // its close must not count as a leave
      this._peers = null;
      holder.state.replaced = true;
      holder.save(holder.state);
      this.closeQ(holder, 4009, "replaced");
      this.stats.takeovers = (this.stats.takeovers ?? 0) + 1;
    }
    this._peers = null;
    Object.assign(st, { joined: true, peer: `k${rid()}${rid()}`, anonId, nick: String(d.nick ?? "").slice(0, 40), org: g.organizer, wrong: 0 });
    await this.issueSeat(sock, st);
    if (g.organizer && !g.claims?.o) this.reply(sock, "organizer", { token: await this.gate.tokenFor(this.meta, { o: 1 }, this.L.organizerTtlMs) });
    else if (g.organizer) this.reply(sock, "organizer", { token: d.organizerToken });
    // Entered with the PIN: a pass for this device (12 h), so a reload does not ask again.
    if (st.adm?.v === "pin") this.reply(sock, "pass", await signPass(this.secret, this.roomId, anonId, this.now()));
    if (g.organizer && this.meta?.pin && (await this.pins.closed())) this.reply(sock, "pinClosed", {});
    this.ensureEngine().join(st.peer, st);
    if (auto) this.engine.configureAuto(auto.start, auto.ms); // the first one kept arms the lobby countdown
    // The new socket joins BEFORE the old one leaves (#115: a phone back from the share sheet
    // replaces a socket the room still holds): the person never leaves the roster, and a room
    // with only them in it keeps its game instead of being torn down and made anew.
    if (holder) this.engine.leave(holder.state.peer);
  }

  onClose(sock) {
    const run = this.chain.then(async () => {
      this.pingTally(sock);
      await this.closed(sock);
      await this.hostCheck(sock);
    });
    this.chain = run.catch((e) => console.error("[edge-room]", e));
    return run;
  }

  async closed(sock) {
    const st = sock.state ?? {};
    if (st.left) return; // already handled (bye / away sweep, then its close)
    st.left = true;
    const left = st.joined;
    // #213: a room woken from hibernation by this close is rebuilt WITH the leaver still in it —
    // rebuilt without, the engine never knew them, its leave() changed nothing and nobody was told
    // (everyone's count stayed). So: rebuild first, then the leave that tells everyone.
    if (left) await this.rehydrate();
    st.joined = false;
    this._peers = null;
    sock.save(st);
    if (left) {
      // away (#213): a host's / quiz subject's grace counts from when they went to the background
      if (this.engine?.leave(st.peer, st.awayAt != null ? { awaySince: st.awayAt } : undefined)) this.engine = null; // empty: torn down (as snack-server)
    }
    if (!this.sockets().some((s) => s !== sock && s.state?.joined)) {
      this.engine?.destroy();
      this.engine = null;
      this.coalesced.clear();
      if (this.coalesceTimer != null) this.timers.clearTimer(this.coalesceTimer);
      this.coalesceTimer = null;
      if (this.persistTimer) this.timers.clearTimer(this.persistTimer);
      this.persistTimer = null;
      if (this.lastSnap !== null) {
        await this.store.delete("snap"); // nicknames / scores leave with the last player
        this.meter.count("rows");
        this.lastSnap = null;
      }
      this.meter.count("rows", 1 + 3); // the alarm, and its deleteAll later (meta, lock?, snap?)
      this.meter.count("alarms"); // the alarm firing (a DO request; upper bound — emptying again replaces it)
      await this.setAlarm(this.now() + this.L.roomTtlMs);
      this.meter.flush(true);
      this.statsSender?.flush(); // the room is idle: send its games now (not awaited)
    }
  }

  /**
   * `away` (#213): mark the socket, and make sure the room's alarm goes off by its deadline. One alarm
   * for all: it is set only when this deadline is earlier than the one already set (in memory —
   * after a hibernation it is set again, which is harmless).
   */
  markAway(sock, st) {
    if (st.awayAt == null) {
      st.awayAt = this.now();
      sock.save(st);
    }
    const at = st.awayAt + this.L.awayGraceMs;
    if (this.awayAlarmAt != null && this.awayAlarmAt <= at && this.awayAlarmAt > this.now()) return;
    this.awayAlarmAt = at;
    this.meter.count("rows"); // the alarm (a write)…
    this.meter.count("alarms"); // …and its firing (a DO request)
    return this.setAlarm(at);
  }

  /** Let go of every socket away longer than the grace (#213); the alarm again for the next one. */
  async sweepAway() {
    const t = this.now();
    let next = null;
    for (const s of this.sockets()) {
      const st = s.state;
      if (!st?.joined || st.awayAt == null) continue;
      const due = st.awayAt + this.L.awayGraceMs;
      if (due > t) {
        next = next == null ? due : Math.min(next, due);
        continue;
      }
      this.stats.awayClosed = (this.stats.awayClosed ?? 0) + 1;
      this.closeQ(s, AWAY_CLOSE, "away");
      await this.closed(s);
    }
    await this.hostCheck(null);
    this.awayAlarmAt = null;
    if (next != null && this.sockets().some((s) => s.state?.joined)) {
      this.awayAlarmAt = next;
      this.meter.count("rows");
      this.meter.count("alarms");
      await this.setAlarm(next);
    }
  }

  /** The host's socket now (null: no host room, nobody hosting, or not here). */
  hostSock() {
    const host = this.engine?.startRule === "host" ? this.engine._state.session.host : "";
    if (!host) return null;
    for (const s of this.peerMap().values()) if (s.state?.anonId === host) return s;
    return null;
  }

  /**
   * #142, inside an event that already woke the room (`by` = its socket, null for the alarm): a host
   * phone gone without a word (no keepalive for hostStaleMs) leaves now — its grace counted from its
   * last sign of life, so the role is handed over at once. Never on a timer of its own.
   */
  async hostCheck(by, anonId = null) {
    const s = this.hostSock();
    if (!s) return;
    this.pingTally(s);
    if (s === by || (anonId && s.state?.anonId === anonId)) return; // its own frame / hello: alive
    const st = s.state;
    const pongAt = s.pongAt?.() ?? null;
    const seenAt = this.budgets.get(s)?.at ?? null;
    const now = this.now();
    if (!hostStale({ now, phase: this.engine._state.session.phase, away: st.awayAt != null, pongAt, seenAt, phaseAt: this.phaseAt ?? null, staleMs: this.L.hostStaleMs })) return;
    this.stats.hostLost = (this.stats.hostLost ?? 0) + 1;
    st.awayAt = Math.max(pongAt, seenAt ?? 0, this.phaseAt ?? 0); // the grace began at its last sign of life
    s.save(st);
    this.closeQ(s, LOST_CLOSE, "lost");
    await this.closed(s);
  }

  /**
   * #142 meter: the host's pings are answered without reaching the room, so they are estimated —
   * one per pingEveryMs since the last tally (run on every event and the close) (kept in the socket's attachment: a hibernation forgets
   * nothing), counted 1:1 as DO requests (whether CF counts them is not documented: the guard stays
   * conservative). Over-counts a game's time (no pings then) rather than under-count; away time skipped.
   */
  pingTally(s) {
    const st = s?.state;
    if (!st?.joined || s.pongAt?.() == null || this.hostSock() !== s) return; // never pinged on this socket: nothing to count
    const now = this.now();
    if (st.awayAt != null) {
      st.pingAt = now; // hidden: no pings meanwhile
      return s.save(st);
    }
    const from = st.pingAt ?? st.openedAt ?? now; // (first tally: from the socket's open — rather too many than too few)
    const n = Math.floor((now - from) / this.L.pingEveryMs);
    if (n <= 0) return;
    st.pingAt = from + n * this.L.pingEveryMs;
    s.save(st);
    this.meter.count("pings", n);
    this.stats.pingsEst = (this.stats.pingsEst ?? 0) + n;
  }

  /** A ping-like frame the auto-response did not match: it woke the room (GB-s). Should stay 0. */
  pingMiss() {
    this.meter.count("pingMiss");
    this.stats.pingMiss = (this.stats.pingMiss ?? 0) + 1;
  }

  async onAlarm() {
    if (this.sockets().some((s) => s.state?.joined)) {
      // occupied: the alarm was an away deadline (#213); the 24 h cleanup is set again when the room empties
      const run = this.chain.then(() => this.sweepAway());
      this.chain = run.catch((e) => console.error("[edge-room]", e));
      await run;
      return false;
    }
    if (this.sockets().length) return false;
    await this.resultChain;
    return roomAlarm({ store: this.store, now: this.now, setAlarm: this.setAlarm });
  }

  /** Tests: drop everything in memory, as an evicted (hibernated) DO would. */
  forget() {
    this._peers = null;
    this.coalesced.clear();
    if (this.coalesceTimer != null) this.timers.clearTimer(this.coalesceTimer);
    this.coalesceTimer = null;
    if (this.persistTimer) this.timers.clearTimer(this.persistTimer);
    this.persistTimer = null;
    this.engine?.destroy();
    this.engine = null;
    this.meta = null;
    this.awayAlarmAt = null; // (the alarm itself is in storage: it still fires)
    // …and its usage counts not yet reported (a woken DO starts a fresh counter).
    this.meter.stop();
    this.meter = this.newMeter();
    this.gate.meter = this.meter;
  }
}
