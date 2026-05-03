import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { subscribe as subscribeLocation, getOneShotPosition, getCurrentPosition as getCachedPosition } from "@/lib/location-service";
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
import { Check, AlertTriangle, Clock, Phone, UserCheck, AlertCircle, Bell, Activity, Car, Smartphone, Timer, Navigation, ShieldCheck } from "lucide-react";
import type { UserStatus } from "@shared/schema";
import { format } from "date-fns";
import { getQuoteOfTheDay } from "@/lib/quotes";
import { ConcernTimelinePanel } from "@/components/concern-resolution";
import { PermissionRecoveryCard } from "@/components/permission-recovery";
import { createFallDetector, isDeviceMotionSupported } from "@/lib/fall-detection";
import { drivingMonitor } from "@/lib/driving-monitor";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/lib/auth";
import { AppDrawer } from "@/components/app-drawer";

const triggerHaptic = (pattern: number | number[] = 50) => {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
};

async function getCheckinLocation(): Promise<{ lat?: number; lng?: number; timezone?: string }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  try {
    const pos = await getOneShotPosition();
    if (pos) return { lat: pos.lat, lng: pos.lng, timezone };
  } catch {}
  return { timezone };
}

// Build SOS request body from cached location only. This is a SYNC read of the
// location service's last known position - it never triggers an OS permission
// popup and never blocks. If no cache exists (permission never granted, app
// just opened, etc.) the body is empty and the server uses the user's last
// stored location instead.
function buildSosBody(): { lat?: number; lng?: number; accuracy?: number } {
  try {
    const cached = getCachedPosition();
    if (cached) {
      return { lat: cached.lat, lng: cached.lng, accuracy: cached.accuracy };
    }
  } catch {}
  return {};
}

// Best-effort post-SOS location refresh. Only fires if the OS has already
// granted location permission - we check first via the Permissions API so
// we never accidentally trigger a popup AFTER the user has already pressed SOS.
async function refreshLocationIfPermitted(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName }).catch(() => null);
    if (!status || status.state !== "granted") return;
    const pos = await getOneShotPosition();
    if (pos) {
      try {
        await apiRequest("POST", "/api/location/update", {
          lat: pos.lat,
          lng: pos.lng,
          accuracy: pos.accuracy,
        });
      } catch {}
    }
  } catch {}
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
  const [longPressProgress, setLongPressProgress] = useState(0);
  const longPressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const longPressStartRef = useRef<number>(0);
  const fallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallDetectorRef = useRef<ReturnType<typeof createFallDetector> | null>(null);
  const [driveActive, setDriveActive] = useState(false);

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

  const sendLocationToServer = async (state: { lat: number; lng: number; accuracy: number }) => {
    try {
      await apiRequest("POST", "/api/location/update", {
        lat: state.lat,
        lng: state.lng,
        accuracy: state.accuracy,
      });
    } catch (error) {
      console.log("Location update failed:", error);
    }
  };

  const locationUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (locationEnabled && status?.activeLocationSession) {
      if (locationUnsubRef.current) locationUnsubRef.current();
      locationUnsubRef.current = subscribeLocation((state) => {
        sendLocationToServer(state);
      });
    }

    return () => {
      if (locationUnsubRef.current) {
        locationUnsubRef.current();
        locationUnsubRef.current = null;
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
      const sosBody = buildSosBody();
      apiRequest("POST", "/api/sos", sosBody).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/status"] });
        toast({
          title: "Fall detected - SOS sent",
          description: sosBody.lat != null
            ? "Your emergency contacts have been alerted with your location."
            : "Your emergency contacts have been alerted. Location unavailable, last known location used.",
        });
        refreshLocationIfPermitted();
      }).catch(() => {});
      setFallCountdown(null);
    }
  }, [fallCountdown, toast]);

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
        const sosBody = buildSosBody();
        apiRequest("POST", "/api/sos", sosBody).then(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/status"] });
          toast({
            title: "Discreet SOS sent",
            description: sosBody.lat != null
              ? "Your emergency contacts have been alerted with your location."
              : "Your emergency contacts have been alerted. Location unavailable, last known location used.",
          });
          refreshLocationIfPermitted();
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
    if (drivingMonitor.isActive()) {
      setDriveActive(true);
    }
  }, []);

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
      // CRITICAL: SOS must fire instantly. Never await any geolocation call here -
      // that would trigger an OS permission popup and block the alert. Instead we
      // attach whatever the location service already has cached (sync, never blocks)
      // and let the server snapshot it. Fresh location is fetched async AFTER send,
      // and only if permission is already granted (no popup, ever).
      const sosBody = buildSosBody();
      return apiRequest("POST", "/api/sos", sosBody);
    },
    onSuccess: (_data, _vars, _ctx) => {
      triggerHaptic([100, 50, 100, 50, 200]);
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      const cached = getCachedPosition();
      toast({
        title: "Alert sent",
        description: cached
          ? "Your emergency contacts were notified with your location."
          : "Your emergency contacts were notified. Location unavailable, last known location used.",
      });

      if (status?.settings?.locationMode !== "off") {
        refreshLocationIfPermitted();
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

  const formatNextCheckinTime = (date: Date) => format(new Date(date), "h:mm a");

  const formatNextCheckinMeta = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const dayAfterTomorrowStart = new Date(todayStart);
    dayAfterTomorrowStart.setDate(dayAfterTomorrowStart.getDate() + 2);

    let dayLabel = "";
    if (d < tomorrowStart) dayLabel = "Today";
    else if (d < dayAfterTomorrowStart) dayLabel = "Tomorrow";
    else dayLabel = format(d, "EEEE");

    const tzRaw = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const tzCity = tzRaw.split("/").pop()?.replace(/_/g, " ") || "";

    return tzCity ? `${dayLabel} \u00B7 ${tzCity}` : dayLabel;
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
  const guardianCount = status?.contacts?.length || 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <div className="max-w-md mx-auto px-2 h-14 flex items-center justify-between">
          <AppDrawer
            userName={status?.user?.name}
            onSosTap={() => setShowSosConfirm(true)}
          />
          <h1 className="text-base font-semibold tracking-tight" data-testid="text-app-title">
            StillHere
          </h1>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            onClick={() => setLocation("/inbox")}
            data-testid="button-notifications"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span
                className="absolute top-1.5 right-1.5 h-2 w-2 bg-red-500 rounded-full"
                data-testid="badge-unread-count"
              />
            )}
          </Button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 pt-6 pb-12 space-y-7">
        <PushNotificationBanner />
        <PermissionRecoveryCard />

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

        {status?.user?.safetyState === "concern" && !hasOpenIncident && (
          <ConcernTimelinePanel userId={status.user.id} isWatcher={false} />
        )}

        <div className="text-center pt-1">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100 dark:bg-green-950/40 mb-3">
            <ShieldCheck className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-base font-semibold text-foreground" data-testid="text-protected-status">
            {guardianCount > 0 ? "You're Protected" : "Set up your Safety Circle"}
          </p>
          <p className="text-sm text-muted-foreground mt-1" data-testid="text-guardian-count">
            {guardianCount > 0
              ? `Sharing with ${guardianCount} Guardian${guardianCount === 1 ? "" : "s"}`
              : "Add an emergency contact to get started"}
          </p>
        </div>

        <div className="text-center pt-1">
          <button
            onClick={() => checkinMutation.mutate()}
            disabled={checkinMutation.isPending}
            className="w-44 h-44 rounded-full bg-green-500 hover:bg-green-600 active:bg-green-600 text-white shadow-[0_12px_36px_-12px_rgba(34,197,94,0.55)] disabled:opacity-50 disabled:active:scale-100 transition-all duration-150 active:scale-[0.97] flex flex-col items-center justify-center mx-auto"
            data-testid="button-im-ok"
          >
            <Check className="h-12 w-12 mb-1.5" strokeWidth={3} />
            <span className="text-2xl font-bold tracking-wide">I'M OK</span>
          </button>
          <p className="text-sm text-muted-foreground mt-5 max-w-xs mx-auto leading-relaxed">
            Tap anytime to let your guardian know you're okay
          </p>
        </div>

        {showQuote && (
          <Card className="border-accent/30 rounded-2xl" data-testid="card-quote">
            <CardContent className="pt-6 text-center">
              <p className="text-base italic text-foreground leading-relaxed" data-testid="text-quote">
                &ldquo;{getQuoteOfTheDay()}&rdquo;
              </p>
              <p className="text-xs text-muted-foreground mt-3">Quote of the day</p>
            </CardContent>
          </Card>
        )}

        <Card className="rounded-2xl shadow-sm" data-testid="card-next-checkin">
          <CardContent className="px-5 py-4 flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Next check-in
              </p>
              <p className="text-lg font-semibold text-foreground mt-1" data-testid="text-next-checkin">
                {status?.nextCheckinDue
                  ? formatNextCheckinTime(status.nextCheckinDue)
                  : "Not scheduled"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-next-checkin-meta">
                {status?.nextCheckinDue
                  ? formatNextCheckinMeta(status.nextCheckinDue)
                  : "Set a schedule in Settings"}
              </p>
            </div>
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 ml-3">
              <Clock className="h-5 w-5 text-primary" />
            </div>
          </CardContent>
        </Card>

        {isPaused && (
          <p className="text-center text-xs text-muted-foreground -mt-3" data-testid="text-paused">
            Alerts paused until {format(new Date(status!.settings.pauseUntil!), "h:mm a")}
          </p>
        )}

        <div className="grid grid-cols-4 gap-3">
          <button
            className="flex flex-col items-center text-center gap-2 py-3 px-1 rounded-2xl bg-orange-50 dark:bg-orange-950/30 transition-all duration-150 active:scale-95 active:bg-orange-100 dark:active:bg-orange-950/50"
            onClick={() => setLocation("/safety-timer")}
            data-testid="card-safety-timer"
          >
            <div className="w-11 h-11 rounded-2xl bg-orange-500 flex items-center justify-center">
              <Timer className="h-5 w-5 text-white" />
            </div>
            <span className="font-medium text-xs text-foreground">Timer</span>
          </button>
          <button
            className="flex flex-col items-center text-center gap-2 py-3 px-1 rounded-2xl bg-green-50 dark:bg-green-950/30 transition-all duration-150 active:scale-95 active:bg-green-100 dark:active:bg-green-950/50"
            onClick={() => setLocation("/safe-walk")}
            data-testid="card-safe-walk"
          >
            <div className="w-11 h-11 rounded-2xl bg-green-500 flex items-center justify-center">
              <Navigation className="h-5 w-5 text-white" />
            </div>
            <span className="font-medium text-xs text-foreground">Safe Walk</span>
          </button>
          <button
            className={`flex flex-col items-center text-center gap-2 py-3 px-1 rounded-2xl transition-all duration-150 active:scale-95 ${driveActive ? "bg-blue-100 dark:bg-blue-950/50 active:bg-blue-200" : "bg-blue-50 dark:bg-blue-950/30 active:bg-blue-100 dark:active:bg-blue-950/50"}`}
            onClick={() => setLocation("/drive")}
            data-testid="card-drive"
          >
            <div className={`w-11 h-11 rounded-2xl flex items-center justify-center ${driveActive ? "bg-blue-600 animate-pulse" : "bg-blue-500"}`}>
              <Car className="h-5 w-5 text-white" />
            </div>
            <span className="font-medium text-xs text-foreground">{driveActive ? "Driving" : "Drive"}</span>
          </button>
          <button
            className="flex flex-col items-center text-center gap-2 py-3 px-1 rounded-2xl bg-red-50 dark:bg-red-950/30 transition-all duration-150 active:scale-95 active:bg-red-100 dark:active:bg-red-950/50"
            onClick={() => setShowSosConfirm(true)}
            disabled={sosMutation.isPending}
            data-testid="card-sos"
          >
            <div className="w-11 h-11 rounded-2xl bg-red-500 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-white" />
            </div>
            <span className="font-medium text-xs text-foreground">SOS</span>
          </button>
        </div>

        {(status?.settings as any)?.discreetSos && (
          <button
            className="w-full relative overflow-hidden rounded-xl border border-destructive/30 py-2.5 px-4 text-xs font-medium text-destructive/80 select-none touch-none"
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
              className="absolute inset-0 bg-destructive/15 transition-none"
              style={{ width: `${longPressProgress * 100}%` }}
            />
            <span className="relative flex items-center justify-center gap-2">
              <Smartphone className="h-3.5 w-3.5" />
              {longPressProgress > 0
                ? `Hold ${Math.ceil((1 - longPressProgress) * 3)}s...`
                : "Hold 3 seconds for discreet SOS"}
            </span>
          </button>
        )}
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


    </div>
  );
}
