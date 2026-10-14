import type { Application } from "pixi.js";
import type { BiteApp, BiteDoc } from "@snack/bite";
import type { Instance, ScrollOffsets } from "@snack/bite-layout";

export interface BiteView {
  readonly pixi: Application;
  readonly scene: { root: Instance; deps: Set<string> };
  readonly scale: number;
  readonly scroll: ScrollOffsets;
  /** True while a released list is still moving. */
  readonly flinging: boolean;
  toClient(x: number, y: number): { x: number; y: number };
  refresh(): void;
  destroy(): void;
}

export function mountBite(opts: {
  el: HTMLElement;
  doc: BiteDoc;
  app: BiteApp;
  fontBase?: string;
  background?: string;
  debug?: boolean;
  /** false = ignore pointer input (an editor handles it). Default true. */
  interactive?: boolean;
  /** true = do not advance the runtime (a frozen frame to edit on). */
  paused?: boolean;
}): Promise<BiteView>;

export function loadFonts(doc: BiteDoc, base?: string): Promise<void>;
export function fontFamily(font?: string): string;
export const FAMILY: { body: string; display: string };

/** Where a frame lands in a canvas (contain, centred) — the renderer's fit. */
export function fitFrame(width: number, height: number, fw: number, fh: number): { scale: number; x: number; y: number };
/** Client (CSS px) point → frame units, given the canvas's client rect and the fit. */
export function clientToFrame(clientX: number, clientY: number, rect: { left: number; top: number }, fit: { scale: number; x: number; y: number }): { x: number; y: number };
