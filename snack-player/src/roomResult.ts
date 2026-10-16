// Saved room results (docs/room-results.md): a friends-room link is also that room's
// result page. The host device posts each finished game (engine hook onResult); a
// device that opens the link and finds itself alone in the lobby fetches the last one.
// No React / DOM here, so it is unit-tested in Node (snack-player/test/roomResult.test.ts).
import { buildResultView, type BoardEntry, type QuizRecap, type ResultView } from "./quizResult.ts";

export const ROOM_RESULT_API = "/api/room-result";
/** The server's body cap (api/_lib/roomResult.js RR_MAX_BODY_BYTES). */
export const MAX_BODY_BYTES = 24 * 1024;
/** Players / rounds the server accepts (api/_lib/roomResult.js). */
const MAX_PLAYERS = 20;
const TRIM_PICKS_TO = 8;
export const KEEP_DAYS = 7;
export const KEEP_NOTE = `이 결과는 ${KEEP_DAYS}일 동안 링크로 볼 수 있어요`;

/** What the engine's onResult gives (packages/snack-room/src/room.js savedResult). */
export type EngineResult = {
  v: 1; sid: string; endedAt: number; title?: string; about?: string;
  board: (BoardEntry & { pid: string })[];
  quizRecap?: QuizRecap;
};
/** What GET returns (api/_lib/roomResult.js record). */
export type SavedResult = { v: 1; app: string; endedAt: number; title?: string; about?: string; board: BoardEntry[]; quizRecap?: QuizRecap };

/** A friends room: `<slug>~<CODE>` (links.ts roomIdFor). Only those are saved / looked up. */
export const isFriendRoom = (roomId: string) => roomId.includes("~");

/**
 * The request body, fitted under the server's cap: the full game; else each round's picks
 * cut to the board's top players; else the ranking alone. null = nothing to save.
 */
export function fitResult(roomId: string, r: EngineResult, app = roomId.slice(0, roomId.indexOf("~"))): string | null {
  if (!r || !Array.isArray(r.board)) return null;
  const board = r.board.slice(0, MAX_PLAYERS);
  const base = { ...r, app, board };
  const recap = r.quizRecap && Array.isArray(r.quizRecap.rounds) && r.quizRecap.rounds.length ? r.quizRecap : undefined;
  if (!board.length && !recap) return null;
  const body = (result: object) => JSON.stringify({ room: roomId, sid: r.sid, result });
  const fits = (s: string) => new TextEncoder().encode(s).length <= MAX_BODY_BYTES;
  const tries: object[] = [];
  if (recap) {
    tries.push({ ...base, quizRecap: { ...recap, rounds: recap.rounds.slice(0, 20).map((rd) => ({ ...rd, picks: rd.picks.slice(0, MAX_PLAYERS) })) } });
    const top = new Set(board.slice(0, TRIM_PICKS_TO).map((b) => b.pid));
    tries.push({ ...base, quizRecap: { ...recap, rounds: recap.rounds.slice(0, 20).map((rd) => ({ ...rd, picks: rd.picks.filter((p) => top.has(p.pid ?? "")) })) } });
  }
  if (board.length) {
    const { quizRecap: _q, ...rest } = base;
    void _q;
    tries.push(rest);
  }
  for (const t of tries) {
    const s = body(t);
    if (fits(s)) return s;
  }
  return null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Fire-and-forget POST from the host (keepalive: survives the tab closing right after). */
export function postRoomResult(roomId: string, r: EngineResult, fetchImpl: Fetch = (u, i) => fetch(u, i)): boolean {
  if (!isFriendRoom(roomId)) return false;
  const body = fitResult(roomId, r);
  if (!body) return false;
  try {
    void fetchImpl(ROOM_RESULT_API, { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {});
  } catch {
    return false;
  }
  return true;
}

/** The room engine's hook for this room (merged into `engine` next to engineMetrics). */
export function engineResults(roomId: string, fetchImpl?: Fetch) {
  return { onResult: (r: EngineResult) => void postRoomResult(roomId, r, fetchImpl) };
}

const isSaved = (x: unknown): x is SavedResult =>
  !!x && typeof x === "object" && (x as SavedResult).v === 1 && Array.isArray((x as SavedResult).board);

/**
 * Where a room's last game is read: the edge room server when rooms run there (VITE_ROOM_URL,
 * its Durable Object keeps the result — `GET <room server>/room/<id>/result`, docs/edge-rooms.md),
 * else the site's `/api/room-result` (the host phone posted it — MQTT mesh / edge relay).
 */
/** `k`: a PIN room's pass (or seat token) — the room server reads such a room's result only with it (#157). */
export function roomResultUrl(roomId: string, roomServer?: string, k?: string): string {
  const id = encodeURIComponent(roomId);
  return roomServer
    ? `${roomServer.replace(/^ws/, "http").replace(/\/+$/, "")}/room/${id}/result${k ? `?k=${encodeURIComponent(k)}` : ""}`
    : `${ROOM_RESULT_API}?room=${id}`;
}

/** GET the room's last finished game; null when there is none (or anything failed). */
export async function fetchRoomResult(roomId: string, fetchImpl: Fetch = (u, i) => fetch(u, i), roomServer?: string, k?: string): Promise<SavedResult | null> {
  if (!isFriendRoom(roomId)) return null;
  try {
    const res = await fetchImpl(roomResultUrl(roomId, roomServer, k));
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; result?: unknown };
    return j.ok && isSaved(j.result) ? j.result : null;
  } catch {
    return null;
  }
}

/**
 * Whether to look the last result up: a friends room, the room's first state on this
 * connection, and this device is alone in the lobby (it found nobody and runs the room).
 */
export function shouldLookUp(s: { roomId: string; phase: unknown; participants: unknown; looked: boolean }): boolean {
  if (s.looked || !isFriendRoom(s.roomId)) return false;
  const phase = s.phase ?? "lobby"; // a new room has no sessionPhase yet
  return phase === "lobby" && typeof s.participants === "number" && s.participants <= 1;
}

/**
 * The lobby side for LiveApp: fed the room's messages, it looks the last game up once
 * (alone in the lobby of a friends room) and shows it only if this device is STILL alone
 * in the lobby when the answer comes; a game starting in the room hides it again.
 */
export function lastResultWatcher(o: {
  roomId: string;
  /** No lookup at all (server mode, a room this page just made). */
  skip: boolean;
  show: (saved: SavedResult | null) => void;
  fetchResult?: (roomId: string) => Promise<SavedResult | null>;
}) {
  let looked = o.skip;
  let participants = 0;
  let phase: unknown = "lobby";
  let closed = false;
  const stillAlone = () => participants <= 1 && phase === "lobby";
  return {
    /** A "state" message: the room's participants and sessionPhase (absent = lobby). */
    state(count: unknown, sessionPhase: unknown) {
      if (typeof count === "number") participants = count;
      phase = sessionPhase ?? "lobby";
      if (!shouldLookUp({ roomId: o.roomId, phase, participants: count, looked })) return;
      looked = true;
      void (o.fetchResult ?? fetchRoomResult)(o.roomId).then((saved) => {
        if (!closed && saved && stillAlone()) o.show(saved);
      });
    },
    phase(p: unknown) {
      phase = p;
      if (p !== "lobby") o.show(null);
    },
    participants(n: unknown) {
      if (typeof n === "number") participants = n;
    },
    close() {
      closed = true;
    },
  };
}

/** "3시간 전" style age of a saved result (whole minutes / hours / days). */
export function agoLabel(endedAt: number, now: number): string {
  const min = Math.max(0, Math.floor((now - endedAt) / 60_000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** The screen's view: the quiz result view (quizResult.ts) — the same one the image draws. */
export function savedResultView(saved: SavedResult, myNick: string | null): ResultView {
  const v = buildResultView({
    quizRecap: saved.quizRecap ?? null,
    raceBoard: saved.board.map((b) => ({ ...b })),
    myNick,
    iAmSubject: false,
    canMake: false,
  });
  if (saved.quizRecap) return v;
  // A game without a quiz (tap race …): just the ranking.
  return { ...v, kicker: "지난 판 · 결과", title: saved.title || "지난 판", headline: v.mode === "duo" ? "지난 판 결과" : "누가 이겼을까?", duo: { ...v.duo, tier: "", tierKey: "" } };
}
