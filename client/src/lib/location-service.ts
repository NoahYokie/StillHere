type LocationState = {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  speed: number | null;
  heading: number | null;
};

type LocationSubscriber = (state: LocationState) => void;
type ErrorSubscriber = (msg: string) => void;

let currentState: LocationState | null = null;
let watchId: number | null = null;
let hasInitialFix = false;
let subscriberCount = 0;

const subscribers = new Set<LocationSubscriber>();
const errorSubscribers = new Set<ErrorSubscriber>();

function shouldAccept(accuracy: number, timestamp: number): boolean {
  if (!hasInitialFix) return true;
  if (accuracy > 500) {
    console.log(`[GPS] Rejected position: accuracy ${Math.round(accuracy)}m > 500m`);
    return false;
  }
  if (currentState && timestamp < currentState.timestamp) {
    console.log(`[GPS] Rejected position: timestamp ${timestamp} older than ${currentState.timestamp}`);
    return false;
  }
  return true;
}

function handlePosition(pos: GeolocationPosition) {
  const { latitude, longitude, accuracy, speed, heading } = pos.coords;
  const timestamp = pos.timestamp;

  if (!shouldAccept(accuracy, timestamp)) return;

  hasInitialFix = true;
  currentState = { lat: latitude, lng: longitude, accuracy, timestamp, speed, heading };

  console.log(`[GPS] New position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}, accuracy ${Math.round(accuracy)}m`);

  subscribers.forEach(fn => {
    try { fn(currentState!); } catch {}
  });
}

function handleError(err: GeolocationPositionError) {
  const msg = err.code === err.PERMISSION_DENIED
    ? "Location permission denied"
    : err.code === err.POSITION_UNAVAILABLE
      ? "Position unavailable"
      : "Location request timed out";
  console.log(`[GPS] Error: ${msg}`);
  errorSubscribers.forEach(fn => {
    try { fn(msg); } catch {}
  });
}

function startWatch() {
  if (watchId !== null) return;

  console.log("[GPS] Starting single GPS watch");
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleError,
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
}

function stopWatch() {
  if (watchId === null) return;
  console.log("[GPS] Stopping GPS watch");
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  hasInitialFix = false;
  currentState = null;
}

export function subscribe(fn: LocationSubscriber): () => void {
  subscribers.add(fn);
  subscriberCount++;

  if (subscriberCount === 1) {
    startWatch();
  }

  if (currentState) {
    try { fn(currentState); } catch {}
  }

  return () => {
    subscribers.delete(fn);
    subscriberCount--;
    if (subscriberCount <= 0) {
      subscriberCount = 0;
      stopWatch();
    }
  };
}

export function subscribeError(fn: ErrorSubscriber): () => void {
  errorSubscribers.add(fn);
  return () => { errorSubscribers.delete(fn); };
}

export function getCurrentPosition(): LocationState | null {
  return currentState;
}

export function isWatching(): boolean {
  return watchId !== null;
}

export function forceRefresh(): void {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    handlePosition,
    () => {},
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}
