import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Serverless: base "./" → the build runs from any sub-path (e.g. GitHub Pages
// /snackapp/; routes are #hashes). With a server (VITE_SERVER_URL) the server
// serves real /p/… paths, so assets must be absolute.
// host:true exposes the dev server on the LAN (multi-device testing).
export default defineConfig({
  base: process.env.VITE_SERVER_URL ? "/" : "./",
  plugins: [react()],
  server: { host: true, port: 5290, strictPort: true },
});
