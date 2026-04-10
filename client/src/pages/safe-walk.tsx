import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Navigation, MapPin, ChevronLeft, Home, Briefcase, Search, CheckCircle2, Clock, Footprints, Bike, Bus, Car } from "lucide-react";
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

async function fetchRouteEstimate(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  profile: "foot" | "bike" | "car"
): Promise<{ durationMin: number; distanceKm: number } | null> {
  try {
    const osrmProfile = profile === "foot" ? "foot" : profile === "bike" ? "bicycle" : "car";
    const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) return null;
    const route = data.routes[0];
    return {
      durationMin: Math.ceil(route.duration / 60),
      distanceKm: Math.round(route.distance / 100) / 10,
    };
  } catch {
    return null;
  }
}

type TravelMode = "walk" | "bike" | "transit" | "drive";

interface TravelEstimates {
  walk: { min: number; km: number };
  bike: { min: number; km: number };
  transit: { min: number; km: number };
  drive: { min: number; km: number };
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
  const [addressResults, setAddressResults] = useState<{ name: string; subtitle?: string; type?: string; lat: number; lng: number; distance?: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [destinationName, setDestinationName] = useState("");
  const [destinationCoords, setDestinationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [expectedMinutes, setExpectedMinutes] = useState(30);
  const [estimates, setEstimates] = useState<TravelEstimates | null>(null);
  const [estimatesLoading, setEstimatesLoading] = useState(false);
  const [selectedMode, setSelectedMode] = useState<TravelMode>("walk");
  const [note, setNote] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lng: number } | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchIdRef = useRef(0);

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
    if (!destinationCoords) return;
    let cancelled = false;
    setEstimatesLoading(true);

    (async () => {
      if (currentPos) {
        const [walk, bike, drive] = await Promise.all([
          fetchRouteEstimate(currentPos, destinationCoords, "foot"),
          fetchRouteEstimate(currentPos, destinationCoords, "bike"),
          fetchRouteEstimate(currentPos, destinationCoords, "car"),
        ]);

        if (cancelled) return;

        const straightLine = getDistanceKm(currentPos, destinationCoords);
        const fallback = (speedKmh: number) => Math.max(5, Math.ceil((straightLine / speedKmh) * 60 * 1.2));

        if (walk || bike || drive) {
          const driveEst = drive ? { min: drive.durationMin, km: drive.distanceKm } : { min: fallback(40), km: Math.round(straightLine * 12) / 10 };
          const transitMin = Math.max(5, Math.ceil(driveEst.min * 1.5));
          const est: TravelEstimates = {
            walk: walk ? { min: walk.durationMin, km: walk.distanceKm } : { min: fallback(5), km: Math.round(straightLine * 13) / 10 },
            bike: bike ? { min: bike.durationMin, km: bike.distanceKm } : { min: fallback(15), km: Math.round(straightLine * 12) / 10 },
            transit: { min: transitMin, km: driveEst.km },
            drive: driveEst,
          };
          setEstimates(est);
          setSelectedMode("walk");
          setExpectedMinutes(Math.max(5, est.walk.min));
        } else {
          const fallbackEst = (s: number) => Math.max(5, Math.ceil((straightLine / s) * 60 * 1.2));
          const driveMin = fallbackEst(40);
          const est: TravelEstimates = {
            walk: { min: fallbackEst(5), km: Math.round(straightLine * 13) / 10 },
            bike: { min: fallbackEst(15), km: Math.round(straightLine * 12) / 10 },
            transit: { min: Math.max(5, Math.ceil(driveMin * 1.5)), km: Math.round(straightLine * 12) / 10 },
            drive: { min: driveMin, km: Math.round(straightLine * 12) / 10 },
          };
          setEstimates(est);
          setSelectedMode("walk");
          setExpectedMinutes(fallbackEst(5));
        }
      } else {
        if (cancelled) return;
        setEstimates({
          walk: { min: 30, km: 0 },
          bike: { min: 15, km: 0 },
          transit: { min: 20, km: 0 },
          drive: { min: 10, km: 0 },
        });
        setSelectedMode("walk");
        setExpectedMinutes(30);
      }
      setEstimatesLoading(false);
    })();

    return () => { cancelled = true; };
  }, [currentPos?.lat, currentPos?.lng, destinationCoords?.lat, destinationCoords?.lng]);

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

  const haversineKm = useCallback((lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, []);

  const formatDistance = useCallback((km: number) => {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }, []);

  const cleanPlaceName = useCallback((r: any) => {
    const parts = (r.display_name || "").split(",").map((s: string) => s.trim());
    const name = r.namedetails?.name || parts[0] || "";
    const type = r.type?.replace(/_/g, " ") || "";
    const city = r.address?.city || r.address?.town || r.address?.village || r.address?.suburb || parts[1] || "";
    const area = r.address?.state || r.address?.county || parts[2] || "";
    const country = r.address?.country || "";
    let subtitle = [city, area].filter(Boolean).join(", ");
    if (country && !subtitle.includes(country)) subtitle = subtitle ? `${subtitle}, ${country}` : country;
    return { name, subtitle, type };
  }, []);

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 2) { setAddressResults([]); setSearching(false); return; }
    const thisSearchId = ++searchIdRef.current;
    setSearching(true);
    try {
      const base = "https://nominatim.openstreetmap.org/search";
      const common = `format=json&q=${encodeURIComponent(query)}&limit=10&addressdetails=1&namedetails=1`;
      const lang = navigator.language || "en";
      let results: any[] = [];

      if (currentPos) {
        const nearDeg = 0.25;
        const nearUrl = `${base}?${common}&viewbox=${currentPos.lng - nearDeg},${currentPos.lat + nearDeg},${currentPos.lng + nearDeg},${currentPos.lat - nearDeg}&bounded=1`;
        const nearRes = await fetch(nearUrl, { headers: { "Accept-Language": lang } });
        results = await nearRes.json();

        if (results.length < 3) {
          const wideDeg = 1.0;
          const wideUrl = `${base}?${common}&viewbox=${currentPos.lng - wideDeg},${currentPos.lat + wideDeg},${currentPos.lng + wideDeg},${currentPos.lat - wideDeg}&bounded=0`;
          const wideRes = await fetch(wideUrl, { headers: { "Accept-Language": lang } });
          const wideData = await wideRes.json();
          const existingIds = new Set(results.map((r: any) => r.place_id));
          for (const r of wideData) {
            if (!existingIds.has(r.place_id)) results.push(r);
          }
        }
      } else {
        const res = await fetch(`${base}?${common}`, { headers: { "Accept-Language": lang } });
        results = await res.json();
      }

      const sorted = currentPos
        ? [...results].sort((a: any, b: any) => {
            const distA = haversineKm(currentPos.lat, currentPos.lng, parseFloat(a.lat), parseFloat(a.lon));
            const distB = haversineKm(currentPos.lat, currentPos.lng, parseFloat(b.lat), parseFloat(b.lon));
            return distA - distB;
          })
        : results;

      if (thisSearchId !== searchIdRef.current) return;
      setAddressResults(sorted.slice(0, 6).map((r: any) => {
        const { name, subtitle, type } = cleanPlaceName(r);
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lon);
        const dist = currentPos ? haversineKm(currentPos.lat, currentPos.lng, lat, lng) : null;
        return { name, subtitle, type, lat, lng, distance: dist !== null ? formatDistance(dist) : null };
      }));
    } catch {
      if (thisSearchId !== searchIdRef.current) return;
      setAddressResults([]);
    } finally {
      if (thisSearchId === searchIdRef.current) setSearching(false);
    }
  }, [currentPos, haversineKm, formatDistance, cleanPlaceName]);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const handleAddressInput = (value: string) => {
    setAddressQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (value.length < 2) { setAddressResults([]); setSearching(false); return; }
    searchTimeoutRef.current = setTimeout(() => searchAddress(value), 300);
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
            <div className="relative">
              <Input
                placeholder="Where to?"
                value={addressQuery}
                onChange={(e) => handleAddressInput(e.target.value)}
                className="pr-8"
                data-testid="input-address"
              />
              {searching && (
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            {addressResults.length > 0 && (
              <div className="mt-1.5 border rounded-xl divide-y max-h-60 overflow-y-auto bg-background shadow-lg">
                {addressResults.map((r, i) => (
                  <button
                    key={i}
                    className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition-colors flex items-start gap-2.5"
                    onClick={() => {
                      setDestinationCoords({ lat: r.lat, lng: r.lng });
                      setDestinationName(r.name);
                      setAddressQuery(r.name);
                      setAddressResults([]);
                      setSelectedGeofence(null);
                      setDestinationType("address");
                    }}
                    data-testid={`button-address-result-${i}`}
                  >
                    <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{r.name}</p>
                      {r.subtitle && <p className="text-xs text-muted-foreground truncate">{r.subtitle}</p>}
                    </div>
                    {r.distance && <span className="text-xs text-muted-foreground whitespace-nowrap mt-0.5">{r.distance}</span>}
                  </button>
                ))}
              </div>
            )}
            {addressQuery.length >= 2 && !searching && addressResults.length === 0 && !destinationCoords && (
              <p className="text-xs text-muted-foreground mt-1.5 text-center">No results found</p>
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
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{destinationName || "Selected destination"}</span>
              </div>

              {estimatesLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  Calculating routes...
                </div>
              )}

              {estimates && !estimatesLoading && (
                <>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { mode: "walk" as TravelMode, icon: Footprints, label: "Walk", est: estimates.walk },
                      { mode: "bike" as TravelMode, icon: Bike, label: "Bike", est: estimates.bike },
                      { mode: "transit" as TravelMode, icon: Bus, label: "Bus", est: estimates.transit },
                      { mode: "drive" as TravelMode, icon: Car, label: "Drive", est: estimates.drive },
                    ]).map(({ mode, icon: Icon, label, est }) => (
                      <button
                        key={mode}
                        onClick={() => {
                          setSelectedMode(mode);
                          setExpectedMinutes(Math.max(5, est.min));
                        }}
                        className={`flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl transition-all duration-150 active:scale-95 ${
                          selectedMode === mode
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted"
                        }`}
                        data-testid={`button-mode-${mode}`}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-xs font-semibold">{est.min} min</span>
                        <span className="text-[10px] opacity-75">{est.km} km</span>
                      </button>
                    ))}
                  </div>

                  <div className="bg-muted/40 rounded-lg px-3 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Expected travel time</span>
                    <span className="text-sm font-semibold" data-testid="text-expected-minutes">{expectedMinutes} min</span>
                  </div>

                  <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                    Select how you're travelling. Once moving, we detect your speed and adjust automatically.
                  </p>
                </>
              )}

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
