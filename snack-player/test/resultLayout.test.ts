// Layout lint of the speed-trivia-score result phase with real result data
// (the template gate only reaches the lobby headless). Every state the shell can
// put the screen in — 1:1, group with ties/leaver/long nick, subject's device,
// nobody answered, no view yet × each next-game state (나도 만들기 / 내 퀴즈
// 시작하기 / waiting banner / 다시 하기) × each reaction-question stage, with
// and without 나도 만들기 wired — must have no text overflow, nothing off the
// 390×844 frame, and the buttons fully on screen, never overlapped.
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, checkLayout, computeScene, findInstances, initLayout } from "../../packages/bite-layout/src/index.js";
import { buildResultView, type ResultInput } from "../src/quizResult.ts";
import { canvasDrop } from "../src/canvasFit.ts";
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
  return { issues: checkLayout(root, DOC.frame), warnings, byId, box, boxes };
}

type Inst = { key: string; node: { id?: string }; source?: { id?: string }; children: Inst[] };
function findBySource(root: Inst, id: string): Inst[] {
  const out: Inst[] = [];
  const walk = (i: Inst) => { if (i.source?.id === id) out.push(i); i.children.forEach(walk); };
  walk(root);
  return out;
}

const viewVars = (input: ResultInput, extra: Record<string, unknown> = {}) => ({
  resultView: buildResultView(input), raceBoard: input.raceBoard, roster: input.roster ?? [], ...extra,
});
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const onScreen = (b: Box) => b.x >= 0 && b.y >= 59 && b.x + b.w <= 390 && b.y + b.h <= 844 - 34 + 0.5;

const CASES: [string, ResultInput | null][] = [
  ["1:1 friend", { ...duo, myNick: "지은" }],
  ["1:1 subject", { ...duo, iAmSubject: true, myNick: "민수" }],
  ["group, long nick is me", { ...group, myNick: LONG_NICK }],
  ["group subject", { ...group, iAmSubject: true, myNick: "민수" }],
  ["nobody answered", { quizRecap: { subject: "민수", rounds: [{ q: "a", options: ["x"], answer: 0, picks: [] }] }, raceBoard: [] }],
  ["no view (dev player)", null],
];
// Next-game states (resultView.next): a finished custom quiz (make), my new quiz
// waiting (startMine), someone else's (waiting, long name), a default quiz (again).
const NEXT: [string, (i: ResultInput) => ResultInput][] = [
  ["make", (i) => i],
  ["startMine", (i) => ({ ...i, roster: ["민수", "하늘"], iAmSubjectNow: true, quizInfo: { custom: true, about: "하늘", packId: "pack-new" } })],
  ["waiting", (i) => ({ ...i, iAmSubjectNow: false, quizInfo: { custom: true, about: "가나다라마바사아자차", packId: "pack-new" } })],
  ["again", (i) => ({ ...i, quizRecap: { ...(i.quizRecap ?? {}), subject: null, about: null }, quizInfo: { custom: false } })],
];
const STAGES = ["", "ask", "reasons", "thanks"];
const PRIMARY: Record<string, string> = { startMine: "startMineBtn", again: "againBtn", make: "makeBtn" };

for (const [name, input] of CASES) {
  for (const [nextName, apply] of NEXT) {
    for (const canMake of [false, true]) {
      test(`result layout: ${name} · next=${nextName} · canMake=${canMake} · every reaction stage`, async () => {
        const inp = input ? apply({ ...input, canMake }) : null;
        const vars = inp ? viewVars(inp) : { raceBoard: group.raceBoard };
        const view = inp ? buildResultView(inp) : null;
        for (const stage of STAGES) {
          const s = await scene({ ...vars, canMake, reactionStage: stage });
          assert.deepEqual(s.issues, [], `${stage || "no question"}: ${JSON.stringify(s.issues)}`);
          assert.deepEqual(s.warnings, [], `runtime warnings (${stage})`);
          const next = view?.next ?? "";
          const primary = PRIMARY[next] && (next !== "make" || canMake) ? PRIMARY[next] : null;
          const ids = [...(view && view.mode !== "" ? ["shareBtn"] : []), "inviteBtn", ...(primary ? [primary] : []), ...(next === "waiting" ? ["nextBanner"] : [])];
          const shown = ids.map((id) => [id, s.box(id)] as const);
          for (const [id, b] of shown) {
            assert.ok(b, `${id} shown`);
            assert.ok(onScreen(b!), `${id} on screen (${JSON.stringify(b)})`);
            if (id !== "nextBanner") assert.ok(b!.h >= 44, `${id} is a comfortable tap target`);
          }
          for (const id of Object.values(PRIMARY)) assert.equal(s.box(id) !== null, id === primary, `${id} only in its state`);
          assert.equal(s.box("shareBtn") !== null, Boolean(view && view.mode !== ""), "결과 공유 hidden without a result");
          const card = s.box("reactCard");
          assert.equal(card !== null, stage !== "", "the question card follows reactionStage");
          if (card) for (const [id, b] of shown) assert.ok(!overlaps(card, b!), `the question card covers ${id}`);
          for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) assert.ok(!overlaps(shown[i][1]!, shown[j][1]!), `${shown[i][0]} overlaps ${shown[j][0]}`);
          // The shell's reaction button sits top-right under the people chip:
          // the header keeps x > 306 free down to y = 147 (59 + 88).
          const head = s.box("resHead")!;
          assert.ok(head.x + head.w <= 306 && s.box("resBody")!.y >= 147, "top-right corner is free for the shell");
        }
      });
    }
  }
}

test("다시 하기 / 내 퀴즈 시작하기 send exactly the lobby's start actions", () => {
  const actionsOf = (id: string) => {
    let found: unknown = null;
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (o.id === id) found = o.onTap;
        Object.values(o).forEach(walk);
      }
    };
    walk(DOC.view);
    return (found as { then: unknown }[]).find((a) => "then" in a)!.then;
  };
  const lobby = actionsOf("startBtn");
  assert.deepEqual(actionsOf("againBtn"), lobby);
  assert.deepEqual(actionsOf("startMineBtn"), lobby);
});

test("a 10-grapheme nickname is drawn whole on one line in the ranking", async () => {
  const s = await scene(viewVars({ ...group, myNick: "하늘" }));
  const nick = s.byId("rkNick").find((i) => i.text?.lines[0]?.text.startsWith(LONG_NICK[0]))!;
  assert.equal(nick.text!.lines.length, 1);
  assert.equal(nick.text!.lines[0].text, LONG_NICK);
});

// #92: the hit rate + average time ("5/6 맞힘 · 83% · 평균 2.0초") sits on its own
// line under the nick and is drawn whole — with a 10-grapheme nick, 4-digit scores,
// ties (공동 1위), the leaver tag (나감) and a slow average. The frame is laid out at
// 390×844 and the renderer scales it uniformly to the phone (bite-pixi renderer.js
// fit, canvasFit.ts), so 360×640 is the same layout drawn smaller: the check is the
// laid-out text, then each line's box scaled into the 360×640 canvas.
test("the rank rows' hit-rate line and the 내 순위 line are never cut (390×844 and 360×640)", async () => {
  // The widest a label gets: 10 questions at most, the 9-second answer window, 5-digit points.
  const widest = (v: ReturnType<typeof buildResultView>) => ({
    ...v,
    ranks: v.ranks.map((r) => ({ ...r, scoreLabel: "10,000점", accuracyLabel: "10/10 맞힘 · 100% · 평균 8.9초" })),
    mine: v.mine && v.mine.replace(/ · .*/, "").replace(/$/, " · 10,000점 · 10/10 · 100% · 평균 8.9초"),
  });
  for (const myNick of [LONG_NICK, "하늘", "서준"]) {
    const real = buildResultView({ ...group, myNick });
    assert.ok(real.ranks.some((r) => r.nick === LONG_NICK) && real.ranks.some((r) => r.rankLabel.startsWith("공동")) && real.ranks.some((r) => r.left), "fixture: long nick, tie, leaver");
    assert.ok(real.ranks.filter((r) => !r.left).every((r) => r.score >= 1000), "fixture: 4-digit scores");
    for (const [name, view] of [["fixture", real], ["widest labels", widest(real)]] as const) {
      const s = await scene({ ...viewVars({ ...group, myNick }), resultView: view });
      assert.deepEqual(s.issues, [], `${name}: ${JSON.stringify(s.issues)}`);
      const acc = s.byId("rkAcc");
      assert.equal(acc.length, view.ranks.length, `${name}: one hit-rate line per row`);
      acc.forEach((inst, i) => {
        assert.deepEqual(inst.text!.lines.map((l) => l.text), [view.ranks[i].accuracyLabel], `${name}: row ${i + 1} drawn whole`);
        const b = s.boxes.get(inst.key)!;
        for (const [w, h] of [[390, 844], [360, 640]]) {
          const k = Math.min(w / 390, (h - canvasDrop(w, h)) / 844);
          assert.ok(b.x >= 0 && (b.x + b.w) * k <= w, `${name}: row ${i + 1} inside ${w}×${h}`);
        }
      });
      for (const id of ["rkNick", "rkScore", "rkRank"]) {
        const field = { rkNick: "nick", rkScore: "scoreLabel", rkRank: "rankLabel" }[id] as "nick";
        assert.deepEqual(s.byId(id).map((i) => i.text!.lines.map((l) => l.text)), view.ranks.map((r) => [r[field]]), `${name}: ${id} whole`);
      }
      const mine = s.byId("resMine")[0];
      if (view.mine) assert.deepEqual(mine.text!.lines.map((l) => l.text), [view.mine], `${name}: 내 순위 line whole (${myNick})`);
    }
  }
  assert.match(buildResultView({ ...group, myNick: "하늘" }).ranks[0].accuracyLabel, /^5\/6 맞힘 · 83% · 평균 2\.0초$/);
});

test("20 answerers × 20 questions still fits (the body scrolls)", async () => {
  const nicks = Array.from({ length: 20 }, (_, i) => `플레이어${i + 1}번째`);
  const rounds = Array.from({ length: 20 }, (_, r) => ({
    q: `아주 긴 질문 ${r + 1}: 민수가 어릴 때 제일 좋아했던 만화 캐릭터는 누구였을까요?`,
    options: ["엄청나게 긴 보기 이름 하나", "둘", "셋", "넷"], answer: r % 4,
    picks: nicks.map((nick, i) => ({ pid: `p${i}`, nick, option: (i + r) % 5 - 1, correct: (i + r) % 5 - 1 === r % 4, points: (i + r) % 5 - 1 === r % 4 ? 500 : 0 })),
  }));
  const s = await scene(viewVars({ quizRecap: { subject: "민수", rounds }, raceBoard: nicks.slice(0, 8).map((nick, i) => ({ pid: `p${i}`, nick, score: 1000 - i })), roster: [] }, { reactionStage: "reasons" }));
  assert.deepEqual(s.issues, []);
});
