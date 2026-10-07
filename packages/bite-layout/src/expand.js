// Expand a Bite document into an instance tree for the current state:
// components inlined, `each` repeated, hidden nodes dropped, every template
// evaluated. The result is plain data shared by layout, hit-testing and the
// renderer.
import { compileExpr, templateDeps } from "@snack/bite";

const STRUCTURAL = new Set(["id", "show", "onTap", "each", "children", "use", "props", "box", "text", "image"]);
// Keys a component instance may set on the component's root node.
const INSTANCE_KEYS = ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "grow", "x", "y", "opacity", "rotate", "scale", "origin"];

const kindOf = (node) => ("text" in node ? "text" : "image" in node ? "image" : "use" in node ? "use" : "box");

/**
 * @typedef {object} Instance
 * @property {string} key          stable identity across frames
 * @property {"box"|"text"|"image"} kind
 * @property {string} layout       box layout: column | row | grid | free
 * @property {object} node         source node
 * @property {object} style        evaluated properties
 * @property {string} [content]    text content / image url
 * @property {{actions: object[], scope: object, node: object}} [tap]
 * @property {object} [source]     the `use` node when this is a component root
 * @property {Instance[]} children
 */

/** @returns {{ root: Instance, deps: Set<string> }} */
export function expand(doc, app) {
  const deps = new Set();
  const components = doc.components ?? {};

  const track = (str) => {
    if (typeof str === "string" && str.includes("{")) for (const d of templateDeps(str)) deps.add(d);
  };
  const resolve = (v, scope) => {
    if (typeof v === "string") {
      track(v);
      return app.value(v, scope);
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, scope));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = resolve(x, scope);
      return out;
    }
    return v;
  };
  const evalExpr = (src, scope) => {
    for (const d of compileExpr(src).deps) deps.add(d);
    return app.eval(src, scope);
  };

  const build = (node, scope, key, override) => {
    if (!node || typeof node !== "object") return null;
    if ("show" in node && !evalExpr(node.show, scope)) return null;

    if ("use" in node) {
      const def = components[node.use];
      if (!def) return null;
      const props = { ...(def.props ?? {}) };
      for (const [k, v] of Object.entries(node.props ?? {})) props[k] = resolve(v, scope);
      const inst = {};
      for (const k of INSTANCE_KEYS) if (k in node) inst[k] = resolve(node[k], scope);
      const tap = node.onTap ? { actions: node.onTap, scope, node } : undefined;
      const built = build(def.view, { props }, key, { style: { ...override?.style, ...inst }, tap: override?.tap ?? tap });
      if (built && !override?.source) built.source = node; // the `use` node this instance came from
      return built;
    }

    const kind = kindOf(node);
    const style = {};
    for (const [k, v] of Object.entries(node)) if (!STRUCTURAL.has(k)) style[k] = resolve(v, scope);
    if (override?.style) Object.assign(style, override.style);

    const instance = {
      key,
      kind,
      layout: kind === "box" ? (node.box ?? "column") : null,
      node,
      style,
      children: [],
    };
    const tap = override?.tap ?? (node.onTap ? { actions: node.onTap, scope, node } : undefined);
    if (tap) instance.tap = tap;
    if (kind === "text") {
      track(node.text);
      const v = app.value(node.text, scope);
      instance.content = v == null ? "" : String(v);
    } else if (kind === "image") {
      track(node.image);
      const v = app.value(node.image, scope);
      instance.content = v == null ? "" : String(v);
    } else if ("each" in node) {
      const list = evalExpr(node.each, scope);
      (Array.isArray(list) ? list : []).forEach((item, index) => {
        const inner = { ...scope, item, index };
        (node.children ?? []).forEach((c, ci) => {
          const child = build(c, inner, `${key}/${c.id ?? ci}#${index}`);
          if (child) instance.children.push(child);
        });
      });
    } else {
      (node.children ?? []).forEach((c, ci) => {
        const child = build(c, scope, `${key}/${c.id ?? ci}`);
        if (child) instance.children.push(child);
      });
    }
    return instance;
  };

  const root = build(doc.view, {}, "view") ?? { key: "view", kind: "box", layout: "free", node: {}, style: {}, children: [] };
  return { root, deps };
}
