import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { startLiveTracking, stopLiveTracking, isLiveTrackingActive, formatActivity, formatSpeed, addLocationListener } from "@/lib/live-location";
import { getSocket } from "@/lib/socket";
import { ArrowLeft, MapPin, Navigation, Radio, RadioTower, Footprints, Car, Bike, PersonStanding, Zap, Clock, ShieldAlert, Info } from "lucide-react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import LocationMap from "@/components/location-map";

interface LiveShare {
  id: string;
  userId: string;
  active: boolean;
  expiresAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSpeed: number | null;
  lastHeading: number | null;
  lastActivity: string | null;
  lastUpdatedAt: string;
  userName?: string;
}

interface LocationPoint {
  id: string;
  lat: number;
  lng: number;
  speed: number | null;
  heading: number | null;
  activity: string | null;
  recordedAt: string;
}

function getActivityIcon(activity: string | null) {
  switch (activity) {
    case "walking": return <Footprints className="h-4 w-4" />;
    case "running": return <Zap className="h-4 w-4" />;
    case "cycling": return <Bike className="h-4 w-4" />;
    case "driving": return <Car className="h-4 w-4" />;
    default: return <PersonStanding className="h-4 w-4" />;
  }
}

function getActivityColor(activity: string | null): string {
  switch (activity) {
    case "walking": return "bg-green-500";
    case "running": return "bg-orange-500";
    case "cycling": return "bg-blue-500";
    case "driving": return "bg-purple-500";
    default: return "bg-gray-400";
  }
}

export default function LiveLocationPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [sharingActive, setSharingActive] = useState(() => {
    return localStorage.getItem("liveLocationActive") === "true" || isLiveTrackingActive();
  });
  const [currentActivity, setCurrentActivity] = useState<string>("stationary");
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);
  const [currentLat, setCurrentLat] = useState<number | null>(null);
  const [currentLng, setCurrentLng] = useState<number | null>(null);
  const [duration, setDuration] = useState<string>("0");
  const [watchedLocations, setWatchedLocations] = useState<Record<string, LiveShare>>({});
  const [locationDenied, setLocationDenied] = useState(false);

  const { data: myStatus } = useQuery<{ active: boolean; share: LiveShare | null }>({
    queryKey: ["/api/live-location/status"],
    refetchInterval: 10000,
  });

  const { data: watchedShares, refetch: refetchWatched } = useQuery<LiveShare[]>({
    queryKey: ["/api/live-location/watching"],
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (myStatus?.active) {
      setSharingActive(true);
      if (myStatus.share) {
        if (myStatus.share.lastLat != null && myStatus.share.lastLng != null) {
          setCurrentLat(myStatus.share.lastLat);
          setCurrentLng(myStatus.share.lastLng);
        }
        if (myStatus.share.lastActivity) {
          setCurrentActivity(myStatus.share.lastActivity);
        }
        if (myStatus.share.lastSpeed != null) {
          setCurrentSpeed(myStatus.share.lastSpeed);
        }
      }
      if (!isLiveTrackingActive()) {
        startLiveTracking();
      }
    } else if (myStatus && !myStatus.active) {
      setSharingActive(false);
      localStorage.removeItem("liveLocationActive");
    }
  }, [myStatus]);

  useEffect(() => {
    if (watchedShares) {
      const map: Record<string, LiveShare> = {};
      for (const s of watchedShares) map[s.userId] = s;
      setWatchedLocations(map);
    }
  }, [watchedShares]);

  useEffect(() => {
    if (!sharingActive) return;
    const unsubscribe = addLocationListener((data) => {
      setCurrentActivity(data.activity);
      setCurrentSpeed(data.speed);
      setCurrentLat(data.lat);
      setCurrentLng(data.lng);
    });
    return unsubscribe;
  }, [sharingActive]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleContactUpdate = (data: any) => {
      setWatchedLocations(prev => {
        const existing = prev[data.userId];
        if (!existing) return prev;
        return {
          ...prev,
          [data.userId]: {
            ...existing,
            lastLat: data.lat,
            lastLng: data.lng,
            lastSpeed: data.speed,
            lastHeading: data.heading,
            lastActivity: data.activity,
            lastUpdatedAt: data.timestamp || new Date().toISOString(),
          },
        };
      });
    };

    socket.on("live-location:contact-updated", handleContactUpdate);
    return () => { socket.off("live-location:contact-updated", handleContactUpdate); };
  }, []);

  const startMutation = useMutation({
    mutationFn: async () => {
      const permResult = await navigator.permissions?.query({ name: "geolocation" }).catch(() => null);
      if (permResult?.state === "denied") {
        setLocationDenied(true);
        throw new Error("Location permission denied");
      }

      const durationMinutes = duration === "0" ? null : parseInt(duration);
      return apiRequest("POST", "/api/live-location/start", { durationMinutes });
    },
    onSuccess: () => {
      setLocationDenied(false);
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });

      const started = startLiveTracking({
        onError: (err) => {
          if (err.toLowerCase().includes("denied") || err.toLowerCase().includes("permission")) {
            setLocationDenied(true);
            stopLiveTracking();
            setSharingActive(false);
            apiRequest("POST", "/api/live-location/stop").catch(() => {});
          } else {
            toast({ title: "Location error", description: err, variant: "destructive" });
          }
        },
        onExpired: () => {
          setSharingActive(false);
          toast({ title: "Live location expired", description: "Your sharing session has ended." });
        },
      });

      if (!started) {
        setLocationDenied(true);
      } else {
        setSharingActive(true);
        toast({ title: "Live location sharing started", description: "Your emergency contacts can now see your location in real time." });
      }
    },
    onError: (err: Error) => {
      if (err.message.includes("denied")) {
        setLocationDenied(true);
      }
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/live-location/stop"),
    onSuccess: () => {
      stopLiveTracking();
      setSharingActive(false);
      setCurrentActivity("stationary");
      setCurrentSpeed(null);
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/status"] });
      toast({ title: "Live location sharing stopped" });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-primary text-primary-foreground p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")} className="text-primary-foreground hover:bg-primary/80" data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Live Location</h1>
          <p className="text-xs opacity-80">Share your real-time location with contacts</p>
        </div>
      </div>

      <div className="p-4 space-y-4 max-w-lg mx-auto">
        {locationDenied && (
          <Card className="border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <ShieldAlert className="h-6 w-6 text-orange-600 shrink-0 mt-0.5" />
                <div className="space-y-3">
                  <div>
                    <p className="font-semibold text-orange-800 dark:text-orange-200">Location permission is blocked</p>
                    <p className="text-sm text-orange-700 dark:text-orange-300 mt-1">
                      StillHere needs access to your location to share it with your emergency contacts. Please follow the steps below to enable it.
                    </p>
                  </div>
                  <div className="space-y-2 text-sm">
                    <p className="font-medium text-orange-800 dark:text-orange-200 flex items-center gap-1">
                      <Info className="h-4 w-4" /> On iPhone (Safari):
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-orange-700 dark:text-orange-300 pl-1">
                      <li>Open your phone <b>Settings</b></li>
                      <li>Scroll down and tap <b>Safari</b> (or your browser)</li>
                      <li>Tap <b>Location</b> and select <b>Allow</b> or <b>Ask</b></li>
                      <li>Come back here and try again</li>
                    </ol>
                    <p className="font-medium text-orange-800 dark:text-orange-200 flex items-center gap-1 mt-2">
                      <Info className="h-4 w-4" /> On Android (Chrome):
                    </p>
                    <ol className="list-decimal list-inside space-y-1 text-orange-700 dark:text-orange-300 pl-1">
                      <li>Tap the <b>lock icon</b> in Chrome's address bar</li>
                      <li>Tap <b>Permissions</b> or <b>Site settings</b></li>
                      <li>Set <b>Location</b> to <b>Allow</b></li>
                      <li>Refresh the page and try again</li>
                    </ol>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-orange-300 text-orange-800 hover:bg-orange-100 dark:border-orange-600 dark:text-orange-200 dark:hover:bg-orange-900"
                    onClick={() => setLocationDenied(false)}
                    data-testid="button-dismiss-location-help"
                  >
                    I've updated my settings, try again
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <RadioTower className="h-5 w-5" />
              Share My Location
            </CardTitle>
            <CardDescription>
              When active, your emergency contacts can see where you are, how you are moving, and your travel path in real time.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sharingActive ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="relative">
                    <Radio className="h-6 w-6 text-green-600" />
                    <span className="absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full animate-ping" />
                    <span className="absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full" />
                  </div>
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-200">Location sharing is active</p>
                    <p className="text-sm text-green-600 dark:text-green-400">
                      Your contacts can see you right now
                    </p>
                  </div>
                </div>

                {currentLat != null && currentLng != null && (
                  <LocationMap
                    center={{ lat: currentLat, lng: currentLng }}
                    zoom={16}
                    className="w-full h-48"
                    showTrail={false}
                  />
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-muted text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      {getActivityIcon(currentActivity)}
                    </div>
                    <p className="text-sm font-medium" data-testid="text-current-activity">{formatActivity(currentActivity)}</p>
                    <p className="text-xs text-muted-foreground">Activity</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted text-center">
                    <Navigation className="h-4 w-4 mx-auto mb-1" />
                    <p className="text-sm font-medium" data-testid="text-current-speed">{formatSpeed(currentSpeed)}</p>
                    <p className="text-xs text-muted-foreground">Speed</p>
                  </div>
                </div>

                {myStatus?.share?.expiresAt && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>Expires {formatDistanceToNow(new Date(myStatus.share.expiresAt), { addSuffix: true })}</span>
                  </div>
                )}

                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => stopMutation.mutate()}
                  disabled={stopMutation.isPending}
                  data-testid="button-stop-sharing"
                >
                  Stop Sharing Location
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Duration</label>
                  <Select value={duration} onValueChange={setDuration}>
                    <SelectTrigger data-testid="select-duration">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Until I turn it off</SelectItem>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                      <SelectItem value="240">4 hours</SelectItem>
                      <SelectItem value="480">8 hours</SelectItem>
                      <SelectItem value="1440">24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  className="w-full"
                  onClick={() => startMutation.mutate()}
                  disabled={startMutation.isPending}
                  data-testid="button-start-sharing"
                >
                  <RadioTower className="h-4 w-4 mr-2" />
                  {startMutation.isPending ? "Starting..." : "Start Sharing My Location"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {Object.keys(watchedLocations).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <MapPin className="h-5 w-5" />
                Contacts Sharing Location
              </CardTitle>
              <CardDescription>People who are sharing their live location with you.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {Object.values(watchedLocations).map((share) => (
                <div
                  key={share.userId}
                  className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => navigate(`/live-location/${share.userId}`)}
                  data-testid={`card-live-contact-${share.userId}`}
                >
                  <div className="relative">
                    <div className={`h-10 w-10 rounded-full ${getActivityColor(share.lastActivity)} flex items-center justify-center text-white`}>
                      {getActivityIcon(share.lastActivity)}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-900" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{share.userName || "Contact"}</p>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>{formatActivity(share.lastActivity)}</span>
                      {share.lastSpeed != null && share.lastSpeed > 0.5 && (
                        <>
                          <span>-</span>
                          <span>{formatSpeed(share.lastSpeed)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>{formatDistanceToNow(new Date(share.lastUpdatedAt), { addSuffix: true })}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-sm text-muted-foreground space-y-2">
              <p className="font-medium">How it works</p>
              <ul className="text-left space-y-1">
                <li className="flex items-start gap-2">
                  <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Your GPS location is shared with your emergency contacts</span>
                </li>
                <li className="flex items-start gap-2">
                  <Navigation className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>We detect if you are stationary, walking, running, cycling, or driving</span>
                </li>
                <li className="flex items-start gap-2">
                  <Radio className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Updates are sent every 5 seconds when moving, every 30 seconds when stationary</span>
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
