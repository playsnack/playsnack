import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { configureTelemetry, installErrorBeacon, telemetryEnabled, trackDailySeen } from "./telemetry";
import { initDebug } from "./debugLog";

// Anonymous error beacon (docs/telemetry.md; off in dev, with DNT/GPC or VITE_TELEMETRY=off)
// and the on-device test log (?debug=1, loaded only then).
if (telemetryEnabled()) {
  configureTelemetry({ build: __BUILD_ID__ });
  installErrorBeacon(__BUILD_ID__);
  trackDailySeen(); // once per KST day: random browser id (HyperLogLog only) + usage buckets
}
const DebugLog = initDebug(__BUILD_ID__) ? lazy(() => import("./DebugLog.tsx")) : null;

// No StrictMode: it double-invokes effects in dev, which would init/destroy
// the Pixi Application twice per mount. The player owns a single WebGL context.
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    {DebugLog && <Suspense fallback={null}><DebugLog /></Suspense>}
  </>,
);
