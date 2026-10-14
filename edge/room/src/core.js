// Room relay core — the logic of one room, with no platform in it.
//
// The Cloudflare Durable Object (worker.js) and the Node test hub
// (packages/snack-room/tools/edgeHub.js) both drive this same code, so what the
// sims prove on the hub is what the Worker runs. Only WebCrypto (globalThis.crypto)
// is used — present in workerd and in Node ≥ 20.
//
// Protocol (one WebSocket per player at /room/<roomId>):
//   client → {t:"auth", peer, pin?, token?}   the FIRST message; nothing is relayed before it
//   relay  → {ctl:"ok", token}                 in; token = HMAC-SHA256 {r, p, exp} (15 min)
//          → {ctl:"token", token}              a fresh token (sent with traffic, ≥ 5 min apart)
//          → {ctl:"denied", reason, retryIn?}  reason: pin | pin-required | locked | busy | full | bad
//   client → any JSON {from: <its peer>, ...}  relayed verbatim to every OTHER authed socket
//   relay  → {from, t:"bye"}                   when a socket closes without having said bye
//                                               (what the MQTT last will did)
// Control frames carry `ctl` and no `from`; mesh messages always carry `from`.
//
// Stored per room (and nothing else — no nicknames, messages or IPs):
//   meta  {epoch, created, iter?, salt?, hash?}   epoch = random id of this incarnation
//   lock  {fails, until, step, hour: [ts…]}       wrong-PIN limiter (only after a wrong PIN)
// The alarm deletes both 24 h after the last socket leaves.

export const LIMITS = {
  tokenTtlMs: 15 * 60 * 1000,
  tokenRefreshMs: 5 * 60 * 1000,
  roomTtlMs: 24 * 60 * 60 * 1000, // storage kept after the last socket leaves
  pinIterations: 50000, // PBKDF2-SHA256; stored per room (see docs/edge-relay.md §PIN)
  lockAfter: 5, // wrong PINs in a row → lock
  lockMs: 60 * 1000, // first lock; doubles each time (until a right PIN)
  maxLockMs: 60 * 60 * 1000,
  wrongPerHour: 20,
  wrongPerConn: 3, // then the socket is closed
  maxSockets: 32,
  maxFrame: 256 * 1024,
  msgsPerSec: 60, // per socket; above → closed (a client publishes ~1–15/s)
  authTimeoutMs: 10000, // an unauthed socket older than this is closed on the next connect
};

// Room ids are `slug` or `slug~CODE` (snack-player links.ts roomIdFor): URL-unreserved chars.
export const ROOM_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const PEER_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PIN_RE = /^.{1,32}$/su;

const enc = new TextEncoder();
const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomId = (n = 12) => b64u(crypto.getRandomValues(new Uint8Array(n)));

export async function hashPin(pin, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64u(salt), iterations }, key, 256);
  return hex(new Uint8Array(bits));
}
// Constant-time for equal lengths (both are 64 hex chars).
const sameHex = (a, b) => {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const hmacKeys = new Map();
const hmacKey = (secret) => {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secret, k);
  }
  return k;
};
/** token = base64url(JSON {r, p, exp}) "." base64url(HMAC-SHA256) */
export async function signToken(secret, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64u(new Uint8Array(sig))}`;
}
/** The payload if the signature is right, else null (expiry and room are the caller's checks). */
export async function verifyToken(secret, token) {
  if (typeof token !== "string" || token.length > 512) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), enc.encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(unb64u(body))) : null;
  } catch {
    return null;
  }
}

/** An in-memory stand-in for DurableObjectStorage (get/put/delete/deleteAll). */
export function memoryStore() {
  const m = new Map();
  return {
    map: m,
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => void m.set(k, structuredClone(v)),
    delete: async (k) => m.delete(k),
    deleteAll: async () => m.clear(),
  };
}

/**
 * Daily usage guard: refuses NEW rooms once today's estimate passes a safe share of
 * the free limits. Estimates (docs/edge-relay.md §limits):
 *   requests ≈ sockets opened (1 Worker + 1 DO request each) + incoming messages / 20
 *              + 2 per room (this meter) ; GB-s ≈ room-awake seconds × 0.128 GB.
 * Days are UTC (Cloudflare resets the free limits at 00:00 UTC).
 */
export const FREE = { workerRequests: 100000, doRequests: 100000, doGbSeconds: 13000 };
export class UsageMeter {
  constructor({ store, now = Date.now, share = 0.7, free = FREE }) {
    this.store = store;
    this.now = now;
    this.cap = { req: free.doRequests * share, wreq: free.workerRequests * share, gbs: free.doGbSeconds * share };
  }
  async today() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const u = (await this.store.get("usage")) ?? {};
    return u.day === day ? u : { day, rooms: 0, conns: 0, msgs: 0, awakeMs: 0, refused: 0 };
  }
  static estimate(u) {
    return { workerRequests: u.conns, doRequests: u.conns + Math.ceil(u.msgs / 20) + 2 * u.rooms, doGbSeconds: (u.awakeMs / 1000) * 0.128 };
  }
  /** May a new room open? Counts it if so. */
  async admit() {
    const u = await this.today();
    const e = UsageMeter.estimate(u);
    const ok = e.doRequests < this.cap.req && e.workerRequests < this.cap.wreq && e.doGbSeconds < this.cap.gbs;
    if (ok) u.rooms += 1;
    else u.refused += 1;
    await this.store.put("usage", u);
    return ok;
  }
  async add({ conns = 0, msgs = 0, awakeMs = 0 }) {
    const u = await this.today();
    u.conns += conns;
    u.msgs += msgs;
    u.awakeMs += awakeMs;
    await this.store.put("usage", u);
  }
  async report() {
    const u = await this.today();
    return { ...u, estimate: UsageMeter.estimate(u) };
  }
}

/**
 * One room. Sockets are adapters: {send(str), close(code, reason), state, save(state)}
 * where `state` is the socket's small JSON record (a hibernatable attachment in the DO).
 * `sockets()` lists every socket of the room (including the one being handled).
 */
export class RoomRelay {
  constructor({ roomId, store, secret, usage, setAlarm = () => {}, now = Date.now, limits = {} }) {
    if (!secret) throw new Error("ROOM_TOKEN_SECRET is required");
    this.roomId = roomId;
    this.store = store;
    this.secret = secret;
    this.usage = usage; // {admit(): Promise<bool>, add({conns, msgs, awakeMs})} or null
    this.setAlarm = setAlarm;
    this.now = now;
    this.L = { ...LIMITS, ...limits };
    this.authChain = Promise.resolve(); // auths run one at a time (create / lock state)
    this.rate = new WeakMap(); // socket state → {sec, n} (memory only)
    this.pending = { conns: 0, msgs: 0 }; // not yet reported to the usage meter
    this.awakeSince = null;
    // Accounting for the sims (memory only, never stored).
    this.stats = { conns: 0, in: 0, out: 0, bytesIn: 0, byType: {}, authFail: 0 };
  }

  /** A socket connected (before any message). Returns false if it was refused. */
  onOpen(sock, sockets) {
    const t = this.now();
    sock.save({ openedAt: t, authed: false, wrong: 0 });
    this.stats.conns += 1;
    this.pending.conns += 1;
    this.awakeSince ??= t;
    // Unauthed sockets cannot be timed out while hibernating: sweep stale ones here.
    for (const s of sockets) {
      if (s === sock || s.state?.authed) continue;
      if (t - (s.state?.openedAt ?? t) > this.L.authTimeoutMs) s.close(4008, "auth timeout");
    }
    if (sockets.length > this.L.maxSockets) {
      sock.send(JSON.stringify({ ctl: "denied", reason: "full" }));
      sock.close(4029, "room full");
      return false;
    }
    return true;
  }

  async onMessage(sock, data, sockets) {
    const st = sock.state ?? {};
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (raw.length > this.L.maxFrame) return sock.close(1009, "too big");
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      m = null;
    }
    if (!st.authed) {
      if (m?.t !== "auth") return sock.close(4001, "auth first");
      const run = this.authChain.then(() => this.auth(sock, m));
      this.authChain = run.catch(() => {});
      return run;
    }
    // Rate limit per socket (memory only — hibernation resets it, which is fine).
    const sec = Math.floor(this.now() / 1000);
    let r = this.rate.get(st);
    if (!r || r.sec !== sec) this.rate.set(st, (r = { sec, n: 0 }));
    if (++r.n > this.L.msgsPerSec) return sock.close(4029, "too fast");
    if (!m || typeof m !== "object" || m.from !== st.peer) return; // spoofed / not a mesh message
    this.stats.in += 1;
    this.stats.bytesIn += raw.length;
    const t = typeof m.t === "string" ? m.t.slice(0, 16) : "?";
    this.stats.byType[t] = (this.stats.byType[t] ?? 0) + 1;
    this.pending.msgs += 1;
    if (t === "bye") {
      st.byeSent = true;
      sock.save(st);
    }
    // Token refresh rides on traffic (no timers while hibernating).
    if (this.now() - (st.issuedAt ?? 0) >= this.L.tokenRefreshMs) {
      st.issuedAt = this.now();
      sock.save(st);
      sock.send(JSON.stringify({ ctl: "token", token: await this.token(st.epoch) }));
    }
    for (const s of sockets) {
      if (s === sock || !s.state?.authed) continue;
      s.send(raw);
      this.stats.out += 1;
    }
    if (this.pending.msgs >= 1000) this.flushUsage(false);
  }

  async onClose(sock, sockets) {
    const st = sock.state ?? {};
    const others = sockets.filter((s) => s !== sock);
    if (st.authed && !st.byeSent && !others.some((s) => s.state?.authed && s.state.peer === st.peer)) {
      const bye = JSON.stringify({ from: st.peer, t: "bye" });
      for (const s of others) {
        if (!s.state?.authed) continue;
        s.send(bye);
        this.stats.out += 1;
      }
    }
    st.authed = false;
    sock.save(st);
    if (!others.length) {
      this.flushUsage(true);
      await this.setAlarm(this.now() + this.L.roomTtlMs);
    }
  }

  /** The cleanup alarm: delete the room's storage if nobody came back. */
  async onAlarm(sockets) {
    if (sockets.length) return false;
    await this.store.deleteAll();
    return true;
  }

  flushUsage(empty) {
    const t = this.now();
    const awakeMs = this.awakeSince ? t - this.awakeSince : 0;
    this.awakeSince = empty ? null : t;
    const d = { ...this.pending, awakeMs };
    this.pending = { conns: 0, msgs: 0 };
    if (this.usage && (d.conns || d.msgs || d.awakeMs)) Promise.resolve(this.usage.add(d)).catch(() => {});
  }

  token(epoch) {
    return signToken(this.secret, { r: this.roomId, p: epoch, exp: this.now() + this.L.tokenTtlMs });
  }

  deny(sock, reason, extra = {}) {
    this.stats.authFail += 1;
    sock.send(JSON.stringify({ ctl: "denied", reason, ...extra }));
  }

  async auth(sock, m) {
    const st = sock.state ?? {};
    if (st.authed) return;
    const peer = typeof m.peer === "string" ? m.peer : "";
    if (!PEER_RE.test(peer)) {
      this.deny(sock, "bad");
      return sock.close(4000, "bad auth");
    }
    this.gate ??= new RoomGate({ roomId: this.roomId, store: this.store, secret: this.secret, usage: this.usage, now: this.now, limits: this.L });
    const g = await this.gate.check(m, st);
    if (g.deny) {
      sock.save(st);
      this.deny(sock, g.deny, g.retryIn ? { retryIn: g.retryIn } : {});
      if (g.close) sock.close(g.close, g.deny);
      return;
    }
    Object.assign(st, { authed: true, peer, epoch: g.meta.epoch, issuedAt: this.now(), wrong: 0 });
    sock.save(st);
    sock.send(JSON.stringify({ ctl: "ok", token: await this.token(g.meta.epoch) }));
  }
}

/**
 * Who may enter a room: creates it (usage guard, optional PIN, optional organizer),
 * checks tokens, PINs and the wrong-PIN limiter. Shared by the relay and the game room.
 * `st` is the socket's record: st.wrong counts this connection's wrong PINs.
 * → {meta, claims?, organizer, created?} or {deny, retryIn?, close?}
 */
export class RoomGate {
  constructor({ roomId, store, secret, usage, now = Date.now, limits = {} }) {
    Object.assign(this, { roomId, store, secret, usage, now, L: { ...LIMITS, ...limits } });
  }

  tokenFor(meta, extra = {}, ttl = this.L.tokenTtlMs) {
    return signToken(this.secret, { r: this.roomId, p: meta.epoch, exp: this.now() + ttl, ...extra });
  }

  /** The token's claims if it is valid for THIS room incarnation, else null. */
  async claims(meta, token) {
    if (!token) return null;
    const p = await verifyToken(this.secret, token);
    return p && p.r === this.roomId && p.p === meta.epoch && p.exp > this.now() ? p : null;
  }

  async check(m, st) {
    const pin = m.pin == null || m.pin === "" ? null : String(m.pin);
    if (pin !== null && !PIN_RE.test(pin)) return { deny: "bad", close: 4000 };
    let meta = await this.store.get("meta");
    if (!meta) {
      // A new room (or one deleted after 24 h idle): the usage guard decides.
      if (this.usage && !(await this.usage.admit())) return { deny: "busy", close: 4029 };
      meta = { epoch: randomId(), created: this.now() };
      if (pin !== null) {
        meta.salt = randomId(16);
        meta.iter = this.L.pinIterations;
        meta.hash = await hashPin(pin, meta.salt, meta.iter);
      }
      if (m.organize === true) meta.org = 1; // whoever creates it organizes it
      await this.store.put("meta", meta);
      return { meta, organizer: Boolean(meta.org), created: true };
    }
    const org = meta.org ? await this.claims(meta, m.organizerToken) : null;
    if (org?.o === 1) return { meta, claims: org, organizer: true };
    const claims = await this.claims(meta, m.token);
    if (claims && !claims.o) return { meta, claims, organizer: false };
    if (!meta.hash) return { meta, organizer: false };
    if (pin === null) return { deny: "pin-required" };

    const t = this.now();
    const lock = (await this.store.get("lock")) ?? { fails: 0, until: 0, step: this.L.lockMs, hour: [] };
    lock.hour = lock.hour.filter((x) => t - x < 3600000);
    if (t < lock.until) return { deny: "locked", retryIn: lock.until - t };
    if (lock.hour.length >= this.L.wrongPerHour) return { deny: "locked", retryIn: lock.hour[0] + 3600000 - t };
    if (sameHex(await hashPin(pin, meta.salt, meta.iter), meta.hash)) {
      if (lock.fails || lock.step !== this.L.lockMs) await this.store.put("lock", { fails: 0, until: 0, step: this.L.lockMs, hour: lock.hour });
      return { meta, organizer: false };
    }
    lock.fails += 1;
    lock.hour.push(t);
    let retryIn = 0;
    if (lock.fails >= this.L.lockAfter) {
      lock.until = t + lock.step;
      retryIn = lock.step;
      lock.step = Math.min(lock.step * 2, this.L.maxLockMs);
      lock.fails = 0;
    }
    await this.store.put("lock", lock);
    st.wrong = (st.wrong ?? 0) + 1;
    const close = st.wrong >= this.L.wrongPerConn ? 4003 : 0;
    return retryIn ? { deny: "locked", retryIn, close } : { deny: "pin", close };
  }
}
