// Layout lint of the speed-trivia-score result phase with real result data
// (the template gate only reaches the lobby headless). Every state the shell can
// put the screen in — 1:1, group with ties/leaver/long nick, subject's device,
// nobody answered, no view yet, each reaction-question stage, with and without
// "나도 만들기" — must have no text overflow, nothing off the 390×844 frame,
// and the buttons fully on screen, never overlapped.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, checkLayout, computeScene, findInstances, initLayout } from "../../packages/bite-layout/src/index.js";
import { buildResultView, type ResultInput } from "../src/quizResult.ts";
import { LONG_NICK, duo, group } from "./fixtures/quizResult.ts";

const DOC = JSON.parse(readFileSync(new URL("../../snack-server/data/bite/speed-trivia-score.bite.json", import.meta.url), "utf8"));
const ready = initLayout();

type Box = { x: number; y: number; w: number; h: number };
async function scene(vars: Record<string, unknown>) {
  await ready;
  let t = 0;
  const warnings: string[] = [];
  const app = createBite(DOC, { now: () => t, random: () => 0.5, warn: (m: string) => warnings.push(m) });
  app.start();
  app.setVars({ sessionPhase: "result", ...vars });
  for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
  assert.equal(app.phase, "result");
  const { root } = computeScene(DOC, app);
  const boxes = absBoxes(root, new Map()) as Map<string, Box>;
  // A component instance carries its `use` node as `source` (the view's own id is "root").
  const byId = (id: string) => [...findInstances(root, id), ...findBySource(root, id)] as { key: string; text?: { lines: { text: string }[] } }[];
  const box = (id: string) => { const i = byId(id)[0]; return i ? boxes.get(i.key)! : null; };
  return { issues: checkLayout(root, DOC.frame), warnings, byId, box };
}

type Inst = { key: string; node: { id?: string }; source?: { id?: string }; children: Inst[] };
function findBySource(root: Inst, id: string): Inst[] {
  const out: Inst[] = [];
  const walk = (i: Inst) => { if (i.source?.id === id) out.push(i); i.children.forEach(walk); };
  walk(root);
  return out;
}

const viewVars = (input: ResultInput, extra: Record<string, unknown> = {}) => ({
  resultView: buildResultView(input), raceBoard: input.raceBoard, ...extra,
});
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const onScreen = (b: Box) => b.x >= 0 && b.y >= 59 && b.x + b.w <= 390 && b.y + b.h <= 844 - 34 + 0.5;

const CASES: [string, Record<string, unknown>][] = [
  ["1:1 friend", viewVars({ ...duo, myNick: "지은" })],
  ["1:1 subject", viewVars({ ...duo, iAmSubject: true, myNick: "민수" })],
  ["group, long nick is me", viewVars({ ...group, myNick: LONG_NICK })],
  ["group subject", viewVars({ ...group, iAmSubject: true, myNick: "민수" })],
  ["nobody answered", viewVars({ quizRecap: { subject: "민수", rounds: [{ q: "a", options: ["x"], answer: 0, picks: [] }] }, raceBoard: [] })],
  ["no view (dev player)", { raceBoard: group.raceBoard }],
];
const STAGES = ["", "ask", "reasons", "thanks"];

for (const [name, vars] of CASES) {
  for (const canMake of [false, true]) {
    test(`result layout: ${name} · canMake=${canMake} · every reaction stage`, async () => {
      for (const stage of STAGES) {
        const s = await scene({ ...vars, canMake, reactionStage: stage });
        assert.deepEqual(s.issues, [], `${stage || "no question"}: ${JSON.stringify(s.issues)}`);
        assert.deepEqual(s.warnings, [], `runtime warnings (${stage})`);
        const buttons = ["shareBtn", "inviteBtn", ...(canMake ? ["makeBtn"] : [])].map((id) => [id, s.box(id)] as const);
        for (const [id, b] of buttons) {
          assert.ok(b, `${id} shown`);
          assert.ok(onScreen(b!), `${id} on screen (${JSON.stringify(b)})`);
          assert.ok(b!.h >= 44, `${id} is a comfortable tap target`);
        }
        assert.equal(s.box("makeBtn") !== null, canMake, "나도 만들기 only when the shell wired it");
        const card = s.box("reactCard");
        assert.equal(card !== null, stage !== "", "the question card follows reactionStage");
        if (card) for (const [id, b] of buttons) assert.ok(!overlaps(card, b!), `the question card covers ${id}`);
        // The shell's reaction button sits top-right under the people chip:
        // the header keeps x > 306 free down to y = 147 (59 + 88).
        const head = s.box("resHead")!;
        assert.ok(head.x + head.w <= 306 && s.box("resBody")!.y >= 147, "top-right corner is free for the shell");
      }
    });
  }
}

test("a 10-grapheme nickname is drawn whole on one line in the ranking", async () => {
  const s = await scene(viewVars({ ...group, myNick: "하늘" }));
  const nick = s.byId("rkNick").find((i) => i.text?.lines[0]?.text.startsWith(LONG_NICK[0]))!;
  assert.equal(nick.text!.lines.length, 1);
  assert.equal(nick.text!.lines[0].text, LONG_NICK);
});

test("20 answerers × 20 questions still fits (the body scrolls)", async () => {
  const nicks = Array.from({ length: 20 }, (_, i) => `플레이어${i + 1}번째`);
  const rounds = Array.from({ length: 20 }, (_, r) => ({
    q: `아주 긴 질문 ${r + 1}: 민수가 어릴 때 제일 좋아했던 만화 캐릭터는 누구였을까요?`,
    options: ["엄청나게 긴 보기 이름 하나", "둘", "셋", "넷"], answer: r % 4,
    picks: nicks.map((nick, i) => ({ nick, option: (i + r) % 5 - 1, correct: (i + r) % 5 - 1 === r % 4 })),
  }));
  const s = await scene(viewVars({ quizRecap: { subject: "민수", rounds }, raceBoard: nicks.slice(0, 8).map((nick, i) => ({ nick, score: 1000 - i })), roster: [] }, { reactionStage: "reasons" }));
  assert.deepEqual(s.issues, []);
});
