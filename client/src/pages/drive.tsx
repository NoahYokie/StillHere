import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ArrowLeft, Car, Gauge, MapPin, Clock, AlertTriangle, History, Play, Square, Shield, Navigation, Zap, BarChart3 } from "lucide-react";
import { useLocation } from "wouter";
import { drivingMonitor } from "@/lib/driving-monitor";
import CrashCountdown from "@/components/crash-countdown";
import GoogleMap from "@/components/google-map";
import type { DriveSession, SpeedAlert, TripPoint, UserStatus } from "@shared/schema";
import { format, formatDistanceToNow } from "date-fns";

const triggerHaptic = (pattern: number | number[] = 50) => {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSessionDuration(start: string, end: string | null) {
  if (!end) return "In progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

export default function DrivePage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [driveActive, setDriveActive] = useState(false);
  const [driveStarting, setDriveStarting] = useState(false);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [speedLimit, setSpeedLimit] = useState(120);
  const [crashDetected, setCrashDetected] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [currentPosition, setCurrentPosition] = useState<{ lat: number; lng: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const driveStartTimeRef = useRef<number>(0);
  const [showHistory, setShowHistory] = useState(false);

  const { data: status } = useQuery<UserStatus>({ queryKey: ["/api/status"] });
  const drivingSafetyEnabled = !!(status?.settings as any)?.drivingSafety;
  const configuredSpeedLimit = (status?.settings as any)?.speedLimitKmh || 120;

  const { data: activeSession } = useQuery<{ session: DriveSession | null }>({
    queryKey: ["/api/drive/active"],
    refetchInterval: driveActive ? 10000 : false,
  });

  const sessionId = activeSession?.session?.id;

  const { data: trailPoints = [], refetch: refetchTrail } = useQuery<TripPoint[]>({
    queryKey: ["/api/drive/trail", sessionId],
    queryFn: async () => {
      if (!sessionId) return [];
      const res = await fetch(`/api/drive/trail/${sessionId}`);
      return res.json();
    },
    enabled: !!sessionId && driveActive,
    refetchInterval: driveActive ? 15000 : false,
  });

  const { data: sessions = [] } = useQuery<DriveSession[]>({
    queryKey: ["/api/drive/history"],
    enabled: showHistory,
  });

  const { data: alerts = [] } = useQuery<SpeedAlert[]>({
    queryKey: ["/api/drive/alerts"],
    enabled: showHistory,
  });

  useEffect(() => {
    if (drivingMonitor.isActive()) {
      setDriveActive(true);
      driveStartTimeRef.current = Date.now() - 1000;
    }
  }, []);

  useEffect(() => {
    if (driveActive) {
      if (!driveStartTimeRef.current) driveStartTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedTime(Date.now() - driveStartTimeRef.current);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [driveActive]);

  useEffect(() => {
    if (!driveActive) return;
    const id = navigator.geolocation?.watchPosition(
      (pos) => setCurrentPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
    return () => { if (id != null) navigator.geolocation.clearWatch(id); };
  }, [driveActive]);

  const startDrive = useCallback(async () => {
    if (driveStarting || driveActive) return;
    setDriveStarting(true);
    try {
      await drivingMonitor.start({
        onSpeedUpdate: (speed, limit) => {
          setCurrentSpeed(speed);
          setSpeedLimit(limit);
        },
        onSpeedAlert: (speed, limit) => {
          triggerHaptic([200, 100, 200, 100, 200]);
          toast({
            title: "Speed alert",
            description: `You're going ${Math.round(speed)} km/h in a ${limit} km/h zone`,
            variant: "destructive",
          });
        },
        onCrashDetected: (impactForce) => {
          triggerHaptic([500, 200, 500, 200, 500, 200, 500]);
          setCrashDetected(impactForce);
        },
        onError: (error) => {
          toast({ title: "Drive monitor error", description: error, variant: "destructive" });
        },
        onSessionStarted: () => {
          setDriveActive(true);
          driveStartTimeRef.current = Date.now();
          toast({ title: "Drive started", description: "Speed monitoring and crash detection active" });
        },
        onSessionEnded: () => {
          setDriveActive(false);
          setCurrentSpeed(0);
          setElapsedTime(0);
          driveStartTimeRef.current = 0;
          queryClient.invalidateQueries({ queryKey: ["/api/drive/history"] });
          toast({ title: "Drive ended", description: "Session saved" });
        },
      }, configuredSpeedLimit);
    } catch {
      toast({ title: "Could not start drive", variant: "destructive" });
    } finally {
      setDriveStarting(false);
    }
  }, [driveStarting, driveActive, configuredSpeedLimit, toast]);

  const stopDrive = useCallback(async () => {
    await drivingMonitor.stop();
    setDriveActive(false);
    setCurrentSpeed(0);
    setElapsedTime(0);
    driveStartTimeRef.current = 0;
    queryClient.invalidateQueries({ queryKey: ["/api/drive/history"] });
  }, []);

  const handleCrashCancel = useCallback(() => setCrashDetected(null), []);

  const handleCrashSos = useCallback(async () => {
    setCrashDetected(null);
    let pos: GeolocationPosition | null = null;
    try {
      pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 5000 })
      );
    } catch {}
    try {
      await drivingMonitor.reportCrash(pos?.coords.latitude, pos?.coords.longitude);
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Crash SOS sent", description: "Emergency contacts notified", variant: "destructive" });
    } catch {
      try {
        await apiRequest("POST", "/api/sos", {});
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        toast({ title: "SOS sent", description: "Emergency contacts notified", variant: "destructive" });
      } catch {
        toast({ title: "Could not send SOS", description: "Call emergency services directly", variant: "destructive" });
      }
    }
  }, [toast]);

  const speedPercent = Math.min(currentSpeed / Math.max(speedLimit, 1), 1.5);
  const isOverSpeed = currentSpeed > speedLimit;
  const mapPoints = trailPoints.map(p => ({
    lat: p.lat, lng: p.lng, activity: p.activity,
  }));

  return (
    <div className="min-h-screen bg-background" data-testid="page-drive">
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back-drive">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold" data-testid="text-drive-title">Driving Safety</h1>
        </div>
        {driveActive && (
          <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 animate-pulse">
            <div className="w-2 h-2 rounded-full bg-blue-500 mr-1.5" />
            Live
          </Badge>
        )}
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {!drivingSafetyEnabled && (
          <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-300 text-sm">Driving Safety is disabled</p>
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/60 mt-1">
                    Enable it in Settings to use speed monitoring and crash detection.
                  </p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate("/settings")} data-testid="button-enable-driving">
                    Go to Settings
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {driveActive ? (
          <>
            <Card className="border-blue-500/50 bg-gradient-to-b from-blue-50 to-background dark:from-blue-950/30 dark:to-background overflow-hidden">
              <CardContent className="pt-6 pb-6">
                <div className="text-center mb-6">
                  <div className="relative inline-flex items-center justify-center w-40 h-40 mb-2">
                    <svg viewBox="0 0 200 200" className="w-full h-full -rotate-90">
                      <circle cx="100" cy="100" r="85" fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/20" />
                      <circle
                        cx="100" cy="100" r="85"
                        fill="none"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={`${Math.min(speedPercent, 1) * 534} 534`}
                        className={isOverSpeed ? "text-red-500" : "text-blue-500"}
                        stroke="currentColor"
                        style={{ transition: "stroke-dasharray 0.5s ease" }}
                      />
                      {isOverSpeed && (
                        <circle
                          cx="100" cy="100" r="85"
                          fill="none"
                          strokeWidth="10"
                          strokeLinecap="round"
                          strokeDasharray={`${(speedPercent - 1) * 534} 534`}
                          strokeDashoffset={`-${534}`}
                          className="text-red-500"
                          stroke="currentColor"
                          style={{ opacity: 0.3 }}
                        />
                      )}
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className={`text-5xl font-bold tabular-nums ${isOverSpeed ? "text-red-500" : "text-foreground"}`} data-testid="text-current-speed">
                        {Math.round(currentSpeed)}
                      </span>
                      <span className="text-sm text-muted-foreground -mt-1">km/h</span>
                    </div>
                  </div>

                  {isOverSpeed && (
                    <div className="flex items-center justify-center gap-2 text-red-500 text-sm font-medium animate-pulse mb-2" data-testid="text-speed-warning">
                      <AlertTriangle className="w-4 h-4" />
                      Over speed limit!
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-4 gap-2 text-center">
                  <div className="bg-background/80 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground mb-0.5">Limit</p>
                    <p className="font-semibold text-sm" data-testid="text-speed-limit">{speedLimit}</p>
                    <p className="text-[10px] text-muted-foreground">km/h</p>
                  </div>
                  <div className="bg-background/80 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground mb-0.5">Max</p>
                    <p className="font-semibold text-sm" data-testid="text-max-speed">{Math.round(drivingMonitor.getMaxSpeed())}</p>
                    <p className="text-[10px] text-muted-foreground">km/h</p>
                  </div>
                  <div className="bg-background/80 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground mb-0.5">Distance</p>
                    <p className="font-semibold text-sm" data-testid="text-distance">{drivingMonitor.getDistance().toFixed(1)}</p>
                    <p className="text-[10px] text-muted-foreground">km</p>
                  </div>
                  <div className="bg-background/80 rounded-lg p-2">
                    <p className="text-xs text-muted-foreground mb-0.5">Time</p>
                    <p className="font-semibold text-sm tabular-nums" data-testid="text-elapsed">{formatDuration(elapsedTime)}</p>
                    <p className="text-[10px] text-muted-foreground">&nbsp;</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {currentPosition && (
              <Card className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="px-4 py-2 border-b flex items-center gap-2 bg-muted/30">
                    <Navigation className="w-4 h-4 text-blue-500" />
                    <span className="text-sm font-medium">Live Route</span>
                    {mapPoints.length > 0 && (
                      <span className="text-xs text-muted-foreground ml-auto">{mapPoints.length} points</span>
                    )}
                  </div>
                  <GoogleMap
                    center={currentPosition}
                    points={mapPoints}
                    zoom={15}
                    className="w-full h-56"
                    showTrail={true}
                  />
                  <div className="px-4 py-2 border-t flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-400" />Stationary</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />Walking</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" />Running</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />Cycling</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500" />Driving</span>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="border-blue-200 dark:border-blue-800">
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <Shield className="w-5 h-5 text-blue-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Crash detection active</p>
                  <p className="text-xs text-muted-foreground">If a crash is detected, your emergency contacts will be notified automatically.</p>
                </div>
              </CardContent>
            </Card>

            <Button
              variant="destructive"
              size="lg"
              className="w-full py-6 text-lg font-semibold"
              onClick={stopDrive}
              data-testid="button-stop-drive"
            >
              <Square className="w-5 h-5 mr-2" />
              End Drive
            </Button>
          </>
        ) : (
          <>
            <Card className="overflow-hidden">
              <CardContent className="pt-8 pb-8 text-center">
                <div className="w-20 h-20 rounded-full bg-blue-100 dark:bg-blue-950/40 flex items-center justify-center mx-auto mb-4">
                  <Car className="w-10 h-10 text-blue-600" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Start a Drive</h2>
                <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
                  Monitor your speed, detect crashes, and track your route. Emergency contacts get notified instantly if something goes wrong.
                </p>

                <div className="grid grid-cols-3 gap-3 mb-6 text-center">
                  <div className="bg-muted/30 rounded-lg p-3">
                    <Gauge className="w-5 h-5 text-blue-500 mx-auto mb-1" />
                    <p className="text-xs font-medium">Speed Alerts</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Limit: {configuredSpeedLimit} km/h</p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <Zap className="w-5 h-5 text-red-500 mx-auto mb-1" />
                    <p className="text-xs font-medium">Crash Detection</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Auto SOS on impact</p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <Navigation className="w-5 h-5 text-purple-500 mx-auto mb-1" />
                    <p className="text-xs font-medium">Route Trail</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Live GPS tracking</p>
                  </div>
                </div>

                <Button
                  size="lg"
                  className="w-full py-6 text-lg font-semibold bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={startDrive}
                  disabled={driveStarting || !drivingSafetyEnabled}
                  data-testid="button-start-drive"
                >
                  <Play className="w-5 h-5 mr-2" />
                  {driveStarting ? "Starting..." : "Start Drive"}
                </Button>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowHistory(!showHistory)}
                data-testid="button-toggle-history"
              >
                <History className="w-4 h-4 mr-2" />
                {showHistory ? "Hide History" : "Drive History"}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => navigate("/drive-report")}
                data-testid="button-drive-report"
              >
                <BarChart3 className="w-4 h-4 mr-2" />
                Driving Report
              </Button>
            </div>

            {showHistory && (
              <div className="space-y-3">
                <h3 className="font-semibold text-sm text-muted-foreground px-1">Recent Drives</h3>
                {sessions.length === 0 ? (
                  <Card>
                    <CardContent className="pt-6 pb-6 text-center">
                      <Car className="w-10 h-10 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">No drive sessions yet</p>
                    </CardContent>
                  </Card>
                ) : (
                  sessions.map((session) => {
                    const sessionAlerts = alerts.filter(a => a.sessionId === session.id);
                    return (
                      <Card key={session.id} className="overflow-hidden" data-testid={`card-drive-${session.id}`}>
                        <CardContent className="pt-4 pb-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Car className="w-4 h-4 text-blue-500" />
                              <span className="font-medium text-sm" data-testid={`text-drive-date-${session.id}`}>
                                {format(new Date(session.startedAt), "MMM d, yyyy")}
                              </span>
                            </div>
                            <div className="flex gap-1.5">
                              {session.crashDetected && (
                                <Badge variant="destructive" className="text-[10px]" data-testid={`badge-crash-${session.id}`}>
                                  <AlertTriangle className="w-3 h-3 mr-0.5" />
                                  Crash
                                </Badge>
                              )}
                              {!session.endedAt && (
                                <Badge variant="secondary" className="text-[10px]">Active</Badge>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-4 gap-2 text-center">
                            <div>
                              <p className="text-[10px] text-muted-foreground">Max</p>
                              <p className="font-semibold text-sm">{Math.round(session.maxSpeedKmh)}</p>
                              <p className="text-[10px] text-muted-foreground">km/h</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Avg</p>
                              <p className="font-semibold text-sm">{Math.round(session.avgSpeedKmh)}</p>
                              <p className="text-[10px] text-muted-foreground">km/h</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Distance</p>
                              <p className="font-semibold text-sm">{session.distanceKm.toFixed(1)}</p>
                              <p className="text-[10px] text-muted-foreground">km</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Duration</p>
                              <p className="font-semibold text-sm">{formatSessionDuration(session.startedAt as unknown as string, session.endedAt as unknown as string)}</p>
                              <p className="text-[10px] text-muted-foreground">&nbsp;</p>
                            </div>
                          </div>

                          <div className="flex items-center justify-between mt-3 pt-2 border-t text-xs text-muted-foreground">
                            <span>
                              {format(new Date(session.startedAt), "h:mm a")}
                              {session.endedAt && ` · ${format(new Date(session.endedAt), "h:mm a")}`}
                            </span>
                            {sessionAlerts.length > 0 && (
                              <span className="text-orange-500 font-medium">
                                {sessionAlerts.length} speed alert{sessionAlerts.length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}
      </div>

      {crashDetected !== null && (
        <CrashCountdown
          impactForce={crashDetected}
          onCancel={handleCrashCancel}
          onConfirmSos={handleCrashSos}
        />
      )}
    </div>
  );
}
