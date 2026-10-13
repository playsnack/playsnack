import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Play links are real paths (/p/<slug>) in both modes, so assets must be
// absolute: the static host rewrites /p/* to index.html (vercel.json) and
// snack-server does the same. (A sub-path host such as GitHub Pages /snackapp/
// is not supported — the fonts in index.html are absolute too.)
// host:true exposes the dev server on the LAN (multi-device testing).
export default defineConfig({
  base: "/",
  plugins: [react()],
  server: { host: true, port: 5290, strictPort: true },
});
