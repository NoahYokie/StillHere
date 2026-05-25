import { Capacitor } from "@capacitor/core";

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

type NativeBackgroundGeo = any;

class LocationService {
  private currentState: LocationState | null = null;
  private watchId: number | null = null;
  private locating = true;
  private subscribers = new Set<LocationSubscriber>();
  private errorSubscribers = new Set<ErrorSubscriber>();
  private locatingSubscribers = new Set<(v: boolean) => void>();

  private highAccuracyRefCount = 0;
  private activeMode: LocationMode = "normal";

  private nativePlugin: NativeBackgroundGeo | null = null;
  private nativeReady = false;
  private nativeStarted = false;
  private nativeSubscriptions: Array<{ remove: () => void }> = [];
  private nativeInitPromise: Promise<void> | null = null;
  private capGeolocationPlugin: any = null;
  private capWatchId: string | null = null;
  private watchSessionId = 0;

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

    const source = this.nativeStarted ? "native" : (this.capWatchId ? "cap-geo" : "browser");
    console.log(`[GPS] Position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}, accuracy ${Math.round(accuracy)}m, mode=${this.activeMode}, src=${source}`);

    if (wasLocating) {
      this.locatingSubscribers.forEach(fn => { try { fn(false); } catch {} });
    }

    this.subscribers.forEach(fn => { try { fn(this.currentState!); } catch {} });
  };

  private handleError = (err: GeolocationPositionError | { code: number; message: string }) => {
    const msg = err.code === 1
      ? "Location permission denied"
      : err.code === 2
        ? "Position unavailable"
        : "Location request timed out";
    console.log(`[GPS] Error: ${msg}`);
    this.errorSubscribers.forEach(fn => { try { fn(msg); } catch {} });
  };

  private desiredMode(): LocationMode {
    return this.highAccuracyRefCount > 0 ? "high_accuracy" : "normal";
  }

  private isNativePlatform(): boolean {
    try {
      return Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  }

  private async initNativePlugin(): Promise<void> {
    if (!this.isNativePlatform()) return;

    try {
      const pluginId = "@transistorsoft/capacitor-background-geolocation";
      const mod = await import(/* @vite-ignore */ pluginId);
      this.nativePlugin = mod.default || mod.BackgroundGeolocation;
      if (this.nativePlugin) {
        this.nativeReady = true;
        console.log("[GPS] Native background geolocation plugin loaded");
      }
    } catch {
      console.log("[GPS] Background geolocation plugin not available, trying @capacitor/geolocation");
    }

    if (!this.nativeReady) {
      try {
        const mod = await import("@capacitor/geolocation");
        this.capGeolocationPlugin = mod.Geolocation;
        console.log("[GPS] Capacitor Geolocation plugin loaded");
      } catch {
        console.log("[GPS] No native geolocation plugins available, falling back to browser API");
      }
    }
  }

  private async startNativeBackgroundWatch(): Promise<boolean> {
    if (!this.nativePlugin || !this.nativeReady) return false;

    // Phase 1.2 gate: native background tracking only runs after a feature
    // page has explicitly received Always authorization from the user.
    // Without the gate flipped on, fall through to the foreground capacitor /
    // browser path so the app still functions but never claims background.
    if (!nativeBackgroundAllowed) {
      console.log("[GPS] Native background watch suppressed (Always not granted yet)");
      return false;
    }

    try {
      const BG = this.nativePlugin;
      const isHighAccuracy = this.desiredMode() === "high_accuracy";

      for (const sub of this.nativeSubscriptions) {
        try { sub.remove(); } catch {}
      }
      this.nativeSubscriptions = [];

      this.nativeSubscriptions.push(BG.onLocation((location: any) => {
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
        this.handlePosition(pos);
      }));

      this.nativeSubscriptions.push(BG.onMotionChange((event: any) => {
        console.log(`[GPS] Native motion change: isMoving=${event.isMoving}`);
      }));

      this.nativeSubscriptions.push(BG.onProviderChange((event: any) => {
        console.log(`[GPS] Native provider change: enabled=${event.enabled}, status=${event.status}`);
        if (!event.enabled) {
          this.errorSubscribers.forEach(fn => { try { fn("Location services disabled"); } catch {} });
        }
      }));

      const state = await BG.ready({
        desiredAccuracy: isHighAccuracy ? BG.DESIRED_ACCURACY_HIGH : BG.DESIRED_ACCURACY_MEDIUM,
        distanceFilter: isHighAccuracy ? 5 : 10,
        stopOnTerminate: false,
        startOnBoot: true,
        heartbeatInterval: 60,
        preventSuspend: true,
        foregroundService: true,
        notification: {
          title: "StillHere",
          text: "Safety tracking active",
        },
        enableHeadless: true,
        stopTimeout: 5,
        // Phase 1 (App Store launch): request WhenInUse only. The full
        // "ask for Always at the moment a background-needing feature
        // starts" escalation UX is a separate, approved follow-up task
        // and must NOT be built into this file. See STORE_SUBMISSION.md
        // section 5c for the escalation plan.
        // Phase 1.2: by the time we reach this code, the gate above has
        // confirmed the user already granted Always via our pre-permission
        // sheet. Asking for Always here makes the plugin internally consistent.
        locationAuthorizationRequest: "Always",
        backgroundPermissionRationale: {
          title: "Background location for safety features",
          message: "StillHere uses background location only while a safety feature you turned on is running, such as Safe Walk, Safety Timer, Drive Safety, an active SOS, or active sharing with your Safety Circle. We will attempt to share your location with the contacts you chose so they can reach you. Background location is off when you are not using one of these features.",
          positiveAction: "Allow",
          negativeAction: "Cancel",
        },
      });

      if (!state.enabled) {
        await BG.start();
      }

      this.nativeStarted = true;
      console.log(`[GPS] Native background tracking started (accuracy=${isHighAccuracy ? "high" : "medium"}, distanceFilter=${isHighAccuracy ? 5 : 10}m)`);
      return true;
    } catch (err: any) {
      console.log(`[GPS] Native background tracking failed to start: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Public hook for `setNativeBackgroundAllowed(false)`. Tears down only the
   * native BG plugin; foreground subscribers fall back to capacitor/browser
   * watch on the next restart.
   */
  async handleNativeBackgroundRevoked(): Promise<void> {
    if (!this.nativeStarted) return;
    console.log("[GPS] Always authorization revoked; stopping native BG plugin");
    await this.stopNativeBackgroundWatch();
    // After stopping native, no watch is active by definition. If there are
    // still subscribers (e.g. an in-progress Safe Walk or Safety Timer), we
    // must immediately start a foreground fallback so they don't lose
    // location updates.
    if (this.subscribers.size > 0) {
      this.startWatch();
    }
  }

  async handleNativeBackgroundGranted(): Promise<void> {
    if (!this.isNativePlatform() || this.nativeStarted || this.subscribers.size === 0) return;
    console.log("[GPS] Always authorization granted; restarting GPS to prefer native BG plugin");
    await this.stopWatch();
    this.startWatch();
  }

  private async stopNativeBackgroundWatch(): Promise<void> {
    for (const sub of this.nativeSubscriptions) {
      try { sub.remove(); } catch {}
    }
    this.nativeSubscriptions = [];

    if (this.nativeStarted && this.nativePlugin) {
      try {
        await this.nativePlugin.stop();
      } catch {}
    }
    this.nativeStarted = false;
  }

  private async startCapacitorWatch(): Promise<boolean> {
    if (!this.capGeolocationPlugin) return false;

    try {
      const Geo = this.capGeolocationPlugin;
      const isHighAccuracy = this.desiredMode() === "high_accuracy";

      const id = await Geo.watchPosition(
        {
          enableHighAccuracy: true,
          maximumAge: isHighAccuracy ? 2000 : 10000,
          timeout: isHighAccuracy ? 5000 : 20000,
        },
        (position: any, err: any) => {
          if (err) {
            const code = err.code === 1 ? 1 : err.code === 3 ? 3 : 2;
            this.handleError({ code, message: err.message || "Position unavailable" });
            return;
          }
          if (position) {
            const pos = {
              coords: {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy,
                speed: position.coords.speed,
                heading: position.coords.heading,
                altitude: position.coords.altitude,
                altitudeAccuracy: position.coords.altitudeAccuracy,
              },
              timestamp: position.timestamp,
            } as GeolocationPosition;
            this.handlePosition(pos);
          }
        }
      );

      this.capWatchId = id;
      console.log(`[GPS] Capacitor Geolocation watch started (watchId=${id})`);
      return true;
    } catch (err: any) {
      console.log(`[GPS] Capacitor Geolocation watch failed: ${err?.message || err}`);
      return false;
    }
  }

  private async stopCapacitorWatch(): Promise<void> {
    if (this.capWatchId && this.capGeolocationPlugin) {
      try {
        await this.capGeolocationPlugin.clearWatch({ id: this.capWatchId });
      } catch {}
      this.capWatchId = null;
    }
  }

  private startBrowserWatch() {
    if (this.watchId !== null) return;
    this.activeMode = this.desiredMode();
    const opts = MODE_CONFIG[this.activeMode];
    console.log(`[GPS] Starting browser GPS watch (mode=${this.activeMode})`);
    this.locating = true;
    this.locatingSubscribers.forEach(fn => { try { fn(true); } catch {} });
    this.watchId = navigator.geolocation.watchPosition(
      this.handlePosition,
      this.handleError,
      opts
    );
  }

  private stopBrowserWatch() {
    if (this.watchId === null) return;
    console.log("[GPS] Stopping browser GPS watch");
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private async startWatch() {
    const session = ++this.watchSessionId;
    this.locating = true;
    this.locatingSubscribers.forEach(fn => { try { fn(true); } catch {} });

    if (this.isNativePlatform()) {
      if (!this.nativeInitPromise) {
        this.nativeInitPromise = this.initNativePlugin();
      }
      await this.nativeInitPromise;

      if (session !== this.watchSessionId) return;

      if (this.nativeReady) {
        const started = await this.startNativeBackgroundWatch();
        if (session !== this.watchSessionId) return;
        if (started) return;
      } else if (nativeBackgroundAllowed) {
        this.errorSubscribers.forEach(fn => {
          try {
            fn("Live location works while the app is open. Enable Always Location for background sharing.");
          } catch {}
        });
      }

      if (this.capGeolocationPlugin) {
        const started = await this.startCapacitorWatch();
        if (session !== this.watchSessionId) return;
        if (started) return;
      }
    }

    if (session !== this.watchSessionId) return;
    this.startBrowserWatch();
  }

  private async stopWatch() {
    ++this.watchSessionId;
    if (this.nativeStarted) {
      await this.stopNativeBackgroundWatch();
    }
    if (this.capWatchId) {
      await this.stopCapacitorWatch();
    }
    this.stopBrowserWatch();
  }

  private async restartWatch() {
    const desired = this.desiredMode();
    if (desired === this.activeMode) return;

    if (!this.isAnyWatchActive()) return;

    console.log(`[GPS] Mode change: ${this.activeMode} → ${desired}, restarting watch`);
    this.activeMode = desired;

    if (this.nativeStarted && this.nativePlugin) {
      const isHighAccuracy = desired === "high_accuracy";
      try {
        await this.nativePlugin.setConfig({
          desiredAccuracy: isHighAccuracy
            ? this.nativePlugin.DESIRED_ACCURACY_HIGH
            : this.nativePlugin.DESIRED_ACCURACY_MEDIUM,
          distanceFilter: isHighAccuracy ? 5 : 10,
        });
        console.log(`[GPS] Native config updated: accuracy=${isHighAccuracy ? "high" : "medium"}`);
        return;
      } catch {}
    }

    if (this.capWatchId) {
      await this.stopCapacitorWatch();
      await this.startCapacitorWatch();
      return;
    }

    if (this.watchId !== null) {
      this.stopBrowserWatch();
      this.startBrowserWatch();
    }
  }

  private isAnyWatchActive(): boolean {
    return this.watchId !== null || this.nativeStarted || this.capWatchId !== null;
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

  isUsingNativeTracking(): boolean {
    return this.nativeStarted;
  }

  isUsingCapacitorGeo(): boolean {
    return this.capWatchId !== null;
  }

  getTrackingSource(): "native-bg" | "capacitor" | "browser" | "none" {
    if (this.nativeStarted) return "native-bg";
    if (this.capWatchId) return "capacitor";
    if (this.watchId !== null) return "browser";
    return "none";
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
    return this.watchId !== null || this.nativeStarted || this.capWatchId !== null;
  }

  forceRefresh(): void {
    if (this.nativeStarted && this.nativePlugin) {
      try {
        this.nativePlugin.getCurrentPosition({ samples: 1, persist: false }).then((location: any) => {
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
          this.handlePosition(pos);
        }).catch(() => {});
      } catch {}
      return;
    }

    if (this.capGeolocationPlugin) {
      try {
        this.capGeolocationPlugin.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 })
          .then((position: any) => {
            if (position) {
              const pos = {
                coords: {
                  latitude: position.coords.latitude,
                  longitude: position.coords.longitude,
                  accuracy: position.coords.accuracy,
                  speed: position.coords.speed,
                  heading: position.coords.heading,
                  altitude: position.coords.altitude,
                  altitudeAccuracy: position.coords.altitudeAccuracy,
                },
                timestamp: position.timestamp,
              } as GeolocationPosition;
              this.handlePosition(pos);
            }
          }).catch(() => {});
      } catch {}
      return;
    }

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

/**
 * Phase 1.2 gate. Toggled by BackgroundLocationProvider when Always
 * authorization is granted (true) or revoked (false). When false, the native
 * BackgroundGeolocation plugin is NOT started; the service falls back to
 * Capacitor or browser geolocation. This prevents claiming background usage
 * before the user has explicitly opted in.
 */
let nativeBackgroundAllowed = false;

export function setNativeBackgroundAllowed(allowed: boolean): void {
  const previous = nativeBackgroundAllowed;
  nativeBackgroundAllowed = allowed;
  if (!previous && allowed) {
    locationService.handleNativeBackgroundGranted();
  }
  if (previous && !allowed) {
    // Tear down the native plugin so we don't keep collecting in background
    // after the user revoked Always.
    locationService.handleNativeBackgroundRevoked();
  }
}

export function isNativeBackgroundAllowed(): boolean {
  return nativeBackgroundAllowed;
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

export function getTrackingSource(): "native-bg" | "capacitor" | "browser" | "none" {
  return locationService.getTrackingSource();
}
