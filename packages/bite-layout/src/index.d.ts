import type { BiteApp, BiteDoc, BiteNode, Scope } from "@snack/bite";

export interface Box { x: number; y: number; w: number; h: number }
export interface TextLine { text: string; width: number }

export interface Instance {
  key: string;
  kind: "box" | "text" | "image";
  layout: "column" | "row" | "grid" | "free" | null;
  node: BiteNode;
  style: Record<string, any>;
  content?: string;
  tap?: { actions: unknown[]; scope: Scope; node: BiteNode };
  /** The `use` node when this instance is a component's root. */
  source?: BiteNode;
  children: Instance[];
  box: Box;
  text?: { lines: TextLine[]; lineHeight: number; weight: number };
  contentSize?: { w: number; h: number };
}

export type ScrollOffsets = Map<string, { x: number; y: number }>;

export function initLayout(): Promise<void>;
export function expand(doc: BiteDoc, app: BiteApp): { root: Instance; deps: Set<string> };
export function layout(root: Instance, frame: [number, number]): Instance;
export function computeScene(doc: BiteDoc, app: BiteApp): { root: Instance; deps: Set<string> };
export function padOf(pad: unknown): [number, number, number, number];
export function measureText(
  text: string,
  style?: { font?: string; size?: number; weight?: number; lines?: number },
  maxWidth?: number,
): { lines: TextLine[]; width: number; height: number; lineHeight: number; weight: number };
export function faceFor(font: string, weight?: number): { weight: number; metrics: unknown };
export const TEXT_DEFAULTS: { font: string; size: number; weight: number };
export const LINE_HEIGHT: { body: number; display: number };
export function hitTest(root: Instance, x: number, y: number, scroll?: ScrollOffsets): Instance | null;
export function scrollTargetAt(root: Instance, x: number, y: number, scroll?: ScrollOffsets): Instance | null;
export function absBoxes(root: Instance, scroll?: ScrollOffsets): Map<string, Box>;
export function findInstances(root: Instance, id: string): Instance[];
export function checkLayout(root: Instance, frame: [number, number]): { key: string; where: string; kind: string; detail: string }[];
