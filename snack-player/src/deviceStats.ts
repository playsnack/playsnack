// This browser's own usage counters + its random id for the unique-device estimate
// (docs/telemetry.md §4a). Everything lives in this browser's localStorage; once per
// KST day the app sends ONE `seen` event: the random id (the server only salted-hashes it
// into a HyperLogLog) and BUCKETS of these counters — never the counters themselves,
// never anything that names a person. Storage blocked → no id → nothing is sent (never
// a new id per page). Callers check telemetryEnabled() first (DNT/GPC → nothing).
// Erasable TypeScript only (Node runs it directly in tests).

export const DID_KEY = "snack.did";
export const USAGE_KEY = "snack.usage";
const DID_RE = /^[A-Za-z0-9_-]{22}$/;

export type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export type Usage = {
  firstDay: string;
  activeDays: number;
  gamesFinished: number;
  quizzesMade: number;
  lastActiveDay: string;
  /** The KST day the last `seen` report went out (at most one a day). */
  lastReportDay: string;
};

// ── buckets (the only form the counters leave the browser in; same lists in api/_lib/schema.js) ──
const bucket = (edges: [number, string][], last: string) => (n: number) => {
  for (const [max, label] of edges) if (n <= max) return label;
  return last;
};
/** Active days: 1 | 2-3 | 4-7 | 8-14 | 15-30 | 31+ */
export const usesBucket = bucket([[1, "1"], [3, "2-3"], [7, "4-7"], [14, "8-14"], [30, "15-30"]], "31+");
/** Lifetime finished games: 0 | 1 | 2-4 | 5-9 | 10-19 | 20-49 | 50+ */
export const gamesBucket = bucket([[0, "0"], [1, "1"], [4, "2-4"], [9, "5-9"], [19, "10-19"], [49, "20-49"]], "50+");
/** Quizzes made: 0 | 1 | 2-4 | 5+ */
export const madeBucket = bucket([[0, "0"], [1, "1"], [4, "2-4"]], "5+");
/** Days since first use: 0 | 1-6 | 7-29 | 30-89 | 90+ */
export const ageBucket = bucket([[0, "0"], [6, "1-6"], [29, "7-29"], [89, "30-89"]], "90+");

/** 128 random bits, base64url without padding (22 chars). */
export function newDeviceId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(16);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This browser's id: kept, or made once and kept. null when storage does not work. */
export function deviceId(storage: Store | null, random?: (n: number) => Uint8Array): string | null {
  if (!storage) return null;
  try {
    const have = storage.getItem(DID_KEY);
    if (have && DID_RE.test(have)) return have;
    const id = newDeviceId(random);
    storage.setItem(DID_KEY, id);
    return storage.getItem(DID_KEY) === id ? id : null; // only an id that sticks
  } catch {
    return null;
  }
}

function readUsage(storage: Store): Usage | null {
  try {
    const u = JSON.parse(storage.getItem(USAGE_KEY) || "null");
    if (u && typeof u === "object" && typeof u.firstDay === "string") return u as Usage;
  } catch {
    /* fall through */
  }
  return null;
}
function writeUsage(storage: Store, u: Usage): void {
  try {
    storage.setItem(USAGE_KEY, JSON.stringify(u));
  } catch {
    /* counters are best effort */
  }
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Count today as an active day (once per KST day) and return the counters. */
export function markActive(storage: Store, today: string): Usage {
  const u = readUsage(storage) || { firstDay: today, activeDays: 0, gamesFinished: 0, quizzesMade: 0, lastActiveDay: "", lastReportDay: "" };
  if (u.lastActiveDay !== today) {
    u.activeDays += 1;
    u.lastActiveDay = today;
  }
  writeUsage(storage, u);
  return u;
}

/** A game reached its result on this browser / this browser made a quiz the room took. */
export function noteUsage(storage: Store, today: string, what: "game" | "made"): void {
  const u = markActive(storage, today);
  if (what === "game") u.gamesFinished += 1;
  else u.quizzesMade += 1;
  writeUsage(storage, u);
}

export type SeenEvent = { k: "seen"; d: string; uses: string; games: string; made: string; age: string };

/** Today's one `seen` report (and mark it sent), or null: already sent today, or no id. */
export function dailySeen(storage: Store | null, today: string, random?: (n: number) => Uint8Array): SeenEvent | null {
  const d = deviceId(storage, random);
  if (!d || !storage) return null;
  const u = markActive(storage, today);
  if (u.lastReportDay === today) return null;
  u.lastReportDay = today;
  writeUsage(storage, u);
  if (readUsage(storage)?.lastReportDay !== today) return null; // could not remember it: do not risk one a page
  return {
    k: "seen", d,
    uses: usesBucket(u.activeDays),
    games: gamesBucket(u.gamesFinished),
    made: madeBucket(u.quizzesMade),
    age: ageBucket(Math.max(0, daysBetween(u.firstDay, today))),
  };
}
