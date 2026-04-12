import { getCurrentPosition } from "./location-service";

const HEARTBEAT_INTERVAL_MS = 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

async function sendHeartbeat(): Promise<void> {
  try {
    const cached = getCurrentPosition();
    const body: Record<string, number> = { ts: Math.floor(Date.now() / 1000) };
    if (cached) {
      body.lat = cached.lat;
      body.lng = cached.lng;
      body.acc = cached.accuracy;
    }
    await fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
  } catch {}
}

export function startHeartbeat(): void {
  if (intervalId !== null) return;
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
