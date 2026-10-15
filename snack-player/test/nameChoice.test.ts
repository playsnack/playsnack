// "이름 정하기" card (#104): who sees it, the IME guard, choosing ends it, and where it sits
// (never over a template's lobby button or the shell's own buttons, at 360×640 and 390×844).
// node --import tsx --test snack-player/test/   (pnpm player:test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBite } from "../../packages/bite/src/index.js";
import { absBoxes, computeScene, initLayout } from "../../packages/bite-layout/src/index.js";
import { nameCardFrameBox, nameCardRect, nickToCommit, showNameCard, typedNick, type NameCardState } from "../src/nameChoice.ts";
import { PILLS_BOTTOM } from "../src/canvasFit.ts";

// A browser-like localStorage for identity.ts (read at call time).
const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
});
const { getNick, isNickAuto, setNick } = await import("../src/identity.ts");

const base: NameCardState = { auto: true, chosen: false, live: true, phase: "lobby", covered: false };

test("shows only for an auto-assigned name, in a connected room's lobby", () => {
  assert.equal(showNameCard(base), true);
  assert.equal(showNameCard({ ...base, phase: "" }), true, "a new room has no phase yet: the lobby");
  assert.equal(showNameCard({ ...base, auto: false }), false, "a name the person chose");
  assert.equal(showNameCard({ ...base, live: false }), false, "connecting / failed / solo");
  for (const phase of ["countdown", "play", "result"]) assert.equal(showNameCard({ ...base, phase }), false, phase);
  assert.equal(showNameCard({ ...base, covered: true }), false, "maker / last result / a shell notice on top");
});

test("hides after a choice — kept or changed — and does not come back on the next visit", () => {
  data.clear();
  setNick("느긋한 치킨", { auto: true }); // what App does for a share link
  assert.equal(showNameCard({ ...base, auto: isNickAuto() }), true);
  // "이 이름 그대로": the same name, now chosen
  setNick(getNick()!);
  assert.equal(getNick(), "느긋한 치킨");
  assert.equal(isNickAuto(), false);
  assert.equal(showNameCard({ ...base, auto: isNickAuto(), chosen: true }), false);
  assert.equal(showNameCard({ ...base, auto: isNickAuto() }), false, "a later page load: not auto any more");
  // "바꾸기"
  data.clear();
  setNick("느긋한 치킨", { auto: true });
  setNick(nickToCommit("  민지  ")!);
  assert.equal(getNick(), "민지");
  assert.equal(showNameCard({ ...base, auto: isNickAuto() }), false);
  // storage that forgets: the page's own `chosen` still hides it
  assert.equal(showNameCard({ ...base, auto: true, chosen: true }), false);
});

test("IME guard: a composing syllable is never cut; the 10-grapheme cap applies when it ends", () => {
  const long = "가나다라마바사아자차카타";
  assert.equal(typedNick(long, true), long, "while composing: untouched");
  assert.equal(typedNick(long, false), "가나다라마바사아자차", "after: 10 graphemes");
  assert.equal(typedNick("👩‍👩‍👧‍👦".repeat(12), false), "👩‍👩‍👧‍👦".repeat(10), "an emoji counts one");
  assert.equal(typedNick("민ㅈ", true), "민ㅈ");
  assert.equal(nickToCommit("   "), null, "blank: nothing to send");
  assert.equal(nickToCommit("  민지  "), "민지");
  assert.equal(nickToCommit("가나다라마바사아자차카"), "가나다라마바사아자차");
});

// ── where it sits ──
type Box = { x: number; y: number; w: number; h: number };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// The shell's own buttons (CSS px from the play area's top-left; shellDocks.test.ts frame zones at 390 wide).
const shellZones = (w: number): Record<string, Box> => ({
  topRow: { x: 0, y: 0, w, h: PILLS_BOTTOM },
  reactionFab: { x: w - 12 - 46, y: 62, w: 46, h: 46 + 4 },
  debugTab: { x: w - 12 - 46 - 6 - 32, y: 62, w: 32, h: 32 },
});
const VIEWPORTS: [number, number][] = [[360, 640], [390, 844]];

test("clear of the top-row pills, 💬 and 🪲 at 360 and 390 wide", () => {
  for (const [w] of VIEWPORTS) {
    const card = nameCardRect(w);
    assert.ok(card.w >= 240, `${w}: room for the field and 바꾸기 (${card.w})`);
    for (const [zone, z] of Object.entries(shellZones(w))) assert.ok(!hit(card, z), `${w}: overlaps ${zone}`);
    assert.ok(card.x >= 12 && card.x + card.w <= w - 12, `${w}: inside the screen`);
    assert.ok(Math.abs(card.x - (w - card.x - card.w)) < 1, `${w}: centred (#114)`);
  }
});

const DIR = new URL("../../snack-server/data/bite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", DIR), "utf8")) as { id: string; mode: string; hidden?: boolean }[];
const TOGETHER = index.filter((t) => t.mode === "multi" && !t.hidden).map((t) => t.id);
type Inst = { key: string; node: Record<string, unknown>; tap?: unknown; children: Inst[] };
function* walk(i: Inst): Generator<Inst> { yield i; for (const c of i.children) yield* walk(c); }
const ready = initLayout();

test("every together template: no lobby button under the card (360×640, 390×844)", async () => {
  await ready;
  assert.ok(TOGETHER.length >= 8, `found ${TOGETHER.length}`);
  for (const id of TOGETHER) {
    const doc = JSON.parse(readFileSync(new URL(`${id}.bite.json`, DIR), "utf8"));
    let t = 0;
    const app = createBite(doc, { now: () => t, random: () => 0.5, warn: () => {} });
    app.start();
    if ("sessionPhase" in (doc.vars ?? {})) app.setVars({ sessionPhase: "lobby", roster: ["가나다라마바사아자차", "하늘", "느긋한 치킨"], participants: 3 });
    for (let f = 0; f < 3; f++) { t += 16; app.tick(); }
    const { root } = computeScene(doc, app);
    const boxes = absBoxes(root, new Map()) as Map<string, Box>;
    const buttons = [...walk(root as unknown as Inst)].filter((i) => i.tap || i.node.onTap);
    assert.ok(buttons.length > 0, `${id}: no lobby button found (is the lobby rendered?)`);
    for (const [w, h] of VIEWPORTS) {
      const card = nameCardFrameBox(w, h, doc.frame ?? [390, 844]);
      for (const b of buttons) assert.ok(!hit(boxes.get(b.key)!, card), `${id} ${w}×${h}: lobby button ${b.key} ${JSON.stringify(boxes.get(b.key))} under the card ${JSON.stringify(card)}`);
    }
  }
});
