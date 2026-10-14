import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { BiteDoc } from "@snack/bite";
// Pixi loads its browser environment and WebGL renderer lazily, which on a play
// link costs two more round trips after the app code (~1.4 s on Fast 3G).
// Importing them here puts them in the same download as the player.
import "pixi.js/browser";
import { WebGLRenderer } from "pixi.js";
import { BitePlayer } from "./BitePlayer.tsx";
import { getAnonId, getNick, isNickAuto } from "./identity";
import type { ConnState, RoomTransport } from "./roomTransport";
import { createRoom, hrefTo, loadRoomDoc, markFreshRoom, navigate } from "./backend";
import { friendLink, newRoomCode, playPath, publicLink, roomCodeOf, roomIdFor, roomParamOf, shareableParams } from "./links";
import { needsRoom, soloAlternative, type CatalogEntry } from "./catalog";
import { HomeButton, LoadingScreen, MessageScreen, RoomChip, RoomFailedSheet, goHome } from "./Screens";
import { pill, primaryBtn, secondaryBtn } from "./ui";
import { C, R, S, TOKENS, blockShadow } from "./tokens.gen";
import { joinTracker } from "./roomJoin";
import { trackRoomCreate, trackShare } from "./telemetry";
import {
  MAKE_EVENT, MAKE_HOST_EVENT, MAKE_PARAM, PACK_REFUSALS, QUIZ_SLUG, deviceQuizStore, openQuizMaker, packAction, packFailureMessage, packPending,
  type QuizInfo, type QuizPack, type RoomEntry,
} from "./quiz";
// The maker is loaded only when opened (play links do not pay for it).
const QuizMaker = lazy(() => import("./QuizMaker.tsx").then((m) => ({ default: m.QuizMaker })));
import { makerLink, resultHooks, useResultExtras } from "./ResultExtras";
import { InviteQrSheet, QrButton } from "./InviteQr";

// "나도 만들기" on the quiz result screen opens the maker over this room (lane B).
resultHooks.makeQuiz = () => openQuizMaker();

// Plays one app from a link. Solo apps just play. Together apps (or any app
// that sends events to a room, or a link that names a room) also join a room
// through a RoomTransport: Bite `emit` → room action, room `setVar` broadcasts
// → the runtime, so everyone sees the same shared state.
type Runtime = { setVar: (id: string, v: unknown) => void };

// A real use, so the bundler keeps the renderer here (an unused import is dropped).
Object.assign(globalThis, { __snackWebGLRenderer: WebGLRenderer });

/** A room that stays silent this long counts as failed (nothing may hang). */
const ROOM_SILENCE_MS = 15_000;

type LoadError = "notFound" | "network";
const isNetworkError = (e: unknown) =>
  (typeof navigator !== "undefined" && navigator.onLine === false) ||
  (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));

export function LiveApp({ slug, params }: { slug: string; params: URLSearchParams }) {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState<LoadError | null>(null);
  const [loadGen, setLoadGen] = useState(0);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [roomGen, setRoomGen] = useState(0);
  const [participants, setParticipants] = useState(1);
  const [solo, setSolo] = useState<CatalogEntry | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const roomRef = useRef<RoomTransport | null>(null);
  const sharedRef = useRef<Record<string, unknown> | null>(null);
  const fxRef = useRef<HTMLDivElement | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const [reactOpen, setReactOpen] = useState(false);
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
  const quizRef = useRef({ phase: "lobby", info: null as QuizInfo | null, iAmSubject: undefined as boolean | undefined, lastSentAt: 0, live: false });
  const withRoom = doc ? needsRoom(doc, params) : false;
  // A present-but-invalid ?room= (a code cut by a chat app) must never land in
  // the public room: nothing loads or joins, the screen says the link is bad.
  const roomParam = roomParamOf(params);
  const invalidRoom = roomParam.kind === "invalid";

  // Floating emoji reaction that rises and fades (DOM overlay above the canvas).
  const spawnReaction = (emoji: string) => {
    const c = fxRef.current;
    if (!c || !emoji) return;
    const el = document.createElement("div");
    el.textContent = emoji;
    el.style.cssText = `position:absolute;bottom:96px;left:${20 + Math.random() * 60}%;font-size:34px;will-change:transform,opacity;`;
    c.appendChild(el);
    el.animate(
      [{ transform: "translateY(0) scale(1)", opacity: 1 },
       { transform: `translateY(-${180 + Math.random() * 130}px) scale(1.35)`, opacity: 0 }],
      { duration: 1600 + Math.random() * 500, easing: "ease-out" },
    ).onfinish = () => el.remove();
  };
  const sendReaction = (emoji: string) => {
    roomRef.current?.sendReaction(emoji);
    spawnReaction(emoji); // optimistic local
  };

  const applyShared = (shared: Record<string, unknown> | null | undefined) => {
    const rt = runtimeRef.current;
    if (!rt || !shared) return;
    for (const [k, v] of Object.entries(shared)) rt.setVar(k, v);
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
    if (!doc || !withRoom || invalidRoom) return;
    // The room id is the link's: the app's public room, or `slug~CODE` for a
    // friends-only link (links.ts). The transport passes it through unchanged.
    const room: RoomTransport = createRoom({ slug: roomIdFor(slug, params), anonId: getAnonId(), nick: getNick() ?? "" }, params);
    roomRef.current = room;
    const join = joinTracker({ slug, room: roomIdFor(slug, params) }); // room_join telemetry + ?debug=1 log
    let silence: ReturnType<typeof setTimeout> | undefined;
    const waitForRoom = () => {
      clearTimeout(silence);
      silence = setTimeout(() => { join.conn("failed", "silence"); setConn((s) => (s === "connecting" ? "failed" : s)); }, ROOM_SILENCE_MS);
    };
    const heard = () => {
      clearTimeout(silence);
      join.conn("connected");
      setConn((s) => (s === "connecting" ? "connected" : s));
    };
    room.onMessage((m) => {
      if (m.t === "conn") {
        const state = m.d.state as ConnState;
        quizRef.current.live = state === "connected"; // a pack sent before this is dropped (and burns a resend gap)
        join.conn(state, m.d.reason as string | undefined);
        setConn(state);
        if (state === "connecting") waitForRoom();
        else clearTimeout(silence);
        return;
      }
      heard(); // any room traffic means we're in
      if (m.t === "state") {
        quizRef.current.live = true;
        sharedRef.current = m.d.sharedState as Record<string, unknown>;
        applyShared(sharedRef.current);
        if (typeof m.d.participants === "number") setParticipants(m.d.participants);
        const sh = sharedRef.current ?? {};
        // A (re)join: the room sends this player's iAmSubject right after the state.
        quizRef.current.iAmSubject = undefined;
        // A new room has no sessionPhase yet (the room sets it on its first phase change): it is in the lobby.
        onQuizVar("sessionPhase", sh.sessionPhase ?? "lobby");
        onQuizVar("roster", sh.roster ?? []);
        onQuizVar("quizInfo", sh.quizInfo ?? null);
      } else if (m.t === "setVar") {
        runtimeRef.current?.setVar(m.d.id as string, m.d.value);
        onQuizVar(m.d.id as string, m.d.value);
      } else if (m.t === "actionAck") {
        // Only quizPack is refused this way ("not_in_lobby" = sent mid-game: packAction waits for the result).
        if (m.d.accepted === false && PACK_REFUSALS.has(m.d.reason as string)) onPackRefused(m.d.reason as string);
      } else if (m.t === "participants") {
        setParticipants(m.d.count as number);
      } else if (m.t === "reaction") {
        spawnReaction(m.d.emoji as string);
      }
    });
    setConn("connecting");
    waitForRoom();
    join.start("connect");
    room.connect();
    // retry() (when the transport has it) restarts the same connection.
    retryRef.current = room.retry
      ? () => { setConn("connecting"); waitForRoom(); join.start("retry"); room.retry!(); }
      : () => setRoomGen((g) => g + 1);
    return () => {
      clearTimeout(silence);
      join.end();
      room.close();
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [doc, slug, withRoom, roomGen]);

  // The closest one-person app, offered if the room can't be joined.
  useEffect(() => {
    if (conn === "failed") soloAlternative(slug).then(setSolo);
  }, [conn, slug]);

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

  const onReady = (rt: Runtime | undefined) => {
    if (!rt) return;
    runtimeRef.current = rt;
    applyShared(sharedRef.current); // seed from cold-load / latest authoritative state
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
    roomRef.current?.sendAction(e.name, e.payload);
  };

  // Friends-only room: the link carries a room code (?room=…). Without one,
  // the pill makes a code and moves this player into that room (no reload);
  // with one, it hands the link out — share sheet, else clipboard, else shown
  // to copy by hand (kept until dismissed). Only what really happened is
  // reported. A present-but-invalid code never falls back to the public room.
  const code = roomParam.kind === "code" ? roomParam.code : null;
  const [invite, setInvite] = useState<"copied" | "show" | null>(null);
  const [qrOpen, setQrOpen] = useState(false); // the same link as a QR, for friends right here
  const openFriendRoom = () => {
    const p = shareableParams(params);
    p.set("room", newRoomCode());
    trackRoomCreate(slug); // the code itself is never sent
    markFreshRoom(roomIdFor(slug, p));
    navigate(playPath(slug, p));
  };
  // The result screen's "친구 초대" can run in the public room too: there it hands out the
  // maker link ("나도 만들어 보기"), not the busy public room.
  const inviteUrl = () => (code ? friendLink(location.origin, slug, params, code) : makerLink(location.origin));
  const shareInvite = async () => {
    const url = inviteUrl();
    const what = code ? "invite" : "app"; // the public room hands out the maker link
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url });
        trackShare("web", what, slug);
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return; // the person closed the sheet: nothing happened
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      trackShare("copy", what, slug);
      setInvite("copied");
      setTimeout(() => setInvite((s) => (s === "copied" ? null : s)), 2500);
    } catch {
      trackShare("other", what, slug);
      setInvite("show"); // stays until ✕ — a long link needs time to long-press
    }
  };
  // Result screen of a template with a result view (나 맞히기 퀴즈): view, image,
  // reaction question and the result buttons' taps (ResultExtras.tsx).
  const extras = useResultExtras({ doc, slug, params, onInvite: () => void shareInvite() });
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
  if (!doc) return <LoadingScreen />;
  // What happened to the invite link (only what really happened is said).
  const inviteFeedback = (
    <>
      {invite === "copied" && <div style={inviteNote} role="status">초대 링크를 복사했어요</div>}
      {invite === "show" && (code || inResult) && (
        <div style={inviteNote} role="status">
          <span style={{ userSelect: "all", wordBreak: "break-all" }}>{inviteUrl()}</span>
          <button style={closeBtn} onClick={() => setInvite(null)} aria-label="닫기">✕</button>
        </div>
      )}
    </>
  );
  // Quiz lobby (friends-only room): the template owns every word of the lobby;
  // the shell adds only the invite button, in the band the template leaves
  // empty for it (y 758–810 of the 390×844 frame). Big while only one person is
  // in (by the room's roster), small once friends are there.
  const quizInvite = isQuiz && withRoom && conn === "connected" && phase === "lobby" && Boolean(code);
  const alone = roster.length <= 1;
  const people = isQuiz && roster.length ? roster.length : participants;
  // A quiz that did not reach the room is said in the lobby / result only — never over a question being played.
  const showPackFail = Boolean(packFail) && (phase === "lobby" || phase === "result");
  return (
    <>
      <BitePlayer doc={doc} onHostEvent={withRoom ? onHostEvent : undefined} onReady={onReady} />
      <HomeButton />
      {withRoom && conn !== "failed" && <RoomChip state={conn} people={people} />}
      {quizInvite && (
        <div style={quizInviteBand}>
          <button className="blk" style={alone ? { ...primaryBtn, padding: 0, height: 52, flex: 1 } : { ...pill, height: 52 }}
            onClick={() => void shareInvite()} aria-label="친구 초대 링크 보내기">
            {alone ? "🔗 친구 초대하기" : "🔗 친구 더 부르기"}
          </button>
          <QrButton style={{ height: 52, minWidth: 52 }} onClick={() => setQrOpen(true)} />
        </div>
      )}
      {/* Quiz notices (top, under the home row): the invite result while the
          lobby's bottom band holds the button, and a quiz that did not reach the room. */}
      {isQuiz && withRoom && conn === "connected" && ((quizInvite && invite) || showPackFail) && (
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
      {/* Friends-only room pill (top row, right of 홈): "친구끼리" opens a new coded
          room (an unlisted link — friends who have it meet there); in a coded room
          it hands the invite link out. In the quiz lobby the band button has it.
          The bottom corners belong to the templates' start / answer buttons (MP-09). */}
      {withRoom && conn !== "failed" && !quizInvite && (
        <div style={inResult ? resultNoteDock : inviteDockTop}>
          {inviteFeedback}
          {/* On the result screen its own "친구 초대" button replaces the pill (MP-09).
              QR once connected: the wide "방에 들어가는 중" chip needs the room on a 360 px screen. */}
          {inResult ? null : code
            ? <div style={{ display: "flex", gap: 6 }}><button className="blk" style={pill} onClick={() => void shareInvite()} aria-label="친구 초대 링크 보내기">🔗 친구 초대</button>{conn === "connected" && <QrButton onClick={() => setQrOpen(true)} />}</div>
            : <button className="blk" style={pill} onClick={openFriendRoom} aria-label="친구끼리 하는 방 만들기">🤝 친구끼리</button>}
        </div>
      )}
      {makerOpen && (
        <Suspense fallback={<LoadingScreen />}>
          <QuizMaker nick={getNick() ?? ""} nickAuto={isNickAuto()} doneLabel="완료 · 이 방에서 하기" closeLabel="✕ 닫기"
            note="다 만들면 이 방의 다음 판이 내 퀴즈로 바뀌어요."
            onClose={() => setMakerOpen(false)} onDone={finishMaker} />
        </Suspense>
      )}
      {withRoom && conn === "failed" && (
        <RoomFailedSheet
          onRetry={() => retryRef.current()}
          solo={solo
            ? { label: `혼자 하기 · ${solo.title}`, onClick: () => { location.href = hrefTo(`/p/tpl-${solo.id}`); } }
            : { label: "혼자 하는 게임 고르기", onClick: goHome }}
        />
      )}
      <div ref={fxRef} style={fxOverlay} />
      {extras.overlay}
      {/* The result screen's own "친구 초대" is the template's; its QR sits in the top row. */}
      {withRoom && conn !== "failed" && inResult && <div style={inviteDockTop}><QrButton onClick={() => setQrOpen(true)} /></div>}
      {qrOpen && <InviteQrSheet url={inviteUrl()} onClose={() => setQrOpen(false)} onCopied={() => trackShare("copy", code ? "invite" : "app", slug)} />}
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
          <button style={reactionFab} onClick={() => setReactOpen((o) => !o)} aria-label="반응 보내기">
            {reactOpen ? "✕" : "💬"}
          </button>
        </div>
      )}
    </>
  );
}

const REACTIONS = ["❤️", "🔥", "😂", "👍", "😮"];

const fxOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, pointerEvents: "none", zIndex: 12, overflow: "hidden",
};
// Bottom-left, mirroring the reaction dock; the note sits above the pill.
const inviteDock: React.CSSProperties = {
  position: "fixed", left: 10, bottom: "calc(var(--snack-safe-bottom) + 10px)", maxWidth: "70vw",
  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, zIndex: 13,
};
// Top row, between 홈 (left) and the people chip (right): never over a template's
// bottom buttons. Column-reverse keeps the pill on the row and notes under it.
const inviteDockTop: React.CSSProperties = {
  position: "fixed", top: "calc(var(--snack-safe-top) + 10px)", left: 84, maxWidth: "calc(100vw - 180px)",
  display: "flex", flexDirection: "column-reverse", alignItems: "flex-start", gap: 8, zIndex: 13,
};
const inviteNote: React.CSSProperties = {
  ...pill, minHeight: 0, padding: "8px 12px", whiteSpace: "normal", wordBreak: "break-all", fontWeight: 600, alignItems: "flex-start",
};
const closeBtn: React.CSSProperties = {
  flex: "none", width: 32, height: 32, margin: "-4px -6px -4px 0", padding: 0, border: "none", background: "transparent",
  color: C.ink, fontSize: 16, cursor: "pointer",
};
// The quiz lobby's invite band: the template leaves y 758–810 × x 16–374 of its
// 390×844 frame empty for it (34 px above the frame's bottom edge). The big
// button fills it; the small one sits at its left (the reaction button, shown
// once others are in, takes the bottom-right corner).
const quizInviteBand: React.CSSProperties = {
  position: "fixed", left: 16, right: 16, bottom: "calc(var(--snack-safe-bottom) + 34px)", maxWidth: 488, margin: "0 auto",
  display: "flex", justifyContent: "flex-start", gap: 8, zIndex: 13,
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
