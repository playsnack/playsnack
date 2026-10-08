import { useEffect, useState } from "react";
import { currentRoute } from "./backend";
import { BitePlayer } from "./BitePlayer.tsx";
import { validate, type BiteDoc } from "@snack/bite";
import { LiveApp } from "./LiveApp.tsx";
import { CreateApp } from "./CreateApp.tsx";
import { Discover } from "./Discover.tsx";
import { NicknameGate } from "./NicknameGate.tsx";
import { getNick, setNick as saveNick, randomNick } from "./identity";

// Routing (no router dep, see backend.currentRoute): ?bite=<name> -> Bite dev
// player (public/bite/<name>.bite.json); #/create (or /create) -> builder;
// #/p/:slug (or /p/:slug) -> live player; otherwise -> Discover home.
export function App() {
  // Hash routes (#/p/…, #/create) change without a reload — re-render on change.
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const isLive = route.name === "live";
  // First-visit nickname onboarding (per-browser). Gate only the HOME / Create
  // entry — a direct share link auto-assigns a guest nick so play is never
  // blocked (frictionless virality; each browser still gets a name, editable
  // later). The ?bite= dev player is exempt so tooling/screenshots are not blocked.
  const [nick, setNick] = useState<string | null>(() => {
    const n = getNick();
    if (n) return n;
    if (isLive) { const g = randomNick(); saveNick(g); return g; }
    return null;
  });
  if (route.name !== "bite" && !isLive && !nick) return <NicknameGate onDone={setNick} />;

  if (route.name === "bite") return <BiteFilePlayer />;
  if (route.name === "create") return <CreateApp />;
  if (route.name === "live") return <LiveApp key={location.hash} slug={route.slug!} params={route.params} />;
  return <Discover />;
}

// Bite dev player: fetch public/bite/<name>.bite.json, validate, play locally.
function BiteFilePlayer() {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const name = new URLSearchParams(location.search).get("bite") || "reaction";
    // a bare name → public/bite/<name>.bite.json; anything with a slash is a URL
    const file = name.includes("/") ? name : `${import.meta.env.BASE_URL}bite/${name}.bite.json`;
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
