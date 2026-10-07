import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createBite } from "@snack/bite";
import { initLayout, computeScene, absBoxes, hitTest, findInstances, checkLayout, measureText } from "../src/index.js";

before(() => initLayout());

const scene = (view, extra = {}) => {
  const doc = {
    bite: 1,
    meta: { name: "t" },
    frame: [390, 844],
    vars: { open: true, list: ["a", "b", "c"], n: 3 },
    start: "a",
    phases: { a: {} },
    view,
    ...extra,
  };
  const app = createBite(doc, { now: () => 0, random: () => 0 });
  app.start();
  const { root, deps } = computeScene(doc, app);
  const boxes = absBoxes(root);
  const box = (id) => boxes.get(findInstances(root, id)[0].key);
  return { root, deps, boxes, box, app, doc };
};

test("column: padding, gap, stretch, fill on the main axis", () => {
  const { box } = scene({
    box: "column",
    pad: [10, 20],
    gap: 8,
    children: [
      { id: "a", height: 100 },
      { id: "b", height: "fill" },
      { id: "c", height: 50 },
    ],
  });
  assert.deepEqual(box("a"), { x: 20, y: 10, w: 350, h: 100 });
  assert.deepEqual(box("b"), { x: 20, y: 118, w: 350, h: 844 - 10 - 10 - 100 - 50 - 16 });
  assert.deepEqual(box("c"), { x: 20, y: 844 - 10 - 50, w: 350, h: 50 });
});

test("row: fill splits remaining space, hug keeps content size, align center", () => {
  const { box } = scene({
    box: "column",
    children: [
      {
        box: "row",
        height: 60,
        gap: 10,
        align: "center",
        children: [
          { id: "l", width: 40, height: 40 },
          { id: "m", width: "fill", height: 20 },
          { id: "r", width: "fill", height: 20 },
        ],
      },
      { box: "column", children: [{ id: "hug", box: "row", width: "hug", children: [{ width: 30, height: 10 }] }] },
    ],
  });
  assert.deepEqual(box("l"), { x: 0, y: 10, w: 40, h: 40 });
  assert.equal(box("m").w, box("r").w);
  assert.equal(box("m").w, (390 - 40 - 20) / 2);
  assert.equal(box("m").y, 20);
  assert.equal(box("hug").w, 30);
});

test("grow on the main axis works next to fill on the cross axis (spacer)", () => {
  const { box } = scene({
    box: "column",
    children: [{ id: "card", height: 250 }, { id: "spacer", width: "fill", height: 1, grow: 1 }, { id: "btn", height: 50 }],
  });
  assert.equal(box("btn").y, 844 - 50);
  assert.equal(box("spacer").h, 844 - 250 - 50);
});

test("justify between and end", () => {
  const { box } = scene({
    box: "row",
    justify: "between",
    children: [{ id: "a", width: 50, height: 10 }, { id: "b", width: 50, height: 10 }],
  });
  assert.equal(box("a").x, 0);
  assert.equal(box("b").x, 340);
});

test("grid: equal columns with gap, short last row keeps cell width", () => {
  const { box } = scene({
    box: "grid",
    columns: 3,
    gap: 10,
    pad: 10,
    children: [1, 2, 3, 4].map((i) => ({ id: `g${i}`, height: 40 })),
  });
  const cell = (390 - 20 - 20) / 3;
  assert.deepEqual(box("g1"), { x: 10, y: 10, w: Math.round(cell), h: 40 });
  assert.equal(box("g3").x + box("g3").w, 380);
  assert.deepEqual([box("g4").x, box("g4").y], [10, 60]);
  assert.equal(box("g4").w, box("g1").w);
});

test("free: x/y positioning and fill = 100%", () => {
  const { box } = scene({
    box: "free",
    children: [
      { id: "bg", width: "fill", height: "fill" },
      { id: "mole", x: 120, y: 300, width: 60, height: 60 },
    ],
  });
  assert.deepEqual(box("bg"), { x: 0, y: 0, w: 390, h: 844 });
  assert.deepEqual(box("mole"), { x: 120, y: 300, w: 60, h: 60 });
});

test("show removes nodes from layout; each repeats children with item/index", () => {
  const { root, box } = scene({
    box: "column",
    children: [
      { id: "hidden", show: "!open", height: 500 },
      { id: "list", box: "column", gap: 4, each: "list", children: [{ id: "row", text: "{index}:{item}" }] },
    ],
  });
  assert.equal(findInstances(root, "hidden").length, 0);
  const rows = findInstances(root, "row");
  assert.deepEqual(rows.map((r) => r.content), ["0:a", "1:b", "2:c"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
  assert.equal(box("list").y, 0);
});

test("components: props evaluated in the caller's scope, instance size applies to the root", () => {
  const { root, box } = scene(
    { box: "column", children: [{ id: "card", use: "Card", width: 200, props: { label: "n={n}" } }] },
    { components: { Card: { props: { label: "" }, view: { box: "column", height: 80, children: [{ id: "lbl", text: "{props.label}" }] } } } },
  );
  assert.equal(findInstances(root, "lbl")[0].content, "n=3");
  const cardKey = root.children[0].key;
  assert.equal(root.children[0].style.width, 200);
  assert.equal(absBoxes(root).get(cardKey).h, 80);
  assert.equal(box("lbl").w, 200);
});

test("deps collect variables, phase and specials used by the current view", () => {
  const { deps } = scene({ box: "column", show: "phase == 'a'", children: [{ text: "{n} {open}" }] });
  assert.deepEqual([...deps].sort(), ["n", "open", "phase"]);
});

test("text: Korean keep-all wrapping, long-word break, newline, ellipsis", () => {
  const style = { size: 20, weight: 500 };
  const one = measureText("가나다", style).width; // 3 Hangul
  assert.equal(one, 3 * 20 * (1770 / 2048));
  const wrapped = measureText("가나다 라마바 사아자", style, one * 2 + 10);
  assert.deepEqual(wrapped.lines.map((l) => l.text), ["가나다 라마바", "사아자"]); // space ≈ 4.9px fits in the 10px slack
  const longWord = measureText("가나다라마바사", style, one);
  assert.deepEqual(longWord.lines.map((l) => l.text), ["가나다", "라마바", "사"]);
  assert.equal(measureText("a\nb", style).lines.length, 2);
  const cut = measureText("가나다 라마바 사아자 차카타", { ...style, lines: 1 }, one * 2);
  assert.equal(cut.lines.length, 1);
  assert.ok(cut.lines[0].text.endsWith("…"));
  assert.ok(cut.lines[0].width <= one * 2);
  assert.equal(measureText("", style).lines.length, 1);
  assert.equal(measureText("x", { size: 20 }).lineHeight, 27);
  assert.equal(measureText("x", { size: 20, font: "display", weight: 800 }).weight, 700);
});

test("text in a column wraps to the column width and grows its height", () => {
  const long = "아주 긴 문장이 여러 줄로 나뉘어야 하는 경우를 확인합니다 줄바꿈 테스트";
  const { root } = scene({ box: "column", children: [{ box: "column", width: 120, children: [{ id: "t", text: long, size: 16 }] }] });
  const t = findInstances(root, "t")[0];
  assert.ok(t.text.lines.length > 2);
  assert.equal(t.box.h, t.text.lines.length * t.text.lineHeight);
  assert.ok(t.text.lines.every((l) => l.width <= 120));
  assert.deepEqual(checkLayout(root, [390, 844]), []);
});

test("text keeps its height in a crowded column, still wraps in a row", () => {
  const { root } = scene({
    box: "column",
    children: [
      { box: "column", height: 100, children: [{ height: 80 }, { id: "big", text: "◎", size: 60 }] },
      { box: "row", width: 120, children: [{ width: 40, height: 10 }, { id: "wrap", text: "가나다 라마바 사아자" }] },
    ],
  });
  const big = findInstances(root, "big")[0];
  assert.equal(big.box.h, big.text.lineHeight); // not squeezed to the 20px left over
  const wrap = findInstances(root, "wrap")[0];
  assert.ok(wrap.box.w <= 80 && wrap.text.lines.length > 1);
});

test("hit test: topmost tappable wins, untappable passes through, clip hides", () => {
  const { root } = scene({
    box: "free",
    children: [
      { id: "under", x: 0, y: 0, width: 200, height: 200, onTap: [] },
      { id: "cover", x: 0, y: 0, width: 200, height: 200 },
      { id: "top", x: 50, y: 50, width: 50, height: 50, onTap: [] },
      { id: "clipper", x: 300, y: 0, width: 40, height: 40, clip: true, box: "free", children: [{ id: "spill", x: 0, y: 0, width: 80, height: 80, onTap: [] }] },
    ],
  });
  assert.equal(hitTest(root, 60, 60).node.id, "top");
  assert.equal(hitTest(root, 10, 10).node.id, "under");
  assert.equal(hitTest(root, 310, 10).node.id, "spill");
  assert.equal(hitTest(root, 360, 60), null); // spill is outside its clipping parent
  assert.equal(hitTest(root, 250, 300), null);
});

test("scroll: content size and offset-aware hit test", () => {
  const { root } = scene({
    box: "column",
    children: [
      {
        id: "list",
        box: "column",
        height: 100,
        scroll: true,
        children: [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, height: 50, onTap: [] })),
      },
    ],
  });
  const list = findInstances(root, "list")[0];
  assert.deepEqual(list.contentSize, { w: 390, h: 250 });
  assert.equal(hitTest(root, 10, 10).node.id, "r1");
  const scroll = new Map([[list.key, { x: 0, y: 120 }]]);
  assert.equal(hitTest(root, 10, 10, scroll).node.id, "r3");
  assert.equal(hitTest(root, 10, 150, scroll), null); // below the scroll viewport
});

test("checkLayout flags overflowing text and off-frame nodes", () => {
  const { root } = scene({
    box: "free",
    children: [
      { id: "t", x: 0, y: 0, width: 60, height: 20, box: "column", children: [{ id: "tt", text: "넘치는 텍스트 넘치는 텍스트", height: 20 }] },
      { id: "far", x: 380, y: 10, width: 40, height: 40 },
    ],
  });
  const kinds = checkLayout(root, [390, 844]).map((i) => `${i.where}:${i.kind}`);
  assert.ok(kinds.includes("tt:text-overflow-y"));
  assert.ok(kinds.includes("far:off-frame"));
});

test("layout is deterministic", () => {
  const view = { box: "column", pad: 16, gap: 12, children: [{ text: "결정적 레이아웃 확인 Deterministic 123", size: 17 }, { box: "grid", columns: 2, gap: 8, children: [1, 2, 3].map(() => ({ height: 30 })) }] };
  const a = [...scene(view).boxes.values()];
  const b = [...scene(view).boxes.values()];
  assert.deepEqual(a, b);
});
