import { formatDistanceToNow } from "date-fns";
import type { WatchedUser } from "@shared/schema";
import {
  Wifi, WifiOff, MapPin, MapPinOff, Signal, SignalLow, SignalZero,
} from "lucide-react";

export type ConnectionStatus = "connected" | "weak" | "unreachable";
export type LocationStatus = "live" | "stale" | "unavailable";
export type TrustLevel = "safe" | "watching" | "worried";

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
    user.lastHeartbeatAt ? `Phone unreachable since ${friendlyTimeAgo(user.lastHeartbeatAt)}` :
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
    return {
      trustLevel: "worried",
      headline: `${reason} alert active`,
      subtext: user.lastHeartbeatAt
        ? `Last heard from ${friendlyTimeAgo(user.lastHeartbeatAt)}`
        : "Trying to reach them now",
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
    return {
      trustLevel: "worried",
      headline: `We haven't heard from ${user.userName.split(" ")[0]} for ${heartbeatAge ?? "?"} minutes`,
      subtext: "Trying to reach them now",
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
      headline: `No updates in the last ${mins} ${mins === 1 ? "minute" : "minutes"}`,
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

  return {
    trustLevel: "safe",
    headline: recoveryMessage || "Everything looks good",
    subtext: user.lastCheckinAt
      ? `Last check-in ${friendlyTimeAgo(user.lastCheckinAt)}`
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
