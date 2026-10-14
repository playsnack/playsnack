#!/usr/bin/env node
// Build the player for Cloudflare Pages (docs/cloudflare-pages.md):
//   node scripts/pages-build.mjs            → snack-player/dist with rooms on the edge room server
//   PAGES_ROOM_URL= node scripts/pages-build.mjs   → rollback build: rooms back on the MQTT mesh
// = `pnpm player:build` with VITE_ROOM_URL set for this build only (the Vercel build is
// untouched: it never sets it), then the Pages routing files from cloudflare/pages/ are
// copied into the output (_redirects = vercel.json rewrites, _routes.json = only /api/* and the /p/*
// HTML (link previews, #106) run Functions, so static files never spend the free 100k requests/day).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ROOM_URL = "wss://snack-room.playsnack.workers.dev";
const roomUrl = process.env.PAGES_ROOM_URL ?? DEFAULT_ROOM_URL;

const env = { ...process.env };
if (roomUrl) env.VITE_ROOM_URL = roomUrl;
else delete env.VITE_ROOM_URL;
console.log(`[pages-build] VITE_ROOM_URL=${roomUrl || "(unset → MQTT mesh rooms)"}`);
execFileSync("pnpm", ["-s", "player:build"], { cwd: ROOT, env, stdio: "inherit" });

const src = path.join(ROOT, "cloudflare/pages");
const out = path.join(ROOT, "snack-player/dist");
if (!existsSync(path.join(out, "index.html"))) throw new Error("player build produced no index.html");
for (const f of readdirSync(src)) copyFileSync(path.join(src, f), path.join(out, f));
console.log(`[pages-build] ${out} ready (+ ${readdirSync(src).join(", ")})`);
