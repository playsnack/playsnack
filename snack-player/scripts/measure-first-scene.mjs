// Cold first-scene time on a throttled "Fast 3G" link (Chrome DevTools preset:
// 562.5 ms RTT, ~1.44 Mbit/s down, ~675 kbit/s up), cache disabled, fresh
// browser context per run. Prints the median of N runs per page.
//
//   node snack-player/scripts/measure-first-scene.mjs [baseUrl] [runs] [page,page…]
//   (serve a build first, e.g. `npx vite preview --port 4178 --strictPort`)
//
// "First scene":
//   home      — game cards rendered AND the heading's font is ready
//   play page — the Bite renderer finished its first frame (window.__bite set;
//               mountBite awaits layout + the fonts the app needs, then draws)
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:4178/").replace(/\/?$/, "/");
const RUNS = Number(process.argv[3] || 3);
const PAGES = (process.argv[4] || "home,quiz-ox,game-reaction,tap-battle").split(",");

const FAST_3G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: ((1.6 * 1024 * 1024) / 8) * 0.9,
  uploadThroughput: ((750 * 1024) / 8) * 0.9,
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function once(browser, page) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("snack_nick", "측정봇");
    } catch {}
  });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", FAST_3G);
  let bytes = 0;
  cdp.on("Network.loadingFinished", (e) => (bytes += e.encodedDataLength || 0));
  const url = page === "home" ? BASE : `${BASE}#/p/tpl-${page}`;
  await p.goto(url, { waitUntil: "commit" });
  const ms = await p.waitForFunction(
    (isHome) => {
      if (isHome) {
        const h1 = document.querySelector("h1");
        const cards = document.querySelectorAll("button.blk").length;
        if (!h1 || cards < 4) return false;
        const cs = getComputedStyle(h1);
        return document.fonts.check(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, h1.textContent || "") ? performance.now() : false;
      }
      return globalThis.__bite ? performance.now() : false;
    },
    page === "home",
    { polling: "raf", timeout: 60000 },
  );
  const t = await ms.jsonValue();
  await ctx.close();
  return { t, bytes };
}

const browser = await chromium.launch();
const rows = [];
for (const page of PAGES) {
  const ts = [];
  let kb = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = await once(browser, page);
    ts.push(r.t);
    kb = Math.round(r.bytes / 1024);
  }
  rows.push({ page, median_s: +(median(ts) / 1000).toFixed(2), runs_s: ts.map((x) => +(x / 1000).toFixed(2)).join(" / "), kb_by_scene: kb });
  console.log(JSON.stringify(rows.at(-1)));
}
await browser.close();
console.table(rows);
