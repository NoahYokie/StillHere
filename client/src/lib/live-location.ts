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
let nativePluginActive = false;
let trackingSessionId = 0;
let nativeSubscriptions: Array<{ remove: () => void }> = [];
let silentAudioEl: HTMLAudioElement | null = null;
const listeners = new Set<LocationListener>();
let onErrorCb: ((err: string) => void) | null = null;
let onExpiredCb: (() => void) | null = null;

const STATIONARY_SEND_INTERVAL_MS = 30000;
const MOVING_SEND_INTERVAL_MS = 5000;
const KEEPALIVE_CHECK_MS = 10000;
const STALE_THRESHOLD_MS = 45000;

const SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

function detectActivityFromSpeed(speedMs: number | null | undefined): ActivityType {
  if (speedMs == null || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;
  if (kmh < 7) return "walking";
  if (kmh < 20) return "running";
  if (kmh < 35) return "cycling";
  return "driving";
}

function startSilentAudio() {
  try {
    if (silentAudioEl) {
      if (silentAudioEl.paused) {
        silentAudioEl.play().catch(() => {});
      }
      return;
    }
    const el = document.createElement("audio");
    el.id = "stillhere-keepalive-audio";
    el.loop = true;
    el.muted = true;
    el.setAttribute("playsinline", "true");
    el.style.display = "none";
    el.src = SILENT_WAV_BASE64;
    document.body.appendChild(el);
    el.play().then(() => {
      el.muted = false;
    }).catch(() => {});
    silentAudioEl = el;
  } catch {}
}

function stopSilentAudio() {
  if (silentAudioEl) {
    try {
      silentAudioEl.pause();
      silentAudioEl.src = "";
      silentAudioEl.remove();
    } catch {}
    silentAudioEl = null;
  }
}

async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await (navigator as any).wakeLock.request("screen");
      wakeLock?.addEventListener("release", () => {
        wakeLock = null;
        if (localStorage.getItem("liveLocationActive") === "true" && document.visibilityState === "visible") {
          acquireWakeLock();
        }
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

async function sendLocationUpdate(position: GeolocationPosition, force = false): Promise<void> {
  const now = Date.now();
  const activity = detectActivityFromSpeed(position.coords.speed);

  if (!force) {
    const interval = activity === "stationary" ? STATIONARY_SEND_INTERVAL_MS : MOVING_SEND_INTERVAL_MS;
    if (now - lastSentTime < interval) return;
  }

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

function restartGpsWatch() {
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
      maximumAge: 0,
      timeout: 20000,
    }
  );
}

function startGpsWatch() {
  if (nativePluginActive) return;

  restartGpsWatch();

  if (updateInterval) clearInterval(updateInterval);
  updateInterval = setInterval(() => {
    if (lastPosition) {
      sendLocationUpdate(lastPosition);
    }
  }, 10000);

  startKeepAlive();
  acquireWakeLock();
  startSilentAudio();
  showPersistentNotification();
}

function startKeepAlive() {
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  let lastTick = Date.now();

  keepAliveInterval = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;

    const wasSuspended = drift > KEEPALIVE_CHECK_MS * 3;
    const isStale = (now - lastSentTime) > STALE_THRESHOLD_MS;

    if (wasSuspended || isStale) {
      lastSentTime = 0;
      restartGpsWatch();
      acquireWakeLock();

      if (!silentAudioEl || silentAudioEl.paused) {
        startSilentAudio();
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastPosition = pos;
          sendLocationUpdate(pos, true);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    }
  }, KEEPALIVE_CHECK_MS);
}

async function tryNativeBackgroundGeo(sessionId: number): Promise<boolean> {
  try {
    const pluginId = "@transistorsoft/capacitor-background-geolocation";
    const mod = await import(/* @vite-ignore */ pluginId);
    const BG = mod.default;

    if (trackingSessionId !== sessionId) return false;

    for (const sub of nativeSubscriptions) {
      try { sub.remove(); } catch {}
    }
    nativeSubscriptions = [];

    nativeSubscriptions.push(BG.onLocation((location: any) => {
      const pos = {
        coords: {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracy: location.coords.accuracy,
          speed: location.coords.speed,
          heading: location.coords.heading,
          altitude: location.coords.altitude,
          altitudeAccuracy: location.coords.altitude_accuracy,
        },
        timestamp: location.timestamp ? new Date(location.timestamp).getTime() : Date.now(),
      } as GeolocationPosition;
      lastPosition = pos;
      sendLocationUpdate(pos, true);
    }));

    nativeSubscriptions.push(BG.onMotionChange((event: any) => {
      if (event.isMoving) {
        lastSentTime = 0;
      }
    }));

    nativeSubscriptions.push(BG.onHeartbeat(() => {
      BG.getCurrentPosition({ samples: 1, persist: false }).then((location: any) => {
        const pos = {
          coords: {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
            speed: location.coords.speed,
            heading: location.coords.heading,
            altitude: location.coords.altitude,
            altitudeAccuracy: location.coords.altitude_accuracy,
          },
          timestamp: Date.now(),
        } as GeolocationPosition;
        sendLocationUpdate(pos, true);
      }).catch(() => {});
    }));

    if (trackingSessionId !== sessionId) return false;

    const state = await BG.ready({
      desiredAccuracy: BG.DESIRED_ACCURACY_HIGH,
      distanceFilter: 10,
      stopOnTerminate: false,
      startOnBoot: true,
      heartbeatInterval: 60,
      preventSuspend: true,
      foregroundService: true,
      notification: {
        title: "StillHere",
        text: "Location sharing active",
      },
      enableHeadless: true,
      stopTimeout: 5,
      locationAuthorizationRequest: "Always",
    });

    if (trackingSessionId !== sessionId) return false;

    if (!state.enabled) {
      await BG.start();
    }

    nativePluginActive = true;
    return true;
  } catch {
    return false;
  }
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

  const currentSession = ++trackingSessionId;
  tryNativeBackgroundGeo(currentSession).then((nativeOk) => {
    if (trackingSessionId !== currentSession) return;
    if (!nativeOk) {
      startGpsWatch();
    }
  });

  localStorage.setItem("liveLocationActive", "true");
  return true;
}

export async function stopLiveTracking(): Promise<void> {
  trackingSessionId++;

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

  for (const sub of nativeSubscriptions) {
    try { sub.remove(); } catch {}
  }
  nativeSubscriptions = [];

  if (nativePluginActive) {
    try {
      const pluginId = "@transistorsoft/capacitor-background-geolocation";
      const mod = await import(/* @vite-ignore */ pluginId);
      await mod.default.stop();
      nativePluginActive = false;
    } catch {}
  }

  lastPosition = null;
  lastSentTime = 0;
  listeners.clear();
  onErrorCb = null;
  onExpiredCb = null;
  releaseWakeLock();
  stopSilentAudio();
  clearPersistentNotification();
  localStorage.removeItem("liveLocationActive");
}

export function isLiveTrackingActive(): boolean {
  return watchId !== null || nativePluginActive;
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
  if (watchId !== null || nativePluginActive) return true;

  const wasActive = localStorage.getItem("liveLocationActive") === "true";
  if (!wasActive) return false;

  try {
    const res = await fetch("/api/live-location/status", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("liveLocationActive");
        clearPersistentNotification();
        stopSilentAudio();
      }
      return false;
    }
    const data = await res.json();
    if (!data.active) {
      localStorage.removeItem("liveLocationActive");
      clearPersistentNotification();
      stopSilentAudio();
      return false;
    }

    return startLiveTracking({
      onError: (err) => {
        if (err.toLowerCase().includes("denied") || err.toLowerCase().includes("permission")) {
          stopLiveTracking();
        }
      },
    });
  } catch {
    return false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && localStorage.getItem("liveLocationActive") === "true") {
    if (watchId === null && !nativePluginActive) {
      resumeLiveTrackingIfNeeded();
    } else if (watchId !== null) {
      lastSentTime = 0;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastPosition = pos;
          sendLocationUpdate(pos, true);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    }
    acquireWakeLock();

    if (silentAudioEl?.paused) {
      silentAudioEl.play().catch(() => {});
    }
  }
});

window.addEventListener("focus", () => {
  if (localStorage.getItem("liveLocationActive") === "true") {
    if (watchId === null && !nativePluginActive) {
      resumeLiveTrackingIfNeeded();
    }
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
