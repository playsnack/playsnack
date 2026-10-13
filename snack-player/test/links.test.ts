// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_MIN,
  friendLink, newRoomCode, parseRoute, playPath, roomCodeOf, roomIdFor,
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

test("old hash link on /index.html with a made app's d= payload keeps the payload", () => {
  const d = "eJyrVspMUbJSSk7MyU_JLFaqBQAlvwTz";
  const { route, canonical } = parseRoute(loc("/index.html", "", `#/p/app-k3j9x?d=${d}`));
  assert.equal(route.slug, "app-k3j9x");
  assert.equal(route.params.get("d"), d);
  assert.equal(canonical, `/p/app-k3j9x?d=${d}`);
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
