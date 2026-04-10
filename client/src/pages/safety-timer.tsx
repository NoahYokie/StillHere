import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Shield, Clock, MapPin, ChevronLeft, Plus, X } from "lucide-react";
import { useLocation } from "wouter";
import LocationMap from "@/components/location-map";
import type { SafetyTimer, TripPoint } from "@shared/schema";

const DURATION_PRESETS = [
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "2 hr", value: 120 },
  { label: "3 hr", value: 180 },
];

const EXTEND_OPTIONS = [
  { label: "+15 min", value: 15 },
  { label: "+30 min", value: 30 },
  { label: "+1 hr", value: 60 },
];

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getActivityFromSpeed(speedMps: number | null): string {
  if (!speedMps || speedMps < 0.5) return "stationary";
  if (speedMps < 2) return "walking";
  if (speedMps < 5) return "running";
  if (speedMps < 8) return "cycling";
  return "driving";
}

export default function SafetyTimerPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [note, setNote] = useState("");
  const [remaining, setRemaining] = useState(0);
  const watchIdRef = useRef<number | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: activeTimer, isLoading } = useQuery<SafetyTimer | null>({
    queryKey: ["/api/safety-timer/active"],
    refetchInterval: 5000,
  });

  const { data: trail } = useQuery<TripPoint[]>({
    queryKey: ["/api/safety-timer/trail"],
    enabled: !!activeTimer,
    refetchInterval: 10000,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const duration = showCustom ? parseInt(customDuration) : selectedDuration;
      return apiRequest("POST", "/api/safety-timer/start", { durationMinutes: duration, note: note || undefined });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/active"] });
      toast({ title: "Safety Timer started", description: "Your contacts will be alerted if you don't check back in time." });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not start timer.", variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety-timer/cancel"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/active"] });
      toast({ title: "You're safe!", description: "Timer cancelled. Your contacts will not be notified." });
    },
  });

  const extendMutation = useMutation({
    mutationFn: (mins: number) => apiRequest("POST", "/api/safety-timer/extend", { additionalMinutes: mins }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/active"] });
      toast({ title: "Timer extended" });
    },
  });

  const sendLocation = useCallback(async () => {
    if (!activeTimer) return;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      );
      const activity = getActivityFromSpeed(pos.coords.speed);
      await apiRequest("POST", "/api/safety-timer/location", {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speed: pos.coords.speed,
        activity,
      });
    } catch {}
  }, [activeTimer]);

  useEffect(() => {
    if (!activeTimer) return;

    sendLocation();
    locationIntervalRef.current = setInterval(sendLocation, 15000);

    return () => {
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
    };
  }, [activeTimer?.id, sendLocation]);

  useEffect(() => {
    if (!activeTimer) {
      setRemaining(0);
      return;
    }
    const update = () => {
      const diff = new Date(activeTimer.expiresAt).getTime() - Date.now();
      setRemaining(Math.max(0, diff));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeTimer?.expiresAt]);

  const progress = activeTimer
    ? Math.max(0, Math.min(1, remaining / (activeTimer.durationMinutes * 60 * 1000)))
    : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (activeTimer) {
    const trailPoints = (trail || []).map(p => ({ lat: p.lat, lng: p.lng, activity: p.activity, timestamp: p.recordedAt?.toString() }));
    const lastPoint = trailPoints.length > 0 ? trailPoints[trailPoints.length - 1] : null;
    const center = lastPoint
      ? { lat: lastPoint.lat, lng: lastPoint.lng }
      : activeTimer.lastLat && activeTimer.lastLng
        ? { lat: activeTimer.lastLat, lng: activeTimer.lastLng }
        : null;

    return (
      <div className="min-h-screen bg-primary pb-8">
        <header className="px-6 pt-6 pb-4 flex items-center gap-3">
          <Button variant="ghost" size="icon" className="text-primary-foreground" onClick={() => navigate("/")} data-testid="button-back">
            <ChevronLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-xl font-semibold text-primary-foreground" data-testid="text-title">Safety Timer Active</h1>
        </header>

        <div className="flex flex-col items-center px-6">
          <div className="relative w-56 h-56 mb-6">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="6" />
              <circle
                cx="50" cy="50" r="45" fill="none"
                stroke="white" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={`${progress * 283} 283`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-4xl font-bold text-primary-foreground font-mono" data-testid="text-countdown">
                {formatCountdown(remaining)}
              </span>
            </div>
          </div>

          {activeTimer.note && (
            <Card className="w-full max-w-sm mb-4">
              <CardContent className="py-3 px-4 text-center">
                <p className="text-sm font-medium" data-testid="text-note">{activeTimer.note}</p>
              </CardContent>
            </Card>
          )}

          {center && (
            <Card className="w-full max-w-sm mb-4">
              <CardContent className="p-2">
                <LocationMap
                  center={center}
                  points={trailPoints}
                  zoom={15}
                  className="w-full h-40"
                  markerLabel="You"
                  showTrail={true}
                />
                <p className="text-xs text-muted-foreground text-center mt-2">Tracking your location</p>
              </CardContent>
            </Card>
          )}

          <div className="w-full max-w-sm space-y-3 mt-2">
            <Button
              size="lg"
              className="w-full bg-green-500 hover:bg-green-600 text-white text-lg"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="button-im-safe"
            >
              <Shield className="h-5 w-5 mr-2" />
              I'm Safe
            </Button>

            <div className="flex gap-2">
              {EXTEND_OPTIONS.map(opt => (
                <Button
                  key={opt.value}
                  variant="secondary"
                  className="flex-1"
                  onClick={() => extendMutation.mutate(opt.value)}
                  disabled={extendMutation.isPending}
                  data-testid={`button-extend-${opt.value}`}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isValid = showCustom ? parseInt(customDuration) >= 5 && parseInt(customDuration) <= 1440 : true;

  return (
    <div className="min-h-screen bg-background pb-8">
      <header className="bg-primary text-primary-foreground px-6 py-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="text-primary-foreground" onClick={() => navigate("/")} data-testid="button-back">
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold" data-testid="text-title">Safety Timer</h1>
          <p className="text-sm opacity-90">Set a countdown before doing something</p>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        <div className="flex flex-col items-center">
          <div className="relative w-48 h-48 mb-6">
            <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
              <circle cx="50" cy="50" r="45" fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
              <circle
                cx="50" cy="50" r="45" fill="none"
                stroke="hsl(var(--primary))" strokeWidth="6" strokeLinecap="round"
                strokeDasharray="283 283"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-3xl font-bold font-mono text-foreground" data-testid="text-duration-display">
                {formatCountdown((showCustom ? (parseInt(customDuration) || 0) : selectedDuration) * 60 * 1000)}
              </span>
            </div>
          </div>
        </div>

        <Card>
          <CardContent className="pt-4 space-y-4">
            <Input
              placeholder="Add a note... (e.g. Hiking at Blue Ridge Trail)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="input-note"
            />

            <div>
              <p className="text-sm font-medium mb-2">Duration</p>
              <div className="flex gap-2 flex-wrap">
                {DURATION_PRESETS.map(p => (
                  <Button
                    key={p.value}
                    variant={!showCustom && selectedDuration === p.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => { setShowCustom(false); setSelectedDuration(p.value); }}
                    data-testid={`button-duration-${p.value}`}
                  >
                    {p.label}
                  </Button>
                ))}
                <Button
                  variant={showCustom ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowCustom(true)}
                  data-testid="button-duration-custom"
                >
                  Custom
                </Button>
              </div>

              {showCustom && (
                <div className="flex items-center gap-2 mt-3">
                  <Input
                    type="number"
                    placeholder="Minutes"
                    value={customDuration}
                    onChange={(e) => setCustomDuration(e.target.value)}
                    min={5}
                    max={1440}
                    className="w-32"
                    data-testid="input-custom-duration"
                  />
                  <span className="text-sm text-muted-foreground">minutes (5–1440)</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Button
          size="lg"
          className="w-full bg-green-500 hover:bg-green-600 text-white text-lg"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || !isValid}
          data-testid="button-start-timer"
        >
          <Clock className="h-5 w-5 mr-2" />
          Start Timer
        </Button>

        <p className="text-xs text-muted-foreground text-center">
          Your contacts will be alerted if you don't check back in time
        </p>
      </main>
    </div>
  );
}
