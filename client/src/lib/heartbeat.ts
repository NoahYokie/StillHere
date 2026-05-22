import { getCurrentPosition, getOneShotPosition } from "./location-service";
import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { isNativeTrackingAllowed, refreshPolicy } from "./tracking-policy-cache";

const DEFAULT_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let currentIntervalMs = DEFAULT_INTERVAL_MS;

async function getBatteryInfo(): Promise<{ level: number; charging: boolean } | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await Device.getBatteryInfo();
      if (typeof info.batteryLevel === "number") {
        return {
          level: info.batteryLevel,
          charging: !!info.isCharging,
        };
      }
    } catch {}
  }
  try {
    if ("getBattery" in navigator) {
      const battery = await (navigator as any).getBattery();
      return { level: battery.level, charging: battery.charging };
    }
  } catch {}
  return null;
}

function getNetworkType(): string | null {
  try {
    const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    if (conn) {
      if (!navigator.onLine) return "offline";
      if (conn.type === "wifi") return "wifi";
      if (conn.type === "cellular") return "cell";
      if (conn.effectiveType) return conn.effectiveType;
      return "online";
    }
    return navigator.onLine ? "online" : "offline";
  } catch {}
  return null;
}

function getAdaptiveInterval(battery: { level: number; charging: boolean } | null): number {
  if (!battery) return DEFAULT_INTERVAL_MS;
  if (battery.level < 0.10 && !battery.charging) return 300_000;
  if (battery.level < 0.30 && !battery.charging) return 120_000;
  return DEFAULT_INTERVAL_MS;
}

function reschedule(newIntervalMs: number): void {
  if (newIntervalMs === currentIntervalMs || intervalId === null) return;
  currentIntervalMs = newIntervalMs;
  clearInterval(intervalId);
  intervalId = setInterval(sendHeartbeat, currentIntervalMs);
}

async function sendHeartbeat(): Promise<void> {
  try {
    await refreshPolicy().catch(() => null);
    const cached = getCurrentPosition();
    const body: Record<string, any> = { ts: Math.floor(Date.now() / 1000) };
    try {
      body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}

    // Defense-in-depth: only attach lat/lng/acc if the cached tracking policy
    // says native tracking is allowed. Server still strips these fields when
    // the policy denies, but the client cooperates as a first line of defense.
    const trackingAllowed = isNativeTrackingAllowed();
    if (trackingAllowed) {
      const location =
        cached && (Date.now() - cached.timestamp) < STALE_THRESHOLD_MS
          ? cached
          : await getOneShotPosition().catch(() => null);

      if (location && (Date.now() - location.timestamp) < STALE_THRESHOLD_MS) {
        body.lat = location.lat;
        body.lng = location.lng;
        body.acc = location.accuracy;
      }
    }
    const battInfo = await getBatteryInfo();
    if (battInfo) {
      body.batt = battInfo.level;
      body.chg = battInfo.charging;
    }
    const netType = getNetworkType();
    if (netType) {
      body.net = netType;
    }
    const res = await fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (res.ok) {
      consecutiveFailures = 0;
      const adaptiveMs = getAdaptiveInterval(battInfo);
      reschedule(adaptiveMs);
    } else {
      consecutiveFailures++;
      console.warn(`[Heartbeat] send failed (count: ${consecutiveFailures}) HTTP ${res.status}`);
    }
  } catch (err: any) {
    consecutiveFailures++;
    console.warn(`[Heartbeat] send failed (count: ${consecutiveFailures}) ${err?.message || "network error"}`);
  }
}

export function startHeartbeat(): void {
  if (intervalId !== null) return;
  consecutiveFailures = 0;
  currentIntervalMs = DEFAULT_INTERVAL_MS;
  sendHeartbeat();
  intervalId = setInterval(sendHeartbeat, currentIntervalMs);
}

export function stopHeartbeat(): void {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

export function isHeartbeatRunning(): boolean {
  return intervalId !== null;
}
