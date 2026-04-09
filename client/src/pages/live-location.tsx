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
import { ArrowLeft, MapPin, Navigation, Radio, RadioTower, Footprints, Car, Bike, PersonStanding, Zap, Clock, ShieldAlert, Info, ExternalLink, ChevronUp, ChevronDown } from "lucide-react";
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
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [panelExpanded, setPanelExpanded] = useState(false);

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

  const allPeople = [];
  if (sharingActive && currentLat != null && currentLng != null) {
    allPeople.push({
      id: "me",
      name: "Me",
      lat: currentLat,
      lng: currentLng,
      activity: currentActivity,
      isMe: true,
    });
  }
  Object.values(watchedLocations).forEach(share => {
    if (share.lastLat != null && share.lastLng != null) {
      allPeople.push({
        id: share.userId,
        name: share.userName || "Contact",
        lat: share.lastLat,
        lng: share.lastLng,
        activity: share.lastActivity,
        isMe: false,
      });
    }
  });

  const mapCenter = allPeople.length > 0
    ? { lat: allPeople[0].lat, lng: allPeople[0].lng }
    : currentLat != null && currentLng != null
      ? { lat: currentLat, lng: currentLng }
      : { lat: -31.95, lng: 115.86 };

  const hasMap = allPeople.length > 0;
  const watchedPeopleList = Object.values(watchedLocations);

  const handlePersonTap = useCallback((personId: string) => {
    setSelectedPerson(personId);
    setPanelExpanded(true);
  }, []);

  const selectedShare = selectedPerson ? watchedLocations[selectedPerson] : null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-20 bg-primary text-primary-foreground p-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")} className="text-primary-foreground hover:bg-primary/80" data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Live Location</h1>
          <p className="text-xs opacity-80">
            {sharingActive ? "Sharing with contacts" : "Share your real-time location"}
          </p>
        </div>
        {sharingActive && (
          <div className="relative">
            <Radio className="h-5 w-5 text-green-300" />
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 bg-green-400 rounded-full animate-ping" />
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 bg-green-400 rounded-full" />
          </div>
        )}
      </div>

      {locationDenied && (
        <div className="p-4 pb-0">
          <Card className="border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="h-5 w-5 text-orange-600 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <p className="font-semibold text-orange-800 dark:text-orange-200 text-sm">Location permission is blocked</p>
                  <p className="text-xs text-orange-700 dark:text-orange-300">
                    Open your device Settings and allow location access for this browser, then try again.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-orange-300 text-orange-800 hover:bg-orange-100 dark:border-orange-600 dark:text-orange-200 dark:hover:bg-orange-900"
                    onClick={() => setLocationDenied(false)}
                    data-testid="button-dismiss-location-help"
                  >
                    Try again
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {hasMap ? (
        <div className="relative flex-1 min-h-[50vh]">
          <LocationMap
            center={mapCenter}
            people={allPeople}
            zoom={15}
            className="w-full h-full absolute inset-0"
            showTrail={false}
            onPersonTap={handlePersonTap}
          />

          {sharingActive && (
            <div className="absolute top-3 left-3 z-10">
              <div className="bg-green-500 text-white rounded-full px-3 py-1.5 flex items-center gap-2 shadow-lg text-xs font-medium" data-testid="badge-sharing-active">
                <span className="h-2 w-2 bg-white rounded-full animate-pulse" />
                Sharing ON
              </div>
            </div>
          )}

          <div className="absolute bottom-0 left-0 right-0 z-10">
            <div className="bg-background rounded-t-2xl shadow-[0_-4px_20px_rgba(0,0,0,0.1)] border-t">
              <button
                className="w-full pt-3 pb-2 flex justify-center"
                onClick={() => setPanelExpanded(!panelExpanded)}
                data-testid="button-toggle-panel"
              >
                <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
              </button>

              <div className="px-4 pb-3">
                <div className="flex items-center gap-2 mb-3">
                  {sharingActive && (
                    <div className="flex items-center gap-2 flex-1">
                      <div className={`h-8 w-8 rounded-full ${getActivityColor(currentActivity)} flex items-center justify-center text-white shrink-0`}>
                        {getActivityIcon(currentActivity)}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">You - {formatActivity(currentActivity)}</p>
                        <p className="text-xs text-muted-foreground">{formatSpeed(currentSpeed)}</p>
                      </div>
                    </div>
                  )}
                  {sharingActive ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => stopMutation.mutate()}
                      disabled={stopMutation.isPending}
                      data-testid="button-stop-sharing"
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => startMutation.mutate()}
                      disabled={startMutation.isPending}
                      data-testid="button-start-sharing"
                    >
                      <RadioTower className="h-4 w-4 mr-1" />
                      {startMutation.isPending ? "Starting..." : "Share My Location"}
                    </Button>
                  )}
                </div>

                {watchedPeopleList.length > 0 && (
                  <div className="space-y-2">
                    {watchedPeopleList.map((share) => (
                      <button
                        key={share.userId}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-lg border transition-colors text-left ${selectedPerson === share.userId ? "bg-primary/5 border-primary/30" : "hover:bg-muted/50"}`}
                        onClick={() => {
                          setSelectedPerson(share.userId === selectedPerson ? null : share.userId);
                          navigate(`/live-location/${share.userId}`);
                        }}
                        data-testid={`card-live-contact-${share.userId}`}
                      >
                        <div className="relative">
                          <div className={`h-9 w-9 rounded-full ${getActivityColor(share.lastActivity)} flex items-center justify-center text-white`}>
                            {getActivityIcon(share.lastActivity)}
                          </div>
                          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 bg-green-500 rounded-full border-2 border-white dark:border-gray-900" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{share.userName || "Contact"}</p>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span>{formatActivity(share.lastActivity)}</span>
                            {share.lastSpeed != null && share.lastSpeed > 0.5 && (
                              <span>- {formatSpeed(share.lastSpeed)}</span>
                            )}
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatDistanceToNow(new Date(share.lastUpdatedAt), { addSuffix: true })}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {panelExpanded && (
                <div className="px-4 pb-4 border-t pt-3 space-y-3">
                  {!sharingActive && (
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
                      <Button
                        className="w-full"
                        onClick={() => startMutation.mutate()}
                        disabled={startMutation.isPending}
                        data-testid="button-start-sharing-expanded"
                      >
                        <RadioTower className="h-4 w-4 mr-2" />
                        {startMutation.isPending ? "Starting..." : "Start Sharing My Location"}
                      </Button>
                    </div>
                  )}

                  {sharingActive && myStatus?.share?.expiresAt && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      <span>Expires {formatDistanceToNow(new Date(myStatus.share.expiresAt), { addSuffix: true })}</span>
                    </div>
                  )}

                  <div className="text-center text-xs text-muted-foreground space-y-1 pt-2">
                    <p className="font-medium">How it works</p>
                    <div className="flex items-center justify-center gap-4">
                      <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> GPS shared</span>
                      <span className="flex items-center gap-1"><Navigation className="h-3 w-3" /> Activity detected</span>
                      <span className="flex items-center gap-1"><Radio className="h-3 w-3" /> Real-time</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4 max-w-lg mx-auto flex-1">
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
            </CardContent>
          </Card>

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
      )}
    </div>
  );
}
