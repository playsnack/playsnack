// Anonymous telemetry client for POST /api/ev (see docs/telemetry.md).
// - No cookies, localStorage, nicknames, user agents or person / device / browser-session
//   ids are sent. The free-beta game events carry a random per-game id (`sid` / `gid`,
//   made by the host engine); the server keeps only its hash, for 6 h (docs/telemetry.md §9).
// - Off in dev, with VITE_TELEMETRY=off, or when Do Not Track / Global Privacy Control is set.
// - Batches every 5 s / 20 events / when the page is hidden; sendBeacon, fetch keepalive fallback.
// Not wired into the app yet; callers use track()/installErrorBeacon() and the
// free-beta helpers at the end of this file.
// Erasable TypeScript only (Node can run this file directly for tests).

export type Route = 'home' | 'app' | 'room' | 'create' | 'other';
export type ShareMethod = 'web' | 'kakao' | 'copy' | 'save' | 'other';
// Free-beta metrics (docs/telemetry.md §9). Defined, not yet called from the app.
export type ShareWhat = 'invite' | 'result' | 'app' | 'other';
export type RoomKind = 'public' | 'friend';
export type JoinFailReason = 'bad_link' | 'not_found' | 'network' | 'timeout' | 'unreachable' | 'disconnected' | 'refused' | 'other';
export type GameSource = 'editor' | 'remake';
export type AskAnswer = 'yes' | 'no' | 'skip';
export type AskReason = 'boring' | 'hard' | 'laggy' | 'few' | 'other';

export type TelemetryEvent =
  | { k: 'open'; route: Route; app?: string }
  | { k: 'first_tap'; ms: number; app?: string }
  | { k: 'result'; app?: string }
  | { k: 'share'; method: ShareMethod; what?: ShareWhat; app?: string }
  | { k: 'room_join'; ok: boolean; ms?: number; app?: string; room?: RoomKind; reason?: JoinFailReason }
  | { k: 'err'; msg: string; where?: string; build?: string }
  /**
   * A game reached its result — sent by the host engine only; `p` = players who took part (acted this game; a quiz subject counts),
   * `sid` = the engine's game id. Quiz only: `about` = a made quiz about a person,
   * `ans` = players other than that person who answered (1 = the 1:1 case).
   */
  | { k: 'session_done'; app?: string; p: number; sid: string; about?: boolean; ans?: number }
  /** A new game started in a room whose previous game reached its result (host engine only). */
  | { k: 'rematch'; app?: string; p: number; sid: string }
  | { k: 'room_create'; app?: string }
  /** The host engine accepted a valid quiz pack; `gid` = the engine's id for that pack. */
  | { k: 'game_created'; app?: string; source: GameSource; gid: string }
  | { k: 'ask_shown'; app?: string }
  | { k: 'ask_answer'; app?: string; a: AskAnswer; why?: AskReason };

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

// ── free-beta metrics (docs/telemetry.md §9 — defined, not yet wired) ──

/**
 * The app part of a slug or room id, so a friends-room code or a made app's hash is
 * never sent: `quiz-ox~CODE` / `tpl-quiz-ox` → `quiz-ox`, `app-<hash>` → `custom`.
 */
export function appOf(slugOrRoomId: string): string {
  const id = slugOrRoomId.replace(/~.*$/s, '').replace(/^tpl-/, '');
  return id.startsWith('app-') ? 'custom' : id;
}

/** Map a room transport's failure reason (roomTransport / mqttBus) to the reported set. */
export function joinFailReason(raw: string | undefined): JoinFailReason {
  if (!raw) return 'other';
  if (raw === 'timeout' || raw === 'unreachable' || raw === 'disconnected') return raw;
  if (raw === 'broker' || raw === 'subscribe') return 'unreachable';
  if (raw === 'load') return 'network';
  if (raw.startsWith('refused')) return 'refused';
  return 'other';
}

const MAX_ONCE_KEYS = 400;
const onceKeys = new Set<string>();
/** True the first time `key` is seen on this page (bounded). */
function firstTime(key: string): boolean {
  if (onceKeys.has(key) || onceKeys.size >= MAX_ONCE_KEYS) return false;
  onceKeys.add(key);
  return true;
}

const players = (n: number) => Math.max(1, Math.floor(Number(n) || 0));

/** Host engine only: a game reached its result; `tookPart` = players who acted this game. Counted once per `sid`. */
export function trackSessionDone(app: string, tookPart: number, sid: string, quiz?: { about: boolean; answerers: number }): void {
  if (!(tookPart >= 1) || !firstTime(`session_done|${sid}`)) return; // nobody took part: not a played game
  const ev: Extract<TelemetryEvent, { k: 'session_done' }> = { k: 'session_done', app: appOf(app), p: players(tookPart), sid };
  if (quiz) {
    ev.about = quiz.about;
    ev.ans = Math.max(0, Math.floor(Number(quiz.answerers) || 0));
  }
  track(ev);
}

/** Host engine only: a new game started after the room's previous game reached its result. */
export function trackRematch(app: string, playerCount: number, sid: string): void {
  if (firstTime(`rematch|${sid}`)) track({ k: 'rematch', app: appOf(app), p: players(playerCount), sid });
}

/** The device that made a new friends-room code (never the code itself). */
export function trackRoomCreate(app: string): void {
  track({ k: 'room_create', app: appOf(app) });
}

/** Host engine only: it accepted a valid quiz pack. Counted once per `gid` (here and on the receiving end). */
export function trackGameCreated(app: string, source: GameSource, gid: string): void {
  if (firstTime(`game_created|${gid}`)) track({ k: 'game_created', app: appOf(app), source, gid });
}

/** One join attempt: ok, or the reason it failed. */
export function trackJoin(app: string, ok: boolean, o: { ms?: number; room?: RoomKind; reason?: JoinFailReason } = {}): void {
  const ev: Extract<TelemetryEvent, { k: 'room_join' }> = { k: 'room_join', ok, app: appOf(app) };
  if (o.ms !== undefined) ev.ms = Math.round(o.ms);
  if (o.room) ev.room = o.room;
  if (!ok) ev.reason = o.reason ?? 'other';
  track(ev);
}

/** A share that really happened (share sheet resolved, clipboard written). */
export function trackShare(method: ShareMethod, what: ShareWhat, app?: string): void {
  const ev: Extract<TelemetryEvent, { k: 'share' }> = { k: 'share', method, what };
  if (app) ev.app = appOf(app);
  track(ev);
}

/**
 * The result-screen question was shown — once per game per device. `gameKey` is any
 * per-game key known on this device (e.g. a count of result screens seen); it is not sent.
 */
export function trackAskShown(app: string, gameKey: string): void {
  if (firstTime(`ask_shown|${gameKey}`)) track({ k: 'ask_shown', app: appOf(app) });
}

/** The question was answered (or explicitly skipped) — once per game per device; a reason only with "no". */
export function trackAskAnswer(app: string, gameKey: string, a: AskAnswer, why?: AskReason): void {
  if (!firstTime(`ask_answer|${gameKey}`)) return;
  const ev: Extract<TelemetryEvent, { k: 'ask_answer' }> = { k: 'ask_answer', app: appOf(app), a };
  if (a === 'no' && why) ev.why = why;
  track(ev);
}
