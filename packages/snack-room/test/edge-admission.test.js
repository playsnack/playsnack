// Room admission end to end on the Node hub (#157, docs/room-admission.md): the Worker's check
// before a room is touched (edge/room/src/admit.js), the room's side (game.js / core.js PinLock),
// and what each case costs (hub counters = the Worker's tally + the room's meter).
// Clients send `cf-connecting-ip` (as Cloudflare sets it) so one machine can be many addresses.
// Ports: EDGE_TEST_PORT_ADMIT (default 4558), EDGE_TEST_PORT_ADMIT_LEGACY (default 4559).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startEdgeHub } from "../tools/edgeHub.js";
import { mintCode, signPass } from "../../../edge/room/src/admit.js";

const SLUG = "tpl-tap-battle";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
let clock = Date.now();
let old; // a second hub: legacy deadlines on a clock the test moves, /relay retired (as the Worker)

before(async () => {
  hub = await startEdgeHub({ port: Number(process.env.EDGE_TEST_PORT_ADMIT || 4558) });
  old = await startEdgeHub({
    port: Number(process.env.EDGE_TEST_PORT_ADMIT_LEGACY || 4559),
    now: () => clock,
    relay: false,
    env: { LEGACY_CREATE_UNTIL: String(clock + 60_000), LEGACY_JOIN_UNTIL: String(clock + 120_000), ALLOWED_ORIGINS: "https://playsnack.pages.dev" },
  });
});
after(async () => {
  await hub?.close();
  await old?.close();
});

const http = (h) => `http://127.0.0.1:${h.port}`;
const mint = async (body, h = hub, ip = "10.9.9.9") => {
  const r = await fetch(`${http(h)}/mint`, { method: "POST", headers: { "content-type": "text/plain", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

/** A player socket (server /ws protocol) from a given address; records frames and its close code. */
function player(room, anonId, { ip = "10.0.0.1", k, pin, h = hub, origin } = {}) {
  const q = new URLSearchParams();
  if (k) q.set("k", k);
  if (pin) q.set("pin", pin);
  const headers = { "cf-connecting-ip": ip, ...(origin ? { origin } : {}) };
  const ws = new WebSocket(`${h.url}/room/${room}${q.size ? `?${q}` : ""}`, { headers });
  const frames = [];
  let closed = null;
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  ws.on("close", (code) => (closed = code));
  ws.on("error", () => {});
  const opened = new Promise((r) => ws.once("open", r));
  const p = {
    frames,
    get closed() {
      return closed;
    },
    hello: async (extra = {}) => {
      await opened;
      ws.send(JSON.stringify({ t: "hello", d: { slug: room, anonId, nick: anonId, ...extra } }));
    },
    frame: (t) => frames.find((m) => m.t === t),
    async until(fn, ms = 3000) {
      for (let t = 0; t < ms; t += 20) {
        if (fn()) return true;
        await sleep(20);
      }
      return Boolean(fn());
    },
    close: () => ws.close(),
  };
  return p;
}
const refused = async (p) => {
  assert.ok(await p.until(() => p.closed !== null), "closed");
  return { ...p.frame("denied")?.d, close: p.closed };
};
// The Worker side's own count in the meter (other rooms report their sockets concurrently).
const workerRequests = async (h = hub) => (await h.meter.today()).workerExtra;

test("v2 friends room without a PIN: /mint → the host organizes; a friend joins with no extra round trip (D2 R0)", async () => {
  const m = await mint({ slug: SLUG });
  assert.equal(m.status, 200);
  const room = `${SLUG}~${m.body.code}`;
  const host = player(room, "host");
  await host.hello({ organizerToken: m.body.org });
  assert.ok(await host.until(() => host.frame("organizer")), "the /mint ticket made the host the organizer");
  const core = hub.room(room).core;
  const d0 = { ...core.meter.d };
  const friend = player(room, "fr");
  await friend.hello({ organize: true });
  assert.ok(await friend.until(() => friend.frame("state")));
  assert.equal(friend.frame("organizer"), undefined, "organize: true is not honoured on a v2 code");
  const d1 = core.meter.d;
  assert.deepEqual([d1.conns - d0.conns, d1.msgs - d0.msgs, d1.rows - d0.rows], [1, 1, 0], "one socket + its hello, no write");
  host.close();
  friend.close();
});

test("forged code, other app's code, stripped V: 'expired' 4004 from the Worker side — no room touched, counted as a Worker request", async () => {
  const open = await mintCode(hub.secret, SLUG);
  const pin = await mintCode(hub.secret, SLUG, "4821");
  const flipped = open.slice(0, 12) + (open[12] === "A" ? "B" : "A") + open.slice(13);
  for (const room of [`${SLUG}~${flipped}`, `tpl-quiz-ox~${open}`, `${SLUG}~${pin.slice(0, 15)}`]) {
    const w0 = await workerRequests();
    const d0 = hub.counts.workerDenied;
    const p = player(room, "x");
    assert.deepEqual(await refused(p), { reason: "expired", close: 4004 }, room);
    assert.equal(hub.room(room), undefined, `${room}: no Durable Object`);
    assert.equal(hub.counts.workerDenied - d0, 1);
    assert.equal((await workerRequests()) - w0, 1, "W1 in the meter");
  }
});

test("PIN room: pin-required (no room touched), wrong → left (1 row), right → in + pass; reload with the pass needs no PIN", async () => {
  const m = await mint({ slug: SLUG, pin: "4821", anonId: "host" });
  const room = `${SLUG}~${m.body.code}`;
  const asks = player(room, "b", { ip: "10.1.0.2" });
  assert.deepEqual(await refused(asks), { reason: "pin-required", close: 4003 });
  assert.equal(hub.room(room), undefined, "no Durable Object for a missing PIN");
  // the host enters with its /mint pass (no PIN typed)
  const host = player(room, "host", { k: m.body.pass.token });
  await host.hello({ organizerToken: m.body.org });
  assert.ok(await host.until(() => host.frame("organizer")));
  const rpc0 = hub.counts.pinRpc;
  const wrong = player(room, "b", { ip: "10.1.0.2", pin: "1111" });
  assert.deepEqual(await refused(wrong), { reason: "pin", left: 4, close: 4003 });
  assert.equal(hub.counts.pinRpc - rpc0, 1, "one RPC");
  assert.equal((await hub.room(room).store.get("pinlock")).wrong, 1, "exactly one row");
  const right = player(room, "b", { ip: "10.1.0.2", pin: "4821" });
  await right.hello();
  assert.ok(await right.until(() => right.frame("state") && right.frame("pass")));
  assert.equal(hub.counts.pinRpc - rpc0, 1, "a right PIN: no RPC");
  assert.equal((await hub.room(room).store.get("pinlock")).ip[Object.keys((await hub.room(room).store.get("pinlock")).ip)[0]], undefined, "cleared on success");
  const pass = right.frame("pass").d.token;
  right.close();
  await sleep(50);
  const reload = player(room, "b", { ip: "10.1.0.2", k: pass });
  await reload.hello();
  assert.ok(await reload.until(() => reload.frame("state")), "back in without the PIN");
  const thief = player(room, "someone-else", { ip: "10.1.0.3", k: pass });
  await thief.hello();
  assert.equal((await refused(thief)).reason, "pin-required", "the pass is bound to its device");
  const otherRoom = `${SLUG}~${(await mint({ slug: SLUG, pin: "4821", anonId: "b" })).body.code}`;
  const elsewhere = player(otherRoom, "b", { ip: "10.1.0.2", k: pass });
  assert.equal((await refused(elsewhere)).reason, "pin-required", "another room's pass");
  host.close();
  reload.close();
});

test("PIN lock per address: A locked after 5 wrong, B still gets in; A's right PIN gets A's wrong-PIN answer; locked tries write nothing", async () => {
  const m = await mint({ slug: SLUG, pin: "4821", anonId: "host" });
  const room = `${SLUG}~${m.body.code}`;
  let last;
  for (let i = 0; i < 5; i++) last = await refused(player(room, "a", { ip: "10.2.0.1", pin: "1111" }));
  assert.deepEqual(last, { reason: "locked", retryIn: 60000, close: 4003 });
  const rec = await hub.room(room).store.get("pinlock");
  const wrongWhileLocked = await refused(player(room, "a", { ip: "10.2.0.1", pin: "2222" }));
  const rightWhileLocked = await refused(player(room, "a", { ip: "10.2.0.1", pin: "4821" }));
  assert.deepEqual(rightWhileLocked, wrongWhileLocked, "the same frame and close code");
  assert.equal(rightWhileLocked.reason, "locked");
  assert.deepEqual(await hub.room(room).store.get("pinlock"), rec, "no write while locked");
  const b = player(room, "b", { ip: "10.2.0.2", pin: "4821" });
  await b.hello();
  assert.ok(await b.until(() => b.frame("state")), "another address is not locked");
  b.close();
});

test("50 wrong in all close the room to PINs: pass holders still enter, the organizer is told; the cap survives the room's cleanup", async () => {
  const m = await mint({ slug: SLUG, pin: "4821", anonId: "host" });
  const room = `${SLUG}~${m.body.code}`;
  const host = player(room, "host", { k: m.body.pass.token });
  await host.hello({ organizerToken: m.body.org });
  assert.ok(await host.until(() => host.frame("organizer")));
  let last;
  for (let i = 0; i < 50; i++) last = await refused(player(room, "x", { ip: `10.3.${Math.floor(i / 4)}.1`, pin: "0000" }));
  assert.equal(last.reason, "closed");
  assert.ok(await host.until(() => host.frame("pinClosed")), "the organizer hears it");
  assert.ok(host.frames.some((f) => f.t === "alert" && f.d.kind === "pin_failures"));
  assert.equal((await refused(player(room, "y", { ip: "10.3.99.1", pin: "4821" }))).reason, "closed", "a right PIN from someone new");
  host.close();
  await sleep(50);
  const back = player(room, "host", { k: m.body.pass.token });
  await back.hello({ organizerToken: host.frame("organizer").d.token }); // the 12 h organizer token it kept
  assert.ok(await back.until(() => back.frame("state") && back.frame("pinClosed")), "the pass holder gets in and is told again");
  back.close();
  await sleep(50);
  await hub.fireAlarm(room, "room"); // nobody left: the room's cleanup
  assert.equal(await hub.room(room).store.get("meta"), undefined, "the room is gone");
  assert.equal((await hub.room(room).store.get("pinlock")).wrong, 50, "its PIN lock is not");
  assert.equal((await refused(player(room, "z", { ip: "10.3.98.1", pin: "4821" }))).reason, "closed", "re-creating the room does not reset the cap");
});

test("a 24 h-empty PIN-less link opens a new room quietly; a public id never gets an organizer or a PIN", async () => {
  const m = await mint({ slug: SLUG });
  const room = `${SLUG}~${m.body.code}`;
  const a = player(room, "a");
  await a.hello();
  assert.ok(await a.until(() => a.frame("state")));
  a.close();
  await sleep(50);
  await hub.fireAlarm(room, "room");
  const again = player(room, "b");
  await again.hello();
  assert.ok(await again.until(() => again.frame("state")), "silently re-created");
  again.close();
  const pub = `g-${Date.now().toString(36)}`;
  const p1 = player(pub, "p1");
  await p1.hello({ organize: true, pin: "9999" });
  assert.ok(await p1.until(() => p1.frame("state")));
  assert.equal(p1.frame("organizer"), undefined);
  const p2 = player(pub, "p2");
  await p2.hello();
  assert.ok(await p2.until(() => p2.frame("state")), "no PIN was set on a public room");
  p1.close();
  p2.close();
});

test("/result: a PIN room's needs a pass (else 404, no room touched); an open code's as before", async () => {
  const m = await mint({ slug: SLUG, pin: "4821", anonId: "host" });
  const room = `${SLUG}~${m.body.code}`;
  const host = player(room, "host", { k: m.body.pass.token });
  await host.hello({ organizerToken: m.body.org });
  assert.ok(await host.until(() => host.frame("state")));
  const rec = { v: 1, app: SLUG, endedAt: 1, board: [{ pid: "p", nick: "n", score: 3 }] };
  await hub.room(room).store.put("result", { sid: "s1", exp: Date.now() + 60_000, rec, pin: 1 });
  const conns0 = hub.room(room).core.stats.conns;
  const meterConns0 = hub.room(room).core.meter.d.conns;
  const d0 = hub.counts.workerDenied;
  const no = await fetch(`${http(hub)}/room/${room}/result`);
  assert.equal(no.status, 404);
  assert.equal(hub.counts.workerDenied - d0, 1, "refused at the Worker");
  assert.equal(hub.room(room).core.meter.d.conns, meterConns0, "the room was not asked");
  const yes = await fetch(`${http(hub)}/room/${room}/result?k=${encodeURIComponent(m.body.pass.token)}`);
  assert.equal(yes.status, 200);
  assert.deepEqual((await yes.json()).result, rec);
  assert.equal(hub.room(room).core.stats.conns, conns0);
  host.close();
});

test("legacy codes until the deadlines; /relay is gone (410); a browser from another site is refused", async () => {
  const room = `${SLUG}~ABCDEFGHJK`;
  const a = player(room, "a", { h: old });
  await a.hello({ organize: true });
  assert.ok(await a.until(() => a.frame("organizer")), "a code from before v2 still creates (and organizes) — today's player");
  clock += 61_000; // past LEGACY_CREATE_UNTIL
  const b = player(room, "b", { h: old });
  await b.hello();
  assert.ok(await b.until(() => b.frame("state")), "the existing legacy room still takes joins");
  const fresh = player(`${SLUG}~ABCDEFGHJM`, "c", { h: old });
  await fresh.hello();
  assert.equal((await refused(fresh)).reason, "expired", "a new legacy room may not be created");
  clock += 60_000; // past LEGACY_JOIN_UNTIL
  const late = player(room, "d", { h: old });
  assert.deepEqual(await refused(late), { reason: "expired", close: 4004 });
  a.close();
  b.close();
  const w0 = await workerRequests(old);
  const relay = await fetch(`${http(old)}/relay/x`);
  assert.equal(relay.status, 410);
  assert.equal((await workerRequests(old)) - w0, 1, "counted, no DO");
  const evil = player("tpl-tap-battle", "e", { h: old, origin: "https://evil.example" });
  assert.deepEqual(await refused(evil), { reason: "origin", close: 4000 });
  const ok = player("tpl-tap-battle", "f", { h: old, origin: "https://playsnack.pages.dev" });
  await ok.hello();
  assert.ok(await ok.until(() => ok.frame("state")));
  ok.close();
});

test("rate limits at the Worker side: 120 upgrades a minute per address, then 'slow' 4029 (no room touched)", async () => {
  const room = `g-rl-${Date.now().toString(36)}`;
  const ps = [];
  for (let i = 0; i < 120; i++) ps.push(player(room, `r${i}`, { ip: "10.4.0.1" }));
  await sleep(300);
  const over = player(`${room}-2`, "late", { ip: "10.4.0.1" });
  const r = await refused(over);
  assert.equal(r.reason, "slow");
  assert.equal(r.close, 4029);
  assert.equal(hub.room(`${room}-2`), undefined);
  for (const p of ps) p.close();
});

test("a forged pass cannot create the room; a pass made with the server key can (the host's first entry)", async () => {
  const code = await mintCode(hub.secret, SLUG, "1357");
  const room = `${SLUG}~${code}`;
  const forged = player(room, "h", { k: "eyJ9.abc" });
  assert.equal((await refused(forged)).reason, "pin-required");
  const pass = await signPass(hub.secret, room, "h");
  const ok = player(room, "h", { k: pass.token });
  await ok.hello();
  assert.ok(await ok.until(() => ok.frame("state")));
  ok.close();
});
