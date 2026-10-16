// Room admission (#157, docs/room-admission.md), in memory (no network, no ports): signed room
// codes, the Worker's upgrade decision (admit.js), the PIN lock (core.js PinLock), the game room's
// side (pass bound to the device, organizer only from a /mint ticket on `~` ids, public ids never
// organized or PIN-locked), the per-socket budget and the meter's new counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../../../edge/room/src/admit.js";
import { PinLock, UsageMeter, memoryStore, signToken } from "../../../edge/room/src/core.js";
import { GameRoom, roomAlarm } from "../../../edge/room/src/game.js";

const S = "unit-secret";
const SLUG = "tpl-tap-battle";
const ALPHA = A.CODE_ALPHABET;
const flip = (code, i) => code.slice(0, i) + ALPHA[(ALPHA.indexOf(code[i]) + 1) % 32] + code.slice(i + 1);
const params = (o = {}) => new URLSearchParams(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── codes ──
test("codes: 15 (no PIN) and 20 (PIN) symbols round-trip; kinds by length", async () => {
  const open = await A.mintCode(S, SLUG);
  const pin = await A.mintCode(S, SLUG, "4821");
  assert.equal(open.length, 15);
  assert.equal(pin.length, 20);
  assert.match(open + pin, new RegExp(`^[${ALPHA}]+$`));
  assert.equal(A.codeKind(open), "open");
  assert.equal(A.codeKind(pin), "pin");
  assert.equal(await A.verifyCode(S, SLUG, open), true);
  assert.equal(await A.verifyCode(S, SLUG, pin), true);
  assert.equal(await A.pinMatches(S, SLUG, pin, "4821"), true);
  assert.equal(await A.pinMatches(S, SLUG, pin, "4822"), false);
  assert.equal(await A.pinMatches(S, SLUG, pin, "482"), false, "not 4 digits");
  for (const n of [8, 10, 14, 16, 21, 32]) assert.equal(A.codeKind("A".repeat(n)), "legacy", `${n} symbols`);
  for (const bad of ["A".repeat(7), "A".repeat(33), "AAAAAAAAA0", "aaaaaaaaaa", ""]) assert.equal(A.codeKind(bad), null);
});

test("codes: one symbol changed, another app's slug, V cut off, another secret — all refused", async () => {
  const open = await A.mintCode(S, SLUG);
  const pin = await A.mintCode(S, SLUG, "4821");
  for (let i = 0; i < 15; i++) assert.equal(await A.verifyCode(S, SLUG, flip(open, i)), false, `open, symbol ${i}`);
  for (let i = 0; i < 15; i++) assert.equal(await A.verifyCode(S, SLUG, flip(pin, i)), false, `pin, symbol ${i}`);
  assert.equal(await A.verifyCode(S, "tpl-quiz-ox", open), false, "slug swap");
  assert.equal(await A.verifyCode(S, SLUG, pin.slice(0, 15)), false, "V stripped: T was made for a PIN code");
  assert.equal(await A.verifyCode("other-secret", SLUG, open), false);
  // a changed V keeps T valid but no PIN matches the old one
  assert.equal(await A.pinMatches(S, SLUG, flip(pin, 17), "4821"), false);
});

test("room ids: public / open / pin / legacy / bad / not an id", async () => {
  const open = await A.mintCode(S, SLUG);
  assert.deepEqual(A.parseRoomId("tpl-tap-battle"), { kind: "public" });
  assert.deepEqual(A.parseRoomId("tpl-tap-battle.g12"), { kind: "public" });
  assert.deepEqual(A.parseRoomId(`${SLUG}~${open}`), { kind: "open", slug: SLUG, code: open });
  assert.equal(A.parseRoomId(`${SLUG}~ABCDEFGHJK`).kind, "legacy");
  assert.equal(A.parseRoomId(`${SLUG}~abc`).kind, "bad");
  assert.equal(A.parseRoomId("a_b"), null);
  assert.equal(A.parseRoomId("x.y.z"), null);
});

test("ipKey: an IPv6 /64 is one key, IPv4 addresses are each their own; never the address", async () => {
  const k = (ip) => A.ipKeyOf(S, ip);
  assert.equal(await k("2001:db8:1:2:aaaa::1"), await k("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.equal(await k("2001:db8:1:2::1"), await k("2001:0db8:0001:0002:0:0:0:9"));
  assert.notEqual(await k("2001:db8:1:2::1"), await k("2001:db8:1:3::1"));
  assert.notEqual(await k("10.0.0.1"), await k("10.0.0.2"));
  assert.equal(await k("::ffff:10.0.0.1"), await k("10.0.0.1"), "v4-mapped = v4");
  const key = await k("10.0.0.1");
  assert.match(key, /^[A-Za-z0-9_-]{11}$/);
  assert.ok(!key.includes("10.0"));
});

test("tokens: each kind verifies only as itself (pass ↔ orgt ↔ seat ↔ admit), for its room, until it expires", async () => {
  const r = `${SLUG}~${await A.mintCode(S, SLUG)}`;
  const t0 = 1_000_000;
  const pass = (await A.signPass(S, r, "dev1", t0)).token;
  const orgt = await A.signOrgt(S, r, t0);
  const seat = await signToken(S, { r, p: "epoch", exp: t0 + 60000, a: "dev1" });
  const admit = await A.signAdmit(S, { r, v: "open", i: "ik", c: 1 }, t0);
  assert.ok(await A.verifyPass(S, pass, r, t0));
  assert.ok(await A.verifyOrgt(S, orgt, r, t0));
  assert.ok(await A.verifySeat(S, seat, r, t0));
  assert.ok(await A.verifyAdmit(S, admit, r, t0));
  for (const [name, verify] of Object.entries({ pass: A.verifyPass, orgt: A.verifyOrgt, seat: A.verifySeat, admit: A.verifyAdmit })) {
    for (const [other, tok] of Object.entries({ pass, orgt, seat, admit })) {
      if (other === name) continue;
      assert.equal(await verify(S, tok, r, t0), null, `${other} is not a ${name}`);
    }
    assert.equal(await verify(S, { pass, orgt, seat, admit }[name], `${r}X`, t0), null, `${name}: another room`);
  }
  assert.equal(await A.verifyAdmit(S, admit, r, t0 + 29_999) !== null, true);
  assert.equal(await A.verifyAdmit(S, admit, r, t0 + 30_000), null, "admit claim: 30 s");
  assert.equal(await A.verifyOrgt(S, orgt, r, t0 + 10 * 60_000), null, "orgt: 10 min");
  assert.equal(await A.verifyPass(S, pass, r, t0 + 12 * 3600_000), null, "pass: 12 h");
});

test("headers: every client-sent x-room-* header is dropped before the Worker sets its own", () => {
  const h = new Headers({ "x-room-admit": "forged", "X-Room-Id": "other", "x-room-anything": "1", upgrade: "websocket", origin: "https://playsnack.pages.dev" });
  A.stripRoomHeaders(h);
  assert.deepEqual([...h.keys()].sort(), ["origin", "upgrade"]);
});

test("origins: no header passes; a list must match (* = host labels); empty list = all", () => {
  const list = ["https://playsnack.pages.dev", "https://*.playsnack.pages.dev", "http://localhost:*"];
  assert.equal(A.originAllowed(null, list), true);
  assert.equal(A.originAllowed("https://playsnack.pages.dev", list), true);
  assert.equal(A.originAllowed("https://abc123.playsnack.pages.dev", list), true);
  assert.equal(A.originAllowed("http://localhost:5290", list), true);
  assert.equal(A.originAllowed("https://evil.example", list), false);
  assert.equal(A.originAllowed("https://playsnack.pages.dev.evil.example", list), false);
  assert.equal(A.originAllowed("https://evil.example", []), true);
});

// ── the Worker's decision ──
const decide = (o) => A.decideUpgrade({ secret: S, ip: "10.0.0.1", now: 1_000_000, limiters: A.memoryLimiters(() => 1_000_000), ...o });

test("decideUpgrade: a forged code, a swapped slug, a stripped V are refused 'expired' without touching the room", async () => {
  const open = await A.mintCode(S, SLUG);
  const pin = await A.mintCode(S, SLUG, "4821");
  let rpc = 0;
  const pinAttempt = async () => (rpc++, { deny: "pin", left: 4, wrote: 1 });
  for (const roomId of [`${SLUG}~${flip(open, 12)}`, `tpl-quiz-ox~${open}`, `${SLUG}~${pin.slice(0, 15)}`, `${SLUG}~not-a-code`]) {
    const d = await decide({ roomId, params: params({ pin: "4821" }), pinAttempt });
    assert.deepEqual(d.deny, { reason: "expired", close: 4004 }, roomId);
  }
  assert.equal(rpc, 0, "no PIN-lock RPC: nothing reached a Durable Object");
  const ok = await decide({ roomId: `${SLUG}~${open}`, params: params() });
  assert.equal(ok.forward.claim.v, "open");
  assert.equal(ok.forward.claim.c, 1);
  const adm = await A.verifyAdmit(S, ok.forward.admit, `${SLUG}~${open}`, 1_000_000);
  assert.equal(adm.v, "open");
  assert.equal(adm.i, await A.ipKeyOf(S, "10.0.0.1"));
});

test("decideUpgrade: PIN room — no PIN, wrong PIN (one RPC), right PIN (no RPC), pass, seat; k / pin never forwarded", async () => {
  const pin = await A.mintCode(S, SLUG, "4821");
  const roomId = `${SLUG}~${pin}`;
  let rpc = 0;
  const pinAttempt = async () => (rpc++, { deny: "pin", left: 4, wrote: 1, alarms: 1 });
  assert.deepEqual((await decide({ roomId, params: params(), pinAttempt })).deny, { reason: "pin-required", close: 4003 });
  const wrong = await decide({ roomId, params: params({ pin: "1111" }), pinAttempt });
  assert.deepEqual(wrong.deny, { reason: "pin", close: 4003, left: 4 });
  assert.equal(wrong.rpc, true);
  assert.equal(wrong.rows, 1);
  assert.equal(wrong.alarms, 1);
  assert.equal(rpc, 1);
  assert.deepEqual((await decide({ roomId, params: params({ pin: "12a4" }), pinAttempt })).deny, { reason: "pin", close: 4003 }, "not 4 digits: refused, not counted");
  assert.equal(rpc, 1);
  const right = await decide({ roomId, params: params({ pin: "4821" }), pinAttempt });
  assert.equal(right.forward.claim.v, "pin");
  assert.equal(rpc, 1, "a right PIN costs no RPC");
  const pass = (await A.signPass(S, roomId, "dev1", 1_000_000)).token;
  const viaPass = await decide({ roomId, params: params({ k: pass }), pinAttempt });
  assert.deepEqual([viaPass.forward.claim.v, viaPass.forward.claim.a, viaPass.forward.claim.c], ["pass", "dev1", 1]);
  const seat = await signToken(S, { r: roomId, p: "e", exp: 2_000_000 });
  const viaSeat = await decide({ roomId, params: params({ k: seat }), pinAttempt });
  assert.deepEqual([viaSeat.forward.claim.v, viaSeat.forward.claim.c], ["seat", 0], "a seat never creates the room");
  const otherRoomPass = (await A.signPass(S, `${SLUG}~${await A.mintCode(S, SLUG, "4821")}`, "dev1", 1_000_000)).token;
  assert.equal((await decide({ roomId, params: params({ k: otherRoomPass }) })).deny.reason, "pin-required");
  assert.equal(JSON.stringify(right.forward).includes("4821"), false);
});

test("decideUpgrade: legacy codes until the deadlines (fake clock); public ids create; Origin and rate limits", async () => {
  const roomId = `${SLUG}~ABCDEFGHJK`;
  const cfg = A.configFrom({ LEGACY_CREATE_UNTIL: "2026-10-20T00:00:00Z", LEGACY_JOIN_UNTIL: "2026-10-27T00:00:00Z" });
  const at = (iso) => decide({ roomId, params: params(), cfg, now: Date.parse(iso) });
  assert.deepEqual([(await at("2026-10-19T23:59:59Z")).forward.claim.v, (await at("2026-10-19T23:59:59Z")).forward.claim.c], ["legacy", 1]);
  assert.equal((await at("2026-10-20T00:00:00Z")).forward.claim.c, 0, "after LEGACY_CREATE_UNTIL: joins only");
  assert.deepEqual((await at("2026-10-27T00:00:00Z")).deny, { reason: "expired", close: 4004 });
  const empty = A.configFrom({ LEGACY_CREATE_UNTIL: "", LEGACY_JOIN_UNTIL: "" });
  assert.equal((await decide({ roomId, params: params(), cfg: empty, now: Date.parse("2030-01-01") })).forward.claim.c, 1, "empty deadlines = today's behaviour");
  const pub = await decide({ roomId: "tpl-tap-battle.g3", params: params({ pin: "1234" }) });
  assert.deepEqual([pub.forward.claim.v, pub.forward.claim.c], ["public", 1]);
  assert.deepEqual((await decide({ roomId: "a_b", params: params() })).deny, { reason: "bad", close: 4000 });
  const ocfg = A.configFrom({ ALLOWED_ORIGINS: "https://playsnack.pages.dev" });
  assert.deepEqual((await decide({ roomId: SLUG, params: params(), cfg: ocfg, origin: "https://evil.example" })).deny, { reason: "origin", close: 4000 });
  const lim = A.memoryLimiters(() => 1_000_000);
  for (let i = 0; i < 120; i++) assert.ok((await decide({ roomId: SLUG, params: params(), limiters: lim })).forward);
  const slow = await decide({ roomId: SLUG, params: params(), limiters: lim });
  assert.equal(slow.deny.reason, "slow");
  assert.equal(slow.deny.close, 4029);
  assert.equal(slow.deny.retryIn, 60000);
  assert.ok((await decide({ roomId: SLUG, params: params(), limiters: lim, ip: "10.0.0.2" })).forward, "another address is not limited");
});

test("decideUpgrade: PIN tries per ipKey|room (10/min) and per ipKey (20/min) stop before any RPC", async () => {
  const lim = A.memoryLimiters(() => 1_000_000);
  let rpc = 0;
  const pinAttempt = async () => (rpc++, { deny: "pin", left: 4, wrote: 1 });
  const rooms = [];
  for (let i = 0; i < 3; i++) rooms.push(`${SLUG}~${await A.mintCode(S, SLUG, "4821")}`);
  for (let i = 0; i < 10; i++) assert.equal((await decide({ roomId: rooms[0], params: params({ pin: "0000" }), limiters: lim, pinAttempt })).deny.reason, "pin");
  assert.equal((await decide({ roomId: rooms[0], params: params({ pin: "0000" }), limiters: lim, pinAttempt })).deny.reason, "slow", "11th try on one room");
  for (let i = 0; i < 9; i++) await decide({ roomId: rooms[1], params: params({ pin: "0000" }), limiters: lim, pinAttempt });
  // ipKey total: 10 + 1 (refused on PIN_RL, counted on PINIP_RL? no — PIN_RL refused first) + 9 = 19 counted on PINIP_RL
  const last = await decide({ roomId: rooms[2], params: params({ pin: "0000" }), limiters: lim, pinAttempt });
  assert.equal(last.deny.reason, "pin", "20th counted try across rooms");
  assert.equal((await decide({ roomId: rooms[2], params: params({ pin: "0000" }), limiters: lim, pinAttempt })).deny.reason, "slow", "21st across rooms");
  assert.equal(rpc, 20);
});

test("decideMint: code + organizer ticket (+ pass with a PIN); bad input; Origin; 10 a minute", async () => {
  const lim = A.memoryLimiters(() => 1_000_000);
  const mint = (body, o = {}) => A.decideMint({ secret: S, text: typeof body === "string" ? body : JSON.stringify(body), ip: "10.0.0.9", now: 1_000_000, limiters: lim, ...o });
  const r = await mint({ slug: SLUG });
  assert.equal(r.status, 200);
  assert.equal(r.body.code.length, 15);
  assert.ok(await A.verifyOrgt(S, r.body.org, `${SLUG}~${r.body.code}`, 1_000_000));
  assert.equal(r.body.pass, undefined);
  const p = await mint({ slug: SLUG, pin: "4821", anonId: "dev1" });
  assert.equal(p.body.code.length, 20);
  assert.ok(await A.pinMatches(S, SLUG, p.body.code, "4821"));
  assert.equal((await A.verifyPass(S, p.body.pass.token, `${SLUG}~${p.body.code}`, 1_000_000)).a, "dev1");
  assert.equal(JSON.stringify(p.body).includes("4821"), false, "the PIN is not in the answer");
  assert.equal((await mint({ slug: "bad slug" })).body.error, "bad_slug");
  assert.equal((await mint({ slug: SLUG, pin: "12345", anonId: "d" })).body.error, "bad_pin");
  assert.equal((await mint({ slug: SLUG, pin: "1234" })).body.error, "bad_anon");
  assert.equal((await mint("{nope")).status, 400);
  assert.equal((await mint("x".repeat(2000))).status, 400);
  assert.equal((await mint({ slug: SLUG }, { origin: "https://evil.example", cfg: A.configFrom({ ALLOWED_ORIGINS: "https://playsnack.pages.dev" }) })).status, 403);
  for (let i = 0; i < 8; i++) assert.equal((await mint({ slug: SLUG })).status, 200); // + the 2 above = 10 (refused input never reaches the limiter)
  const slow = await mint({ slug: SLUG });
  assert.equal(slow.status, 429, "11th mint in a minute from one address");
  assert.equal(slow.body.error, "slow");
});

test("decideResult: open code as before; PIN room only with a pass / seat token; forged / expired legacy → 404", async () => {
  const open = `${SLUG}~${await A.mintCode(S, SLUG)}`;
  const pin = `${SLUG}~${await A.mintCode(S, SLUG, "4821")}`;
  const res = (roomId, k, cfg) => A.decideResult({ secret: S, roomId, params: params(k ? { k } : {}), now: 1_000_000, cfg });
  assert.deepEqual(await res(open), { forward: {} });
  assert.deepEqual(await res(`${SLUG}~${flip(open.split("~")[1], 3)}`), { notFound: true });
  assert.deepEqual(await res(pin), { notFound: true });
  assert.deepEqual(await res(pin, "junk"), { notFound: true });
  const r = await res(pin, (await A.signPass(S, pin, "dev1", 1_000_000)).token);
  assert.equal((await A.verifyAdmit(S, r.forward.admit, pin, 1_000_000)).v, "pass");
  assert.deepEqual(await res(`${SLUG}~ABCDEFGHJK`), { forward: {} });
  assert.deepEqual(await res(`${SLUG}~ABCDEFGHJK`, null, A.configFrom({ LEGACY_JOIN_UNTIL: "1" })), { notFound: true });
});

test("WorkerTally: one meter call per 200 refusals or per 60 s (checked on the next request)", () => {
  let t = 0;
  const w = new A.WorkerTally({ now: () => t });
  for (let i = 0; i < 199; i++) assert.equal(w.count({ workerExtra: 1 }), null);
  assert.deepEqual(w.count({ workerExtra: 1, doExtra: 1, rows: 1 }), { workerExtra: 200, doExtra: 1, rows: 1 });
  assert.equal(w.count({ workerExtra: 1 }), null);
  t = 60_000;
  assert.deepEqual(w.count({ workerExtra: 1 }), { workerExtra: 2, doExtra: 0, rows: 0 });
});

// ── the PIN lock ──
test("PinLock: per ipKey — 5 wrong → 1 min, doubling; others unaffected; a right PIN resets; locked tries write nothing", async () => {
  let t = 1_000_000;
  const store = memoryStore();
  let puts = 0;
  const put = store.put;
  store.put = (k, v) => (puts++, put(k, v));
  const p = new PinLock({ store, now: () => t });
  for (let i = 1; i <= 4; i++) assert.deepEqual(await p.wrong("A"), { deny: "pin", left: 5 - i, wrote: 1, created: i === 1 });
  assert.deepEqual(await p.wrong("A"), { deny: "locked", retryIn: 60000, wrote: 1, created: false, alert: 5 });
  assert.equal(puts, 5);
  assert.deepEqual(await p.wrong("A"), { deny: "locked", retryIn: 60000, wrote: 0 }, "locked: read only");
  assert.deepEqual(await p.right("A"), { deny: "locked", retryIn: 60000, wrote: 0 }, "a right PIN while locked = the same answer");
  assert.equal(puts, 5);
  assert.deepEqual(await p.right("B"), { wrote: 0 }, "B is not locked (and had nothing to clear)");
  t += 60_000;
  for (let i = 1; i <= 4; i++) await p.wrong("A");
  assert.equal((await p.wrong("A")).retryIn, 120000, "second lock: 2 min");
  t += 120_000;
  assert.deepEqual(await p.right("A"), { wrote: 1 }, "a right PIN clears A");
  assert.equal((await store.get("pinlock")).ip.A, undefined);
  assert.deepEqual((await p.wrong("A")).left, 4, "and the next lock starts at 1 min again");
});

test("PinLock: 50 wrong in all close the code — kept 7 days, through the room's own cleanup", async () => {
  let t = 1_000_000;
  const store = memoryStore();
  const p = new PinLock({ store, now: () => t });
  let last;
  for (let i = 0; i < 50; i++) last = await p.wrong(`ip${Math.floor(i / 4)}`); // 4 per address: never locked
  assert.deepEqual([last.deny, last.closedNow], ["closed", true]);
  assert.equal(Object.keys((await store.get("pinlock")).ip).length, 13);
  assert.deepEqual(await p.right("fresh"), { deny: "closed", wrote: 0 });
  assert.deepEqual(await p.wrong("fresh"), { deny: "closed", wrote: 0 });
  // the room empties and its 24 h alarm fires: meta / snap go, the PIN lock stays
  await store.put("meta", { epoch: "e" });
  let alarmAt = null;
  t += 24 * 3600_000;
  assert.equal(await roomAlarm({ store, now: () => t, setAlarm: (at) => (alarmAt = at) }), false);
  assert.equal(await store.get("meta"), undefined);
  assert.equal((await store.get("pinlock")).wrong, 50);
  assert.equal(alarmAt, 1_000_000 + 7 * 24 * 3600_000, "the alarm moves to the lock's expiry");
  assert.equal(await new PinLock({ store, now: () => t }).closed(), true, "a new incarnation still refuses PINs");
  t = alarmAt;
  assert.equal(await roomAlarm({ store, now: () => t, setAlarm: () => {} }), true, "after 7 days everything goes");
  assert.equal(await store.get("pinlock"), undefined);
});

// ── the game room's side ──
function sock() {
  return {
    state: {},
    frames: [],
    closed: null,
    save(s) {
      this.state = s;
    },
    send(str) {
      this.frames.push(JSON.parse(str));
    },
    close(code) {
      this.closed = code;
    },
    frame(t) {
      return this.frames.find((m) => m.t === t);
    },
  };
}
function room(roomId, { usage = null, limits = {} } = {}) {
  const socks = [];
  const store = memoryStore();
  const r = new GameRoom({ roomId, store, secret: S, usage, limits, sockets: () => socks });
  const join = async (anonId, adm, hello = {}) => {
    const s = sock();
    socks.push(s);
    r.onOpen(s, adm);
    await r.onMessage(s, JSON.stringify({ t: "hello", d: { slug: roomId, anonId, nick: anonId, ...hello } }));
    await sleep(5);
    return s;
  };
  return { r, store, socks, join };
}
const claim = (v, extra = {}) => ({ v, i: "ik1", c: 1, ...extra });

test("game room: the organizer comes from a /mint ticket on a `~` id only; `organize: true` is ignored on v2 codes", async () => {
  const id = `${SLUG}~${await A.mintCode(S, SLUG)}`;
  const g = room(id);
  const host = await g.join("h1", claim("open"), { organize: true, organizerToken: await A.signOrgt(S, id) });
  assert.ok(host.frame("organizer"), "orgt → organizer (12 h token)");
  assert.ok(await A.verifySeat(S, host.frame("organizer").d.token, id), "the organizer token is a plain-secret token");
  const late = await g.join("h2", claim("open"), { organizerToken: await A.signOrgt(S, id) });
  assert.equal(late.frame("organizer"), undefined, "a ticket only counts when the room is created");
  const id2 = `${SLUG}~${await A.mintCode(S, SLUG)}`;
  const g2 = room(id2);
  const a = await g2.join("a1", claim("open"), { organize: true });
  assert.equal(a.frame("organizer"), undefined, "v2: organize is ignored");
  const g3 = room(`${SLUG}~${await A.mintCode(S, SLUG)}`);
  assert.equal((await g3.join("x", claim("open"), { organizerToken: await A.signOrgt(S, id) })).frame("organizer"), undefined, "another room's ticket");
});

test("game room: a public id never gets an organizer or a PIN (the prank path)", async () => {
  const g = room("tpl-tap-battle");
  const a = await g.join("a1", claim("public"), { organize: true, pin: "9999", organizerToken: await A.signOrgt(S, "tpl-tap-battle") });
  assert.equal(a.frame("organizer"), undefined);
  const b = await g.join("b1", claim("public"));
  assert.ok(b.frame("state"), "joined without the PIN the first one tried to set");
  assert.equal((await g.store.get("meta")).hash, undefined);
  assert.equal((await g.store.get("meta")).org, undefined);
});

test("game room: legacy codes keep today's rules (organize, PBKDF2 PIN) on `~` ids", async () => {
  const id = `${SLUG}~ABCDEFGHJK`;
  const g = room(id, { limits: { pinIterations: 1000 } });
  const a = await g.join("a1", claim("legacy"), { organize: true, pin: "8080" });
  assert.ok(a.frame("organizer"));
  const b = await g.join("b1", claim("legacy"), { pin: "1111" });
  assert.equal(b.frame("denied").d.reason, "pin");
  const c = await g.join("c1", claim("legacy"), { pin: "8080" });
  assert.ok(c.frame("state"));
  const gone = room(`${SLUG}~ABCDEFGHJM`);
  const d = await gone.join("d1", claim("legacy", { c: 0 }));
  assert.equal(d.frame("denied").d.reason, "expired", "after LEGACY_CREATE_UNTIL a legacy code cannot create");
  await sleep(5);
  assert.equal(d.closed, 4004);
});

test("game room: PIN entry → a pass bound to that device; the pass works for that anonId only", async () => {
  const id = `${SLUG}~${await A.mintCode(S, SLUG, "4821")}`;
  const g = room(id);
  const a = await g.join("devA", claim("pin"));
  const pass = a.frame("pass");
  assert.ok(pass, "a pass after the hello");
  const p = await A.verifyPass(S, pass.d.token, id);
  assert.equal(p.a, "devA");
  assert.ok(pass.d.exp > Date.now() + 11 * 3600_000);
  assert.ok((await g.store.get("meta")).pin, "the room knows it is a PIN room");
  const other = await g.join("devB", claim("pass", { a: "devA" }));
  assert.equal(other.frame("denied").d.reason, "pin-required", "someone else's pass");
  const again = await g.join("devA2", claim("pass", { a: "devA2" }));
  assert.ok(again.frame("state"));
  assert.equal(again.frame("pass"), undefined, "a pass entry does not mint another pass");
  const seat = await g.join("devC", claim("seat", { c: 0 }), { token: "junk" });
  assert.equal(seat.frame("denied").d.reason, "pin-required", "a seat token from another epoch asks for the PIN");
});

test("game room: the right-PIN check refuses a locked address like a wrong PIN; the organizer hears alerts and the close", async () => {
  const id = `${SLUG}~${await A.mintCode(S, SLUG, "4821")}`;
  const g = room(id);
  const host = await g.join("host", claim("pass", { a: "host" }), { organizerToken: await A.signOrgt(S, id) });
  assert.ok(host.frame("organizer"));
  const friend = await g.join("fr", claim("pin", { i: "ikF" }));
  assert.ok(friend.frame("state"));
  let last;
  for (let i = 0; i < 5; i++) last = await g.r.pinAttempt("ikA");
  assert.deepEqual([last.deny, last.retryIn], ["locked", 60000]);
  assert.deepEqual(await g.r.upgradeCheck(claim("pin", { i: "ikA" })), { reason: "locked", retryIn: 60000 });
  assert.equal(await g.r.upgradeCheck(claim("pin", { i: "ikB" })), null);
  await sleep(5);
  assert.deepEqual(host.frames.filter((m) => m.t === "alert").map((m) => m.d), [{ kind: "pin_failures", n: 5 }]);
  assert.equal(friend.frame("alert"), undefined, "only the organizer");
  for (let i = 0; i < 45; i++) last = await g.r.pinAttempt(`ip${i}`);
  assert.equal(last.deny, "closed");
  await sleep(5);
  assert.ok(host.frame("pinClosed"));
  assert.deepEqual(await g.r.upgradeCheck(claim("pin", { i: "ikB" })), { reason: "closed" });
  const back = await g.join("fr2", claim("pass", { a: "fr2" }));
  assert.ok(back.frame("state"), "a pass still gets in after the close");
});

test("game room: reactions ≤ 3/s from the allowlist; a socket over its frame budget is refused slow (4029)", async () => {
  const g = room("tpl-tap-battle");
  const a = await g.join("a1", claim("public"));
  const b = await g.join("b1", claim("public"));
  for (let i = 0; i < 6; i++) await g.r.onMessage(a, JSON.stringify({ t: "react", d: { emoji: "🔥" } }));
  await g.r.onMessage(a, JSON.stringify({ t: "react", d: { emoji: "💩" } }));
  await sleep(5);
  const seen = b.frames.filter((m) => m.t === "reaction").length;
  assert.ok(seen <= 3 && seen >= 1, `≤ 3 reactions spread in a second (saw ${seen})`);
  assert.equal(b.frames.some((m) => m.t === "reaction" && m.d.emoji === "💩"), false);
  for (let i = 0; i < 30; i++) await g.r.onMessage(a, JSON.stringify({ t: "react", d: { emoji: "👍" } }));
  await sleep(5);
  assert.equal(a.frames.find((m) => m.t === "denied")?.d.reason, "slow");
  assert.equal(a.closed, 4029);
  assert.equal(b.closed, null, "the others play on");
});

test("meter: new rooms per address — the 21st in an hour is slow; Worker refusals count as Worker requests", async () => {
  let t = 1_000_000;
  const m = new UsageMeter({ store: memoryStore(), now: () => t });
  for (let i = 0; i < 20; i++) assert.equal((await m.admit({ ipKey: "ik" })).ok, true);
  const r = await m.admit({ ipKey: "ik" });
  assert.deepEqual([r.ok, r.slow], [false, true]);
  assert.equal((await m.admit({ ipKey: "other" })).ok, true);
  t += 3600_000;
  assert.equal((await m.admit({ ipKey: "ik" })).ok, true, "an hour later");
  const before = (await m.report()).used;
  await m.add({ workerExtra: 200, doExtra: 3, rows: 3 });
  const after = (await m.report()).used;
  assert.equal(after.workerRequests - before.workerRequests, 200);
  assert.equal(after.doRequests - before.doRequests, 3 + 1, "the RPCs + this meter call");
  assert.equal(after.rowsWritten - before.rowsWritten, 3 + 1);
  // the room's side: a 21st new room from one address is refused "slow" at the hello
  const g = room("tpl-x", { usage: { admit: async () => ({ ok: false, stage: 0, slow: true }), add: async () => ({}) } });
  const s = await g.join("z", claim("public"));
  assert.equal(s.frame("denied").d.reason, "slow");
});

test("meter: stage 3 at 95 % — a socket above 60 frames a minute is closed", async () => {
  const m = new UsageMeter({ store: memoryStore(), free: { rowsWritten: 100 } });
  await m.add({ rows: 95 });
  assert.equal((await m.report()).stage, 3);
  const g = room("tpl-y", { limits: { frameBurst: 1000, frameRate: 1000 } });
  const a = await g.join("a", claim("public"));
  g.r.meter.stage = 3;
  for (let i = 0; i < 61; i++) await g.r.onMessage(a, JSON.stringify({ t: "action", d: { name: "noop", clientMsgId: `m${i}` } }));
  await sleep(5);
  assert.equal(a.frames.find((m) => m.t === "denied")?.d.reason, "slow");
  assert.equal(a.closed, 4029);
});
