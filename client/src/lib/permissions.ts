import { useState, useEffect, useCallback } from "react";
import { PushNotifications } from "@capacitor/push-notifications";

export interface PermissionHealth {
  location: "granted" | "prompt" | "denied" | "always" | "when_in_use" | "unknown";
  notifications: "granted" | "prompt" | "denied" | "unknown";
  motion: "granted" | "prompt" | "denied" | "unknown";
  loading: boolean;
}

export type PermissionLevel = "full" | "partial" | "none";

function isNativePlatform(): boolean {
  try {
    const cap = (window as any).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

async function tryNativeLocationCheck(): Promise<PermissionHealth["location"] | null> {
  if (!isNativePlatform()) return null;

  try {
    const bgPkg = "@transistorsoft/capacitor-background-geolocation";
    const BG = await import(/* @vite-ignore */ bgPkg);
    const BackgroundGeolocation = BG.default || BG.BackgroundGeolocation;
    if (BackgroundGeolocation?.getProviderState) {
      const state = await BackgroundGeolocation.getProviderState();
      if (state.status === 3 || state.accuracyAuthorization === 0) return "always";
      if (state.status === 2) return "when_in_use";
      if (state.status === 0) return "denied";
      return "prompt";
    }
  } catch {}

  try {
    const geoPkg = "@capacitor/geolocation";
    const Geo = await import(/* @vite-ignore */ geoPkg);
    const Geolocation = Geo.Geolocation;
    if (Geolocation?.checkPermissions) {
      const perms = await Geolocation.checkPermissions();
      if (perms.location === "granted" && perms.coarseLocation === "granted") return "granted";
      if (perms.location === "denied") return "denied";
      return "prompt";
    }
  } catch {}

  return null;
}

async function checkLocationPermission(): Promise<PermissionHealth["location"]> {
  const nativeResult = await tryNativeLocationCheck();
  if (nativeResult !== null) return nativeResult;

  try {
    if ("permissions" in navigator) {
      const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      if (result.state === "granted") return "granted";
      if (result.state === "denied") return "denied";
      return "prompt";
    }
  } catch {}
  return "unknown";
}

async function checkNotificationPermission(): Promise<PermissionHealth["notifications"]> {
  if (isNativePlatform()) {
    try {
      if (PushNotifications?.checkPermissions) {
        const perms = await PushNotifications.checkPermissions();
        if (perms.receive === "granted") return "granted";
        if (perms.receive === "denied") return "denied";
        return "prompt";
      }
    } catch {}
  }

  if (!("Notification" in window)) return "unknown";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return "prompt";
}

function checkMotionPermission(): PermissionHealth["motion"] {
  if (!("DeviceMotionEvent" in window)) return "unknown";
  const DME = DeviceMotionEvent as any;
  if (typeof DME.requestPermission !== "function") {
    return "granted";
  }
  return "prompt";
}

export async function getPermissionHealth(): Promise<Omit<PermissionHealth, "loading">> {
  const location = await checkLocationPermission();
  const notifications = await checkNotificationPermission();
  const motion = checkMotionPermission();
  return { location, notifications, motion };
}

export function getOverallLevel(health: Omit<PermissionHealth, "loading">): PermissionLevel {
  const locOk = health.location === "granted" || health.location === "always";
  const notifOk = health.notifications === "granted";
  if (locOk && notifOk) return "full";
  if (locOk || notifOk) return "partial";
  if (health.location === "prompt" && health.notifications === "prompt") return "none";
  return "partial";
}

export function getLocationLabel(state: PermissionHealth["location"]): string {
  switch (state) {
    case "always": return "Always Allow";
    case "when_in_use": return "While Using. Tap to update to Always Allow";
    case "granted": return "Enabled";
    case "denied": return "Blocked. Update in phone Settings";
    case "prompt": return "Not enabled";
    default: return "Unknown";
  }
}

export function isLocationFullyGranted(state: PermissionHealth["location"]): boolean {
  return state === "always" || state === "granted";
}

export function usePermissionHealth() {
  const [health, setHealth] = useState<PermissionHealth>({
    location: "unknown",
    notifications: "unknown",
    motion: "unknown",
    loading: true,
  });

  const refresh = useCallback(async () => {
    const result = await getPermissionHealth();
    // Auto-mark intent if the OS confirms the permission is granted now.
    // This back-fills users who enabled permissions before this sticky
    // logic existed, so they don't see a one-time "Not enabled" flicker.
    if (result.location === "granted" || result.location === "always" || result.location === "when_in_use") {
      markPermissionEnabled("location");
    }
    if (result.notifications === "granted") markPermissionEnabled("notifications");
    if (result.motion === "granted") markPermissionEnabled("motion");
    // If the OS now says denied, clear our sticky flag so the user sees
    // the real "Blocked" state and knows to fix it in phone Settings.
    if (result.location === "denied") clearPermissionIntent("location");
    if (result.notifications === "denied") clearPermissionIntent("notifications");
    if (result.motion === "denied") clearPermissionIntent("motion");
    setHealth({ ...result, loading: false });
  }, []);

  useEffect(() => {
    refresh();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [refresh]);

  return { ...health, refresh };
}

const DISMISS_KEY = "permission_recovery_dismissed_at";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Sticky "user intent" memory. Once a user successfully enables a permission
// through our flow, we remember it locally so the UI does not flip back to
// "Not enabled" if the OS returns `prompt` on the next visit (which happens
// on iOS Safari, after page reloads, or in private browsing). The visual
// only reverts when the OS explicitly reports `denied` (Blocked).
type PermissionKey = "location" | "notifications" | "motion";
const INTENT_KEY = (k: PermissionKey) => `stillhere_permission_intent_${k}`;

export function markPermissionEnabled(key: PermissionKey): void {
  try { localStorage.setItem(INTENT_KEY(key), String(Date.now())); } catch {}
}
export function clearPermissionIntent(key: PermissionKey): void {
  try { localStorage.removeItem(INTENT_KEY(key)); } catch {}
}
export function isPermissionMarkedEnabled(key: PermissionKey): boolean {
  try { return !!localStorage.getItem(INTENT_KEY(key)); } catch { return false; }
}

export function isDismissed(): boolean {
  const val = localStorage.getItem(DISMISS_KEY);
  if (!val) return false;
  const ts = parseInt(val, 10);
  if (isNaN(ts)) return false;
  return Date.now() - ts < DISMISS_COOLDOWN_MS;
}

export function dismissRecoveryPrompt(): void {
  localStorage.setItem(DISMISS_KEY, String(Date.now()));
}

export async function requestLocationPermission(): Promise<boolean> {
  if (isNativePlatform()) {
    try {
      const bgPkg = "@transistorsoft/capacitor-background-geolocation";
      const BG = await import(/* @vite-ignore */ bgPkg);
      const BackgroundGeolocation = BG.default || BG.BackgroundGeolocation;
      if (BackgroundGeolocation?.requestPermission) {
        const status = await BackgroundGeolocation.requestPermission();
        const ok = status === 3;
        if (ok) markPermissionEnabled("location");
        return ok;
      }
    } catch {}

    try {
      const geoPkg = "@capacitor/geolocation";
      const Geo = await import(/* @vite-ignore */ geoPkg);
      const Geolocation = Geo.Geolocation;
      if (Geolocation?.requestPermissions) {
        const result = await Geolocation.requestPermissions();
        const ok = result.location === "granted";
        if (ok) markPermissionEnabled("location");
        return ok;
      }
    } catch {}
  }

  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
      });
    });
    if (pos) markPermissionEnabled("location");
    return !!pos;
  } catch {
    return false;
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (isNativePlatform()) {
    try {
      if (PushNotifications?.requestPermissions) {
        const result = await PushNotifications.requestPermissions();
        const ok = result.receive === "granted";
        if (ok) markPermissionEnabled("notifications");
        return ok;
      }
    } catch {}
  }

  if (!("Notification" in window)) return false;
  const result = await Notification.requestPermission();
  const ok = result === "granted";
  if (ok) markPermissionEnabled("notifications");
  return ok;
}

export async function requestMotionPermissionWrapper(): Promise<boolean> {
  const DME = DeviceMotionEvent as any;
  if (typeof DME.requestPermission !== "function") {
    markPermissionEnabled("motion");
    return true;
  }
  try {
    const result = await DME.requestPermission();
    const ok = result === "granted";
    if (ok) markPermissionEnabled("motion");
    return ok;
  } catch {
    return false;
  }
}
