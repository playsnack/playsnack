import { expand } from "./expand.js";
import { layout } from "./layout.js";

export { expand } from "./expand.js";
export { initLayout, layout, padOf } from "./layout.js";
export { measureText, faceFor, TEXT_DEFAULTS, LINE_HEIGHT } from "./measure.js";
export { hitTest, absBoxes, findInstances, checkLayout, scrollTargetAt } from "./hit.js";

/**
 * Expand + lay out the document for the runtime's current state.
 * `deps` = names (variables, phase, now) the result depends on: recompute
 * only when a runtime `change` intersects it.
 */
export function computeScene(doc, app) {
  const { root, deps } = expand(doc, app);
  layout(root, doc.frame ?? [390, 844]);
  return { root, deps };
}
