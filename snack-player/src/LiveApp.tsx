import { useEffect, useRef, useState } from "react";
import type { BiteDoc } from "@snack/bite";
import { BitePlayer } from "./BitePlayer.tsx";
import { getAnonId, getNick } from "./identity";
import { RelayTransport, ServerTransport, type RoomTransport } from "./roomTransport";

// Realtime layer. Cold-loads the app from snack-server, joins its room through a
// RoomTransport, pipes Bite `emit` -> room action, and applies authoritative setVar broadcasts back
// into the runtime so every client sees live shared state (the moat).
// Dev (vite :5290): server is a sibling origin on :4399.
// Prod (player served BY snack-server): same origin, one port → one share link.
const SERVER = import.meta.env.DEV ? `${location.protocol}//${location.hostname}:4399` : location.origin;
const WS_URL = (import.meta.env.DEV
  ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:4399`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`) + "/ws";

// Host mode (?host=1): a player's device runs the room, the server only relays.
const RELAY_URL = WS_URL.replace(/\/ws$/, "/relay");
const HOST_MODE = new URLSearchParams(location.search).has("host");

type Runtime = { setVar: (id: string, v: unknown) => void };

export function LiveApp({ slug }: { slug: string }) {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [participants, setParticipants] = useState(1);
  const runtimeRef = useRef<Runtime | null>(null);
  const roomRef = useRef<RoomTransport | null>(null);
  const sharedRef = useRef<Record<string, unknown> | null>(null);
  const fxRef = useRef<HTMLDivElement | null>(null);
  const [reactOpen, setReactOpen] = useState(false);

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

  useEffect(() => {
    let closed = false;
    fetch(`${SERVER}/api/apps/${slug}`)
      .then((r) => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); })
      .then(({ doc, sharedState }) => {
        if (closed) return;
        sharedRef.current = sharedState;
        setDoc(doc);
      })
      .catch((e) => setErr(String(e)));
    return () => { closed = true; };
  }, [slug]);

  useEffect(() => {
    if (!doc) return;
    const me = { slug, anonId: getAnonId(), nick: getNick() ?? "" };
    const room: RoomTransport = HOST_MODE ? new RelayTransport(RELAY_URL, me, `${SERVER}/api/pack`, `${SERVER}/api/events`) : new ServerTransport(WS_URL, me);
    roomRef.current = room;
    room.onMessage((m) => {
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
    room.connect();
    return () => room.close();
  }, [doc, slug]);

  const onReady = (rt: Runtime | undefined) => {
    if (!rt) return;
    runtimeRef.current = rt;
    applyShared(sharedRef.current); // seed from cold-load / latest authoritative state
  };

  const onHostEvent = (e: { name: string; payload?: unknown }) => roomRef.current?.sendAction(e.name, e.payload);

  if (err) return <div style={msgStyle}>connect failed:\n{err}</div>;
  if (!doc) return <div style={msgStyle}>loading…</div>;
  return (
    <>
      <BitePlayer doc={doc} onHostEvent={onHostEvent} onReady={onReady} />
      <div style={overlayStyle}>👥 {participants}</div>
      <div ref={fxRef} style={fxOverlay} />
      {/* Reactions are a "someone else is watching" feature, so the FAB only
          appears once another person is in the room (participants > 1). Solo play
          — most snacks (gacha/worldcup/quiz…) — has NO FAB, so it never overlaps
          the snack's own bottom content (the recurring "FAB가 하단 도움말 가림" bug).
          In multiplayer it's small and tucked into the very corner. */}
      {participants > 1 && (
        <div style={reactionDock}>
          {reactOpen && (
            <div style={reactionPop}>
              {REACTIONS.map((e) => (
                <button key={e} style={reactionBtn}
                  onClick={() => { sendReaction(e); setReactOpen(false); }}>{e}</button>
              ))}
            </div>
          )}
          <button style={reactionFab} onClick={() => setReactOpen((o) => !o)} aria-label="reactions">
            {reactOpen ? "✕" : "💬"}
          </button>
        </div>
      )}
    </>
  );
}

const REACTIONS = ["❤️", "🔥", "😂", "👍", "😮"];

const msgStyle: React.CSSProperties = {
  color: "#D9FF00", padding: 16, font: "14px ui-monospace, monospace", whiteSpace: "pre-wrap",
};
const overlayStyle: React.CSSProperties = {
  position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 12px)", right: 14,
  background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: 999, padding: "6px 12px",
  font: "600 13px ui-monospace, monospace", pointerEvents: "none", zIndex: 10,
};
const fxOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, pointerEvents: "none", zIndex: 12, overflow: "hidden",
};
// Tucked into the very corner so it covers as little bottom content as possible
// (only shown in multiplayer — see the render guard).
const reactionDock: React.CSSProperties = {
  position: "fixed", right: 10, bottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
  display: "flex", flexDirection: "column", alignItems: "center", gap: 8, zIndex: 13,
};
const reactionPop: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8, padding: 8,
  background: "rgba(0,0,0,0.55)", borderRadius: 999, backdropFilter: "blur(8px)",
};
const reactionFab: React.CSSProperties = {
  width: 46, height: 46, borderRadius: "50%", border: "none", cursor: "pointer",
  background: "rgba(0,0,0,0.62)", color: "#fff", fontSize: 20, lineHeight: "46px", padding: 0,
  backdropFilter: "blur(8px)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
};
const reactionBtn: React.CSSProperties = {
  width: 44, height: 44, borderRadius: "50%", border: "none", cursor: "pointer",
  background: "rgba(255,255,255,0.08)", fontSize: 22, lineHeight: "44px", padding: 0,
};
