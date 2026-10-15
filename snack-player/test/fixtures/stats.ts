// A week of anonymous stats made by the REAL /api/ev handler (memory store), so the
// /stats page is tested against the API's actual answer shape, not a hand copy.
// Also written to JSON for the page screenshot (snack-player/scripts or a scratch run).
// @ts-ignore — plain JS module outside the player (api/ev.js)
import { createHandler } from "../../../api/ev.js";
import { kstDay, last7Days, weeksFor, type DayBody, type GrowthBody, type WeekBody } from "../../src/statsView.ts";

/** KST Wed 2026-10-14 15:00 — the 7 days span 2026-W41 (Thu 10/8 …) and 2026-W42. */
export const NOW = Date.parse("2026-10-14T06:00:00Z");
const NOW_DEFAULT = NOW;
const DAY = 86_400_000;
let n = 0;
const sid = () => `sid${String(++n).padStart(17, "0")}`;

type Ev = Record<string, unknown>;
/**
 * Joins: the last 2 days (i ≤ 1) through the room server (`via: "edge"`, quick); the 5 days
 * before through the old player-hosted rooms (`via: "mesh"`, slower) — or, with `edge: false`,
 * every day the old way with no `via` at all (clients from before it was sent).
 */
const EDGE_MS = [500, 700, 900, 1200, 1600, 2400, 800];
const MESH_MS = [2600, 3400, 4200, 3100, 4800, 9000, 2900];
function dayEvents(i: number, edge = true): Ev[] {
  // i = days before today (0 = today). Varied, so each table row differs.
  const ev: Ev[] = [];
  for (let g = 0; g < 2 + (i % 3); g++) ev.push({ k: "session_done", app: "speed-trivia-score", p: 3 + g, sid: sid(), about: true, ans: 2 });
  ev.push({ k: "session_done", app: "speed-trivia-score", p: 2, sid: sid(), about: true, ans: 1 }); // 1:1
  ev.push({ k: "game_created", app: "speed-trivia-score", source: "editor", gid: sid() });
  if (i % 2 === 0) ev.push({ k: "game_created", app: "speed-trivia-score", source: "remake", gid: sid() });
  ev.push({ k: "room_create", app: "speed-trivia-score" });
  const via = !edge ? {} : { via: i <= 1 ? "edge" : "mesh" };
  const joins = edge && i <= 1 ? EDGE_MS : MESH_MS;
  for (const ms of joins.slice(0, 4 + (i % 4))) ev.push({ k: "room_join", ok: true, ms, room: "friend", app: "speed-trivia-score", ...via });
  if (i % 3 === 0) ev.push({ k: "room_join", ok: false, ms: 15000, reason: "silence", room: "friend", ...via });
  if (i === 1) ev.push({ k: "room_join", ok: false, ms: 300, reason: "bad_link", ...via });
  ev.push({ k: "share", method: "web", what: "invite", app: "speed-trivia-score" });
  if (i % 2) ev.push({ k: "share", method: "copy", what: "result" });
  ev.push({ k: "ask_shown", app: "speed-trivia-score" }, { k: "ask_shown" }, { k: "ask_shown" });
  ev.push({ k: "ask_answer", a: "yes" });
  if (i % 2) ev.push({ k: "ask_answer", a: "no", why: i === 1 ? "laggy" : "few" });
  if (i === 0) ev.push({ k: "ask_answer", a: "skip" });
  return ev;
}

const did = (n: number) => `fixtureBrowser_${String(n).padStart(7, "0")}`; // 22 chars

/**
 * `now` = the page's "today" (default NOW). `historyFrom` = also play a few games every
 * 3rd day from that day on (months of growth). `onlyToday` = nothing but today's games.
 * `edge: false` = no join says how it went (no room-server numbers yet).
 */
export async function statsFixture(o: { now?: number; historyFrom?: string; onlyToday?: boolean; edge?: boolean } = {}): Promise<{ weeks: WeekBody[]; day: DayBody; growth: GrowthBody; now: number }> {
  const NOW = o.now ?? NOW_DEFAULT;
  let t = NOW;
  const h = createHandler({
    env: { EV_DEVICE_SALT: "fixture-salt-0123456789" },
    now: () => t,
    limiter: { check: () => null, dailyCapReached: () => false, noteTotal: () => {} },
  });
  const post = (events: Ev[]) =>
    h(new Request("https://playsnack.test/api/ev", { method: "POST", body: JSON.stringify({ v: 1, events }) }));
  if (o.historyFrom) {
    for (let d = Date.parse(`${o.historyFrom}T03:00:00Z`), k = 0; d < NOW - 7 * DAY; d += 3 * DAY, k++) {
      t = d;
      const ev: Ev[] = [];
      for (let g = 0; g < 1 + (k % 4) + Math.floor(k / 8); g++) ev.push({ k: "session_done", app: "speed-trivia-score", p: 3 + (g % 3), sid: sid(), about: true, ans: 2 });
      if (k % 2 === 0) ev.push({ k: "game_created", app: "speed-trivia-score", source: "editor", gid: sid() });
      ev.push({ k: "seen", d: did(k % 40), uses: "2-3", games: "2-4", made: "0", age: "7-29" });
      for (let i = 0; i < ev.length; i += 20) await post(ev.slice(i, i + 20));
    }
  }
  for (let i = o.onlyToday ? 0 : 6; i >= 0; i--) {
    t = NOW - i * DAY;
    const ev = dayEvents(i, o.edge !== false);
    for (let k = 0; k < ev.length; k += 20) await post(ev.slice(k, k + 20));
  }
  t = NOW;
  // Today's browsers: their once-a-day reports (buckets only).
  await post([
    { k: "seen", d: did(901), uses: "1", games: "0", made: "0", age: "0" },
    { k: "seen", d: did(902), uses: "1", games: "1", made: "1", age: "0" },
    { k: "seen", d: did(903), uses: "4-7", games: "10-19", made: "2-4", age: "7-29" },
    { k: "seen", d: did(904), uses: "8-14", games: "20-49", made: "5+", age: "30-89" },
    { k: "seen", d: did(905), uses: "2-3", games: "2-4", made: "0", age: "1-6" },
  ]);
  const log = console.error;
  console.error = () => {}; // the handler's one-line error log (Vercel Logs)
  await post([
    { k: "err", msg: "TypeError: Cannot read properties of undefined (reading 'phase')", where: "room" },
    { k: "err", msg: "TypeError: Cannot read properties of undefined (reading 'phase')", where: "room" },
    { k: "err", msg: 'Failed to fetch "https://x.test/a?room=ABCDEFGH23"', where: "window.error" },
    { k: "err", msg: "ResizeObserver loop limit exceeded", where: "window.error" },
    { k: "session_done", p: 3, sid: "short" }, // a wiring bug: shows as rejected
  ]).finally(() => {
    console.error = log;
  });
  const get = async (q: string) => (await h(new Request(`https://playsnack.test/api/ev${q}`))).json();
  const today = kstDay(NOW);
  const weeks = await Promise.all(weeksFor(last7Days(today)).map((w) => get(`?week=${w}`)));
  return { weeks, day: await get(`?day=${today}`), growth: await get("?growth=1"), now: NOW };
}
