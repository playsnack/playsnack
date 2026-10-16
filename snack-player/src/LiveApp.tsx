import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { BiteDoc } from "@snack/bite";
// Pixi loads its browser environment and WebGL renderer lazily, which on a play
// link costs two more round trips after the app code (~1.4 s on Fast 3G).
// Importing them here puts them in the same download as the player.
import "pixi.js/browser";
import { WebGLRenderer } from "pixi.js";
import { BitePlayer } from "./BitePlayer.tsx";
import { getAnonId, getNick, isNickAuto, setNick } from "./identity";
import { NameCard } from "./NameCard";
import { ReactionLayer, type ReactionFxApi } from "./ReactionLayer";
import { showNameCard } from "./nameChoice";
import { CONNECT_TIMEOUT_MS, hasSeatToken, type ConnState, type RoomTransport } from "./roomTransport";
import { createRoom, EDGE_ROOM_SERVER, hrefTo, isFreshRoom, loadRoomDoc, navigate, newFriendRoom, SERVERLESS } from "./backend";
import { friendLink, playPath, publicLink, roomCodeOf, roomIdFor, roomKindOf, roomParamOf, shareableParams } from "./links";
import { needsRoom, soloAlternative, type CatalogEntry } from "./catalog";
import { ChoiceSheet, HomeButton, HostPinNotice, LoadingScreen, MessageScreen, PinSheet, RoomChip, RoomFailedSheet, RoomSlowNotice, RoomTypeChip, goHome, type PinError } from "./Screens";
import { chipAction, leaveFriendsCopy, roomChip, roomKind, showRoomChip } from "./roomType";
import { passes, PIN_REASONS } from "./roomAdmission";
import { pill, primaryBtn, secondaryBtn } from "./ui";
import { C, R, S, TOKENS, blockShadow } from "./tokens.gen";
import { joinTracker, slowJoinText } from "./roomJoin";
import { visibleTimeout, type VisibleTimer } from "./visibleTimer";
import { autoStartTicker } from "./autoStart";
import { SCHEDULE_OPEN_EVENT, SCHEDULE_REFUSALS, scheduleTicker, type ScheduleVars } from "./schedule";
import ScheduleSheet from "./ScheduleSheet";
import { noteDeviceUsage, trackRoomCreate, trackShare } from "./telemetry";
import {
  MAKE_EVENT, MAKE_HOST_EVENT, MAKE_PARAM, PACK_REFUSALS, QUIZ_SLUG, deviceQuizStore, openQuizMaker, packAction, packFailureMessage, packPending,
  type QuizInfo, type QuizPack, type RoomEntry,
} from "./quiz";
// The maker is loaded only when opened (play links do not pay for it).
const QuizMaker = lazy(() => import("./QuizMaker.tsx").then((m) => ({ default: m.QuizMaker })));
import { makerLink, resultHooks, useResultExtras } from "./ResultExtras";
import { InviteQrSheet, QrButton } from "./InviteQr";
import Toast from "./Toast";
import { INVITE_PIN_ASK, askPinFirst, browserHandOutEnv, canOfferPin, copiedLines, handOutLink, invitePinAsked } from "./invite";
import { fetchRoomResult, lastResultWatcher, type SavedResult } from "./roomResult";
// The room's last finished game (docs/room-results.md) — loaded only when there is one.
const LastResult = lazy(() => import("./LastResult.tsx").then((m) => ({ default: m.LastResult })));
import { quizInviteBandRect } from "./canvasFit";
import { SPECTATOR_NOTICE_BOX, SPECTATOR_NOTICE_TEXT, declaresVar, forTemplate, showSpectatorNotice } from "./spectate";

// "나도 만들기" on the quiz result screen opens the maker over this room (lane B).
resultHooks.makeQuiz = () => openQuizMaker();

// Plays one app from a link. Solo apps just play. Together apps (or any app
// that sends events to a room, or a link that names a room) also join a room
// through a RoomTransport: Bite `emit` → room action, room `setVar` broadcasts
// → the runtime, so everyone sees the same shared state.
type Runtime = { setVar: (id: string, v: unknown) => void };

// A real use, so the bundler keeps the renderer here (an unused import is dropped).
Object.assign(globalThis, { __snackWebGLRenderer: WebGLRenderer });

/**
 * A room that stays silent this long counts as failed (nothing may hang). Just past the
 * transport's own deadline (45 s — a slow broker gets ≈ 4 connect tries), so its reason wins.
 */
const ROOM_SILENCE_MS = CONNECT_TIMEOUT_MS + 2_000;
/**
 * Getting back into the room after a drop (back from the share sheet, #115) is silent; only
 * if it takes longer than this does the room chip say "다시 연결 중…".
 */
export const RECONNECT_NOTICE_MS = 1_500;

/** Rooms this page just moved its host into with a new PIN link: their invite sheet opens at once (#157). */
const inviteOnOpen = new Set<string>();
/** Rooms this page just moved its host into from "비밀번호 걸고 보내기" (#217): a one-tap "링크 보내기" sheet waits there. */
const sendOnOpen = new Set<string>();
/** Rooms whose "비밀번호를 걸까요?" was answered on this device (#217). */
const pinAsked = invitePinAsked();

/** Tests only (#218 e2e): `localStorage.snack_sched_test_s` adds a short preset to the time sheet (the room still checks its own minimum). */
const scheduleTestSec = () => {
  try {
    const n = Number(localStorage.getItem("snack_sched_test_s"));
    return Number.isInteger(n) && n > 0 && n < 60 ? n : undefined;
  } catch {
    return undefined;
  }
};

type LoadError = "notFound" | "network";
const isNetworkError = (e: unknown) =>
  (typeof navigator !== "undefined" && navigator.onLine === false) ||
  (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));

export function LiveApp({ slug, params }: { slug: string; params: URLSearchParams }) {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState<LoadError | null>(null);
  const [loadGen, setLoadGen] = useState(0);
  // The screen's room state. A transport's "reconnecting" keeps it (the screen stays as it was)
  // and only sets `reconnecting` (#115).
  const [conn, setConn] = useState<Exclude<ConnState, "reconnecting">>("connecting");
  const [reconnecting, setReconnecting] = useState(false);
  const [connReason, setConnReason] = useState<string | undefined>(undefined);
  const [connRetryIn, setConnRetryIn] = useState<number | undefined>(undefined);
  const [roomGen, setRoomGen] = useState(0);
  const [participants, setParticipants] = useState(1);
  const [solo, setSolo] = useState<CatalogEntry | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const roomRef = useRef<RoomTransport | null>(null);
  const sharedRef = useRef<Record<string, unknown> | null>(null);
  const fxRef = useRef<ReactionFxApi | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const [reactOpen, setReactOpen] = useState(false);
  // "이름 정하기" (#104, nameChoice.ts): this device's identity as the room transport holds it,
  // and whether the guest name was auto-assigned and not yet kept / changed on this page.
  const meRef = useRef<{ slug: string; anonId: string; nick: string } | null>(null);
  const [nickAuto, setNickAuto] = useState(isNickAuto);
  const [nameChosen, setNameChosen] = useState(false);
  // Spectating a game in progress (spectate.ts): this player's flag and the room's phase.
  const [spectator, setSpectator] = useState<{ me: unknown; phase: string }>({ me: false, phase: "" });
  // ── "나 맞히기" quiz (only the quiz app): the room's phase, quizInfo, roster
  // and this player's iAmSubject flag (per player, from the room), and the pack
  // this device made for this room (quiz.ts packAction decides when to send it).
  // The questions never travel in the link. The lobby's words are the
  // template's; the shell only adds the invite button.
  const isQuiz = slug === QUIZ_SLUG;
  const roomId = roomIdFor(slug, params);
  const [phase, setPhase] = useState("");
  const [roster, setRoster] = useState<string[]>([]);
  const [myPack, setMyPack] = useState<QuizPack | null>(() => (isQuiz ? deviceQuizStore().roomPack(roomId) : null));
  const [packFail, setPackFail] = useState<string | null>(null);
  const [makerOpen, setMakerOpen] = useState(false);
  // A friends-room link opened when nobody is there: the room's last finished game (roomResult.ts).
  const [lastResult, setLastResult] = useState<SavedResult | null>(null);
  const quizRef = useRef({ phase: "lobby", info: null as QuizInfo | null, iAmSubject: undefined as boolean | undefined, lastSentAt: 0, live: false });
  const withRoom = doc ? needsRoom(doc, params) : false;
  // A present-but-invalid ?room= (a code cut by a chat app) must never land in
  // the public room: nothing loads or joins, the screen says the link is bad.
  const roomParam = roomParamOf(params);
  const invalidRoom = roomParam.kind === "invalid";
  // ── PIN rooms (#157, docs/room-admission.md): a 20-symbol code on the room server. Without a
  // pass or a seat on this device the PIN is asked BEFORE joining (no network needed to know);
  // the app loads meanwhile. The PIN goes to the transport and is not kept here.
  const pinRoom = Boolean(EDGE_ROOM_SERVER) && roomParam.kind === "code" && roomKindOf(roomParam.code) === "pin";
  const [joinReady, setJoinReady] = useState(() => !pinRoom || Boolean(passes.get(roomId)) || hasSeatToken(roomId));
  const [pinGate, setPinGate] = useState<{ checking: boolean; error: PinError | null } | null>(() => (joinReady ? null : { checking: false, error: null }));
  const firstPinRef = useRef<string | null>(null);
  const enterPinRef = useRef<(pin: string) => void>(() => {});
  // The host's side: setting a PIN (a new link) and the PIN room's warnings.
  const [pinSet, setPinSet] = useState<{ checking: boolean; send?: boolean } | null>(null);
  const [hostPin, setHostPin] = useState<"alert" | "closed" | null>(null);
  const [moving, setMoving] = useState(false);
  const [mintFail, setMintFail] = useState(false);
  // 시작 시간 예약 (#218, schedule.ts): the room's scheduled start as this device runs it, and the
  // host's sheet (busy = a schedule / unschedule sent, waiting for the room's answer).
  const schedVarsRef = useRef<ScheduleVars>({ startAt: 0, startIn: 0, startAtText: "" }); // (for onReady)
  const [sched, setSched] = useState<ScheduleVars>({ startAt: 0, startIn: 0, startAtText: "" });
  const [schedSheet, setSchedSheet] = useState<{ busy: boolean; error: string | null } | null>(null);

  // Floating emoji reactions over the canvas (ReactionLayer.tsx, #121).
  const sendReaction = (emoji: string) => {
    roomRef.current?.sendReaction(emoji);
    fxRef.current?.mine(emoji); // an immediate local burst; the room's echo is skipped
  };

  const applyShared = (shared: Record<string, unknown> | null | undefined) => {
    const rt = runtimeRef.current;
    if (!rt || !shared) return;
    for (const [k, v] of Object.entries(shared)) if (forTemplate(doc, k)) rt.setVar(k, v);
  };

  // Load the app (a merged template's old link was already redirected by App).
  useEffect(() => {
    if (invalidRoom) return;
    let closed = false;
    setErr(null);
    loadRoomDoc(slug, params)
      .then(({ doc, sharedState }) => {
        if (closed) return;
        sharedRef.current = sharedState ?? null;
        setDoc(doc);
      })
      .catch((e) => {
        if (closed) return;
        console.warn("[snack] app load failed", e);
        setErr(isNetworkError(e) ? "network" : "notFound");
      });
    return () => { closed = true; };
  }, [slug, loadGen]);

  // Join the room — only when the app is played together.
  useEffect(() => {
    if (!doc || !withRoom || invalidRoom || !joinReady) return;
    // The room id is the link's: the app's public room, or `slug~CODE` for a
    // friends-only link (links.ts). The transport passes it through unchanged.
    // Alone in the lobby of a friends room: its last finished game, if any (docs/room-results.md).
    // A room this page has just made has no past game: no lookup (saves a KV read).
    // Edge rooms (VITE_ROOM_URL): the room server keeps the result, so it is read there.
    const last = lastResultWatcher({
      roomId: roomIdFor(slug, params),
      skip: !(SERVERLESS || EDGE_ROOM_SERVER) || isFreshRoom(roomIdFor(slug, params)),
      show: setLastResult,
      // A PIN room's result is read with this device's pass (the room server answers nothing without it).
      ...(EDGE_ROOM_SERVER ? { fetchResult: (id: string) => fetchRoomResult(id, undefined, EDGE_ROOM_SERVER, pinRoom ? passes.get(id)?.token : undefined) } : {}),
    });
    // The transport keeps this object: a rename (#104) updates its nick, so a reconnect's hello
    // and a mesh heartbeat say the new name too.
    const me = { slug: roomIdFor(slug, params), anonId: getAnonId(), nick: getNick() ?? "" };
    meRef.current = me;
    // A public edge room starts by itself with the app's own start payload (#136, doc.room).
    const roomCfg = doc.room;
    const pin = firstPinRef.current ?? undefined;
    firstPinRef.current = null; // handed to the transport (which drops it once in)
    const room: RoomTransport = createRoom(me, params, { ...(roomCfg ? { autoStart: { start: roomCfg.start, ms: roomCfg.autoStartMs } } : {}), ...(pin ? { pin } : {}) });
    roomRef.current = room;
    // "10초 뒤 시작" (autoStart.ts): seconds left, into the template's autoStartIn when it has one.
    const auto = autoStartTicker((n) => {
      if (doc.vars && Object.prototype.hasOwnProperty.call(doc.vars, "autoStartIn")) runtimeRef.current?.setVar("autoStartIn", n);
    });
    // "m:ss 뒤 시작!" (#218): the scheduled start on this device's clock, into startAt / startIn / startAtText.
    const schedule = scheduleTicker((v) => {
      for (const [k, x] of Object.entries(v)) if (declaresVar(doc, k)) runtimeRef.current?.setVar(k, x);
      schedVarsRef.current = { ...schedVarsRef.current, ...v };
      if ("startAt" in v || "startAtText" in v) setSched(schedVarsRef.current); // (not every second)
    });
    const join = joinTracker({ slug, room: roomIdFor(slug, params), via: room.via }); // room_join telemetry + ?debug=1 log
    // The backstop for a transport that never reports: like the transport's own deadline,
    // it counts only time with the page on screen (visibleTimer.ts, #115).
    let silence: VisibleTimer | undefined;
    let back = false; // reconnecting (was in, dropped): the screen stays
    const waitForRoom = () => {
      silence?.cancel();
      silence = visibleTimeout(() => {
        join.conn("failed", "silence");
        if (back) {
          back = false;
          setReconnecting(false);
          setConn("failed");
        } else setConn((s) => (s === "connecting" ? "failed" : s));
      }, ROOM_SILENCE_MS);
    };
    const heard = () => {
      silence?.cancel();
      join.conn("connected");
      setConn((s) => (s === "connecting" ? "connected" : s));
    };
    room.onMessage((m) => {
      if (m.t === "conn") {
        const state = m.d.state as ConnState;
        quizRef.current.live = state === "connected"; // a pack sent before this is dropped (and burns a resend gap)
        join.conn(state, m.d.reason as string | undefined);
        back = state === "reconnecting";
        setReconnecting(back);
        const reason = m.d.reason as string | undefined;
        // A PIN refusal: the PIN screen asks again (wrong → tries left, locked → the wait) — the
        // screen is not "failed" (no failure sheet) and nothing reconnects on its own.
        const pinAsk = state === "failed" && PIN_REASONS.has(reason ?? "");
        if (pinAsk) setPinGate({ checking: false, error: { reason: reason!, left: m.d.left as number | undefined, retryIn: m.d.retryIn as number | undefined } });
        else if (state === "connected") setPinGate(null);
        else if (state === "failed") setPinGate(null);
        if (state !== "reconnecting") {
          setConn(state);
          setConnReason(reason);
          setConnRetryIn(typeof m.d.retryIn === "number" ? m.d.retryIn : undefined);
        }
        if (state === "connecting" || state === "reconnecting") waitForRoom();
        else silence?.cancel();
        return;
      }
      // To the organizer of a PIN room: wrong PINs keep coming / it no longer lets new people in.
      if (m.t === "alert") return setHostPin((k) => k ?? "alert");
      if (m.t === "pinClosed") return setHostPin("closed");
      // A new broker connect try (serverless): counted for room_join, not room traffic.
      if (m.t === "connAttempt") return join.attempt(Number(m.d.n), m.d.reason as string | undefined);
      // A public room mid-game moved us to its next room (#136): still joining, the screen stays.
      if (m.t === "moved") return;
      heard(); // any room traffic means we're in
      if (m.t === "autoStart") return auto.message(m.d.endsIn);
      if (m.t === "schedule") {
        schedule.message(m.d as Record<string, unknown>);
        // the host's sheet: the room took it (a new time, or the cancel) — done
        setSchedSheet((x) => (x?.busy ? null : x));
        return;
      }
      if (m.t === "state") {
        quizRef.current.live = true;
        sharedRef.current = m.d.sharedState as Record<string, unknown>;
        applyShared(sharedRef.current);
        if (typeof m.d.participants === "number") setParticipants(m.d.participants);
        const sh = sharedRef.current ?? {};
        last.state(m.d.participants, sh.sessionPhase);
        // A (re)join: the room sends this player's iAmSubject right after the state.
        quizRef.current.iAmSubject = undefined;
        // A new room has no sessionPhase yet (the room sets it on its first phase change): it is in the lobby.
        onQuizVar("sessionPhase", sh.sessionPhase ?? "lobby");
        onQuizVar("roster", sh.roster ?? []);
        onQuizVar("quizInfo", sh.quizInfo ?? null);
        setSpectator({ me: sh.iAmSpectator, phase: String(sh.sessionPhase ?? "lobby") });
      } else if (m.t === "setVar") {
        if (m.d.id === "sessionPhase") last.phase(m.d.value); // a game started here: the old result steps aside
        if (m.d.id === "sessionPhase" && m.d.value !== "lobby") {
          auto.clear(); // the countdown is over
          schedule.clear(); // a start ends the schedule (#218)
          setSchedSheet(null);
        }
        if (forTemplate(doc, m.d.id as string)) runtimeRef.current?.setVar(m.d.id as string, m.d.value);
        onQuizVar(m.d.id as string, m.d.value);
        if (m.d.id === "iAmSpectator") setSpectator((x) => ({ ...x, me: m.d.value }));
        else if (m.d.id === "sessionPhase") setSpectator((x) => ({ ...x, phase: String(m.d.value) }));
      } else if (m.t === "actionAck") {
        // Only quizPack is refused this way ("not_in_lobby" = sent mid-game: packAction waits for the result).
        if (m.d.accepted === false && PACK_REFUSALS.has(m.d.reason as string)) onPackRefused(m.d.reason as string);
        // the host's schedule / unschedule refused (#218): the sheet says why
        else if (m.d.accepted === false) setSchedSheet((x) => (x?.busy ? { busy: false, error: SCHEDULE_REFUSALS[m.d.reason as string] ?? "예약하지 못했어요. 다시 해 주세요" } : x));
      } else if (m.t === "participants") {
        last.participants(m.d.count);
        setParticipants(m.d.count as number);
      } else if (m.t === "reaction") {
        fxRef.current?.incoming(m.d.emoji as string);
      }
    });
    setConn("connecting");
    waitForRoom();
    join.start("connect");
    room.connect();
    // retry() (when the transport has it) restarts the same connection.
    retryRef.current = room.retry
      ? () => { back = false; setReconnecting(false); setConn("connecting"); waitForRoom(); join.start("retry"); room.retry!(); }
      : () => setRoomGen((g) => g + 1);
    // Another PIN typed on the PIN screen: the same join, with it.
    enterPinRef.current = (p: string) => {
      back = false;
      setReconnecting(false);
      setConn("connecting");
      waitForRoom();
      join.start("retry");
      room.enterPin?.(p);
    };
    return () => {
      silence?.cancel();
      auto.stop();
      schedule.clear();
      setReconnecting(false);
      last.close();
      join.end();
      room.close();
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [doc, slug, withRoom, roomGen, joinReady]);

  // A slow join (a public broker can take ~20 s): from SLOW_JOIN_MS on, the connecting UI
  // says so with the seconds and already offers "혼자 하기"; the failed sheet comes only at
  // the transport's deadline. Never "connected" before the room state arrives.
  const [connectingFor, setConnectingFor] = useState(0);
  useEffect(() => {
    setConnectingFor(0);
    if (!withRoom || conn !== "connecting" || !joinReady || pinGate) return;
    const t0 = performance.now();
    const id = setInterval(() => setConnectingFor(performance.now() - t0), 1000);
    return () => clearInterval(id);
  }, [conn, withRoom, roomGen, joinReady, Boolean(pinGate)]);
  const slowText = withRoom && conn === "connecting" && joinReady && !pinGate ? slowJoinText(connectingFor) : null;
  // Back in the room after a drop: quiet at first, then a small "다시 연결 중…" in the room chip.
  const [reconnectNotice, setReconnectNotice] = useState(false);
  useEffect(() => {
    setReconnectNotice(false);
    if (!reconnecting) return;
    const t = setTimeout(() => setReconnectNotice(true), RECONNECT_NOTICE_MS);
    return () => clearTimeout(t);
  }, [reconnecting]);
  const slow = Boolean(slowText);

  // The closest one-person app, offered if the room can't be joined (or is slow to).
  useEffect(() => {
    if (conn === "failed" || slow) soloAlternative(slug).then(setSolo);
  }, [conn, slug, slow]);
  const soloBtn = solo
    ? { label: `혼자 하기 · ${solo.title}`, onClick: () => { location.href = hrefTo(`/p/tpl-${solo.id}`); } }
    : { label: "혼자 하는 게임 고르기", onClick: goHome };

  // The quiz vars this shell reads (the template shows the rest itself).
  const onQuizVar = (id: string, value: unknown) => {
    if (!isQuiz) return;
    const q = quizRef.current;
    if (id === "sessionPhase" && typeof value === "string") {
      q.phase = value;
      setPhase(value);
    } else if (id === "quizInfo") {
      q.info = value && typeof value === "object" ? (value as QuizInfo) : null;
    } else if (id === "iAmSubject") {
      q.iAmSubject = value === true ? true : value === false ? false : undefined;
    } else if (id === "roster") {
      // People in the room by the room's roster (not raw connections).
      setRoster(Array.isArray(value) ? value.map(String) : []);
      return;
    } else return;
    quizTick();
  };
  // Send / confirm / forget this device's pack (rules + tests: quiz.ts packAction).
  const myPackRef = useRef(myPack);
  myPackRef.current = myPack;
  const quizTick = () => {
    const pack = myPackRef.current;
    const room = roomRef.current;
    const q = quizRef.current;
    const store = deviceQuizStore();
    const entry: Partial<RoomEntry> = (pack && store.roomEntry(roomId)) || {};
    const state = { phase: q.phase, info: q.info, iAmSubject: q.iAmSubject, entry, lastSentAt: q.lastSentAt, now: Date.now() };
    // Until the room takes my pack its lobby must not offer the quiz it has now (packPending).
    if (isQuiz) runtimeRef.current?.setVar("packPending", pack && packPending(state) ? pack.title : "");
    if (!pack || !room || !q.live) return;
    const action = packAction(state);
    if (action === "confirm") {
      store.confirmRoomPack(roomId);
      if (!entry.confirmed) noteDeviceUsage("made"); // first confirm only; this browser's own counter (deviceStats.ts); only buckets ever leave
      setPackFail(null);
    } else if (action === "forget") {
      // Someone else's quiz is the room's now: stop sending mine here (it stays in the recent list).
      store.forgetRoomPack(roomId);
      myPackRef.current = null;
      setMyPack(null);
      setPackFail(null);
    } else if (action === "send") {
      q.lastSentAt = Date.now();
      store.countSend(roomId);
      room.sendAction("quizPack", pack);
    } else if (action === "failed") {
      setPackFail(packFailureMessage(entry.refused));
    }
  };
  const onPackRefused = (reason: string) => {
    if (!myPackRef.current) return;
    deviceQuizStore().refuseRoomPack(roomId, reason);
    quizTick();
  };
  const retryPack = () => {
    deviceQuizStore().retryRoomPack(roomId);
    quizRef.current.lastSentAt = 0;
    setPackFail(null);
    quizTick();
  };
  // Retries after the re-send gap (a lost pack, one sent mid-game).
  useEffect(() => {
    if (!isQuiz || !myPack || conn !== "connected") return;
    quizTick();
    const t = setInterval(quizTick, 1000);
    return () => clearInterval(t);
  }, [isQuiz, myPack, conn]);
  // "나도 만들기": ?make=1 on a room link, or openQuizMaker() (quiz.ts) from the
  // result screen. Without a room code the maker opens on its own page (App).
  useEffect(() => {
    if (!isQuiz) return;
    const open = () => {
      if (!roomCodeOf(params)) return navigate(playPath(slug, new URLSearchParams({ [MAKE_PARAM]: "1" })));
      setMakerOpen(true);
    };
    if (params.has(MAKE_PARAM) && roomCodeOf(params)) {
      setMakerOpen(true);
      // Drop ?make=1 from the address bar so a shared or reloaded link does not reopen the maker.
      history.replaceState(history.state, "", playPath(slug, shareableParams(params)));
    }
    addEventListener(MAKE_EVENT, open);
    return () => removeEventListener(MAKE_EVENT, open);
  }, [isQuiz]);
  const finishMaker = (pack: QuizPack) => {
    // The maker's "내 이름" (a guest picks a real one there) is this player's name in the room too.
    renameInRoom(getNick() ?? "");
    setNickAuto(isNickAuto());
    const store = deviceQuizStore();
    store.rememberRoomPack(roomId, pack, quizRef.current.info?.packId ?? null);
    store.clearDraft();
    quizRef.current.lastSentAt = 0;
    myPackRef.current = pack;
    setMyPack(pack);
    setPackFail(null);
    setMakerOpen(false);
    quizTick();
  };

  // This device's nickname changed (the card, the maker): tell the room (`rename`, taken in the
  // lobby / result — where the card and the maker are) and the transport (its next hello / heartbeat).
  const renameInRoom = (nick: string) => {
    const me = meRef.current;
    if (!me || !nick || nick === me.nick) return;
    me.nick = nick;
    roomRef.current?.sendAction("rename", { nick });
  };
  const keepName = () => {
    setNick(getNick() ?? meRef.current?.nick ?? ""); // no longer the auto name (storage permitting)
    setNameChosen(true);
    setNickAuto(isNickAuto());
  };
  const changeName = (nick: string) => {
    setNick(nick);
    setNameChosen(true);
    renameInRoom(nick);
    setNickAuto(isNickAuto());
  };

  const onReady = (rt: Runtime | undefined) => {
    if (!rt) return;
    runtimeRef.current = rt;
    applyShared(sharedRef.current); // seed from cold-load / latest authoritative state
    // A shell variable (#143): this friends room has a PIN — the lobby subtitle adds 🔒.
    if (doc && declaresVar(doc, "roomPin")) rt.setVar("roomPin", pinRoom);
    // A shell variable (#218): the lobby's "under a minute" pulse stays still with reduced motion.
    if (doc && declaresVar(doc, "reduceMotion")) rt.setVar("reduceMotion", globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);
    // …and the scheduled start, when the room said it before the app was ready
    if (doc) for (const [k, x] of Object.entries(schedVarsRef.current)) if (declaresVar(doc, k)) rt.setVar(k, x);
    extras.attach(rt as Parameters<typeof extras.attach>[0]);
    quizTick(); // a pack made for this room shows "준비 중…" from the first frame
    // Dev only (dropped from builds): the screenshot harness feeds fixture vars.
    if (import.meta.env.DEV) Object.assign(globalThis, { __snackRuntime: rt });
    try {
      performance.mark("snack:first-scene");
    } catch {}
  };

  const onHostEvent = (e: { name: string; payload?: unknown }) => {
    if (extras.handleEvent(e)) return; // a result-screen button: handled here, not a room action
    // "나도 만들기" from a template button: handled on this device, never sent to the room.
    if (isQuiz && e.name === MAKE_HOST_EVENT) return openQuizMaker();
    // "⏰ 시작 시간 정하기" (#218): the host's sheet, on this device (the room hears the chosen time).
    if (e.name === SCHEDULE_OPEN_EVENT) return setSchedSheet({ busy: false, error: null });
    roomRef.current?.sendAction(e.name, e.payload);
  };

  // Friends-only room: the link carries a room code (?room=…). Without one,
  // the pill makes a code and moves this player into that room (no reload);
  // with one, it hands the link out — share sheet, else clipboard, else shown
  // to copy by hand (kept until dismissed). Only what really happened is
  // reported. A present-but-invalid code never falls back to the public room.
  const code = roomParam.kind === "code" ? roomParam.code : null;
  const [invite, setInvite] = useState<"copied" | null>(null);
  const [area, setArea] = useState<[number, number]>([0, 0]); // the play area (BitePlayer), for the quiz invite band
  const [qrOpen, setQrOpen] = useState(() => inviteOnOpen.delete(roomId)); // the same link as a QR, for friends right here
  const failMint = () => {
    setMintFail(true);
    setTimeout(() => setMintFail(false), 3000);
  };
  // The room server makes the code (/mint, ~0.1 s, no room woken yet); this device hosts it.
  // `pin`: a PIN room (a new link). `replace`: the old link was only this device's (nobody came).
  const goToNewRoom = async (o: { pin?: string; replace?: boolean; openInvite?: boolean; sendLink?: boolean } = {}) => {
    const r = await newFriendRoom(slug, o.pin ? { pin: o.pin, anonId: getAnonId() } : {});
    if (!r.ok) return false;
    const p = shareableParams(params);
    p.set("room", r.code);
    const next = roomIdFor(slug, p);
    trackRoomCreate(slug); // the code itself is never sent
    // A quiz made for this room goes along to the new one (nobody else has seen it yet).
    const store = deviceQuizStore();
    const pack = isQuiz ? store.roomPack(roomId) : null;
    if (pack) store.rememberRoomPack(next, pack);
    if (o.openInvite) inviteOnOpen.add(next);
    if (o.sendLink) {
      sendOnOpen.add(next);
      pinAsked.add(next); // the new room's PIN is set: never asked there
    }
    navigate(playPath(slug, p), { replace: Boolean(o.replace) });
    return true;
  };
  const [minting, setMinting] = useState(false);
  const openFriendRoom = async () => {
    if (minting) return;
    setMinting(true);
    const ok = await goToNewRoom();
    setMinting(false);
    if (!ok) failMint();
  };
  // "비밀번호 걸기" (host, alone): 4 digits → a new PIN link; the invite sheet opens there with the PIN.
  // From "비밀번호 걸고 보내기" (#217, `send`): the new room's "링크 보내기" sheet instead (one fresh tap shares).
  const submitPinSet = async (pin: string) => {
    const send = Boolean(pinSet?.send);
    setPinSet({ checking: true, send });
    const ok = await goToNewRoom({ pin, replace: true, ...(send ? { sendLink: true } : { openInvite: true }) });
    if (!ok) {
      setPinSet(null);
      failMint();
    }
  };
  // The host's one tap after PIN warnings: a new link (same PIN if this device chose it).
  const moveToNewLink = async () => {
    if (moving) return;
    setMoving(true);
    const ok = await goToNewRoom({ pin: passes.pin(roomId) ?? undefined, openInvite: true });
    setMoving(false);
    if (!ok) failMint();
  };
  const submitPin = (pin: string) => {
    setPinGate({ checking: true, error: null });
    if (joinReady) return enterPinRef.current(pin);
    firstPinRef.current = pin;
    setJoinReady(true);
  };
  // The result screen's "친구 초대" can run in the public room too: there it hands out the
  // maker link ("나도 만들어 보기"), not the busy public room.
  const inviteUrl = () => (code ? friendLink(location.origin, slug, params, code) : makerLink(location.origin));
  // #209: the share sheet on touch phones / tablets only; on a computer the link is copied
  // (+ "show the QR" for phones nearby); no clipboard → the QR sheet with the link selected.
  const [qrManual, setQrManual] = useState(false);
  const [copiedText, setCopiedText] = useState<string[]>([]);
  const shareInvite = async () => {
    const url = inviteUrl();
    const what = code ? "invite" : "app"; // the public room hands out the maker link
    const env = browserHandOutEnv();
    const out = await handOutLink(url, env);
    if (out === "cancelled") return; // the person closed the sheet: nothing happened
    if (out === "shared") return trackShare("web", what, slug);
    if (out === "copied") {
      trackShare("copy", what, slug);
      setCopiedText(copiedLines({ touch: env.touch, pin: code ? passes.pin(roomId) : null }));
      setInvite("copied");
      setTimeout(() => setInvite((s) => (s === "copied" ? null : s)), env.touch ? 2500 : 4000);
      return;
    }
    trackShare("other", what, slug);
    setQrManual(true);
    setQrOpen(true); // the link, selected, to copy by hand (kept until 닫기)
  };
  // Result screen of a template with a result view (나 맞히기 퀴즈): view, image,
  // reaction question and the result buttons' taps (ResultExtras.tsx).
  // Every invite button goes through here (#217): the first one in a friends room may ask
  // "비밀번호를 걸까요?" first (decided at render: requestInviteRef).
  const requestInviteRef = useRef<() => void>(() => void shareInvite());
  const requestInvite = () => requestInviteRef.current();
  const [inviteAsk, setInviteAsk] = useState(false);
  // "비밀번호 걸고 보내기" landed here: one tap on "링크 보내기" shares it (a fresh user gesture, iOS).
  const [sendReady, setSendReady] = useState(() => sendOnOpen.delete(roomId));
  // The room-type chip (#143): the "친구방에서 나갈까요?" sheet.
  const [leaveAsk, setLeaveAsk] = useState(false);
  const extras = useResultExtras({ doc, slug, params, onInvite: requestInvite });
  const inResult = extras.inResult;

  if (roomParam.kind === "invalid") {
    return (
      <MessageScreen icon="🔗" title="초대 링크가 잘못됐어요" body="링크를 다시 받아 주세요. 방 코드가 잘리거나 바뀐 것 같아요." withHome
        primary={{ label: "공개 방에서 하기", onClick: () => navigate(publicLink(slug, params)) }} />
    );
  }
  if (err === "notFound") {
    return <MessageScreen icon="🔍" title="앱을 찾을 수 없어요" body="링크가 잘못됐거나 더 이상 없는 앱이에요." primary={{ label: "홈으로", onClick: goHome }} />;
  }
  if (err === "network") {
    return (
      <MessageScreen icon="📡" title="연결이 불안정해요" body="인터넷 연결을 확인하고 다시 시도해 주세요." withHome
        primary={{ label: "다시 시도", onClick: () => setLoadGen((g) => g + 1) }} />
    );
  }
  if (!doc) {
    // A PIN room asks right away; the app keeps loading behind the PIN screen.
    if (pinGate) return <PinSheet mode="enter" checking={pinGate.checking} error={pinGate.error} onSubmit={submitPin} solo={soloBtn} />;
    return <LoadingScreen />;
  }
  // What happened to the invite link (only what really happened is said).
  const inviteFeedback = (
    <>
      <Toast shown={invite === "copied"} style={{ ...inviteNote, flexDirection: "column", alignItems: "flex-start", gap: 2, wordBreak: "keep-all" }} role="status" data-testid="invite-copied">
        {copiedText.map((l, i) => <span key={i} style={i ? { color: C.inkMuted, fontSize: TOKENS.size.bodySm } : undefined}>{l}</span>)}
      </Toast>
      <Toast shown={mintFail} style={inviteNote} role="status">방을 만들지 못했어요. 잠시 후 다시 눌러 주세요</Toast>
    </>
  );
  // Quiz lobby (friends-only room): the template owns every word of the lobby;
  // the shell adds only the invite button, in the band the template leaves
  // empty for it (y 758–810 of the 390×844 frame). Big while only one person is
  // in (by the room's roster), small once friends are there.
  // Never on the result screen, even if the room's phase reached the template first: its buttons own that band (#94).
  const quizInvite = isQuiz && withRoom && conn === "connected" && phase === "lobby" && !inResult && Boolean(code) && area[0] > 0;
  // Placed through the canvas fit, so on a short phone it stays in the template's band, off 시작하기 (#94).
  const band = quizInviteBandRect(area[0], area[1], doc.frame ?? [390, 844]);
  const alone = roster.length <= 1;
  const people = isQuiz && roster.length ? roster.length : participants;
  // A quiz that did not reach the room is said in the lobby / result only — never over a question being played.
  const showPackFail = Boolean(packFail) && (phase === "lobby" || phase === "result");
  // "이름 정하기" (#104): a guest name in a connected room's lobby, until kept or changed. It
  // steps aside while something else holds the top of the screen.
  const nameCard = showNameCard({
    auto: nickAuto, chosen: nameChosen, live: withRoom && conn === "connected", phase: spectator.phase,
    covered: makerOpen || Boolean(lastResult) || inResult || Boolean(invite) || qrOpen || showPackFail || Boolean(pinGate) || Boolean(pinSet) || Boolean(hostPin) || mintFail || inviteAsk || sendReady || leaveAsk || Boolean(schedSheet),
  });
  // "비밀번호 걸기" only while nobody else is in (a PIN means a new link, owner decision #157).
  const canSetPin = canOfferPin({ edge: Boolean(EDGE_ROOM_SERVER), code: Boolean(code), connected: conn === "connected", people });
  const openPinSet = () => { setQrOpen(false); setQrManual(false); setPinSet({ checking: false }); };
  const hostPinValue = code ? passes.pin(roomId) : null;
  const invitePin = EDGE_ROOM_SERVER && code ? { value: hostPinValue, canSet: canSetPin, onSet: openPinSet } : undefined;
  // #217: the first invite in a friends room asks "비밀번호를 걸까요?" (alone, no PIN yet, not asked
  // here before). A PIN room this device only joined (no PIN known here) counts as having one.
  const askPin = askPinFirst({
    edge: Boolean(EDGE_ROOM_SERVER), code: Boolean(code), connected: conn === "connected", people,
    pin: hostPinValue || (pinRoom ? "set" : null), asked: pinAsked.has(roomId),
  });
  requestInviteRef.current = () => (askPin ? setInviteAsk(true) : void shareInvite());
  // #143: the room-type chip — lobby and result only; not in the 나 맞히기 quiz (always a friends room).
  const kind = roomKind(code);
  const chip = roomChip(kind);
  const chipShown = !isQuiz && showRoomChip({ withRoom, failed: conn === "failed", phase: spectator.phase, inResult });
  const toPublicRoom = () => navigate(publicLink(slug, params));
  const onChip = () => {
    const a = chipAction(kind, people);
    if (a === "mint") void openFriendRoom();
    else if (a === "leave") toPublicRoom();
    else setLeaveAsk(true);
  };
  const rowNarrow = typeof innerWidth === "number" && innerWidth < TOP_ROW_FULL_W;
  const leaveCopy = leaveFriendsCopy(Boolean(EDGE_ROOM_SERVER && doc.room));
  return (
    <>
      <BitePlayer doc={doc} onHostEvent={withRoom ? onHostEvent : undefined} onReady={onReady} onArea={(w, h) => setArea([w, h])} />
      <HomeButton />
      {withRoom && conn !== "failed" && <RoomChip state={conn} people={people} reconnecting={reconnecting && reconnectNotice} kind={EDGE_ROOM_SERVER ? kind : "public"} />}
      {quizInvite && (
        <div style={{ ...quizInviteBand, top: `calc(var(--snack-safe-top) + ${band.y}px)`, left: band.x, width: band.w, height: band.h }}>
          <button className="blk" style={alone ? { ...primaryBtn, padding: 0, height: band.h, flex: 1, minWidth: 0 } : { ...pill, height: band.h }}
            onClick={requestInvite} aria-label="친구 초대 링크 보내기">
            {alone ? "🔗 친구 초대하기" : "🔗 친구 더 부르기"}
          </button>
          <QrButton style={{ height: band.h, minWidth: band.h }} onClick={() => setQrOpen(true)} />
        </div>
      )}
      {/* Quiz notices (top, under the home row): the invite result while the
          lobby's bottom band holds the button, and a quiz that did not reach the room. */}
      {isQuiz && withRoom && conn === "connected" && ((quizInvite && (invite || mintFail)) || showPackFail) && (
        <div style={topDock}>
          {quizInvite && inviteFeedback}
          {showPackFail && (
            <div style={{ ...inviteNote, flexDirection: "column", alignItems: "stretch", gap: S.s2 }} role="alert">
              <span>{packFail}</span>
              <div style={{ display: "flex", gap: S.s2 }}>
                <button className="blk" style={{ ...secondaryBtn, padding: S.s2 }} onClick={retryPack}>다시 보내기</button>
                <button className="blk" style={{ ...secondaryBtn, padding: S.s2 }} onClick={() => setMakerOpen(true)}>다시 만들기</button>
              </div>
            </div>
          )}
        </div>
      )}
      {/* The top row, right of 홈 (#143): the room-type chip "🌐 공개방" / "🤝 친구방" (lobby and
          result only; a tap switches), then in a friends room 🔗 초대 + QR. The quiz lobby's band
          has its own invite. On the result screen the template's own "친구 초대" replaces the
          pill (MP-09) and only QR stays. QR once connected: the wide "방에 들어가는 중" chip needs
          the room on a 360 px screen. The bottom corners belong to the templates' buttons. */}
      {withRoom && conn !== "failed" && (
        <div style={inviteDockTop}>
          {!inResult && !quizInvite && inviteFeedback}
          <div style={{ display: "flex", gap: 4 }}>
            {chipShown && <RoomTypeChip icon={chip.icon} label={chip.label} aria={chip.aria} busy={minting} onClick={onChip} />}
            {!inResult && !quizInvite && code && (
              // Under ~380 px with the chip there, the 🔗 alone (the people chip keeps its room at 10명+).
              <button className="blk" style={{ ...pill, padding: "0 10px", minWidth: 44, justifyContent: "center" }} onClick={requestInvite} aria-label="친구 초대 링크 보내기">
                {chipShown && rowNarrow ? "🔗" : chipShown ? "🔗 초대" : "🔗 친구 초대"}
              </button>
            )}
            {(inResult || (!quizInvite && code && conn === "connected")) && <QrButton style={{ padding: "0 10px" }} onClick={() => setQrOpen(true)} />}
          </div>
        </div>
      )}
      {withRoom && conn !== "failed" && inResult && <div style={resultNoteDock}>{inviteFeedback}</div>}
      {nameCard && <NameCard nick={getNick() ?? meRef.current?.nick ?? ""} onKeep={keepName} onChange={changeName} />}
      {schedSheet && withRoom && conn === "connected" && spectator.phase !== "countdown" && spectator.phase !== "play" && (
        <ScheduleSheet
          current={sched.startAt > Date.now() ? { startAt: sched.startAt, startAtText: sched.startAtText } : null}
          busy={schedSheet.busy} error={schedSheet.error} testSec={scheduleTestSec()}
          onPick={(ms) => {
            setSchedSheet({ busy: true, error: null });
            // the app's own start payload (its template's `room.start` — the lobby button's)
            roomRef.current?.sendAction("schedule", { in: Math.round(ms), start: doc.room?.start ?? {} });
          }}
          onCancel={() => {
            setSchedSheet({ busy: true, error: null });
            roomRef.current?.sendAction("unschedule");
          }}
          onClose={() => setSchedSheet(null)} />
      )}
      {makerOpen && (
        <Suspense fallback={<LoadingScreen />}>
          <QuizMaker nick={getNick() ?? ""} nickAuto={isNickAuto()} doneLabel="완료 · 이 방에서 하기" closeLabel="✕ 닫기"
            note="다 만들면 이 방의 다음 판이 내 퀴즈로 바뀌어요."
            onClose={() => setMakerOpen(false)} onDone={finishMaker} />
        </Suspense>
      )}
      {withRoom && conn === "failed" && !pinGate && (
        <RoomFailedSheet key={`${connReason}:${connRetryIn ?? ""}`} reason={connReason} retryIn={connRetryIn} onRetry={() => retryRef.current()} solo={soloBtn} onPublic={toPublicRoom} />
      )}
      {withRoom && conn === "connected" && hostPin && (
        <HostPinNotice kind={hostPin} busy={moving} onMove={() => void moveToNewLink()} onClose={hostPin === "alert" ? () => setHostPin(null) : undefined} />
      )}
      {slowText && <RoomSlowNotice text={slowText} solo={soloBtn} />}
      {withRoom && conn === "connected" && showSpectatorNotice(doc, spectator.me, spectator.phase) && (
        <div style={spectatorNotice} role="status">{SPECTATOR_NOTICE_TEXT}</div>
      )}
      <ReactionLayer handle={fxRef} />
      {extras.overlay}
      {leaveAsk && chipShown && (
        <ChoiceSheet title={leaveCopy.title} body={leaveCopy.body} testId="leave-friends"
          primary={{ label: leaveCopy.go, onClick: () => { setLeaveAsk(false); toPublicRoom(); } }}
          secondary={{ label: leaveCopy.stay, onClick: () => setLeaveAsk(false) }} onClose={() => setLeaveAsk(false)} />
      )}
      {inviteAsk && (
        <ChoiceSheet title={INVITE_PIN_ASK.title} body={INVITE_PIN_ASK.body} testId="invite-ask"
          primary={{ label: INVITE_PIN_ASK.send, onClick: () => { pinAsked.add(roomId); setInviteAsk(false); void shareInvite(); } }}
          secondary={{ label: INVITE_PIN_ASK.withPin, onClick: () => { setInviteAsk(false); setPinSet({ checking: false, send: true }); } }}
          onClose={() => setInviteAsk(false)} />
      )}
      {sendReady && !pinGate && (
        <ChoiceSheet title="비밀번호를 걸었어요" testId="invite-send"
          body={hostPinValue ? `비밀번호 ${hostPinValue} · 링크를 보낼 때 함께 알려 주세요.` : "링크를 보낼 때 비밀번호도 함께 알려 주세요."}
          primary={{ label: "🔗 링크 보내기", onClick: () => { setSendReady(false); void shareInvite(); } }}
          secondary={{ label: "나중에", onClick: () => setSendReady(false) }} onClose={() => setSendReady(false)} />
      )}
      {qrOpen && <InviteQrSheet url={inviteUrl()} pin={invitePin} manual={qrManual} onClose={() => { setQrOpen(false); setQrManual(false); }} onCopied={() => trackShare("copy", code ? "invite" : "app", slug)} />}
      {lastResult && (
        <Suspense fallback={null}>
          <LastResult saved={lastResult} slug={slug} myNick={getNick()} onAgain={() => setLastResult(null)} />
        </Suspense>
      )}
      {pinGate && <PinSheet mode="enter" checking={pinGate.checking} error={pinGate.error} onSubmit={submitPin} solo={soloBtn} />}
      {pinSet && <PinSheet mode="set" checking={pinSet.checking} onSubmit={(p) => void submitPinSet(p)} onCancel={() => setPinSet(null)} />}
      {/* Reactions are a "someone else is watching" feature, so the button only
          appears once another person is in the room. Solo play never shows it,
          so it can't cover the app's own bottom content. */}
      {withRoom && conn === "connected" && participants > 1 && (
        <div style={reactionDockTop}>
          {reactOpen && (
            <div style={reactionPop}>
              {REACTIONS.map((e) => (
                <button key={e} style={reactionBtn}
                  onClick={() => { sendReaction(e); setReactOpen(false); }}>{e}</button>
              ))}
            </div>
          )}
          <button style={reactionFab} onClick={() => setReactOpen((o) => !o)} aria-label={reactOpen ? "이모지 반응 닫기" : "이모지 반응 보내기"}>
            {reactOpen ? "✕" : "😀"}
          </button>
        </div>
      )}
    </>
  );
}

const REACTIONS = ["❤️", "🔥", "😂", "👍", "😮"];

// Bottom-left, mirroring the reaction dock; the note sits above the pill.
const inviteDock: React.CSSProperties = {
  position: "fixed", left: 10, bottom: "calc(var(--snack-safe-bottom) + 10px)", maxWidth: "70vw",
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, zIndex: 13,
};
// Top row, between 홈 (left, 12–70) and the people chip (right): never over a template's
// bottom buttons. Column-reverse keeps the pills on the row and notes under it.
// #143: 🌐 공개방 / 🤝 친구방 · 🔗 초대 · QR, 76–273 at 390 px; under TOP_ROW_FULL_W the 🔗 drops its
// word (76–251) so "👥 10명" still fits at 360 (room-rules-e2e measures both).
const TOP_ROW_FULL_W = 380;
const inviteDockTop: React.CSSProperties = {
  position: "fixed", top: "calc(var(--snack-safe-top) + 10px)", left: 76, maxWidth: "calc(100vw - 160px)",
  display: "flex", flexDirection: "column-reverse", alignItems: "flex-start", gap: 8, zIndex: 13,
};
const inviteNote: React.CSSProperties = {
  ...pill, minHeight: 0, padding: "8px 12px", whiteSpace: "normal", wordBreak: "break-all", fontWeight: 600, alignItems: "flex-start",
};
// The quiz lobby's invite band: the template leaves y 758–810 × x 16–374 of its
// 390×844 frame empty for it; its place on screen is that box through the
// canvas fit (canvasFit.ts quizInviteBandRect), never a fixed CSS offset (#94).
// The big button fills it; the small one sits at its left.
const quizInviteBand: React.CSSProperties = {
  position: "fixed", display: "flex", justifyContent: "flex-start", gap: 8, zIndex: 13,
};
// Notices over the top of the play area, under the home / people row.
const topDock: React.CSSProperties = {
  position: "fixed", top: "calc(var(--snack-safe-top) + 66px)", left: 16, right: 16, maxWidth: 488, margin: "0 auto",
  display: "flex", flexDirection: "column", gap: 8, zIndex: 15,
};
// Tucked into the very corner so it covers as little bottom content as possible.
const reactionDock: React.CSSProperties = {
  position: "fixed", right: 10, bottom: "calc(var(--snack-safe-bottom) + 10px)",
  display: "flex", flexDirection: "column", alignItems: "center", gap: 8, zIndex: 13,
};
// Every screen (MP-09): the bottom corners belong to the templates' buttons, so the
// reaction button sits under the people chip and its emoji list opens downward;
// on the result screen the invite note moves to the top as well.
const reactionDockTop: React.CSSProperties = {
  ...reactionDock, bottom: undefined, top: "calc(var(--snack-safe-top) + 62px)", right: 12, flexDirection: "column-reverse",
};
const resultNoteDock: React.CSSProperties = {
  ...inviteDock, bottom: undefined, top: "calc(var(--snack-safe-top) + 64px)", left: 12, right: 70, maxWidth: undefined,
};
// Over the templates' subtitle line, clear of the top-row pills and 😀 / 🪲 (spectate.ts, shellDocks.test.ts).
const spectatorNotice: React.CSSProperties = {
  ...pill, position: "fixed", top: `calc(var(--snack-safe-top) + ${SPECTATOR_NOTICE_BOX.y}px)`, left: SPECTATOR_NOTICE_BOX.x,
  maxWidth: SPECTATOR_NOTICE_BOX.w, minHeight: 0, height: SPECTATOR_NOTICE_BOX.h, padding: "0 10px", boxShadow: "none",
  font: `700 13px ${TOKENS.font.body}`, color: C.accent, pointerEvents: "none", zIndex: 13, overflow: "hidden", textOverflow: "ellipsis",
};
const reactionPop: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8, padding: 6,
  background: C.surface, border: `2px solid ${C.borderBlock}`, borderRadius: R.block,
};
const reactionFab: React.CSSProperties = {
  width: 46, height: 46, borderRadius: R.block, border: `2px solid ${C.borderBlock}`, cursor: "pointer",
  background: C.surface, color: C.ink, fontSize: 20, lineHeight: "42px", padding: 0, boxShadow: "0 4px 0 #000000",
};
const reactionBtn: React.CSSProperties = {
  width: 44, height: 44, borderRadius: R.block, border: "none", cursor: "pointer",
  background: C.surface2, fontSize: 22, lineHeight: "44px", padding: 0,
};
