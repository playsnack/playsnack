// Static validation of a Bite document. Errors mean "will not play correctly";
// warnings mean "plays, but probably not what the author meant". Messages are
// in English because they are fed back to the LLM for self-repair.
import { compileExpr, template, RESERVED, FUNCS } from "./expr.js";

const TOP_KEYS = new Set(["bite", "meta", "frame", "vars", "data", "components", "start", "phases", "view"]);
const META_KEYS = new Set(["name", "multi", "description"]);
const PHASE_KEYS = new Set(["enter", "tick"]);
const KIND_KEYS = ["box", "text", "image", "use"];

const COMMON = ["id", "show", "onTap", "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "grow", "x", "y", "opacity", "rotate", "scale", "origin"];
const KEYS = {
  box: new Set([...COMMON, "box", "children", "each", "gap", "pad", "align", "justify", "columns", "scroll", "fill", "gradient", "radius", "stroke", "shadow", "clip"]),
  text: new Set([...COMMON, "text", "font", "size", "weight", "color", "align", "lines"]),
  image: new Set([...COMMON, "image", "fit", "focus", "radius", "stroke", "shadow"]),
  use: new Set([...COMMON, "use", "props"]),
};
const ENUMS = {
  box: ["column", "row", "grid", "free"],
  boxAlign: ["start", "center", "end", "stretch"],
  textAlign: ["left", "center", "right"],
  justify: ["start", "center", "end", "between"],
  font: ["body", "display"],
  fit: ["cover", "contain"],
  focus: ["center", "top"],
};
const NUMERIC = ["minWidth", "minHeight", "maxWidth", "maxHeight", "grow", "x", "y", "opacity", "rotate", "scale", "gap", "columns", "size", "weight", "lines"];
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTemplate = (v) => typeof v === "string" && v.includes("{");
// Literal ranges the renderer relies on (outside them the node vanishes or flies off).
const RANGES = { opacity: [0, 1], weight: [100, 900] };
const typeOfJson = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isNumericString = (s) => s.trim() !== "" && Number.isFinite(Number(s));

/**
 * @param {unknown} doc
 * @param {{ hostActions?: Record<string, { payload: "none" | "object", number?: boolean,
 *   fields?: Record<string, { type: string | string[], required?: boolean, enum?: string[], text?: boolean }> }> }} [opts]
 *   hostActions — the room's payload contract (`@snack/room/actions` HOST_ACTIONS).
 *   With it, every `emit` is checked against what the room actually reads.
 */
export function validate(doc, { hostActions } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warning = (path, message) => warnings.push({ path, message });
  const used = new Set();

  if (!isObj(doc)) {
    err("", "document must be a JSON object");
    return { ok: false, errors, warnings };
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) err(k, `unknown top-level key '${k}'`);
  if (doc.bite !== 1) err("bite", "must be 1");

  if (!isObj(doc.meta)) err("meta", "required object { name }");
  else {
    if (typeof doc.meta.name !== "string" || !doc.meta.name) err("meta.name", "required string");
    if ("multi" in doc.meta && typeof doc.meta.multi !== "boolean") err("meta.multi", "must be boolean");
    for (const k of Object.keys(doc.meta)) if (!META_KEYS.has(k)) err(`meta.${k}`, `unknown key '${k}'`);
  }

  if (!Array.isArray(doc.frame) || doc.frame.length !== 2 || !doc.frame.every((n) => typeof n === "number" && n > 0)) {
    err("frame", "must be [width, height] in px, e.g. [390, 844]");
  }

  const vars = isObj(doc.vars) ? doc.vars : {};
  if (!isObj(doc.vars)) err("vars", "required object { name: initialValue }");
  for (const [name, v] of Object.entries(vars)) {
    if (!NAME_RE.test(name)) err(`vars.${name}`, "variable names must be identifiers");
    else if (RESERVED.has(name)) err(`vars.${name}`, `'${name}' is reserved`);
    else if (Object.hasOwn(FUNCS, name)) err(`vars.${name}`, `'${name}' is a built-in function name — pick another variable name`);
    if (v === undefined) err(`vars.${name}`, "needs an initial value");
  }

  if ("data" in doc) {
    if (!isObj(doc.data) || typeof doc.data.url !== "string") err("data", "must be { url }");
  }

  const phases = isObj(doc.phases) ? doc.phases : {};
  if (!isObj(doc.phases) || Object.keys(phases).length === 0) err("phases", "required object with at least one phase");
  if (typeof doc.start !== "string" || !Object.hasOwn(phases, doc.start)) err("start", `must name a phase (${Object.keys(phases).join(", ")})`);

  const components = isObj(doc.components) ? doc.components : {};
  if ("components" in doc && !isObj(doc.components)) err("components", "must be an object");

  // ── expressions ──
  const checkCompiled = (c, path, scope) => {
    if (c.error) return err(path, c.error);
    if (c.mathPrefix) warning(path, "drop the 'Math.' prefix (bare functions: round, floor, min, …)");
    for (const name of c.deps) {
      if (name === "phase" || name === "now") continue;
      if (name === "props") {
        if (!scope.component) err(path, "'props' is only available inside a component");
        continue;
      }
      if (name === "item" || name === "index") {
        if (!scope.each) err(path, `'${name}' is only available inside an 'each' box`);
        continue;
      }
      used.add(name);
      if (!Object.hasOwn(vars, name)) err(path, `unknown variable '${name}' — declare it in vars`);
    }
  };
  const checkExpr = (src, path, scope) => {
    if (typeof src !== "string" || !src.trim()) return err(path, "must be an expression string");
    checkCompiled(compileExpr(src), path, scope);
  };
  const checkTemplate = (str, path, scope) => {
    const t = template(str);
    if (t.error) err(path, t.error);
    for (const p of t.parts) if (typeof p !== "string") checkCompiled(p, path, scope);
  };
  const checkJson = (value, path, scope) => {
    if (typeof value === "string") checkTemplate(value, path, scope);
    else if (Array.isArray(value)) value.forEach((v, i) => checkJson(v, `${path}[${i}]`, scope));
    else if (isObj(value)) for (const [k, v] of Object.entries(value)) checkJson(v, `${path}.${k}`, scope);
  };

  // ── actions ──
  const checkActions = (list, path, scope) => {
    if (!Array.isArray(list)) return err(path, "must be an array of actions");
    list.forEach((a, i) => {
      const p = `${path}[${i}]`;
      if (!isObj(a)) return err(p, "action must be an object");
      const kinds = ["set", "go", "if", "emit"].filter((k) => k in a);
      if (kinds.length !== 1) return err(p, "action needs exactly one of set / go / if / emit");
      const allow = { set: ["set", "to", "value"], go: ["go"], if: ["if", "then", "else"], emit: ["emit", "payload"] }[kinds[0]];
      for (const k of Object.keys(a)) if (!allow.includes(k)) err(`${p}.${k}`, `unexpected key '${k}' in ${kinds[0]} action`);
      if ("set" in a) {
        if (typeof a.set !== "string" || !Object.hasOwn(vars, a.set)) err(`${p}.set`, `unknown variable '${a.set}' — declare it in vars`);
        else used.add(a.set);
        if (("to" in a) === ("value" in a)) err(p, "set needs exactly one of 'to' (expression) or 'value' (JSON)");
        if ("to" in a) checkExpr(a.to, `${p}.to`, scope);
      } else if ("go" in a) {
        if (typeof a.go !== "string" || !Object.hasOwn(phases, a.go)) err(`${p}.go`, `unknown phase '${a.go}'`);
      } else if ("if" in a) {
        checkExpr(a.if, `${p}.if`, scope);
        checkActions(a.then, `${p}.then`, scope);
        if ("else" in a) checkActions(a.else, `${p}.else`, scope);
      } else {
        if (typeof a.emit !== "string" || !a.emit) err(`${p}.emit`, "event name must be a string");
        if ("payload" in a) checkJson(a.payload, `${p}.payload`, scope);
        checkEmit(a, p);
      }
    });
  };

  // ── emit payloads vs. the host-action contract ──
  // A payload string is a template: "score" sends the TEXT "score", "{score}"
  // sends the variable's value. Sending a variable's name is always a bug,
  // except in a free-text field (start.game), where it only warns.
  const checkVarNameLiterals = (value, path, field) => {
    if (typeof value === "string") {
      if (template(value).kind === "literal" && Object.hasOwn(vars, value)) {
        const msg = `sends the literal text "${value}", not the variable's value — did you mean "{${value}}"?`;
        if (field?.text) warning(path, msg);
        else err(path, msg);
      }
    } else if (Array.isArray(value)) value.forEach((v, i) => checkVarNameLiterals(v, `${path}[${i}]`));
    else if (isObj(value)) for (const [k, v] of Object.entries(value)) checkVarNameLiterals(v, `${path}.${k}`);
  };
  // The JSON type a payload value will have when sent, or null when unknown.
  const sentType = (v) => {
    if (typeof v !== "string") return { type: typeOfJson(v) };
    const t = template(v);
    if (t.kind === "literal") return { type: "string", literal: t.value };
    if (t.kind === "parts") return { type: "string", text: true };
    const src = t.expr.src?.trim();
    if (src === "index") return { type: "number", from: src };
    if (src && NAME_RE.test(src) && Object.hasOwn(vars, src) && vars[src] !== null) return { type: typeOfJson(vars[src]), from: src };
    return null; // an expression — its type is unknown statically
  };
  const checkField = (v, field, path, key) => {
    const types = [].concat(field.type);
    const want = types.join(" | ");
    const st = sentType(v);
    if (!st) return;
    if (st.literal !== undefined) {
      if (Object.hasOwn(vars, st.literal)) return; // reported by checkVarNameLiterals
      if (types.includes("string")) {
        if (field.enum && !field.enum.includes(st.literal)) err(path, `unknown ${key} "${st.literal}" (${field.enum.join(" | ")})`);
      } else if (!(types.includes("number") && isNumericString(st.literal))) {
        err(path, `'${key}' must be a ${want}, got the text ${JSON.stringify(st.literal)}`);
      }
      return;
    }
    if (st.text) {
      if (!types.includes("string")) warning(path, `a text template always sends a string; '${key}' needs a ${want} — use a single {expression}`);
      return;
    }
    if (types.includes(st.type)) return;
    if (st.from) err(path, `'{${st.from}}' starts as a ${st.type} but '${key}' must be a ${want}`);
    else err(path, `'${key}' must be a ${want}, got ${JSON.stringify(v)}`);
  };
  const checkEmit = (a, p) => {
    const payload = a.payload;
    const contract = hostActions && typeof a.emit === "string" && Object.hasOwn(hostActions, a.emit) ? hostActions[a.emit] : null;
    const fields = contract?.fields ?? {};
    // Always on: a variable's name sent as text.
    if (isObj(payload)) for (const [k, v] of Object.entries(payload)) checkVarNameLiterals(v, `${p}.payload.${k}`, fields[k]);
    else if (payload !== undefined) checkVarNameLiterals(payload, `${p}.payload`);
    if (!hostActions || typeof a.emit !== "string" || !a.emit) return;
    if (!contract) return warning(`${p}.emit`, `'${a.emit}' is not a room action — the room ignores it (${Object.keys(hostActions).join(", ")})`);
    if (contract.payload === "none") {
      if (payload !== undefined) warning(`${p}.payload`, `'${a.emit}' takes no payload — it is ignored`);
      return;
    }
    const required = Object.entries(fields).filter(([, f]) => f.required).map(([k]) => k);
    if (payload === undefined) {
      if (required.length) err(p, `'${a.emit}' needs a payload { ${required.join(", ")} }`);
      return;
    }
    if (!isObj(payload)) {
      const st = sentType(payload);
      if (st === null) return; // an expression: can't tell statically
      if (st.type === "object" || (contract.number && st.type === "number")) return;
      return err(`${p}.payload`, `'${a.emit}' payload must be an object { ${Object.keys(fields).join(", ")} }${contract.number ? " or a number" : ""}`);
    }
    for (const k of required) if (!(k in payload)) err(`${p}.payload`, `'${a.emit}' needs '${k}'`);
    for (const [k, v] of Object.entries(payload)) {
      if (!Object.hasOwn(fields, k)) warning(`${p}.payload.${k}`, `'${a.emit}' does not read '${k}' (${Object.keys(fields).join(", ")})`);
      else checkField(v, fields[k], `${p}.payload.${k}`, k);
    }
  };

  for (const [name, ph] of Object.entries(phases)) {
    const p = `phases.${name}`;
    if (!isObj(ph)) {
      err(p, "phase must be an object { enter?, tick? }");
      continue;
    }
    for (const k of Object.keys(ph)) if (!PHASE_KEYS.has(k)) err(`${p}.${k}`, `unknown phase key '${k}' (use enter / tick)`);
    if ("enter" in ph) checkActions(ph.enter, `${p}.enter`, {});
    if ("tick" in ph) checkActions(ph.tick, `${p}.tick`, {});
  }

  // ── nodes ──
  const checkValue = (node, key, path, scope, ok, hint) => {
    if (!(key in node)) return;
    const v = node[key];
    if (isTemplate(v)) return checkTemplate(v, path, scope);
    if (!ok(v)) err(path, `invalid ${key}: ${JSON.stringify(v)}${hint ? ` (${hint})` : ""}`);
  };
  const checkColor = (v, path, scope) => {
    if (isTemplate(v)) return checkTemplate(v, path, scope);
    if (typeof v !== "string" || !COLOR_RE.test(v)) err(path, `invalid color ${JSON.stringify(v)} (use #rrggbb or #rrggbbaa)`);
  };

  const checkNode = (node, path, scope, ids, parentBox) => {
    if (!isObj(node)) return err(path, "node must be an object");
    const kinds = KIND_KEYS.filter((k) => k in node);
    if (kinds.length > 1) return err(path, `node has more than one kind: ${kinds.join(", ")}`);
    const kind = kinds[0] ?? "box";
    for (const k of Object.keys(node)) if (!KEYS[kind].has(k)) err(`${path}.${k}`, `unknown key '${k}' on a ${kind} node`);

    if ("id" in node) {
      if (typeof node.id !== "string" || !node.id) err(`${path}.id`, "id must be a non-empty string");
      else if (ids.has(node.id)) err(`${path}.id`, `duplicate id '${node.id}'`);
      else ids.add(node.id);
    }
    if ("show" in node) checkExpr(node.show, `${path}.show`, scope);
    if ("onTap" in node) checkActions(node.onTap, `${path}.onTap`, scope);

    for (const key of ["width", "height"]) {
      checkValue(node, key, `${path}.${key}`, scope, (v) => typeof v === "number" || v === "fill" || v === "hug", "number, 'fill' or 'hug'");
    }
    for (const key of NUMERIC) checkValue(node, key, `${path}.${key}`, scope, (v) => typeof v === "number");
    if (("x" in node || "y" in node) && parentBox !== "free") err(path, "x / y only apply inside a 'free' box");
    for (const [key, [lo, hi]] of Object.entries(RANGES)) {
      if (typeof node[key] === "number" && (node[key] < lo || node[key] > hi)) err(`${path}.${key}`, `${key} must be ${lo}–${hi}, got ${node[key]}`);
    }
    checkValue(node, "origin", `${path}.origin`, scope, (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number"), "[0-1, 0-1]");
    if (Array.isArray(node.origin) && node.origin.length === 2 && node.origin.every((n) => typeof n === "number") && node.origin.some((n) => n < 0 || n > 1)) {
      err(`${path}.origin`, `origin is a fraction of the node's size per axis (0–1), got ${JSON.stringify(node.origin)} — [0.5, 0.5] is the center`);
    }
    checkValue(node, "radius", `${path}.radius`, scope, (v) => typeof v === "number" || v === "full");
    if ("stroke" in node) {
      const s = node.stroke;
      if (!isObj(s) || !("color" in s)) err(`${path}.stroke`, "must be { color, width }");
      else {
        checkColor(s.color, `${path}.stroke.color`, scope);
        if ("width" in s && typeof s.width !== "number" && !isTemplate(s.width)) err(`${path}.stroke.width`, "must be a number");
      }
    }
    if ("shadow" in node) {
      const s = node.shadow;
      if (!isObj(s)) err(`${path}.shadow`, "must be { x, y, blur, color }");
      else {
        for (const k of Object.keys(s)) if (!["x", "y", "blur", "color"].includes(k)) err(`${path}.shadow.${k}`, `unknown shadow key '${k}'`);
        if ("color" in s) checkColor(s.color, `${path}.shadow.color`, scope);
      }
    }

    if (kind === "box") {
      checkValue(node, "box", `${path}.box`, scope, (v) => ENUMS.box.includes(v), ENUMS.box.join(" | "));
      checkValue(node, "align", `${path}.align`, scope, (v) => ENUMS.boxAlign.includes(v), ENUMS.boxAlign.join(" | "));
      checkValue(node, "justify", `${path}.justify`, scope, (v) => ENUMS.justify.includes(v), ENUMS.justify.join(" | "));
      checkValue(node, "pad", `${path}.pad`, scope, (v) => typeof v === "number" || (Array.isArray(v) && (v.length === 2 || v.length === 4) && v.every((n) => typeof n === "number")), "number, [v, h] or [t, r, b, l]");
      checkValue(node, "clip", `${path}.clip`, scope, (v) => typeof v === "boolean" || v === "circle");
      checkValue(node, "scroll", `${path}.scroll`, scope, (v) => typeof v === "boolean");
      if ("fill" in node) checkColor(node.fill, `${path}.fill`, scope);
      if ("gradient" in node) {
        const g = node.gradient;
        if (!isObj(g) || !Array.isArray(g.colors) || g.colors.length < 2) err(`${path}.gradient`, "must be { colors: [≥2 colors], angle? }");
        else g.colors.forEach((c, i) => checkColor(c, `${path}.gradient.colors[${i}]`, scope));
      }
      if (node.box === "grid" && !("columns" in node)) err(`${path}.columns`, "a grid box needs 'columns'");
      if ("columns" in node && node.box !== "grid") err(`${path}.columns`, "columns only apply to a grid box");
      let inner = scope;
      if ("each" in node) {
        checkExpr(node.each, `${path}.each`, scope);
        inner = { ...scope, each: true };
      }
      if ("children" in node && !Array.isArray(node.children)) err(`${path}.children`, "must be an array");
      const layout = node.box ?? "column";
      (node.children ?? []).forEach((c, i) => checkNode(c, `${path}.children[${i}]`, inner, ids, layout));
    } else if (kind === "text") {
      if (typeof node.text !== "string") err(`${path}.text`, "must be a string");
      else checkTemplate(node.text, `${path}.text`, scope);
      if ("color" in node) checkColor(node.color, `${path}.color`, scope);
      checkValue(node, "align", `${path}.align`, scope, (v) => ENUMS.textAlign.includes(v), ENUMS.textAlign.join(" | "));
      checkValue(node, "font", `${path}.font`, scope, (v) => ENUMS.font.includes(v), ENUMS.font.join(" | "));
    } else if (kind === "image") {
      if (typeof node.image !== "string") err(`${path}.image`, "must be a URL string");
      else checkTemplate(node.image, `${path}.image`, scope);
      checkValue(node, "fit", `${path}.fit`, scope, (v) => ENUMS.fit.includes(v), ENUMS.fit.join(" | "));
      checkValue(node, "focus", `${path}.focus`, scope, (v) => ENUMS.focus.includes(v), ENUMS.focus.join(" | "));
    } else {
      const def = components[node.use];
      if (!def) err(`${path}.use`, `unknown component '${node.use}'`);
      if ("props" in node) {
        if (!isObj(node.props)) err(`${path}.props`, "must be an object");
        else
          for (const [k, v] of Object.entries(node.props)) {
            if (def && isObj(def.props) && !Object.hasOwn(def.props, k)) err(`${path}.props.${k}`, `component '${node.use}' has no prop '${k}'`);
            checkJson(v, `${path}.props.${k}`, scope);
          }
      }
    }
  };

  for (const [name, def] of Object.entries(components)) {
    const p = `components.${name}`;
    if (!NAME_RE.test(name)) err(p, "component names must be identifiers");
    if (!isObj(def)) {
      err(p, "must be { props, view }");
      continue;
    }
    for (const k of Object.keys(def)) if (!["props", "view", "description"].includes(k)) err(`${p}.${k}`, `unknown key '${k}'`);
    if ("props" in def && !isObj(def.props)) err(`${p}.props`, "must be an object { name: default }");
    checkNode(def.view, `${p}.view`, { component: true }, new Set(), "free");
  }
  // A component that (indirectly) uses itself would render forever.
  const usesOf = (node, out = new Set()) => {
    if (!isObj(node)) return out;
    if (typeof node.use === "string") out.add(node.use);
    for (const c of node.children ?? []) usesOf(c, out);
    return out;
  };
  const visiting = new Set();
  const done = new Set();
  const cyclic = (name) => {
    if (done.has(name)) return false;
    if (visiting.has(name)) return true;
    visiting.add(name);
    const hit = [...usesOf(components[name]?.view)].some((n) => Object.hasOwn(components, n) && cyclic(n));
    visiting.delete(name);
    done.add(name);
    return hit;
  };
  for (const name of Object.keys(components)) if (cyclic(name)) err(`components.${name}`, "component uses itself (directly or indirectly)");

  if (!isObj(doc.view)) err("view", "required root node");
  else checkNode(doc.view, "view", {}, new Set(), "free");

  for (const name of Object.keys(vars)) if (!used.has(name)) warning(`vars.${name}`, `variable '${name}' is never used`);

  return { ok: errors.length === 0, errors, warnings };
}
