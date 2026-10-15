import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Build id for error reports and the ?debug=1 log: "g" + short commit (the server
// only accepts ids that start with a letter). Vercel sets VERCEL_GIT_COMMIT_SHA, Cloudflare Pages CF_PAGES_COMMIT_SHA.
function buildId(): string {
  let sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || "";
  if (!sha) {
    try {
      sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      sha = "";
    }
  }
  return /^[0-9a-f]{7,}$/i.test(sha) ? `g${sha.slice(0, 7).toLowerCase()}` : "dev";
}

// Play links are real paths (/p/<slug>) in both modes, so assets must be
// absolute: the static host rewrites /p/* to index.html (Cloudflare Pages _redirects) and
// snack-server does the same. (A sub-path host such as GitHub Pages /snackapp/
// is not supported — the fonts in index.html are absolute too.)
// host:true exposes the dev server on the LAN (multi-device testing).
export default defineConfig({
  base: "/",
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  server: { host: true, port: 5290, strictPort: true },
});
