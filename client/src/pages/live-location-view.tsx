import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Navigation, Footprints, Car, Bike, PersonStanding, Zap, RefreshCw, ExternalLink } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { formatDistanceToNow, format } from "date-fns";
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
  };
  points: LocationPoint[];
}

function getActivityIcon(activity: string | null) {
  switch (activity) {
    case "walking": return <Footprints className="h-5 w-5" />;
    case "running": return <Zap className="h-5 w-5" />;
    case "cycling": return <Bike className="h-5 w-5" />;
    case "driving": return <Car className="h-5 w-5" />;
    default: return <PersonStanding className="h-5 w-5" />;
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

function getDirectionLabel(heading: number | null): string {
  if (heading == null) return "";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(heading / 45) % 8;
  return dirs[idx];
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
        <div className="flex-1">
          <h1 className="text-lg font-semibold">{userName}</h1>
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
          <div className="relative flex-1 min-h-[50vh]">
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

          <div className="bg-background border-t p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-muted">
                <div className={`h-8 w-8 rounded-full ${getActivityColor(liveActivity)} flex items-center justify-center mx-auto mb-1`}>
                  {getActivityIcon(liveActivity)}
                </div>
                <p className="text-sm font-medium" data-testid="text-activity">{formatActivity(liveActivity)}</p>
                <p className="text-xs text-muted-foreground">Activity</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted">
                <Navigation className="h-5 w-5 mx-auto mb-1" />
                <p className="text-sm font-medium" data-testid="text-speed">{formatSpeed(liveSpeed)}</p>
                <p className="text-xs text-muted-foreground">Speed</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-muted">
                <Navigation className="h-5 w-5 mx-auto mb-1" style={{ transform: `rotate(${liveHeading || 0}deg)` }} />
                <p className="text-sm font-medium" data-testid="text-heading">{getDirectionLabel(liveHeading) || "--"}</p>
                <p className="text-xs text-muted-foreground">Direction</p>
              </div>
            </div>

            {livePoints.length > 0 && (
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
                        {getActivityIcon(point.activity)}
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
