export type LocationState = {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  speed: number | null;
  heading: number | null;
  isStale: boolean;
};

export type LocationMode = "normal" | "high_accuracy";

type LocationSubscriber = (state: LocationState) => void;
type ErrorSubscriber = (msg: string) => void;

const VALID_ACCURACY_THRESHOLD = 100;
const JITTER_DISTANCE_KM = 5;
const JITTER_TIME_MS = 10000;

const MODE_CONFIG: Record<LocationMode, PositionOptions> = {
  normal: { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  high_accuracy: { enableHighAccuracy: true, maximumAge: 2000, timeout: 5000 },
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class LocationService {
  private currentState: LocationState | null = null;
  private watchId: number | null = null;
  private locating = true;
  private subscribers = new Set<LocationSubscriber>();
  private errorSubscribers = new Set<ErrorSubscriber>();
  private locatingSubscribers = new Set<(v: boolean) => void>();

  private highAccuracyRefCount = 0;
  private activeMode: LocationMode = "normal";

  private shouldAccept(lat: number, lng: number, accuracy: number, timestamp: number): { ok: boolean; reason?: string } {
    if (accuracy > VALID_ACCURACY_THRESHOLD && this.currentState === null) {
      return { ok: false, reason: `accuracy ${Math.round(accuracy)}m > ${VALID_ACCURACY_THRESHOLD}m (waiting for valid first fix)` };
    }

    if (this.currentState && accuracy > 500) {
      return { ok: false, reason: `accuracy ${Math.round(accuracy)}m > 500m` };
    }

    if (this.currentState && timestamp < this.currentState.timestamp) {
      return { ok: false, reason: `timestamp older than current` };
    }

    if (this.currentState) {
      const dist = haversineKm(this.currentState.lat, this.currentState.lng, lat, lng);
      const dt = timestamp - this.currentState.timestamp;
      if (dist > JITTER_DISTANCE_KM && dt < JITTER_TIME_MS) {
        return { ok: false, reason: `jitter: ${dist.toFixed(1)}km in ${(dt / 1000).toFixed(1)}s` };
      }
    }

    return { ok: true };
  }

  private handlePosition = (pos: GeolocationPosition) => {
    const { latitude, longitude, accuracy, speed, heading } = pos.coords;
    const timestamp = pos.timestamp;

    const check = this.shouldAccept(latitude, longitude, accuracy, timestamp);
    if (!check.ok) {
      console.log(`[GPS] Rejected: ${check.reason}`);
      return;
    }

    const wasLocating = this.locating;
    this.locating = false;
    this.currentState = { lat: latitude, lng: longitude, accuracy, timestamp, speed, heading, isStale: false };

    console.log(`[GPS] Position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}, accuracy ${Math.round(accuracy)}m, mode=${this.activeMode}`);

    if (wasLocating) {
      this.locatingSubscribers.forEach(fn => { try { fn(false); } catch {} });
    }

    this.subscribers.forEach(fn => { try { fn(this.currentState!); } catch {} });
  };

  private handleError = (err: GeolocationPositionError) => {
    const msg = err.code === err.PERMISSION_DENIED
      ? "Location permission denied"
      : err.code === err.POSITION_UNAVAILABLE
        ? "Position unavailable"
        : "Location request timed out";
    console.log(`[GPS] Error: ${msg}`);
    this.errorSubscribers.forEach(fn => { try { fn(msg); } catch {} });
  };

  private desiredMode(): LocationMode {
    return this.highAccuracyRefCount > 0 ? "high_accuracy" : "normal";
  }

  private startWatch() {
    if (this.watchId !== null) return;
    this.activeMode = this.desiredMode();
    const opts = MODE_CONFIG[this.activeMode];
    console.log(`[GPS] Starting GPS watch (mode=${this.activeMode})`);
    this.locating = true;
    this.locatingSubscribers.forEach(fn => { try { fn(true); } catch {} });
    this.watchId = navigator.geolocation.watchPosition(
      this.handlePosition,
      this.handleError,
      opts
    );
  }

  private stopWatch() {
    if (this.watchId === null) return;
    console.log("[GPS] Stopping GPS watch");
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private restartWatch() {
    const desired = this.desiredMode();
    if (this.watchId === null || desired === this.activeMode) return;
    console.log(`[GPS] Mode change: ${this.activeMode} → ${desired}, restarting watch`);
    this.stopWatch();
    this.startWatch();
  }

  startHighAccuracyMode(): void {
    this.highAccuracyRefCount++;
    console.log(`[GPS] High accuracy requested (refCount=${this.highAccuracyRefCount})`);
    this.restartWatch();
  }

  stopHighAccuracyMode(): void {
    this.highAccuracyRefCount = Math.max(0, this.highAccuracyRefCount - 1);
    console.log(`[GPS] High accuracy released (refCount=${this.highAccuracyRefCount})`);
    this.restartWatch();
  }

  getMode(): LocationMode {
    return this.activeMode;
  }

  subscribe(fn: LocationSubscriber): () => void {
    this.subscribers.add(fn);

    if (this.subscribers.size === 1) {
      this.startWatch();
    }

    if (this.currentState) {
      const staleState = { ...this.currentState, isStale: (Date.now() - this.currentState.timestamp) > 30000 };
      try { fn(staleState); } catch {}
    }

    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) {
        this.stopWatch();
      }
    };
  }

  subscribeError(fn: ErrorSubscriber): () => void {
    this.errorSubscribers.add(fn);
    return () => { this.errorSubscribers.delete(fn); };
  }

  subscribeLocating(fn: (v: boolean) => void): () => void {
    this.locatingSubscribers.add(fn);
    try { fn(this.locating); } catch {}
    return () => { this.locatingSubscribers.delete(fn); };
  }

  getCurrentPosition(): LocationState | null {
    return this.currentState;
  }

  getIsLocating(): boolean {
    return this.locating;
  }

  isWatching(): boolean {
    return this.watchId !== null;
  }

  forceRefresh(): void {
    navigator.geolocation.getCurrentPosition(
      this.handlePosition,
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  getOneShotPosition(): Promise<LocationState | null> {
    if (this.currentState && (Date.now() - this.currentState.timestamp) < 30000) {
      return Promise.resolve(this.currentState);
    }
    return new Promise((resolve) => {
      const unsub = this.subscribe((state) => {
        unsub();
        resolve(state);
      });
      setTimeout(() => {
        unsub();
        resolve(this.currentState);
      }, 10000);
    });
  }
}

export const locationService = new LocationService();

export function subscribe(fn: LocationSubscriber): () => void {
  return locationService.subscribe(fn);
}

export function subscribeError(fn: ErrorSubscriber): () => void {
  return locationService.subscribeError(fn);
}

export function subscribeLocating(fn: (v: boolean) => void): () => void {
  return locationService.subscribeLocating(fn);
}

export function getCurrentPosition(): LocationState | null {
  return locationService.getCurrentPosition();
}

export function getIsLocating(): boolean {
  return locationService.getIsLocating();
}

export function isWatching(): boolean {
  return locationService.isWatching();
}

export function forceRefresh(): void {
  locationService.forceRefresh();
}

export function getOneShotPosition(): Promise<LocationState | null> {
  return locationService.getOneShotPosition();
}

export function startHighAccuracyMode(): void {
  locationService.startHighAccuracyMode();
}

export function stopHighAccuracyMode(): void {
  locationService.stopHighAccuracyMode();
}

export function getMode(): LocationMode {
  return locationService.getMode();
}
