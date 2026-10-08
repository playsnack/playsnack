// Copies the content the serverless player needs into public/data/ (served as
// static files): templates + index, the curated content bank, seed pools, and
// multiplayer round packs. Source of truth stays in snack-server/data.
import { cpSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../snack-server/data");
const out = resolve(here, "../public/data");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ["bite", "seed-content", "pools", "multi-content"]) {
  cpSync(resolve(src, dir), resolve(out, dir), { recursive: true });
}
const n = readdirSync(resolve(out, "bite")).filter((f) => f.endsWith(".bite.json")).length;
console.log(`[sync-data] ${n} templates + content → public/data`);
