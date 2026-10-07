// Hit-testing and geometry queries over a laid-out instance tree. Pure data,
// so the renderer and headless gates resolve taps the same way.

const clips = (inst) => Boolean(inst.style?.clip || inst.style?.scroll);
const scrollOf = (scroll, key) => scroll?.get(key) ?? { x: 0, y: 0 };

/**
 * Find the instance that receives a tap at frame point (x, y): the last
 * painted instance with an onTap whose box contains the point. Instances
 * without onTap let the tap through; clipped/scrolled boxes hide what lies
 * outside them.
 * @param {Map<string, {x: number, y: number}>} [scroll] scroll offsets by instance key
 */
export function hitTest(root, x, y, scroll) {
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    const inside = x >= ax && x < ax + inst.box.w && y >= ay && y < ay + inst.box.h;
    if (clips(inst) && !inside) return null;
    const off = scrollOf(scroll, inst.key);
    for (let i = inst.children.length - 1; i >= 0; i--) {
      const hit = walk(inst.children[i], ax - off.x, ay - off.y);
      if (hit) return hit;
    }
    return inst.tap && inside ? inst : null;
  };
  return walk(root, -root.box.x, -root.box.y);
}

/** Absolute frame boxes for every instance, keyed by instance key. */
export function absBoxes(root, scroll) {
  const out = new Map();
  const walk = (inst, ox, oy) => {
    const box = { x: ox + inst.box.x, y: oy + inst.box.y, w: inst.box.w, h: inst.box.h };
    out.set(inst.key, box);
    const off = scrollOf(scroll, inst.key);
    for (const c of inst.children) walk(c, box.x - off.x, box.y - off.y);
  };
  walk(root, -root.box.x, -root.box.y);
  return out;
}

/** All instances whose source node has the given id (several inside `each`). */
export function findInstances(root, id) {
  const out = [];
  const walk = (inst) => {
    if (inst.node?.id === id) out.push(inst);
    inst.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Static layout lint for gates: text that does not fit its box, children that
 * spill out of a flowing parent, and visible nodes that leave the frame
 * (outside scroll boxes).
 */
export function checkLayout(root, frame) {
  const [fw, fh] = frame;
  const issues = [];
  const walk = (inst, ox, oy, inScroll) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    const where = inst.node?.id ?? inst.key;
    if (inst.kind === "text" && inst.text) {
      const h = inst.text.lines.length * inst.text.lineHeight;
      const w = inst.text.lines.reduce((m, l) => Math.max(m, l.width), 0);
      if (h > inst.box.h + 0.5) issues.push({ key: inst.key, where, kind: "text-overflow-y", detail: `${Math.ceil(h)} > ${inst.box.h}` });
      if (w > inst.box.w + 0.5) issues.push({ key: inst.key, where, kind: "text-overflow-x", detail: `${Math.ceil(w)} > ${inst.box.w}` });
    }
    if (!inScroll && inst.box.w > 0 && inst.box.h > 0 && (ax < -0.5 || ay < -0.5 || ax + inst.box.w > fw + 0.5 || ay + inst.box.h > fh + 0.5)) {
      issues.push({ key: inst.key, where, kind: "off-frame", detail: `${ax},${ay} ${inst.box.w}×${inst.box.h}` });
    }
    // Children of a flowing (non-free) box should stay inside it.
    if (inst.kind === "box" && inst.layout !== "free" && !inst.style?.scroll) {
      for (const c of inst.children) {
        const b = c.box;
        if (b.w > 0 && b.h > 0 && (b.x < -0.5 || b.y < -0.5 || b.x + b.w > inst.box.w + 0.5 || b.y + b.h > inst.box.h + 0.5)) {
          issues.push({ key: c.key, where: c.node?.id ?? c.key, kind: "overflow-parent", detail: `${b.x},${b.y} ${b.w}×${b.h} in ${inst.box.w}×${inst.box.h}` });
        }
      }
    }
    for (const c of inst.children) walk(c, ax, ay, inScroll || Boolean(inst.style?.scroll));
  };
  walk(root, -root.box.x, -root.box.y, false);
  return issues;
}

/** Deepest scroll box containing frame point (x, y), or null. */
export function scrollTargetAt(root, x, y, scroll) {
  let found = null;
  const walk = (inst, ox, oy) => {
    const ax = ox + inst.box.x;
    const ay = oy + inst.box.y;
    const inside = x >= ax && x < ax + inst.box.w && y >= ay && y < ay + inst.box.h;
    if (clips(inst) && !inside) return;
    if (inst.style?.scroll && inside) found = inst;
    const off = scrollOf(scroll, inst.key);
    for (const c of inst.children) walk(c, ax - off.x, ay - off.y);
  };
  walk(root, -root.box.x, -root.box.y);
  return found;
}
