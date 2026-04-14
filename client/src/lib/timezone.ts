export function getViewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function formatTimeInZone(
  date: Date | string | null | undefined,
  timezone: string
): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
}

export function formatDateTimeInZone(
  date: Date | string | null | undefined,
  timezone: string
): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
}

export function shouldShowDualTime(
  userTimezone: string | null | undefined,
  watcherTimezone: string
): boolean {
  if (!userTimezone) return false;
  if (userTimezone === watcherTimezone) return false;
  try {
    const now = new Date();
    const userOffset = getTimezoneOffsetMinutes(now, userTimezone);
    const watcherOffset = getTimezoneOffsetMinutes(now, watcherTimezone);
    return userOffset !== watcherOffset;
  } catch {
    return false;
  }
}

function getTimezoneOffsetMinutes(date: Date, tz: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / 60000;
}

export function getPlaceLabel(timezone: string): string {
  const parts = timezone.split("/");
  const city = parts[parts.length - 1].replace(/_/g, " ");
  return city;
}

export function formatDualTime(
  date: Date | string | null | undefined,
  userTimezone: string,
  watcherTimezone: string
): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";

  const watcherTime = formatTimeInZone(d, watcherTimezone);

  if (!shouldShowDualTime(userTimezone, watcherTimezone)) {
    return watcherTime;
  }

  const userTime = formatTimeInZone(d, userTimezone);
  const userPlace = getPlaceLabel(userTimezone);
  return `${watcherTime} your time (${userTime} in ${userPlace})`;
}

export function formatTimeForViewer(
  date: Date | string | null | undefined,
  viewerTz?: string
): string {
  const tz = viewerTz || getViewerTimezone();
  return formatTimeInZone(date, tz);
}
