// The room's floating emoji reactions (#121): a pointer-transparent overlay over the
// canvas that plays reactionFx.ts plans with the Web Animations API (transform +
// opacity only, so the compositor does the work). LiveApp calls handle.mine(emoji)
// on my own tap and handle.incoming(emoji) for each "reaction" the room sends.
import { useEffect, useRef } from "react";
import { EchoFilter, ReactionQueue, REACTION_CAP, keyframesFor, planBurst, type Particle } from "./reactionFx";

export type ReactionFxApi = {
  /** My own tap: an immediate local burst; the room's echo of it is skipped later. */
  mine(emoji: string): void;
  /** A reaction the room sent (anyone's, mine included). */
  incoming(emoji: string): void;
};

const reducedMotion = () => {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
};

export function ReactionLayer({ handle }: { handle: React.MutableRefObject<ReactionFxApi | null> }) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const queue = new ReactionQueue<HTMLElement>(REACTION_CAP);
    const echo = new EchoFilter();
    const anims = new Map<HTMLElement, Animation>();
    const drop = (el: HTMLElement) => {
      queue.remove(el);
      anims.get(el)?.cancel();
      anims.delete(el);
      el.remove();
    };
    const play = (p: Particle) => {
      const box = boxRef.current;
      if (!box) return;
      const el = document.createElement("div");
      el.textContent = p.emoji;
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        `position:absolute;left:${p.x.toFixed(1)}%;bottom:${p.bottom.toFixed(0)}px;font-size:${p.size}px;line-height:1;` +
        "opacity:0;will-change:transform,opacity;filter:drop-shadow(0 4px 0 rgba(0,0,0,0.55));";
      box.appendChild(el);
      for (const old of queue.add(el)) drop(old);
      if (typeof el.animate !== "function") {
        setTimeout(() => drop(el), p.duration);
        return;
      }
      const reduced = reducedMotion();
      const a = el.animate(keyframesFor(p, reduced), {
        duration: reduced ? Math.min(p.duration, 2200) : p.duration,
        delay: p.delay,
        easing: "linear",
        fill: "both",
      });
      anims.set(el, a);
      a.onfinish = () => drop(el);
    };
    handle.current = {
      mine(emoji) {
        if (!emoji) return;
        echo.sent(emoji, Date.now());
        planBurst(emoji, true).forEach(play);
      },
      incoming(emoji) {
        if (!emoji || !echo.incoming(emoji, Date.now())) return;
        planBurst(emoji, false).forEach(play);
      },
    };
    return () => {
      handle.current = null;
      for (const el of [...anims.keys()]) drop(el);
    };
  }, [handle]);

  return <div ref={boxRef} style={overlay} />;
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, pointerEvents: "none", zIndex: 12, overflow: "hidden",
};
