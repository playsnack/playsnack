// node --import tsx --test snack-player/test/   (pnpm player:test)
// #118: "결과 공유" always does one thing — the share sheet — and the save-image
// preview appears only where the browser cannot share files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canShareFiles, shareResultImage, type ShareOutcome } from "../src/resultImage.ts";
import { createImageSharer, SHARE_AGAIN, SHARE_FAILED } from "../src/resultShare.ts";

const flush = () => new Promise((r) => setImmediate(r));
const err = (name: string) => Object.assign(new Error(name), { name });

/** A phone's navigator: one share sheet at a time (a second call while open → InvalidStateError). */
function fakeNav(opts: { files?: boolean; fail?: string } = {}) {
  let open: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  const nav = {
    calls: 0,
    canShare: (d?: ShareData) => opts.files !== false && Boolean(d?.files?.length),
    share: (_d?: ShareData) => {
      nav.calls++;
      if (opts.fail) return Promise.reject(err(opts.fail));
      if (open) return Promise.reject(err("InvalidStateError"));
      return new Promise<void>((resolve, reject) => {
        open = { resolve: () => { open = null; resolve(); }, reject: (e) => { open = null; reject(e); } };
      });
    },
    close: (how: "done" | "cancel" = "done") => (how === "done" ? open?.resolve() : open?.reject(err("AbortError"))),
  };
  return nav;
}

function harness(nav: ReturnType<typeof fakeNav> | undefined, opts: { slowImage?: boolean } = {}) {
  const log = { images: 0, previews: 0, said: [] as string[], shared: 0, outcomes: [] as ShareOutcome[] };
  let release: (() => void) | null = null;
  const sharer = createImageSharer<{ id: number }>({
    makeImage: async () => {
      log.images++;
      if (opts.slowImage) await new Promise<void>((r) => { release = r; });
      return new Blob(["png"]);
    },
    shareImage: async (blob, v) => {
      const out = await shareResultImage(blob, { fileName: "r.png", title: String(v.id), nav: nav as unknown as Navigator });
      log.outcomes.push(out);
      return out;
    },
    canShareFiles: () => canShareFiles(nav as unknown as Navigator),
    showPreview: () => { log.previews++; },
    say: (t) => log.said.push(t),
    onShared: () => { log.shared++; },
  });
  return { sharer, log, release: () => release?.() };
}

test("cached picture: the tap calls navigator.share synchronously (inside the tap's activation)", async () => {
  const nav = fakeNav();
  const h = harness(nav);
  h.sharer.prepare({ id: 1 });
  await flush();
  assert.ok(h.sharer.readyBlob({ id: 1 }), "drawn ahead");
  void h.sharer.share({ id: 1 });
  assert.equal(nav.calls, 1, "share called before any await");
  nav.close();
  await flush();
  assert.equal(h.log.shared, 1);
  assert.equal(h.log.images, 1, "the cached picture is used, not redrawn");
});

test("repeat taps while the sheet is open: one share call, no preview", async () => {
  const nav = fakeNav();
  const h = harness(nav);
  h.sharer.prepare({ id: 1 });
  await flush();
  for (let i = 0; i < 5; i++) void h.sharer.share({ id: 1 });
  await flush();
  assert.equal(nav.calls, 1);
  assert.equal(h.sharer.busy, true);
  nav.close("cancel");
  await flush();
  assert.equal(h.sharer.busy, false);
  assert.equal(h.log.previews, 0);
  assert.deepEqual(h.log.said, []);
  // after the sheet closes the button works again, the same way
  void h.sharer.share({ id: 1 });
  assert.equal(nav.calls, 2);
  nav.close();
  await flush();
  assert.equal(h.log.shared, 1);
  assert.equal(h.log.previews, 0);
});

test("InvalidStateError (another sheet open elsewhere) is 'busy', never the preview", async () => {
  const nav = fakeNav({ fail: "InvalidStateError" });
  const h = harness(nav);
  h.sharer.prepare({ id: 1 });
  await flush();
  await h.sharer.share({ id: 1 });
  assert.deepEqual(h.log.outcomes, ["busy"]);
  assert.equal(h.log.previews, 0);
  assert.deepEqual(h.log.said, []);
});

test("not drawn yet and activation ran out (NotAllowedError): '한 번 더 눌러' hint, no preview; next tap shares the cached picture", async () => {
  const nav = fakeNav({ fail: "NotAllowedError" });
  const h = harness(nav, { slowImage: true });
  const p = h.sharer.share({ id: 1 });
  assert.equal(nav.calls, 0, "still drawing");
  h.release();
  await p;
  assert.deepEqual(h.log.outcomes, ["retry"]);
  assert.deepEqual(h.log.said, [SHARE_AGAIN]);
  assert.equal(h.log.previews, 0);
  assert.ok(h.sharer.readyBlob({ id: 1 }), "cached for the next tap");
});

test("other share failures say so; never the preview", async () => {
  const nav = fakeNav({ fail: "DataError" });
  const h = harness(nav);
  h.sharer.prepare({ id: 1 });
  await flush();
  await h.sharer.share({ id: 1 });
  assert.deepEqual(h.log.outcomes, ["failed"]);
  assert.deepEqual(h.log.said, [SHARE_FAILED]);
  assert.equal(h.log.previews, 0);
});

test("no file sharing (desktop): the save-image preview, and navigator.share is not called", async () => {
  for (const nav of [fakeNav({ files: false }), undefined]) {
    const h = harness(nav);
    h.sharer.prepare({ id: 1 });
    await flush();
    await h.sharer.share({ id: 1 });
    assert.equal(h.log.previews, 1);
    if (nav) assert.equal(nav.calls, 0);
  }
});

test("a changed view draws a new picture; the old one is not shared", async () => {
  const nav = fakeNav();
  const h = harness(nav);
  h.sharer.prepare({ id: 1 });
  await flush();
  assert.equal(h.sharer.readyBlob({ id: 2 }), null);
  h.sharer.prepare({ id: 2 });
  await flush();
  assert.equal(h.log.images, 2);
  void h.sharer.share({ id: 2 });
  assert.equal(nav.calls, 1);
  nav.close();
});

test("shareResultImage maps share errors: Abort→cancelled, InvalidState→busy, NotAllowed→retry, other→failed", async () => {
  for (const [name, out] of [["AbortError", "cancelled"], ["InvalidStateError", "busy"], ["NotAllowedError", "retry"], ["TypeError", "failed"]] as const) {
    const got = await shareResultImage(new Blob(["png"]), { fileName: "r.png", title: "t", nav: fakeNav({ fail: name }) as unknown as Navigator });
    assert.equal(got, out, name);
  }
  assert.equal(await shareResultImage(new Blob(["png"]), { fileName: "r.png", title: "t", nav: fakeNav({ files: false }) as unknown as Navigator }), "preview");
});
