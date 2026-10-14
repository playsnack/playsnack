// The shell's top row (← 홈 / 친구 초대 / 👥 N명, CSS px) over a canvas scaled to fit a
// short phone (#85): at 360×640 the frame shrinks and its top band used to slide
// under 홈. The canvas now starts lower by canvasDrop (canvasFit.ts); this checks
// the band stays clear on short and tall phones, the canvas does not move where
// it was already clear, and — on the screens themselves at 360×640 — that no
// template draws text under the pills, the quiz result included.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, computeScene, initLayout } from "../../packages/bite-layout/src/index.js";
import { PILLS_BOTTOM, bandBottom, canvasDrop } from "../src/canvasFit.ts";
import { buildResultView } from "../src/quizResult.ts";
import { duo, group } from "./fixtures/quizResult.ts";

// Areas below the notch (CSS px): short Androids / SE-class, then common phones.
const SHORT: [number, number][] = [[360, 640], [320, 568], [375, 667], [360, 700], [375, 768]];
const ROOMY: [number, number][] = [[390, 844], [430, 932], [412, 915], [768, 1024]];

test("the frame's top band clears the pills on every phone size", () => {
  for (const [w, h] of [...SHORT, ...ROOMY]) {
    const d = canvasDrop(w, h);
    assert.ok(bandBottom(w, h, d) >= PILLS_BOTTOM, `${w}×${h}: band ends at ${bandBottom(w, h, d)}`);
    assert.ok(d === 0 || bandBottom(w, h, d - 1) < PILLS_BOTTOM, `${w}×${h}: drop ${d} is the smallest`);
  }
});
test("the canvas does not move where the band was already clear", () => {
  for (const [w, h] of ROOMY) assert.equal(canvasDrop(w, h), 0, `${w}×${h}`);
  assert.ok(canvasDrop(360, 640) > 0 && canvasDrop(360, 640) <= 16, "a small drop at 360×640");
});

// On screen at 360×640: every template, every phase it shows at start or as a
// together session phase, plus the quiz result with real data — no text under
// the pills (CSS px, measured at 360 wide: ← 홈 12–74, 친구 초대 + QR / 🤝 친구끼리
// 84–244 and the people chip at the right edge, up to "방에 들어가는 중"; the 4px
// shadow included). A solo app has only 홈.
const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")) as { id: string; hidden?: boolean }[];
type Box = { x: number; y: number; w: number; h: number };
type Inst = { key: string; style?: { align?: string }; text?: { lines: { text: string; width: number }[]; lineHeight: number }; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const ready = initLayout();

const [W, H] = [360, 640];
const HOME: Box = { x: 12, y: 10, w: 62, h: 44 };
const ROOM_PILLS: Box[] = [{ x: 84, y: 10, w: 160, h: 44 }, { x: W - 12 - 134, y: 10, w: 134, h: 44 }];
async function underPills(doc: { frame: [number, number] }, vars: Record<string, unknown>, together: boolean) {
  await ready;
  let t = 0;
  const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
  app.start();
  if (Object.keys(vars).length) app.setVars(vars);
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  const { root } = computeScene(doc, app);
  const boxes = absBoxes(root, new Map()) as Map<string, Box>;
  const [fw, fh] = doc.frame;
  const drop = canvasDrop(W, H, doc.frame);
  const s = Math.min(W / fw, (H - drop) / fh);
  const ox = (W - fw * s) / 2, oy = drop + (H - drop - fh * s) / 2; // renderer.js fit
  const pills = together ? [HOME, ...ROOM_PILLS] : [HOME];
  const out: string[] = [];
  for (const inst of walk(root as unknown as Inst)) {
    const b = boxes.get(inst.key)!;
    const a = inst.style?.align;
    (inst.text?.lines ?? []).forEach((l, n) => {
      if (!l.text.trim()) return;
      // Each line's glyph run, placed like the renderer does (shellDocks.test.ts).
      const x = b.x + (a === "center" ? (b.w - l.width) / 2 : a === "right" ? b.w - l.width : 0);
      const ink = { x: ox + x * s, y: oy + (b.y + n * inst.text!.lineHeight) * s, w: l.width * s, h: inst.text!.lineHeight * s };
      if (pills.some((p) => hit(ink, p))) out.push(`"${l.text}" at ${JSON.stringify(ink)}`);
    });
  }
  return out;
}

for (const { id, hidden } of index) {
  if (hidden) continue;
  test(`${id} at 360×640: no text under the shell's top row`, async () => {
    const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
    const together = "sessionPhase" in (doc.vars ?? {});
    for (const phase of together ? ["lobby", "countdown", "play", "result"] : [""]) {
      const vars = together ? { sessionPhase: phase, roster: ["가나다라마바사아자차", "하늘"], participants: 2 } : {};
      assert.deepEqual(await underPills(doc, vars, together), [], phase || "start");
    }
  });
}

test("quiz result at 360×640 (1:1 and group): the 결과 line clears ← 홈", async () => {
  const doc = JSON.parse(readFileSync(new URL("speed-trivia-score.bite.json", DIR), "utf8"));
  for (const input of [{ ...duo, myNick: "지은" }, { ...group, myNick: "하늘" }]) {
    const vars = { sessionPhase: "result", resultView: buildResultView(input), raceBoard: input.raceBoard, roster: input.roster ?? [] };
    assert.deepEqual(await underPills(doc, vars, true), []);
  }
});
