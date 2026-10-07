import { useEffect, useState } from "react";
import { BitePlayer } from "./BitePlayer.tsx";
import { validate, type BiteDoc } from "@snack/bite";
import { LiveApp } from "./LiveApp.tsx";
import { CreateApp } from "./CreateApp.tsx";
import { Discover } from "./Discover.tsx";
import { NicknameGate } from "./NicknameGate.tsx";
import { getNick, setNick as saveNick, randomNick } from "./identity";

// Routing (no router dep): ?bite=<name> -> Bite dev player
// (public/bite/<name>.bite.json); /create -> chat builder;
// /p/:slug -> realtime player; otherwise (/) -> Discover home.
export function App() {
  const isBite = new URLSearchParams(location.search).has("bite");
  const isLive = /^\/p\//.test(location.pathname);
  // First-visit nickname onboarding (per-browser). Gate only the HOME / Create
  // entry — a direct /p/ share link auto-assigns a guest nick so play is never
  // blocked (frictionless virality; each browser still gets a name, editable
  // later). The ?bite= dev player is exempt so tooling/screenshots are not blocked.
  const [nick, setNick] = useState<string | null>(() => {
    const n = getNick();
    if (n) return n;
    if (isLive) { const g = randomNick(); saveNick(g); return g; }
    return null;
  });
  if (!isBite && !isLive && !nick) return <NicknameGate onDone={setNick} />;

  if (isBite) return <BiteFilePlayer />;
  if (location.pathname.startsWith("/create")) return <CreateApp />;
  const liveMatch = location.pathname.match(/^\/p\/([^/]+)/);
  if (liveMatch) return <LiveApp slug={decodeURIComponent(liveMatch[1])} />;
  return <Discover />;
}

// Bite dev player: fetch public/bite/<name>.bite.json, validate, play locally.
function BiteFilePlayer() {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const name = new URLSearchParams(location.search).get("bite") || "reaction";
    // a bare name → public/bite/<name>.bite.json; anything with a slash is a URL
    const file = name.includes("/") ? name : `/bite/${name}.bite.json`;
    fetch(file)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} (${file})`);
        return r.json();
      })
      .then((d) => {
        const v = validate(d);
        for (const w of v.warnings) console.warn(`[bite] ${w.path}: ${w.message}`);
        if (!v.ok) throw new Error(v.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
        setDoc(d);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <pre style={errStyle}>{"bite load failed:\n" + err}</pre>;
  if (!doc) return <div style={loadingStyle}>loading…</div>;
  return <BitePlayer doc={doc} onHostEvent={(e) => console.log("[bite] emit", e)} />;
}

const errStyle: React.CSSProperties = {
  color: "#FF6B6B", padding: 16, font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap",
};
const loadingStyle: React.CSSProperties = {
  color: "#D9FF00", padding: 16, font: "14px ui-monospace, monospace",
};
