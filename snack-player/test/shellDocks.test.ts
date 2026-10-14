// The shell's room buttons sit in the top row (🔗 친구 초대 + QR / 🤝 친구끼리, right of 홈)
// and under the people chip (💬), on every screen (MP-09). This checks that no
// together template draws text or a tappable node there, in any session phase.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, computeScene, initLayout } from "../../packages/bite-layout/src/index.js";
import { SPECTATOR_NOTICE_BOX, forTemplate, showSpectatorNotice } from "../src/spectate.ts";

const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")) as { id: string; mode: string; hidden?: boolean }[];
const TOGETHER = index.filter((t) => t.mode === "multi" && !t.hidden).map((t) => t.id);

type Box = { x: number; y: number; w: number; h: number };
// Frame coordinates (390 wide): pills are 44 tall from y 10; 💬 is 46×46 at right 12, top 62.
const ZONES: Record<string, Box> = {
  // 🔗 친구 초대 (84–184) + QR (190–235, measured at 390 by scripts/qr-shots.mjs); the QR alone on the result screen.
  invitePill: { x: 84, y: 10, w: 160, h: 44 },
  reactionFab: { x: 332, y: 62, w: 46, h: 46 },
  debugTab: { x: 294, y: 62, w: 32, h: 32 }, // 🪲 (?debug=1 only, DebugLog.tsx)
};
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

type Inst = { key: string; box: Box; node: Record<string, unknown>; style?: { align?: string }; text?: { lines: { text: string; width: number }[]; lineHeight: number }; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }
const tappable = (i: Inst) => Boolean(i.node.on || i.node.tap || i.node.onTap);
// What a node actually puts on screen: each text line's glyph run (placed like the
// renderer does, bite-pixi renderer.js ~:228), or the whole box for a tappable node.
function inkBoxes(i: Inst, b: Box): Box[] {
  if (tappable(i)) return [b];
  if (!i.text?.lines?.length) return [];
  const a = i.style?.align;
  return i.text.lines.filter((l) => l.text.trim()).map((l, n) => ({
    x: b.x + (a === "center" ? (b.w - l.width) / 2 : a === "right" ? b.w - l.width : 0),
    y: b.y + n * i.text!.lineHeight, w: l.width, h: i.text!.lineHeight,
  }));
}

const ready = initLayout();
for (const id of TOGETHER) {
  test(`${id}: nothing under the shell's top-row buttons`, async () => {
    await ready;
    const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
    for (const phase of ["lobby", "countdown", "play", "result"]) {
      let t = 0;
      const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
      app.start();
      if ("sessionPhase" in (doc.vars ?? {})) app.setVars({ sessionPhase: phase, roster: ["가나다라마바사아자차", "하늘"], participants: 2 });
      for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
      const { root } = computeScene(doc, app);
      const boxes = absBoxes(root, new Map()) as Map<string, Box>;
      for (const inst of walk(root as unknown as Inst)) {
        for (const b of inkBoxes(inst, boxes.get(inst.key)!)) {
          for (const [zone, z] of Object.entries(ZONES)) {
            assert.ok(!hit(b, z), `${id} ${phase}: "${inst.text?.lines.map((l) => l.text).join(" ") ?? inst.key}" overlaps ${zone} at ${JSON.stringify(b)}`);
          }
        }
      }
    }
  });
}

// The spectator notice (spectate.ts) — shown during countdown / play to someone who opened the
// link mid-game, for templates that do not show it themselves. It sits on the templates' subtitle
// line: never over the shell's own buttons, never over a template button (it lets taps through, but
// a hidden button is still a broken screen).
test("spectator notice: clear of the top-row pills, 💬 and 🪲", () => {
  for (const [zone, z] of Object.entries(ZONES)) assert.ok(!hit(SPECTATOR_NOTICE_BOX, z), `overlaps ${zone}`);
});
test("spectator notice: only while watching a game in progress, only for templates without iAmSpectator", () => {
  const plain = { vars: { sessionPhase: "lobby" } };
  const quiz = { vars: { sessionPhase: "lobby", iAmSpectator: false, spectators: 0 } };
  assert.equal(showSpectatorNotice(plain, true, "play"), true);
  assert.equal(showSpectatorNotice(plain, true, "countdown"), true);
  for (const phase of ["lobby", "result", ""]) assert.equal(showSpectatorNotice(plain, true, phase), false, phase);
  assert.equal(showSpectatorNotice(plain, false, "play"), false);
  assert.equal(showSpectatorNotice(quiz, true, "play"), false, "the quiz shows its own banner");
  assert.equal(forTemplate(plain, "iAmSpectator"), false, "no undeclared-variable warning");
  assert.equal(forTemplate(plain, "spectators"), false);
  assert.equal(forTemplate(quiz, "iAmSpectator"), true);
  assert.equal(forTemplate(plain, "roster"), true);
});
for (const id of TOGETHER) {
  test(`${id}: no template button under the spectator notice (countdown / play)`, async () => {
    await ready;
    const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
    if ("iAmSpectator" in (doc.vars ?? {})) return; // shows its own
    for (const phase of ["countdown", "play"]) {
      let t = 0;
      const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
      app.start();
      if ("sessionPhase" in (doc.vars ?? {})) app.setVars({ sessionPhase: phase, roster: ["가나다라마바사아자차", "하늘"], participants: 2 });
      for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
      const { root } = computeScene(doc, app);
      const boxes = absBoxes(root, new Map()) as Map<string, Box>;
      for (const inst of walk(root as unknown as Inst)) {
        if (tappable(inst)) assert.ok(!hit(boxes.get(inst.key)!, SPECTATOR_NOTICE_BOX), `${id} ${phase}: button ${inst.key} under the notice`);
      }
    }
  });
}
