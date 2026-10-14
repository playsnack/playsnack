// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_MIN,
  MAKE_PARAM, appApiPath, friendLink, newRoomCode, parseRoute, playPath, publicLink, roomCodeOf, roomIdFor, roomParamOf, shareableParams,
} from "../src/links.ts";

const loc = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

// ── routes ──
test("path link: /p/<slug>?room=&host= → live route, params kept, nothing to rewrite", () => {
  const { route, canonical } = parseRoute(loc("/p/tpl-tap-battle", "?room=ABCDEFGH23&host=1"));
  assert.equal(route.name, "live");
  assert.equal(route.slug, "tpl-tap-battle");
  assert.equal(route.params.get("room"), "ABCDEFGH23");
  assert.equal(route.params.get("host"), "1");
  assert.equal(canonical, null);
});

test("old hash link #/p/<slug>?… → same route + the path form to replace it with", () => {
  const { route, canonical } = parseRoute(loc("/", "", "#/p/tpl-tap-battle?room=ABCDEFGH23&host=1"));
  assert.equal(route.name, "live");
  assert.equal(route.slug, "tpl-tap-battle");
  assert.equal(route.params.get("room"), "ABCDEFGH23");
  assert.equal(route.params.get("host"), "1");
  assert.equal(canonical, "/p/tpl-tap-battle?room=ABCDEFGH23&host=1");
});

test("old hash link on /index.html with a made app's d= payload keeps the payload, moved to the fragment", () => {
  const d = "eJyrVspMUbJSSk7MyU_JLFaqBQAlvwTz";
  const { route, canonical } = parseRoute(loc("/index.html", "", `#/p/app-k3j9x?d=${d}`));
  assert.equal(route.slug, "app-k3j9x");
  assert.equal(route.params.get("d"), d);
  assert.equal(canonical, `/p/app-k3j9x#d=${d}`, "the doc never travels in the query (server round trip, URL limit)");
});

test("made-app link: #d= fragment is read as a param; query d= (old form) still works; playPath writes the fragment", () => {
  const d = "eJyrVspMUbJSSk7MyU_JLFaqBQAlvwTz";
  const frag = parseRoute(loc("/p/app-k3j9x", "?room=K7MNP2QRS4", `#d=${d}`));
  assert.equal(frag.route.name, "live");
  assert.equal(frag.route.slug, "app-k3j9x");
  assert.equal(frag.route.params.get("d"), d);
  assert.equal(frag.route.params.get("room"), "K7MNP2QRS4");
  assert.equal(frag.canonical, null);
  const query = parseRoute(loc("/p/app-k3j9x", `?d=${d}`));
  assert.equal(query.route.params.get("d"), d);
  // the query wins over the fragment for the same key
  assert.equal(parseRoute(loc("/p/x", "?k=q", "#k=f")).route.params.get("k"), "q");
  assert.equal(playPath("app-k3j9x", new URLSearchParams({ room: "K7MNP2QRS4", d })), `/p/app-k3j9x?room=K7MNP2QRS4#d=${d}`);
  assert.equal(playPath("app-k3j9x", new URLSearchParams({ d })), `/p/app-k3j9x#d=${d}`);
  // friendLink keeps the doc in the fragment too
  assert.equal(friendLink("https://h", "app-k3j9x", new URLSearchParams({ d }), "K7MNP2QRS4"), `https://h/p/app-k3j9x?room=K7MNP2QRS4#d=${d}`);
});

test("malformed percent-escape in the slug does not throw: raw slug, no app → not found", () => {
  const { route } = parseRoute(loc("/p/100%"));
  assert.equal(route.name, "live");
  assert.equal(route.slug, "100%");
  assert.equal(parseRoute(loc("/", "", "#/p/%E0%A4%A")).route.slug, "%E0%A4%A");
});

test("hash link with a query before the # merges it (the hash's own query wins)", () => {
  const { route, canonical } = parseRoute(loc("/", "?host=0&x=1", "#/p/s?host=1"));
  assert.equal(route.params.get("host"), "1");
  assert.equal(route.params.get("x"), "1");
  assert.equal(canonical, "/p/s?host=1&x=1");
});

test("?bite=<name> dev route is untouched (even with a hash)", () => {
  const { route, canonical } = parseRoute(loc("/", "?bite=reaction", "#/p/x"));
  assert.equal(route.name, "bite");
  assert.equal(route.params.get("bite"), "reaction");
  assert.equal(canonical, null);
});

test("home and create routes, path and hash forms", () => {
  assert.equal(parseRoute(loc("/")).route.name, "home");
  assert.equal(parseRoute(loc("/create")).route.name, "create");
  const h = parseRoute(loc("/", "", "#/create"));
  assert.equal(h.route.name, "create");
  assert.equal(h.canonical, "/create");
  assert.equal(parseRoute(loc("/", "", "#notaroute")).route.name, "home");
});

test("slugs are URL-decoded and encoded symmetrically", () => {
  assert.equal(parseRoute(loc("/p/tpl-%ED%85%8C%EC%8A%A4%ED%8A%B8")).route.slug, "tpl-테스트");
  assert.equal(playPath("tpl-테스트"), "/p/tpl-%ED%85%8C%EC%8A%A4%ED%8A%B8");
  assert.equal(playPath("tpl-x", new URLSearchParams({ room: "ABCDEFGH23" })), "/p/tpl-x?room=ABCDEFGH23");
});

// ── room codes ──
test("room code: length, alphabet, entropy ≥ 40 bits, no ambiguous symbols", () => {
  assert.ok(ROOM_CODE_LENGTH >= 8);
  assert.equal(new Set(ROOM_CODE_ALPHABET).size, ROOM_CODE_ALPHABET.length);
  for (const bad of "0O1Il") assert.ok(!ROOM_CODE_ALPHABET.includes(bad), `ambiguous symbol ${bad}`);
  const bits = ROOM_CODE_LENGTH * Math.log2(ROOM_CODE_ALPHABET.length);
  assert.ok(bits >= 40, `entropy ${bits} bits`);
  for (let i = 0; i < 200; i++) {
    const c = newRoomCode();
    assert.equal(c.length, ROOM_CODE_LENGTH);
    assert.match(c, new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`));
  }
});

test("room code generation uses the given random bytes uniformly (5-bit mask, every symbol reachable)", () => {
  const seen = new Set<string>();
  for (let b = 0; b < 256; b++) {
    const c = newRoomCode((n) => new Uint8Array(n).fill(b));
    assert.equal(c, c[0].repeat(ROOM_CODE_LENGTH));
    seen.add(c[0]);
  }
  assert.equal(seen.size, ROOM_CODE_ALPHABET.length);
  // default source is crypto.getRandomValues: two draws differ
  assert.notEqual(newRoomCode(), newRoomCode());
});

test("roomParamOf: none / legacy (room=, room=1) / code / invalid — invalid is never the public room", () => {
  assert.deepEqual(roomParamOf(new URLSearchParams("host=1")), { kind: "none" });
  for (const legacy of ["room=", "room=1", "room=true"]) assert.deepEqual(roomParamOf(new URLSearchParams(legacy)), { kind: "legacy" }, legacy);
  assert.deepEqual(roomParamOf(new URLSearchParams("room=K7MNP2QRS4")), { kind: "code", code: "K7MNP2QRS4" });
  // a chat app cut the code short
  assert.deepEqual(roomParamOf(new URLSearchParams("room=K7MNP2Q")), { kind: "invalid", raw: "K7MNP2Q" });
  // longer than any code
  assert.equal(roomParamOf(new URLSearchParams(`room=${"A".repeat(33)}`)).kind, "invalid");
  assert.equal(roomParamOf(new URLSearchParams(`room=${"A".repeat(32)}`)).kind, "code");
  // symbols outside the alphabet: 0/1/O/I are all rejected, never mapped to another room
  for (const bad of ["K7MNP2QRS0", "K7MNP2QRS1", "K7MNP2QRSO", "K7MNP2QRSI", "K7MNP2QRS4!", "K7MNP2QRS4/x"]) {
    assert.equal(roomParamOf(new URLSearchParams({ room: bad })).kind, "invalid", bad);
  }
  // roomIdFor on legacy/none is the public room; LiveApp blocks "invalid" before joining
  assert.equal(roomIdFor("tpl-x", new URLSearchParams("room=1")), "tpl-x");
});

test("appApiPath (server mode) names the room so the state returned is that room's", () => {
  assert.equal(appApiPath("tpl-x", new URLSearchParams("")), "/api/apps/tpl-x");
  assert.equal(appApiPath("tpl-x", new URLSearchParams("room=1")), "/api/apps/tpl-x");
  assert.equal(appApiPath("tpl-x", new URLSearchParams("room=k7mnp2qrs4")), "/api/apps/tpl-x?room=tpl-x~K7MNP2QRS4");
});

test("publicLink drops the room param, keeps the rest", () => {
  assert.equal(publicLink("tpl-x", new URLSearchParams("room=K7MNP2Q&host=1")), "/p/tpl-x?host=1");
});

test("roomCodeOf: normalizes case, strips separators, rejects short/absent values", () => {
  assert.equal(roomCodeOf(new URLSearchParams("room=abcd-efgh-23")), "ABCDEFGH23");
  assert.equal(roomCodeOf(new URLSearchParams("room=ABCDEFGH")), "ABCDEFGH");
  assert.equal(roomCodeOf(new URLSearchParams("room=ABCDEFG")), null, "7 symbols is not a code");
  assert.equal(roomCodeOf(new URLSearchParams("room=1")), null, "a bare room=1 only forces a room");
  assert.equal(roomCodeOf(new URLSearchParams("host=1")), null);
  assert.ok(ROOM_CODE_MIN >= 8);
});

test("roomIdFor: public room by default, slug~CODE with a code (MQTT-topic safe)", () => {
  assert.equal(roomIdFor("tpl-tap-battle", new URLSearchParams("")), "tpl-tap-battle");
  assert.equal(roomIdFor("tpl-tap-battle", new URLSearchParams("host=1")), "tpl-tap-battle");
  const id = roomIdFor("tpl-tap-battle", new URLSearchParams("room=K7MNP2QRS4"));
  assert.equal(id, "tpl-tap-battle~K7MNP2QRS4");
  assert.doesNotMatch(id, /[/+#\s]/, "no MQTT wildcard / separator characters");
});

test("friendLink: adds the code, keeps other params, replaces an old room value", () => {
  const url = friendLink("https://playsnack.app", "tpl-tap-battle", new URLSearchParams("host=1&room=x"), "K7MNP2QRS4");
  assert.equal(url, "https://playsnack.app/p/tpl-tap-battle?host=1&room=K7MNP2QRS4");
  // and it round-trips through the parser into the same room
  const u = new URL(url);
  const { route } = parseRoute(u);
  assert.equal(roomIdFor(route.slug!, route.params), "tpl-tap-battle~K7MNP2QRS4");
});

test("?make=1 is device-only: never in an invite or public link built from the params", () => {
  const params = new URLSearchParams({ room: "ABCDEFGH23", make: "1", host: "1" });
  const invite = friendLink("https://x.example", "tpl-speed-trivia-score", params, "ABCDEFGH23");
  assert.equal(invite, "https://x.example/p/tpl-speed-trivia-score?room=ABCDEFGH23&host=1");
  assert.ok(!/make=/.test(invite));
  assert.equal(publicLink("tpl-speed-trivia-score", params), "/p/tpl-speed-trivia-score?host=1");
  assert.equal(shareableParams(params).has(MAKE_PARAM), false);
  assert.equal(params.get("make"), "1", "the caller's params are not changed");
});

test("?debug= is device-only too: an invite from an old hash link carrying it never turns a friend's log on", () => {
  const { route } = parseRoute(loc("/", "", "#/p/tpl-quiz-me?room=ABCDEFGH23&debug=1"));
  const invite = friendLink("https://x.example", route.slug!, route.params, "ABCDEFGH23");
  assert.equal(invite, "https://x.example/p/tpl-quiz-me?room=ABCDEFGH23");
  assert.equal(publicLink(route.slug!, route.params), "/p/tpl-quiz-me");
});
