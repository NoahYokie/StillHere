import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Phone, MessageSquare, CheckCircle2, AlertTriangle, MapPin, Clock, User, Navigation, Bell, MessageCircleMore, PhoneCall, Shield, Smartphone, Sparkles } from "lucide-react";
import logoPath from "@assets/F0BE7587-0A49-40F7-A9A8-E7C53E58260F_1777863919813.png";
import type { ContactPageData } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import GoogleMap from "@/components/google-map";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { formatDualTime, getViewerTimezone } from "@/lib/timezone";

export default function ContactPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  useDocumentMeta({ noindex: true });
  const viewerTimezone = getViewerTimezone();
  const [showHandleConfirm, setShowHandleConfirm] = useState(false);
  const [showEscalateConfirm, setShowEscalateConfirm] = useState(false);
  const [address, setAddress] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<ContactPageData>({
    queryKey: ["/api/emergency", token],
  });

  const locationLat = data?.locationSession?.lastLat ?? data?.lastCheckin?.lat ?? null;
  const locationLng = data?.locationSession?.lastLng ?? data?.lastCheckin?.lng ?? null;
  const locationIsLive = !!(data?.locationSession?.active && data?.locationSession?.lastLat);
  const locationTimestamp = data?.locationSession?.lastTimestamp ?? data?.lastCheckin?.createdAt ?? null;

  useEffect(() => {
    if (locationLat && locationLng) {
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${locationLat}&lon=${locationLng}`)
        .then(res => res.json())
        .then(result => {
          if (result.display_name) {
            setAddress(result.display_name);
          }
        })
        .catch(() => {
          setAddress(null);
        });
    }
  }, [locationLat, locationLng]);

  const handleMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/emergency/${token}/handle`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/emergency", token] });
      toast({
        title: "You're handling this",
        description: "We've paused further alerts while you check on them.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not update status. Please try again.",
        variant: "destructive",
      });
    },
  });

  const escalateMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/emergency/${token}/escalate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/emergency", token] });
      toast({
        title: "Alert escalated",
        description: "We will continue notifying other contacts.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Could not escalate. Please try again.",
        variant: "destructive",
      });
    },
  });

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

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Invalid or Expired Link</h2>
            <p className="text-muted-foreground">
              This contact link is no longer valid. Please contact the person directly.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Post-resolution privacy guard: a watcher tapped an alert-era link AFTER
  // the incident was resolved. We strip location, last check-in, and live
  // share, and show a plain confirmation. The fresh all-clear link sent in
  // the resolution SMS handles the "they're safe" receipt separately.
  if (data.mode === "resolved") {
    const resolvedTime = data.resolvedAt
      ? formatDualTime(data.resolvedAt, data.user.timezone || viewerTimezone, viewerTimezone)
      : null;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 py-12" data-testid="page-resolved">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-accent" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold mb-2" data-testid="text-resolved-title">This alert has been resolved.</h2>
              {resolvedTime && (
                <p className="text-base text-muted-foreground" data-testid="text-resolved-summary">
                  {data.user.name} confirmed they are safe at {resolvedTime}. No further action is needed.
                </p>
              )}
            </div>
            <div className="text-xs text-muted-foreground border-t pt-4">
              For privacy, live status is no longer shown on this link. Open the StillHere app to view current status.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Resolution-receipt mode: minimal "they're safe" page with no location,
  // no history, and no actions. Triggered when the link came from an all-clear SMS.
  if (data.mode === "allclear") {
    const resolvedTime = data.resolvedAt
      ? formatDualTime(data.resolvedAt, data.user.timezone || viewerTimezone, viewerTimezone)
      : null;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 py-12" data-testid="page-allclear">
        <Card className="max-w-md w-full border-accent/30">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-accent" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold mb-1">All clear</h2>
              <p className="text-base text-muted-foreground" data-testid="text-allclear-summary">
                {data.user.name} confirmed they are safe{resolvedTime ? ` at ${resolvedTime}` : ""}. No action is needed.
              </p>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-4">
              This is a read-only confirmation. Open the StillHere app for live status during future check-ins.
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { user, contact, lastCheckin, incident, locationSession, handlingContact, safetyTimer, safeWalk, crashDrive, tripTrail } = data;
  const hasActiveIncident = incident && incident.status !== "resolved";
  const isBeingHandled = incident?.status === "paused" && handlingContact;
  const isMissedCheckin = incident?.reason === "missed_checkin";
  const isSOS = incident?.reason === "sos";
  const hasTrip = safetyTimer || safeWalk || crashDrive;
  const trailPoints = (tripTrail || []).map((p: any) => ({ lat: p.lat, lng: p.lng, activity: p.activity, timestamp: p.recordedAt?.toString() }));

  const getStatusColor = () => {
    if (isSOS) return "text-destructive";
    if (hasActiveIncident && !isBeingHandled) return "text-yellow-600 dark:text-yellow-500";
    if (isBeingHandled) return "text-primary";
    return "text-accent";
  };

  const getStatusText = () => {
    if (isSOS) return "Help requested";
    if (isBeingHandled) return `${handlingContact?.name} is checking on them`;
    if (hasActiveIncident) return "Pending";
    return "OK";
  };

  return (
    <div className="min-h-screen bg-background pb-12">
      {/* Header */}
      <header className="bg-primary text-primary-foreground px-6 py-4">
        <div className="max-w-md mx-auto flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2" data-testid="text-app-title">
              <img src={logoPath} alt="StillHere" className="h-8 w-8 object-contain" />
              <span className="text-xl font-semibold">StillHere</span>
            </div>
            <p className="text-sm opacity-90" data-testid="text-status-for">
              Status for {user.name}
            </p>
          </div>
          <span className="text-[10px] uppercase tracking-wide bg-white/15 px-2 py-1 rounded font-medium whitespace-nowrap mt-1" data-testid="badge-no-login">
            No login needed
          </span>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        {/* High-contrast Alert Banner — dominates the screen so it's impossible to miss */}
        {hasActiveIncident && !isBeingHandled && (
          <>
            <div
              className={`rounded-2xl p-6 shadow-xl ${isSOS ? "bg-red-600 text-white" : "bg-amber-500 text-white"}`}
              data-testid="banner-alert"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-8 w-8 flex-shrink-0 mt-0.5" strokeWidth={2.5} />
                <div className="flex-1">
                  <p className="text-2xl font-bold leading-tight">
                    {isSOS ? "Help has been requested" : "Missed check-in"}
                  </p>
                  <p className="text-base font-medium mt-2 opacity-95">
                    {isSOS
                      ? `${user.name} pressed the emergency button.`
                      : `${user.name} hasn't checked in as expected.`}
                  </p>
                </div>
              </div>
            </div>

            {/* What to do next guidance — bold dark text, clear numbered chips */}
            <div className="bg-white dark:bg-gray-900 border-2 border-gray-900 dark:border-gray-100 rounded-2xl p-5" data-testid="guidance-next-steps">
              <p className="text-base font-bold mb-3 text-gray-900 dark:text-gray-100 uppercase tracking-wide">What to do next</p>
              <ol className="space-y-3">
                {[
                  "Try calling them",
                  "If no answer, send them a text",
                  "If still no response, call emergency services",
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-bold flex items-center justify-center shrink-0 text-sm">{i + 1}</span>
                    <span className="text-base font-semibold text-gray-900 dark:text-gray-100 pt-1">{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Escalation Timeline */}
            {incident?.escalationTimeline && (() => {
              let timeline: { type: string; time: string; detail: string }[] = [];
              try { timeline = JSON.parse(incident.escalationTimeline); } catch {}
              if (timeline.length === 0) return null;

              const getIcon = (type: string) => {
                switch (type) {
                  case "push": return <Bell className="h-3.5 w-3.5" />;
                  case "sms": return <MessageCircleMore className="h-3.5 w-3.5" />;
                  case "call": case "call_failed": return <PhoneCall className="h-3.5 w-3.5" />;
                  case "contact_alert": case "contact_escalation": return <Shield className="h-3.5 w-3.5" />;
                  default: return <Clock className="h-3.5 w-3.5" />;
                }
              };

              const getColor = (type: string) => {
                switch (type) {
                  case "push": return "text-blue-600 bg-blue-100 dark:bg-blue-900/40 dark:text-blue-400";
                  case "sms": return "text-green-600 bg-green-100 dark:bg-green-900/40 dark:text-green-400";
                  case "call": return "text-purple-600 bg-purple-100 dark:bg-purple-900/40 dark:text-purple-400";
                  case "call_failed": return "text-red-600 bg-red-100 dark:bg-red-900/40 dark:text-red-400";
                  case "contact_alert": case "contact_escalation": return "text-orange-600 bg-orange-100 dark:bg-orange-900/40 dark:text-orange-400";
                  default: return "text-muted-foreground bg-muted";
                }
              };

              return (
                <Card className="mt-4">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      What we tried before contacting you
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {timeline.map((entry, i) => (
                        <div key={i} className="flex items-start gap-3" data-testid={`timeline-entry-${i}`}>
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${getColor(entry.type)}`}>
                            {getIcon(entry.type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{entry.detail}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDualTime(entry.time, user.timezone || viewerTimezone, viewerTimezone)}
                              {" \u2022 "}
                              {new Date(entry.time).toLocaleDateString([], { month: "short", day: "numeric" })}
                            </p>
                          </div>
                          {i < timeline.length - 1 && (
                            <span className="text-xs text-muted-foreground whitespace-nowrap">No response</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}
          </>
        )}

        {/* Status Card — only show when no active alert (the alert banner is the headline otherwise) */}
        {!(hasActiveIncident && !isBeingHandled) && (
          <Card className="border-2">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                  <User className="h-7 w-7 text-muted-foreground" />
                </div>
                <div>
                  <CardTitle className="text-xl font-bold" data-testid="text-user-name">{user.name}</CardTitle>
                  <CardDescription className="text-sm font-medium">
                    Last check-in:{" "}
                    <span data-testid="text-last-checkin">
                      {lastCheckin
                        ? formatDistanceToNow(new Date(lastCheckin.createdAt), { addSuffix: true })
                        : "Never"}
                    </span>
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Status:</span>
                <span className={`text-base font-bold ${getStatusColor()}`} data-testid="text-status">
                  {getStatusText()}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {hasTrip && (
          <Card className={crashDrive ? "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20" : "border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20"}>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                {crashDrive ? <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5 text-red-600" /> : <Clock className="h-5 w-5 flex-shrink-0 mt-0.5 text-orange-600" />}
                <div>
                  <p className={`font-medium ${crashDrive ? "text-red-700 dark:text-red-400" : "text-orange-700 dark:text-orange-400"}`}>
                    {crashDrive ? "Crash Detected" : safetyTimer ? "Safety Timer Expired" : "Safe Walk Overdue"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {crashDrive
                      ? `A crash was detected during ${user.name}'s drive. Max speed: ${Math.round(crashDrive.maxSpeedKmh)} km/h, Distance: ${crashDrive.distanceKm.toFixed(1)} km.`
                      : safetyTimer
                      ? `${user.name} set a safety timer${safetyTimer.note ? ` (${safetyTimer.note})` : ""} and did not check back in.`
                      : `${user.name} was heading${safeWalk?.destinationName ? ` to ${safeWalk.destinationName}` : ""} and has not arrived.`}
                  </p>
                </div>
              </div>

              {trailPoints.length > 0 && (
                <div className="mt-4">
                  <GoogleMap
                    center={trailPoints[trailPoints.length - 1]}
                    points={trailPoints}
                    zoom={14}
                    className="w-full h-48"
                    showTrail={true}
                    markerLabel="Last position"
                  />
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-gray-400" />Stationary</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500" />Walking</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-orange-500" />Running</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-blue-500" />Cycling</span>
                    <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-purple-500" />Driving</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Location Map */}
        {locationLat && locationLng && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <MapPin className="h-5 w-5" />
                {locationIsLive ? "Live location" : "Last known location"}
              </CardTitle>
              <CardDescription className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {locationTimestamp
                  ? formatDistanceToNow(new Date(locationTimestamp), { addSuffix: true })
                  : "Unknown"}
                {locationIsLive && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    Live
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <GoogleMap
                center={{ lat: locationLat, lng: locationLng }}
                zoom={15}
                className="w-full h-56"
                markerLabel={user.name}
                showStreetView={true}
                showMapTypeControl={true}
              />
              {address && (
                <p className="text-sm text-foreground mt-3" data-testid="text-address">
                  {address}
                </p>
              )}
              <Button
                variant="default"
                size="lg"
                className="w-full mt-3 gap-2"
                asChild
                data-testid="button-navigate"
              >
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${locationLat},${locationLng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Navigation className="h-5 w-5" />
                  Get Directions in Google Maps
                </a>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Contact Actions — bold and high-contrast */}
        <div className="space-y-3">
          <Button
            size="lg"
            className="w-full justify-center gap-3 h-14 text-base font-bold bg-green-600 hover:bg-green-700 text-white shadow-md"
            asChild
            data-testid="button-call"
          >
            <a href={`tel:${user.phone || ""}`}>
              <Phone className="h-6 w-6" strokeWidth={2.5} />
              Call {user.name}
            </a>
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full justify-center gap-3 h-14 text-base font-bold border-2 border-gray-900 dark:border-gray-100 text-gray-900 dark:text-gray-100"
            asChild
            data-testid="button-message"
          >
            <a href={`sms:${user.phone || ""}`}>
              <MessageSquare className="h-6 w-6" strokeWidth={2.5} />
              Message {user.name}
            </a>
          </Button>
        </div>

        {/* Action Buttons */}
        {hasActiveIncident && !isBeingHandled && (
          <div className="space-y-3">
            <Button
              size="lg"
              className="w-full"
              onClick={() => setShowHandleConfirm(true)}
              disabled={handleMutation.isPending}
              data-testid="button-handling"
            >
              <CheckCircle2 className="h-5 w-5 mr-2" />
              I'm handling this
            </Button>

            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => setShowEscalateConfirm(true)}
              disabled={escalateMutation.isPending}
              data-testid="button-escalate"
            >
              I can't reach them
            </Button>
          </div>
        )}

        {/* Already Being Handled */}
        {isBeingHandled && (
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-primary">Being handled</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {handlingContact?.name} is checking on {user.name}.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Get the App promo */}
        <Card className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border-primary/30" data-testid="card-get-app">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-11 h-11 rounded-xl bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0">
                <Smartphone className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-base" data-testid="text-get-app-title">Help faster with StillHere</h3>
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  This link works without an account. The app gives you faster alerts and a clearer way to support {user.name}.
                </p>
              </div>
            </div>

            <ul className="space-y-2 mb-4 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                <span><strong>Instant push alerts</strong> when something needs attention.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                <span><strong>Live status</strong> with location, directions, and safety updates in one place.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                <span><strong>One-tap response</strong> so other contacts know when you are checking on them.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                <span><strong>Safety reports</strong> that show what StillHere tried before contacts were alerted.</span>
              </li>
            </ul>

            <Button
              size="lg"
              className="w-full"
              asChild
              data-testid="button-install-app"
            >
              <a href="/" target="_blank" rel="noopener noreferrer">
                Install StillHere (free)
              </a>
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-3">
              Free to install. You'll be added automatically as {user.name}'s contact when you sign in.
            </p>
          </CardContent>
        </Card>

      </main>

      {/* Handle Confirmation Dialog */}
      <AlertDialog open={showHandleConfirm} onOpenChange={setShowHandleConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>I'm handling this</AlertDialogTitle>
            <AlertDialogDescription>
              We'll pause alerts while you check on them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-handle-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                handleMutation.mutate();
                setShowHandleConfirm(false);
              }}
              data-testid="button-handle-confirm"
            >
              I'm handling this
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Escalate Confirmation Dialog */}
      <AlertDialog open={showEscalateConfirm} onOpenChange={setShowEscalateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>I can't reach them</AlertDialogTitle>
            <AlertDialogDescription>
              We'll continue notifying other contacts.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-escalate-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                escalateMutation.mutate();
                setShowEscalateConfirm(false);
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-escalate-confirm"
            >
              Escalate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
