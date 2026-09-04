import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// TEMPORARY — Task 15.9E-D.1 diagnostic telemetry overlay. Remove after audit.
import { DiagnosticTelemetryOverlay } from "./components/diagnostic-telemetry-overlay";
import { resumeLiveTrackingIfNeeded } from "./lib/live-location";
import { installNativeFetchBridge, isNativeApp } from "./lib/native-api";
import { isIOS } from "./lib/capacitor";

installNativeFetchBridge();

if (isNativeApp()) {
  document.documentElement.classList.add("capacitor-native");
  if (isIOS()) {
    document.documentElement.classList.add("capacitor-ios");
    document.body.classList.add("capacitor-ios");
  }
}

if (!isNativeApp() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(async (registration) => {
        console.log('SW registered:', registration.scope);

        if ('periodicSync' in registration) {
          try {
            const status = await navigator.permissions.query({ name: 'periodic-background-sync' as any });
            if (status.state === 'granted') {
              await (registration as any).periodicSync.register('live-location-sync', {
                minInterval: 60 * 1000,
              });
            }
          } catch {}
        }
      })
      .catch((error) => {
        console.log('SW registration failed:', error);
      });
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'resume-location-tracking') {
      resumeLiveTrackingIfNeeded().catch(() => {});
    }
  });
}

// TEMPORARY — Task 15.9E-D.1. When the flag is unset (production), the render
// tree is byte-identical to `<App />`. Remove this gate and the import above
// once telemetry capture is complete.
const SHOW_DIAGNOSTIC_TELEMETRY =
  import.meta.env.VITE_DIAGNOSTIC_TELEMETRY === "true";

createRoot(document.getElementById("root")!).render(
  SHOW_DIAGNOSTIC_TELEMETRY ? (
    <>
      <App />
      <DiagnosticTelemetryOverlay />
    </>
  ) : (
    <App />
  ),
);
