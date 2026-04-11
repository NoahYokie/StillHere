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
import { Phone, MessageSquare, CheckCircle2, AlertTriangle, MapPin, Clock, User, Navigation, Bell, MessageCircleMore, PhoneCall, Shield } from "lucide-react";
import type { ContactPageData } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import GoogleMap from "@/components/google-map";

export default function ContactPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
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
        <div className="max-w-md mx-auto">
          <h1 className="text-xl font-semibold" data-testid="text-app-title">StillHere</h1>
          <p className="text-sm opacity-90" data-testid="text-status-for">
            Status for {user.name}
          </p>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-6 space-y-6">
        {/* Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <User className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <CardTitle className="text-lg" data-testid="text-user-name">{user.name}</CardTitle>
                <CardDescription>
                  Last checkin:{" "}
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
              <span className="text-sm text-muted-foreground">Status:</span>
              <span className={`font-medium ${getStatusColor()}`} data-testid="text-status">
                {getStatusText()}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Alert Banner */}
        {hasActiveIncident && !isBeingHandled && (
          <>
            <Card className={isSOS ? "bg-destructive/10 border-destructive/30" : "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800"}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertTriangle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${isSOS ? "text-destructive" : "text-yellow-600 dark:text-yellow-500"}`} />
                  <div>
                    <p className={`font-medium ${isSOS ? "text-destructive" : "text-yellow-700 dark:text-yellow-400"}`}>
                      {isSOS ? "Help has been requested" : "Missed checkin"}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {isSOS
                        ? `${user.name} pressed the emergency button.`
                        : `${user.name} hasn't checked in as expected.`}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* What to do next guidance */}
            <div className="bg-muted/50 rounded-lg p-4 mt-4" data-testid="guidance-next-steps">
              <p className="text-sm font-medium mb-2">What to do next:</p>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Try calling them</li>
                <li>If no answer, send them a text message</li>
                <li>If still no response, call local emergency services</li>
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
                              {new Date(entry.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })}
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

        {/* Contact Actions */}
        <div className="space-y-3">
          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start gap-3"
            asChild
            data-testid="button-call"
          >
            <a href={`tel:${user.phone || ""}`}>
              <Phone className="h-5 w-5" />
              Call {user.name}
            </a>
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start gap-3"
            asChild
            data-testid="button-message"
          >
            <a href={`sms:${user.phone || ""}`}>
              <MessageSquare className="h-5 w-5" />
              Message {user.name}
            </a>
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full justify-start gap-3"
            asChild
            data-testid="button-in-app-chat"
          >
            <a href={`/chat/${user.id}`}>
              <MessageSquare className="h-5 w-5 text-primary" />
              In-App Chat with {user.name}
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
