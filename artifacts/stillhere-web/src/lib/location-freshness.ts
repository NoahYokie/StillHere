import { formatDistanceToNow } from "date-fns";

export const LIVE_LOCATION_FRESH_MS = 2 * 60 * 1000;

export function isFreshLocation(timestamp: string | Date | null | undefined, now = Date.now()): boolean {
  if (!timestamp) return false;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) && now - time < LIVE_LOCATION_FRESH_MS;
}

export function locationFreshnessLabel(
  timestamp: string | Date | null | undefined,
  active = true,
): "Live now" | string {
  if (!active) return "Location sharing off";
  if (isFreshLocation(timestamp)) return "Live now";
  if (!timestamp) return "Location sharing off";
  return `Last updated ${formatDistanceToNow(new Date(timestamp), { addSuffix: true })}`;
}
