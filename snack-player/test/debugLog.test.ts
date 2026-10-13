// On-device test log (?debug=1): ring buffer, redaction, formatting, on/off.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINES, Ring, _resetForTest, clearLog, decideDebug, describeLocation, dlog, entries, formatEntry,
  inAppBrowser, logText, noteRoomMessage, redact, setRoomCode, subscribe,
} from "../src/debugLog.ts";

test("ring buffer keeps the newest max items, in order", () => {
  const r = new Ring<number>(3);
  for (let i = 1; i <= 7; i++) r.push(i);
  assert.deepEqual(r.items(), [5, 6, 7]);
  assert.equal(r.size, 3);
  r.clear();
  assert.deepEqual(r.items(), []);
  r.push(9);
  assert.deepEqual(r.items(), [9]);
  assert.equal(MAX_LINES, 500);
});

test("off (no ?debug=1): dlog records nothing and notifies nobody", () => {
  _resetForTest({ on: false });
  let calls = 0;
  const unsub = subscribe(() => calls++);
  dlog("conn", "connected");
  noteRoomMessage({ t: "state", d: { sharedState: { sessionPhase: "lobby" } } });
  assert.equal(entries().length, 0);
  assert.equal(calls, 0);
  unsub();
});

test("on: 500-line ring, newest kept; long messages cut", () => {
  let t = 0;
  _resetForTest({ on: true, now: () => (t += 10) });
  for (let i = 0; i < 520; i++) dlog("x", `line ${i}`);
  const e = entries();
  assert.equal(e.length, 500);
  assert.equal(e[0].msg, "line 20");
  assert.equal(e[499].msg, "line 519");
  dlog("x", "a".repeat(2000));
  assert.ok(entries().at(-1)!.msg.length <= 501);
  clearLog();
  assert.equal(entries().length, 0);
});

test("redaction: room codes keep 3 symbols, link-carried apps shortened", () => {
  _resetForTest({ on: true });
  assert.equal(redact("/p/tpl-tap-battle?room=K7MNP2QRS4&x=1"), "/p/tpl-tap-battle?room=K7M…&x=1");
  assert.equal(redact("room tpl-tap-battle~K7MNP2QRS4"), "room tpl-tap-battle~K7M…");
  assert.equal(redact("snackapp/v1/tpl-quiz~ABCDEFGH23 closed"), "snackapp/v1/tpl-quiz~ABC… closed");
  assert.equal(redact("/p/app-1x?d=" + "A".repeat(300)), "/p/app-1x?d=<300 chars>");
  // A known room code is cut wherever it appears (e.g. inside an error message).
  setRoomCode("K7MNP2QRS4");
  assert.equal(redact("Error: topic K7MNP2QRS4 refused"), "Error: topic K7M… refused");
  assert.equal(describeLocation({ pathname: "/p/tpl-tap-battle", search: "?room=k7mnp2qrs4", hash: "" }), "/p/tpl-tap-battle?room=k7m…");
  // dlog redacts too.
  dlog("join", "connect → room tpl-tap-battle~K7MNP2QRS4");
  assert.equal(entries().at(-1)!.msg, "connect → room tpl-tap-battle~K7M…");
  assert.doesNotMatch(logText(), /K7MNP2QRS4/);
});

test("format: +seconds since load, wall clock, [category]", () => {
  const wall = new Date(2026, 9, 13, 14, 3, 22, 120).getTime();
  assert.equal(formatEntry({ t: 12345.6, wall, cat: "conn", msg: "connected" }), "+12.346s 14:03:22.120 [conn] connected");
  _resetForTest({ on: true, now: () => 1500 });
  dlog("phase", "lobby");
  const text = logText().split("\n");
  assert.match(text[0], /^snack test log · 1 lines · copied \d{4}-/);
  assert.match(text[1], /^\+1\.500s \d\d:\d\d:\d\d\.\d{3} \[phase\] lobby$/);
});

test("phase and head-count changes are logged once per change", () => {
  _resetForTest({ on: true });
  noteRoomMessage({ t: "state", d: { sharedState: { sessionPhase: "lobby", roster: ["닉네임"] }, participants: 1 } });
  noteRoomMessage({ t: "setVar", d: { id: "sessionPhase", value: "lobby" } });
  noteRoomMessage({ t: "participants", d: { count: 2 } });
  noteRoomMessage({ t: "setVar", d: { id: "sessionPhase", value: "countdown" } });
  noteRoomMessage({ t: "setVar", d: { id: "score", value: 3 } });
  assert.deepEqual(entries().map((e) => `${e.cat}:${e.msg}`), ["phase:lobby", "room:1 in the room", "room:2 in the room", "phase:countdown"]);
  assert.doesNotMatch(logText(), /닉네임/); // the roster is never logged
});

test("?debug=1 turns on and is remembered for the tab; ?debug=0 turns off", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const at = (search: string) => decideDebug({ location: { pathname: "/", search, hash: "" }, storage });
  assert.equal(at(""), false);
  assert.equal(at("?debug=1"), true);
  assert.equal(at(""), true); // same tab, later page
  assert.equal(at("?debug=0"), false);
  assert.equal(at(""), false);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(decideDebug({ location: { pathname: "/", search: "?debug=1", hash: "" }, storage: blocked }), true);
  assert.equal(decideDebug({ location: { pathname: "/", search: "", hash: "" }, storage: blocked }), false);
});

test("in-app browser detection", () => {
  const ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  assert.equal(inAppBrowser(`${ios} KAKAOTALK 10.8.0`), "KakaoTalk");
  assert.equal(inAppBrowser(`${ios} Instagram 300.0`), "Instagram");
  assert.equal(inAppBrowser(`${ios} [FBAN/FBIOS;FBAV/400.0]`), "Facebook");
  assert.equal(inAppBrowser(`${ios} NAVER(inapp; search; 1000; 12.0.0)`), "Naver");
  assert.equal(inAppBrowser(`${ios} Line/14.0.0`), "LINE");
  assert.equal(inAppBrowser("Mozilla/5.0 (Linux; Android 14; SM-S921N; wv) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36"), "Android WebView");
  assert.equal(inAppBrowser(`${ios} Version/18.0 Safari/604.1`), null);
  assert.equal(inAppBrowser("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36"), null);
});
