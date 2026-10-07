// Lay out an expanded instance tree with Yoga. Writes `box` ({x, y, w, h},
// relative to the parent instance) onto every instance, plus `text` (final
// lines) on text instances and `content` size on scroll boxes.
import { loadYoga, Align, Edge, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType } from "yoga-layout/load";
import { measureText } from "./measure.js";

let Yoga = null;
let config = null;

/** Load the Yoga WASM module once. Must resolve before layout(). */
export async function initLayout() {
  if (Yoga) return;
  Yoga = await loadYoga();
  config = Yoga.Config.create();
  config.setPointScaleFactor(1); // whole pixels everywhere → identical results in Node and browsers
}

const ALIGN = { start: Align.FlexStart, center: Align.Center, end: Align.FlexEnd, stretch: Align.Stretch };
const JUSTIFY = { start: Justify.FlexStart, center: Justify.Center, end: Justify.FlexEnd, between: Justify.SpaceBetween };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function padOf(pad) {
  if (typeof pad === "number") return [pad, pad, pad, pad];
  if (Array.isArray(pad) && pad.length === 2) return [pad[0], pad[1], pad[0], pad[1]];
  if (Array.isArray(pad) && pad.length === 4) return pad.map((n) => num(n) ?? 0);
  return [0, 0, 0, 0];
}

function textStyle(s) {
  return { font: s.font, size: s.size, weight: s.weight, lines: s.lines };
}

// `parent` = { layout, align } of the parent box ("cell" for grid cells).
function applyItem(yn, inst, parent) {
  const s = inst.style;
  const mainDim = parent.layout === "row" || parent.layout === "cell" ? "width" : "height";
  for (const dim of ["width", "height"]) {
    const v = s[dim];
    const set = dim === "width" ? (x) => yn.setWidth(x) : (x) => yn.setHeight(x);
    const setPct = dim === "width" ? (x) => yn.setWidthPercent(x) : (x) => yn.setHeightPercent(x);
    if (parent.layout === "cell" && dim === "width") continue; // grid decides cell width
    if (num(v) !== undefined) set(v);
    else if (v === "fill") {
      if (parent.layout === "free") setPct(100);
      else if (dim === mainDim) {
        yn.setFlexGrow(num(s.grow) ?? 1);
        yn.setFlexShrink(1);
        yn.setFlexBasis(0);
      } else yn.setAlignSelf(Align.Stretch);
    } else if (v === "hug" && dim !== mainDim && parent.align === "stretch" && parent.layout !== "free") {
      yn.setAlignSelf(Align.FlexStart);
    }
  }
  // `fill` on the main axis already set flexGrow; otherwise grow applies as-is
  // (e.g. a spacer with width: fill + grow: 1 in a column grows vertically).
  if (num(s.grow) !== undefined && s[mainDim] !== "fill" && parent.layout !== "free") yn.setFlexGrow(s.grow);
  if (num(s.minWidth) !== undefined) yn.setMinWidth(s.minWidth);
  if (num(s.minHeight) !== undefined) yn.setMinHeight(s.minHeight);
  if (num(s.maxWidth) !== undefined) yn.setMaxWidth(s.maxWidth);
  if (num(s.maxHeight) !== undefined) yn.setMaxHeight(s.maxHeight);
  if (parent.layout === "free") {
    yn.setPositionType(PositionType.Absolute);
    yn.setPosition(Edge.Left, num(s.x) ?? 0);
    yn.setPosition(Edge.Top, num(s.y) ?? 0);
  }
}

function applyBox(yn, inst) {
  const s = inst.style;
  const [t, r, b, l] = padOf(s.pad);
  yn.setPadding(Edge.Top, t);
  yn.setPadding(Edge.Right, r);
  yn.setPadding(Edge.Bottom, b);
  yn.setPadding(Edge.Left, l);
  yn.setFlexDirection(inst.layout === "row" ? FlexDirection.Row : FlexDirection.Column);
  if (inst.layout !== "free") yn.setGap(Gutter.All, num(s.gap) ?? 0);
  yn.setAlignItems(ALIGN[s.align] ?? Align.Stretch);
  yn.setJustifyContent(JUSTIFY[s.justify] ?? Justify.FlexStart);
  if (s.scroll) yn.setOverflow(Overflow.Scroll);
}

function buildNode(inst, parent, links) {
  const yn = Yoga.Node.create(config);
  links.push({ inst, yn });
  applyItem(yn, inst, parent);

  if (inst.kind === "text") {
    // Shrink only along a row, where a narrower box means wrapping. In a column
    // a text must keep its content height (Yoga has no CSS min-height:auto).
    if (parent.layout === "row") yn.setFlexShrink(1);
    const style = textStyle(inst.style);
    yn.setMeasureFunc((width, widthMode) => {
      const max = widthMode === MeasureMode.Undefined ? Infinity : width;
      const m = measureText(inst.content, style, max);
      return { width: widthMode === MeasureMode.Exactly ? width : Math.ceil(m.width), height: m.height };
    });
    return yn;
  }
  if (inst.kind !== "box") return yn;

  applyBox(yn, inst);
  const me = { layout: inst.layout, align: inst.style.align ?? "stretch" };
  if (inst.layout === "grid") {
    const cols = Math.max(1, Math.floor(num(inst.style.columns) ?? 1));
    const gap = num(inst.style.gap) ?? 0;
    for (let i = 0; i < inst.children.length; i += cols) {
      const row = Yoga.Node.create(config);
      row.setFlexDirection(FlexDirection.Row);
      row.setGap(Gutter.All, gap);
      row.setAlignItems(Align.Stretch);
      yn.insertChild(row, yn.getChildCount());
      for (let c = 0; c < cols; c++) {
        const child = inst.children[i + c];
        const at = links.length; // the child's own link (its descendants follow)
        const cell = child ? buildNode(child, { layout: "cell", align: "stretch" }, links) : Yoga.Node.create(config);
        cell.setFlexGrow(1);
        cell.setFlexShrink(1);
        cell.setFlexBasis(0);
        if (child) links[at].row = row; // its position is relative to this row wrapper
        row.insertChild(cell, row.getChildCount());
      }
    }
    return yn;
  }
  for (const child of inst.children) yn.insertChild(buildNode(child, me, links), yn.getChildCount());
  return yn;
}

/** Compute boxes for the whole tree. The root is forced to the frame size. */
export function layout(root, frame) {
  if (!Yoga) throw new Error("bite-layout: await initLayout() before layout()");
  const [fw, fh] = frame;
  const links = [];
  const rootStyle = { ...root.style, width: fw, height: fh, x: 0, y: 0 };
  const yn = buildNode({ ...root, style: rootStyle }, { layout: "free", align: "stretch" }, links);
  links[0].inst = root; // buildNode saw a shallow copy for the forced size
  yn.calculateLayout(fw, fh);

  for (const l of links) {
    const { inst } = l;
    // A grid child's position is relative to its row wrapper.
    let x = l.yn.getComputedLeft();
    let y = l.yn.getComputedTop();
    if (l.row) {
      x += l.row.getComputedLeft();
      y += l.row.getComputedTop();
    }
    inst.box = { x, y, w: l.yn.getComputedWidth(), h: l.yn.getComputedHeight() };
    if (inst.kind === "text") {
      const m = measureText(inst.content, textStyle(inst.style), inst.box.w);
      inst.text = { lines: m.lines, lineHeight: m.lineHeight, weight: m.weight };
    }
  }
  root.box = { x: 0, y: 0, w: fw, h: fh };
  for (const { inst } of links) {
    if (inst.style.scroll) {
      const [, r, b] = padOf(inst.style.pad);
      let cw = 0;
      let ch = 0;
      for (const c of inst.children) {
        cw = Math.max(cw, c.box.x + c.box.w);
        ch = Math.max(ch, c.box.y + c.box.h);
      }
      inst.contentSize = { w: cw + r, h: ch + b };
    }
  }
  yn.freeRecursive();
  return root;
}
