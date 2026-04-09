import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Settings, MapPin, Check, AlertTriangle, Clock, LogOut, Phone, Users, UserCheck, AlertCircle, Bell, Activity, Eye, MessageCircle, Car, Gauge, History, Smartphone, Satellite, RadioTower } from "lucide-react";
import type { UserStatus } from "@shared/schema";
import { format } from "date-fns";
import { getQuoteOfTheDay } from "@/lib/quotes";
import { createFallDetector, isDeviceMotionSupported, requestMotionPermission } from "@/lib/fall-detection";
import { drivingMonitor } from "@/lib/driving-monitor";
import CrashCountdown from "@/components/crash-countdown";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/lib/auth";

const triggerHaptic = (pattern: number | number[] = 50) => {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
};

function getCheckinLocation(): Promise<{ lat?: number; lng?: number; timezone?: string }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ timezone });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, timezone }),
      () => resolve({ timezone }),
      { timeout: 5000, maximumAge: 60000 }
    );
  });
}

function EscalationBanner({ status }: { status: UserStatus }) {
  const incident = status.openIncident;
  if (!incident || incident.status === "resolved") return null;

  const contacts = status.contacts || [];
  const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
  const handlingContact = incident.handledByContactId
    ? contacts.find(c => c.id === incident.handledByContactId)
    : null;

  const isSOSReason = incident.reason === "sos";
  const title = isSOSReason ? "Help request active" : "Missed checkin alert";

  if (incident.status === "paused") {
    const contactName = handlingContact?.name || "A contact";
    return (
      <Card className="bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800" data-testid="banner-escalation">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <UserCheck className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-blue-800 dark:text-blue-300" data-testid="text-banner-title">
                {contactName} is checking on you
              </p>
              <p className="text-sm text-blue-700/80 dark:text-blue-300/60 mt-1" data-testid="text-banner-detail">
                They've seen your alert and will reach out soon.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  let notifiedIds: string[] = [];
  try { notifiedIds = JSON.parse((incident as any).notifiedContactIds || "[]"); } catch { notifiedIds = []; }

  const steps: { label: string; done: boolean; icon: JSX.Element }[] = [];

  for (const contact of sortedContacts) {
    if (notifiedIds.includes(contact.id)) {
      steps.push({
        label: `${contact.name} notified`,
        done: true,
        icon: <Phone className="h-3.5 w-3.5" />,
      });
    }
  }

  const nextContact = sortedContacts.find(c => !notifiedIds.includes(c.id));
  if (nextContact && !incident.userNotifiedNoResponseAt) {
    steps.push({
      label: `${nextContact.name} will be notified if no response`,
      done: false,
      icon: <Clock className="h-3.5 w-3.5" />,
    });
  }

  if (incident.userNotifiedNoResponseAt) {
    steps.push({
      label: "No contacts have responded yet",
      done: true,
      icon: <AlertCircle className="h-3.5 w-3.5" />,
    });
  }

  return (
    <Card className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800" data-testid="banner-escalation">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-amber-800 dark:text-amber-400" data-testid="text-banner-title">
              {title}
            </p>

            {steps.length > 0 && (
              <div className="mt-3 space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm" data-testid={`step-escalation-${i}`}>
                    <span className={step.done
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-amber-600/50 dark:text-amber-500/40"
                    }>
                      {step.icon}
                    </span>
                    <span className={step.done
                      ? "text-amber-800 dark:text-amber-300"
                      : "text-amber-600/60 dark:text-amber-400/50 italic"
                    }>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {steps.length === 0 && (
              <p className="text-sm text-amber-700/80 dark:text-amber-300/70 mt-1">
                Your contacts are being notified.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function PushNotificationBanner() {
  const { toast } = useToast();
  const [pushState, setPushState] = useState<"loading" | "unsupported" | "denied" | "granted" | "prompt">("loading");

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    const permission = Notification.permission;
    if (permission === "granted") {
      setPushState("granted");
    } else if (permission === "denied") {
      setPushState("denied");
    } else {
      setPushState("prompt");
    }
  }, []);

  const subscribeToPush = useCallback(async () => {
    try {
      const res = await fetch("/api/push/vapid-key");
      const { key, configured } = await res.json();
      if (!configured || !key) {
        toast({ title: "Push notifications not available", description: "Server is not configured for push notifications.", variant: "destructive" });
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      } as any);

      await apiRequest("POST", "/api/push/subscribe", {
        subscription: subscription.toJSON(),
      });

      setPushState("granted");
      toast({ title: "Notifications enabled", description: "You'll receive checkin reminders." });
    } catch (error) {
      console.error("Push subscription failed:", error);
      toast({ title: "Could not enable notifications", variant: "destructive" });
    }
  }, [toast]);

  if (pushState === "loading" || pushState === "unsupported" || pushState === "denied") {
    return null;
  }

  if (pushState === "granted") {
    return null;
  }

  return (
    <Card data-testid="card-push-prompt">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <Bell className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium text-sm" data-testid="text-push-title">
              Enable notifications
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Get reminded to check in, even when the app is closed.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={subscribeToPush}
              data-testid="button-enable-notifications"
            >
              <Bell className="h-4 w-4 mr-2" />
              Turn on notifications
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showSosConfirm, setShowSosConfirm] = useState(false);
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [fallCountdown, setFallCountdown] = useState<number | null>(null);
  const [shakeCountdown, setShakeCountdown] = useState<number | null>(null);
  const [longPressProgress, setLongPressProgress] = useState(0);
  const longPressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const longPressStartRef = useRef<number>(0);
  const fallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shakeCooldownUntilRef = useRef<number>(0);
  const fallDetectorRef = useRef<ReturnType<typeof createFallDetector> | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const [driveActive, setDriveActive] = useState(false);
  const [driveSpeed, setDriveSpeed] = useState(0);
  const [driveSpeedLimit, setDriveSpeedLimit] = useState(120);
  const [crashDetected, setCrashDetected] = useState<number | null>(null);
  const [driveStarting, setDriveStarting] = useState(false);

  const { auth } = useAuth();

  const { data: status, isLoading } = useQuery<UserStatus>({
    queryKey: ["/api/status"],
    refetchInterval: (query) => {
      const data = query.state.data as UserStatus | undefined;
      if (data?.openIncident && data.openIncident.status !== "resolved") {
        return 15000;
      }
      return 60000;
    },
  });

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/messages/unread/count"],
    refetchInterval: 30000,
  });
  const unreadCount = unreadData?.count || 0;

  useEffect(() => {
    if (!auth?.authenticated) return;
    const socket = getSocket();
    const handleNewMessage = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread/count"] });
    };
    socket.on("message:new", handleNewMessage);
    return () => { socket.off("message:new", handleNewMessage); };
  }, [auth?.authenticated]);

  const sendLocationToServer = async (position: GeolocationPosition) => {
    try {
      await apiRequest("POST", "/api/location/update", {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
    } catch (error) {
      console.log("Location update failed:", error);
    }
  };

  useEffect(() => {
    if (locationEnabled && status?.activeLocationSession) {
      navigator.geolocation.getCurrentPosition(sendLocationToServer);
      
      locationWatchRef.current = navigator.geolocation.watchPosition(
        sendLocationToServer,
        (error) => console.log("Location watch error:", error),
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 }
      );
    }

    return () => {
      if (locationWatchRef.current !== null) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
        locationWatchRef.current = null;
      }
    };
  }, [locationEnabled, status?.activeLocationSession]);

  const autoCheckedRef = useRef(false);
  const hasActiveIncident = status?.openIncident && status.openIncident.status !== "resolved";

  useEffect(() => {
    if (
      status?.settings?.autoCheckin &&
      !autoCheckedRef.current &&
      !hasActiveIncident &&
      !isLoading
    ) {
      autoCheckedRef.current = true;
      getCheckinLocation().then((loc) => {
        const body: any = { method: "auto" };
        if (loc.lat != null) body.lat = loc.lat;
        if (loc.lng != null) body.lng = loc.lng;
        if (loc.timezone) body.timezone = loc.timezone;
        return apiRequest("POST", "/api/checkin", body);
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        setShowQuote(true);
        triggerHaptic(30);
      }).catch(() => {});
    }
  }, [status?.settings?.autoCheckin, isLoading, hasActiveIncident]);

  const startFallCountdown = useCallback(() => {
    triggerHaptic([200, 100, 200, 100, 200]);
    setFallCountdown(60);
    if (fallTimerRef.current) clearInterval(fallTimerRef.current);
    fallTimerRef.current = setInterval(() => {
      setFallCountdown(prev => {
        if (prev === null) {
          if (fallTimerRef.current) clearInterval(fallTimerRef.current);
          fallTimerRef.current = null;
          return null;
        }
        if (prev <= 1) {
          if (fallTimerRef.current) clearInterval(fallTimerRef.current);
          fallTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const dismissFallAlert = useCallback(() => {
    if (fallTimerRef.current) {
      clearInterval(fallTimerRef.current);
      fallTimerRef.current = null;
    }
    setFallCountdown(null);
  }, []);

  useEffect(() => {
    if (fallCountdown === 0 && fallCountdown !== null) {
      apiRequest("POST", "/api/sos", {}).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        toast({
          title: "Fall detected - SOS sent",
          description: "Your emergency contacts have been alerted.",
        });
      }).catch(() => {});
      setFallCountdown(null);
    }
  }, [fallCountdown, toast]);

  const startShakeCountdown = useCallback(() => {
    triggerHaptic([200, 100, 200, 100, 200]);
    setShakeCountdown(30);
    if (shakeTimerRef.current) clearInterval(shakeTimerRef.current);
    shakeTimerRef.current = setInterval(() => {
      setShakeCountdown(prev => {
        if (prev === null) {
          if (shakeTimerRef.current) clearInterval(shakeTimerRef.current);
          shakeTimerRef.current = null;
          return null;
        }
        if (prev <= 1) {
          if (shakeTimerRef.current) clearInterval(shakeTimerRef.current);
          shakeTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const dismissShakeAlert = useCallback(() => {
    if (shakeTimerRef.current) {
      clearInterval(shakeTimerRef.current);
      shakeTimerRef.current = null;
    }
    setShakeCountdown(null);
    shakeCooldownUntilRef.current = Date.now() + 5 * 60 * 1000;
  }, []);

  useEffect(() => {
    if (shakeCountdown === 0 && shakeCountdown !== null) {
      apiRequest("POST", "/api/sos", {}).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        toast({
          title: "Shake SOS sent",
          description: "Your emergency contacts have been alerted.",
        });
      }).catch(() => {});
      setShakeCountdown(null);
    }
  }, [shakeCountdown, toast]);

  const LONG_PRESS_DURATION = 3000;

  const startLongPress = useCallback(() => {
    longPressStartRef.current = Date.now();
    setLongPressProgress(0);
    triggerHaptic([30]);

    if (longPressTimerRef.current) clearInterval(longPressTimerRef.current);
    longPressTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - longPressStartRef.current;
      const pct = Math.min(elapsed / LONG_PRESS_DURATION, 1);
      setLongPressProgress(pct);
      if (pct >= 1) {
        if (longPressTimerRef.current) clearInterval(longPressTimerRef.current);
        longPressTimerRef.current = null;
        triggerHaptic([200, 100, 200, 100, 200]);
        apiRequest("POST", "/api/sos", {}).then(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/status"] });
          toast({
            title: "Discreet SOS sent",
            description: "Your emergency contacts have been alerted.",
          });
        }).catch(() => {});
        setLongPressProgress(0);
      }
    }, 50);
  }, [toast]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearInterval(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setLongPressProgress(0);
  }, []);

  useEffect(() => {
    const fallEnabled = (status?.settings as any)?.fallDetection;
    if (fallEnabled && isDeviceMotionSupported() && !fallDetectorRef.current) {
      fallDetectorRef.current = createFallDetector({
        onFallDetected: startFallCountdown,
      });
      fallDetectorRef.current.start();
    } else if (!fallEnabled && fallDetectorRef.current) {
      fallDetectorRef.current.stop();
      fallDetectorRef.current = null;
    }
    return () => {
      if (fallDetectorRef.current) {
        fallDetectorRef.current.stop();
      }
    };
  }, [(status?.settings as any)?.fallDetection, startFallCountdown]);

  useEffect(() => {
    const discreetEnabled = (status?.settings as any)?.discreetSos;
    if (!discreetEnabled || !isDeviceMotionSupported()) return;

    let cleanup: (() => void) | null = null;

    const setupShakeDetection = async () => {
      const DME = DeviceMotionEvent as any;
      const needsPermission = typeof DME.requestPermission === "function";
      if (needsPermission) {
        const alreadyGranted = localStorage.getItem("motionPermissionGranted") === "true";
        if (!alreadyGranted) {
          const granted = await requestMotionPermission();
          if (!granted) return;
        }
      }

      const SHAKES_NEEDED = 3;
      const SHAKE_WINDOW_MS = 3000;
      const PEAK_THRESHOLD = 10;
      const CALM_THRESHOLD = 5;
      const MIN_CALM_MS = 60;
      const DEBOUNCE_MS = 80;

      let shakeCount = 0;
      let firstShakeTime = 0;
      let lastShakeTime = 0;
      let aboveThreshold = false;
      const gravity = { x: 0, y: 0, z: 0 };
      let initialized = false;

      const handleMotion = (e: DeviceMotionEvent) => {
        let magnitude: number;

        const pureAccel = e.acceleration;
        if (pureAccel && pureAccel.x != null && pureAccel.y != null && pureAccel.z != null) {
          magnitude = Math.sqrt(pureAccel.x ** 2 + pureAccel.y ** 2 + pureAccel.z ** 2);
        } else {
          const accel = e.accelerationIncludingGravity;
          if (!accel || accel.x == null || accel.y == null || accel.z == null) return;

          const alpha = 0.8;
          if (!initialized) {
            gravity.x = accel.x; gravity.y = accel.y; gravity.z = accel.z;
            initialized = true;
            return;
          }
          gravity.x = alpha * gravity.x + (1 - alpha) * accel.x;
          gravity.y = alpha * gravity.y + (1 - alpha) * accel.y;
          gravity.z = alpha * gravity.z + (1 - alpha) * accel.z;

          magnitude = Math.sqrt(
            (accel.x - gravity.x) ** 2 +
            (accel.y - gravity.y) ** 2 +
            (accel.z - gravity.z) ** 2
          );
        }

        const now = Date.now();

        if (shakeCount > 0 && now - firstShakeTime > SHAKE_WINDOW_MS) {
          shakeCount = 0;
          aboveThreshold = false;
        }

        if (magnitude >= PEAK_THRESHOLD) {
          aboveThreshold = true;
        } else if (magnitude < CALM_THRESHOLD && aboveThreshold) {
          aboveThreshold = false;

          if (now - lastShakeTime < DEBOUNCE_MS) return;

          const calmGap = now - lastShakeTime;
          if (shakeCount > 0 && calmGap < MIN_CALM_MS) return;

          shakeCount++;
          lastShakeTime = now;
          if (shakeCount === 1) firstShakeTime = now;

          triggerHaptic([30]);

          if (shakeCount >= SHAKES_NEEDED) {
            shakeCount = 0;
            aboveThreshold = false;
            if (Date.now() < shakeCooldownUntilRef.current) return;
            startShakeCountdown();
          }
        }
      };

      window.addEventListener("devicemotion", handleMotion);
      cleanup = () => {
        window.removeEventListener("devicemotion", handleMotion);
      };
    };

    setupShakeDetection();
    return () => { if (cleanup) cleanup(); };
  }, [(status?.settings as any)?.discreetSos, startShakeCountdown]);

  const drivingSafetyEnabled = !!(status?.settings as any)?.drivingSafety;
  const configuredSpeedLimit = (status?.settings as any)?.speedLimitKmh || 120;

  useEffect(() => {
    if (drivingMonitor.isActive()) {
      setDriveActive(true);
    }
  }, []);

  const startDrive = useCallback(async () => {
    if (driveStarting || driveActive) return;
    setDriveStarting(true);
    try {
      await drivingMonitor.start({
        onSpeedUpdate: (speed, limit) => {
          setDriveSpeed(speed);
          setDriveSpeedLimit(limit);
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
          toast({ title: "Drive started", description: "Speed monitoring and crash detection are active" });
        },
        onSessionEnded: () => {
          setDriveActive(false);
          setDriveSpeed(0);
          toast({ title: "Drive ended", description: "Session saved to your drive history" });
        },
      }, configuredSpeedLimit);
    } catch (err) {
      toast({ title: "Could not start drive", description: "Please try again", variant: "destructive" });
    } finally {
      setDriveStarting(false);
    }
  }, [driveStarting, driveActive, configuredSpeedLimit, toast]);

  const stopDrive = useCallback(async () => {
    await drivingMonitor.stop();
    setDriveActive(false);
    setDriveSpeed(0);
  }, []);

  const handleCrashCancel = useCallback(() => {
    setCrashDetected(null);
  }, []);

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
      toast({ title: "Crash SOS sent", description: "Your emergency contacts have been notified", variant: "destructive" });
    } catch {
      try {
        await apiRequest("POST", "/api/sos", {});
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        toast({ title: "SOS sent", description: "Your emergency contacts have been notified", variant: "destructive" });
      } catch {
        toast({ title: "Could not send SOS", description: "Please call emergency services directly", variant: "destructive" });
      }
    }
  }, [toast]);

  const checkinMutation = useMutation({
    mutationFn: async () => {
      const loc = await getCheckinLocation();
      const body: any = {};
      if (loc.lat != null) body.lat = loc.lat;
      if (loc.lng != null) body.lng = loc.lng;
      if (loc.timezone) body.timezone = loc.timezone;
      return apiRequest("POST", "/api/checkin", body);
    },
    onSuccess: () => {
      triggerHaptic(50);
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      setShowQuote(true);
      const count = parseInt(localStorage.getItem("stillhere_checkin_count") || "0", 10);
      localStorage.setItem("stillhere_checkin_count", String(count + 1));
      toast({
        title: "Checked in",
        description: "Your emergency contacts know you're okay.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not check in. Please try again.",
        variant: "destructive",
      });
    },
  });

  const sosMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/sos", {});
    },
    onSuccess: () => {
      triggerHaptic([100, 50, 100, 50, 200]);
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Alert sent",
        description: "Your emergency contacts were notified.",
      });
      
      if (status?.settings?.locationMode !== "off") {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            sendLocationToServer(position);
            setLocationEnabled(true);
          },
          () => {
            console.log("Could not get location for SOS");
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not send alert. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resolveAlertMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/resolve-alert", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({
        title: "Alert resolved",
        description: "Your contacts will know you're OK.",
      });
      setLocationEnabled(false);
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not resolve alert. Please try again.",
        variant: "destructive",
      });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: async () => {
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      window.location.href = "/login";
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not log out. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleLocationToggle = () => {
    if (!locationEnabled) {
      navigator.geolocation.getCurrentPosition(
        () => {
          setLocationEnabled(true);
          toast({
            title: "Location on",
            description: "Location sharing is on for emergencies.",
          });
        },
        () => {
          toast({
            title: "Location access denied",
            description: "Please enable location in your browser settings.",
            variant: "destructive",
          });
        }
      );
    } else {
      setLocationEnabled(false);
      toast({
        title: "Location off",
      });
    }
  };

  const formatNextCheckin = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const dayAfterTomorrowStart = new Date(todayStart);
    dayAfterTomorrowStart.setDate(dayAfterTomorrowStart.getDate() + 2);

    if (d < tomorrowStart) {
      return format(d, "h:mm a 'today'");
    } else if (d < dayAfterTomorrowStart) {
      return format(d, "h:mm a 'tomorrow'");
    } else {
      return format(d, "EEEE 'at' h:mm a");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  const isPaused = status?.settings?.pauseUntil && new Date(status.settings.pauseUntil) > new Date();
  const hasOpenIncident = hasActiveIncident;

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-app-title">StillHere</h1>
            <p className="text-sm opacity-90" data-testid="text-welcome">
              Welcome, {status?.user?.name || "User"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground relative"
              onClick={() => setLocation("/inbox")}
              data-testid="button-inbox"
            >
              <MessageCircle className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1 leading-none" data-testid="badge-unread-count">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => setLocation("/watched")}
              data-testid="button-watched"
            >
              <Eye className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground relative"
              onClick={() => setLocation("/live-location")}
              data-testid="button-live-location"
            >
              <RadioTower className="h-5 w-5" />
              {localStorage.getItem("liveLocationActive") === "true" && (
                <span className="absolute top-1 right-1 h-2.5 w-2.5 bg-green-400 rounded-full animate-pulse" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => setLocation("/satellite")}
              data-testid="button-satellite"
            >
              <Satellite className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => setLocation("/settings")}
              data-testid="button-settings"
            >
              <Settings className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary-foreground"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              data-testid="button-logout"
            >
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-8 space-y-8">
        <PushNotificationBanner />

        {hasOpenIncident && status && (
          <div className="space-y-3">
            <EscalationBanner status={status} />
            <div className="text-center">
              <Button
                variant="outline"
                size="sm"
                className="border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                onClick={() => resolveAlertMutation.mutate()}
                disabled={resolveAlertMutation.isPending}
                data-testid="button-resolve-alert"
              >
                <Check className="h-4 w-4 mr-2" />
                {resolveAlertMutation.isPending ? "Resolving..." : "I'm OK now"}
              </Button>
            </div>
          </div>
        )}

        <Card>
          <CardContent className="pt-6 text-center">
            <div className="flex items-center justify-center gap-2 text-muted-foreground mb-2">
              <Clock className="h-4 w-4" />
              <span className="text-sm">Next checkin</span>
            </div>
            <p className="text-lg font-medium" data-testid="text-next-checkin">
              {status?.nextCheckinDue
                ? formatNextCheckin(status.nextCheckinDue)
                : "No schedule set"}
            </p>
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-timezone">
              {(Intl.DateTimeFormat().resolvedOptions().timeZone || "").replace(/_/g, " ") || "Unknown timezone"}
            </p>
            {isPaused && (
              <p className="text-sm text-muted-foreground mt-2">
                Alerts paused until {format(new Date(status.settings.pauseUntil!), "h:mm a")}
              </p>
            )}
          </CardContent>
        </Card>

        <div className="text-center">
          <button
            onClick={() => checkinMutation.mutate()}
            disabled={checkinMutation.isPending}
            className="w-44 h-44 rounded-full bg-accent text-accent-foreground font-bold text-2xl shadow-lg transition-all duration-200 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 flex flex-col items-center justify-center mx-auto"
            data-testid="button-im-ok"
          >
            <Check className="h-12 w-12 mb-2" />
            <span>I'm OK</span>
          </button>
          <p className="text-sm text-muted-foreground mt-4">
            Tap "I'm OK" anytime
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            This lets your family know you're okay.
          </p>
        </div>

        {showQuote && (
          <Card className="border-accent/30" data-testid="card-quote">
            <CardContent className="pt-6 text-center">
              <p className="text-base italic text-foreground leading-relaxed" data-testid="text-quote">
                &ldquo;{getQuoteOfTheDay()}&rdquo;
              </p>
              <p className="text-xs text-muted-foreground mt-3">
                Quote of the day
              </p>
            </CardContent>
          </Card>
        )}

        {drivingSafetyEnabled && (
          <Card className={driveActive ? "border-blue-500/50 bg-blue-50/50 dark:bg-blue-950/20" : ""} data-testid="card-driving">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Car className={`w-5 h-5 ${driveActive ? "text-blue-500" : "text-muted-foreground"}`} />
                  <span className="font-medium">Driving safety</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLocation("/drive-history")}
                  data-testid="button-drive-history"
                >
                  <History className="w-4 h-4 mr-1" />
                  History
                </Button>
              </div>

              {driveActive ? (
                <>
                  <div className="flex items-center justify-center gap-4 mb-3">
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Gauge className="w-4 h-4 text-blue-500" />
                        <span className={`text-2xl font-bold ${driveSpeed > driveSpeedLimit ? "text-red-500" : "text-foreground"}`} data-testid="text-current-speed">
                          {Math.round(driveSpeed)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">km/h</p>
                    </div>
                    <div className="text-center">
                      <span className="text-sm text-muted-foreground">Limit</span>
                      <p className="font-semibold" data-testid="text-speed-limit">{driveSpeedLimit} km/h</p>
                    </div>
                    <div className="text-center">
                      <span className="text-sm text-muted-foreground">Max</span>
                      <p className="font-semibold" data-testid="text-max-speed-live">{Math.round(drivingMonitor.getMaxSpeed())} km/h</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 text-center text-xs text-muted-foreground">
                      Distance: {drivingMonitor.getDistance().toFixed(1)} km
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full mt-3"
                    onClick={stopDrive}
                    data-testid="button-stop-drive"
                  >
                    Stop drive
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground mb-3">
                    Monitor your speed and detect crashes while driving
                  </p>
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={startDrive}
                    disabled={driveStarting}
                    data-testid="button-start-drive"
                  >
                    <Car className="w-4 h-4 mr-2" />
                    {driveStarting ? "Starting..." : "Start drive"}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="bg-destructive/5 border-destructive/20">
          <CardContent className="pt-6">
            <Button
              variant="destructive"
              size="lg"
              className="w-full py-6 text-lg font-semibold"
              onClick={() => setShowSosConfirm(true)}
              disabled={sosMutation.isPending}
              data-testid="button-sos"
            >
              <AlertTriangle className="h-5 w-5 mr-2" />
              I Need Help
            </Button>
            {(status?.settings as any)?.discreetSos && (
              <div className="mt-4">
                <button
                  className="w-full relative overflow-hidden rounded-lg border-2 border-destructive/30 py-3 px-4 text-sm font-medium text-destructive select-none touch-none"
                  onTouchStart={(e) => { e.preventDefault(); startLongPress(); }}
                  onTouchEnd={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  onMouseDown={startLongPress}
                  onMouseUp={cancelLongPress}
                  onMouseLeave={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                  data-testid="button-discreet-sos"
                >
                  <div
                    className="absolute inset-0 bg-destructive/20 transition-none"
                    style={{ width: `${longPressProgress * 100}%` }}
                  />
                  <span className="relative flex items-center justify-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    {longPressProgress > 0
                      ? `Hold ${Math.ceil((1 - longPressProgress) * 3)}s...`
                      : "Hold 3 seconds for discreet SOS"}
                  </span>
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-center gap-2 text-sm">
          <MapPin className={`h-4 w-4 ${locationEnabled ? "text-accent" : "text-destructive"}`} />
          <span className="text-muted-foreground">
            Share my Location {locationEnabled ? "ON" : "OFF"}
          </span>
          <span className="text-muted-foreground">|</span>
          <button
            onClick={handleLocationToggle}
            className="text-primary underline hover:no-underline"
            data-testid="button-location-toggle"
          >
            {locationEnabled ? "Turn off" : "Enable Location"}
          </button>
        </div>
      </main>

      <AlertDialog open={showSosConfirm} onOpenChange={setShowSosConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send help alert?</AlertDialogTitle>
            <AlertDialogDescription>
              We will notify your emergency contacts now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-sos-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                sosMutation.mutate();
                setShowSosConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-sos-confirm"
            >
              Send Alert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={fallCountdown !== null} onOpenChange={(open) => { if (!open) dismissFallAlert(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-destructive" />
              Fall detected
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              It looks like you may have fallen. We'll alert your emergency contacts in{" "}
              <span className="font-bold text-destructive text-lg">{fallCountdown}</span>{" "}
              seconds unless you dismiss this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={dismissFallAlert} data-testid="button-fall-dismiss">
              I'm fine
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                dismissFallAlert();
                sosMutation.mutate();
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-fall-sos"
            >
              Send SOS now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={shakeCountdown !== null} onOpenChange={(open) => { if (!open) dismissShakeAlert(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-destructive" />
              Shake detected
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              We detected a distress shake. SOS will be sent to your emergency contacts in{" "}
              <span className="font-bold text-destructive text-lg">{shakeCountdown}</span>{" "}
              seconds. If this was accidental, tap cancel below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={dismissShakeAlert} data-testid="button-shake-dismiss">
              Cancel - I'm fine
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                dismissShakeAlert();
                sosMutation.mutate();
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-shake-sos"
            >
              Send SOS now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
