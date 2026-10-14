// Design-system rule (#84): the pixel face (font "display", Galmuri11) is only for
// text with no Korean at all — Latin/digit scores, counters, "VS"; anything with
// Korean is Pretendard (body, 700 for titles). One font per text node. The pixel
// subsets ship without Hangul (scripts/subset_fonts.py), so a Korean display text
// would also pull the 0.5 MB full face.
// Checked on every official template two ways: the authored text (a Korean literal,
// or a component text fed by a prop, which is data), and the drawn text in every
// phase (each phase as the start phase; a together app also in each session phase).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { computeScene, initLayout } from "../../packages/bite-layout/src/index.js";

const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".bite.json"));
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
type Node = Record<string, unknown>;

function displayTexts(n: unknown, inComponent: boolean, out: { text: string; id: string; inComponent: boolean }[]) {
  if (Array.isArray(n)) { n.forEach((c) => displayTexts(c, inComponent, out)); return out; }
  if (!n || typeof n !== "object") return out;
  const o = n as Node;
  if (o.font === "display" && "text" in o) out.push({ text: String(o.text), id: String(o.id ?? "?"), inComponent });
  for (const v of Object.values(o)) displayTexts(v, inComponent, out);
  return out;
}

const ready = initLayout();
type Inst = { style?: { font?: string }; text?: { lines: { text: string }[] }; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }

for (const file of FILES) {
  const doc = JSON.parse(readFileSync(new URL(file, DIR), "utf8"));
  test(`${file}: no Korean in a pixel-font (display) text node`, async () => {
    const authored = [
      ...displayTexts(doc.view, false, []),
      ...displayTexts(doc.phases, false, []),
      ...displayTexts(doc.components, true, []),
    ];
    for (const t of authored) {
      assert.ok(!HANGUL.test(t.text), `${t.id}: "${t.text.slice(0, 60)}" has Korean — use the body face (weight 700)`);
      assert.ok(!(t.inComponent && /\{\s*props\./.test(t.text)), `${t.id}: a component's display text shows a prop ("${t.text}") — that is data and can be Korean`);
    }
    await ready;
    const together = "sessionPhase" in (doc.vars ?? {});
    const runs: [string, Record<string, unknown>][] = Object.keys(doc.phases ?? {}).map((p) => [p, {}]);
    if (together) for (const p of ["lobby", "countdown", "play", "result"]) runs.push([doc.start, { sessionPhase: p, roster: ["가나다라마바사아자차", "하늘"], participants: 2 }]);
    for (const [start, vars] of runs) {
      let t = 0;
      const app = createBite({ ...doc, start }, { now: () => t, random: () => 0.5, warn: () => {} });
      app.start();
      if (Object.keys(vars).length) app.setVars(vars);
      for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
      const { root } = computeScene(doc, app);
      for (const inst of walk(root as unknown as Inst)) {
        if (inst.style?.font !== "display") continue;
        const drawn = (inst.text?.lines ?? []).map((l) => l.text).join(" ");
        assert.ok(!HANGUL.test(drawn), `${start} ${JSON.stringify(vars.sessionPhase ?? "")}: pixel-font text "${drawn}" has Korean`);
      }
    }
  });
}
