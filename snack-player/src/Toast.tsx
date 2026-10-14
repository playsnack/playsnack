// A notice that rises in and sinks out, played by nudg (src/motion/toast.nudg.json).
// `shown` drives it like a conditional render used to: the element mounts when shown
// becomes true and unmounts after it has faded out, so the layout is the same as before
// except during the exit.
import { useEffect, useState } from "react";
import { useNudg } from "@nudg/core/react";
import toast from "./motion/toast.nudg.json";
import snackMotion from "./motion/snack.nudg.json";

const EXIT_MS = 400;

export default function Toast({ shown, children, ...rest }: { shown: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const [mounted, setMounted] = useState(shown);
  useEffect(() => {
    if (shown) setMounted(true);
    else {
      const t = setTimeout(() => setMounted(false), EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [shown]);
  return mounted ? <ToastBody shown={shown} {...rest}>{children}</ToastBody> : null;
}

function ToastBody({ shown, children, ...rest }: { shown: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const { bind, send } = useNudg(toast, { files: { "snack.nudg.json": snackMotion } });
  useEffect(() => {
    send(shown ? "host.show" : "host.hide");
  }, [shown, send]);
  return <div ref={bind("toast")} {...rest}>{children}</div>;
}
