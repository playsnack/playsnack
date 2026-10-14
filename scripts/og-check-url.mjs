#!/usr/bin/env node
// Link previews (#106) on a running site, as KakaoTalk's crawler sees them:
//   node scripts/og-check-url.mjs http://127.0.0.1:4630        (wrangler pages dev)
//   node scripts/og-check-url.mjs https://playsnack.pages.dev   (after a deploy)
// For "/" and every listed catalog app: fetch the page with the Kakao scrap UA, read og:title /
// og:image, check the title is the app's and the image answers 200 image/png 1200×630.
// Exit 1 on any miss.
import { readFileSync } from "node:fs";
import { ogMeta } from "../api/_lib/og.js";

const base = (process.argv[2] ?? "http://127.0.0.1:4630").replace(/\/+$/, "");
const UA = "facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984";
const catalog = JSON.parse(readFileSync(new URL("../snack-server/data/bite/index.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../snack-player/public/og/manifest.json", import.meta.url), "utf8"));

const attr = (html, prop) => {
  const m = new RegExp(`<meta property="${prop}"(?! data-og)[^>]*content="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
};
let bad = 0;
const paths = ["/", ...catalog.map((e) => `/p/tpl-${e.id}`)];
for (const p of paths) {
  const html = await (await fetch(base + p, { headers: { "user-agent": UA } })).text();
  const want = ogMeta({ url: base + p, catalog, manifest });
  const title = attr(html, "og:title");
  const image = attr(html, "og:image");
  const problems = [];
  // "/" is the static index.html (fixed production URLs); /p/* is rewritten per request.
  if (title !== want.title) problems.push(`og:title ${JSON.stringify(title)} ≠ ${JSON.stringify(want.title)}`);
  if (!image) problems.push("no og:image");
  else {
    const r = await fetch(p === "/" ? image.replace(/^https:\/\/playsnack\.pages\.dev/, base) : image);
    const b = Buffer.from(await r.arrayBuffer());
    const w = b.length > 24 ? b.readUInt32BE(16) : 0;
    const h = b.length > 24 ? b.readUInt32BE(20) : 0;
    if (r.status !== 200 || !String(r.headers.get("content-type")).startsWith("image/png") || w !== 1200 || h !== 630)
      problems.push(`image ${image} → ${r.status} ${r.headers.get("content-type")} ${w}×${h}`);
  }
  if (problems.length) bad += 1;
  console.log(`${problems.length ? "✗" : "✓"} ${p}  ${title ?? ""}${problems.length ? `\n    ${problems.join("\n    ")}` : ""}`);
}
console.log(`[og-check-url] ${paths.length - bad}/${paths.length} ok on ${base}`);
process.exit(bad ? 1 : 0);
