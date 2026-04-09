import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MapPin, Navigation, Footprints, Car, Bike, PersonStanding, Zap, RefreshCw, ExternalLink, Clock, Route, ArrowRight } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { formatDistanceToNow, format, differenceInSeconds, differenceInMinutes } from "date-fns";
import { getSocket } from "@/lib/socket";
import { formatActivity, formatSpeed } from "@/lib/live-location";
import LocationMap from "@/components/location-map";

interface LocationPoint {
  id: string;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  activity: string | null;
  accuracy: number | null;
  recordedAt: string;
}

interface TrailData {
  active: boolean;
  share?: {
    id: string;
    userId: string;
    lastLat: number | null;
    lastLng: number | null;
    lastSpeed: number | null;
    lastHeading: number | null;
    lastActivity: string | null;
    lastUpdatedAt: string;
    expiresAt: string | null;
    userName?: string;
    createdAt?: string;
  };
  points: LocationPoint[];
}

interface TimelineSegment {
  type: "stationary" | "moving";
  activity: string;
  startTime: string;
  endTime: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceKm: number;
  durationMin: number;
  maxSpeed: number | null;
  avgSpeed: number | null;
  pointCount: number;
  startPlace?: string;
  endPlace?: string;
}

function getActivityIcon(activity: string | null, size = "h-5 w-5") {
  switch (activity) {
    case "walking": return <Footprints className={size} />;
    case "running": return <Zap className={size} />;
    case "cycling": return <Bike className={size} />;
    case "driving": return <Car className={size} />;
    default: return <PersonStanding className={size} />;
  }
}

function getActivityColor(activity: string | null): string {
  switch (activity) {
    case "walking": return "bg-green-500 text-white";
    case "running": return "bg-orange-500 text-white";
    case "cycling": return "bg-blue-500 text-white";
    case "driving": return "bg-purple-500 text-white";
    default: return "bg-gray-400 text-white";
  }
}

function getActivityBorderColor(activity: string | null): string {
  switch (activity) {
    case "walking": return "border-green-500";
    case "running": return "border-orange-500";
    case "cycling": return "border-blue-500";
    case "driving": return "border-purple-500";
    default: return "border-gray-400";
  }
}

function getDirectionLabel(heading: number | null): string {
  if (heading == null) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(heading / 45) % 8;
  return dirs[idx];
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}

function formatDistance(km: number): string {
  if (km < 0.1) return "";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

const placeCache = new Map<string, string>();

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (placeCache.has(key)) return placeCache.get(key)!;

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`, {
      headers: { "User-Agent": "StillHere-App/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const addr = data.address;
    let place = "";
    if (addr.road) {
      place = addr.road;
      if (addr.house_number) place = `${addr.house_number} ${place}`;
    }
    if (addr.suburb) place = place ? `${place}, ${addr.suburb}` : addr.suburb;
    else if (addr.city || addr.town || addr.village) place = place ? `${place}, ${addr.city || addr.town || addr.village}` : (addr.city || addr.town || addr.village);
    if (!place) place = data.display_name?.split(",").slice(0, 2).join(",") || "";
    placeCache.set(key, place);
    return place;
  } catch {
    return "";
  }
}

function buildTimeline(points: LocationPoint[]): TimelineSegment[] {
  if (points.length < 2) return [];

  const segments: TimelineSegment[] = [];
  let segStart = 0;

  for (let i = 1; i <= points.length; i++) {
    const prevActivity = points[i - 1].activity || "stationary";
    const currActivity = i < points.length ? (points[i].activity || "stationary") : null;
    const prevIsMoving = prevActivity !== "stationary";
    const currIsMoving = currActivity ? currActivity !== "stationary" : null;

    if (currIsMoving !== prevIsMoving || i === points.length) {
      const segPoints = points.slice(segStart, i);
      let dist = 0;
      let maxSpd: number | null = null;
      let totalSpd = 0;
      let spdCount = 0;

      for (let j = 1; j < segPoints.length; j++) {
        dist += haversineDistance(segPoints[j - 1].lat, segPoints[j - 1].lng, segPoints[j].lat, segPoints[j].lng);
        if (segPoints[j].speed != null && segPoints[j].speed! > 0) {
          const spd = segPoints[j].speed! * 3.6;
          if (maxSpd === null || spd > maxSpd) maxSpd = spd;
          totalSpd += spd;
          spdCount++;
        }
      }

      const durMin = differenceInSeconds(new Date(segPoints[segPoints.length - 1].recordedAt), new Date(segPoints[0].recordedAt)) / 60;

      const dominantActivity = prevIsMoving
        ? (segPoints.filter(p => p.activity === "driving").length > segPoints.length / 2 ? "driving"
          : segPoints.filter(p => p.activity === "cycling").length > segPoints.length / 2 ? "cycling"
          : segPoints.filter(p => p.activity === "running").length > segPoints.length / 2 ? "running"
          : segPoints.filter(p => p.activity === "walking").length > segPoints.length / 2 ? "walking"
          : prevActivity)
        : "stationary";

      segments.push({
        type: prevIsMoving ? "moving" : "stationary",
        activity: dominantActivity,
        startTime: segPoints[0].recordedAt,
        endTime: segPoints[segPoints.length - 1].recordedAt,
        startLat: segPoints[0].lat,
        startLng: segPoints[0].lng,
        endLat: segPoints[segPoints.length - 1].lat,
        endLng: segPoints[segPoints.length - 1].lng,
        distanceKm: dist,
        durationMin: durMin,
        maxSpeed: maxSpd,
        avgSpeed: spdCount > 0 ? totalSpd / spdCount : null,
        pointCount: segPoints.length,
      });

      segStart = i;
    }
  }

  return segments;
}

function getStationarySince(points: LocationPoint[], currentActivity: string | null): string | null {
  if (currentActivity !== "stationary" && currentActivity !== null) return null;
  if (points.length === 0) return null;

  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].activity !== "stationary" && points[i].activity !== null) {
      if (i + 1 < points.length) return points[i + 1].recordedAt;
      return null;
    }
  }
  return points[0].recordedAt;
}

function getTotalDistance(points: LocationPoint[]): number {
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }
  return dist;
}

export default function LiveLocationViewPage() {
  const [, navigate] = useLocation();
  const params = useParams<{ userId: string }>();
  const targetUserId = params.userId;
  const [liveLat, setLiveLat] = useState<number | null>(null);
  const [liveLng, setLiveLng] = useState<number | null>(null);
  const [liveActivity, setLiveActivity] = useState<string | null>(null);
  const [liveSpeed, setLiveSpeed] = useState<number | null>(null);
  const [liveHeading, setLiveHeading] = useState<number | null>(null);
  const [liveTimestamp, setLiveTimestamp] = useState<string | null>(null);
  const [livePoints, setLivePoints] = useState<LocationPoint[]>([]);
  const [currentPlace, setCurrentPlace] = useState<string>("");
  const [segmentPlaces, setSegmentPlaces] = useState<Record<number, { start: string; end: string }>>({});

  const { data: trail, refetch, isLoading } = useQuery<TrailData>({
    queryKey: ["/api/live-location/trail", targetUserId],
    refetchInterval: 15000,
    enabled: !!targetUserId,
  });

  useEffect(() => {
    if (trail?.share) {
      setLiveLat(trail.share.lastLat);
      setLiveLng(trail.share.lastLng);
      setLiveActivity(trail.share.lastActivity);
      setLiveSpeed(trail.share.lastSpeed);
      setLiveHeading(trail.share.lastHeading);
      setLiveTimestamp(trail.share.lastUpdatedAt);
    }
    if (trail?.points) {
      setLivePoints(trail.points);
    }
  }, [trail]);

  useEffect(() => {
    if (liveLat != null && liveLng != null) {
      reverseGeocode(liveLat, liveLng).then(place => {
        if (place) setCurrentPlace(place);
      });
    }
  }, [liveLat, liveLng]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !targetUserId) return;

    const handleUpdate = (data: any) => {
      if (data.userId === targetUserId) {
        setLiveLat(data.lat);
        setLiveLng(data.lng);
        setLiveActivity(data.activity);
        setLiveSpeed(data.speed);
        setLiveHeading(data.heading);
        setLiveTimestamp(data.timestamp || new Date().toISOString());
        setLivePoints(prev => {
          const updated = [...prev, {
            id: Date.now().toString(),
            lat: data.lat,
            lng: data.lng,
            speed: data.speed,
            heading: data.heading,
            activity: data.activity,
            accuracy: null,
            recordedAt: data.timestamp || new Date().toISOString(),
          }];
          return updated.length > 200 ? updated.slice(-200) : updated;
        });
      }
    };

    socket.on("live-location:contact-updated", handleUpdate);
    return () => { socket.off("live-location:contact-updated", handleUpdate); };
  }, [targetUserId]);

  const openInMaps = () => {
    if (liveLat != null && liveLng != null) {
      window.open(`https://www.google.com/maps?q=${liveLat},${liveLng}`, "_blank");
    }
  };

  const userName = trail?.share?.userName || "Contact";
  const timeline = useMemo(() => buildTimeline(livePoints), [livePoints]);
  const stationarySince = useMemo(() => getStationarySince(livePoints, liveActivity), [livePoints, liveActivity]);
  const totalDistance = useMemo(() => getTotalDistance(livePoints), [livePoints]);

  useEffect(() => {
    timeline.forEach((seg, idx) => {
      if (segmentPlaces[idx]) return;
      Promise.all([
        reverseGeocode(seg.startLat, seg.startLng),
        reverseGeocode(seg.endLat, seg.endLng),
      ]).then(([start, end]) => {
        if (start || end) {
          setSegmentPlaces(prev => ({ ...prev, [idx]: { start, end } }));
        }
      });
    });
  }, [timeline]);

  const stationaryDuration = stationarySince
    ? formatDuration(differenceInMinutes(new Date(), new Date(stationarySince)))
    : null;

  if (!trail?.active && !isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-10 bg-primary text-primary-foreground p-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/live-location")} className="text-primary-foreground hover:bg-primary/80">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">Live Location</h1>
        </div>
        <div className="p-4 text-center">
          <Card>
            <CardContent className="pt-6">
              <PersonStanding className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
              <p className="font-medium">Location sharing is not active</p>
              <p className="text-sm text-muted-foreground mt-1">This person is not currently sharing their live location.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-20 bg-primary text-primary-foreground p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/live-location")} className="text-primary-foreground hover:bg-primary/80" data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">{userName}</h1>
          {liveTimestamp && (
            <p className="text-xs opacity-80">Updated {formatDistanceToNow(new Date(liveTimestamp), { addSuffix: true })}</p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={() => refetch()} className="text-primary-foreground hover:bg-primary/80" data-testid="button-refresh">
          <RefreshCw className="h-5 w-5" />
        </Button>
      </div>

      {liveLat != null && liveLng != null ? (
        <>
          <div className="relative flex-1 min-h-[45vh]">
            <LocationMap
              center={{ lat: liveLat, lng: liveLng }}
              points={livePoints.map(p => ({ lat: p.lat, lng: p.lng, activity: p.activity, timestamp: p.recordedAt }))}
              zoom={16}
              className="w-full h-full absolute inset-0"
              showTrail={livePoints.length > 1}
              markerLabel={userName}
            />
            <div className="absolute bottom-4 left-4 right-4 z-10 flex gap-2">
              <Button
                size="sm"
                className="shadow-lg"
                onClick={openInMaps}
                data-testid="button-open-maps"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open in Google Maps
              </Button>
            </div>
          </div>

          <div className="bg-background border-t overflow-y-auto" style={{ maxHeight: "55vh" }}>
            <div className="p-4 space-y-3">
              {currentPlace && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted" data-testid="current-place">
                  <MapPin className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{currentPlace}</p>
                    {stationaryDuration && liveActivity === "stationary" ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Here for {stationaryDuration}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {formatActivity(liveActivity)}
                        {liveSpeed != null && liveSpeed > 0.5 && ` -- ${formatSpeed(liveSpeed)}`}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2.5 rounded-lg bg-muted">
                  <div className={`h-7 w-7 rounded-full ${getActivityColor(liveActivity)} flex items-center justify-center mx-auto mb-1`}>
                    {getActivityIcon(liveActivity, "h-4 w-4")}
                  </div>
                  <p className="text-xs font-medium" data-testid="text-activity">{formatActivity(liveActivity)}</p>
                </div>
                <div className="text-center p-2.5 rounded-lg bg-muted">
                  <Navigation className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-xs font-medium" data-testid="text-speed">{formatSpeed(liveSpeed)}</p>
                </div>
                <div className="text-center p-2.5 rounded-lg bg-muted">
                  <Route className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-xs font-medium" data-testid="text-distance">{totalDistance > 0.01 ? formatDistance(totalDistance) : "0 m"}</p>
                </div>
              </div>

              {timeline.length > 0 && (
                <div data-testid="timeline-section">
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Activity Timeline
                  </h3>
                  <div className="relative pl-6">
                    <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-border" />

                    {timeline.slice().reverse().map((seg, idx) => {
                      const realIdx = timeline.length - 1 - idx;
                      const places = segmentPlaces[realIdx];
                      return (
                        <div key={idx} className="relative pb-4 last:pb-0" data-testid={`timeline-segment-${idx}`}>
                          <div className={`absolute left-[-13px] w-6 h-6 rounded-full ${getActivityColor(seg.activity)} flex items-center justify-center z-10`}>
                            {getActivityIcon(seg.activity, "h-3 w-3")}
                          </div>
                          <div className="ml-4 p-2.5 rounded-lg border bg-card">
                            {seg.type === "stationary" ? (
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-medium">Stayed</span>
                                  {places?.start && (
                                    <span className="text-xs text-muted-foreground truncate">at {places.start}</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                  <span>{format(new Date(seg.startTime), "h:mm a")} - {format(new Date(seg.endTime), "h:mm a")}</span>
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{formatDuration(seg.durationMin)}</Badge>
                                </div>
                              </div>
                            ) : (
                              <div>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-sm font-medium">{formatActivity(seg.activity)}</span>
                                  {seg.distanceKm > 0.05 && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{formatDistance(seg.distanceKm)}</Badge>
                                  )}
                                </div>
                                {(places?.start || places?.end) && places.start !== places.end && (
                                  <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                                    {places.start && <span className="truncate max-w-[120px]">{places.start}</span>}
                                    <ArrowRight className="h-3 w-3 shrink-0" />
                                    {places.end && <span className="truncate max-w-[120px]">{places.end}</span>}
                                  </div>
                                )}
                                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                  <span>{format(new Date(seg.startTime), "h:mm a")} - {format(new Date(seg.endTime), "h:mm a")}</span>
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{formatDuration(seg.durationMin)}</Badge>
                                </div>
                                {seg.maxSpeed != null && seg.maxSpeed > 5 && (
                                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                    <span>Max {Math.round(seg.maxSpeed)} km/h</span>
                                    {seg.avgSpeed != null && <span>Avg {Math.round(seg.avgSpeed)} km/h</span>}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {livePoints.length > 0 && timeline.length === 0 && (
                <details className="group">
                  <summary className="flex items-center gap-2 cursor-pointer text-sm font-medium py-2" data-testid="toggle-trail">
                    <Navigation className="h-4 w-4" />
                    Location Trail ({livePoints.length} points)
                  </summary>
                  <div className="space-y-2 max-h-48 overflow-y-auto mt-2">
                    {livePoints.slice(-20).reverse().map((point, idx) => (
                      <div
                        key={point.id}
                        className="flex items-center gap-3 text-sm py-2 border-b last:border-0"
                        data-testid={`trail-point-${idx}`}
                      >
                        <div className={`h-6 w-6 rounded-full ${getActivityColor(point.activity)} flex items-center justify-center shrink-0`}>
                          {getActivityIcon(point.activity, "h-3 w-3")}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-muted-foreground">{formatActivity(point.activity)}</span>
                          {point.speed != null && point.speed > 0.5 && (
                            <span className="text-muted-foreground"> - {formatSpeed(point.speed)}</span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(point.recordedAt), "h:mm:ss a")}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <MapPin className="h-12 w-12 mx-auto mb-3 animate-pulse" />
            <p className="font-medium">Waiting for location data...</p>
          </div>
        </div>
      )}
    </div>
  );
}
