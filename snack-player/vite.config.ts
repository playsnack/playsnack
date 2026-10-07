import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host:true exposes the dev server on the LAN (multi-device testing).
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5290, strictPort: true },
});
