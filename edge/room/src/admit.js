// Room admission (#157, docs/room-admission.md): signed room codes, the Worker's check before a
// room's Durable Object is woken, and the small signed tokens around it. Platform-free (WebCrypto
// only), so the Worker (worker.js) and the Node hub (packages/snack-room/tools/edgeHub.js) run
// the same decisions.
//
// Room code v2 (the link's `?room=`, alphabet of snack-player links.ts — 32 symbols, 5 bits each):
//   no PIN  15 = R(10) + T(5)          T = trunc25(HMAC(Kc, "c2|slug|R|o"))
//   PIN     20 = R(10) + T(5) + V(5)   T = trunc25(HMAC(Kc, "c2|slug|R|p")) · V = trunc25(HMAC(Kv, "v2|slug|R|pin"))
//   any other 8–32 symbols = legacy (codes made before v2), accepted until LEGACY_JOIN_UNTIL.
// T covers the slug and the kind: a code moved to another app, or a PIN code with V cut off,
// fails. The server stores no PIN: V is the check, and it is useless without the server key.
//
// Keys: HKDF-SHA256 from ROOM_TOKEN_SECRET, one per use (table in docs/room-admission.md). Seat and
// organizer tokens keep the plain secret (core.js signToken), so tabs already open keep working.

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_R = 10;
export const CODE_OPEN = 15;
export const CODE_PIN = 20;
const SYM = `[${CODE_ALPHABET}]`;
const CODE_RE = new RegExp(`^${SYM}{8,32}$`);
/** A public room: `slug` or a generation `slug.gN` (game.js nextRoomId). */
export const PUBLIC_ID_RE = /^[A-Za-z0-9-]{1,80}(\.g\d{1,6})?$/;
const SLUG_RE = /^[A-Za-z0-9-]{1,80}$/;
const FRIEND_ID_RE = /^([A-Za-z0-9-]{1,80})~(.+)$/;
export const PIN_FORMAT = /^\d{4}$/;
const ANON_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const ADMIT = {
  admitTtlMs: 30 * 1000, // Worker → DO claim
  passTtlMs: 12 * 60 * 60 * 1000, // PIN room: no PIN asked again for 12 h
  orgtTtlMs: 10 * 60 * 1000, // /mint organizer ticket
  mintMaxBytes: 1024,
};
/** Worker-side rate limits (Cloudflare `ratelimits` bindings; an in-isolate fallback otherwise). */
export const RATE = {
  IP_RL: { limit: 120, period: 60 }, // WebSocket upgrades per ipKey (generous: a park's NAT)
  PIN_RL: { limit: 10, period: 60 }, // PIN tries per ipKey|room
  PINIP_RL: { limit: 20, period: 60 }, // PIN tries per ipKey, all rooms
  MINT_RL: { limit: 10, period: 60 }, // /mint per ipKey
};
/** Close codes of a refused upgrade (the reason rides in the `denied` frame before it). */
export const CLOSE = { expired: 4004, "pin-required": 4003, pin: 4003, locked: 4003, closed: 4003, slow: 4029, origin: 4000, bad: 4000 };

const enc = new TextEncoder();
export const b64u = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKeys = new Map();
const hmacKey = (secret) => {
  let k = hmacKeys.get(secret);
  if (!k) {
    if (hmacKeys.size > 64) hmacKeys.clear();
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secret, k);
  }
  return k;
};
const hmac = async (secret, msg) => new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(msg)));

/** token = base64url(JSON payload) "." base64url(HMAC-SHA256) */
export async function signToken(secret, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64u(await hmac(secret, body))}`;
}
/** The payload if the signature is right, else null (expiry, room and kind are the caller's checks). */
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

// ── keys ──
const INFO = { Kc: "snack/code/v2", Kv: "snack/pin/v2", Ki: "snack/ip/v1", Ka: "snack/admit/v1", Kp: "snack/pass/v1", Ko: "snack/orgt/v1" };
const derived = new Map();
/** The derived keys of a secret (as strings, usable wherever a secret is): HKDF-SHA256, empty salt. */
export function keysOf(secret) {
  if (!secret) throw new Error("ROOM_TOKEN_SECRET is required");
  let p = derived.get(secret);
  if (!p) {
    p = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
      const out = {};
      for (const [k, info] of Object.entries(INFO)) {
        const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) }, base, 256);
        out[k] = b64u(new Uint8Array(bits));
      }
      return out;
    })();
    if (derived.size > 16) derived.clear();
    derived.set(secret, p);
  }
  return p;
}

// ── codes ──
/** The first 25 bits of an HMAC as 5 code symbols. */
const tag25 = async (key, msg) => {
  const h = await hmac(key, msg);
  const v = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 7;
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[(v >>> (20 - 5 * i)) & 31];
  return s;
};
const randomR = (randomBytes) => {
  const b = randomBytes(CODE_R);
  let s = "";
  for (let i = 0; i < CODE_R; i++) s += CODE_ALPHABET[b[i] & 31];
  return s;
};
/** Equal-length strings compared in constant time. */
export const sameStr = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** "open" (15) · "pin" (20) · "legacy" (other 8–32) · null (not a code). */
export function codeKind(code) {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  return code.length === CODE_OPEN ? "open" : code.length === CODE_PIN ? "pin" : "legacy";
}

/** A new v2 code for an app: 15 symbols, or 20 with a PIN. */
export async function mintCode(secret, slug, pin = null, randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const K = await keysOf(secret);
  const R = randomR(randomBytes);
  if (pin == null) return R + (await tag25(K.Kc, `c2|${slug}|${R}|o`));
  return R + (await tag25(K.Kc, `c2|${slug}|${R}|p`)) + (await tag25(K.Kv, `v2|${slug}|${R}|${pin}`));
}

/** Is T right for this slug and the code's kind? (V is not checked here.) */
export async function verifyCode(secret, slug, code) {
  const kind = codeKind(code);
  if (kind !== "open" && kind !== "pin") return false;
  const K = await keysOf(secret);
  const R = code.slice(0, CODE_R);
  return sameStr(code.slice(CODE_R, CODE_R + 5), await tag25(K.Kc, `c2|${slug}|${R}|${kind === "pin" ? "p" : "o"}`));
}

/** Does this PIN match the code's V? (A 20-symbol code only.) */
export async function pinMatches(secret, slug, code, pin) {
  if (codeKind(code) !== "pin" || typeof pin !== "string" || !PIN_FORMAT.test(pin)) return false;
  const K = await keysOf(secret);
  return sameStr(code.slice(CODE_R + 5), await tag25(K.Kv, `v2|${slug}|${code.slice(0, CODE_R)}|${pin}`));
}

/**
 * What a room id is: {kind:"public"} · {kind:"open"|"pin"|"legacy", slug, code} ·
 * {kind:"bad"} (a `~` id whose code is not a code) · null (not a room id at all).
 */
export function parseRoomId(id) {
  if (typeof id !== "string") return null;
  if (PUBLIC_ID_RE.test(id)) return { kind: "public" };
  const m = FRIEND_ID_RE.exec(id);
  if (!m) return null;
  const kind = codeKind(m[2]);
  return kind ? { kind, slug: m[1], code: m[2] } : { kind: "bad" };
}

// ── ipKey ──
/** IPv6 → its /64 (first four groups, expanded); IPv4 (also v4-mapped) as is; else null. */
export function ipPrefix(ip) {
  if (typeof ip !== "string" || !ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  if (v4) return `4|${v4[1]}`;
  const s = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (!/^[0-9a-f:]+$/.test(s) || s.split("::").length > 2) return null;
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return `6|${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}`;
}
/** A short keyed hash of the client's network (never the IP itself): rate limits and the PIN lock. */
export async function ipKeyOf(secret, ip) {
  const K = await keysOf(secret);
  return b64u((await hmac(K.Ki, ipPrefix(ip) ?? "?")).slice(0, 8));
}

// ── tokens ──
/**
 * Worker → DO: this upgrade was checked. v: open | pin | pass | seat | public | legacy; c: may create the room.
 * @param {string} secret
 * @param {{r: string, v: string, i: string, a?: string, c: number|boolean}} claim
 */
export async function signAdmit(secret, { r, v, i, a, c }, now = Date.now()) {
  const K = await keysOf(secret);
  return signToken(K.Ka, { r, k: "admit", v, i, ...(a ? { a } : {}), c: c ? 1 : 0, exp: now + ADMIT.admitTtlMs });
}
const kindOk = (p, k, r, now) => (p && p.k === k && p.r === r && typeof p.exp === "number" && p.exp > now ? p : null);
export async function verifyAdmit(secret, token, r, now = Date.now()) {
  const K = await keysOf(secret);
  return kindOk(await verifyToken(K.Ka, token), "admit", r, now);
}
/** PIN room: the device (anonId) gets in without the PIN for 12 h. */
export async function signPass(secret, r, a, now = Date.now()) {
  const K = await keysOf(secret);
  const exp = now + ADMIT.passTtlMs;
  return { token: await signToken(K.Kp, { r, k: "pass", a, exp }), exp };
}
export async function verifyPass(secret, token, r, now = Date.now()) {
  const K = await keysOf(secret);
  return kindOk(await verifyToken(K.Kp, token), "pass", r, now);
}
/** /mint organizer ticket: whoever holds it organizes the room it creates (10 min). */
export async function signOrgt(secret, r, now = Date.now()) {
  const K = await keysOf(secret);
  return signToken(K.Ko, { r, k: "orgt", exp: now + ADMIT.orgtTtlMs });
}
export async function verifyOrgt(secret, token, r, now = Date.now()) {
  const K = await keysOf(secret);
  return kindOk(await verifyToken(K.Ko, token), "orgt", r, now);
}
/** A seat or organizer token (plain secret, no `k`) for this room, not expired. The epoch is the DO's check. */
export async function verifySeat(secret, token, r, now = Date.now()) {
  const p = await verifyToken(secret, token);
  return p && !p.k && p.r === r && typeof p.exp === "number" && p.exp > now ? p : null;
}

// ── rate limits ──
/** Fixed-window counter per key, in this isolate only (bounded LRU) — the fallback for a `ratelimits` binding. */
export class MemoryLimiter {
  constructor({ limit, period, max = 5000, now = Date.now }) {
    this.limitN = limit;
    this.periodMs = period * 1000;
    this.max = max;
    this.now = now;
    this.m = new Map();
  }
  async limit({ key }) {
    const t = this.now();
    let e = this.m.get(key);
    if (!e || t - e.start >= this.periodMs) e = { start: t, n: 0 };
    this.m.delete(key);
    this.m.set(key, e);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
    e.n += 1;
    return { success: e.n <= this.limitN, retryIn: e.n <= this.limitN ? 0 : e.start + this.periodMs - t };
  }
}
/** {IP_RL, PIN_RL, PINIP_RL, MINT_RL}: the env's binding where there is one (`.limit({key})`), else `fallback[name]`. */
export function limitersFrom(env, fallback) {
  const out = {};
  for (const name of Object.keys(RATE)) out[name] = typeof env?.[name]?.limit === "function" ? env[name] : fallback[name];
  return out;
}
export const memoryLimiters = (now = Date.now) => Object.fromEntries(Object.entries(RATE).map(([k, v]) => [k, new MemoryLimiter({ ...v, now })]));
const over = async (lim, key) => {
  if (!lim) return null;
  try {
    const r = await lim.limit({ key });
    return r?.success === false ? { retryIn: r.retryIn || 60000 } : null;
  } catch {
    return null; // a limiter that fails open: the DO's own limits still hold
  }
};

// ── config ──
const deadline = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
/** The Worker's vars → {allowedOrigins, legacyCreateUntil, legacyJoinUntil} (empty = no limit). */
export function configFrom(env = {}) {
  return {
    allowedOrigins: String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    legacyCreateUntil: deadline(env.LEGACY_CREATE_UNTIL),
    legacyJoinUntil: deadline(env.LEGACY_JOIN_UNTIL),
  };
}
/** No Origin header (not a browser) passes; with a list, an Origin must match (`*` = one host label run). */
export function originAllowed(origin, allowed) {
  if (!origin || !allowed?.length) return true;
  return allowed.some((p) => {
    if (p === origin || p === "*") return true;
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[A-Za-z0-9.-]*")}$`);
    return re.test(origin);
  });
}

// ── decisions ──
const deny = (reason, extra = {}) => ({ deny: { reason, close: CLOSE[reason] ?? 4000, ...extra } });

/**
 * A WebSocket upgrade to /room/<id>, before any Durable Object is woken.
 * @param {object} o
 * @param {string} o.secret
 * @param {string} o.roomId
 * @param {URLSearchParams} o.params  `k` (pass / seat / organizer token) and `pin`
 * @param {string} [o.ip]  CF-Connecting-IP
 * @param {string|null} [o.origin]
 * @param {number} [o.now]
 * @param {ReturnType<typeof configFrom>} [o.cfg]
 * @param {Record<string, {limit(o: {key: string}): Promise<{success: boolean}>}>} [o.limiters]
 * @param {(ipKey: string) => Promise<{deny: string, left?: number, retryIn?: number, wrote?: number, alarms?: number}>} [o.pinAttempt]  wrong PIN → the room's PIN lock (one DO request)
 * @returns {Promise<{forward: {admit: string, claim: any}, deny?: undefined} | {deny: {reason: string, close: number, retryIn?: number, left?: number}, rpc?: boolean, rows?: number, alarms?: number, forward?: undefined}>}
 */
export async function decideUpgrade({ secret, roomId, params, ip = "", origin = null, now = Date.now(), cfg = configFrom(), limiters = {}, pinAttempt }) {
  const id = parseRoomId(roomId);
  if (!id) return deny("bad");
  if (!originAllowed(origin, cfg.allowedOrigins)) return deny("origin");
  const i = await ipKeyOf(secret, ip);
  const slow = await over(limiters.IP_RL, i);
  if (slow) return deny("slow", slow);
  const fwd = async (v, c, a) => {
    const claim = { r: roomId, v, i, ...(a ? { a } : {}), c: c ? 1 : 0 };
    return { forward: { admit: await signAdmit(secret, claim, now), claim } };
  };
  if (id.kind === "public") return fwd("public", true);
  if (id.kind === "bad") return deny("expired");
  if (id.kind === "legacy") {
    if (cfg.legacyJoinUntil != null && now >= cfg.legacyJoinUntil) return deny("expired");
    return fwd("legacy", cfg.legacyCreateUntil == null || now < cfg.legacyCreateUntil);
  }
  if (!(await verifyCode(secret, id.slug, id.code))) return deny("expired");
  if (id.kind === "open") return fwd("open", true);
  // A PIN room: a pass or a seat / organizer token first (they get in even when the room is closed to new PINs).
  const k = params?.get("k");
  if (k) {
    const pass = await verifyPass(secret, k, roomId, now);
    if (pass && typeof pass.a === "string" && ANON_RE.test(pass.a)) return fwd("pass", true, pass.a);
    if (await verifySeat(secret, k, roomId, now)) return fwd("seat", false);
  }
  const pin = params?.get("pin");
  if (pin == null || pin === "") return deny("pin-required");
  const s1 = (await over(limiters.PIN_RL, `${i}|${roomId}`)) ?? (await over(limiters.PINIP_RL, i));
  if (s1) return deny("slow", s1);
  if (!PIN_FORMAT.test(pin)) return deny("pin");
  if (await pinMatches(secret, id.slug, id.code, pin)) return fwd("pin", true);
  if (!pinAttempt) return deny("pin");
  const r = await pinAttempt(i);
  const extra = {};
  if (typeof r?.left === "number") extra.left = r.left;
  if (typeof r?.retryIn === "number") extra.retryIn = r.retryIn;
  return { ...deny(r?.deny || "pin", extra), rpc: true, rows: r?.wrote ?? 0, alarms: r?.alarms ?? 0 };
}

/**
 * POST /mint {slug, pin?, anonId?} (text/plain, ≤ 1 KB) → {status, body}: a new room code and its
 * organizer ticket; with a PIN, also the creator's pass (bound to anonId). No Durable Object.
 */
/** @param {{secret: string, text: string|null, ip?: string, origin?: string|null, now?: number, cfg?: ReturnType<typeof configFrom>, limiters?: Record<string, any>, randomBytes?: (n: number) => Uint8Array}} o */
export async function decideMint({ secret, text, ip = "", origin = null, now = Date.now(), cfg = configFrom(), limiters = {}, randomBytes = undefined }) {
  if (!originAllowed(origin, cfg.allowedOrigins)) return { status: 403, body: { ok: false, error: "origin" } };
  if (typeof text !== "string" || enc.encode(text).length > ADMIT.mintMaxBytes) return { status: 400, body: { ok: false, error: "bad_request" } };
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return { status: 400, body: { ok: false, error: "bad_request" } };
  }
  const slug = b?.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { status: 400, body: { ok: false, error: "bad_slug" } };
  const pin = b.pin == null || b.pin === "" ? null : b.pin;
  if (pin !== null && (typeof pin !== "string" || !PIN_FORMAT.test(pin))) return { status: 400, body: { ok: false, error: "bad_pin" } };
  if (pin !== null && (typeof b.anonId !== "string" || !ANON_RE.test(b.anonId))) return { status: 400, body: { ok: false, error: "bad_anon" } };
  const slow = await over(limiters.MINT_RL, await ipKeyOf(secret, ip));
  if (slow) return { status: 429, body: { ok: false, error: "slow", retryIn: slow.retryIn } };
  const code = await mintCode(secret, slug, pin, randomBytes);
  const r = `${slug}~${code}`;
  const body = { ok: true, code, org: await signOrgt(secret, r, now) };
  if (pin !== null) body.pass = await signPass(secret, r, b.anonId, now);
  return { status: 200, body };
}

/**
 * GET /room/<id>/result: a friends room whose code checks out; a PIN room only with `?k=` (pass or
 * seat / organizer token). → {forward: {admit?}} or {notFound: true} (no Durable Object woken).
 */
export async function decideResult({ secret, roomId, params, now = Date.now(), cfg = configFrom() }) {
  const id = parseRoomId(roomId);
  if (!id || id.kind === "public" || id.kind === "bad") return { notFound: true };
  if (id.kind === "legacy") return cfg.legacyJoinUntil != null && now >= cfg.legacyJoinUntil ? { notFound: true } : { forward: {} };
  if (!(await verifyCode(secret, id.slug, id.code))) return { notFound: true };
  if (id.kind === "open") return { forward: {} };
  const k = params?.get("k");
  if (!k) return { notFound: true };
  const pass = await verifyPass(secret, k, roomId, now);
  const v = pass ? "pass" : (await verifySeat(secret, k, roomId, now)) ? "seat" : null;
  if (!v) return { notFound: true };
  return { forward: { admit: await signAdmit(secret, { r: roomId, v, i: "-", c: 0 }, now) } };
}

/** Drop every client-sent `x-room-*` header (only the Worker sets them) — on a Headers object. */
export function stripRoomHeaders(headers) {
  for (const k of [...headers.keys()]) if (k.toLowerCase().startsWith("x-room-")) headers.delete(k);
  return headers;
}

/**
 * The Worker's own refusals (no DO request each) for the usage meter, batched per isolate: one
 * meter call per `every` counted requests or `everyMs` (checked on the next request — no timer).
 */
export class WorkerTally {
  constructor({ every = 200, everyMs = 60000, now = Date.now } = {}) {
    this.every = every;
    this.everyMs = everyMs;
    this.now = now;
    this.d = { workerExtra: 0, doExtra: 0, rows: 0 };
    this.last = now();
  }
  /** Count; → the delta to send now (and reset), or null. */
  count({ workerExtra = 0, doExtra = 0, rows = 0 } = {}) {
    this.d.workerExtra += workerExtra;
    this.d.doExtra += doExtra;
    this.d.rows += rows;
    const n = this.d.workerExtra + this.d.doExtra;
    if (!n || (n < this.every && this.now() - this.last < this.everyMs)) return null;
    const d = this.d;
    this.d = { workerExtra: 0, doExtra: 0, rows: 0 };
    this.last = this.now();
    return d;
  }
}
