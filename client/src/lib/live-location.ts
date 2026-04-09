import { apiRequest } from "./queryClient";

type ActivityType = "stationary" | "walking" | "running" | "cycling" | "driving";

type LocationListener = (data: {
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  activity: ActivityType;
}) => void;

let watchId: number | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let lastSentTime = 0;
let lastPosition: GeolocationPosition | null = null;
let wakeLock: WakeLockSentinel | null = null;
let persistentNotifShown = false;
const listeners = new Set<LocationListener>();
let onErrorCb: ((err: string) => void) | null = null;
let onExpiredCb: (() => void) | null = null;

const STATIONARY_SEND_INTERVAL_MS = 30000;
const MOVING_SEND_INTERVAL_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 15000;

function detectActivityFromSpeed(speedMs: number | null | undefined): ActivityType {
  if (speedMs == null || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;
  if (kmh < 7) return "walking";
  if (kmh < 20) return "running";
  if (kmh < 35) return "cycling";
  return "driving";
}

async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await (navigator as any).wakeLock.request("screen");
      wakeLock?.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {}
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
    wakeLock = null;
  } catch {}
}

async function showPersistentNotification() {
  if (persistentNotifShown) return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const reg = await navigator.serviceWorker?.ready;
      if (reg) {
        await reg.showNotification("StillHere - Location sharing active", {
          body: "Your emergency contacts can see your location. Tap to open.",
          icon: "/icons/icon-192x192.png",
          badge: "/icons/icon-96x96.png",
          tag: "live-location-active",
          requireInteraction: true,
          silent: true,
          data: { url: "/live-location" },
        });
        persistentNotifShown = true;
      }
    }
  } catch {}
}

async function clearPersistentNotification() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      const notifs = await reg.getNotifications({ tag: "live-location-active" });
      notifs.forEach(n => n.close());
    }
    persistentNotifShown = false;
  } catch {}
}

async function sendLocationUpdate(position: GeolocationPosition): Promise<void> {
  const now = Date.now();
  const activity = detectActivityFromSpeed(position.coords.speed);

  const interval = activity === "stationary" ? STATIONARY_SEND_INTERVAL_MS : MOVING_SEND_INTERVAL_MS;
  if (now - lastSentTime < interval) return;

  lastSentTime = now;
  lastPosition = position;

  const data = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    speed: position.coords.speed,
    heading: position.coords.heading,
    activity,
  };

  try {
    await apiRequest("POST", "/api/live-location/update", data);
    listeners.forEach(fn => fn({
      lat: data.lat,
      lng: data.lng,
      speed: data.speed,
      heading: data.heading,
      activity,
    }));
  } catch (error: any) {
    const msg = error?.message || "";
    if (msg.includes("expired") || msg.includes("No active")) {
      stopLiveTracking();
      onExpiredCb?.();
    } else {
      onErrorCb?.(msg || "Failed to send location");
    }
  }
}

function startGpsWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      lastPosition = position;
      sendLocationUpdate(position);
    },
    (error) => {
      onErrorCb?.(error.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000,
    }
  );

  if (updateInterval) clearInterval(updateInterval);
  updateInterval = setInterval(() => {
    if (lastPosition) {
      sendLocationUpdate(lastPosition);
    }
  }, 10000);

  startKeepAlive();
  acquireWakeLock();
  showPersistentNotification();
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  let lastTick = Date.now();

  keepAliveInterval = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;

    if (drift > KEEPALIVE_INTERVAL_MS * 3) {
      lastSentTime = 0;
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          lastPosition = position;
          sendLocationUpdate(position);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
      acquireWakeLock();
    }

    if (lastPosition && (now - lastSentTime > STATIONARY_SEND_INTERVAL_MS + 5000)) {
      lastSentTime = 0;
      sendLocationUpdate(lastPosition);
    }
  }, KEEPALIVE_INTERVAL_MS);
}

export function startLiveTracking(opts?: {
  onError?: (err: string) => void;
  onExpired?: () => void;
  onUpdate?: (position: GeolocationPosition, activity: ActivityType) => void;
}): boolean {
  if (!navigator.geolocation) {
    opts?.onError?.("Geolocation is not supported by this device");
    return false;
  }

  onErrorCb = opts?.onError || null;
  onExpiredCb = opts?.onExpired || null;
  lastSentTime = 0;

  if (opts?.onUpdate) {
    const updateFn: LocationListener = (data) => {
      if (lastPosition) {
        opts.onUpdate!(lastPosition, data.activity);
      }
    };
    listeners.add(updateFn);
  }

  startGpsWatch();
  localStorage.setItem("liveLocationActive", "true");
  return true;
}

export function stopLiveTracking(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  lastPosition = null;
  lastSentTime = 0;
  listeners.clear();
  onErrorCb = null;
  onExpiredCb = null;
  releaseWakeLock();
  clearPersistentNotification();
  localStorage.removeItem("liveLocationActive");
}

export function isLiveTrackingActive(): boolean {
  return watchId !== null;
}

export function isLiveTrackingEnabled(): boolean {
  return localStorage.getItem("liveLocationActive") === "true";
}

export function addLocationListener(fn: LocationListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function removeLocationListener(fn: LocationListener): void {
  listeners.delete(fn);
}

export async function resumeLiveTrackingIfNeeded(): Promise<boolean> {
  if (watchId !== null) return true;

  const wasActive = localStorage.getItem("liveLocationActive") === "true";
  if (!wasActive) return false;

  try {
    const res = await fetch("/api/live-location/status", { credentials: "include" });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.active) {
      localStorage.removeItem("liveLocationActive");
      clearPersistentNotification();
      return false;
    }

    return startLiveTracking();
  } catch {
    return false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && localStorage.getItem("liveLocationActive") === "true") {
    if (watchId === null) {
      resumeLiveTrackingIfNeeded();
    } else {
      lastSentTime = 0;
      if (lastPosition) {
        sendLocationUpdate(lastPosition);
      }
    }
    acquireWakeLock();
  }
});

window.addEventListener("focus", () => {
  if (localStorage.getItem("liveLocationActive") === "true" && watchId === null) {
    resumeLiveTrackingIfNeeded();
  }
});

export function formatActivity(activity: string | null | undefined): string {
  switch (activity) {
    case "stationary": return "Stationary";
    case "walking": return "Walking";
    case "running": return "Running";
    case "cycling": return "Cycling";
    case "driving": return "Driving";
    default: return "Unknown";
  }
}

export function formatSpeed(speedMs: number | null | undefined): string {
  if (speedMs == null || speedMs < 0.5) return "0 km/h";
  return `${Math.round(speedMs * 3.6)} km/h`;
}
