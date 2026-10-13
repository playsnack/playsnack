// Anonymous telemetry client for POST /api/ev (see docs/telemetry.md).
// - No cookies, localStorage, device/session ids, nicknames or user agents are sent.
// - Off in dev, with VITE_TELEMETRY=off, or when Do Not Track / Global Privacy Control is set.
// - Batches every 5 s / 20 events / when the page is hidden; sendBeacon, fetch keepalive fallback.
// Wired in main.tsx (installErrorBeacon) and LiveApp via roomJoin.ts (room_join).
// Erasable TypeScript only (Node can run this file directly for tests).

export type Route = 'home' | 'app' | 'room' | 'create' | 'other';
export type ShareMethod = 'web' | 'kakao' | 'copy' | 'save' | 'other';

export type TelemetryEvent =
  | { k: 'open'; route: Route; app?: string }
  | { k: 'first_tap'; ms: number; app?: string }
  | { k: 'result'; app?: string }
  | { k: 'share'; method: ShareMethod; app?: string }
  | { k: 'room_join'; ok: boolean; ms?: number; reason?: string; app?: string }
  | { k: 'err'; msg: string; where?: string; build?: string };

export type TelemetryOptions = {
  /** Force on/off. Privacy signals (DNT/GPC) still win over `true`. */
  enabled?: boolean;
  endpoint?: string;
  /** Build id attached to error events (e.g. short git sha). */
  build?: string;
  flushMs?: number;
};

const MAX_BATCH_EVENTS = 20;
const MAX_BATCH_BYTES = 4000; // server rejects bodies > 4096 bytes
const MAX_EVENTS_PER_PAGE = 200;
const MAX_ERRORS_PER_PAGE = 10;
const MAX_MSG_CHARS = 300;

const opts: Required<Omit<TelemetryOptions, 'enabled' | 'build'>> & Pick<TelemetryOptions, 'enabled' | 'build'> = {
  endpoint: '/api/ev',
  flushMs: 5000,
};

let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sentTotal = 0;
let errCount = 0;
const errSeen = new Set<string>();
let lifecycleInstalled = false;
let errorBeaconInstalled = false;

export function configureTelemetry(o: TelemetryOptions): void {
  Object.assign(opts, o);
}

function viteEnv(): Record<string, unknown> {
  try {
    return (import.meta.env as Record<string, unknown> | undefined) ?? {};
  } catch {
    return {};
  }
}

function privacySignal(): boolean {
  const nav = (globalThis as { navigator?: Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string } }).navigator;
  const win = globalThis as { doNotTrack?: string };
  const dnt = nav?.doNotTrack ?? win.doNotTrack ?? nav?.msDoNotTrack;
  return dnt === '1' || dnt === 'yes' || nav?.globalPrivacyControl === true;
}

/** Whether events are currently collected. */
export function telemetryEnabled(): boolean {
  if (privacySignal()) return false;
  if (opts.enabled !== undefined) return opts.enabled;
  const env = viteEnv();
  if (env.DEV === true) return false;
  if (String(env.VITE_TELEMETRY ?? '').toLowerCase() === 'off') return false;
  return true;
}

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Split events into JSON bodies of at most MAX_BATCH_EVENTS events and MAX_BATCH_BYTES bytes. */
export function packBatches(events: TelemetryEvent[]): string[] {
  const out: string[] = [];
  let cur: TelemetryEvent[] = [];
  const body = (evs: TelemetryEvent[]) => JSON.stringify({ v: 1, events: evs });
  for (const ev of events) {
    if (bytes(body([ev])) > MAX_BATCH_BYTES) continue; // cannot fit even alone
    if (cur.length >= MAX_BATCH_EVENTS || (cur.length && bytes(body([...cur, ev])) > MAX_BATCH_BYTES)) {
      out.push(body(cur));
      cur = [];
    }
    cur.push(ev);
  }
  if (cur.length) out.push(body(cur));
  return out;
}

function send(body: string): void {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  try {
    // A string body is sent as text/plain (no CORS preflight).
    if (nav && typeof nav.sendBeacon === 'function' && nav.sendBeacon(opts.endpoint, body)) return;
  } catch {
    /* fall through */
  }
  try {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (f) {
      void f(opts.endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        credentials: 'omit',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }).catch(() => {});
    }
  } catch {
    /* telemetry must never break the app */
  }
}

/** Send everything queued now. */
export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const events = queue;
  queue = [];
  if (!telemetryEnabled()) return;
  for (const b of packBatches(events)) send(b);
}

function installLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  const g = globalThis as unknown as Partial<Window>;
  const doc = g.document;
  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flush();
  });
  g.addEventListener?.('pagehide', () => flush());
}

/** Queue one event. No-op when telemetry is disabled or the per-page budget is spent. */
export function track(ev: TelemetryEvent): void {
  if (!telemetryEnabled()) return;
  if (sentTotal >= MAX_EVENTS_PER_PAGE) return;
  sentTotal++;
  installLifecycle();
  queue.push(ev);
  if (queue.length >= MAX_BATCH_EVENTS) flush();
  else if (!timer) timer = setTimeout(flush, opts.flushMs);
}

/** Report an error once per page (dedupe by message + where), at most 10 per page. */
export function trackError(msg: unknown, where?: string): void {
  const text = String(msg ?? '').slice(0, MAX_MSG_CHARS).trim();
  if (!text) return;
  const key = `${where ?? ''}|${text}`;
  if (errSeen.has(key) || errCount >= MAX_ERRORS_PER_PAGE) return;
  if (!telemetryEnabled()) return;
  errSeen.add(key);
  errCount++;
  const ev: Extract<TelemetryEvent, { k: 'err' }> = { k: 'err', msg: text };
  if (where) ev.where = where;
  if (opts.build) ev.build = opts.build;
  track(ev);
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === 'string' ? e : String(e);
}

/** Listen for uncaught errors and unhandled rejections and report them anonymously. */
export function installErrorBeacon(build?: string): void {
  if (build) opts.build = build;
  if (errorBeaconInstalled) return;
  const g = globalThis as unknown as Window;
  if (typeof g.addEventListener !== 'function') return;
  errorBeaconInstalled = true;
  g.addEventListener('error', (e: ErrorEvent) => {
    trackError(e.error ? errorText(e.error) : e.message, 'window.error');
  });
  g.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    trackError(errorText(e.reason), 'unhandledrejection');
  });
}
