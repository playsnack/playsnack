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
import { PILLS_BOTTOM, bandBottom, canvasDrop, frameFit, quizInviteBandRect } from "../src/canvasFit.ts";
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
// An entry that plays another entry's file (`template`, #210) is checked with that file.
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

for (const { id, hidden, template } of index as { id: string; hidden?: boolean; template?: string }[]) {
  if (hidden || template) continue;
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

// The quiz lobby's invite band (#94) — the shell's 🔗 친구 초대하기 / 친구 더 부르기 + QR,
// in CSS px over the canvas. It used to sit at a fixed 34px above the bottom, 52 tall:
// right for 390×844, but at 360×640 the frame shrinks (0.74) and the band covered the
// lower half of 시작하기 (a tap there opened the invite / QR instead of starting).
// Now it is the template's empty band through the canvas fit: on every phone size,
// in every lobby the quiz shows, it covers no template button or text, and stays on
// screen. (The result screen: the band is lobby-only — LiveApp quizInvite — and the
// result's own 친구 초대 / QR take over.)
type TapInst = Inst & { node: Record<string, unknown>; tap?: { node: { id?: string } } };
const tappable = (i: TapInst) => Boolean(i.tap); // what the hit test taps (bite-layout hit.js), components included
async function screenBoxes(doc: { frame: [number, number] }, vars: Record<string, unknown>, w: number, h: number) {
  await ready;
  let t = 0;
  const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
  app.start();
  app.setVars(vars);
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  const { root } = computeScene(doc, app);
  const boxes = absBoxes(root, new Map()) as Map<string, Box>;
  const { s, x: ox, y: oy } = frameFit(w, h, doc.frame);
  const out: { what: string; box: Box }[] = [];
  for (const inst of walk(root as unknown as Inst) as Generator<TapInst>) {
    const b = boxes.get(inst.key)!;
    const a = inst.style?.align;
    if (tappable(inst)) out.push({ what: `button ${inst.tap!.node.id ?? inst.key}`, box: { x: ox + b.x * s, y: oy + b.y * s, w: b.w * s, h: b.h * s } });
    (inst.text?.lines ?? []).forEach((l, n) => {
      if (!l.text.trim()) return;
      const x = b.x + (a === "center" ? (b.w - l.width) / 2 : a === "right" ? b.w - l.width : 0);
      out.push({ what: `"${l.text}"`, box: { x: ox + x * s, y: oy + (b.y + n * inst.text!.lineHeight) * s, w: l.width * s, h: inst.text!.lineHeight * s } });
    });
  }
  return out;
}
test("quiz lobby: the invite band covers no button or text, on every phone size (#94)", async () => {
  const doc = JSON.parse(readFileSync(new URL("speed-trivia-score.bite.json", DIR), "utf8"));
  const mine = { title: "하늘 맞히기", count: 6, custom: true, about: "하늘", answerMs: 9000, packId: "pack-x" };
  const lobbies: Record<string, unknown>[] = [
    { roster: ["하늘"], participants: 1 }, // alone: the big 🔗 친구 초대하기
    { roster: ["가나다라마바사아자차", "하늘"], participants: 2 }, // friends in: 시작하기
    { roster: ["가나다라마바사아자차", "하늘"], participants: 2, quizInfo: mine, iAmSubject: true }, // my own quiz loaded
  ];
  for (const [w, h] of [...SHORT, ...ROOMY]) {
    const band = quizInviteBandRect(w, h, doc.frame);
    const ink = { ...band, h: band.h + 4 }; // the 4px block shadow
    assert.ok(band.h >= 44 && band.y + ink.h <= h && band.x >= 0 && band.x + band.w <= w, `${w}×${h}: band on screen, ${JSON.stringify(band)}`);
    for (const vars of lobbies) {
      const over = (await screenBoxes(doc, { sessionPhase: "lobby", ...vars }, w, h)).filter((o) => hit(o.box, ink));
      assert.deepEqual(over.map((o) => `${o.what} at ${JSON.stringify(o.box)}`), [], `${w}×${h} ${JSON.stringify(vars.roster)}`);
    }
  }
});
test("quiz lobby band at 390×844 is where it always was (16, 758, 358×52)", () => {
  assert.deepEqual(quizInviteBandRect(390, 844), { x: 16, y: 758, w: 358, h: 52 });
});
