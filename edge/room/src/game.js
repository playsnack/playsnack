// Server-authoritative game room: the room engine (@snack/room createRoom — the same
// one snack-server runs for /ws and a host player runs in the mesh) runs HERE, inside
// the room's Durable Object. The DO is the host: no player device is trusted with the
// answers, the clock or the scores. Platform-free, so the Node hub runs it too.
//
// Wire protocol = snack-server's /ws (the player's ServerTransport speaks it):
//   client → {t:"hello", d:{slug, anonId, nick, pin?, token?, organize?, organizerToken?}}  first
//   client → {t:"action", d:{name, payload, clientMsgId}} | {t:"react", d:{emoji}}
//   room   → {t:"state"|"setVar"|"participants"|"reaction"|"actionAck", d}   (engine messages)
//   room   → {t:"token", d:{token}}        seat token (reconnect without the PIN, seat takeover)
//   room   → {t:"organizer", d:{token}}    to the room's creator, when it asked to organize
//   room   → {t:"denied", d:{reason, retryIn?}}   then usually a close
// Per-player variables (iAmSubject, myPid, myPick, iAmSpectator, iAmOut) go to that socket
// only (engine `send`); answers never leave before the reveal (engine: roundContent has no
// answer, picks stay inside, raceBoard shows pre-round scores while a round is open).
//
// One seat per device (anonId) per room: a second socket with the same anonId is refused
// unless it shows that seat's token (a reconnect) — then it takes the seat over.
// Organized rooms (created with organize: true): only the organizer may start a game,
// return to the lobby or set the quiz; everyone else just plays.
//
// Hibernation: engine state lives in memory; a pending engine timer (setTimeout) keeps the
// DO awake through a game. Idle (lobby / result), the DO may hibernate and lose memory, so
// the engine snapshot is kept in storage while the room is occupied and deleted when the
// last player leaves (then the 24 h alarm deletes the rest).
import { createRoom } from "../../../packages/snack-room/src/room.js";
import { RoomGate, LIMITS } from "./core.js";

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
};
const ORGANIZER_ONLY = new Set(["start", "lobby", "quizPack"]);
const ANON_RE = /^[A-Za-z0-9_-]{1,64}$/;
const rid = () => Math.random().toString(36).slice(2, 10);

export class GameRoom {
  /**
   * @param {object} o
   * @param {() => Array<{state: object, save(s: object): void, send(s: string): void, close(c?: number, r?: string): void}>} o.sockets  every socket of the room, now
   * @param {(game: string, opts: object) => Promise<any[] | null>} [o.getPack]
   */
  constructor({ roomId, store, secret, usage, setAlarm = () => {}, now = Date.now, limits = {}, sockets, getPack = async () => null, setTimer, clearTimer }) {
    if (!secret) throw new Error("ROOM_TOKEN_SECRET is required");
    Object.assign(this, { roomId, store, secret, usage, setAlarm, now, sockets, getPack });
    this.L = { ...GAME_LIMITS, ...limits };
    this.timers = { setTimer: setTimer ?? ((fn, ms) => setTimeout(fn, ms)), clearTimer: clearTimer ?? ((h) => clearTimeout(h)) };
    this.gate = new RoomGate({ roomId, store, secret, usage, now, limits: this.L });
    this.engine = null;
    this.meta = null;
    this.chain = Promise.resolve(); // every event of the room, in order
    this.persistTimer = null;
    this.rate = new WeakMap();
    // Accounting (memory only): frames in/out, bytes out, engine handling time.
    this.stats = { conns: 0, in: 0, out: 0, bytesOut: 0, broadcasts: 0, byType: {}, handleMs: 0, handled: 0 };
    this.pending = { conns: 0, msgs: 0 }; // for the usage meter, reported when the room empties
    this.awakeSince = null;
  }

  peers() {
    const m = new Map();
    for (const s of this.sockets()) if (s.state?.joined) m.set(s.state.peer, s);
    return m;
  }

  ensureEngine(rejoin) {
    if (this.engine) return this.engine;
    const out = (s, str) => {
      s.send(str);
      this.stats.out += 1;
      this.stats.bytesOut += str.length;
    };
    this.engine = createRoom({
      getPack: this.getPack,
      now: this.now,
      claimWindowMs: this.L.claimWindowMs,
      ...this.timers,
      broadcast: (t, d) => {
        const str = JSON.stringify({ t, d });
        this.stats.broadcasts += 1;
        for (const s of this.sockets()) if (s.state?.joined) out(s, str);
        this.schedulePersist();
      },
      send: (peerId, t, d) => {
        const s = this.peers().get(peerId);
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
      if (this.engine && this.engine.size) this.store.put("snap", { at: this.now(), s: this.engine.snapshot() }).catch?.(() => {});
    }, this.L.persistMs);
  }

  /** After a wake from hibernation: memory is empty but players are still connected. */
  async rehydrate() {
    if (this.engine) return;
    const joined = this.sockets().filter((s) => s.state?.joined);
    this.meta ??= await this.store.get("meta");
    if (!joined.length) return;
    const snap = await this.store.get("snap");
    this.ensureEngine(snap ? { snap, sockets: joined } : null);
    if (!snap) for (const s of joined) this.engine.join(s.state.peer, s.state); // nothing saved: a fresh room for them
    this.stats.rehydrated = (this.stats.rehydrated ?? 0) + 1;
  }

  onOpen(sock) {
    const t = this.now();
    sock.save({ openedAt: t, joined: false, wrong: 0 });
    this.stats.conns += 1;
    this.pending.conns += 1;
    this.awakeSince ??= t;
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
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (raw.length > this.L.maxFrame) return sock.close(1009, "too big");
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const st = sock.state ?? {};
    const t = typeof m?.t === "string" ? m.t : "?";
    this.stats.in += 1;
    this.pending.msgs += 1;
    this.stats.byType[t] = (this.stats.byType[t] ?? 0) + 1;
    if (!st.joined) {
      if (t !== "hello") return sock.close(4001, "hello first");
      return this.hello(sock, m.d ?? {});
    }
    await this.rehydrate();
    const t0 = performance.now();
    if (t === "action") {
      const sec = Math.floor(this.now() / 1000);
      let r = this.rate.get(st);
      if (!r || r.sec !== sec) this.rate.set(st, (r = { sec, n: 0 }));
      const id = m.d?.clientMsgId;
      if (++r.n > this.L.actionsPerSec) return this.reply(sock, "actionAck", { clientMsgId: id, accepted: false, reason: "rate_limited" });
      if (this.meta?.org && !st.org && ORGANIZER_ONLY.has(m.d?.name)) return this.reply(sock, "actionAck", { clientMsgId: id, accepted: false, reason: "organizer_only" });
      this.engine.action(st.peer, m.d);
    } else if (t === "react") this.engine.react(m.d?.emoji);
    this.stats.handleMs += performance.now() - t0;
    this.stats.handled += 1;
    // The seat token rides on traffic (no timers while hibernating).
    if (this.now() - (st.issuedAt ?? 0) >= this.L.tokenRefreshMs) await this.issueSeat(sock, st);
  }

  reply(sock, t, d) {
    sock.send(JSON.stringify({ t, d }));
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
      return sock.close(4000, "bad hello");
    }
    const g = await this.gate.check(d, st);
    if (g.deny) {
      sock.save(st);
      this.reply(sock, "denied", { reason: g.deny, ...(g.retryIn ? { retryIn: g.retryIn } : {}) });
      if (g.close) sock.close(g.close, g.deny);
      return;
    }
    this.meta = g.meta;
    await this.rehydrate();
    // One seat per device: a second socket for this anonId only with the seat's token.
    const holder = this.sockets().find((s) => s !== sock && s.state?.joined && s.state.anonId === anonId);
    if (holder) {
      const reconnect = g.claims?.a === anonId || (g.claims?.o === 1 && holder.state.org);
      if (!reconnect) {
        this.reply(sock, "denied", { reason: "seat_taken" });
        return sock.close(4009, "seat taken");
      }
      holder.state.joined = false; // its close must not count as a leave
      holder.state.replaced = true;
      holder.save(holder.state);
      this.engine?.leave(holder.state.peer);
      if (this.engine && !this.engine.size) this.engine = null;
      holder.close(4009, "replaced");
      this.stats.takeovers = (this.stats.takeovers ?? 0) + 1;
    }
    Object.assign(st, { joined: true, peer: `k${rid()}${rid()}`, anonId, nick: String(d.nick ?? "").slice(0, 40), org: g.organizer, wrong: 0 });
    await this.issueSeat(sock, st);
    if (g.organizer && !g.claims?.o) this.reply(sock, "organizer", { token: await this.gate.tokenFor(this.meta, { o: 1 }, this.L.organizerTtlMs) });
    else if (g.organizer) this.reply(sock, "organizer", { token: d.organizerToken });
    this.ensureEngine().join(st.peer, st);
  }

  onClose(sock) {
    const run = this.chain.then(() => this.closed(sock));
    this.chain = run.catch((e) => console.error("[edge-room]", e));
    return run;
  }

  async closed(sock) {
    const st = sock.state ?? {};
    const left = st.joined;
    st.joined = false;
    sock.save(st);
    if (left) {
      await this.rehydrate();
      if (this.engine?.leave(st.peer)) this.engine = null; // empty: torn down (as snack-server)
    }
    if (!this.sockets().some((s) => s !== sock && s.state?.joined)) {
      this.engine?.destroy();
      this.engine = null;
      if (this.persistTimer) this.timers.clearTimer(this.persistTimer);
      this.persistTimer = null;
      await this.store.delete("snap"); // nicknames / scores leave with the last player
      const d = { ...this.pending, awakeMs: this.awakeSince ? this.now() - this.awakeSince : 0 };
      this.pending = { conns: 0, msgs: 0 };
      this.awakeSince = null;
      if (this.usage) Promise.resolve(this.usage.add(d)).catch(() => {});
      await this.setAlarm(this.now() + this.L.roomTtlMs);
    }
  }

  async onAlarm() {
    if (this.sockets().length) return false;
    await this.store.deleteAll();
    return true;
  }

  /** Tests: drop everything in memory, as an evicted (hibernated) DO would. */
  forget() {
    if (this.persistTimer) this.timers.clearTimer(this.persistTimer);
    this.persistTimer = null;
    this.engine?.destroy();
    this.engine = null;
    this.meta = null;
  }
}
