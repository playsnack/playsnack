// KST (UTC+9, no DST) calendar day helpers. Aggregates are bucketed per KST day.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' of the KST day containing `now` (ms since epoch). */
export function kstDay(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Whole KST days from `day` to the KST day containing `now`: 0 = today, 1 = yesterday, -1 = tomorrow. */
export function daysAgo(day, now = Date.now()) {
  return Math.round((Date.parse(`${kstDay(now)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** ISO week ('YYYY-Www', Monday-start) of a YYYY-MM-DD day. */
export function isoWeek(day) {
  const d = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Mon = 0
  const thu = d + (3 - dow) * DAY_MS; // the week's Thursday decides its year
  const year = new Date(thu).getUTCFullYear();
  const week = Math.floor((thu - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The 7 days (Mon…Sun, YYYY-MM-DD) of an ISO week 'YYYY-Www', or null if it is not a real week. */
export function weekDays(week) {
  const m = typeof week === 'string' && /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const w = Number(m[2]);
  if (w < 1 || w > 53) return null;
  const jan4 = Date.UTC(year, 0, 4); // always in week 1
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (w - 1) * 7 * DAY_MS;
  const days = Array.from({ length: 7 }, (_, i) => utcDay(monday + i * DAY_MS));
  return isoWeek(days[0]) === week ? days : null; // e.g. 2026-W53 does not exist
}
