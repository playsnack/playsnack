// #157 on the client (docs/room-admission.md): signed room codes, /mint, PIN-room passes and the
// transport's handling of every refusal; the failure copy table.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomKindOf, roomParamOf } from "../src/links.ts";
import {
  failCopy, isPin, mintRoom, passStore, passes, PASS_KEY, PASS_MAX, pinDigits, pinErrorText, PIN_REASONS, roomHttpBase, waitText,
} from "../src/roomAdmission.ts";
import { EdgeRoomTransport, hasSeatToken, rememberOrganizerTicket, type RoomMessage } from "../src/roomTransport.ts";
import { joinFailReason } from "../src/telemetry.ts";
import type { PageEnv } from "../src/visibleTimer.ts";

const OPEN = "K7MNP2QRS4ABCDE"; // 15
const PIN = "K7MNP2QRS4ABCDEFGH23"; // 20
const LEGACY = "K7MNP2QRS4"; // 10

// ── codes ──

test("roomKindOf: 15 = open, 20 = PIN room, anything else = legacy (no network needed)", () => {
  assert.equal(roomKindOf(OPEN), "open");
  assert.equal(roomKindOf(PIN), "pin");
  assert.equal(roomKindOf(LEGACY), "legacy");
  assert.equal(roomKindOf("ABCDEFGH"), "legacy");
  assert.equal(roomKindOf("A".repeat(21)), "legacy");
  // the link reader already takes them (8–32 symbols), normalized
  assert.deepEqual(roomParamOf(new URLSearchParams({ room: PIN.toLowerCase() })), { kind: "code", code: PIN });
  assert.deepEqual(roomParamOf(new URLSearchParams({ room: OPEN })), { kind: "code", code: OPEN });
});

test("PIN input: exactly 4 digits; the field keeps digits only (full-width too), at most 4", () => {
  assert.equal(isPin("4821"), true);
  for (const bad of ["482", "48211", "48a1", "", " 4821", null, 4821]) assert.equal(isPin(bad), false, String(bad));
  assert.equal(pinDigits("48-21x9"), "4821");
  assert.equal(pinDigits("４８２１"), "4821");
  assert.equal(pinDigits("abc"), "");
});

// ── /mint ──

type Call = { url: string; init?: RequestInit };
const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("mintRoom: text/plain POST to the room server's http base; an open room → {code(15), org}", async () => {
  const calls: Call[] = [];
  const r = await mintRoom("wss://room.test/", "tpl-tap-battle", {}, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, code: OPEN, org: "orgt" }), { status: 200 });
  });
  assert.deepEqual(r, { ok: true, code: OPEN, org: "orgt" });
  assert.equal(calls[0].url, "https://room.test/mint");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(typeof calls[0].init?.body, "string", "a string body = text/plain: no CORS preflight");
  assert.equal((calls[0].init?.headers as unknown) ?? null, null, "no custom header (would force a preflight)");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { slug: "tpl-tap-battle" }, "no PIN, no anonId without one");
  assert.equal(roomHttpBase("ws://127.0.0.1:4931"), "http://127.0.0.1:4931");
});

test("mintRoom with a PIN sends the anonId (the pass is bound to it) → {code(20), org, pass}", async () => {
  let body: Record<string, unknown> = {};
  const pass = { token: "pass-1", exp: Date.now() + 3600_000 };
  const r = await mintRoom("wss://room.test", "tpl-x", { pin: "4821", anonId: "dev-1" }, async (_u, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, code: PIN, org: "orgt", pass }), { status: 200 });
  });
  assert.deepEqual(body, { slug: "tpl-x", pin: "4821", anonId: "dev-1" });
  assert.deepEqual(r, { ok: true, code: PIN, org: "orgt", pass });
});

test("mintRoom never throws: refusals, odd answers and network errors come back as {ok:false, error}", async () => {
  assert.deepEqual(await mintRoom("wss://r", "s", {}, answer(429, { ok: false, error: "slow", retryIn: 12000 })), { ok: false, error: "slow", retryIn: 12000 });
  assert.deepEqual(await mintRoom("wss://r", "s", {}, answer(403, { ok: false, error: "origin" })), { ok: false, error: "origin" });
  assert.deepEqual(await mintRoom("wss://r", "s", {}, async () => new Response("oops", { status: 502 })), { ok: false, error: "http_502" });
  assert.deepEqual(await mintRoom("wss://r", "s", {}, answer(200, { ok: true, code: PIN, org: "o" })), { ok: false, error: "bad_answer" }, "a 20-symbol code for an open room");
  assert.deepEqual(await mintRoom("wss://r", "s", { pin: "1234", anonId: "a" }, answer(200, { ok: true, code: PIN, org: "o" })), { ok: false, error: "bad_answer" }, "a PIN room without its pass");
  assert.deepEqual(await mintRoom("wss://r", "s", {}, () => Promise.reject(new TypeError("Failed to fetch"))), { ok: false, error: "network" });
  let called = false;
  assert.deepEqual(await mintRoom("wss://r", "s", { pin: "12a4" }, async () => ((called = true), new Response("{}"))), { ok: false, error: "bad_pin" });
  assert.equal(called, false, "a malformed PIN never leaves the device");
  // a server that never answers: the request is given up
  const hung = await mintRoom("wss://r", "s", {}, (_u, init) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))), 20);
  assert.deepEqual(hung, { ok: false, error: "network" });
});

// ── pass storage ──

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

test("passStore: kept per room until it expires; the host's PIN kept with its pass", () => {
  let now = 1000;
  const s = memStorage();
  const p = passStore(s, () => now);
  p.set("a~X", { token: "t1", exp: 5000 }, "4821");
  p.set("b~Y", { token: "t2", exp: 9000 });
  assert.deepEqual(p.get("a~X"), { token: "t1", exp: 5000 });
  assert.equal(p.pin("a~X"), "4821");
  assert.equal(p.pin("b~Y"), null, "a joiner's device never stores the PIN");
  // a later pass for the same room (the room's own `pass` frame) keeps the PIN this device chose
  p.set("a~X", { token: "t1b", exp: 6000 });
  assert.equal(p.pin("a~X"), "4821");
  now = 6000;
  assert.equal(p.get("a~X"), null, "expired");
  assert.equal(p.pin("a~X"), null);
  p.set("c~Z", { token: "t3", exp: 20000 });
  assert.deepEqual(Object.keys(JSON.parse(s.m.get(PASS_KEY)!)).sort(), ["b~Y", "c~Z"], "expired entries are pruned on write");
  p.set("d~W", { token: "t4", exp: 100 }); // already expired: not kept
  assert.equal(p.get("d~W"), null);
  p.forget("b~Y");
  assert.equal(p.get("b~Y"), null);
});

test("passStore: capped at PASS_MAX (the soonest-expiring go first); bad stored JSON is ignored", () => {
  const s = memStorage();
  const p = passStore(s, () => 0);
  for (let i = 0; i < PASS_MAX + 5; i++) p.set(`r~${i}`, { token: `t${i}`, exp: 1000 + i });
  const kept = Object.keys(JSON.parse(s.m.get(PASS_KEY)!));
  assert.equal(kept.length, PASS_MAX);
  assert.equal(p.get("r~0"), null);
  assert.ok(p.get(`r~${PASS_MAX + 4}`));
  s.m.set(PASS_KEY, "{not json");
  assert.equal(passStore(s, () => 0).get("r~24"), null);
});

test("passStore: storage blocked → this page still remembers (memory)", () => {
  const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  const p = passStore(blocked, () => 0);
  p.set("a~X", { token: "t", exp: 10 });
  assert.deepEqual(p.get("a~X"), { token: "t", exp: 10 });
  const none = passStore(null, () => 0);
  none.set("a~X", { token: "t", exp: 10 }, "1234");
  assert.equal(none.pin("a~X"), "1234");
});

// ── the failure copy (design §7) ──

test("failCopy: one row per reason; expired / closed never offer 다시 시도; unknown → the network sheet", () => {
  const rows: Record<string, [string, string, boolean, boolean]> = {
    expired: ["링크가 만료됐어요", "방이 끝났거나 링크가 바뀌었어요. 친구에게 새 링크를 받아 주세요", false, true],
    closed: ["이 방은 지금 들어갈 수 없어요", "비밀번호 시도가 너무 많았어요. 방장에게 새 링크를 받아 주세요", false, true],
    slow: ["잠시 후 다시 시도해 주세요", "짧은 시간에 너무 많이 시도했어요", true, false],
    seat_taken: ["이 기기에서 이미 들어와 있어요", "다른 탭이나 창에 이 방이 열려 있는지 확인해 주세요", true, false],
    full: ["방이 꽉 찼어요", "이 방은 최대 300명까지 들어올 수 있어요", false, false],
    friends_full: ["친구방이 꽉 찼어요 (30명)", "친구방은 30명까지 들어올 수 있어요. 공개방에서는 누구나 같이 할 수 있어요", false, true],
    room_full_today: ["오늘 준비한 방이 다 찼어요", "한국 시간 오전 9시에 다시 열려요", false, false],
    timeout: ["같이 하는 방에 못 들어갔어요", "인터넷이 불안정하거나 방 연결이 잠시 막혔을 수 있어요.", true, false],
  };
  for (const [reason, [title, body, retry, home]] of Object.entries(rows)) {
    const c = failCopy(reason);
    assert.deepEqual([c.title, c.body, c.retry, c.home], [title, body, retry, home], reason);
  }
  assert.deepEqual(failCopy(undefined), failCopy("timeout"));
  // #232: the full friends room sends you to the public room (primary) or home — no retry loop, no 혼자 하기
  assert.equal(failCopy("friends_full").toPublic, true);
  for (const r of Object.keys(rows).filter((r) => r !== "friends_full")) assert.ok(!failCopy(r).toPublic, r);
  // public copy: no operator words (money, limits by vendor, "free tier"), no emoji in the new rows
  for (const r of ["expired", "closed", "slow", "seat_taken", "full", "friends_full"]) {
    const c = failCopy(r);
    assert.equal(c.icon, undefined, r);
    assert.doesNotMatch(c.title + c.body, /무료|한도|Cloudflare|요금|서버/, r);
  }
});

test("PIN screen lines: wrong (with tries left), locked (counting m분 s초); the PIN reasons stay on the PIN screen", () => {
  assert.deepEqual(pinErrorText("pin", { left: 4 }), { title: "비밀번호가 달라요. 다시 입력해 주세요", body: "4번 더 틀리면 잠시 입력이 막혀요" });
  assert.deepEqual(pinErrorText("pin", {}), { title: "비밀번호가 달라요. 다시 입력해 주세요" });
  assert.deepEqual(pinErrorText("locked", { retryInMs: 65_000 }), { title: "잠시 후 다시 입력해 주세요", body: "비밀번호를 여러 번 틀렸어요. 1분 5초 뒤에 다시 할 수 있어요" });
  assert.equal(pinErrorText("pin-required"), null);
  assert.equal(waitText(42_001), "43초");
  assert.equal(waitText(-5), "0초");
  assert.deepEqual([...PIN_REASONS].sort(), ["locked", "pin", "pin-required"]);
});

test("telemetry: room server refusals keep their reason; the PIN asked counts as pin", () => {
  for (const r of ["pin", "locked", "closed", "expired", "slow", "seat_taken", "full", "friends_full"]) assert.equal(joinFailReason(r), r);
  assert.equal(joinFailReason("pin-required"), "pin");
});

// ── the transport (EdgeRoomTransport) on a fake socket ──

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: { t: string; d: Record<string, unknown> }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  closedByClient = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closedByClient = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(t: string, d: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ t, d }) });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
const session = new Map<string, string>();
const local = new Map<string, string>();
Object.assign(globalThis, {
  WebSocket: FakeWS,
  sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) },
  localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) },
});
const env: PageEnv = {
  now: () => 0,
  setTimeout: (fn: () => void, ms: number) => (ms === 0 ? void fn() : 0),
  clearTimeout: () => {},
  doc: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  win: { addEventListener: () => {}, removeEventListener: () => {} },
};
const ROOM = `tpl-tap-battle~${PIN}`;
function transport(room: string, opts: { pin?: string } = {}) {
  FakeWS.all = [];
  session.clear();
  local.clear();
  const t = new EdgeRoomTransport("wss://room.test", { slug: room, anonId: "dev-1", nick: "가나" }, opts);
  t.env = env;
  const seen: RoomMessage[] = [];
  t.onMessage((m) => seen.push(m));
  const conns = () => seen.filter((m) => m.t === "conn").map((m) => m.d);
  return { t, seen, conns, last: () => FakeWS.all[FakeWS.all.length - 1], start: () => t.connect() };
}
const later = Date.now() + 12 * 3600_000;

test("PIN room: the typed PIN rides in the URL (?pin=), never in the hello; the pass arrives and is kept; the PIN is wiped once in", () => {
  const { t, conns, last, start } = transport(ROOM, { pin: "4821" });
  start();
  const ws = last();
  assert.equal(ws.url, `wss://room.test/room/${encodeURIComponent(ROOM)}?pin=4821`);
  ws.open();
  assert.equal(ws.sent[0].t, "hello");
  assert.ok(!JSON.stringify(ws.sent[0]).includes("4821"), "the PIN is not in the hello");
  assert.equal(ws.sent[0].d.pin, undefined);
  ws.push("token", { token: "seat-1" });
  ws.push("pass", { token: "pass-1", exp: later });
  assert.equal(t.holdsPin, true, "kept until the room's state");
  ws.push("state", { sharedState: {}, participants: 2 });
  assert.equal(t.holdsPin, false, "wiped after the first state");
  assert.deepEqual(passes.get(ROOM), { token: "pass-1", exp: later });
  assert.ok(!local.get("snk-room-pass")!.includes("4821"), "a joiner's device does not store the PIN");
  assert.deepEqual(conns().map((d) => d.state), ["connecting", "connected"]);
  // a dropped socket comes back on the pass, without the PIN
  ws.drop(1006);
  assert.equal(last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?k=pass-1`);
  t.close();
});

test("PIN room reload: a stored pass (or a seat token) opens it without the PIN", () => {
  const a = transport(ROOM);
  passes.set(ROOM, { token: "pass-9", exp: later });
  a.start();
  assert.equal(a.last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?k=pass-9`);
  a.t.close();
  const b = transport(ROOM);
  session.set(`snk-room-token:${ROOM}`, "seat-7");
  assert.equal(hasSeatToken(ROOM), true);
  b.start();
  assert.equal(b.last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?k=seat-7`);
  b.t.close();
});

test("an open (15) or legacy room never puts a token or PIN in the URL", () => {
  for (const code of [OPEN, LEGACY]) {
    const x = transport(`tpl-a~${code}`, { pin: "1234" });
    session.set(`snk-room-token:tpl-a~${code}`, "seat");
    x.start();
    assert.equal(x.last().url, `wss://room.test/room/tpl-a~${code}`, code);
    x.t.close();
  }
});

test("a wrong PIN: failed 'pin' with the tries left — no reconnect, the PIN dropped; enterPin tries again with the new one", () => {
  const { t, conns, last, start } = transport(ROOM, { pin: "1111" });
  start();
  last().open();
  last().push("denied", { reason: "pin", left: 4 });
  last().drop(4003, "pin");
  assert.equal(FakeWS.all.length, 1, "no reconnect loop");
  assert.deepEqual(conns().at(-1), { state: "failed", reason: "pin", left: 4 });
  assert.equal(t.holdsPin, false);
  t.enterPin("4821");
  assert.equal(FakeWS.all.length, 2);
  assert.equal(last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?pin=4821`);
  assert.equal(conns().at(-1)?.state, "connecting");
  t.close();
});

test("locked: failed 'locked' with retryIn (the PIN screen counts down); pin-required drops a pass that did not hold", () => {
  const a = transport(ROOM, { pin: "1111" });
  a.start();
  a.last().open();
  a.last().push("denied", { reason: "locked", retryIn: 60000 });
  assert.deepEqual(a.conns().at(-1), { state: "failed", reason: "locked", retryIn: 60000 });
  a.t.close();
  const b = transport(ROOM);
  passes.set(ROOM, { token: "stale", exp: later });
  b.start();
  b.last().open();
  b.last().push("denied", { reason: "pin-required" });
  assert.deepEqual(b.conns().at(-1), { state: "failed", reason: "pin-required" });
  assert.equal(passes.get(ROOM), null, "the pass is forgotten");
  // a seat token the room no longer takes does not shadow a typed PIN
  session.set(`snk-room-token:${ROOM}`, "old-seat");
  b.t.enterPin("4821");
  assert.equal(b.last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?pin=4821`);
  b.t.close();
});

test("final refusals: expired / closed / slow / full / friends_full are reported with their reason, never retried; 4003 / 4004 alone too", () => {
  for (const [reason, extra] of [["expired", {}], ["closed", {}], ["slow", { retryIn: 30000 }], ["full", {}], ["friends_full", {}], ["origin", {}]] as const) {
    const x = transport(`tpl-a~${OPEN}`);
    x.start();
    x.last().open();
    x.last().push("denied", { reason, ...extra });
    assert.deepEqual(x.conns().at(-1), { state: "failed", reason, ...extra }, reason);
    assert.equal(FakeWS.all.length, 1, reason);
    x.t.close();
  }
  // the frame lost, only the close code: still final, with the reason the code means
  for (const [code, why, want] of [[4004, "", "expired"], [4003, "", "pin-required"], [4003, "closed", "closed"], [4029, "slow", "slow"], [4029, "friends_full", "friends_full"]] as const) {
    const x = transport(ROOM);
    x.start();
    x.last().open();
    x.last().drop(code, why);
    assert.equal(FakeWS.all.length, 1, `${code}`);
    assert.equal(x.conns().at(-1)?.reason, want, `${code} ${why}`);
    x.t.close();
  }
});

test("a PIN room's last result is read with this device's pass (?k=); other rooms unchanged", async () => {
  const { roomResultUrl } = await import("../src/roomResult.ts");
  assert.equal(roomResultUrl(ROOM, "wss://room.test", "pass-1"), `https://room.test/room/${encodeURIComponent(ROOM)}/result?k=pass-1`);
  assert.equal(roomResultUrl(`tpl-a~${OPEN}`, "wss://room.test"), `https://room.test/room/tpl-a~${OPEN}/result`);
});

test("organizer of a PIN room: alert / pinClosed reach the screen; the hello carries the /mint ticket, never organize", () => {
  const { t, seen, last, start } = transport(ROOM);
  rememberOrganizerTicket(ROOM, "orgt-1");
  passes.set(ROOM, { token: "host-pass", exp: later }, "4821");
  start();
  assert.equal(last().url, `wss://room.test/room/${encodeURIComponent(ROOM)}?k=host-pass`, "the host enters on its pass (no PIN typed)");
  last().open();
  assert.equal(last().sent[0].d.organizerToken, "orgt-1");
  assert.equal(last().sent[0].d.organize, undefined);
  last().push("state", { sharedState: {}, participants: 1 });
  last().push("alert", { kind: "pin_failures", n: 5 });
  last().push("pinClosed", {});
  assert.deepEqual(seen.filter((m) => m.t === "alert" || m.t === "pinClosed").map((m) => m.t), ["alert", "pinClosed"]);
  assert.equal(passes.pin(ROOM), "4821");
  t.close();
});
