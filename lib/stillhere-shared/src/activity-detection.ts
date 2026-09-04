export type ActivityType = "stationary" | "walking" | "running" | "cycling" | "scooter" | "driving" | "transit";

export function detectActivityFromSpeed(speedMs: number | null | undefined): ActivityType {
  if (speedMs == null || !Number.isFinite(speedMs) || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;

  // Best-effort GPS-only classifier. Scooter/bike and car/train can overlap,
  // so these thresholds prioritize useful safety labels over false precision.
  if (kmh < 7) return "walking";
  if (kmh < 14) return "running";
  if (kmh < 28) return "cycling";
  if (kmh < 45) return "scooter";
  if (kmh < 90) return "driving";
  return "transit";
}

export function formatActivity(activity: string | null | undefined): string {
  switch (activity) {
    case "stationary": return "Still";
    case "walking": return "Walking";
    case "running": return "Running";
    case "cycling": return "Bike";
    case "scooter": return "Scooter";
    case "driving": return "Driving";
    case "transit": return "Train / transit";
    default: return "Moving";
  }
}
