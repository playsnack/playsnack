// Handing out an invite link (#209): the native share sheet only on touch phones and tablets;
// on a computer the link goes to the clipboard ("링크를 복사했어요") — Safari on a Mac and Chrome
// on Windows have navigator.share too, and their share menu (AirDrop, Mail, Notes…) is not how
// a friend gets a link from a PC. Clipboard refused → the caller shows the link to copy by hand
// (the QR sheet). Pure, no DOM needed: unit-tested in Node (snack-player/test/invite.test.ts).

/** What the device tells us (all optional; a missing piece counts as "not touch"). */
export type DeviceHints = {
  /** matchMedia(query).matches */
  media?: (query: string) => boolean;
  userAgent?: string;
  maxTouchPoints?: number;
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i;

/**
 * A touch phone or tablet (the share sheet is how people send links there).
 *  - `(pointer: coarse)`: the PRIMARY pointer is a finger — every phone and tablet browser, and
 *    not a laptop with a touch screen (its primary pointer is the trackpad / mouse: `fine`).
 *  - a mobile UA: the odd phone browser that does not answer the media query.
 *  - a Mac UA with touch points: iPadOS Safari asks for desktop sites as "Macintosh" (a real Mac
 *    reports 0 touch points), and with a trackpad attached its primary pointer can read `fine`.
 * A Mac / Windows / Linux computer: none of these → copy.
 */
export function isTouchDevice(h: DeviceHints = browserHints()): boolean {
  let coarse = false;
  try {
    coarse = Boolean(h.media?.("(pointer: coarse)"));
  } catch {
    coarse = false;
  }
  const ua = h.userAgent ?? "";
  if (coarse || MOBILE_UA.test(ua)) return true;
  return /Macintosh/.test(ua) && (h.maxTouchPoints ?? 0) > 1;
}

/** This browser's hints (empty outside one). */
export function browserHints(): DeviceHints {
  if (typeof navigator === "undefined") return {};
  return {
    media: typeof matchMedia === "function" ? (q) => matchMedia(q).matches : undefined,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

export type HandOutEnv = {
  touch: boolean;
  share?: (data: { url: string }) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
};
/** shared: the share sheet sent it · cancelled: the person closed the sheet (nothing happened)
 *  · copied: on the clipboard · manual: no clipboard — show the link to copy by hand. */
export type HandOut = "shared" | "cancelled" | "copied" | "manual";

/** Give `url` out the way this device does it. Never throws. */
export async function handOutLink(url: string, env: HandOutEnv): Promise<HandOut> {
  if (env.touch && typeof env.share === "function") {
    try {
      await env.share({ url });
      return "shared";
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return "cancelled";
      // NotAllowedError (no user activation left), a broken share target…: copy instead.
    }
  }
  try {
    if (typeof env.writeText !== "function") return "manual";
    await env.writeText(url);
    return "copied";
  } catch {
    return "manual";
  }
}

/** This browser's env for handOutLink. */
export function browserHandOutEnv(): HandOutEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    touch: isTouchDevice(),
    share: nav && typeof nav.share === "function" ? (d) => nav.share(d) : undefined,
    writeText: nav?.clipboard?.writeText ? (t) => nav.clipboard.writeText(t) : undefined,
  };
}

/** The lines of the "copied" toast: the fact, then what helps next (PIN room, a computer). */
export function copiedLines(o: { touch: boolean; pin?: string | null }): string[] {
  return [
    "링크를 복사했어요",
    ...(o.pin ? [`비밀번호 ${o.pin}도 함께 알려 주세요`] : []),
    ...(o.touch ? [] : ["옆에 있는 친구는 QR을 보여 주면 바로 들어와요"]),
  ];
}

/**
 * The quiz lobby's "비밀번호 걸기" next to 친구 초대하기 (#208): only on the room server, in a
 * friends room, connected, while this device is the only one in (a PIN means a new link —
 * owner decision #157). Same rule as the QR sheet's row.
 */
export function canOfferPin(o: { edge: boolean; code: boolean; connected: boolean; people: number }): boolean {
  return o.edge && o.code && o.connected && o.people <= 1;
}

/**
 * The maker page's 완료 (#208): ONE new friends room for the quiz — with the PIN chosen in the
 * maker, a PIN room straight away (no second room switch) — then the quiz goes to it (kept on
 * this device, never in the link). A failed mint throws (the maker says "다시 눌러 주세요").
 */
export async function finishMakerRoom<P>(
  pack: P,
  o: { pin?: string },
  d: {
    slug: string;
    anonId: () => string;
    mint: (slug: string, o: { pin?: string; anonId?: string }) => Promise<{ ok: true; code: string } | { ok: false; error: string }>;
    roomIdFor: (slug: string, params: URLSearchParams) => string;
    rememberRoomPack: (roomId: string, pack: P) => void;
    clearDraft: () => void;
    go: (params: URLSearchParams) => void;
    roomParam: string;
  },
): Promise<void> {
  const room = await d.mint(d.slug, o.pin ? { pin: o.pin, anonId: d.anonId() } : {});
  if (!room.ok) throw new Error(`mint ${room.error}`);
  const params = new URLSearchParams({ [d.roomParam]: room.code });
  d.rememberRoomPack(d.roomIdFor(d.slug, params), pack);
  d.clearDraft();
  d.go(params);
}
