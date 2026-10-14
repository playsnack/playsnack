// #105: a finger on the quiz result's per-question list ("문제별 정답", resBody)
// must land on resBody in frame units on every phone shape, with the shell's
// canvasFit drop under the notch and the renderer's contain-fit on top — the
// renderer turns client points into frame points with bite-pixi gesture.js
// (clientToFrame over the canvas's client rect). Checked on the real template
// with a 10-question result, and the list must be long enough to scroll.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, computeScene, findInstances, initLayout, scrollTargetAt } from "../../packages/bite-layout/src/index.js";
import { clientToFrame, fitFrame } from "../../packages/bite-pixi/src/gesture.js";
import { buildResultView, type ResultInput } from "../src/quizResult.ts";
import { canvasDrop, frameFit } from "../src/canvasFit.ts";

const DOC = JSON.parse(readFileSync(new URL("../../snack-server/data/bite/speed-trivia-score.bite.json", import.meta.url), "utf8"));

const NICKS = ["하늘", "도윤", "지은"];
const input: ResultInput = {
  quizRecap: {
    subject: "민수", about: "민수", title: "민수 맞히기", packId: "p",
    rounds: Array.from({ length: 10 }, (_, i) => ({
      q: `${i + 1}번 문제: 민수가 제일 좋아하는 것은?`, options: ["가", "나", "다", "라"], answer: i % 4,
      picks: NICKS.map((nick, k) => ({ pid: `pid-${nick}`, nick, option: (i + k) % 4, ms: 2000, correct: (i + k) % 4 === i % 4 })),
    })),
  },
  raceBoard: NICKS.map((nick) => ({ pid: `pid-${nick}`, nick, score: 1000 })),
  roster: ["민수", ...NICKS],
  quizInfo: { title: "민수 맞히기", count: 10, custom: true, about: "민수", packId: "p" },
  myNick: "지은",
};

type Box = { x: number; y: number; w: number; h: number };
type Inst = { key: string; box: Box; contentSize?: { w: number; h: number } };

async function resultScene(reactionStage: string) {
  await initLayout();
  let t = 0;
  const app = createBite(DOC, { now: () => t, random: () => 0.5 });
  app.start();
  app.setVars({ sessionPhase: "result", resultView: buildResultView(input), raceBoard: input.raceBoard, roster: input.roster, reactionStage });
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  const { root } = computeScene(DOC, app);
  const list = findInstances(root, "resBody")[0] as Inst;
  return { root, list, box: (absBoxes(root, new Map()) as Map<string, Box>).get(list.key)! };
}

// [area w, area h, safe-area top] — the play area is the viewport below the notch.
const PHONES: [string, number, number, number][] = [
  ["390×844", 390, 844, 0],
  ["iPhone 13 Safari 390×664 (notch 47)", 390, 664, 47],
  ["360×640", 360, 640, 0],
  ["375×667", 375, 667, 20],
];

for (const stage of ["", "ask"]) {
  test(`the per-question list is scrollable and under the finger on every phone (question card: ${stage || "none"})`, async () => {
    const { root, list, box } = await resultScene(stage);
    assert.ok(list.contentSize && list.contentSize.h - list.box.h > 400, `10 questions overflow the list (${list.contentSize?.h} in ${list.box.h})`);
    for (const [name, w, h, safeTop] of PHONES) {
      const area = h - safeTop;
      const drop = canvasDrop(w, area);
      // The renderer's fit of its canvas (the area below the drop) is canvasFit's model of it.
      const fit = fitFrame(w, area - drop, 390, 844);
      const model = frameFit(w, area);
      assert.ok(Math.abs(fit.scale - model.s) < 1e-9 && Math.abs(fit.x - model.x) < 1e-9 && Math.abs(drop + fit.y - model.y) < 1e-9, `${name}: renderer fit = canvasFit.frameFit`);
      const rect = { left: 0, top: safeTop + drop }; // the canvas's client rect
      // Fingers across the list's on-screen box (inset 2px from its edges).
      for (const [fx, fy] of [[0.5, 0.05], [0.5, 0.5], [0.5, 0.95], [0.05, 0.5], [0.95, 0.5]]) {
        const cx = rect.left + fit.x + (box.x + box.w * fx) * fit.scale;
        const cy = rect.top + fit.y + (box.y + box.h * fy) * fit.scale;
        const p = clientToFrame(cx, cy, rect, fit);
        const target = scrollTargetAt(root, p.x, p.y, new Map()) as Inst | null;
        assert.equal(target?.key, list.key, `${name}: a finger at (${cx.toFixed(1)}, ${cy.toFixed(1)}) px reaches the list`);
      }
    }
  });
}
