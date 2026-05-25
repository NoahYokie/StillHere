import { apiRequest } from "./queryClient";
import { subscribe as subscribeGps, subscribeError as subscribeGpsError, forceRefresh as forceGpsRefresh, getTrackingSource, isNativeBackgroundAllowed } from "./location-service";
import {
  refreshPolicy,
  isNativeTrackingAllowed,
  getCachedPolicy,
  didJustFlipToAllowed,
  consumeFlipMarker,
  subscribePolicy,
  applyPushedPolicy,
  clearCachedPolicy,
} from "./tracking-policy-cache";
import { getSocket } from "./socket";

type ActivityType = "stationary" | "walking" | "running" | "cycling" | "driving";

type LocationListener = (data: {
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  activity: ActivityType;
}) => void;

let gpsUnsubscribe: (() => void) | null = null;
let gpsErrorUnsubscribe: (() => void) | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let policyPollInterval: ReturnType<typeof setInterval> | null = null;
let policyUnsubscribe: (() => void) | null = null;
let socketListenerInstalled = false;
let lastSentTime = 0;
let lastPosition: GeolocationPosition | null = null;
let wakeLock: WakeLockSentinel | null = null;
let persistentNotifShown = false;
let trackingSessionId = 0;
let silentAudioEl: HTMLAudioElement | null = null;
const listeners = new Set<LocationListener>();
let onErrorCb: ((err: string) => void) | null = null;
let onExpiredCb: (() => void) | null = null;

const STATIONARY_SEND_INTERVAL_MS = 30000;
const MOVING_SEND_INTERVAL_MS = 5000;
const KEEPALIVE_CHECK_MS = 10000;
const STALE_THRESHOLD_MS = 45000;
const POLICY_POLL_MS = 60000;

const SILENT_WAV_BASE64 = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

function detectActivityFromSpeed(speedMs: number | null | undefined): ActivityType {
  if (speedMs == null || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;
  if (kmh < 7) return "walking";
  if (kmh < 20) return "running";
  if (kmh < 35) return "cycling";
  return "driving";
}

function distanceMeters(a: GeolocationPosition, b: GeolocationPosition): number {
  const R = 6371000;
  const dLat = ((b.coords.latitude - a.coords.latitude) * Math.PI) / 180;
  const dLng = ((b.coords.longitude - a.coords.longitude) * Math.PI) / 180;
  const lat1 = (a.coords.latitude * Math.PI) / 180;
  const lat2 = (b.coords.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDegrees(a: GeolocationPosition, b: GeolocationPosition): number {
  const lat1 = (a.coords.latitude * Math.PI) / 180;
  const lat2 = (b.coords.latitude * Math.PI) / 180;
  const dLng = ((b.coords.longitude - a.coords.longitude) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function inferMotion(position: GeolocationPosition): { speed: number | null; heading: number | null } {
  const reportedSpeed = position.coords.speed;
  const reportedHeading = position.coords.heading;
  if (!lastPosition) {
    return {
      speed: reportedSpeed ?? null,
      heading: reportedHeading ?? null,
    };
  }

  const elapsedSeconds = (position.timestamp - lastPosition.timestamp) / 1000;
  if (elapsedSeconds < 2 || elapsedSeconds > 90) {
    return {
      speed: reportedSpeed ?? null,
      heading: reportedHeading ?? null,
    };
  }

  const distance = distanceMeters(lastPosition, position);
  const accuracyFloor = Math.max(
    8,
    ((position.coords.accuracy || 0) + (lastPosition.coords.accuracy || 0)) / 2,
  );
  const estimatedSpeed = distance > accuracyFloor ? distance / elapsedSeconds : 0;

  return {
    speed: reportedSpeed != null && reportedSpeed >= 0 ? reportedSpeed : estimatedSpeed,
    heading: reportedHeading != null && reportedHeading >= 0
      ? reportedHeading
      : distance > 10
      ? bearingDegrees(lastPosition, position)
      : null,
  };
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
        await reg.showNotification("StillHere: Location sharing active", {
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
  // Defense-in-depth: refuse to upload coordinates if the cached policy
  // says native tracking is no longer allowed. The server enforces too.
  if (!isNativeTrackingAllowed()) {
    return;
  }

  const now = Date.now();
  const motion = inferMotion(position);
  const activity = detectActivityFromSpeed(motion.speed);

  const accuracy = position.coords.accuracy;
  if (accuracy != null && accuracy > 150 && !force) return;

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
    speed: motion.speed,
    heading: motion.heading,
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

async function fireOneShotLocationUpdate(): Promise<void> {
  // When the policy flips false → true (e.g. an incident opens for a
  // presence-mode user), the watcher would otherwise stare at "Locating..."
  // until BackgroundGeolocation fires its first sample. We grab one
  // foreground point with a tight 5s timeout to close that gap.
  try {
    const Cap = (globalThis as any).Capacitor;
    if (Cap?.isNativePlatform?.()) {
      const geoMod: any = await import(/* @vite-ignore */ "@capacitor/geolocation" as any);
      const Geolocation = geoMod?.Geolocation || geoMod?.default?.Geolocation;
      if (Geolocation?.getCurrentPosition) {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 });
        await sendLocationUpdate({
          coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed ?? null,
            heading: pos.coords.heading ?? null,
            altitude: null,
            altitudeAccuracy: null,
          },
          timestamp: pos.timestamp,
        } as GeolocationPosition, true);
        return;
      }
    }
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5000);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(timer);
            sendLocationUpdate(pos, true).finally(() => resolve());
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
        );
      });
    }
  } catch {}
}

function startGpsSubscription() {
  if (gpsUnsubscribe) return;

  gpsUnsubscribe = subscribeGps((state) => {
    const pos = {
      coords: {
        latitude: state.lat,
        longitude: state.lng,
        accuracy: state.accuracy,
        speed: state.speed,
        heading: state.heading,
        altitude: null,
        altitudeAccuracy: null,
      },
      timestamp: state.timestamp,
    } as GeolocationPosition;
    lastPosition = pos;
    sendLocationUpdate(pos);
  });

  gpsErrorUnsubscribe = subscribeGpsError((msg) => {
    onErrorCb?.(msg);
  });

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
      acquireWakeLock();

      if (!silentAudioEl || silentAudioEl.paused) {
        startSilentAudio();
      }

      forceGpsRefresh();
    }
  }, KEEPALIVE_CHECK_MS);
}

/**
 * Server-side tracking policy is the source of truth. This function refreshes
 * the cached decision and either starts or stops native tracking accordingly.
 *
 * Called from:
 *   - 60-second poll while live tracking is active
 *   - visibilitychange / focus
 *   - tracking-policy:changed socket event
 */
async function reconcileWithServerPolicy(): Promise<void> {
  const before = isNativeTrackingAllowed();
  const policy = await refreshPolicy();
  const after = !!policy?.nativeTrackingAllowed;

  if (after && !before) {
    // Just got permission — fire one-shot mitigation if we have a flip marker
    if (didJustFlipToAllowed()) {
      consumeFlipMarker();
      fireOneShotLocationUpdate().catch(() => {});
    }
  }

  if (!after && gpsUnsubscribe !== null) {
    // Lost permission mid-session. Stop native GPS within ~2 seconds.
    console.log("[LiveLocation] Tracking policy revoked — stopping native GPS");
    await stopLiveTracking();
    onExpiredCb?.();
  }
}

function startPolicyPolling() {
  if (policyPollInterval) return;
  policyPollInterval = setInterval(() => {
    reconcileWithServerPolicy();
  }, POLICY_POLL_MS);
}

function stopPolicyPolling() {
  if (policyPollInterval) {
    clearInterval(policyPollInterval);
    policyPollInterval = null;
  }
}

function installPolicySocketListener() {
  if (socketListenerInstalled) return;
  try {
    const socket = getSocket();
    socket.on("tracking-policy:changed", (payload: any) => {
      try {
        applyPushedPolicy({
          nativeTrackingAllowed: !!payload?.nativeTrackingAllowed,
          heartbeatAllowed: payload?.heartbeatAllowed,
          reason: payload?.reason,
        });
        // Always re-fetch the full policy to be sure (covers any race
        // between the lightweight push payload and the canonical state).
        reconcileWithServerPolicy();
      } catch {}
    });
    socketListenerInstalled = true;
  } catch {
    // socket may not be available yet; will retry on next startLiveTracking call
  }
}

function installPolicySubscriber() {
  if (policyUnsubscribe) return;
  policyUnsubscribe = subscribePolicy((p) => {
    if (!p?.nativeTrackingAllowed && gpsUnsubscribe !== null) {
      // Cache says revoked — stop native GPS.
      stopLiveTracking().then(() => onExpiredCb?.());
    }
  });
}

/**
 * Server-authoritative gate. If the cached decision says no, refresh once;
 * if still no, refuse to start. Fail closed.
 */
async function assertNativeTrackingAllowed(): Promise<boolean> {
  const cached = getCachedPolicy();
  if (cached && cached.nativeTrackingAllowed) return true;
  const fresh = await refreshPolicy();
  return !!fresh?.nativeTrackingAllowed;
}

export async function startLiveTrackingAsync(opts?: {
  onError?: (err: string) => void;
  onExpired?: () => void;
  onUpdate?: (position: GeolocationPosition, activity: ActivityType) => void;
}): Promise<boolean> {
  if (typeof navigator === "undefined" || (!navigator.geolocation && typeof (globalThis as any).Capacitor === "undefined")) {
    opts?.onError?.("Geolocation is not supported by this device");
    return false;
  }

  onErrorCb = opts?.onError || null;
  onExpiredCb = opts?.onExpired || null;
  lastSentTime = 0;

  // Server policy gate. Fail closed if the server says no.
  const allowed = await assertNativeTrackingAllowed();
  if (!allowed) {
    const reason = getCachedPolicy()?.reason || "no_active_session";
    console.log(`[LiveLocation] Native tracking denied by server policy (reason=${reason})`);
    opts?.onError?.("Location sharing is not currently allowed");
    return false;
  }

  if (opts?.onUpdate) {
    const updateFn: LocationListener = (data) => {
      if (lastPosition) {
        opts.onUpdate!(lastPosition, data.activity);
      }
    };
    listeners.add(updateFn);
  }

  ++trackingSessionId;
  startGpsSubscription();
  startPolicyPolling();
  installPolicySocketListener();
  installPolicySubscriber();
  console.log(`[LiveLocation] Started via location-service (source=${getTrackingSource()})`);

  setTimeout(() => {
    const cap = (globalThis as any).Capacitor;
    if (cap?.isNativePlatform?.() && isNativeBackgroundAllowed() && getTrackingSource() !== "native-bg") {
      const msg = "Live location works while the app is open. Enable Always Location for background sharing.";
      console.warn(`[LiveLocation] ${msg} source=${getTrackingSource()}`);
      onErrorCb?.(msg);
    }
  }, 3000);

  localStorage.setItem("liveLocationActive", "true");
  return true;
}

/**
 * Backwards-compatible synchronous wrapper. Existing call sites use the
 * boolean return for an immediate UX response — we kick off the async
 * version and return true if the cached policy already approves, false
 * otherwise. The async path will stop tracking if the server later denies.
 */
export function startLiveTracking(opts?: {
  onError?: (err: string) => void;
  onExpired?: () => void;
  onUpdate?: (position: GeolocationPosition, activity: ActivityType) => void;
}): boolean {
  const optimistic = isNativeTrackingAllowed();
  startLiveTrackingAsync(opts).catch(() => {});
  return optimistic;
}

export async function stopLiveTracking(): Promise<void> {
  trackingSessionId++;

  if (gpsUnsubscribe) {
    gpsUnsubscribe();
    gpsUnsubscribe = null;
  }
  if (gpsErrorUnsubscribe) {
    gpsErrorUnsubscribe();
    gpsErrorUnsubscribe = null;
  }
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  stopPolicyPolling();
  if (policyUnsubscribe) {
    policyUnsubscribe();
    policyUnsubscribe = null;
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
  return gpsUnsubscribe !== null;
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
  if (gpsUnsubscribe !== null) return true;

  const wasActive = localStorage.getItem("liveLocationActive") === "true";
  if (!wasActive) {
    // Even if we're not resuming live tracking, install the policy listener
    // so the heartbeat client can receive policy push events.
    installPolicySocketListener();
    refreshPolicy().catch(() => {});
    return false;
  }

  try {
    const res = await fetch("/api/live-location/status", { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("liveLocationActive");
        clearPersistentNotification();
        stopSilentAudio();
        clearCachedPolicy();
      }
      return false;
    }
    const data = await res.json();
    // Update the cache with this fresh status response.
    applyPushedPolicy({
      nativeTrackingAllowed: !!data.nativeTrackingAllowed,
      heartbeatAllowed: data.heartbeatAllowed !== false,
      reason: data.reason,
    });

    if (!data.active || !data.nativeTrackingAllowed) {
      localStorage.removeItem("liveLocationActive");
      clearPersistentNotification();
      stopSilentAudio();
      installPolicySocketListener();
      return false;
    }

    return await startLiveTrackingAsync({
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
    if (gpsUnsubscribe === null) {
      resumeLiveTrackingIfNeeded();
    } else {
      lastSentTime = 0;
      forceGpsRefresh();
      reconcileWithServerPolicy();
    }
    acquireWakeLock();

    if (silentAudioEl?.paused) {
      silentAudioEl.play().catch(() => {});
    }
  } else if (document.visibilityState === "visible") {
    // Page came back; refresh policy even when not actively tracking.
    reconcileWithServerPolicy();
  }
});

window.addEventListener("focus", () => {
  if (localStorage.getItem("liveLocationActive") === "true") {
    if (gpsUnsubscribe === null) {
      resumeLiveTrackingIfNeeded();
    } else {
      reconcileWithServerPolicy();
    }
  } else {
    reconcileWithServerPolicy();
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
