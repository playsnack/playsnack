import { useEffect, useRef, useState } from "react";
import type { BiteDoc } from "@snack/bite";
// Pixi loads its browser environment and WebGL renderer lazily, which on a play
// link costs two more round trips after the app code (~1.4 s on Fast 3G).
// Importing them here puts them in the same download as the player.
import "pixi.js/browser";
import { WebGLRenderer } from "pixi.js";
import { BitePlayer } from "./BitePlayer.tsx";
import { getAnonId, getNick } from "./identity";
import type { ConnState, RoomTransport } from "./roomTransport";
import { createRoom, hrefTo, loadRoomDoc, navigate } from "./backend";
import { friendLink, newRoomCode, playPath, publicLink, roomIdFor, roomParamOf } from "./links";
import { needsRoom, soloAlternative, type CatalogEntry } from "./catalog";
import { HomeButton, LoadingScreen, MessageScreen, RoomChip, RoomFailedSheet, goHome } from "./Screens";
import { pill } from "./ui";
import { C, R } from "./tokens.gen";
import { joinTracker } from "./roomJoin";

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
        join.conn(state, m.d.reason as string | undefined);
        setConn(state);
        if (state === "connecting") waitForRoom();
        else clearTimeout(silence);
        return;
      }
      heard(); // any room traffic means we're in
      if (m.t === "state") {
        sharedRef.current = m.d.sharedState as Record<string, unknown>;
        applyShared(sharedRef.current);
        if (typeof m.d.participants === "number") setParticipants(m.d.participants);
      } else if (m.t === "setVar") {
        runtimeRef.current?.setVar(m.d.id as string, m.d.value);
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

  const onReady = (rt: Runtime | undefined) => {
    if (!rt) return;
    runtimeRef.current = rt;
    applyShared(sharedRef.current); // seed from cold-load / latest authoritative state
    try {
      performance.mark("snack:first-scene");
    } catch {}
  };

  const onHostEvent = (e: { name: string; payload?: unknown }) => roomRef.current?.sendAction(e.name, e.payload);

  // Friends-only room: the link carries a room code (?room=…). Without one,
  // the pill makes a code and moves this player into that room (no reload);
  // with one, it hands the link out — share sheet, else clipboard, else shown
  // to copy by hand (kept until dismissed). Only what really happened is
  // reported. A present-but-invalid code never falls back to the public room.
  const code = roomParam.kind === "code" ? roomParam.code : null;
  const [invite, setInvite] = useState<"copied" | "show" | null>(null);
  const openFriendRoom = () => {
    const p = new URLSearchParams(params);
    p.set("room", newRoomCode());
    navigate(playPath(slug, p));
  };
  const shareInvite = async () => {
    const url = friendLink(location.origin, slug, params, code!);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url });
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return; // the person closed the sheet: nothing happened
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setInvite("copied");
      setTimeout(() => setInvite((s) => (s === "copied" ? null : s)), 2500);
    } catch {
      setInvite("show"); // stays until ✕ — a long link needs time to long-press
    }
  };

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
  return (
    <>
      <BitePlayer doc={doc} onHostEvent={withRoom ? onHostEvent : undefined} onReady={onReady} />
      <HomeButton />
      {withRoom && conn !== "failed" && <RoomChip state={conn} people={participants} />}
      {/* Friends-only room pill (top row, right of 홈): "친구끼리" opens a new coded room
          (an unlisted link — friends who have it meet there); in a coded room it
          hands the invite link out. The bottom corners belong to the templates' buttons (MP-09). */}
      {withRoom && conn !== "failed" && (
        <div style={inviteDock}>
          {invite === "copied" && <div style={inviteNote} role="status">초대 링크를 복사했어요</div>}
          {invite === "show" && code && (
            <div style={inviteNote} role="status">
              <span style={{ userSelect: "all", wordBreak: "break-all" }}>{friendLink(location.origin, slug, params, code)}</span>
              <button style={closeBtn} onClick={() => setInvite(null)} aria-label="닫기">✕</button>
            </div>
          )}
          {code
            ? <button className="blk" style={pill} onClick={() => void shareInvite()} aria-label="친구 초대 링크 보내기">🔗 친구 초대</button>
            : <button className="blk" style={pill} onClick={openFriendRoom} aria-label="친구끼리 하는 방 만들기">🤝 친구끼리</button>}
        </div>
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
      {/* Reactions are a "someone else is watching" feature, so the button only
          appears once another person is in the room. Solo play never shows it,
          so it can't cover the app's own bottom content. */}
      {withRoom && conn === "connected" && participants > 1 && (
        <div style={reactionDock}>
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
// Top row, between 홈 (left) and the people chip (right): never over a template's
// bottom buttons (MP-09). Column-reverse keeps the pill on the row and notes under it.
const inviteDock: React.CSSProperties = {
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
// Under the people chip on every screen (MP-09): the bottom corners belong to the
// templates' buttons. The emoji list opens downward.
const reactionDock: React.CSSProperties = {
  position: "fixed", right: 12, top: "calc(var(--snack-safe-top) + 62px)",
  display: "flex", flexDirection: "column-reverse", alignItems: "center", gap: 8, zIndex: 13,
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
