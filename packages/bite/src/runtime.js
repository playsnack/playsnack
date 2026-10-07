// Bite runtime: owns variables and the current phase, runs actions, and tells
// the renderer which names changed each frame. It knows nothing about pixels
// or networks — hosts wire taps in and `emit` events out.
import { compileExpr, run, runTemplate } from "./expr.js";

const MAX_TRANSITIONS = 16; // a `go` chain longer than this is a loop in the doc

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Walk the view tree and index nodes that carry an `id` (component internals excluded). */
function indexNodes(view) {
  const byId = new Map();
  const walk = (node, ancestors) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.id === "string") byId.set(node.id, { node, ancestors });
    const next = [...ancestors, node];
    for (const child of node.children ?? []) walk(child, next);
  };
  walk(view, []);
  return byId;
}

/**
 * @param {object} doc  a Bite document (validate() it first)
 * @param {{ now?: () => number, random?: () => number, warn?: (msg: string) => void }} [opts]
 */
export function createBite(doc, opts = {}) {
  const clock = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const warn = opts.warn ?? ((msg) => console.warn(`[bite] ${msg}`));

  const vars = clone(doc.vars ?? {});
  const phases = doc.phases ?? {};
  const nodes = indexNodes(doc.view);
  const listeners = { emit: new Set(), phase: new Set(), change: new Set() };
  const dirty = new Set();
  const warnedKeys = new Set();

  let phase = null;
  let now = clock();
  let pendingGo = null;
  let started = false;

  const warnOnce = (key, msg) => {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warn(msg);
  };
  const fire = (type, payload) => {
    for (const fn of listeners[type]) fn(payload);
  };
  const ctxFor = (scope = {}) => ({
    vars,
    phase,
    now,
    random,
    props: scope.props,
    item: scope.item,
    index: scope.index,
  });

  const evalExpr = (src, scope) => run(compileExpr(src), ctxFor(scope), warn);
  const evalTemplate = (str, scope) => resolve(str, ctxFor(scope));
  // Deep-resolve templates inside a JSON value (emit payloads).
  const resolve = (value, ctx) => {
    if (typeof value === "string") return runTemplate(value, ctx, warn);
    if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v, ctx);
      return out;
    }
    return value;
  };

  const assign = (name, value) => {
    if (!Object.hasOwn(vars, name)) {
      warnOnce(`set:${name}`, `cannot set undeclared variable '${name}'`);
      return;
    }
    if (Object.is(vars[name], value)) return;
    vars[name] = value;
    dirty.add(name);
  };

  const runActions = (actions, scope) => {
    for (const a of actions ?? []) {
      if (!a || typeof a !== "object") continue;
      if ("set" in a) assign(a.set, "value" in a ? clone(a.value) : evalExpr(a.to, scope));
      else if ("go" in a) pendingGo = a.go;
      else if ("if" in a) runActions(evalExpr(a.if, scope) ? a.then : a.else, scope);
      else if ("emit" in a) fire("emit", { name: a.emit, payload: resolve(a.payload, ctxFor(scope)) });
      else warnOnce(`action:${Object.keys(a).join(",")}`, `unknown action ${JSON.stringify(a)}`);
    }
  };

  // Run a batch of actions, then apply any `go` once the batch is done.
  const batch = (fn) => {
    fn();
    for (let hops = 0; pendingGo !== null; hops++) {
      const target = pendingGo;
      pendingGo = null;
      if (target === phase) continue;
      if (!Object.hasOwn(phases, target)) {
        warnOnce(`go:${target}`, `cannot go to unknown phase '${target}'`);
        continue;
      }
      if (hops >= MAX_TRANSITIONS) {
        warnOnce(`loop:${target}`, `phase transitions loop (stopped at '${target}')`);
        break;
      }
      const from = phase;
      phase = target;
      dirty.add("phase");
      fire("phase", { from, to: target });
      runActions(phases[target].enter);
    }
  };

  const isShown = (node, scope) => node.show === undefined || Boolean(evalExpr(node.show, scope));

  const app = {
    doc,

    get phase() {
      return phase;
    },
    /** Read-only snapshot of the variables. */
    get vars() {
      return Object.freeze({ ...vars });
    },

    start() {
      if (started) return;
      started = true;
      now = clock();
      if (!Object.hasOwn(phases, doc.start)) {
        warn(`start phase '${doc.start}' does not exist`);
        return;
      }
      pendingGo = doc.start;
      batch(() => {});
    },

    /** Advance one frame: run the phase's tick actions, then report changes. */
    tick() {
      now = clock();
      if (started && phase !== null) batch(() => runActions(phases[phase].tick));
      dirty.add("now");
      const changed = [...dirty];
      dirty.clear();
      fire("change", changed);
      return changed;
    },

    /**
     * Deliver a tap. `target` is a node id or the node object itself (the
     * renderer passes objects; headless tests pass ids). Returns false when
     * the node has no onTap or it, or an ancestor, is hidden.
     */
    tap(target, scope = {}) {
      let node = target;
      let ancestors = [];
      if (typeof target === "string") {
        const hit = nodes.get(target);
        if (!hit) {
          warnOnce(`tap:${target}`, `no node with id '${target}'`);
          return false;
        }
        ({ node, ancestors } = hit);
      }
      if (!node?.onTap) return false;
      // validate() guarantees item/index only appear inside `each`, so the
      // tap's scope is safe to use for every ancestor.
      if (!ancestors.every((a) => isShown(a, scope)) || !isShown(node, scope)) return false;
      now = clock();
      batch(() => runActions(node.onTap, scope));
      return true;
    },

    setVar(id, value) {
      if (!Object.hasOwn(vars, id)) {
        warnOnce(`host:${id}`, `host set undeclared variable '${id}' (ignored)`);
        return;
      }
      assign(id, value);
    },

    setVars(obj) {
      for (const [k, v] of Object.entries(obj ?? {})) if (Object.hasOwn(vars, k)) assign(k, v);
    },

    /** Evaluate an expression (show/if/each style). */
    eval: evalExpr,
    /** Evaluate a template string (text/fill/width style). */
    value: evalTemplate,

    on(type, fn) {
      if (!listeners[type]) throw new Error(`unknown event '${type}'`);
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
  };
  return app;
}
