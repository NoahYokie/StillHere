type FallCallback = () => void;

interface FallDetectorOptions {
  impactThreshold?: number;
  stillnessThreshold?: number;
  stillnessDuration?: number;
  onFallDetected: FallCallback;
}

const DEFAULTS = {
  impactThreshold: 30,
  stillnessThreshold: 2,
  stillnessDuration: 2000,
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
      return result === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

export function createFallDetector(options: FallDetectorOptions) {
  const impactThreshold = options.impactThreshold ?? DEFAULTS.impactThreshold;
  const stillnessThreshold = options.stillnessThreshold ?? DEFAULTS.stillnessThreshold;
  const stillnessDuration = options.stillnessDuration ?? DEFAULTS.stillnessDuration;

  let impactDetected = false;
  let impactTime = 0;
  let stillnessStart = 0;
  let active = false;
  let cooldown = false;

  function handleMotion(event: DeviceMotionEvent) {
    if (!active || cooldown) return;

    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);

    if (!impactDetected) {
      if (magnitude > impactThreshold) {
        impactDetected = true;
        impactTime = Date.now();
        stillnessStart = 0;
      }
    } else {
      if (Date.now() - impactTime > 10000) {
        impactDetected = false;
        stillnessStart = 0;
        return;
      }

      if (magnitude < stillnessThreshold + 9.81 && magnitude > 9.81 - stillnessThreshold) {
        if (stillnessStart === 0) {
          stillnessStart = Date.now();
        } else if (Date.now() - stillnessStart >= stillnessDuration) {
          impactDetected = false;
          stillnessStart = 0;
          cooldown = true;
          setTimeout(() => { cooldown = false; }, 30000);
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
      impactDetected = false;
      stillnessStart = 0;
      window.removeEventListener("devicemotion", handleMotion);
    },
    isActive() {
      return active;
    },
  };
}
