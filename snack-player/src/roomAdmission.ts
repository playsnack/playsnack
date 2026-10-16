// Getting into a friends room on the edge room server (#157, docs/room-admission.md):
//   mintRoom()   POST /mint — the server makes the room code (15 symbols; 20 with a PIN) and an
//                organizer ticket (10 min) for the device that asked; with a PIN also this
//                device's pass, so the host never types its own PIN.
//   passStore    PIN-room passes (12 h, bound to this device's anonId) in localStorage, so a
//                reload or a later visit does not ask for the PIN again. Capped and pruned.
//   failCopy()   what the screen says for each refusal (table-driven: Screens.tsx draws it).
// Pure (no build env, no DOM beyond an injectable Storage) — unit-tested in Node
// (snack-player/test/roomAdmission.test.ts). The PIN is never sent anywhere but /mint (host) and
// the room socket URL (joiner), never logged, never in telemetry.
import { OPEN_CODE_LENGTH, PIN_CODE_LENGTH, ROOM_CODE_ALPHABET } from "./links.ts";

/** Exactly 4 digits (owner decision, 2026-10-16). */
export const PIN_LENGTH = 4;
export const isPin = (s: unknown): s is string => typeof s === "string" && /^\d{4}$/.test(s);
/** What a PIN field keeps of what was typed or pasted: digits only, at most 4 (full-width digits too). */
export function pinDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, "")
    .slice(0, PIN_LENGTH);
}

/** A PIN-room pass as the room / mint sends it: `{token, exp}` (exp = epoch ms). */
export type Pass = { token: string; exp: number };
export type MintOk = { ok: true; code: string; org: string; pass?: Pass };
/** error: the server's code (bad_slug | bad_pin | bad_anon | origin | slow | bad_request) or "network" / "http_<n>" / "bad_answer". */
export type MintFail = { ok: false; error: string; retryIn?: number };
export type MintResult = MintOk | MintFail;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The room server's http(s) base from its ws(s) URL. */
export const roomHttpBase = (roomServer: string) => roomServer.replace(/^ws/, "http").replace(/\/+$/, "");
const isPass = (p: unknown): p is Pass => Boolean(p) && typeof (p as Pass).token === "string" && (p as Pass).token.length > 0 && Number.isFinite((p as Pass).exp);
const codeOk = (c: unknown, len: number): c is string => typeof c === "string" && c.length === len && [...c].every((x) => ROOM_CODE_ALPHABET.includes(x));
export const MINT_TIMEOUT_MS = 8000;

/**
 * A new friends room for `slug`: `{code, org}` (+ `pass` with a PIN). Never throws.
 * The body goes as text/plain (a "simple" request — no CORS preflight round trip).
 * With a PIN the server needs this device's anonId: the pass it returns is bound to it.
 */
export async function mintRoom(
  roomServer: string,
  slug: string,
  o: { pin?: string; anonId?: string } = {},
  fetchImpl: Fetch = (u, i) => fetch(u, i),
  timeoutMs = MINT_TIMEOUT_MS,
): Promise<MintResult> {
  const withPin = o.pin != null && o.pin !== "";
  if (withPin && !isPin(o.pin)) return { ok: false, error: "bad_pin" };
  const body = JSON.stringify(withPin ? { slug, pin: o.pin, anonId: o.anonId } : { slug });
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${roomHttpBase(roomServer)}/mint`, { method: "POST", body, signal: ctl?.signal, cache: "no-store" });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !j || j.ok !== true) {
      const error = j && typeof j.error === "string" ? j.error : `http_${res.status}`;
      return { ok: false, error, ...(typeof j?.retryIn === "number" ? { retryIn: j.retryIn } : {}) };
    }
    if (!codeOk(j.code, withPin ? PIN_CODE_LENGTH : OPEN_CODE_LENGTH) || typeof j.org !== "string" || (withPin && !isPass(j.pass))) {
      return { ok: false, error: "bad_answer" };
    }
    return { ok: true, code: j.code, org: j.org, ...(withPin ? { pass: j.pass as Pass } : {}) };
  } catch {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// ── passes (and the host's own PIN, to show it again) ──

type Entry = { t: string; e: number; p?: string };
export const PASS_KEY = "snk-room-pass";
/** Passes kept at most (a device in more PIN rooms within 12 h drops the soonest-expiring). */
export const PASS_MAX = 20;
type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void };

export type PassStore = {
  /** This room's pass while it holds (an expired one is dropped). */
  get(roomId: string): Pass | null;
  /** Keep a pass; `pin` only on the host's device (the PIN it chose, shown in its invite sheet). */
  set(roomId: string, pass: Pass, pin?: string): void;
  /** The PIN this device chose for its room (host only), or null. */
  pin(roomId: string): string | null;
  forget(roomId: string): void;
};

/**
 * Passes in `storage` (default localStorage) under one key, pruned of expired entries on every
 * write and capped at PASS_MAX. Storage blocked (private mode, an in-app browser) → kept in memory
 * for this page: a reload then asks for the PIN again.
 */
export function passStore(storage?: StorageLike | null, now: () => number = Date.now): PassStore {
  let mem: Record<string, Entry> = {};
  const st = (): StorageLike | null => {
    if (storage !== undefined) return storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  const read = (): Record<string, Entry> => {
    const s = st();
    if (!s) return mem;
    try {
      const j = JSON.parse(s.getItem(PASS_KEY) || "{}");
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, Entry>) : {};
    } catch {
      return mem;
    }
  };
  const live = (all: Record<string, Entry>) => {
    const t = now();
    const out: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(all)) if (v && typeof v.t === "string" && Number(v.e) > t) out[k] = v;
    return out;
  };
  const write = (all: Record<string, Entry>) => {
    let keep = live(all);
    const keys = Object.keys(keep);
    if (keys.length > PASS_MAX) {
      keys.sort((a, b) => keep[b].e - keep[a].e); // latest expiry first
      keep = Object.fromEntries(keys.slice(0, PASS_MAX).map((k) => [k, keep[k]]));
    }
    mem = keep;
    const s = st();
    if (!s) return;
    try {
      s.setItem(PASS_KEY, JSON.stringify(keep));
    } catch {
      /* blocked or full: the memory copy serves this page */
    }
  };
  const entry = (roomId: string): Entry | null => {
    const e = read()[roomId];
    return e && typeof e.t === "string" && Number(e.e) > now() ? e : null;
  };
  return {
    get(roomId) {
      const e = entry(roomId);
      return e ? { token: e.t, exp: e.e } : null;
    },
    set(roomId, pass, pin) {
      if (!isPass(pass) || pass.exp <= now()) return;
      const all = read();
      const old = all[roomId];
      all[roomId] = { t: pass.token, e: pass.exp, ...(isPin(pin) ? { p: pin } : old?.p ? { p: old.p } : {}) };
      write(all);
    },
    pin(roomId) {
      const p = entry(roomId)?.p;
      return isPin(p) ? p : null;
    },
    forget(roomId) {
      const all = read();
      delete all[roomId];
      write(all);
    },
  };
}
/** This page's store (localStorage). */
export const passes = passStore();

// ── what the screen says (design §7) ──

/** Refusals the PIN screen handles itself (the input stays; no failure sheet, no reconnect loop). */
export const PIN_REASONS = new Set(["pin", "pin-required", "locked"]);

export type FailCopy = {
  title: string;
  body: string;
  /** "다시 시도" offered (enabled only after `retryIn` ms, when set). */
  retry: boolean;
  /** "홈으로" offered next to "혼자 하기". */
  home: boolean;
  /** #232: the primary button is "공개방으로 가기" (the same game's public room) — no "혼자 하기". */
  toPublic?: boolean;
  /** Only the old sheets keep their picture; the new refusals have none (no emoji in new copy). */
  icon?: string;
};
const COPY: Record<string, FailCopy> = {
  closed: { title: "이 방은 지금 들어갈 수 없어요", body: "비밀번호 시도가 너무 많았어요. 방장에게 새 링크를 받아 주세요", retry: false, home: true },
  expired: { title: "링크가 만료됐어요", body: "방이 끝났거나 링크가 바뀌었어요. 친구에게 새 링크를 받아 주세요", retry: false, home: true },
  slow: { title: "잠시 후 다시 시도해 주세요", body: "짧은 시간에 너무 많이 시도했어요", retry: true, home: false },
  seat_taken: { title: "이 기기에서 이미 들어와 있어요", body: "다른 탭이나 창에 이 방이 열려 있는지 확인해 주세요", retry: true, home: false },
  friends_full: { title: "친구방이 꽉 찼어요 (30명)", body: "친구방은 30명까지 들어올 수 있어요. 공개방에서는 누구나 같이 할 수 있어요", retry: false, home: true, toPublic: true },
  full: { title: "방이 꽉 찼어요", body: "이 방은 최대 300명까지 들어올 수 있어요", retry: false, home: false },
  room_full_today: { title: "오늘 준비한 방이 다 찼어요", body: "한국 시간 오전 9시에 다시 열려요", retry: false, home: false, icon: "🌙" },
};
const DEFAULT_COPY: FailCopy = { title: "같이 하는 방에 못 들어갔어요", body: "인터넷이 불안정하거나 방 연결이 잠시 막혔을 수 있어요.", retry: true, home: false, icon: "📡" };
/** The failure sheet's words for a transport reason (anything unlisted: the network sheet). */
export function failCopy(reason: string | undefined): FailCopy {
  return (reason && COPY[reason]) || DEFAULT_COPY;
}

/**
 * The host's PIN notice (Screens.tsx HostPinNotice), CSS px from the safe top: under the top-row
 * pills, left of 😀 (others are in the room when it shows). `h` = its tallest (two text lines +
 * the button). While it shows, the name card steps aside (LiveApp `covered`).
 */
export const HOST_NOTICE_BOX = { x: 12, y: 64, right: 70, h: 128 } as const;

/** "1분 5초" / "42초" for a countdown (rounded up, never below 0). */
export function waitText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
}

/** The PIN screen's line for a refusal: wrong PIN (with tries left), locked (with the wait), or null. */
export function pinErrorText(reason: string | undefined, o: { left?: number; retryInMs?: number } = {}): { title: string; body?: string } | null {
  if (reason === "pin") {
    const left = typeof o.left === "number" && o.left > 0 ? o.left : null;
    return { title: "비밀번호가 달라요. 다시 입력해 주세요", ...(left ? { body: `${left}번 더 틀리면 잠시 입력이 막혀요` } : {}) };
  }
  if (reason === "locked") {
    return { title: "잠시 후 다시 입력해 주세요", body: `비밀번호를 여러 번 틀렸어요. ${waitText(o.retryInMs ?? 0)} 뒤에 다시 할 수 있어요` };
  }
  return null;
}
