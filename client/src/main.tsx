import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { resumeLiveTrackingIfNeeded } from "./lib/live-location";

if ('serviceWorker' in navigator) {
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

createRoot(document.getElementById("root")!).render(<App />);
