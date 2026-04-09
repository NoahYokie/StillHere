import { apiRequest } from "./queryClient";

type ActivityType = "stationary" | "walking" | "running" | "cycling" | "driving";

interface LiveLocationCallbacks {
  onUpdate?: (position: GeolocationPosition, activity: ActivityType) => void;
  onError?: (error: string) => void;
  onExpired?: () => void;
}

let watchId: number | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let lastSentTime = 0;
let lastPosition: GeolocationPosition | null = null;
let callbacks: LiveLocationCallbacks = {};

const MIN_SEND_INTERVAL_MS = 5000;
const STATIONARY_SEND_INTERVAL_MS = 30000;
const MOVING_SEND_INTERVAL_MS = 5000;

function detectActivityFromSpeed(speedMs: number | null | undefined): ActivityType {
  if (speedMs == null || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;
  if (kmh < 7) return "walking";
  if (kmh < 20) return "running";
  if (kmh < 35) return "cycling";
  return "driving";
}

async function sendLocationUpdate(position: GeolocationPosition): Promise<void> {
  const now = Date.now();
  const activity = detectActivityFromSpeed(position.coords.speed);

  const interval = activity === "stationary" ? STATIONARY_SEND_INTERVAL_MS : MOVING_SEND_INTERVAL_MS;
  if (now - lastSentTime < interval) return;

  lastSentTime = now;
  lastPosition = position;

  try {
    await apiRequest("POST", "/api/live-location/update", {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      speed: position.coords.speed,
      heading: position.coords.heading,
      activity,
    });
    callbacks.onUpdate?.(position, activity);
  } catch (error: any) {
    if (error?.message?.includes("expired")) {
      callbacks.onExpired?.();
      stopLiveTracking();
    } else {
      callbacks.onError?.(error?.message || "Failed to send location");
    }
  }
}

export function startLiveTracking(cbs: LiveLocationCallbacks = {}): boolean {
  if (!navigator.geolocation) {
    cbs.onError?.("Geolocation is not supported by this device");
    return false;
  }

  callbacks = cbs;
  lastSentTime = 0;

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      lastPosition = position;
      sendLocationUpdate(position);
    },
    (error) => {
      callbacks.onError?.(error.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000,
    }
  );

  updateInterval = setInterval(() => {
    if (lastPosition) {
      sendLocationUpdate(lastPosition);
    }
  }, 10000);

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
  lastPosition = null;
  lastSentTime = 0;
  callbacks = {};
}

export function isLiveTrackingActive(): boolean {
  return watchId !== null;
}

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
