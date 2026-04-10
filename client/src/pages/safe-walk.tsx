import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Navigation, MapPin, ChevronLeft, Home, Briefcase, Search, CheckCircle2, Clock } from "lucide-react";
import { useLocation } from "wouter";
import LocationMap from "@/components/location-map";
import type { SafeWalk, TripPoint, Geofence } from "@shared/schema";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalMinutes = Math.ceil(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getActivityFromSpeed(speedMps: number | null): string {
  if (!speedMps || speedMps < 0.5) return "stationary";
  if (speedMps < 2) return "walking";
  if (speedMps < 5) return "running";
  if (speedMps < 8) return "cycling";
  return "driving";
}

function getDistanceKm(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = (to.lat - from.lat) * Math.PI / 180;
  const dLng = (to.lng - from.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateTravelMinutes(distanceKm: number): { walk: number; bike: number; drive: number } {
  const speeds = { walk: 5, bike: 15, drive: 40 };
  const calc = (s: number) => Math.max(5, Math.ceil((distanceKm / s) * 60 * 1.2));
  return { walk: calc(speeds.walk), bike: calc(speeds.bike), drive: calc(speeds.drive) };
}

function pickSafestEstimate(estimates: { walk: number; bike: number; drive: number }): number {
  return estimates.walk;
}

const EXTEND_OPTIONS = [
  { label: "+15 min", value: 15 },
  { label: "+30 min", value: 30 },
  { label: "+1 hr", value: 60 },
];

export default function SafeWalkPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [destinationType, setDestinationType] = useState<"saved" | "address" | "pin">("saved");
  const [selectedGeofence, setSelectedGeofence] = useState<Geofence | null>(null);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressResults, setAddressResults] = useState<{ name: string; lat: number; lng: number }[]>([]);
  const [destinationName, setDestinationName] = useState("");
  const [destinationCoords, setDestinationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [expectedMinutes, setExpectedMinutes] = useState(30);
  const [estimates, setEstimates] = useState<{ walk: number; bike: number; drive: number } | null>(null);
  const [note, setNote] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lng: number } | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: activeWalk, isLoading } = useQuery<SafeWalk | null>({
    queryKey: ["/api/safe-walk/active"],
    refetchInterval: 5000,
  });

  const { data: trail } = useQuery<TripPoint[]>({
    queryKey: ["/api/safe-walk/trail"],
    enabled: !!activeWalk,
    refetchInterval: 10000,
  });

  const { data: geofences } = useQuery<Geofence[]>({
    queryKey: ["/api/geofences"],
  });

  useEffect(() => {
    if (currentPos && destinationCoords) {
      const dist = getDistanceKm(currentPos, destinationCoords);
      const est = estimateTravelMinutes(dist);
      setEstimates(est);
      setExpectedMinutes(pickSafestEstimate(est));
    }
  }, [currentPos, destinationCoords]);

  useEffect(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => setCurrentPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true }
    );
  }, []);

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!destinationCoords) throw new Error("No destination");
      return apiRequest("POST", "/api/safe-walk/start", {
        destinationLat: destinationCoords.lat,
        destinationLng: destinationCoords.lng,
        destinationName: destinationName || undefined,
        destinationType,
        expectedMinutes,
        note: note || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safe-walk/active"] });
      toast({ title: "Safe Walk started", description: "We'll watch until you arrive safely." });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not start Safe Walk.", variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safe-walk/cancel"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safe-walk/active"] });
      toast({ title: "Safe Walk cancelled" });
    },
  });

  const arrivedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safe-walk/arrived"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safe-walk/active"] });
      toast({ title: "You've arrived safely!" });
    },
  });

  const extendMutation = useMutation({
    mutationFn: (mins: number) => apiRequest("POST", "/api/safe-walk/extend", { additionalMinutes: mins }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safe-walk/active"] });
      toast({ title: "Time extended" });
    },
  });

  const sendLocation = useCallback(async () => {
    if (!activeWalk) return;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      );
      const activity = getActivityFromSpeed(pos.coords.speed);
      const res = await apiRequest("POST", "/api/safe-walk/location", {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speed: pos.coords.speed,
        activity,
      });
      const data = await res.json();
      if (data.arrived) {
        queryClient.invalidateQueries({ queryKey: ["/api/safe-walk/active"] });
        toast({ title: "You've arrived safely!", description: "Safe Walk ended automatically." });
      }
      setCurrentPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {}
  }, [activeWalk, toast]);

  useEffect(() => {
    if (!activeWalk) return;
    sendLocation();
    locationIntervalRef.current = setInterval(sendLocation, 15000);
    return () => {
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
    };
  }, [activeWalk?.id, sendLocation]);

  useEffect(() => {
    if (!activeWalk) { setRemaining(0); return; }
    const update = () => {
      const diff = new Date(activeWalk.expectedArrivalAt).getTime() - Date.now();
      setRemaining(Math.max(0, diff));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeWalk?.expectedArrivalAt]);

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 3) { setAddressResults([]); return; }
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
      const data = await res.json();
      setAddressResults(data.map((r: any) => ({
        name: r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
      })));
    } catch {
      setAddressResults([]);
    }
  }, []);

  const handleAddressInput = (value: string) => {
    setAddressQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => searchAddress(value), 500);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (activeWalk) {
    const trailPoints = (trail || []).map(p => ({ lat: p.lat, lng: p.lng, activity: p.activity, timestamp: p.recordedAt?.toString() }));
    const destPoint = { lat: activeWalk.destinationLat, lng: activeWalk.destinationLng };
    const center = currentPos || (activeWalk.lastLat && activeWalk.lastLng ? { lat: activeWalk.lastLat, lng: activeWalk.lastLng } : destPoint);
    const isOverdue = remaining <= 0;

    return (
      <div className="min-h-screen bg-background pb-8">
        <header className={`${isOverdue ? "bg-destructive" : "bg-primary"} text-primary-foreground px-6 py-4 flex items-center gap-3`}>
          <Button variant="ghost" size="icon" className="text-primary-foreground" onClick={() => navigate("/")} data-testid="button-back">
            <ChevronLeft className="h-6 w-6" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-title">
              {isOverdue ? "Running Late" : "Safe Walk Active"}
            </h1>
            <p className="text-sm opacity-90">
              {activeWalk.destinationName || "Destination"} — {formatCountdown(remaining)} {isOverdue ? "overdue" : "remaining"}
            </p>
          </div>
        </header>

        <main className="max-w-md mx-auto px-6 py-4 space-y-4">
          <Card>
            <CardContent className="p-2">
              <LocationMap
                center={center}
                points={trailPoints}
                zoom={14}
                className="w-full h-52"
                showTrail={true}
              />
            </CardContent>
          </Card>

          {activeWalk.note && (
            <Card>
              <CardContent className="py-3 px-4">
                <p className="text-sm text-muted-foreground" data-testid="text-note">{activeWalk.note}</p>
              </CardContent>
            </Card>
          )}

          <div className="space-y-3">
            <Button
              size="lg"
              className="w-full bg-green-500 hover:bg-green-600 text-white text-lg"
              onClick={() => arrivedMutation.mutate()}
              disabled={arrivedMutation.isPending}
              data-testid="button-arrived"
            >
              <CheckCircle2 className="h-5 w-5 mr-2" />
              I've Arrived
            </Button>

            <div className="flex gap-2">
              {EXTEND_OPTIONS.map(opt => (
                <Button
                  key={opt.value}
                  variant="outline"
                  className="flex-1"
                  onClick={() => extendMutation.mutate(opt.value)}
                  disabled={extendMutation.isPending}
                  data-testid={`button-extend-${opt.value}`}
                >
                  {opt.label}
                </Button>
              ))}
            </div>

            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="button-cancel-walk"
            >
              Cancel Safe Walk
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const geofenceIcon = (type: string) => {
    if (type === "home") return <Home className="h-4 w-4" />;
    if (type === "work") return <Briefcase className="h-4 w-4" />;
    return <MapPin className="h-4 w-4" />;
  };

  return (
    <div className="min-h-screen bg-background pb-8">
      <header className="bg-primary text-primary-foreground px-6 py-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="text-primary-foreground" onClick={() => navigate("/")} data-testid="button-back">
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold" data-testid="text-title">Safe Walk</h1>
          <p className="text-sm opacity-90">We'll watch until you arrive safely</p>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-4">
        {geofences && geofences.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Saved Places
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-2">
                {geofences.map(g => (
                  <Button
                    key={g.id}
                    variant={selectedGeofence?.id === g.id ? "default" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      setSelectedGeofence(g);
                      setDestinationCoords({ lat: g.lat, lng: g.lng });
                      setDestinationName(g.name);
                      setDestinationType("saved");
                    }}
                    data-testid={`button-geofence-${g.id}`}
                  >
                    {geofenceIcon(g.type)}
                    {g.name}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="h-4 w-4" />
              Type an Address
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Input
              placeholder="Search address..."
              value={addressQuery}
              onChange={(e) => handleAddressInput(e.target.value)}
              data-testid="input-address"
            />
            {addressResults.length > 0 && (
              <div className="mt-2 border rounded-lg divide-y max-h-40 overflow-y-auto">
                {addressResults.map((r, i) => (
                  <button
                    key={i}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                    onClick={() => {
                      setDestinationCoords({ lat: r.lat, lng: r.lng });
                      setDestinationName(r.name.split(",")[0]);
                      setAddressQuery(r.name);
                      setAddressResults([]);
                      setSelectedGeofence(null);
                      setDestinationType("address");
                    }}
                    data-testid={`button-address-result-${i}`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {currentPos && destinationCoords && (
          <Card>
            <CardContent className="p-2">
              <LocationMap
                center={currentPos}
                zoom={13}
                className="w-full h-36"
                markerLabel="You"
              />
            </CardContent>
          </Card>
        )}

        {destinationCoords && (
          <Card>
            <CardContent className="pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Destination</span>
                <span className="text-sm text-muted-foreground truncate ml-2 max-w-[200px]">{destinationName || "Selected"}</span>
              </div>

              {currentPos && (
                <p className="text-xs text-muted-foreground">
                  {getDistanceKm(currentPos, destinationCoords).toFixed(1)} km away
                </p>
              )}

              {estimates && (
                <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Estimated travel time</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs">Walking</p>
                      <p className="font-semibold" data-testid="text-est-walk">~{estimates.walk} min</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Cycling</p>
                      <p className="font-semibold" data-testid="text-est-bike">~{estimates.bike} min</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Driving</p>
                      <p className="font-semibold" data-testid="text-est-drive">~{estimates.drive} min</p>
                    </div>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground text-center">
                We'll use the walking estimate to be safe. Once you start moving, the app detects if you're driving or cycling and adjusts automatically.
              </p>

              <Input
                placeholder="Add a note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="input-note"
              />
            </CardContent>
          </Card>
        )}

        <Button
          size="lg"
          className="w-full text-lg"
          onClick={() => startMutation.mutate()}
          disabled={!destinationCoords || startMutation.isPending}
          data-testid="button-start-walk"
        >
          <Navigation className="h-5 w-5 mr-2" />
          Start Safe Walk
        </Button>
      </main>
    </div>
  );
}
