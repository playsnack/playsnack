// Per-browser anonymous identity. Each browser (localStorage origin) is an
// independent player: a stable anonId (UUID) + a chosen nickname. The nickname
// is collected once on first visit (see NicknameGate) and sent on every live
// connection so the server can attribute scores to a name (user leaderboard).

import { clampNick } from "./nick";

const ANON_KEY = "snack_anon";
const NICK_KEY = "snack_nick";
const PHOTO_KEY = "snack_photo"; // "1" once a selfie has been uploaded for this anonId

export function hasPhoto(): boolean {
  return localStorage.getItem(PHOTO_KEY) === "1";
}

// Upload the (already downscaled) selfie data-URL keyed by this browser's anonId.
// Same-origin /api in the served player. Returns true on success.
export async function uploadPhoto(dataUrl: string): Promise<boolean> {
  try {
    const r = await fetch("/api/photo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anonId: getAnonId(), dataUrl }),
    });
    if (r.ok) { localStorage.setItem(PHOTO_KEY, "1"); return true; }
  } catch { /* offline / blocked → enter without a photo */ }
  return false;
}

export function getAnonId(): string {
  let id = localStorage.getItem(ANON_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ANON_KEY, id);
  }
  return id;
}

// Capped at NICK_MAX graphemes (nick.ts) so it fits the ranking rows — also on
// read, so a longer name stored by an older build is capped the same way.
export function getNick(): string | null {
  const n = clampNick(localStorage.getItem(NICK_KEY) ?? "");
  return n || null;
}

export function setNick(n: string): void {
  const v = clampNick(n);
  if (v) localStorage.setItem(NICK_KEY, v);
}

const ADJ = ["빠른", "느긋한", "용감한", "수줍은", "엉뚱한", "날쌘", "포근한", "반짝이는", "치즈맛", "번개", "라임", "심야", "귀여운", "도도한"];
const NOUN = ["라이언", "두더지", "감자", "고양이", "너구리", "수달", "펭귄", "햄스터", "치킨", "떡볶이", "왕감자", "해커", "용사", "젤리"];

// Fun KR suggestion. Client-runtime Math.random is fine here (not a workflow).
export function randomNick(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a} ${n}`;
}
