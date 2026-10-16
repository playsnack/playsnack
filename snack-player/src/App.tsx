import { lazy, Suspense, useEffect, useState } from "react";
import { currentRoute, hrefTo, navigate, newFriendRoom } from "./backend";
import { playPath, roomIdFor, ROOM_PARAM } from "./links";
import { QUIZ_SLUG, deviceQuizStore, opensMakerPage } from "./quiz";
import { BitePlayer } from "./BitePlayer.tsx";
import { validate, type BiteDoc } from "@snack/bite";
import { HOST_ACTIONS } from "@snack/room/actions";
import { LiveApp } from "./LiveApp.tsx";
import { Discover } from "./Discover.tsx";
import { NicknameGate } from "./NicknameGate.tsx";
import { getNick, isNickAuto, setNick as saveNick, randomNick } from "./identity";
import { redirectFor } from "./catalog";
import { LoadingScreen, MessageScreen, goHome } from "./Screens";

// Making apps needs the AI builder (a server). The static (serverless) build
// hides it: #/create goes home, and the builder code is not part of the build.
// The "나 맞히기" maker, loaded only when opened (play links do not pay for it).
const QuizMaker = lazy(() => import("./QuizMaker.tsx").then((m) => ({ default: m.QuizMaker })));
// The anonymous stats page (/stats), loaded only when opened.
const StatsPage = lazy(() => import("./StatsPage.tsx").then((m) => ({ default: m.StatsPage })));
const CreateApp = import.meta.env.VITE_SERVER_URL
  ? lazy(() => import("./CreateApp.tsx").then((m) => ({ default: m.CreateApp })))
  : null;

// Routing (no router dep, see backend.currentRoute / links.ts): ?bite=<name> ->
// Bite dev player (public/bite/<name>.bite.json); /create -> builder (server
// builds only); /p/:slug -> live player; /stats -> anonymous stats; otherwise -> Discover home. Old hash
// links (#/p/:slug) are read the same way and rewritten to the path form.
export function App() {
  // In-app moves (navigate(), back/forward, an old hash link changing) re-read the route.
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    addEventListener("popstate", on);
    addEventListener("hashchange", on);
    return () => {
      removeEventListener("popstate", on);
      removeEventListener("hashchange", on);
    };
  }, []);
  useEffect(() => {
    if (route.name === "create" && !CreateApp) location.replace(hrefTo("/"));
  }, [route.name]);
  // The quiz maker on its own page: /p/tpl-<quiz>?make=1 with no room param at
  // all. With a room code it opens over that room (LiveApp); with a cut/invalid
  // code, LiveApp shows the bad-link screen (never the maker).
  const isMaker = route.name === "live" && opensMakerPage(route.slug, route.params);
  const isLive = route.name === "live" && !isMaker;
  // A merged template's old link (or a bare 나 맞히기 link → 스피드 퀴즈, #210) moves to the app it became — decided here,
  // before the player mounts, so the old app never loads or joins a room.
  // (index.json is preloaded with the page, see index.html.)
  const [checkedLink, setCheckedLink] = useState<string | null>(null); // `slug?params`: the redirect depends on both
  useEffect(() => {
    if (!isLive) return;
    const slug = route.slug!;
    const link = `${slug}?${route.params}`;
    let on = true;
    redirectFor(slug, route.params).then((to) => {
      if (!on) return;
      if (!to) return setCheckedLink(link);
      location.replace(playPath(to, route.params));
    });
    return () => { on = false; };
  }, [isLive, route.slug, String(route.params)]);
  // First-visit nickname onboarding (per-browser). Gate only the HOME / Create
  // entry — a direct share link auto-assigns a guest nick so play is never
  // blocked (frictionless virality; each browser still gets a name, editable
  // later). The ?bite= dev player is exempt so tooling/screenshots are not blocked.
  const [nick, setNick] = useState<string | null>(() => {
    const n = getNick();
    if (n) return n;
    if (isLive) { const g = randomNick(); saveNick(g, { auto: true }); return g; }
    return null;
  });
  // /stats shows counts only and needs no nickname.
  if (route.name === "stats") return <Suspense fallback={<LoadingScreen />}><StatsPage onHome={() => navigate("/")} /></Suspense>;
  if (route.name !== "bite" && !isLive && !nick) return <NicknameGate onDone={setNick} />;

  if (route.name === "bite") return <BiteFilePlayer />;
  if (isMaker) return <Suspense fallback={<LoadingScreen />}><QuizMakerPage nick={nick!} /></Suspense>;
  if (route.name === "create" && CreateApp) return <Suspense fallback={<LoadingScreen />}><CreateApp /></Suspense>;
  if (route.name === "live") {
    if (checkedLink !== `${route.slug}?${route.params}`) return <LoadingScreen />;
    // Keyed by the whole link: a different app or room (e.g. a friends-only
    // code) remounts the player and joins that room.
    return <LiveApp key={`${route.slug}?${route.params}`} slug={route.slug!} params={route.params} />;
  }
  return <Discover />;
}

// The maker on its own page: when done, a new friends-only room is made for the
// quiz; the questions stay on this device (never in the link) and LiveApp sends
// them to the room as `quizPack` once this device joins.
function QuizMakerPage({ nick }: { nick: string }) {
  return (
    <QuizMaker nick={nick} nickAuto={isNickAuto()} doneLabel="완료 · 친구 초대하러 가기" closeLabel="← 홈" onClose={goHome}
      onDone={async (pack) => {
        const store = deviceQuizStore();
        // The room server makes the code (and this device hosts it); a failure keeps the maker
        // open with its "다시 눌러 주세요" line (QuizMaker finish).
        const room = await newFriendRoom(QUIZ_SLUG); // marks it fresh: no host to wait for
        if (!room.ok) throw new Error(`mint ${room.error}`);
        const params = new URLSearchParams({ [ROOM_PARAM]: room.code });
        store.rememberRoomPack(roomIdFor(QUIZ_SLUG, params), pack);
        store.clearDraft();
        navigate(playPath(QUIZ_SLUG, params), { replace: true }); // Back goes where the maker was opened from, not into an empty maker
      }} />
  );
}

// Bite dev player: fetch public/bite/<name>.bite.json, validate, play locally.
function BiteFilePlayer() {
  const [doc, setDoc] = useState<BiteDoc | null>(null);
  const [err, setErr] = useState(false);

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
        const v = validate(d, { hostActions: HOST_ACTIONS });
        for (const w of v.warnings) console.warn(`[bite] ${w.path}: ${w.message}`);
        if (!v.ok) throw new Error(v.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
        setDoc(d);
      })
      .catch((e) => {
        // Details go to the console; the screen stays plain.
        console.error("[bite] load failed\n" + String(e));
        setErr(true);
      });
  }, []);

  if (err) return <MessageScreen icon="🔍" title="앱을 열 수 없어요" body="파일을 찾지 못했거나 형식이 맞지 않아요." />;
  if (!doc) return <LoadingScreen />;
  return <BitePlayer doc={doc} onHostEvent={(e) => console.log("[bite] emit", e)} />;
}
