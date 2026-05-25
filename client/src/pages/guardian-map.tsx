import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  MapPin,
  AlertTriangle,
  Footprints,
  Bike,
  Car,
  Activity,
  CircleDot,
  Building2,
  Map as MapIcon,
  ChevronUp,
  List,
  Maximize2,
  MessageSquare,
  Phone,
  ShieldCheck,
  CheckCircle2,
  X,
  CloudSun,
  Wind,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import GoogleMap from "@/components/google-map";
import type { WatchedUser } from "@shared/schema";
import { getSocket } from "@/lib/socket";
import { formatDistanceToNow } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type MapPerson = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  activity?: string | null;
  speed?: number | null;
  heading?: number | null;
  accuracy?: number | null;
  lastUpdated?: string;
  isMe?: boolean;
  safetyState?: string | null;
  hasSafetyEvent?: boolean;
  safetyStateReason?: string | null;
  incidentReason?: string | null;
};

type LiveSnapshot = Record<string, {
  lat: number;
  lng: number;
  activity?: string | null;
  speed?: number | null;
  heading?: number | null;
  accuracy?: number | null;
  timestamp: string;
}>;

type WatcherRequest = {
  contactId: string;
  ownerName: string;
  contactName: string;
  role: string;
  requestedAt: string | Date | null;
};

const ACTIVITY_LABEL: Record<string, string> = {
  stationary: "Still",
  walking: "Walking",
  running: "Running",
  cycling: "Cycling",
  driving: "Driving",
};

function ActivityIcon({ activity, className }: { activity?: string | null; className?: string }) {
  const cls = className || "w-4 h-4";
  switch (activity) {
    case "walking":
    case "running":
      return <Footprints className={cls} />;
    case "cycling":
      return <Bike className={cls} />;
    case "driving":
      return <Car className={cls} />;
    default:
      return <CircleDot className={cls} />;
  }
}

function stateColor(state: string | null | undefined, hasIncident: boolean): {
  dot: string;
  text: string;
  bg: string;
  ring: string;
  label: string;
} {
  if (hasIncident || state === "concern") {
    return {
      dot: "bg-red-500",
      text: "text-red-600 dark:text-red-400",
      bg: "bg-red-50 dark:bg-red-950/40",
      ring: "ring-red-500/30",
      label: "Needs help",
    };
  }
  if (state === "quiet") {
    return {
      dot: "bg-amber-500",
      text: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-50 dark:bg-amber-950/40",
      ring: "ring-amber-500/30",
      label: "Quiet",
    };
  }
  return {
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    ring: "ring-emerald-500/30",
    label: "Calm",
  };
}

function weatherTone(risk?: string | null): string {
  if (risk === "high") return "text-red-600 dark:text-red-400";
  if (risk === "moderate") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function compactWeather(weather: WatchedUser["weather"]): string | null {
  if (!weather) return null;
  const temp = weather.temperatureC != null ? `${weather.temperatureC}°C` : null;
  return [temp, weather.summary].filter(Boolean).join(" · ") || null;
}

function locationStatusText(
  person: Pick<WatchedUser, "locationStatus" | "locationStatusReason" | "lastKnownLocationAt" | "lastLocationAt" | "lastHeartbeatAt">,
): string {
  const lastKnownAt = person.lastKnownLocationAt || person.lastLocationAt || person.lastHeartbeatAt;
  const lastKnown = lastKnownAt
    ? ` Last known ${formatDistanceToNow(new Date(lastKnownAt), { addSuffix: true })}.`
    : "";
  if (person.locationStatus === "last_known") {
    if (person.locationStatusReason === "sharing_paused") return `Location sharing is off.${lastKnown}`;
    if (person.locationStatusReason === "presence_only") return `Precise location sharing is off.${lastKnown}`;
    return `Showing last known location.${lastKnown}`;
  }
  if (person.locationStatusReason === "permission_denied") return "This contact has not allowed location sharing with you.";
  if (person.locationStatusReason === "sharing_paused") return "Location sharing is off. No last known location is available yet.";
  if (person.locationStatusReason === "presence_only") return "Precise location sharing is off. No last known location is available yet.";
  return "Location is not currently shared.";
}

export default function GuardianMapPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [threeD, setThreeD] = useState(false);
  const [mapType, setMapType] = useState<"roadmap" | "satellite" | "hybrid">("roadmap");
  const [myPos, setMyPos] = useState<{ lat: number; lng: number; accuracy?: number | null } | null>(() => {
    try {
      const cached = localStorage.getItem("stillhere_watcher_pos");
      if (cached) {
        const parsed = JSON.parse(cached);
        if (typeof parsed?.lat === "number" && typeof parsed?.lng === "number") {
          return { lat: parsed.lat, lng: parsed.lng, accuracy: parsed.accuracy ?? null };
        }
      }
    } catch {}
    return null;
  });
  const [liveSnap, setLiveSnap] = useState<LiveSnapshot>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const initialFitRef = useRef(false);

  const { data: watchedUsers, isLoading } = useQuery<WatchedUser[]>({
    queryKey: ["/api/watched-users"],
    refetchInterval: 30_000,
  });

  const { data: watcherRequests } = useQuery<{ requests: WatcherRequest[] }>({
    queryKey: ["/api/watcher-requests"],
    refetchInterval: 30_000,
  });

  const acceptRequestMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watcher-requests/${contactId}/accept`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watcher-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      toast({ title: "Request accepted", description: "They now appear in your watcher area." });
    },
    onError: (err: any) => {
      toast({ title: "Could not accept request", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  const declineRequestMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watcher-requests/${contactId}/decline`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watcher-requests"] });
      toast({ title: "Request declined" });
    },
    onError: (err: any) => {
      toast({ title: "Could not decline request", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  // Watch the watcher's own browser location continuously so fit-bounds always
  // includes both the watcher and the watched users (Life360-style overview).
  useEffect(() => {
    if (!navigator.geolocation) return;
    const onPos = (pos: GeolocationPosition) => {
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
      setMyPos(next);
      try {
        localStorage.setItem("stillhere_watcher_pos", JSON.stringify(next));
      } catch {}
    };
    navigator.geolocation.getCurrentPosition(onPos, () => {}, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 10_000,
    });
    const watchId = navigator.geolocation.watchPosition(onPos, () => {}, {
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 10_000,
    });
    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, []);

  // Subscribe to live location updates for any watched user.
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: {
      userId: string;
      lat: number;
      lng: number;
      speed: number | null;
      heading: number | null;
      accuracy?: number | null;
      activity: string;
      timestamp: string;
    }) => {
      if (!data?.userId || data.lat == null || data.lng == null) return;
      setLiveSnap((prev) => ({
        ...prev,
        [data.userId]: {
          lat: data.lat,
          lng: data.lng,
          activity: data.activity,
          speed: data.speed,
          heading: data.heading,
          accuracy: data.accuracy ?? null,
          timestamp: data.timestamp || new Date().toISOString(),
        },
      }));
    };
    socket.on("live-location:contact-updated", handler);
    return () => {
      socket.off("live-location:contact-updated", handler);
    };
  }, []);

  // Build the marker list. Live socket data overrides REST data when fresher.
  const people = useMemo<MapPerson[]>(() => {
    const list: MapPerson[] = [];
    (watchedUsers || []).forEach((w) => {
      const live = liveSnap[w.userId];
      const lat =
        live?.lat ??
        (w.lastLocationLat != null ? Number(w.lastLocationLat) : null) ??
        (w.lastHeartbeatLat != null ? Number(w.lastHeartbeatLat) : null);
      const lng =
        live?.lng ??
        (w.lastLocationLng != null ? Number(w.lastLocationLng) : null) ??
        (w.lastHeartbeatLng != null ? Number(w.lastHeartbeatLng) : null);
      if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return;

      const activity = live?.activity ?? w.lastActivity ?? "stationary";
      const speed = live?.speed ?? w.lastSpeed ?? null;
      const heading = live?.heading ?? null;
      const accuracy = live?.accuracy ?? w.lastLocationAcc ?? w.lastHeartbeatAcc ?? null;
      const lastUpdated =
        live?.timestamp ??
        (w.lastLocationAt ? new Date(w.lastLocationAt).toISOString() : undefined) ??
        (w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toISOString() : undefined);

      list.push({
        id: w.userId,
        name: w.userName,
        lat,
        lng,
        activity,
        speed,
        heading,
        accuracy,
        lastUpdated,
        safetyState: w.safetyState,
        hasSafetyEvent: w.hasOpenIncident || w.safetyState === "concern",
        safetyStateReason: w.safetyStateReason,
        incidentReason: w.incidentReason,
      });
    });
    if (myPos) {
      list.push({
        id: "__me__",
        name: "You",
        lat: myPos.lat,
        lng: myPos.lng,
        accuracy: myPos.accuracy ?? null,
        isMe: true,
        safetyState: "active",
      });
    }
    return list;
  }, [watchedUsers, liveSnap, myPos]);

  // Initial center: average of all known real coordinates, or the watcher's own position.
  const rawInitialCenter = useMemo(() => {
    if (people.length > 0) {
      const lat = people.reduce((s, p) => s + p.lat, 0) / people.length;
      const lng = people.reduce((s, p) => s + p.lng, 0) / people.length;
      return { lat, lng };
    }
    if (myPos) return myPos;
    return null;
  }, [people, myPos]);
  const [lastInitialCenter, setLastInitialCenter] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (rawInitialCenter) setLastInitialCenter(rawInitialCenter);
  }, [rawInitialCenter]);
  const initialCenter = rawInitialCenter || lastInitialCenter;

  // Auto-fit once when we first have coords.
  useEffect(() => {
    if (people.length > 0 && !initialFitRef.current) {
      initialFitRef.current = true;
    }
  }, [people.length]);

  const visibleWatched = (watchedUsers || []).filter((w) => {
    const live = liveSnap[w.userId];
    return (
      live ||
      w.lastLocationLat != null ||
      w.lastHeartbeatLat != null
    );
  });
  const hiddenWatched = (watchedUsers || []).filter((w) => {
    const live = liveSnap[w.userId];
    return (
      !live &&
      w.lastLocationLat == null &&
      w.lastHeartbeatLat == null
    );
  });

  const concernCount = (watchedUsers || []).filter(
    (w) => w.hasOpenIncident || w.safetyState === "concern",
  ).length;
  const pendingRequests = watcherRequests?.requests || [];
  const requestActionPending = acceptRequestMutation.isPending || declineRequestMutation.isPending;

  return (
    <div className="fixed inset-0 bg-background flex flex-col" data-testid="page-guardian-map">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 p-3 pointer-events-none">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <BackButton to="/" className="pointer-events-auto shadow-lg" />
          <Card className="pointer-events-auto flex-1 px-3 py-2 flex items-center gap-3 shadow-lg">
            <MapIcon className="w-4 h-4 text-primary" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Guardian map</p>
              <p className="text-xs text-muted-foreground leading-tight truncate">
                {isLoading
                  ? "Loading..."
                  : `${visibleWatched.length} on map${
                      hiddenWatched.length > 0 ? ` · ${hiddenWatched.length} no location` : ""
                    }${concernCount > 0 ? ` · ${concernCount} need help` : ""}`}
              </p>
            </div>
          </Card>
          <Button
            variant={threeD ? "default" : "secondary"}
            size="sm"
            className="pointer-events-auto shadow-lg gap-1"
            onClick={() => setThreeD((v) => !v)}
            data-testid="button-toggle-3d"
          >
            <Building2 className="w-4 h-4" />
            3D
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="pointer-events-auto shadow-lg gap-1"
            onClick={() => setLocation("/watched/list")}
            data-testid="button-open-list-view"
          >
            <List className="w-4 h-4" />
            List
          </Button>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        {initialCenter ? (
          <GoogleMap
            center={initialCenter}
            zoom={people.length > 1 ? 11 : 14}
            people={people}
            smartCamera
            focusPersonId={focusedId}
            mapType={threeD && mapType === "roadmap" ? "satellite" : mapType}
            tilt={threeD ? 67.5 : 0}
            heading={threeD ? 30 : 0}
            showMapTypeControl={false}
            showMyLocation={false}
            onPersonTap={(id) => {
              if (id === "__me__") return;
              setFocusedId(id);
            }}
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full bg-muted/40 flex items-center justify-center px-5" data-testid="guardian-map-empty">
            <div className="max-w-sm text-center space-y-3">
              <div className="mx-auto w-14 h-14 rounded-full bg-card border border-border flex items-center justify-center shadow-sm">
                <MapPin className="w-7 h-7 text-muted-foreground" />
              </div>
              <div>
                <p className="font-semibold text-foreground">No live location available</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Locations appear here only when a person shares location or has an active safety event.
                </p>
              </div>
            </div>
          </div>
        )}

        {!focusedId && hiddenWatched.length > 0 && (
          <div className="absolute top-20 left-3 right-3 z-20 pointer-events-none">
            <Card className="pointer-events-auto max-w-3xl mx-auto px-3 py-2 shadow-lg">
              <div className="flex items-start gap-2 text-xs">
                <MapPin className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium text-foreground">Location not shared</p>
                  <p className="text-muted-foreground">
                    {hiddenWatched.slice(0, 2).map((w) => w.userName).join(", ")}
                    {hiddenWatched.length > 2 ? ` and ${hiddenWatched.length - 2} more` : ""}
                    {" "}are not sharing a current location. If StillHere has a previous location, it will be shown as last known.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        )}

        {pendingRequests.length > 0 && !focusedId && (
          <div className={`absolute ${hiddenWatched.length > 0 ? "top-40" : "top-20"} left-0 right-0 z-20 px-3 pointer-events-none`}>
            <Card className="pointer-events-auto max-w-3xl mx-auto p-3 shadow-xl border-primary/30">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-sm">Safety Circle request</p>
                    <Badge variant="outline" className="text-[10px]">
                      {pendingRequests.length}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pendingRequests[0].ownerName} asked you to be their StillHere contact.
                    {pendingRequests.length > 1 ? ` ${pendingRequests.length - 1} more request${pendingRequests.length > 2 ? "s" : ""} waiting.` : ""}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => declineRequestMutation.mutate(pendingRequests[0].contactId)}
                  disabled={requestActionPending}
                  data-testid={`button-map-decline-request-${pendingRequests[0].contactId}`}
                >
                  <X className="w-4 h-4 mr-1" />
                  Decline
                </Button>
                <Button
                  size="sm"
                  onClick={() => acceptRequestMutation.mutate(pendingRequests[0].contactId)}
                  disabled={requestActionPending}
                  data-testid={`button-map-accept-request-${pendingRequests[0].contactId}`}
                >
                  <CheckCircle2 className="w-4 h-4 mr-1" />
                  Accept
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSheetOpen(true);
                  }}
                  data-testid="button-map-review-requests"
                >
                  Review
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* Quick legend */}
        <div className={`absolute ${pendingRequests.length > 0 && !focusedId ? "top-52" : "top-20"} right-3 z-10`}>
          <Card className="p-2 shadow-lg flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>Calm</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span>Quiet</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span>Help</span>
            </div>
          </Card>
        </div>

        {/* Focused person card */}
        {focusedId && (() => {
          const w = (watchedUsers || []).find((x) => x.userId === focusedId);
          if (!w) return null;
          const colors = stateColor(w.safetyState, w.hasOpenIncident);
          const live = liveSnap[w.userId];
          const activity = (live?.activity ?? w.lastActivity ?? "stationary") as string;
          const accuracy = live?.accuracy ?? w.lastLocationAcc ?? w.lastHeartbeatAcc ?? null;
          const batteryLabel = w.batteryLevel != null
            ? `${Math.round(w.batteryLevel * 100)}%${w.batteryCharging ? " charging" : ""}`
            : null;
          const lastTs =
            live?.timestamp ??
            (w.lastLocationAt ? new Date(w.lastLocationAt).toISOString() : undefined) ??
            (w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toISOString() : undefined);
          return (
            <div className="absolute bottom-4 left-0 right-0 z-20 px-3 pointer-events-none">
              <Card
                className="pointer-events-auto max-w-3xl mx-auto p-3 shadow-2xl border-2"
                data-testid={`card-focused-${w.userId}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-12 h-12 rounded-full ${colors.bg} flex items-center justify-center border shrink-0`}>
                    <span className="text-lg font-semibold">
                      {w.userName?.charAt(0)?.toUpperCase() || "?"}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold truncate" data-testid={`text-focused-name-${w.userId}`}>
                        {w.userName}
                      </p>
                      <Badge variant="outline" className={`text-[10px] ${colors.text}`}>
                        {colors.label}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <ActivityIcon activity={activity} className="w-3.5 h-3.5" />
                        {ACTIVITY_LABEL[activity] || "Still"}
                      </span>
                      {lastTs && (
                        <>
                          <span>·</span>
                          <span>{formatDistanceToNow(new Date(lastTs), { addSuffix: true })}</span>
                        </>
                      )}
                      {accuracy != null && Number.isFinite(Number(accuracy)) && Number(accuracy) > 0 && (
                        <>
                          <span>Â·</span>
                          <span>Accurate to ~{Math.round(Number(accuracy))}m</span>
                        </>
                      )}
                      {batteryLabel && (
                        <>
                          <span>Â·</span>
                          <span>Battery {batteryLabel}</span>
                        </>
                      )}
                    </div>
                    {w.locationStatus !== "live" && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-location-status-${w.userId}`}>
                        {locationStatusText(w)}
                      </p>
                    )}
                    {w.hasOpenIncident && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-red-600 dark:text-red-400">
                        <AlertTriangle className="w-3 h-3" />
                        <span className="font-medium">
                          {w.incidentReason === "sos"
                            ? "SOS triggered"
                            : w.incidentReason === "missed_checkin"
                            ? "Missed check-in"
                            : "Needs attention"}
                        </span>
                      </div>
                    )}
                    {compactWeather(w.weather) && (
                      <div className={`flex items-center gap-2 mt-1 text-xs ${weatherTone(w.weather?.risk)}`} data-testid={`text-weather-${w.userId}`}>
                        <CloudSun className="w-3.5 h-3.5" />
                        <span className="font-medium">{compactWeather(w.weather)}</span>
                        {w.weather?.windKmh != null && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Wind className="w-3 h-3" />
                            {w.weather.windKmh} km/h
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFocusedId(null)}
                    className="shrink-0 gap-1"
                    data-testid="button-show-all"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Show all
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocation(`/chat/${w.userId}`)}
                    className="gap-1"
                    data-testid={`button-message-${w.userId}`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    Message
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocation(`/call/${w.userId}`)}
                    className="gap-1"
                    data-testid={`button-call-${w.userId}`}
                  >
                    <Phone className="w-4 h-4" />
                    Call
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => setLocation(`/live-location/${w.userId}`)}
                    className="gap-1"
                    data-testid={`button-live-${w.userId}`}
                  >
                    <MapPin className="w-4 h-4" />
                    Live view
                  </Button>
                </div>
              </Card>
            </div>
          );
        })()}

        {/* Bottom sheet trigger (mobile) */}
        {!focusedId ? (
        <div className="absolute bottom-4 left-0 right-0 z-10 px-3 pointer-events-none">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button
                variant="default"
                className="pointer-events-auto w-full max-w-3xl mx-auto flex items-center gap-2 shadow-xl"
                data-testid="button-open-people-sheet"
              >
                <ChevronUp className="w-4 h-4" />
                {watchedUsers?.length || 0} people
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-2xl max-h-[70vh] overflow-y-auto">
              <div className="space-y-2 pt-2">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-base font-semibold">Your circle</h2>
                  <Badge variant="outline" className="text-xs">
                    {visibleWatched.length} on map
                  </Badge>
                </div>

                {pendingRequests.length > 0 && (
                  <div className="space-y-2" data-testid="sheet-watcher-requests">
                    {pendingRequests.map((request) => (
                      <div
                        key={request.contactId}
                        className="rounded-xl border border-primary/30 bg-primary/5 p-3"
                        data-testid={`card-sheet-request-${request.contactId}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <ShieldCheck className="w-5 h-5 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium">Safety Circle request</p>
                            <p className="text-sm text-muted-foreground">
                              {request.ownerName} asked you to be their StillHere contact.
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => declineRequestMutation.mutate(request.contactId)}
                            disabled={requestActionPending}
                            data-testid={`button-sheet-decline-request-${request.contactId}`}
                          >
                            Decline
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => acceptRequestMutation.mutate(request.contactId)}
                            disabled={requestActionPending}
                            data-testid={`button-sheet-accept-request-${request.contactId}`}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-1.5" />
                            Accept
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {(watchedUsers || []).length === 0 && pendingRequests.length === 0 && (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No one to watch yet. Safety Circle requests will appear here.
                  </p>
                )}

                {(watchedUsers || []).map((w) => {
                  const live = liveSnap[w.userId];
                  const hasCoords =
                    live ||
                    w.lastLocationLat != null ||
                    w.lastHeartbeatLat != null;
                  const colors = stateColor(w.safetyState, w.hasOpenIncident);
                  const activity = (live?.activity ?? w.lastActivity ?? "stationary") as string;
                  const lastTs =
                    live?.timestamp ??
                    (w.lastLocationAt ? new Date(w.lastLocationAt).toISOString() : undefined) ??
                    (w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toISOString() : undefined);

                  return (
                    <button
                      key={w.userId}
                      type="button"
                      onClick={() => {
                        if (hasCoords) {
                          setFocusedId(w.userId);
                          setSheetOpen(false);
                        }
                      }}
                      className={`w-full text-left rounded-xl p-3 transition border ring-1 ${colors.bg} ${colors.ring} ${
                        hasCoords ? "hover-elevate active-elevate-2 cursor-pointer" : "opacity-70 cursor-default"
                      }`}
                      data-testid={`row-watched-${w.userId}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="relative">
                          <div className={`w-10 h-10 rounded-full ${colors.bg} flex items-center justify-center border`}>
                            <span className="text-base font-semibold">
                              {w.userName?.charAt(0)?.toUpperCase() || "?"}
                            </span>
                          </div>
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${colors.dot} ring-2 ring-background`}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium truncate" data-testid={`text-name-${w.userId}`}>
                              {w.userName}
                            </p>
                            <Badge variant="outline" className={`text-[10px] ${colors.text}`}>
                              {colors.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <ActivityIcon activity={activity} className="w-3.5 h-3.5" />
                              {ACTIVITY_LABEL[activity] || "Still"}
                            </span>
                            {hasCoords ? (
                              <>
                                <span>·</span>
                                <span className="flex items-center gap-1">
                                  <Activity className="w-3 h-3" />
                                  {lastTs ? formatDistanceToNow(new Date(lastTs), { addSuffix: true }) : "now"}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>·</span>
                                <span>{locationStatusText(w)}</span>
                              </>
                            )}
                          </div>
                          {w.hasOpenIncident && (
                            <div className="flex items-center gap-1 mt-1 text-xs text-red-600 dark:text-red-400">
                              <AlertTriangle className="w-3 h-3" />
                              <span className="font-medium">
                                {w.incidentReason === "sos"
                                  ? "SOS triggered"
                                  : w.incidentReason === "missed_checkin"
                                  ? "Missed check-in"
                                : "Needs attention"}
                              </span>
                            </div>
                          )}
                          {compactWeather(w.weather) && (
                            <div className={`flex items-center gap-1 mt-1 text-xs ${weatherTone(w.weather?.risk)}`}>
                              <CloudSun className="w-3 h-3" />
                              <span>{compactWeather(w.weather)}</span>
                            </div>
                          )}
                        </div>
                        {hasCoords && (
                          <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </SheetContent>
          </Sheet>
        </div>
        ) : null}
      </div>
    </div>
  );
}
