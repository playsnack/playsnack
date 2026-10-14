// Saved room results, the shell side (docs/room-results.md).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoom } from "@snack/room";
import { parseRoomResult, RR_MAX_BODY_BYTES } from "../../api/_lib/roomResult.js";
import {
  agoLabel, engineResults, fetchRoomResult, fitResult, isFriendRoom, KEEP_NOTE, lastResultWatcher, postRoomResult, roomResultUrl, savedResultView, shouldLookUp,
  type EngineResult, type SavedResult,
} from "../src/roomResult.ts";

const ROOM = "tpl-speed-trivia-score~QWERTYZ234";
const SID = "GameSid0123456789abc";
const flush = () => new Promise((r) => setImmediate(r));

const engineResult = (over: Partial<EngineResult> = {}): EngineResult => ({
  v: 1, sid: SID, endedAt: 1, title: "민수 맞히기", about: "민수",
  board: [{ pid: "p2", nick: "지영", score: 880 }, { pid: "p3", nick: "철수", score: 0, left: true }],
  quizRecap: {
    subject: "민수", about: "민수", title: "민수 맞히기", packId: null,
    rounds: [{ q: "내 MBTI는?", options: ["INFP", "ESTJ"], answer: 0, picks: [
      { nick: "지영", pid: "p2", option: 0, ms: 900, correct: true, points: 880 },
      { nick: "철수", pid: "p3", option: 1, ms: 1200, correct: false, points: 0 },
    ] }],
  },
  ...over,
});
const saved = (over: Partial<SavedResult> = {}): SavedResult => {
  const { sid: _s, ...r } = engineResult();
  void _s;
  return { ...r, app: "tpl-speed-trivia-score", endedAt: 1000, ...over } as SavedResult;
};

test("friends rooms only", () => {
  assert.equal(isFriendRoom(ROOM), true);
  assert.equal(isFriendRoom("tpl-speed-trivia-score"), false);
  const calls: unknown[] = [];
  assert.equal(postRoomResult("tpl-speed-trivia-score", engineResult(), async (...a) => (calls.push(a), new Response("{}"))), false);
  assert.equal(calls.length, 0);
});

test("the host posts once per hook call: keepalive POST /api/room-result, body accepted by the API", async () => {
  const calls: [string, RequestInit][] = [];
  const hook = engineResults(ROOM, async (u, i) => (calls.push([u, i!]), new Response("{}")));
  hook.onResult(engineResult());
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "/api/room-result");
  assert.equal(init.method, "POST");
  assert.equal(init.keepalive, true);
  const parsed = parseRoomResult(String(init.body), 5);
  assert.equal(parsed.status, 200, JSON.stringify(parsed));
  // a failing network never throws into the engine
  const bad = engineResults(ROOM, () => Promise.reject(new Error("offline")));
  assert.doesNotThrow(() => bad.onResult(engineResult()));
  await flush();
});

test("the real engine's result → fitResult → accepted by the API (quiz with a subject, 3 players)", async () => {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const results: EngineResult[] = [];
  const room = createRoom({
    random: () => 0.5, now: () => t, broadcast: () => {}, send: () => {},
    setTimer: (fn: () => void, ms: number) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimer: (id: number) => timers.delete(id),
    onResult: (r: EngineResult) => results.push(r),
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      await flush();
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  const mid = (n: number) => `${n}`.padStart(8, "0") + "-1111-4222-8333-444455556666";
  for (const n of [1, 2, 3]) room.join(`p${n}`, { anonId: `anon-secret-${n}`, nick: `친구${n}` });
  const QS = [{ q: "내 MBTI는?", options: ["INFP", "ESTJ"], answer: 0 }, { q: "좋아하는 색은?", options: ["빨강", "파랑", "초록"], answer: 1 }];
  room.action("p1", { name: "quizPack", payload: { title: "친구1 맞히기", questions: QS }, clientMsgId: mid(1) });
  room.action("p1", { name: "start", payload: { quiz: true, game: "quiz", rounds: 2, answerMs: 4000, revealMs: 1500 }, clientMsgId: mid(2) });
  await advance(3500);
  room.action("p2", { name: "answer", payload: { option: 0, ms: 400 }, clientMsgId: mid(3) });
  await advance(30000);
  assert.equal(results.length, 1);
  const body = fitResult(ROOM, results[0]);
  assert.ok(body);
  assert.ok(!body!.includes("anon-secret"), "no anonId leaves the host");
  const parsed = parseRoomResult(body!, 1) as { status: number; record: SavedResult };
  assert.equal(parsed.status, 200, JSON.stringify(parsed));
  const v = savedResultView(parsed.record, null);
  assert.equal(v.mode, "rank");
  assert.equal(v.questions.length, 2);
  assert.equal(v.headline, "친구1을 제일 잘 아는 친구는?");
  room.destroy();
});

test("fitResult: a 20 × 20 game is trimmed under the cap (picks to the top 8, then ranking only)", () => {
  const players = Array.from({ length: 20 }, (_, i) => ({ pid: `p${i + 1}`, nick: `친구친구친구친구친${i % 10}` }));
  const rounds = Array.from({ length: 20 }, () => ({
    q: "질문".repeat(40), options: Array.from({ length: 4 }, () => "보기".repeat(15)), answer: 1,
    picks: players.map((p) => ({ ...p, option: 1, ms: 12000, correct: true, points: 900 })),
  }));
  const r = engineResult({ board: players.slice(0, 8).map((p) => ({ ...p, score: 18000 })), quizRecap: { subject: "민수", about: "민수", title: "t", packId: null, rounds } });
  const body = fitResult(ROOM, r)!;
  assert.ok(new TextEncoder().encode(body).length <= RR_MAX_BODY_BYTES);
  const parsed = parseRoomResult(body, 1);
  assert.equal(parsed.status, 200);
  const rec = (parsed as { record: SavedResult }).record;
  assert.ok(!rec.quizRecap || rec.quizRecap.rounds.every((rd) => rd.picks.length <= 8));
  assert.equal(fitResult(ROOM, engineResult({ board: [], quizRecap: undefined })), null, "nothing to show: nothing sent");
});

test("lookup rule: friends room, lobby, alone, once", () => {
  assert.equal(shouldLookUp({ roomId: ROOM, phase: undefined, participants: 1, looked: false }), true);
  assert.equal(shouldLookUp({ roomId: ROOM, phase: "lobby", participants: 2, looked: false }), false);
  assert.equal(shouldLookUp({ roomId: ROOM, phase: "result", participants: 1, looked: false }), false);
  assert.equal(shouldLookUp({ roomId: ROOM, phase: "lobby", participants: 1, looked: true }), false);
  assert.equal(shouldLookUp({ roomId: "tpl-speed-trivia-score", phase: "lobby", participants: 1, looked: false }), false);
});

test("watcher: alone in the lobby → fetch → shown", async () => {
  const shown: (SavedResult | null)[] = [];
  const fetched: string[] = [];
  const w = lastResultWatcher({ roomId: ROOM, skip: false, show: (s) => shown.push(s), fetchResult: async (id) => (fetched.push(id), saved()) });
  w.state(1, undefined);
  await flush();
  assert.deepEqual(fetched, [ROOM]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.board[0].nick, "지영");
  w.state(1, "lobby"); // a resync: no second lookup
  await flush();
  assert.equal(fetched.length, 1);
  w.phase("countdown"); // a game starts here: hidden
  assert.equal(shown.at(-1), null);
});

test("watcher: not shown when others are present, when someone arrives before the answer, or with no result", async () => {
  const run = async (steps: (w: ReturnType<typeof lastResultWatcher>) => void, result: SavedResult | null = saved()) => {
    const shown: (SavedResult | null)[] = [];
    let n = 0;
    const w = lastResultWatcher({ roomId: ROOM, skip: false, show: (s) => shown.push(s), fetchResult: async () => (n++, result) });
    steps(w);
    await flush();
    return { shown: shown.filter(Boolean), fetches: n };
  };
  assert.deepEqual(await run((w) => w.state(2, "lobby")), { shown: [], fetches: 0 }); // joined friends
  assert.deepEqual(await run((w) => w.state(1, "result")), { shown: [], fetches: 0 }); // a game's result is on
  assert.deepEqual((await run((w) => { w.state(1, "lobby"); w.participants(2); })).shown, []); // a friend came in meanwhile
  assert.deepEqual(await run((w) => w.state(1, "lobby"), null), { shown: [], fetches: 1 }); // no saved result
  assert.deepEqual((await run((w) => { w.state(1, "lobby"); w.close(); })).shown, []); // left the page
  const skipped = await run((w) => w.state(1, "lobby"));
  assert.equal(skipped.fetches, 1);
  // skip (server mode / a room just made): never fetches
  let n = 0;
  const w = lastResultWatcher({ roomId: ROOM, skip: true, show: () => {}, fetchResult: async () => (n++, saved()) });
  w.state(1, "lobby");
  await flush();
  assert.equal(n, 0);
});

test("fetchRoomResult: 200 → the result; 404 / bad JSON / network → null; public room → no request", async () => {
  const ok = await fetchRoomResult(ROOM, async (u) => {
    assert.equal(u, `/api/room-result?room=${encodeURIComponent(ROOM)}`);
    return new Response(JSON.stringify({ ok: true, result: saved() }));
  });
  assert.equal(ok?.board.length, 2);
  assert.equal(await fetchRoomResult(ROOM, async () => new Response("{}", { status: 404 })), null);
  assert.equal(await fetchRoomResult(ROOM, async () => new Response("nope")), null);
  assert.equal(await fetchRoomResult(ROOM, () => Promise.reject(new TypeError("Failed to fetch"))), null);
  let called = false;
  assert.equal(await fetchRoomResult("tpl-x", async () => ((called = true), new Response("{}"))), null);
  assert.equal(called, false);
});

test("edge room server (VITE_ROOM_URL): the result is read from the room's Durable Object", async () => {
  assert.equal(roomResultUrl(ROOM), `/api/room-result?room=${encodeURIComponent(ROOM)}`);
  assert.equal(roomResultUrl(ROOM, "wss://snack-room.playsnack.workers.dev/"), `https://snack-room.playsnack.workers.dev/room/${ROOM}/result`);
  assert.equal(roomResultUrl(ROOM, "ws://127.0.0.1:4551"), `http://127.0.0.1:4551/room/${ROOM}/result`);
  const seen: string[] = [];
  const got = await fetchRoomResult(ROOM, async (u) => (seen.push(u), new Response(JSON.stringify({ ok: true, result: saved() }))), "wss://rooms.test");
  assert.deepEqual(seen, [`https://rooms.test/room/${ROOM}/result`]);
  assert.equal(got?.board.length, 2);
  assert.equal(await fetchRoomResult(ROOM, async () => new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 }), "wss://rooms.test"), null);
});

test("view: the quiz view for a quiz, a plain ranking otherwise; the honest note; age", () => {
  const q = savedResultView(saved(), "지영");
  assert.equal(q.mode, "rank");
  assert.equal(q.ranks[0].nick, "지영");
  assert.equal(q.ranks[0].me, true);
  assert.equal(q.ranks[1].left, true);
  assert.equal(q.questions[0].chips.length, 2);
  const race = savedResultView(saved({ quizRecap: undefined, title: undefined, about: undefined, board: [{ pid: "p1", nick: "가", score: 12 }, { pid: "p2", nick: "나", score: 30 }] }), null);
  assert.equal(race.mode, "rank");
  assert.equal(race.ranks[0].nick, "나");
  assert.equal(race.headline, "누가 이겼을까?");
  assert.equal(race.questions.length, 0);
  assert.equal(KEEP_NOTE, "이 결과는 7일 동안 링크로 볼 수 있어요");
  assert.equal(agoLabel(0, 30_000), "방금 전");
  assert.equal(agoLabel(0, 5 * 60_000), "5분 전");
  assert.equal(agoLabel(0, 3 * 3_600_000), "3시간 전");
  assert.equal(agoLabel(0, 2 * 86_400_000), "2일 전");
});
