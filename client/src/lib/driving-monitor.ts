import { apiRequest } from "./queryClient";

interface DrivingMonitorCallbacks {
  onSpeedUpdate: (speedKmh: number, speedLimit: number) => void;
  onSpeedAlert: (speedKmh: number, speedLimit: number) => void;
  onCrashDetected: (impactForce: number) => void;
  onError: (error: string) => void;
  onSessionStarted: () => void;
  onSessionEnded: () => void;
}

interface Position {
  lat: number;
  lng: number;
  timestamp: number;
  accuracy: number;
}

const SPEED_UPDATE_INTERVAL = 3000;
const SPEED_REPORT_INTERVAL = 15000;
const CRASH_THRESHOLD_MS2 = 98;
const CRASH_COOLDOWN_MS = 30000;
const MIN_ACCURACY_METERS = 50;

class DrivingMonitor {
  private watchId: number | null = null;
  private motionListener: ((e: DeviceMotionEvent) => void) | null = null;
  private callbacks: DrivingMonitorCallbacks | null = null;
  private positions: Position[] = [];
  private currentSpeedKmh = 0;
  private maxSpeedKmh = 0;
  private speedSamples: number[] = [];
  private totalDistanceKm = 0;
  private speedLimit = 120;
  private lastSpeedReport = 0;
  private lastCrashTime = 0;
  private active = false;
  private sessionId: string | null = null;
  private lastSpeedAlertTime = 0;

  isActive(): boolean {
    return this.active;
  }

  getCurrentSpeed(): number {
    return this.currentSpeedKmh;
  }

  getMaxSpeed(): number {
    return this.maxSpeedKmh;
  }

  getDistance(): number {
    return this.totalDistanceKm;
  }

  async start(callbacks: DrivingMonitorCallbacks, speedLimitKmh: number = 120): Promise<void> {
    if (this.active) return;

    this.callbacks = callbacks;
    this.speedLimit = speedLimitKmh;
    this.positions = [];
    this.currentSpeedKmh = 0;
    this.maxSpeedKmh = 0;
    this.speedSamples = [];
    this.totalDistanceKm = 0;
    this.lastSpeedReport = 0;
    this.lastCrashTime = 0;
    this.lastSpeedAlertTime = 0;

    if (!navigator.geolocation) {
      callbacks.onError("Geolocation is not supported");
      return;
    }

    let startLat: number | undefined;
    let startLng: number | undefined;

    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      startLat = pos.coords.latitude;
      startLng = pos.coords.longitude;
    } catch {
    }

    try {
      const res = await apiRequest("POST", "/api/drive/start", { lat: startLat, lng: startLng });
      const session = await res.json();
      this.sessionId = session.id;
    } catch (err: any) {
      if (err?.message?.includes("already active")) {
        try {
          const res = await apiRequest("GET", "/api/drive/active");
          const data = await res.json();
          if (data.session) this.sessionId = data.session.id;
        } catch {}
      }
    }

    this.active = true;
    callbacks.onSessionStarted();

    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => {
        console.error("[DRIVE] GPS error:", error.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 5000,
      }
    );

    this.startCrashDetection();
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }

    this.stopCrashDetection();

    const lastPos = this.positions[this.positions.length - 1];
    try {
      await apiRequest("POST", "/api/drive/end", {
        maxSpeedKmh: this.maxSpeedKmh,
        avgSpeedKmh: this.getAvgSpeed(),
        distanceKm: this.totalDistanceKm,
        lat: lastPos?.lat,
        lng: lastPos?.lng,
      });
    } catch (err) {
      console.error("[DRIVE] Error ending session:", err);
    }

    this.callbacks?.onSessionEnded();
    this.sessionId = null;
  }

  private handlePosition(position: GeolocationPosition): void {
    const { latitude, longitude, speed, accuracy } = position.coords;
    const timestamp = position.timestamp;

    if (accuracy > MIN_ACCURACY_METERS) return;

    const newPos: Position = { lat: latitude, lng: longitude, timestamp, accuracy };

    if (this.positions.length > 0) {
      const prevPos = this.positions[this.positions.length - 1];
      const timeDiffS = (timestamp - prevPos.timestamp) / 1000;

      if (timeDiffS < 1) return;

      if (speed !== null && speed >= 0) {
        this.currentSpeedKmh = speed * 3.6;
      } else {
        const distKm = this.haversineDistance(prevPos.lat, prevPos.lng, latitude, longitude);
        const timeDiffH = timeDiffS / 3600;
        this.currentSpeedKmh = timeDiffH > 0 ? distKm / timeDiffH : 0;
      }

      if (this.currentSpeedKmh > 300) return;

      const segmentDist = this.haversineDistance(prevPos.lat, prevPos.lng, latitude, longitude);
      this.totalDistanceKm += segmentDist;

      if (this.currentSpeedKmh > this.maxSpeedKmh) {
        this.maxSpeedKmh = this.currentSpeedKmh;
      }
      this.speedSamples.push(this.currentSpeedKmh);

      this.callbacks?.onSpeedUpdate(this.currentSpeedKmh, this.speedLimit);

      if (this.currentSpeedKmh > this.speedLimit) {
        const now = Date.now();
        if (now - this.lastSpeedAlertTime > 30000) {
          this.lastSpeedAlertTime = now;
          this.callbacks?.onSpeedAlert(this.currentSpeedKmh, this.speedLimit);
          this.reportSpeed(latitude, longitude);
        }
      }

      const now = Date.now();
      if (now - this.lastSpeedReport > SPEED_REPORT_INTERVAL) {
        this.lastSpeedReport = now;
        this.reportSpeed(latitude, longitude);
      }
    }

    this.positions.push(newPos);
    if (this.positions.length > 100) {
      this.positions = this.positions.slice(-50);
    }
  }

  private startCrashDetection(): void {
    if (!window.DeviceMotionEvent) return;

    this.motionListener = (event: DeviceMotionEvent) => {
      if (!this.active) return;

      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

      const magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);

      if (magnitude > CRASH_THRESHOLD_MS2) {
        const now = Date.now();
        if (now - this.lastCrashTime > CRASH_COOLDOWN_MS) {
          this.lastCrashTime = now;
          console.log(`[DRIVE] Crash detected! Impact: ${magnitude.toFixed(1)} m/s2`);
          this.callbacks?.onCrashDetected(magnitude);
        }
      }
    };

    window.addEventListener("devicemotion", this.motionListener);
  }

  private stopCrashDetection(): void {
    if (this.motionListener) {
      window.removeEventListener("devicemotion", this.motionListener);
      this.motionListener = null;
    }
  }

  private async reportSpeed(lat: number, lng: number): Promise<void> {
    try {
      await apiRequest("POST", "/api/drive/speed", {
        speedKmh: this.currentSpeedKmh,
        lat,
        lng,
        maxSpeedKmh: this.maxSpeedKmh,
        avgSpeedKmh: this.getAvgSpeed(),
        distanceKm: this.totalDistanceKm,
      });
    } catch (err) {
      console.error("[DRIVE] Error reporting speed:", err);
    }
  }

  async reportCrash(lat?: number, lng?: number): Promise<boolean> {
    this.active = false;
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.stopCrashDetection();

    try {
      await apiRequest("POST", "/api/drive/crash", {
        lat,
        lng,
        speedKmh: this.currentSpeedKmh,
        impactForce: this.lastCrashTime,
      });
      return true;
    } catch (err) {
      console.error("[DRIVE] Error reporting crash:", err);
      throw err;
    }
  }

  private getAvgSpeed(): number {
    if (this.speedSamples.length === 0) return 0;
    return this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;
  }

  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(deg: number): number {
    return (deg * Math.PI) / 180;
  }
}

export const drivingMonitor = new DrivingMonitor();
