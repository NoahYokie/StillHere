type FallCallback = () => void;

interface FallDetectorOptions {
  impactThreshold?: number;
  stillnessThreshold?: number;
  stillnessDuration?: number;
  onFallDetected: FallCallback;
}

const DEFAULTS = {
  impactThreshold: 55,
  freefallThreshold: 3,
  freefallDuration: 150,
  stillnessThreshold: 2,
  stillnessDuration: 3000,
};

export function isDeviceMotionSupported(): boolean {
  return typeof window !== "undefined" && "DeviceMotionEvent" in window;
}

export async function requestMotionPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return false;
  const DME = DeviceMotionEvent as any;
  if (typeof DME.requestPermission === "function") {
    try {
      const result = await DME.requestPermission();
      if (result === "granted") {
        localStorage.setItem("motionPermissionGranted", "true");
      }
      return result === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

export function createFallDetector(options: FallDetectorOptions) {
  const impactThreshold = options.impactThreshold ?? DEFAULTS.impactThreshold;
  const freefallThreshold = DEFAULTS.freefallThreshold;
  const freefallDuration = DEFAULTS.freefallDuration;
  const stillnessThreshold = options.stillnessThreshold ?? DEFAULTS.stillnessThreshold;
  const stillnessDuration = options.stillnessDuration ?? DEFAULTS.stillnessDuration;

  let phase: "watching" | "freefall" | "impact" = "watching";
  let freefallStart = 0;
  let impactTime = 0;
  let stillnessStart = 0;
  let active = false;
  let cooldown = false;

  function handleMotion(event: DeviceMotionEvent) {
    if (!active || cooldown) return;

    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
    const now = Date.now();

    if (phase === "watching") {
      if (magnitude < freefallThreshold) {
        if (freefallStart === 0) {
          freefallStart = now;
        } else if (now - freefallStart >= freefallDuration) {
          phase = "freefall";
        }
      } else {
        freefallStart = 0;
      }
    } else if (phase === "freefall") {
      if (magnitude > impactThreshold) {
        phase = "impact";
        impactTime = now;
        stillnessStart = 0;
      } else if (magnitude > 15) {
        phase = "watching";
        freefallStart = 0;
      }
      if (now - (freefallStart || now) > 2000) {
        phase = "watching";
        freefallStart = 0;
      }
    } else if (phase === "impact") {
      if (now - impactTime > 15000) {
        phase = "watching";
        freefallStart = 0;
        stillnessStart = 0;
        return;
      }

      const nearGravity = magnitude < 9.81 + stillnessThreshold && magnitude > 9.81 - stillnessThreshold;
      if (nearGravity) {
        if (stillnessStart === 0) {
          stillnessStart = now;
        } else if (now - stillnessStart >= stillnessDuration) {
          phase = "watching";
          freefallStart = 0;
          stillnessStart = 0;
          cooldown = true;
          setTimeout(() => { cooldown = false; }, 60000);
          options.onFallDetected();
        }
      } else {
        stillnessStart = 0;
      }
    }
  }

  return {
    start() {
      if (!isDeviceMotionSupported() || active) return;
      active = true;
      window.addEventListener("devicemotion", handleMotion);
    },
    stop() {
      active = false;
      phase = "watching";
      freefallStart = 0;
      stillnessStart = 0;
      window.removeEventListener("devicemotion", handleMotion);
    },
    isActive() {
      return active;
    },
  };
}
