import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import GoogleMap from "@/components/google-map";
import type { WatchedUser } from "@shared/schema";
import { getSocket } from "@/lib/socket";
import { formatDistanceToNow } from "date-fns";

type MapPerson = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  activity?: string | null;
  speed?: number | null;
  heading?: number | null;
  lastUpdated?: string;
  isMe?: boolean;
  safetyState?: string | null;
  hasSafetyEvent?: boolean;
};

type LiveSnapshot = Record<string, {
  lat: number;
  lng: number;
  activity?: string | null;
  speed?: number | null;
  heading?: number | null;
  timestamp: string;
}>;

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

export default function GuardianMapPage() {
  const [, setLocation] = useLocation();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [threeD, setThreeD] = useState(false);
  const [mapType, setMapType] = useState<"roadmap" | "satellite" | "hybrid">("roadmap");
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [liveSnap, setLiveSnap] = useState<LiveSnapshot>({});
  const [sheetOpen, setSheetOpen] = useState(true);
  const initialFitRef = useRef(false);

  const { data: watchedUsers, isLoading } = useQuery<WatchedUser[]>({
    queryKey: ["/api/watched-users"],
    refetchInterval: 30_000,
  });

  // Get watcher's own browser location for fit-bounds context.
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
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
        lastUpdated,
        safetyState: w.safetyState,
        hasSafetyEvent: w.hasOpenIncident || w.safetyState === "concern",
      });
    });
    if (myPos) {
      list.push({
        id: "__me__",
        name: "You",
        lat: myPos.lat,
        lng: myPos.lng,
        isMe: true,
        safetyState: "active",
      });
    }
    return list;
  }, [watchedUsers, liveSnap, myPos]);

  // Initial center: average of all known coords, or watcher's own position, or Melbourne fallback.
  const initialCenter = useMemo(() => {
    if (people.length > 0) {
      const lat = people.reduce((s, p) => s + p.lat, 0) / people.length;
      const lng = people.reduce((s, p) => s + p.lng, 0) / people.length;
      return { lat, lng };
    }
    if (myPos) return myPos;
    return { lat: -37.8136, lng: 144.9631 };
  }, [people, myPos]);

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

  return (
    <div className="fixed inset-0 bg-background flex flex-col" data-testid="page-guardian-map">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-20 p-3 pointer-events-none">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          <BackButton to="/watched" className="pointer-events-auto shadow-lg" />
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
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        <GoogleMap
          center={initialCenter}
          zoom={people.length > 1 ? 11 : 14}
          people={people}
          smartCamera
          focusPersonId={focusId}
          mapType={threeD && mapType === "roadmap" ? "satellite" : mapType}
          tilt={threeD ? 67.5 : 0}
          heading={threeD ? 30 : 0}
          showMapTypeControl={false}
          showMyLocation={false}
          onPersonTap={(id) => {
            if (id !== "__me__") setFocusId(id);
          }}
          className="w-full h-full"
        />

        {/* Quick legend */}
        <div className="absolute top-20 right-3 z-10">
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

        {/* Bottom sheet trigger (mobile) */}
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

                {(watchedUsers || []).length === 0 && (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No one to watch yet.
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
                          setFocusId(w.userId);
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
                                <span>Location not shared</span>
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
      </div>
    </div>
  );
}
