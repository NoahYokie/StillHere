let apiKey: string | null = null;
let loadPromise: Promise<void> | null = null;
let loaded = false;

export async function getGoogleMapsApiKey(): Promise<string> {
  if (apiKey) return apiKey;
  const res = await fetch("/api/maps/config", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load maps config");
  const data = await res.json();
  apiKey = data.apiKey;
  return apiKey!;
}

export async function loadGoogleMaps(): Promise<typeof google.maps> {
  if (loaded && window.google?.maps) return window.google.maps;
  if (loadPromise) {
    await loadPromise;
    return window.google.maps;
  }

  loadPromise = (async () => {
    const key = await getGoogleMapsApiKey();
    await new Promise<void>((resolve, reject) => {
      if (window.google?.maps) { loaded = true; resolve(); return; }
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,geometry,marker,visualization&v=weekly`;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        console.log("[MAPS] Google Maps JS API loaded successfully");
        loaded = true;
        resolve();
      };
      script.onerror = (e) => {
        console.error("[MAPS] Failed to load Google Maps JS API script", e);
        reject(new Error("Failed to load Google Maps"));
      };
      document.head.appendChild(script);
    });
  })();

  await loadPromise;
  return window.google.maps;
}

export function isGoogleMapsLoaded(): boolean {
  return loaded && !!window.google?.maps;
}
