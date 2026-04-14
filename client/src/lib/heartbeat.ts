import { getCurrentPosition } from "./location-service";

const HEARTBEAT_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 300_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;

async function getBatteryInfo(): Promise<{ level: number; charging: boolean } | null> {
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

async function sendHeartbeat(): Promise<void> {
  try {
    const cached = getCurrentPosition();
    const body: Record<string, any> = { ts: Math.floor(Date.now() / 1000) };
    try {
      body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}

    if (cached && (Date.now() - cached.timestamp) < STALE_THRESHOLD_MS) {
      body.lat = cached.lat;
      body.lng = cached.lng;
      body.acc = cached.accuracy;
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
  sendHeartbeat();
  intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

export function isHeartbeatRunning(): boolean {
  return intervalId !== null;
}
