import { formatDistanceToNow } from "date-fns";
import type { WatchedUser } from "@shared/schema";
import {
  Wifi, WifiOff, MapPin, MapPinOff, SignalLow,
  Battery, BatteryLow, BatteryCharging, BatteryWarning,
  Navigation, Clock,
} from "lucide-react";

export type ConnectionStatus = "connected" | "weak" | "unreachable";
export type LocationStatus = "live" | "stale" | "unavailable";
export type TrustLevel = "safe" | "watching" | "worried";
export type ConfidenceBand = "strong" | "limited" | "low";

export interface WatcherInsight {
  trustLevel: TrustLevel;
  headline: string;
  subtext: string;
  connection: { status: ConnectionStatus; label: string };
  location: { status: LocationStatus; label: string };
  recoveryMessage: string | null;
  markerColor: string;
  markerLabel: string;
  pulseColor: string;
  bgClass: string;
  borderClass: string;
  iconColor: string;
}

export interface DeviceInfo {
  batteryText: string | null;
  batteryIcon: "ok" | "low" | "charging" | "critical" | null;
  networkText: string | null;
  confidenceBand: ConfidenceBand;
  confidenceText: string;
}

export interface EtaInfo {
  etaText: string;
  destinationName: string | null;
  isDelayed: boolean;
}

const STALE_LOCATION_MS = 5 * 60 * 1000;
const WEAK_HEARTBEAT_MS = 3 * 60 * 1000;
const UNREACHABLE_HEARTBEAT_MS = 6 * 60 * 1000;

function minutesAgo(date: Date | string | null): number | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - d.getTime()) / 60000);
}

function friendlyTimeAgo(date: Date | string | null): string {
  if (!date) return "unknown";
  const d = typeof date === "string" ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true });
}

export function getDeviceInfo(user: WatchedUser): DeviceInfo {
  const heartbeatAge = minutesAgo(user.lastHeartbeatAt);
  const locationAge = minutesAgo(user.lastLocationAt ?? user.lastHeartbeatAt);
  const hasLocation = user.lastLocationLat != null || user.lastHeartbeatLat != null;
  const batt = user.batteryLevel;
  const chg = user.batteryCharging;
  const net = user.networkType;

  let batteryText: string | null = null;
  let batteryIcon: "ok" | "low" | "charging" | "critical" | null = null;

  if (batt != null) {
    const pct = Math.round(batt * 100);
    if (chg) {
      batteryText = `Charging (${pct}%)`;
      batteryIcon = "charging";
    } else if (pct <= 10) {
      batteryText = `Battery very low (${pct}%)`;
      batteryIcon = "critical";
    } else if (pct <= 20) {
      batteryText = `Battery low (${pct}%)`;
      batteryIcon = "low";
    } else {
      batteryText = `Battery ${pct}%`;
      batteryIcon = "ok";
    }
  }

  let networkText: string | null = null;
  if (net) {
    switch (net) {
      case "wifi": networkText = "On Wi-Fi"; break;
      case "cell": networkText = "On mobile data"; break;
      case "4g": networkText = "On mobile data"; break;
      case "3g": networkText = "Weak connection"; break;
      case "2g": networkText = "Very weak connection"; break;
      case "slow-2g": networkText = "Very weak connection"; break;
      case "offline": networkText = "Phone offline"; break;
      case "online": networkText = "Online"; break;
      default: networkText = "Online"; break;
    }
  }

  let score = 100;

  if (heartbeatAge === null) {
    score -= 50;
  } else if (heartbeatAge > 6) {
    score -= 40;
  } else if (heartbeatAge > 3) {
    score -= 20;
  }

  if (!hasLocation) {
    score -= 20;
  } else if (locationAge !== null && locationAge > 5) {
    score -= 15;
  }

  const acc = user.lastHeartbeatAcc;
  if (acc != null && acc > 500) {
    score -= 15;
  } else if (acc != null && acc > 100) {
    score -= 5;
  }

  if (batt != null && batt <= 0.1) {
    score -= 10;
  } else if (batt != null && batt <= 0.2) {
    score -= 5;
  }

  if (net === "offline") {
    score -= 15;
  } else if (net === "2g" || net === "slow-2g") {
    score -= 10;
  } else if (net === "3g") {
    score -= 5;
  }

  let confidenceBand: ConfidenceBand;
  let confidenceText: string;

  if (score >= 70) {
    confidenceBand = "strong";
    confidenceText = "Everything looks reliable";
  } else if (score >= 40) {
    confidenceBand = "limited";
    if (net === "offline" || net === "2g" || net === "slow-2g") {
      confidenceText = "Phone is on, but connection looks weak";
    } else if (!hasLocation && heartbeatAge !== null && heartbeatAge < 6) {
      confidenceText = "Phone is online, but location is less clear";
    } else if (heartbeatAge !== null && heartbeatAge > 3) {
      confidenceText = "Updates may be delayed right now";
    } else {
      confidenceText = "Updates may be delayed right now";
    }
  } else {
    confidenceBand = "low";
    if (heartbeatAge === null || heartbeatAge > 6) {
      confidenceText = "Phone may be offline";
    } else {
      confidenceText = "Connection appears unstable";
    }
  }

  return { batteryText, batteryIcon, networkText, confidenceBand, confidenceText };
}

export function getEtaInfo(user: WatchedUser): EtaInfo | null {
  if (!user.activeSafeWalk) return null;
  const walk = user.activeSafeWalk;
  if (walk.status !== "active") return null;

  const expectedAt = new Date(walk.expectedArrivalAt);
  const now = Date.now();
  const remainingMs = expectedAt.getTime() - now;
  const remainingMin = Math.round(remainingMs / 60000);

  if (remainingMin <= 0) {
    return {
      etaText: "Running a little later than expected",
      destinationName: walk.destinationName,
      isDelayed: true,
    };
  }

  const expectedDuration = walk.lastLocationAt
    ? expectedAt.getTime() - new Date(walk.lastLocationAt).getTime()
    : remainingMs;
  const isDelayed = expectedDuration > 0 && remainingMs > expectedDuration * 1.3;

  if (isDelayed) {
    return {
      etaText: "Running a little later than expected",
      destinationName: walk.destinationName,
      isDelayed: true,
    };
  }

  let etaText: string;
  if (remainingMin <= 2) {
    etaText = "Almost there";
  } else if (remainingMin <= 5) {
    etaText = "A few minutes away";
  } else {
    etaText = `About ${remainingMin} minutes away`;
  }

  return { etaText, destinationName: walk.destinationName, isDelayed: false };
}

export function getWatcherInsight(user: WatchedUser): WatcherInsight {
  const heartbeatAge = minutesAgo(user.lastHeartbeatAt);
  const locationAge = minutesAgo(user.lastLocationAt ?? user.lastHeartbeatAt);
  const stateChangedAge = minutesAgo(user.safetyStateChangedAt);
  const hasLocation = user.lastLocationLat != null || user.lastHeartbeatLat != null;
  const now = Date.now();

  const connectionStatus: ConnectionStatus =
    heartbeatAge === null ? "unreachable" :
    heartbeatAge * 60000 < WEAK_HEARTBEAT_MS ? "connected" :
    heartbeatAge * 60000 < UNREACHABLE_HEARTBEAT_MS ? "weak" :
    "unreachable";

  const locationTimestamp = user.lastLocationAt ?? user.lastHeartbeatAt;
  const locAge = locationTimestamp ? now - new Date(locationTimestamp).getTime() : Infinity;
  const locationStatus: LocationStatus =
    !hasLocation ? "unavailable" :
    locAge < STALE_LOCATION_MS ? "live" :
    "stale";

  const connectionLabel =
    connectionStatus === "connected" ? "Phone is online" :
    connectionStatus === "weak" ? `Last signal ${friendlyTimeAgo(user.lastHeartbeatAt)}` :
    user.lastHeartbeatAt ? `Phone offline since ${friendlyTimeAgo(user.lastHeartbeatAt)}` :
    "No connection yet";

  const locationLabel =
    locationStatus === "live" ? "Live location updating" :
    locationStatus === "stale" ? "Location may be outdated" :
    connectionStatus === "connected" ? "Phone is online, waiting for location" :
    "Location unavailable";

  let recoveryMessage: string | null = null;
  if (user.safetyState === "active" && stateChangedAge !== null && stateChangedAge < 5) {
    if (user.safetyStateReason?.includes("heartbeat")) {
      recoveryMessage = "Back online just now";
    }
  }

  if (user.hasOpenIncident) {
    const reason = user.incidentReason === "sos" ? "SOS" : "Missed check-in";
    let subtext = user.lastHeartbeatAt
      ? `Last heard from ${friendlyTimeAgo(user.lastHeartbeatAt)}`
      : "Trying to reach them now";
    if (user.wellnessCallStatus === "help") {
      subtext = "We called them. They pressed Need Help.";
    } else if (user.wellnessCallStatus === "no_response") {
      subtext = `We called them ${friendlyTimeAgo(user.wellnessCallAt)}. No answer yet.`;
    } else if (user.reminderStage === "calling") {
      subtext = `We're calling them now${user.wellnessCallAt ? ` (${friendlyTimeAgo(user.wellnessCallAt)})` : ""}`;
    } else if (user.reminderStage === "sms") {
      subtext = "Sent them an SMS reminder. Waiting for reply.";
    } else if (user.reminderStage === "push") {
      subtext = "Sent them a push reminder. Waiting for reply.";
    }
    return {
      trustLevel: "worried",
      headline: `${reason} alert active`,
      subtext,
      connection: { status: connectionStatus, label: connectionLabel },
      location: { status: locationStatus, label: locationLabel },
      recoveryMessage: null,
      markerColor: "#ef4444",
      markerLabel: "Help",
      pulseColor: "#ef4444",
      bgClass: "bg-red-50 dark:bg-red-950/30",
      borderClass: "border-red-200 dark:border-red-800",
      iconColor: "text-red-500",
    };
  }

  if (user.safetyState === "concern") {
    let subtext = "Trying to reach them now";
    if (user.wellnessCallStatus === "no_response") {
      subtext = `We called them ${friendlyTimeAgo(user.wellnessCallAt)}. No answer yet.`;
    } else if (user.reminderStage === "calling") {
      subtext = "We're calling them now";
    }
    return {
      trustLevel: "worried",
      headline: `We haven't heard from ${user.userName.split(" ")[0]} for ${heartbeatAge ?? "?"} minutes`,
      subtext,
      connection: { status: connectionStatus, label: connectionLabel },
      location: { status: locationStatus, label: locationLabel },
      recoveryMessage: null,
      markerColor: "#ef4444",
      markerLabel: "Concern",
      pulseColor: "#ef4444",
      bgClass: "bg-red-50 dark:bg-red-950/30",
      borderClass: "border-red-200 dark:border-red-800",
      iconColor: "text-red-500",
    };
  }

  if (user.safetyState === "quiet") {
    const mins = heartbeatAge ?? stateChangedAge ?? 0;
    return {
      trustLevel: "watching",
      headline: `Quiet for the last ${mins} ${mins === 1 ? "minute" : "minutes"}`,
      subtext: hasLocation
        ? `Last seen ${friendlyTimeAgo(locationTimestamp)}`
        : "Waiting for location",
      connection: { status: connectionStatus, label: connectionLabel },
      location: { status: locationStatus, label: locationLabel },
      recoveryMessage: null,
      markerColor: "#f59e0b",
      markerLabel: "Quiet",
      pulseColor: "#f59e0b",
      bgClass: "bg-amber-50 dark:bg-amber-950/30",
      borderClass: "border-amber-200 dark:border-amber-800",
      iconColor: "text-amber-500",
    };
  }

  const nextDue = new Date(user.nextCheckinDue);
  const isOverdue = new Date() > nextDue;
  if (isOverdue && !user.hasOpenIncident) {
    return {
      trustLevel: "watching",
      headline: "Check-in is overdue",
      subtext: connectionStatus === "connected"
        ? "Phone is on, waiting for them to check in"
        : `Last heard from ${friendlyTimeAgo(user.lastHeartbeatAt)}`,
      connection: { status: connectionStatus, label: connectionLabel },
      location: { status: locationStatus, label: locationLabel },
      recoveryMessage,
      markerColor: "#f59e0b",
      markerLabel: "Overdue",
      pulseColor: "#f59e0b",
      bgClass: "bg-amber-50 dark:bg-amber-950/30",
      borderClass: "border-amber-200 dark:border-amber-800",
      iconColor: "text-amber-500",
    };
  }

  const checkinMethodLabel =
    user.lastCheckinMethod === "auto" ? " via phone call"
    : user.lastCheckinMethod === "sms" ? " via SMS"
    : user.lastCheckinMethod === "watch" ? " via watch"
    : "";

  return {
    trustLevel: "safe",
    headline: recoveryMessage || "Everything looks good",
    subtext: user.lastCheckinAt
      ? `Last check-in ${friendlyTimeAgo(user.lastCheckinAt)}${checkinMethodLabel}`
      : connectionStatus === "connected"
        ? "Phone is online"
        : "No check-ins yet",
    connection: { status: connectionStatus, label: connectionLabel },
    location: { status: locationStatus, label: locationLabel },
    recoveryMessage,
    markerColor: "#22c55e",
    markerLabel: "Active",
    pulseColor: "#22c55e",
    bgClass: "bg-green-50 dark:bg-green-950/30",
    borderClass: "border-green-200 dark:border-green-800",
    iconColor: "text-green-500",
  };
}

export function ConnectionBadge({ status, label }: { status: ConnectionStatus; label: string }) {
  const Icon = status === "connected" ? Wifi : status === "weak" ? SignalLow : WifiOff;
  const color = status === "connected" ? "text-green-500" : status === "weak" ? "text-amber-500" : "text-red-400";
  const bg = status === "connected" ? "bg-green-50 dark:bg-green-950/30" : status === "weak" ? "bg-amber-50 dark:bg-amber-950/30" : "bg-red-50 dark:bg-red-950/30";

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bg}`} data-testid="badge-connection">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function LocationBadge({ status, label }: { status: LocationStatus; label: string }) {
  const Icon = status === "live" ? MapPin : status === "stale" ? MapPin : MapPinOff;
  const color = status === "live" ? "text-green-500" : status === "stale" ? "text-amber-500" : "text-muted-foreground";
  const bg = status === "live" ? "bg-green-50 dark:bg-green-950/30" : status === "stale" ? "bg-amber-50 dark:bg-amber-950/30" : "bg-muted/50";

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bg}`} data-testid="badge-location">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function BatteryBadge({ device }: { device: DeviceInfo }) {
  if (!device.batteryText) return null;

  let Icon = Battery;
  let color = "text-green-500";
  let bg = "bg-green-50 dark:bg-green-950/30";

  if (device.batteryIcon === "charging") {
    Icon = BatteryCharging;
    color = "text-blue-500";
    bg = "bg-blue-50 dark:bg-blue-950/30";
  } else if (device.batteryIcon === "critical") {
    Icon = BatteryWarning;
    color = "text-red-500";
    bg = "bg-red-50 dark:bg-red-950/30";
  } else if (device.batteryIcon === "low") {
    Icon = BatteryLow;
    color = "text-amber-500";
    bg = "bg-amber-50 dark:bg-amber-950/30";
  }

  let contextHint = "";
  if (device.batteryIcon === "critical") {
    contextHint = " . Updates reduced to save battery.";
  } else if (device.batteryIcon === "low") {
    contextHint = " . Updates may be less frequent.";
  }

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bg}`} data-testid="badge-battery">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-xs text-muted-foreground">{device.batteryText}{contextHint}</span>
    </div>
  );
}

export function ConfidenceBadge({ device }: { device: DeviceInfo }) {
  if (device.confidenceBand === "strong") return null;

  const color = device.confidenceBand === "limited" ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400";
  const bg = device.confidenceBand === "limited" ? "bg-amber-50/50 dark:bg-amber-950/20" : "bg-red-50/50 dark:bg-red-950/20";

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bg}`} data-testid="badge-confidence">
      <SignalLow className={`w-3.5 h-3.5 ${color}`} />
      <span className={`text-xs ${color}`}>{device.confidenceText}</span>
    </div>
  );
}

export function EtaBadge({ eta }: { eta: EtaInfo }) {
  const color = eta.isDelayed ? "text-amber-600 dark:text-amber-400" : "text-blue-600 dark:text-blue-400";
  const bg = eta.isDelayed ? "bg-amber-50 dark:bg-amber-950/30" : "bg-blue-50 dark:bg-blue-950/30";
  const Icon = eta.isDelayed ? Clock : Navigation;

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${bg}`} data-testid="badge-eta">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className={`text-xs ${color}`}>
        {eta.destinationName ? `${eta.etaText} (${eta.destinationName})` : eta.etaText}
      </span>
    </div>
  );
}

export function TrustIndicator({ insight }: { insight: WatcherInsight }) {
  const ringColor =
    insight.trustLevel === "safe" ? "ring-green-400" :
    insight.trustLevel === "watching" ? "ring-amber-400" :
    "ring-red-400";

  const dotColor =
    insight.trustLevel === "safe" ? "bg-green-500" :
    insight.trustLevel === "watching" ? "bg-amber-500" :
    "bg-red-500";

  return (
    <div className={`relative w-11 h-11 rounded-full ring-2 ${ringColor} flex items-center justify-center ${insight.bgClass}`} data-testid="trust-indicator">
      <div className={`w-3 h-3 rounded-full ${dotColor} ${insight.trustLevel === "worried" ? "animate-pulse" : ""}`} />
    </div>
  );
}
