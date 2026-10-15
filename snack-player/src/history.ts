// Undo/redo history — pure, in memory only (no storage). One History holds the
// versions of one thing (a quiz question slot, a question list): `past` (oldest
// first), the `present` version and `future` (next redo first). Recording a new
// version drops the redo branch. Typing is coalesced: records that share a
// `group` key and come within `idleMs` of the previous one replace the present
// instead of adding a step; `seal` (e.g. on blur) ends the group.

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Coalescing group of the present step (null = sealed). */
  group: string | null;
  /** When the present step was last recorded (ms). */
  at: number;
};

export const HISTORY_CAP = 30;
export const COALESCE_IDLE_MS = 800;

export type RecordOptions = {
  /** Merge into the present step when it has the same group and is recent. */
  group?: string;
  now?: number;
  idleMs?: number;
  cap?: number;
  /** Versions equal to the present are not recorded (default: same JSON). */
  equal?: (a: unknown, b: unknown) => boolean;
};

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], group: null, at: 0 });

export function record<T>(h: History<T>, next: T, opts: RecordOptions = {}): History<T> {
  const { group, now = Date.now(), idleMs = COALESCE_IDLE_MS, cap = HISTORY_CAP, equal = sameJson } = opts;
  if (equal(h.present, next)) {
    // Nothing changed — but keep a typing group alive so the idle timer restarts.
    return group !== undefined && h.group === group ? { ...h, at: now } : h;
  }
  const merge = group !== undefined && h.group === group && now - h.at < idleMs;
  if (merge) return { ...h, present: next, future: [], at: now };
  const past = [...h.past, h.present];
  // Keep at most `cap` undo steps (the oldest fall off).
  return { past: past.length > cap ? past.slice(past.length - cap) : past, present: next, future: [], group: group ?? null, at: now };
}

/** End the present coalescing group (the next edit starts a new step). */
export const seal = <T>(h: History<T>): History<T> => (h.group === null ? h : { ...h, group: null });

export const canUndo = (h: History<unknown> | undefined) => Boolean(h && h.past.length);
export const canRedo = (h: History<unknown> | undefined) => Boolean(h && h.future.length);

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], group: null, at: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), group: null, at: 0 };
}
