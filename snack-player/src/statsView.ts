// The /stats page's numbers, as pure functions (no DOM): which GET /api/ev reads
// to make, and how their answers turn into the plain-Korean rows on the page.
// Unit-tested in Node (snack-player/test/statsView.test.ts) against a fixture.
// The API's field names and buckets: api/_lib/schema.js (docs/telemetry.md §3, §9).

/** GET /api/ev `summary` (a day, a week, or one day inside a week's byDay). */
export type Summary = {
  sessionsDone: number;
  sessionsDone3: number;
  sessionsDup: number;
  sessionsAbout: number;
  rematch: number;
  roomsCreated: number;
  gamesCreated: number;
  gamesEditor: number;
  gamesRemade: number;
  joinOk: number;
  joinFail: number;
  joinFailReasons: Record<string, number>;
  joinMs: Record<string, number>;
  /**
   * Room-server joins only (`via: 'edge'`, counted from 2026-10-15) — the only join numbers
   * the page shows. The four above count every join (kept for history, not shown).
   */
  joinEdgeOk: number;
  joinEdgeFail: number;
  joinEdgeFailReasons: Record<string, number>;
  joinEdgeMs: Record<string, number>;
  share: number;
  shareWhat: Record<string, number>;
  askShown: number;
  askYes: number;
  askNo: number;
  askSkip: number;
  askNoReasons: Record<string, number>;
  errors: number;
  /** Once-a-day browser reports and their usage buckets (devices, not people). */
  devicesSeen: number;
  devicesByAge: Record<string, number>;
  devicesByUses: Record<string, number>;
  devicesByGames: Record<string, number>;
  devicesByMade: Record<string, number>;
  bad: Record<string, number>;
};
export type Budget = { month: string; used: number | null; limit: number };
export type WeekBody = {
  ok: boolean;
  error?: string;
  week?: string;
  store?: "kv" | "memory";
  wired?: boolean;
  stale?: boolean;
  byDay?: { day: string; total: number; summary: Summary }[];
  cumulative?: Record<string, number>;
  budget?: Budget;
};
export type DayBody = {
  ok: boolean;
  error?: string;
  day?: string;
  store?: "kv" | "memory";
  wired?: boolean;
  stale?: boolean;
  errors?: { distinct: number; top: { msg: string; count: number }[] };
  budget?: Budget;
};

// ── dates (KST, like the API: api/_lib/day.js) ──
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const kstDay = (now: number) => new Date(now + KST_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** ISO week 'YYYY-Www' of a day (same rule as api/_lib/day.js isoWeek). */
export function isoWeek(day: string): string {
  const d = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(d).getUTCDay() + 6) % 7;
  const thu = d + (3 - dow) * DAY_MS;
  const year = new Date(thu).getUTCFullYear();
  const week = Math.floor((thu - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
/** The last 7 KST days, oldest first, ending today. */
export const last7Days = (today: string) => Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
/** The ISO weeks those days fall in (1 or 2): one `?week=` read each. */
export const weeksFor = (days: string[]) => [...new Set(days.map(isoWeek))];

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
/** "10/14 (수)" */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEKDAY[d.getUTCDay()]})`;
}

// ── words ──
export const JOIN_FAIL_LABEL: Record<string, string> = {
  bad_link: "링크가 잘렸거나 잘못됨",
  not_found: "방이나 앱을 못 찾음",
  network: "인터넷 연결 문제",
  timeout: "연결이 15초 넘게 걸림",
  unreachable: "중계 연결에 닿지 못함",
  disconnected: "연결이 끊김",
  refused: "입장이 거절됨",
  subscribe: "방 신호를 받지 못함",
  silence: "15초 동안 방 소식이 없음",
  other: "기타",
};
export const ASK_NO_LABEL: Record<string, string> = {
  boring: "지루해요",
  hard: "어려워요",
  laggy: "끊기거나 느려요",
  few: "사람이 적어요",
  other: "기타",
};
export const SHARE_LABEL: Record<string, string> = { invite: "초대 링크", result: "결과", app: "게임 링크", other: "기타" };
export const KIND_LABEL: Record<string, string> = {
  open: "화면 열기", first_tap: "첫 탭", result: "결과", share: "공유", room_join: "입장", err: "오류",
  session_done: "끝난 판", rematch: "다시 하기", room_create: "방 만들기", game_created: "퀴즈 만들기",
  ask_shown: "질문 보여줌", ask_answer: "질문 응답",
};

// ── join time ──
/** Bucket labels in order, with their ms range (upper bound inclusive; the last has none). */
export const TIME_BUCKETS: { key: string; label: string; from: number; to: number | null }[] = [
  { key: "0-1s", label: "1초 이하", from: 0, to: 1000 },
  { key: "1-2s", label: "1~2초", from: 1000, to: 2000 },
  { key: "2-3s", label: "2~3초", from: 2000, to: 3000 },
  { key: "3-5s", label: "3~5초", from: 3000, to: 5000 },
  { key: "5-10s", label: "5~10초", from: 5000, to: 10000 },
  { key: "10s+", label: "10초 넘음", from: 10000, to: null },
];

/**
 * Estimated q-th percentile (0–1) of join time from bucket counts, by linear
 * interpolation inside the bucket it falls in. `null` when there are no joins;
 * `{ over: true }` when it lands in the open "10s+" bucket (no upper edge).
 */
export function estimatePercentile(counts: Record<string, number>, q: number): { ms: number; over: false } | { ms: 10000; over: true } | null {
  const total = TIME_BUCKETS.reduce((n, b) => n + (counts[b.key] || 0), 0);
  if (!total) return null;
  const rank = q * total;
  let seen = 0;
  for (const b of TIME_BUCKETS) {
    const n = counts[b.key] || 0;
    if (n && seen + n >= rank) {
      if (b.to === null) return { ms: 10000, over: true };
      return { ms: b.from + ((rank - seen) / n) * (b.to - b.from), over: false };
    }
    seen += n;
  }
  return { ms: 10000, over: true };
}

/** "약 1.4초" / "10초 넘음" / "—" */
export function fmtPercentile(p: ReturnType<typeof estimatePercentile>): string {
  if (!p) return "—";
  if (p.over) return "10초 넘음";
  return `약 ${(p.ms / 1000).toFixed(1)}초`;
}

// ── numbers ──
export const fmtInt = (n: number) => n.toLocaleString("ko-KR");
/** "90%" (rounded), or "—" when there is nothing to divide. */
export const fmtPct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

const sumRec = (a: Record<string, number>, b: Record<string, number>) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
  return out;
};
const EMPTY: Summary = {
  sessionsDone: 0, sessionsDone3: 0, sessionsDup: 0, sessionsAbout: 0, rematch: 0, roomsCreated: 0,
  gamesCreated: 0, gamesEditor: 0, gamesRemade: 0, joinOk: 0, joinFail: 0, joinFailReasons: {}, joinMs: {},
  joinEdgeOk: 0, joinEdgeFail: 0, joinEdgeFailReasons: {}, joinEdgeMs: {},
  share: 0, shareWhat: {}, askShown: 0, askYes: 0, askNo: 0, askSkip: 0, askNoReasons: {}, errors: 0,
  devicesSeen: 0, devicesByAge: {}, devicesByUses: {}, devicesByGames: {}, devicesByMade: {}, bad: {},
};
/** Add summaries (numbers add, per-reason maps add key by key). */
export function addSummaries(list: Summary[]): Summary {
  const out: Record<string, unknown> = { ...EMPTY };
  for (const s of list) {
    for (const k of Object.keys(EMPTY) as (keyof Summary)[]) {
      const v = s[k];
      if (typeof v === "number") out[k] = (out[k] as number) + v;
      else if (v && typeof v === "object") out[k] = sumRec(out[k] as Record<string, number>, v);
    }
  }
  return out as Summary;
}

/** Map rows sorted by count (desc), with Korean labels; zero rows left out. */
export function rankedRows(counts: Record<string, number>, labels: Record<string, string>) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, n]) => ({ key, label: labels[key] || key, n }));
}

/**
 * The 날마다 table: one number per column, each header saying what it counts (two short
 * lines, so it fits a 360 px phone; the table scrolls sideways past that). `strong` = the
 * headline (3+ players together — the same number as the 7-day card), in the hero colour.
 */
export const DAY_COLUMNS: { key: string; head: [string, string]; value: (s: Summary) => string; strong?: boolean }[] = [
  { key: "together", head: ["같이 한 판", "3명 이상"], value: (s) => fmtInt(s.sessionsDone3), strong: true },
  { key: "finished", head: ["끝난 판", "전체"], value: (s) => fmtInt(s.sessionsDone) },
  { key: "made", head: ["퀴즈", "직접 만듦"], value: (s) => fmtInt(s.gamesEditor) },
  { key: "remade", head: ["퀴즈", "나도 만들기"], value: (s) => fmtInt(s.gamesRemade) },
  { key: "rooms", head: ["새 친구 방", "만듦"], value: (s) => fmtInt(s.roomsCreated) },
  // Room-server joins only, like the 방 입장 card ("—" on a day before they were counted).
  { key: "join", head: ["입장", "성공률"], value: (s) => fmtPct(s.joinEdgeOk, s.joinEdgeOk + s.joinEdgeFail) },
];

/** Join times from one bucket map: the 6 bars, estimated p50/p75/p95 and the "2 s" bar. */
export function joinTimes(counts: Record<string, number>) {
  const total = TIME_BUCKETS.reduce((n, b) => n + (counts[b.key] || 0), 0);
  const fast = (counts["0-1s"] || 0) + (counts["1-2s"] || 0);
  return {
    total,
    within2s: fmtPct(fast, total),
    // The quality bar: p75 <= 2 s ⇔ at least 75% of timed joins took 2 s or less (exact from the buckets).
    meetsBar: total ? fast / total >= 0.75 : null,
    p50: fmtPercentile(estimatePercentile(counts, 0.5)),
    p75: fmtPercentile(estimatePercentile(counts, 0.75)),
    p95: fmtPercentile(estimatePercentile(counts, 0.95)),
    buckets: TIME_BUCKETS.map((b) => ({ key: b.key, label: b.label, n: counts[b.key] || 0 })),
  };
}

/** "10월 15일" */
export const monthDayLabel = (day: string) => `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;

export type DayRow = {
  day: string;
  label: string;
  isToday: boolean;
  /** No reading for that day (outside what the API returned). */
  missing: boolean;
  /** Nothing was counted that day (or no reading): the page says "아직 기록이 없어요". */
  empty: boolean;
  s: Summary;
};

export type StatsModel = {
  today: string;
  /** All 7 days empty. */
  empty: boolean;
  days: DayRow[];
  week: Summary;
  /** "연결 전" — the app does not send the free-beta numbers yet (0 means "not counted"). */
  wired: boolean;
  store: "kv" | "memory" | null;
  stale: boolean;
  budget: Budget | null;
  budgetReached: boolean;
  cumulative: Record<string, number>;
  errorsToday: { msg: string; count: number }[];
  /**
   * Joins to the room server only (`via: 'edge'`) — the page's only join numbers, so the old
   * player-hosted joins (3–5 s) do not blur the new ones (owner, 2026-10-15: the old combined
   * numbers stay stored but are not shown). `has` = any edge join in the 7 days; `since` = the
   * first of those days ("10월 15일") when it is inside the window — when counting started
   * (the deploy that sends `via`), not when rooms moved to the room server.
   */
  join: ReturnType<typeof joinTimes> & {
    has: boolean;
    since: string | null;
    ok: number;
    fail: number;
    successRate: string;
    /** Why room-server joins failed. */
    reasons: { key: string; label: string; n: number }[];
  };
  ask: { shown: number; yes: number; no: number; skip: number; noAnswer: number; reasons: { key: string; label: string; n: number }[] };
  shares: { total: number; what: { key: string; label: string; n: number }[] };
  rejected: { key: string; label: string; n: number }[];
};

/** Turn the API answers (1–2 `?week=` bodies + today's `?day=`) into what the page shows. */
export function buildModel(weeks: (WeekBody | null)[], day: DayBody | null, now: number): StatsModel {
  const today = kstDay(now);
  const byDay = new Map<string, { total: number; summary: Summary }>();
  for (const w of weeks) for (const d of (w && w.byDay) || []) byDay.set(d.day, d);
  const days: DayRow[] = last7Days(today).map((d) => {
    const r = byDay.get(d);
    return { day: d, label: dayLabel(d), isToday: d === today, missing: !r, empty: !r || !r.total, s: (r && r.summary) || EMPTY };
  }).reverse(); // newest first
  const week = addSummaries(days.map((d) => d.s));
  const okWeeks = weeks.filter((w): w is WeekBody => !!w && w.ok);
  const latest = okWeeks[okWeeks.length - 1] || null;
  const anyBody = [...weeks, day].filter((b): b is WeekBody | DayBody => !!b);
  const budget = anyBody.map((b) => b.budget).filter((b): b is Budget => !!b).sort((a, b) => (b.used || 0) - (a.used || 0))[0] || null;
  const edgeTries = week.joinEdgeOk + week.joinEdgeFail;
  // The first day with joins tagged as room-server ones = when counting them started (rooms
  // were already on the room server a day earlier; untagged joins then are not in here).
  // Only when that is inside these 7 days (on the oldest day it may just be where the window begins).
  const firstEdge = [...days].reverse().find((d) => d.s.joinEdgeOk + d.s.joinEdgeFail > 0);
  const edgeSince = firstEdge && firstEdge !== days[days.length - 1] ? firstEdge.day : null;
  return {
    today,
    empty: days.every((d) => d.empty),
    days,
    week,
    wired: okWeeks.length ? okWeeks.every((w) => w.wired !== false) : true,
    store: (latest && latest.store) || (day && day.store) || null,
    stale: anyBody.some((b) => b.stale === true),
    budget,
    budgetReached: anyBody.some((b) => b.error === "budget_reached"),
    cumulative: (latest && latest.cumulative) || {},
    errorsToday: ((day && day.errors && day.errors.top) || []).slice(0, 5),
    join: {
      ...joinTimes(week.joinEdgeMs),
      has: edgeTries > 0,
      since: edgeSince ? monthDayLabel(edgeSince) : null,
      ok: week.joinEdgeOk,
      fail: week.joinEdgeFail,
      successRate: fmtPct(week.joinEdgeOk, edgeTries),
      reasons: rankedRows(week.joinEdgeFailReasons, JOIN_FAIL_LABEL),
    },
    ask: {
      shown: week.askShown,
      yes: week.askYes,
      no: week.askNo,
      skip: week.askSkip,
      noAnswer: Math.max(0, week.askShown - week.askYes - week.askNo - week.askSkip),
      reasons: rankedRows(week.askNoReasons, ASK_NO_LABEL),
    },
    shares: { total: week.share, what: rankedRows(week.shareWhat, SHARE_LABEL) },
    rejected: rankedRows(week.bad, KIND_LABEL),
  };
}

/** "이번 달 1,234 / 400,000 명령 (0.3%)" pieces; used null = not read yet. */
export function budgetLine(b: Budget | null): { used: string; limit: string; pct: number | null } {
  if (!b) return { used: "—", limit: "—", pct: null };
  return {
    used: b.used === null ? "—" : fmtInt(b.used),
    limit: fmtInt(b.limit),
    pct: b.used === null ? null : Math.min(100, (b.used / b.limit) * 100),
  };
}

// ── growth (GET /api/ev?growth=1): "지금까지" ──
export type GrowthMonth = {
  month: string;
  totals: Record<string, number>;
  /** "DD" -> headline field -> count, that day only. */
  days: Record<string, Record<string, number>>;
  devices: number;
};
export type GrowthBody = {
  ok: boolean;
  error?: string;
  today?: string;
  store?: "kv" | "memory";
  allTime?: Record<string, number>;
  months?: GrowthMonth[];
  devices?: { counting: boolean; allTime: number };
  budget?: Budget;
};
export type GrowthMetric = "games_finished" | "quizzes_created" | "players_in_finished_games";
export const GROWTH_METRICS: { key: GrowthMetric; label: string; unit: string }[] = [
  { key: "games_finished", label: "끝난 판", unit: "판" },
  { key: "quizzes_created", label: "만들어진 퀴즈", unit: "개" },
  { key: "players_in_finished_games", label: "같이 논 사람", unit: "명" },
];
/** Up to this many days the chart has one point a day; longer, one a month. */
export const DAILY_POINTS_MAX = 120;

export type GrowthPoint = { key: string; label: string; value: number };
export type GrowthSeries = { by: "day" | "month"; points: GrowthPoint[] };

/** "2026년 10월" */
export const monthLabel = (m: string) => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5, 7))}월`;
const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const shortMonth = (m: string) => `${m.slice(2, 4)}년 ${Number(m.slice(5, 7))}월`;

/** The first month with any headline count (the honest "기록 시작"), or null. */
export function firstMonth(g: GrowthBody | null): string | null {
  for (const m of (g && g.months) || []) if (Object.values(m.totals || {}).some((n) => n > 0)) return m.month;
  return null;
}

/**
 * Cumulative series of one metric, from the first day with any count to today: one point
 * a day (days without counts carry the total over — a flat step, not a gap), or one a
 * month when that span is longer than DAILY_POINTS_MAX days.
 */
export function growthSeries(g: GrowthBody | null, metric: GrowthMetric, today: string): GrowthSeries {
  const months = ((g && g.months) || []).filter((m) => m.month <= today.slice(0, 7));
  const daily = new Map<string, number>();
  for (const m of months) for (const [dd, f] of Object.entries(m.days || {})) if (f[metric]) daily.set(`${m.month}-${dd}`, f[metric]);
  const anyDay = [...daily.keys()].sort()[0];
  const startMonth = months.find((m) => (m.totals[metric] || 0) > 0)?.month;
  if (!anyDay && !startMonth) return { by: "day", points: [] };
  const start = anyDay && (!startMonth || anyDay.slice(0, 7) <= startMonth) ? anyDay : `${startMonth}-01`;
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (span <= DAILY_POINTS_MAX) {
    const points: GrowthPoint[] = [];
    let sum = 0;
    for (let i = 0; i < span; i++) {
      const d = addDays(start, i);
      sum += daily.get(d) || 0;
      points.push({ key: d, label: shortDay(d), value: sum });
    }
    return { by: "day", points };
  }
  let sum = 0;
  const points = months
    .filter((m) => m.month >= start.slice(0, 7))
    .map((m) => ({ key: m.month, label: shortMonth(m.month), value: (sum += m.totals[metric] || 0) }));
  return { by: "month", points };
}

/** Y-axis ticks 0 … top in round steps (about 3 of them) for a maximum value. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw));
  const st = Number.isInteger(step) ? step : Math.ceil(step);
  const top = Math.ceil(max / st) * st;
  const out: number[] = [];
  for (let v = 0; v <= top; v += st) out.push(v);
  return out;
}

/** Today's browsers (their once-a-day reports): first-timers vs returning, heavy players, makers. */
export function regulars(s: Summary | null) {
  const seen = (s && s.devicesSeen) || 0;
  const by = (k: "devicesByAge" | "devicesByGames" | "devicesByMade"): Record<string, number> => (s && s[k]) || {};
  const first = by("devicesByAge")["0"] || 0;
  const tenPlus = ["10-19", "20-49", "50+"].reduce((n, b) => n + (by("devicesByGames")[b] || 0), 0);
  return {
    seen,
    firstPct: fmtPct(first, seen),
    returningPct: fmtPct(seen - first, seen),
    tenPlusPct: fmtPct(tenPlus, seen),
    madeFivePlus: by("devicesByMade")["5+"] || 0,
  };
}
