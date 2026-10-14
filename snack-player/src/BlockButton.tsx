// A block button whose press is played by nudg: the block sinks by the height of its
// hard shadow and springs back up (src/motion/block-press.nudg.json). nudg moves the
// block; the stylesheet (.blkn in ui.ts) collapses the shadow from the state attribute
// nudg writes. With reduced motion on, it's the plain CSS .blk press instead.
import { useCallback } from "react";
import { useNudg } from "@nudg/core/react";
import blockPress from "./motion/block-press.nudg.json";
import snackMotion from "./motion/snack.nudg.json";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { buttonRef?: React.Ref<HTMLButtonElement> };

const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function BlockButton(props: Props) {
  return REDUCED_MOTION ? <PlainBlockButton {...props} /> : <SpringBlockButton {...props} />;
}

function PlainBlockButton({ buttonRef, className, ...rest }: Props) {
  return <button ref={buttonRef} className={["blk", className].filter(Boolean).join(" ")} {...rest} />;
}

function SpringBlockButton({ buttonRef, className, ...rest }: Props) {
  // The import inside block-press.nudg.json is served from memory, by its path relative to the file.
  const { bind } = useNudg(blockPress, { files: { "snack.nudg.json": snackMotion } });
  const bindBlock = bind("block");
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      bindBlock(el);
      if (typeof buttonRef === "function") buttonRef(el);
      else if (buttonRef) (buttonRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
    },
    [bindBlock, buttonRef],
  );
  return <button ref={ref} className={["blkn", className].filter(Boolean).join(" ")} {...rest} />;
}
