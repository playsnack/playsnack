// /stats page: the numbers (statsView.ts) from the real /api/ev answers, the
// rendered Korean text, and the home screen's link to it.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildModel, budgetLine, dayLabel, estimatePercentile, firstMonth, fmtPercentile, growthSeries, isoWeek, kstDay, last7Days, niceTicks, regulars, weeksFor,
  type GrowthBody,
} from "../src/statsView.ts";
import { StatsBody, StatsPage } from "../src/StatsPage.tsx";
import { GrowthChart, GrowthSection } from "../src/GrowthSection.tsx";
import { StatsLink } from "../src/StatsLink.tsx";
import { parseRoute } from "../src/links.ts";
import { statsFixture, NOW } from "./fixtures/stats.ts";
// @ts-ignore — plain JS (the API's own date helpers)
import { isoWeek as apiIsoWeek, kstDay as apiKstDay } from "../../api/_lib/day.js";

test("dates: KST day, last 7 days, the 1–2 ISO weeks to read (same rule as the API)", () => {
  assert.equal(kstDay(NOW), "2026-10-14");
  assert.equal(kstDay(Date.parse("2026-10-13T15:00:00Z")), "2026-10-14"); // KST midnight
  const days = last7Days("2026-10-14");
  assert.deepEqual([days[0], days[6]], ["2026-10-08", "2026-10-14"]);
  assert.deepEqual(weeksFor(days), ["2026-W41", "2026-W42"]);
  assert.deepEqual(weeksFor(last7Days("2026-10-18")), ["2026-W42"]); // Sunday: one week
  for (const d of ["2026-01-01", "2026-12-28", "2027-01-03", "2026-10-14"]) assert.equal(isoWeek(d), apiIsoWeek(d), d);
  assert.equal(kstDay(NOW), apiKstDay(NOW));
  assert.equal(dayLabel("2026-10-14"), "10/14 (수)");
});

test("join-time percentiles from the buckets (linear inside a bucket; 10s+ has no edge)", () => {
  assert.equal(estimatePercentile({}, 0.75), null);
  // 4 joins: 2 in 0-1s, 2 in 1-2s → p50 = 1.0 s, p75 = 1.5 s.
  const c = { "0-1s": 2, "1-2s": 2 };
  assert.deepEqual(estimatePercentile(c, 0.5), { ms: 1000, over: false });
  assert.deepEqual(estimatePercentile(c, 0.75), { ms: 1500, over: false });
  assert.equal(fmtPercentile(estimatePercentile(c, 0.75)), "약 1.5초");
  assert.deepEqual(estimatePercentile({ "0-1s": 1, "10s+": 3 }, 0.75), { ms: 10000, over: true });
  assert.equal(fmtPercentile(estimatePercentile({ "10s+": 1 }, 0.5)), "10초 넘음");
  assert.equal(fmtPercentile(null), "—");
});

test("model from the real API answers: daily rows, week sums, join, ask, shares, errors", async () => {
  const { weeks, day, now } = await statsFixture();
  assert.ok(weeks.every((w) => w.ok && Array.isArray(w.byDay)), "the API returns byDay");
  const m = buildModel(weeks, day, now);
  assert.equal(m.today, "2026-10-14");
  assert.equal(m.days.length, 7);
  assert.equal(m.days[0].day, "2026-10-14", "newest first");
  assert.ok(m.days[0].isToday);
  assert.ok(m.days.every((d) => !d.missing));
  // Today (i = 0): 2 games with 3+ players + one 1:1 → finished 3 / 3+ 2; quizzes editor 1 / remake 1.
  assert.equal(m.days[0].s.sessionsDone, 3);
  assert.equal(m.days[0].s.sessionsDone3, 2);
  assert.deepEqual([m.days[0].s.gamesEditor, m.days[0].s.gamesRemade], [1, 1]);
  // Yesterday (i = 1): 3 + 1 games, no remake.
  assert.deepEqual([m.days[1].s.sessionsDone, m.days[1].s.sessionsDone3, m.days[1].s.gamesRemade], [4, 3, 0]);
  // Week = sum of the 7 rows.
  assert.equal(m.week.sessionsDone3, m.days.reduce((n, d) => n + d.s.sessionsDone3, 0));
  assert.equal(m.week.sessionsDone3, 2 + 3 + 4 + 2 + 3 + 4 + 2);
  assert.equal(m.week.roomsCreated, 7);
  // Joins: per day 4 + (i % 4) successes from [0.6, 0.9, 1.4, 1.7, 2.6, 4.2, 0.8] s.
  const ok = [0, 1, 2, 3, 4, 5, 6].reduce((n, i) => n + 4 + (i % 4), 0);
  assert.equal(m.week.joinOk, ok);
  assert.equal(m.join.total, ok);
  assert.equal(m.week.joinFail, 3 + 1); // silence on i = 0, 3, 6 + bad_link on i = 1
  assert.deepEqual(m.join.reasons.map((r) => [r.key, r.label, r.n]), [
    ["silence", "15초 동안 방 소식이 없음", 3],
    ["bad_link", "링크가 잘렸거나 잘못됨", 1],
  ]);
  const fast = m.join.buckets[0].n + m.join.buckets[1].n;
  assert.equal(m.join.meetsBar, fast / ok >= 0.75);
  assert.equal(m.join.successRate, `${Math.round((ok / (ok + 4)) * 100)}%`);
  assert.match(m.join.p75, /^약 \d\.\d초$/);
  // "다음에도?": 3 asked a day; yes every day, no on odd days, skip today.
  assert.deepEqual([m.ask.shown, m.ask.yes, m.ask.no, m.ask.skip], [21, 7, 3, 1]);
  assert.equal(m.ask.noAnswer, 21 - 11);
  assert.deepEqual(m.ask.reasons.map((r) => [r.label, r.n]), [["사람이 적어요", 2], ["끊기거나 느려요", 1]]);
  assert.deepEqual(m.shares.what.map((r) => [r.label, r.n]), [["초대 링크", 7], ["결과", 3]]);
  // Today's errors: already cleaned by /api/ev (quoted text, URLs, room codes gone).
  assert.equal(m.errorsToday[0].count, 2);
  assert.ok(m.errorsToday.length <= 5);
  for (const e of m.errorsToday) assert.doesNotMatch(e.msg, /ABCDEFGH23|x\.test|phase'/);
  assert.deepEqual(m.rejected.map((r) => [r.label, r.n]), [["끝난 판", 1]]);
  assert.equal(m.wired, true);
  assert.equal(m.store, "memory");
  assert.equal(m.cumulative.games_finished, m.week.sessionsDone);
  assert.deepEqual(budgetLine(m.budget), { used: "—", limit: "400,000", pct: null }); // memory store: no KV commands
  assert.deepEqual(budgetLine({ month: "2026-10", used: 12345, limit: 400000 }).pct?.toFixed(2), "3.09");
});

test("rendered page: plain Korean, honest notes, no fake-live words", async () => {
  const { weeks, day, growth, now } = await statsFixture();
  const m = buildModel(weeks, day, now);
  const html = renderToStaticMarkup(createElement(StatsBody, { m, g: growth, at: null, onReload: () => {} }));
  for (const s of ["날마다", "최근 7일", "자주 쓰는 사람", "오늘 들어온 기기", "5대", "처음 온 기기", "40%", "다시 온 기기", "60%", "10판 이상 한 기기", "퀴즈를 5개 이상 만든 기기", "1대", "10/14 (수)", "오늘", "방 입장", "입장까지 걸린 시간", "4번 중 3번은", "1초 이하", "10초 넘음",
    "공유", "다음에도 하고 싶나요?", "좋아요", "아니요", "건너뜀", "사람이 적어요", "앱에서 난 문제", "이번 달 집계 사용량", "400,000",
    "잠깐만 남는 임시 숫자"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes("아직 연결 전"), "wired: no 'not connected' note");
  assert.ok(!html.includes("아직 기록이 없어요"), "every fixture day has records");
  // No developer words for a visitor.
  assert.doesNotMatch(html, /p50|p75|p95|KV|명령|wired|session|bucket|NaN/);
  // wired:false → the honest note; budget reached → said so.
  const off = buildModel(weeks.map((w) => ({ ...w, wired: false })), { ...day, store: "kv" }, now);
  const offHtml = renderToStaticMarkup(createElement(StatsBody, { m: off, at: null, onReload: () => {} }));
  assert.ok(offHtml.includes("아직 연결 전"));
  const capped = buildModel([{ ok: false, error: "budget_reached", budget: { month: "2026-10", used: 400100, limit: 400000 } }], null, now);
  const capHtml = renderToStaticMarkup(createElement(StatsBody, { m: capped, at: null, onReload: () => {} }));
  assert.ok(capHtml.includes("집계 한도에 닿아"));
  assert.ok(capHtml.includes("400,100"));
  // Empty days (no reading, or nothing counted) say so instead of rows of zeros.
  assert.equal(capped.empty, true);
  // 7 rows + the 7-day note + 지금까지 (line and empty chart) + 자주 쓰는 사람.
  assert.equal((capHtml.match(/아직 기록이 없어요/g) || []).length, 7 + 1 + 2 + 1);
  const partial = buildModel(weeks.map((w) => ({ ...w, byDay: (w.byDay || []).filter((d) => d.day !== "2026-10-12") })), day, now);
  assert.equal(partial.days.find((d) => d.day === "2026-10-12")?.empty, true);
  assert.equal(partial.empty, false);
  const partialHtml = renderToStaticMarkup(createElement(StatsBody, { m: partial, g: growth, at: null, onReload: () => {} }));
  assert.equal((partialHtml.match(/아직 기록이 없어요/g) || []).length, 1);
  for (const h of [html, offHtml, capHtml]) assert.doesNotMatch(h, /서버|LIVE|접속\s?중|실시간|저장(되었|됐|돼|했어|해요)/);
});

test("page shell: the one-line intro for visitors and the ← 홈 button", () => {
  const html = renderToStaticMarkup(createElement(StatsPage, { onHome: () => {} }));
  assert.ok(html.includes("PlaySnack에서 일어난 일을 익명 숫자로 보여 줘요 · 누가 했는지는 저장하지 않아요"));
  assert.ok(html.includes("← 홈"));
  assert.ok(html.includes("불러오는 중"));
});

test("routes and the home screen's quiet 📊 통계 link (for everyone)", () => {
  const loc = (pathname: string) => ({ pathname, search: "", hash: "" });
  assert.equal(parseRoute(loc("/stats")).route.name, "stats");
  assert.equal(parseRoute(loc("/stats/")).route.name, "stats");
  assert.equal(parseRoute(loc("/statsx")).route.name, "home");
  const link = renderToStaticMarkup(createElement(StatsLink, { onOpen: () => {} }));
  assert.match(link, /📊 통계/);
  assert.match(link, /min-height:44px/);
  assert.ok(link.includes("익명 통계를 위해 이 브라우저에 무작위 번호를 저장해요 · 누가 했는지는 알 수 없어요"));
});

// ── growth ("지금까지") ──
const gm = (month: string, days: Record<string, Record<string, number>>, devices = 0) => {
  const totals: Record<string, number> = {};
  for (const f of Object.values(days)) for (const [k, n] of Object.entries(f)) totals[k] = (totals[k] || 0) + n;
  return { month, totals, days, devices };
};

test("growth series: cumulative per day from the first record, flat over quiet days; months when long", () => {
  const g: GrowthBody = {
    ok: true,
    months: [gm("2026-10", { "13": { games_finished: 2 }, "16": { games_finished: 3, quizzes_created: 1 } }), gm("2026-11", { "01": { games_finished: 1 } })],
  };
  const s = growthSeries(g, "games_finished", "2026-11-02");
  assert.equal(s.by, "day");
  assert.equal(s.points[0].key, "2026-10-13");
  assert.equal(s.points[0].label, "10/13");
  assert.equal(s.points.length, 21); // 10/13 … 11/02
  assert.deepEqual(s.points.slice(0, 5).map((p) => p.value), [2, 2, 2, 5, 5]);
  assert.equal(s.points.at(-1)!.value, 6);
  assert.deepEqual(growthSeries(g, "quizzes_created", "2026-11-02").points[0], { key: "2026-10-16", label: "10/16", value: 1 });
  // Nothing yet / just today.
  assert.deepEqual(growthSeries({ ok: true, months: [gm("2026-10", {})] }, "games_finished", "2026-10-14").points, []);
  assert.deepEqual(growthSeries(null, "games_finished", "2026-10-14").points, []);
  const one = growthSeries({ ok: true, months: [gm("2026-10", { "14": { games_finished: 4 } })] }, "games_finished", "2026-10-14");
  assert.deepEqual(one.points, [{ key: "2026-10-14", label: "10/14", value: 4 }]);
  // Longer than 120 days: one point a month.
  const long: GrowthBody = { ok: true, months: [gm("2026-10", { "13": { games_finished: 1 } }), gm("2026-11", {}), gm("2026-12", { "05": { games_finished: 2 } }), gm("2027-01", {}), gm("2027-02", { "20": { games_finished: 3 } })] };
  const m = growthSeries(long, "games_finished", "2027-02-20");
  assert.equal(m.by, "month");
  assert.deepEqual(m.points.map((p) => [p.label, p.value]), [["26년 10월", 1], ["26년 11월", 1], ["26년 12월", 3], ["27년 1월", 3], ["27년 2월", 6]]);
  assert.equal(firstMonth(long), "2026-10");
  assert.equal(firstMonth({ ok: true, months: [gm("2026-10", {}), gm("2026-11", { "02": { rooms_created: 1 } })] }), "2026-11");
});

test("axis ticks are round and cover the top", () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(4), [0, 2, 4]);
  assert.deepEqual(niceTicks(27), [0, 10, 20, 30]);
  assert.deepEqual(niceTicks(1234), [0, 500, 1000, 1500]);
  for (const n of [1, 3, 7, 99, 101, 5000, 123456]) {
    const t = niceTicks(n);
    assert.ok(t.at(-1)! >= n && t.length >= 2 && t.length <= 6, `${n}: ${t}`);
  }
});

test("regulars: first-timers, returning, 10+ games, 5+ quizzes from today's buckets", () => {
  const r = regulars({ devicesSeen: 5, devicesByAge: { "0": 2, "7-29": 3 }, devicesByGames: { "10-19": 1, "50+": 1, "0": 3 }, devicesByMade: { "5+": 1 } } as never);
  assert.deepEqual(r, { seen: 5, firstPct: "40%", returningPct: "60%", tenPlusPct: "40%", madeFivePlus: 1 });
  assert.deepEqual(regulars(null), { seen: 0, firstPct: "—", returningPct: "—", tenPlusPct: "—", madeFivePlus: 0 });
});

test("growth from the real API: totals, since-month, devices (추정) and the chart render", async () => {
  const { growth, now } = await statsFixture();
  assert.equal(growth.ok, true);
  assert.equal(firstMonth(growth), "2026-10");
  assert.equal(growth.devices!.counting, true);
  assert.equal(growth.devices!.allTime, 5);
  const html = renderToStaticMarkup(createElement(GrowthSection, { g: growth, today: kstDay(now) }));
  for (const s of ["지금까지", "기록 시작: 2026년 10월", "끝난 판", "만들어진 퀴즈", "같이 논 사람", "연인원", "함께한 기기", "약 5대", "(추정)",
    "같은 사람이 폰과 PC를 쓰면 2대로 세요 · 오차 약 1%", "표로 보기", "10/8", "10/14"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes(`>${growth.allTime!.games_finished}<`), "the total");
  assert.doesNotMatch(html, /사용자|NaN|undefined/);
  assert.doesNotMatch(html.replace(/같이 논 사람|연인원|한 사람이 5판 하면 5|같은 사람이 폰과 PC/g, ""), /\d+명/, "no '명' for devices");
  // Several months of history → a month chart; only today → one point.
  const longFx = await statsFixture({ now: Date.parse("2027-03-14T06:00:00Z"), historyFrom: "2026-10-13" });
  const s = growthSeries(longFx.growth, "games_finished", "2027-03-14");
  assert.equal(s.by, "month");
  assert.deepEqual(s.points.map((p) => p.key), ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  for (let i = 1; i < s.points.length; i++) assert.ok(s.points[i].value >= s.points[i - 1].value, "cumulative never falls");
  const todayFx = await statsFixture({ onlyToday: true });
  const one = growthSeries(todayFx.growth, "games_finished", "2026-10-14");
  assert.equal(one.points.length, 1);
  const chart = renderToStaticMarkup(createElement(GrowthChart, { series: one, unit: "판", label: "끝난 판" }));
  assert.match(chart, /<circle/);
  assert.ok(!chart.includes("<polyline"), "one point: a dot, no line");
  assert.ok(chart.includes("첫 기록이에요"));
  assert.ok(renderToStaticMarkup(createElement(GrowthChart, { series: { by: "day", points: [] }, unit: "판", label: "끝난 판" })).includes("아직 기록이 없어요"));
});
