// The invite QR encodes exactly the invite link: the SVG path the sheet draws is
// rasterised here and read back with an independent QR reader (jsQR, Apache-2.0).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { MAX_VERSION, QUIET_ZONE, qrMatrix, qrPath } from "../src/qr.ts";
import { friendLink, MAKE_PARAM } from "../src/links.ts";

/** Paint the path's rects (M x y h w v1 h -w z) black on white at `scale` px per module, read it back. */
function decodePath(path: string, modules: number, scale = 6): string | null {
  const px = modules * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let yy = y * scale; yy < (y + 1) * scale; yy++) {
      for (let xx = x * scale; xx < (x + w) * scale; xx++) {
        const i = (yy * px + xx) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
  }
  return jsQR(rgba, px, px, { inversionAttempts: "dontInvert" })?.data ?? null;
}
const roundTrip = (text: string) => {
  const m = qrMatrix(text);
  assert.ok(m, `no QR for ${text}`);
  return decodePath(qrPath(m), m.size + 2 * QUIET_ZONE);
};

test("a friends invite link reads back exactly, without make= / debug=", () => {
  // The link a maker holds right after "완료": ?make=1 (this device only) and ?debug=1 must not ride along.
  const params = new URLSearchParams({ [MAKE_PARAM]: "1", room: "ABCDEFGH23" });
  const url = friendLink("https://playsnack.vercel.app", "tpl-quiz-me", params, "ABCDEFGH23");
  assert.equal(url, "https://playsnack.vercel.app/p/tpl-quiz-me?room=ABCDEFGH23");
  const read = roundTrip(url);
  assert.equal(read, url);
  assert.ok(!/[?&#](make|debug)=/.test(read!), read!);
});

test("other link shapes read back exactly (non-ASCII slug, made-app fragment)", () => {
  const params = new URLSearchParams({ d: "eyJ2IjoxfQ" });
  for (const url of [
    friendLink("https://playsnack.vercel.app", "월드컵", new URLSearchParams(), "Z9Y8X7W6V5"),
    friendLink("https://playsnack.vercel.app", "app-1a2b3c", params, "ABCDEFGH23"),
    "https://playsnack.vercel.app/create?from=tpl-quiz-me",
  ]) assert.equal(roundTrip(url), url);
});

test("a small code for a friends link; no code at all when too dense to scan off a phone", () => {
  const m = qrMatrix("https://playsnack.vercel.app/p/tpl-quiz-me?room=ABCDEFGH23");
  assert.ok(m && m.size <= 33, `friends link should be version ≤ 4, got ${m?.size} modules`);
  assert.equal(qrMatrix("https://x.y/p/app-1#d=" + "A".repeat(2000)), null); // a big made app
  assert.equal(qrMatrix("x".repeat(5000)), null); // more than any QR holds
  const biggest = qrMatrix("h".repeat(600));
  assert.ok(biggest && biggest.size <= 17 + 4 * MAX_VERSION);
});
