import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MapPin, Navigation, Footprints, Car, Bike, PersonStanding, Zap, RefreshCw, ExternalLink } from "lucide-react";
import { useLocation, useParams } from "wouter";
import { formatDistanceToNow, format } from "date-fns";
import { getSocket } from "@/lib/socket";
import { formatActivity, formatSpeed } from "@/lib/live-location";

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
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-primary text-primary-foreground p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/live-location")} className="text-primary-foreground hover:bg-primary/80" data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Live Location</h1>
          {liveTimestamp && (
            <p className="text-xs opacity-80">Updated {formatDistanceToNow(new Date(liveTimestamp), { addSuffix: true })}</p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={() => refetch()} className="text-primary-foreground hover:bg-primary/80" data-testid="button-refresh">
          <RefreshCw className="h-5 w-5" />
        </Button>
      </div>

      <div className="p-4 space-y-4 max-w-lg mx-auto">
        {liveLat != null && liveLng != null && (
          <Card>
            <CardContent className="pt-6">
              <div className="relative w-full h-48 rounded-lg overflow-hidden bg-muted mb-4">
                <img
                  src={`https://maps.googleapis.com/maps/api/staticmap?center=${liveLat},${liveLng}&zoom=16&size=600x300&markers=color:red%7C${liveLat},${liveLng}&key=`}
                  alt="Location map"
                  className="w-full h-full object-cover hidden"
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-blue-100 to-blue-50 dark:from-blue-950 dark:to-blue-900">
                  <MapPin className="h-10 w-10 text-red-500 mb-2" />
                  <p className="text-sm font-mono">{liveLat.toFixed(6)}, {liveLng.toFixed(6)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={openInMaps}
                    data-testid="button-open-maps"
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Open in Google Maps
                  </Button>
                </div>
              </div>

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
            </CardContent>
          </Card>
        )}

        {trail?.points && trail.points.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-medium mb-3 flex items-center gap-2">
                <Navigation className="h-4 w-4" />
                Location Trail
              </h3>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {trail.points.slice(-20).reverse().map((point, idx) => (
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
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
