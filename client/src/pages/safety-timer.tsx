import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BACKGROUND_LOCATION_UNLICENSED_MESSAGE, getOneShotPosition } from "@/lib/location-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Shield, Clock, MapPin, Plus, X } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useLocation } from "wouter";
import GoogleMap from "@/components/google-map";
import { useBackgroundLocationEscalation } from "@/components/background-location-provider";
import { locationFreshnessLabel } from "@/lib/location-freshness";
import type { SafetyTimer, TripPoint } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

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
  const escalation = useBackgroundLocationEscalation();
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [note, setNote] = useState("");
  const [remaining, setRemaining] = useState(0);
  const watchIdRef = useRef<number | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: activeTimer, isLoading } = useQuery<SafetyTimer | null>({
    queryKey: ["/api/safety-timer/current"],
    refetchInterval: 5000,
  });

  const timerIsRunning = !!activeTimer && ["active", "grace_period"].includes(activeTimer.status);
  const timerIsEscalated = activeTimer?.status === "escalated";
  const timerNeedsAttention = timerIsRunning || timerIsEscalated;

  const { data: trail } = useQuery<TripPoint[]>({
    queryKey: ["/api/safety-timer/trail"],
    enabled: timerNeedsAttention,
    refetchInterval: timerIsRunning ? 10000 : false,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const duration = showCustom ? parseInt(customDuration) : selectedDuration;
      // Phase 1.2: Safety Timer NEVER blocks. We ask for Always so the
      // countdown can post location updates if the screen locks, but if the
      // user only grants WhenInUse (or declines) we still start the timer
      // and post a persistent warning that location updates may be paused.
      const outcome = await escalation.requestAlwaysForFeature("safety_timer");
      if (!outcome.granted) {
        escalation.setActiveWarning({
          feature: "safety_timer",
          message: outcome.unlicensed
            ? BACKGROUND_LOCATION_UNLICENSED_MESSAGE
            : "Safety Timer is running, but background location is limited. Your last known location will be used if the timer runs out.",
        });
      } else {
        escalation.setActiveWarning(null);
      }
      return apiRequest("POST", "/api/safety-timer/start", { durationMinutes: duration, note: note || undefined });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/current"] });
      toast({ title: "Safety Timer started", description: "Your contacts will be alerted if you don't check back in time." });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not start timer.", variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/safety-timer/cancel"),
    onSuccess: () => {
      escalation.setActiveWarning(null);
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/current"] });
      toast({ title: "You're safe!", description: "Timer cancelled. Your contacts will not be notified." });
    },
  });

  const extendMutation = useMutation({
    mutationFn: (mins: number) => apiRequest("POST", "/api/safety-timer/extend", { additionalMinutes: mins }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/safety-timer/current"] });
      toast({ title: "Timer extended", description: "The server expiry time was updated." });
    },
  });

  const sendLocation = useCallback(async () => {
    if (!timerIsRunning) return;
    try {
      const pos = await getOneShotPosition();
      if (!pos) return;
      const activity = getActivityFromSpeed(pos.speed);
      await apiRequest("POST", "/api/safety-timer/location", {
        lat: pos.lat,
        lng: pos.lng,
        speed: pos.speed,
        activity,
      });
    } catch {}
  }, [timerIsRunning]);

  useEffect(() => {
    if (!timerIsRunning) return;

    sendLocation();
    locationIntervalRef.current = setInterval(sendLocation, 15000);

    return () => {
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
    };
  }, [activeTimer?.id, timerIsRunning, sendLocation]);

  useEffect(() => {
    if (!timerIsRunning || !activeTimer) {
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
  }, [activeTimer?.expiresAt, timerIsRunning]);

  const progress = activeTimer && timerIsRunning
    ? Math.max(0, Math.min(1, remaining / (activeTimer.durationMinutes * 60 * 1000)))
    : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (activeTimer && timerNeedsAttention) {
    const trailPoints = (trail || []).map(p => ({ lat: p.lat, lng: p.lng, activity: p.activity, timestamp: p.recordedAt?.toString() }));
    const lastPoint = trailPoints.length > 0 ? trailPoints[trailPoints.length - 1] : null;
    const center = lastPoint
      ? { lat: lastPoint.lat, lng: lastPoint.lng }
      : activeTimer.lastLat && activeTimer.lastLng
        ? { lat: activeTimer.lastLat, lng: activeTimer.lastLng }
        : null;
    const locationTimestamp = lastPoint?.timestamp || activeTimer.lastLocationAt || null;
    const locationLabel = locationTimestamp
      ? timerIsRunning
        ? locationFreshnessLabel(locationTimestamp, true)
        : `Last updated ${formatDistanceToNow(new Date(locationTimestamp), { addSuffix: true })}`
      : "No location update yet";
    const headerTitle = timerIsEscalated ? "Safety Timer Expired" : "Safety Timer Active";
    const statusText = timerIsEscalated
      ? "Emergency contacts have been notified."
      : "Backend timer is active. You can confirm safe or extend before it expires.";

    return (
      <div className={`min-h-screen ${timerIsEscalated ? "bg-destructive" : "bg-primary"} pb-8`}>
        <header className="px-6 pt-6 pb-4 flex items-center gap-3">
          <BackButton onClick={() => navigate("/")} tone="onPrimary" />
          <div>
            <h1 className="text-xl font-semibold text-primary-foreground" data-testid="text-title">{headerTitle}</h1>
            <p className="text-sm text-primary-foreground/90">{statusText}</p>
          </div>
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
                <GoogleMap
                  center={center}
                  points={trailPoints}
                  zoom={15}
                  className="w-full h-40"
                  markerLabel="You"
                  showTrail={true}
                />
                <p className="text-xs text-muted-foreground text-center mt-2">{locationLabel}</p>
              </CardContent>
            </Card>
          )}

          <div className="w-full max-w-sm space-y-3 mt-2">
            {timerIsRunning ? (
              <>
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
              </>
            ) : (
              <Button
                size="lg"
                className="w-full bg-background text-foreground hover:bg-background/90"
                onClick={() => navigate("/")}
                data-testid="button-timer-escalated-home"
              >
                Back to Home
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isValid = showCustom ? parseInt(customDuration) >= 5 && parseInt(customDuration) <= 1440 : true;
  const lastStatusText = activeTimer?.status === "safe"
    ? "Last timer was cancelled safely."
    : activeTimer?.status === "cancelled"
      ? "Last timer was cancelled."
      : null;

  return (
    <div className="min-h-screen bg-background pb-8">
      <header className="bg-primary text-primary-foreground px-6 py-4 flex items-center gap-3">
        <BackButton onClick={() => navigate("/")} tone="onPrimary" />
        <div>
          <h1 className="text-xl font-semibold" data-testid="text-title">Safety Timer</h1>
          <p className="text-sm opacity-90">Set a countdown before doing something</p>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        {lastStatusText && (
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-sm font-medium">{lastStatusText}</p>
            </CardContent>
          </Card>
        )}

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
