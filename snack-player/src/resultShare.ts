// "결과 공유" — one button, one behaviour (#118). Pure (no React/DOM), so it is
// unit-tested in Node (snack-player/test/resultShare.test.ts).
//
// The share sheet needs the tap's user activation, which runs out while the
// picture is drawn (fonts + canvas toBlob). So:
//   · the picture is drawn ahead (`prepare` when the result view appears or
//     changes) and kept as a finished Blob, so a tap calls navigator.share
//     synchronously inside the tap;
//   · a tap while a share is still open is ignored (repeat taps used to reach
//     navigator.share again → InvalidStateError → the save-image popup);
//   · the save-image preview is only for a browser that cannot share files at
//     all (most desktop browsers) — never a fallback for a failed share.
import type { ShareOutcome } from "./resultImage.ts";

export const SHARE_AGAIN = "한 번 더 눌러 공유해 주세요";
export const SHARE_FAILED = "공유하지 못했어요. 다시 눌러 주세요.";
export const IMAGE_FAILED = "결과 이미지를 만들지 못했어요. 화면을 캡처해 주세요.";
/** A share sheet that never settles (some web views) must not wedge the button forever. */
export const STUCK_MS = 60_000;

export type SharerDeps<V> = {
  makeImage: (v: V) => Promise<Blob>;
  /** Calls navigator.share before its first await (resultImage.ts shareResultImage). */
  shareImage: (blob: Blob, v: V) => Promise<ShareOutcome>;
  /** False when this browser cannot share files at all → the save-image preview. */
  canShareFiles: () => boolean;
  showPreview: (blob: Blob) => void;
  say: (text: string) => void;
  onShared: () => void;
  now?: () => number;
};

export function createImageSharer<V>(d: SharerDeps<V>) {
  const now = d.now ?? (() => Date.now());
  let image: { key: string; promise: Promise<Blob>; blob: Blob | null } | null = null;
  let since: number | null = null; // when the share in flight began

  const imageFor = (v: V): Promise<Blob> => {
    const key = JSON.stringify(v);
    if (image?.key !== key) {
      const entry: { key: string; promise: Promise<Blob>; blob: Blob | null } = { key, promise: d.makeImage(v), blob: null };
      entry.promise.then(
        (b) => { entry.blob = b; },
        () => { if (image === entry) image = null; }, // a failed drawing is not cached: the next tap tries again
      );
      image = entry;
    }
    return image.promise;
  };
  const readyBlob = (v: V): Blob | null => (image?.key === JSON.stringify(v) ? image.blob : null);

  /** Draw the picture ahead so the tap can share at once. */
  const prepare = (v: V) => { void imageFor(v).catch(() => {}); };

  const share = async (v: V): Promise<void> => {
    if (since !== null && now() - since < STUCK_MS) return; // a share is open: ignore the tap
    since = now();
    try {
      let blob = readyBlob(v);
      const cached = blob !== null;
      if (!blob) {
        try {
          blob = await imageFor(v);
        } catch {
          d.say(IMAGE_FAILED);
          return;
        }
      }
      if (!d.canShareFiles()) {
        d.showPreview(blob);
        return;
      }
      // With a cached picture nothing above awaited: navigator.share runs inside the tap.
      const out = await d.shareImage(blob, v);
      if (out === "shared") d.onShared();
      else if (out === "preview") d.showPreview(blob); // no navigator.share after all
      else if (out === "retry") d.say(cached ? SHARE_FAILED : SHARE_AGAIN); // the picture is ready now
      else if (out === "failed") d.say(SHARE_FAILED);
      // cancelled: the person closed the sheet; busy: another sheet is open — nothing to say.
    } finally {
      since = null;
    }
  };

  return {
    prepare,
    share,
    get busy() { return since !== null; },
    /** Test/introspection: the finished picture for `v`, if drawn. */
    readyBlob,
  };
}
