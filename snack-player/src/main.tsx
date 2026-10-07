import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// No StrictMode: it double-invokes effects in dev, which would init/destroy
// the Pixi Application twice per mount. The player owns a single WebGL context.
createRoot(document.getElementById("root")!).render(<App />);
