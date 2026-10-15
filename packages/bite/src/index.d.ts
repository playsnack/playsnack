export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Scope {
  props?: Record<string, unknown>;
  item?: unknown;
  index?: number;
}

export interface BiteDoc {
  bite: 1;
  meta: { name: string; multi?: boolean; description?: string };
  frame: [number, number];
  vars: Record<string, Json>;
  data?: { url: string };
  /** Together apps: the room's start payload — a public room starts by itself with it (§6.2). */
  room?: { start: Json; autoStartMs?: number };
  components?: Record<string, { props?: Record<string, Json>; view: BiteNode; description?: string }>;
  start: string;
  phases: Record<string, { enter?: BiteAction[]; tick?: BiteAction[] }>;
  view: BiteNode;
}

export type BiteNode = { [key: string]: unknown; children?: BiteNode[] };

export type BiteAction =
  | { set: string; to: string }
  | { set: string; value: Json }
  | { go: string }
  | { if: string; then: BiteAction[]; else?: BiteAction[] }
  | { emit: string; payload?: Json };

export interface BiteEvents {
  emit: { name: string; payload: unknown };
  phase: { from: string | null; to: string };
  /** Names changed since the last tick: variables plus "phase" / "now". */
  change: string[];
}

export interface BiteApp {
  readonly doc: BiteDoc;
  readonly phase: string | null;
  readonly vars: Readonly<Record<string, unknown>>;
  start(): void;
  tick(): string[];
  tap(target: string | BiteNode, scope?: Scope): boolean;
  setVar(id: string, value: unknown): void;
  setVars(values: Record<string, unknown>): void;
  eval(expr: string, scope?: Scope): unknown;
  value(templateOrJson: unknown, scope?: Scope): unknown;
  on<K extends keyof BiteEvents>(type: K, fn: (e: BiteEvents[K]) => void): () => void;
}

export interface BiteOptions {
  now?: () => number;
  random?: () => number;
  warn?: (msg: string) => void;
}

export function createBite(doc: BiteDoc, opts?: BiteOptions): BiteApp;

export interface Issue {
  path: string;
  message: string;
}
/** One room action's payload contract (see `@snack/room/actions` HOST_ACTIONS). */
export interface HostActionSpec {
  payload: "none" | "object";
  /** A bare number is also accepted. */
  number?: boolean;
  fields?: Record<string, { type: string | string[]; required?: boolean; enum?: string[]; text?: boolean }>;
}
export interface ValidateOptions {
  /** With it, every `emit` is checked against what the room actually reads. */
  hostActions?: Readonly<Record<string, HostActionSpec>>;
}
export function validate(doc: unknown, opts?: ValidateOptions): { ok: boolean; errors: Issue[]; warnings: Issue[] };

export interface Compiled {
  src: string;
  deps: Set<string>;
  vars: Set<string>;
  mathPrefix: boolean;
  error: string | null;
}
export function compileExpr(src: string): Compiled;
export function template(str: string): { kind: "literal" | "single" | "parts"; value?: string; error: string | null };
export function templateDeps(str: string): Set<string>;
export const RESERVED: Set<string>;
