// Bite expressions: a whitelisted subset of JS expressions, parsed by jsep and
// compiled to closures. Nothing outside the whitelist can run — no globals,
// no prototype access, no arbitrary method calls — because expressions are
// written by an LLM and must never escape the sandbox.
import jsep from "jsep";
import jsepArrow from "@jsep-plugin/arrow";

jsep.plugins.register(jsepArrow);
// jsep ships bitwise/shift operators by default; Bite has none of them.
for (const op of ["|", "^", "&", "<<", ">>", ">>>"]) jsep.removeBinaryOp(op);

export const RESERVED = new Set(["phase", "now", "props", "item", "index", "true", "false", "null", "undefined", "Math"]);

const BINARY = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  // `==` is strict on purpose: loose equality is a classic LLM foot-gun.
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};
const UNARY = { "!": (a) => !a, "-": (a) => -a, "+": (a) => +a };

const arr = (x) => (Array.isArray(x) ? x : []);
const round = (x, d = 0) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const minmax = (fn) => (...xs) => fn(...(xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs));

// Bare functions. Each receives the evaluation context first (for injected
// random/now), then the call arguments.
export const FUNCS = {
  round: (c, x, d) => round(x, d),
  floor: (c, x) => Math.floor(x),
  ceil: (c, x) => Math.ceil(x),
  abs: (c, x) => Math.abs(x),
  pow: (c, x, y) => x ** y,
  sqrt: (c, x) => Math.sqrt(x),
  min: (c, ...xs) => minmax(Math.min)(...xs),
  max: (c, ...xs) => minmax(Math.max)(...xs),
  clamp: (c, x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  lerp: (c, a, b, t) => a + (b - a) * t,
  remap: (c, x, a1, b1, a2, b2) => a2 + ((x - a1) * (b2 - a2)) / (b1 - a1),
  random: (c) => c.random(),
  randint: (c, lo, hi) => lo + Math.floor(c.random() * (hi - lo + 1)),
  pick: (c, xs) => arr(xs)[Math.floor(c.random() * arr(xs).length)],
  shuffle: (c, xs) => {
    const out = arr(xs).slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(c.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },
  len: (c, x) => (x == null ? 0 : typeof x === "object" && !Array.isArray(x) ? Object.keys(x).length : x.length ?? 0),
  range: (c, n) => Array.from({ length: Math.max(0, Math.min(10000, Math.floor(n))) }, (_, i) => i),
  sum: (c, xs) => arr(xs).reduce((s, x) => s + (Number(x) || 0), 0),
  with: (c, xs, i, v) => {
    const out = arr(xs).slice();
    out[i] = v;
    return out;
  },
  str: (c, x) => (x == null ? "" : String(x)),
  num: (c, x) => Number(x),
  fmt: (c, n) => Number(n).toLocaleString("ko-KR"),
  pad: (c, n, w) => String(n).padStart(w, "0"),
  elapsed: (c, t) => c.now - t,
  // Stable 32-bit FNV-1a hash of a value's text — the same name always gives the
  // same number (deterministic avatars, colors, picks).
  hash: (c, x) => {
    let h = 0x811c9dc5;
    for (const ch of String(x ?? "")) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  },
};

// `Math.x(...)` is accepted as an alias of the bare function (LLM habit).
const MATH_ALIAS = new Set(["round", "floor", "ceil", "abs", "pow", "sqrt", "min", "max", "random"]);
const MATH_CONST = { PI: Math.PI };

const ARRAY_METHODS = new Set([
  "concat", "slice", "join", "includes", "indexOf", "map", "filter", "find", "some", "every", "reverse", "sort",
]);
const STRING_METHODS = new Set(["slice", "includes", "split", "toUpperCase", "toLowerCase", "trim", "padStart"]);
const NUMBER_METHODS = new Set(["toFixed", "toLocaleString"]);
const COPYING = new Set(["reverse", "sort"]); // never mutate the variable in place

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class BiteExprError extends Error {}

function getMember(obj, key) {
  if (obj == null) throw new BiteExprError(`cannot read '${key}' of ${obj}`);
  if (typeof key !== "string" && typeof key !== "number") throw new BiteExprError("bad member key");
  if (BLOCKED_KEYS.has(key)) throw new BiteExprError(`'${key}' is not allowed`);
  if (Array.isArray(obj) || typeof obj === "string") {
    if (key === "length") return obj.length;
    if (typeof key === "number" || /^\d+$/.test(key)) return obj[key];
    throw new BiteExprError(`'${key}' is not a property`);
  }
  if (typeof obj === "object") return Object.hasOwn(obj, key) ? obj[key] : undefined;
  throw new BiteExprError(`cannot read '${key}' of a ${typeof obj}`);
}

function callMethod(obj, name, args) {
  if (Array.isArray(obj) && ARRAY_METHODS.has(name)) {
    return COPYING.has(name) ? obj.slice()[name](...args) : obj[name](...args);
  }
  if (typeof obj === "string" && STRING_METHODS.has(name)) return obj[name](...args);
  if (typeof obj === "number" && NUMBER_METHODS.has(name)) return obj[name](...args);
  throw new BiteExprError(`method '${name}' is not allowed on ${Array.isArray(obj) ? "array" : typeof obj}`);
}

// ── compiler ────────────────────────────────────────────────────────────────
// compile(ast, locals) → (ctx, env) => value, where ctx = { vars, phase, now,
// random, props, item, index } and env = arrow-function parameters.
function compileNode(node, locals, deps, meta) {
  switch (node.type) {
    case "Literal": {
      const v = node.value;
      return () => v;
    }
    case "Identifier": {
      const name = node.name;
      if (locals.has(name)) return (ctx, env) => env[name];
      if (name === "undefined") return () => undefined;
      if (name === "phase" || name === "now" || name === "props" || name === "item" || name === "index") {
        deps.add(name);
        return (ctx) => ctx[name];
      }
      if (name === "Math") throw new BiteExprError("'Math' can only be used as Math.fn(...)");
      if (Object.hasOwn(FUNCS, name)) throw new BiteExprError(`'${name}' is a function — call it: ${name}(...)`);
      deps.add(name);
      meta.vars.add(name);
      return (ctx) => {
        if (!Object.hasOwn(ctx.vars, name)) throw new BiteExprError(`unknown variable '${name}'`);
        return ctx.vars[name];
      };
    }
    case "ArrayExpression": {
      const els = node.elements.map((e) => compileNode(e, locals, deps, meta));
      return (ctx, env) => els.map((f) => f(ctx, env));
    }
    case "UnaryExpression": {
      const op = UNARY[node.operator];
      if (!op) throw new BiteExprError(`operator '${node.operator}' is not allowed`);
      const a = compileNode(node.argument, locals, deps, meta);
      return (ctx, env) => op(a(ctx, env));
    }
    case "BinaryExpression": {
      const l = compileNode(node.left, locals, deps, meta);
      const r = compileNode(node.right, locals, deps, meta);
      if (node.operator === "&&") return (ctx, env) => l(ctx, env) && r(ctx, env);
      if (node.operator === "||") return (ctx, env) => l(ctx, env) || r(ctx, env);
      const op = BINARY[node.operator];
      if (!op) throw new BiteExprError(`operator '${node.operator}' is not allowed`);
      return (ctx, env) => op(l(ctx, env), r(ctx, env));
    }
    case "ConditionalExpression": {
      const t = compileNode(node.test, locals, deps, meta);
      const a = compileNode(node.consequent, locals, deps, meta);
      const b = compileNode(node.alternate, locals, deps, meta);
      return (ctx, env) => (t(ctx, env) ? a(ctx, env) : b(ctx, env));
    }
    case "MemberExpression": {
      if (node.object.type === "Identifier" && node.object.name === "Math" && !locals.has("Math")) {
        const key = node.computed ? null : node.property.name;
        if (key && Object.hasOwn(MATH_CONST, key)) return () => MATH_CONST[key];
        throw new BiteExprError(`Math.${key ?? "[…]"} is not allowed`);
      }
      const obj = compileNode(node.object, locals, deps, meta);
      if (node.computed) {
        const key = compileNode(node.property, locals, deps, meta);
        return (ctx, env) => getMember(obj(ctx, env), key(ctx, env));
      }
      const key = node.property.name;
      return (ctx, env) => getMember(obj(ctx, env), key);
    }
    case "CallExpression":
      return compileCall(node, locals, deps, meta);
    case "ArrowFunctionExpression":
      throw new BiteExprError("arrow functions are only allowed as arguments of map/filter/find/some/every/sort");
    default:
      throw new BiteExprError(`${node.type} is not allowed`);
  }
}

function compileArgs(args, locals, deps, meta, allowArrow) {
  return args.map((a) => {
    if (a.type !== "ArrowFunctionExpression") return compileNode(a, locals, deps, meta);
    if (!allowArrow) throw new BiteExprError("arrow functions are only allowed as arguments of map/filter/find/some/every/sort");
    const params = (a.params ?? []).map((p) => {
      if (p.type !== "Identifier") throw new BiteExprError("arrow parameters must be plain names");
      return p.name;
    });
    const inner = new Set([...locals, ...params]);
    const body = compileNode(a.body, inner, deps, meta);
    return (ctx, env) =>
      (...xs) => {
        const scope = { ...env };
        params.forEach((p, i) => (scope[p] = xs[i]));
        return body(ctx, scope);
      };
  });
}

function compileCall(node, locals, deps, meta) {
  const callee = node.callee;
  if (callee.type === "Identifier" && !locals.has(callee.name)) {
    const fn = FUNCS[callee.name];
    if (!Object.hasOwn(FUNCS, callee.name)) throw new BiteExprError(`function '${callee.name}' is not allowed`);
    if (callee.name === "elapsed") deps.add("now");
    const args = compileArgs(node.arguments, locals, deps, meta, false);
    return (ctx, env) => fn(ctx, ...args.map((a) => a(ctx, env)));
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    const name = callee.property.name;
    if (callee.object.type === "Identifier" && callee.object.name === "Math" && !locals.has("Math")) {
      if (!MATH_ALIAS.has(name)) throw new BiteExprError(`Math.${name} is not allowed`);
      meta.mathPrefix = true;
      const fn = FUNCS[name];
      const args = compileArgs(node.arguments, locals, deps, meta, false);
      return (ctx, env) => fn(ctx, ...args.map((a) => a(ctx, env)));
    }
    if (!ARRAY_METHODS.has(name) && !STRING_METHODS.has(name) && !NUMBER_METHODS.has(name)) {
      throw new BiteExprError(`method '${name}' is not allowed`);
    }
    const obj = compileNode(callee.object, locals, deps, meta);
    const args = compileArgs(node.arguments, locals, deps, meta, true);
    return (ctx, env) => callMethod(obj(ctx, env), name, args.map((a) => a(ctx, env)));
  }
  throw new BiteExprError("only whitelisted functions and methods can be called");
}

// ── public API ──────────────────────────────────────────────────────────────
const cache = new Map();

/**
 * Compile an expression. Never throws: a bad expression yields { error }.
 * deps = names the value depends on (variables + phase/now/props/item/index).
 * vars = the subset of deps that must be declared variables.
 */
export function compileExpr(src) {
  const key = String(src);
  let hit = cache.get(key);
  if (hit) return hit;
  const deps = new Set();
  const meta = { vars: new Set(), mathPrefix: false };
  try {
    const ast = jsep(key);
    if (ast.type === "Compound") throw new BiteExprError("only a single expression is allowed");
    const fn = compileNode(ast, new Set(), deps, meta);
    hit = { src: key, fn, deps, vars: meta.vars, mathPrefix: meta.mathPrefix, error: null };
  } catch (e) {
    hit = { src: key, fn: null, deps, vars: meta.vars, mathPrefix: meta.mathPrefix, error: e.message };
  }
  cache.set(key, hit);
  return hit;
}

/**
 * Split a template string into literal text and `{expr}` parts.
 * `{{` is a literal `{`. Returns { kind: "literal" | "single" | "parts", ... }.
 */
export function parseTemplate(str) {
  const parts = [];
  let text = "";
  let error = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "{" && str[i + 1] === "{") {
      text += "{";
      i++;
      continue;
    }
    if (ch !== "{") {
      text += ch;
      continue;
    }
    // Find the matching `}` outside of quoted strings.
    let j = i + 1;
    let quote = null;
    for (; j < str.length; j++) {
      const c = str[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "}") break;
    }
    if (j >= str.length) {
      error = "unclosed '{' in template";
      text += str.slice(i);
      break;
    }
    if (text) parts.push(text);
    text = "";
    parts.push(compileExpr(str.slice(i + 1, j).trim()));
    i = j;
  }
  if (text) parts.push(text);
  if (parts.length === 0) return { kind: "literal", value: "", parts, error };
  if (parts.length === 1 && typeof parts[0] === "string") return { kind: "literal", value: parts[0], parts, error };
  if (parts.length === 1) return { kind: "single", expr: parts[0], parts, error };
  return { kind: "parts", parts, error };
}

const templateCache = new Map();
export function template(str) {
  let t = templateCache.get(str);
  if (!t) templateCache.set(str, (t = parseTemplate(str)));
  return t;
}

/** Dependencies of a template string (empty for plain literals). */
export function templateDeps(str) {
  const out = new Set();
  for (const p of template(str).parts) if (typeof p !== "string") for (const d of p.deps) out.add(d);
  return out;
}

/**
 * Evaluate a compiled expression. Errors never propagate: the result is
 * undefined and `warn` is called once per distinct (expression, message).
 */
export function run(compiled, ctx, warn) {
  if (compiled.error) {
    warnOnce(warn, compiled.src, compiled.error);
    return undefined;
  }
  try {
    return compiled.fn(ctx, {});
  } catch (e) {
    warnOnce(warn, compiled.src, e.message);
    return undefined;
  }
}

/** Evaluate a template string: raw value for a lone `{expr}`, else a string. */
export function runTemplate(str, ctx, warn) {
  const t = template(str);
  if (t.kind === "literal") return t.value;
  if (t.kind === "single") return run(t.expr, ctx, warn);
  let out = "";
  for (const p of t.parts) {
    if (typeof p === "string") out += p;
    else {
      const v = run(p, ctx, warn);
      out += v == null ? "" : String(v);
    }
  }
  return out;
}

const warned = new WeakMap();
function warnOnce(warn, src, msg) {
  if (!warn) return;
  let seen = warned.get(warn);
  if (!seen) warned.set(warn, (seen = new Set()));
  const key = src + "\u0000" + msg;
  if (seen.has(key)) return;
  seen.add(key);
  warn(`expression \`${src}\`: ${msg}`);
}
