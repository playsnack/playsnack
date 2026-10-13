// KST (UTC+9, no DST) calendar day helpers. Aggregates are bucketed per KST day.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' of the KST day containing `now` (ms since epoch). */
export function kstDay(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the KST month containing `now` (the Upstash command budget period). */
export function kstMonth(now = Date.now()) {
  return kstDay(now).slice(0, 7);
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
