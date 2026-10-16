// Invite link hand-out (#209) and the PIN chosen while making the quiz (#208): snack-player/src/invite.ts.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { canOfferPin, copiedLines, finishMakerRoom, handOutLink, isTouchDevice } from "../src/invite.ts";

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WIN_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const coarse = (on: boolean) => (q: string) => q === "(pointer: coarse)" && on;

test("touch: phones and tablets yes, Mac / Windows computers no", () => {
  assert.equal(isTouchDevice({ media: coarse(false), userAgent: MAC_SAFARI, maxTouchPoints: 0 }), false, "Mac Safari (has navigator.share)");
  assert.equal(isTouchDevice({ media: coarse(false), userAgent: WIN_CHROME, maxTouchPoints: 0 }), false, "Windows Chrome");
  assert.equal(isTouchDevice({ media: coarse(false), userAgent: WIN_CHROME, maxTouchPoints: 10 }), false, "a touch-screen laptop (primary pointer: the trackpad)");
  assert.equal(isTouchDevice({ media: coarse(true), userAgent: IPHONE, maxTouchPoints: 5 }), true, "iPhone");
  assert.equal(isTouchDevice({ media: coarse(true), userAgent: ANDROID, maxTouchPoints: 5 }), true, "Android");
  assert.equal(isTouchDevice({ media: coarse(false), userAgent: ANDROID }), true, "a phone browser that does not answer the media query: by its UA");
  assert.equal(isTouchDevice({ media: coarse(false), userAgent: MAC_SAFARI, maxTouchPoints: 5 }), true, "iPadOS asking for the desktop site (Mac UA, touch points)");
  assert.equal(isTouchDevice({}), false, "nothing known: a computer");
  assert.equal(isTouchDevice({ media: () => { throw new Error("no"); }, userAgent: MAC_SAFARI }), false, "a broken matchMedia is not touch");
});

function spies(o: { share?: "ok" | "abort" | "fail" | "none"; clip?: "ok" | "fail" | "none" }) {
  const calls = { share: 0, clip: [] as string[] };
  const share = o.share === "none" || !o.share ? undefined : async () => {
    calls.share++;
    if (o.share === "abort") throw Object.assign(new Error("closed"), { name: "AbortError" });
    if (o.share === "fail") throw Object.assign(new Error("no"), { name: "NotAllowedError" });
  };
  const writeText = o.clip === "none" || !o.clip ? undefined : async (t: string) => {
    calls.clip.push(t);
    if (o.clip === "fail") throw new Error("denied");
  };
  return { calls, share, writeText };
}
const URL_ = "https://playsnack.app/p/tpl-speed-trivia-score?room=ABCDEFGHJKLMNPQ";

test("desktop: navigator.share there (Mac Safari) but never called — the link is copied", async () => {
  const s = spies({ share: "ok", clip: "ok" });
  assert.equal(await handOutLink(URL_, { touch: false, share: s.share, writeText: s.writeText }), "copied");
  assert.equal(s.calls.share, 0);
  assert.deepEqual(s.calls.clip, [URL_]);
});
test("desktop: clipboard refused → manual (the QR sheet shows the link selected)", async () => {
  const s = spies({ share: "ok", clip: "fail" });
  assert.equal(await handOutLink(URL_, { touch: false, share: s.share, writeText: s.writeText }), "manual");
  assert.equal(s.calls.share, 0);
  assert.equal(await handOutLink(URL_, { touch: false }), "manual", "no clipboard at all");
});
test("touch: the share sheet; closing it is nothing; a broken sheet falls back to copy", async () => {
  let s = spies({ share: "ok", clip: "ok" });
  assert.equal(await handOutLink(URL_, { touch: true, share: s.share, writeText: s.writeText }), "shared");
  assert.deepEqual([s.calls.share, s.calls.clip.length], [1, 0]);
  s = spies({ share: "abort", clip: "ok" });
  assert.equal(await handOutLink(URL_, { touch: true, share: s.share, writeText: s.writeText }), "cancelled");
  assert.equal(s.calls.clip.length, 0, "closed the sheet: nothing copied");
  s = spies({ share: "fail", clip: "ok" });
  assert.equal(await handOutLink(URL_, { touch: true, share: s.share, writeText: s.writeText }), "copied");
  s = spies({ share: "none", clip: "fail" });
  assert.equal(await handOutLink(URL_, { touch: true, writeText: s.writeText }), "manual", "no share, no clipboard (an in-app browser)");
});
test("copied toast: the fact first; the PIN to pass on; the QR hint only on a computer", () => {
  assert.deepEqual(copiedLines({ touch: true }), ["링크를 복사했어요"]);
  assert.deepEqual(copiedLines({ touch: false }), ["링크를 복사했어요", "옆에 있는 친구는 QR을 보여 주면 바로 들어와요"]);
  assert.deepEqual(copiedLines({ touch: true, pin: "4821" }), ["링크를 복사했어요", "비밀번호 4821도 함께 알려 주세요"]);
});

test("lobby PIN option: only on the room server, in a friends room, connected, while alone — hidden once a friend joined", () => {
  const base = { edge: true, code: true, connected: true, people: 1 };
  assert.equal(canOfferPin(base), true);
  assert.equal(canOfferPin({ ...base, people: 0 }), true, "roster not in yet");
  assert.equal(canOfferPin({ ...base, people: 2 }), false, "a friend joined");
  assert.equal(canOfferPin({ ...base, edge: false }), false, "mesh / dev: no PIN rooms");
  assert.equal(canOfferPin({ ...base, code: false }), false, "the public room");
  assert.equal(canOfferPin({ ...base, connected: false }), false);
});

function makerDeps(result: { ok: true; code: string } | { ok: false; error: string } = { ok: true, code: "ABCDEFGHJKLMNPQRSTUV" }) {
  const log = { mint: [] as [string, unknown][], packs: [] as [string, unknown][], cleared: 0, went: [] as string[] };
  return {
    log,
    d: {
      slug: "tpl-speed-trivia-score",
      anonId: () => "anon-1234",
      mint: async (slug: string, o: { pin?: string; anonId?: string }) => { log.mint.push([slug, o]); return result; },
      roomIdFor: (slug: string, p: URLSearchParams) => `${slug}~${p.get("room")}`,
      rememberRoomPack: (id: string, p: unknown) => void log.packs.push([id, p]),
      clearDraft: () => void log.cleared++,
      go: (p: URLSearchParams) => void log.went.push(p.toString()),
      roomParam: "room",
    },
  };
}
test("maker 완료 with a PIN chosen: one /mint with the PIN and this device's anonId; the quiz goes to that room", async () => {
  const { log, d } = makerDeps();
  await finishMakerRoom({ title: "나" }, { pin: "4821" }, d);
  assert.deepEqual(log.mint, [["tpl-speed-trivia-score", { pin: "4821", anonId: "anon-1234" }]], "mintRoom once, with the PIN");
  assert.deepEqual(log.packs, [["tpl-speed-trivia-score~ABCDEFGHJKLMNPQRSTUV", { title: "나" }]]);
  assert.deepEqual([log.cleared, log.went], [1, ["room=ABCDEFGHJKLMNPQRSTUV"]]);
});
test("maker 완료 without a PIN (default): one /mint, no PIN, no anonId", async () => {
  const { log, d } = makerDeps({ ok: true, code: "ABCDEFGHJKLMNPQ" });
  await finishMakerRoom({ title: "나" }, {}, d);
  assert.deepEqual(log.mint, [["tpl-speed-trivia-score", {}]]);
  assert.deepEqual(log.went, ["room=ABCDEFGHJKLMNPQ"]);
});
test("maker 완료: a failed mint throws (the maker keeps the draft and says 다시 눌러 주세요)", async () => {
  const { log, d } = makerDeps({ ok: false, error: "slow" });
  await assert.rejects(finishMakerRoom({ title: "나" }, { pin: "4821" }, d), /mint slow/);
  assert.deepEqual([log.mint.length, log.packs.length, log.cleared, log.went.length], [1, 0, 0, 0]);
});
