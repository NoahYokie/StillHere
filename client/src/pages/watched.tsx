import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  MessageSquare, Phone, CheckCircle2, AlertTriangle, Clock,
  Shield, ShieldCheck, ShieldAlert, FileText, ChevronDown, ChevronUp, Heart, Mail, UserMinus, Undo2, Car,
  MapPin,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import type { WatchedUser, DailyStatus, ReportPreference, Contact } from "@shared/schema";
import { formatDistanceToNow, format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getSocket } from "@/lib/socket";
import { getViewerTimezone, formatDualTime, formatTimeForViewer, shouldShowDualTime } from "@/lib/timezone";
import { useToast } from "@/hooks/use-toast";
import { getWatcherInsight, getDeviceInfo, getEtaInfo, ConnectionBadge, LocationBadge, BatteryBadge, ConfidenceBadge, EtaBadge, TrustIndicator } from "@/components/watcher-status";
import { ConcernTimelinePanel } from "@/components/concern-resolution";
import { Hand } from "lucide-react";

interface RemovedContact extends Contact {
  ownerName: string;
}

interface WatcherRequest {
  contactId: string;
  ownerName: string;
  contactName: string;
  role: string;
  requestedAt: string | Date | null;
}

function WellnessCallBadge({ user }: { user: WatchedUser }) {
  if (user.wellnessCallStatus === "help") {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-50 dark:bg-red-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <Phone className="w-3.5 h-3.5 text-red-500" />
        <span className="text-xs text-red-600 dark:text-red-400">Pressed Need Help on call</span>
      </div>
    );
  }
  if (user.wellnessCallStatus === "no_response" && user.hasOpenIncident) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <Phone className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-xs text-amber-700 dark:text-amber-400">Called {user.wellnessCallAt ? formatDistanceToNow(new Date(user.wellnessCallAt), { addSuffix: true }) : ""} . No answer</span>
      </div>
    );
  }
  if (user.wellnessCallStatus === "voicemail_left" && user.hasOpenIncident) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <Phone className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-xs text-amber-700 dark:text-amber-400">Reached voicemail</span>
      </div>
    );
  }
  if (user.wellnessCallStatus === "failed" && user.hasOpenIncident) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <Phone className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-xs text-amber-700 dark:text-amber-400">Call could not connect</span>
      </div>
    );
  }
  if (user.reminderStage === "calling" && user.hasOpenIncident) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <Phone className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
        <span className="text-xs text-blue-700 dark:text-blue-400">Calling them now</span>
      </div>
    );
  }
  if (user.wellnessCallStatus === "safe") {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-50 dark:bg-green-950/30" data-testid={`badge-wellness-call-${user.userId}`}>
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
        <span className="text-xs text-green-700 dark:text-green-400">Confirmed safe by call</span>
      </div>
    );
  }
  return null;
}

function ClaimButton({ incidentId, userId }: { incidentId: string; userId: string }) {
  const { toast } = useToast();
  const claimMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/incidents/${incidentId}/claim`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      toast({ title: "You've got this", description: "We let other guardians know you're handling it." });
    },
    onError: (err: any) => {
      toast({ title: "Could not claim", description: err.message || "Someone else may already be handling this.", variant: "destructive" });
    },
  });

  return (
    <Button
      variant="default"
      size="sm"
      className="w-full mb-2 bg-primary"
      onClick={() => claimMutation.mutate()}
      disabled={claimMutation.isPending}
      data-testid={`button-claim-${userId}`}
    >
      <Hand className="w-4 h-4 mr-1.5" />
      {claimMutation.isPending ? "Claiming..." : "I've got this"}
    </Button>
  );
}

function DrillAcknowledgeButton({ drillId, userName, userId }: { drillId: string; userName: string; userId: string }) {
  const { toast } = useToast();
  const [acknowledged, setAcknowledged] = useState(false);
  const ackMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/safety-drill/${drillId}/acknowledge`, {});
      return res.json();
    },
    onSuccess: () => {
      setAcknowledged(true);
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      toast({ title: "You're ready", description: `We let ${userName} know you've got their back.` });
    },
    onError: (err: any) => {
      const msg = err.message || "";
      if (msg.includes("already acknowledged") || msg.includes("already confirmed")) {
        setAcknowledged(true);
        toast({ title: "Already confirmed", description: `${userName} already knows you've got their back.` });
        return;
      }
      toast({ title: "Could not confirm", description: msg || "Please try again.", variant: "destructive" });
    },
  });

  if (acknowledged) {
    return (
      <div className="p-2 rounded bg-green-50 dark:bg-green-950/30 text-xs text-green-700 dark:text-green-300 text-center" data-testid={`text-drill-acked-${userId}`}>
        <ShieldCheck className="w-4 h-4 inline mr-1" />
        You're ready. {userName} knows you've got their back.
      </div>
    );
  }

  return (
    <Button
      variant="default"
      size="sm"
      className="w-full bg-blue-600 hover:bg-blue-700"
      onClick={() => ackMutation.mutate()}
      disabled={ackMutation.isPending}
      data-testid={`button-drill-ack-${userId}`}
    >
      <ShieldCheck className="w-4 h-4 mr-1.5" />
      {ackMutation.isPending ? "Confirming..." : "I'm ready. Got you"}
    </Button>
  );
}

export default function WatchedPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [confirmOptOut, setConfirmOptOut] = useState<{ contactId: string; userName: string } | null>(null);

  const { data: watchedUsers, isLoading } = useQuery<WatchedUser[]>({
    queryKey: ["/api/watched-users"],
    refetchInterval: 15000,
  });

  useEffect(() => {
    const socket = getSocket();
    const handleInvalidate = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
    };
    socket.on("watched-users:invalidate", handleInvalidate);
    socket.on("concern:resolved", handleInvalidate);
    socket.on("incident:claimed", handleInvalidate);
    return () => {
      socket.off("watched-users:invalidate", handleInvalidate);
      socket.off("concern:resolved", handleInvalidate);
      socket.off("incident:claimed", handleInvalidate);
    };
  }, []);

  const { data: reportPrefs } = useQuery<ReportPreference[]>({
    queryKey: ["/api/reports/preferences"],
  });

  const { data: removedContacts } = useQuery<RemovedContact[]>({
    queryKey: ["/api/watched-users/removed"],
  });

  const { data: watcherRequests } = useQuery<{ requests: WatcherRequest[] }>({
    queryKey: ["/api/watcher-requests"],
    refetchInterval: 30000,
  });

  const acceptRequestMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watcher-requests/${contactId}/accept`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watcher-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      toast({ title: "Request accepted", description: "You can now see this person in your watcher dashboard." });
    },
    onError: (err: any) => {
      toast({ title: "Could not accept request", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  const declineRequestMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watcher-requests/${contactId}/decline`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watcher-requests"] });
      toast({ title: "Request declined" });
    },
    onError: (err: any) => {
      toast({ title: "Could not decline request", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  const optOutMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watched-users/${contactId}/opt-out`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users/removed"] });
      toast({ title: "You have been removed as an emergency contact" });
      setConfirmOptOut(null);
    },
    onError: () => {
      toast({ title: "Failed to remove", variant: "destructive" });
      setConfirmOptOut(null);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const res = await apiRequest("POST", `/api/watched-users/${contactId}/restore`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users/removed"] });
      toast({ title: "You are watching this person again" });
    },
    onError: () => {
      toast({ title: "Failed to restore", variant: "destructive" });
    },
  });

  const sortedUsers = (watchedUsers || []).slice().sort((a, b) => {
    const trustOrder = { worried: 0, watching: 1, safe: 2 };
    const aInsight = getWatcherInsight(a);
    const bInsight = getWatcherInsight(b);
    return (trustOrder[aInsight.trustLevel] ?? 2) - (trustOrder[bInsight.trustLevel] ?? 2);
  });

  const worriedUsers = sortedUsers.filter(u => getWatcherInsight(u).trustLevel === "worried");
  const watchingUsers = sortedUsers.filter(u => getWatcherInsight(u).trustLevel === "watching");
  const safeUsers = sortedUsers.filter(u => getWatcherInsight(u).trustLevel === "safe");

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <BackButton to="/" />
          <div className="flex-1">
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Watcher Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {watchedUsers ? `Watching ${watchedUsers.length} ${watchedUsers.length === 1 ? "person" : "people"}` : "Loading..."}
            </p>
          </div>
          {watchedUsers && watchedUsers.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation("/watched/map")}
              className="gap-2"
              data-testid="button-open-guardian-map"
            >
              <MapPin className="w-4 h-4" />
              Map
            </Button>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {(watcherRequests?.requests?.length || 0) > 0 && (
          <div className="mb-4 space-y-3" data-testid="section-watcher-requests">
            {watcherRequests!.requests.map((request) => (
              <Card key={request.contactId} className="border-primary/30">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">Safety Circle request</p>
                      <p className="text-sm text-muted-foreground">
                        {request.ownerName} asked you to be their StillHere contact. Accept only if you agree to see their safety status and receive alerts.
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => declineRequestMutation.mutate(request.contactId)}
                      disabled={declineRequestMutation.isPending || acceptRequestMutation.isPending}
                      data-testid={`button-decline-request-${request.contactId}`}
                    >
                      Decline
                    </Button>
                    <Button
                      onClick={() => acceptRequestMutation.mutate(request.contactId)}
                      disabled={declineRequestMutation.isPending || acceptRequestMutation.isPending}
                      data-testid={`button-accept-request-${request.contactId}`}
                    >
                      <CheckCircle2 className="w-4 h-4 mr-1.5" />
                      Accept
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!isLoading && (!watchedUsers || watchedUsers.length === 0) && !(watcherRequests?.requests?.length || 0) && (
          <Card>
            <CardContent className="py-12 text-center">
              <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-medium text-lg mb-2" data-testid="text-empty-state">No one to watch yet</h3>
              <p className="text-muted-foreground text-sm">
                When someone asks you to be in their Safety Circle, you can accept or decline here.
              </p>
            </CardContent>
          </Card>
        )}

        {worriedUsers.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-sm font-medium text-red-600 dark:text-red-400" data-testid="text-alerts-header">
                Needs Attention ({worriedUsers.length})
              </span>
            </div>
            <div className="space-y-3">
              {worriedUsers.map(user => renderUserCard(user))}
            </div>
          </div>
        )}

        {watchingUsers.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-medium text-amber-600 dark:text-amber-400" data-testid="text-watching-header">
                Keeping an Eye On ({watchingUsers.length})
              </span>
            </div>
            <div className="space-y-3">
              {watchingUsers.map(user => renderUserCard(user))}
            </div>
          </div>
        )}

        {safeUsers.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium text-green-600 dark:text-green-400" data-testid="text-ok-header">
                All Good ({safeUsers.length})
              </span>
            </div>
            <div className="space-y-3">
              {safeUsers.map(user => renderUserCard(user))}
            </div>
          </div>
        )}

        {removedContacts && removedContacts.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <UserMinus className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground" data-testid="text-removed-header">
                Removed ({removedContacts.length})
              </span>
            </div>
            <div className="space-y-3">
              {removedContacts.map(rc => {
                const deletedAt = rc.softDeletedAt ? new Date(rc.softDeletedAt) : new Date();
                const expiresAt = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
                const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
                return (
                  <Card key={rc.id} className="border-dashed opacity-75" data-testid={`card-removed-${rc.id}`}>
                    <CardContent className="py-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-sm" data-testid={`text-removed-name-${rc.id}`}>{rc.ownerName}</p>
                          <p className="text-xs text-muted-foreground">
                            Removed {formatDistanceToNow(deletedAt, { addSuffix: true })}. {daysLeft} {daysLeft === 1 ? "day" : "days"} to restore
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => restoreMutation.mutate(rc.id)}
                          disabled={restoreMutation.isPending}
                          data-testid={`button-restore-${rc.id}`}
                        >
                          <Undo2 className="w-4 h-4 mr-1" />
                          Restore
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={!!confirmOptOut} onOpenChange={(open) => !open && setConfirmOptOut(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-optout-title">Stop watching {confirmOptOut?.userName}?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-optout-description">
              You will no longer receive their safety alerts, missed checkin notifications, or SOS messages. We will attempt to let {confirmOptOut?.userName} know that you have removed yourself. This can be reversed within 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-optout-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmOptOut && optOutMutation.mutate(confirmOptOut.contactId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-optout-confirm"
            >
              {optOutMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  function renderUserCard(user: WatchedUser) {
    const isExpanded = expandedUser === user.userId;
    const userPref = reportPrefs?.find(p => p.watchedUserId === user.userId);
    const insight = getWatcherInsight(user);
    const device = getDeviceInfo(user);
    const eta = getEtaInfo(user);
    const hasLoc = user.lastLocationLat != null || user.lastHeartbeatLat != null;

    return (
      <Card key={user.userId} data-testid={`card-watched-user-${user.userId}`} className={`${insight.borderClass} transition-colors`}>
        <CardContent className="py-4">
          <div className="flex items-start gap-3 mb-3">
            <div
              className="cursor-pointer"
              onClick={() => setExpandedUser(isExpanded ? null : user.userId)}
              data-testid={`toggle-expand-${user.userId}`}
            >
              <TrustIndicator insight={insight} />
            </div>
            <div
              className="flex-1 cursor-pointer min-w-0"
              onClick={() => setExpandedUser(isExpanded ? null : user.userId)}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="font-medium truncate text-left hover:underline focus:outline-none focus-visible:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLocation(`/live-location/${user.userId}`);
                  }}
                  data-testid={`text-user-name-${user.userId}`}
                >
                  {user.userName}
                </button>
                {user.circleRole && (
                  <Badge variant="outline" className="text-[10px] capitalize shrink-0" data-testid={`badge-role-${user.userId}`}>{user.circleRole}</Badge>
                )}
                {user.isInLearningMode && (
                  <Badge variant="secondary" className="text-[10px] shrink-0">Learning</Badge>
                )}
                {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
              </div>
              <p className={`text-sm font-medium mt-0.5 ${insight.iconColor}`} data-testid={`text-headline-${user.userId}`}>
                {insight.headline}
              </p>
              <ContextLine userId={user.userId} fallback={insight.subtext} />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-3">
            <ConnectionBadge status={insight.connection.status} label={insight.connection.label} />
            <LocationBadge status={insight.location.status} label={insight.location.label} />
            <BatteryBadge device={device} />
            {eta && <EtaBadge eta={eta} />}
            <WellnessCallBadge user={user} />
          </div>

          <ConfidenceBadge device={device} />

          {user.sharingMode === "area" && hasLoc && (
            <div className="mb-2 p-2 rounded bg-blue-50 dark:bg-blue-950/30 text-xs text-blue-700 dark:text-blue-300 flex items-center gap-1.5" data-testid={`badge-area-mode-${user.userId}`}>
              <MapPin className="w-3 h-3" />
              {user.userName} is sharing their general area
            </div>
          )}

          {(insight.trustLevel === "worried" || user.safetyState === "concern") && (
            <>
              {user.incidentIsDrill && (
                <div className="mb-2 space-y-2">
                  <div className="p-2 rounded bg-blue-50 dark:bg-blue-950/30 text-xs text-blue-700 dark:text-blue-300 text-center" data-testid={`banner-drill-${user.userId}`}>
                    This is a safety drill. No real emergency.
                  </div>
                  {user.incidentId && <DrillAcknowledgeButton drillId={user.incidentId} userName={user.userName} userId={user.userId} />}
                </div>
              )}
              {user.incidentClaimedBy ? (
                <div className="mb-2 p-2 rounded bg-green-50 dark:bg-green-950/30 text-xs text-green-700 dark:text-green-300 text-center" data-testid={`text-claimed-${user.userId}`}>
                  {user.incidentClaimedBy} is handling this now. No action needed from you.
                </div>
              ) : user.hasOpenIncident && user.incidentId ? (
                <ClaimButton incidentId={user.incidentId} userId={user.userId} />
              ) : null}
              <ConcernTimelinePanel userId={user.userId} isWatcher={true} />
            </>
          )}

          {isExpanded && (
            <>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mb-3">
                <div className="flex items-center gap-1" data-testid={`text-last-checkin-${user.userId}`}>
                  <Clock className="w-3 h-3" />
                  {user.lastCheckinAt ? (
                    <span>Checked in {formatDistanceToNow(new Date(user.lastCheckinAt), { addSuffix: true })}</span>
                  ) : (
                    <span>No check-ins yet</span>
                  )}
                </div>
                <div className="flex items-center gap-1" data-testid={`text-next-due-${user.userId}`}>
                  <Clock className="w-3 h-3" />
                  <span>Next due: {formatDualTime(user.nextCheckinDue, user.userTimezone, getViewerTimezone())}</span>
                </div>
              </div>
              <ContextTimeline userId={user.userId} />
              <NotificationToggle userId={user.userId} />
              <DailyStatusPanel userId={user.userId} />
            </>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setLocation(`/chat/${user.userId}`)}
              data-testid={`button-message-${user.userId}`}
            >
              <MessageSquare className="w-4 h-4 mr-1.5" />
              Message
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setLocation(`/call/${user.userId}`)}
              data-testid={`button-call-${user.userId}`}
            >
              <Phone className="w-4 h-4 mr-1.5" />
              Call
            </Button>
            {hasLoc && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocation(`/live-location`)}
                data-testid={`button-location-${user.userId}`}
              >
                <MapPin className="w-4 h-4" />
              </Button>
            )}
          </div>

          <WeeklyReportPanel userId={user.userId} />

          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            onClick={() => setLocation(`/report/${user.userId}`)}
            data-testid={`button-full-report-${user.userId}`}
          >
            <FileText className="w-4 h-4 mr-1.5" />
            View complete safety report
          </Button>

          {isExpanded && (
            <>
              <ReportPreferencePanel userId={user.userId} existingPref={userPref} />
              <div className="border-t border-border mt-3 pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmOptOut({ contactId: user.contactId, userName: user.userName })}
                  data-testid={`button-stop-watching-${user.userId}`}
                >
                  <UserMinus className="w-4 h-4 mr-1.5" />
                  Stop watching
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  }
}

function DailyStatusPanel({ userId }: { userId: string }) {
  const { data: daily, isLoading } = useQuery<DailyStatus>({
    queryKey: ["/api/watched-users", userId, "daily"],
    queryFn: async () => {
      const res = await fetch(`/api/watched-users/${userId}/daily`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="py-2 mb-3 flex justify-center">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!daily) return null;

  return (
    <div className="bg-muted/50 rounded-lg p-3 mb-3 space-y-2" data-testid={`panel-daily-${userId}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Today's Status</span>
        {daily.checkedInToday ? (
          <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 text-xs" data-testid={`badge-today-${userId}`}>
            Checked in
          </Badge>
        ) : (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-xs" data-testid={`badge-today-${userId}`}>
            Not yet
          </Badge>
        )}
      </div>

      {daily.todayCheckins.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {daily.todayCheckins.map((c, i) => (
            <div key={i} className="flex items-center gap-2" data-testid={`today-checkin-${userId}-${i}`}>
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              <span>{formatTimeForViewer(c.time)} via {c.method}</span>
            </div>
          ))}
        </div>
      )}

      {daily.heartRate && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`hr-reading-${userId}`}>
          <Heart className="w-3 h-3 text-red-400" />
          <span>{daily.heartRate.bpm} BPM</span>
        </div>
      )}

      {daily.hasOpenIncident && (
        <div className="flex items-center gap-1.5 text-xs text-red-500" data-testid={`incident-status-${userId}`}>
          <AlertTriangle className="w-3 h-3" />
          <span>{daily.incidentReason === "sos" ? "Active SOS alert" : "Active missed checkin alert"}</span>
        </div>
      )}
    </div>
  );
}

function ReportPreferencePanel({ userId, existingPref }: { userId: string; existingPref?: ReportPreference }) {
  const { toast } = useToast();
  const [frequency, setFrequency] = useState(existingPref?.frequency || "weekly");
  const [enabled, setEnabled] = useState(existingPref?.enabled !== false);
  const [email, setEmail] = useState(existingPref?.email || "");
  const [synced, setSynced] = useState(false);

  if (existingPref && !synced) {
    setFrequency(existingPref.frequency);
    setEnabled(existingPref.enabled);
    setEmail(existingPref.email || "");
    setSynced(true);
  }

  const saveMutation = useMutation({
    mutationFn: async (data: { frequency: string; enabled: boolean; email: string | null }) => {
      const res = await apiRequest("PUT", `/api/reports/preferences/${userId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports/preferences"] });
      toast({ title: "Report preferences saved" });
    },
    onError: () => {
      toast({ title: "Failed to save preferences", variant: "destructive" });
    },
  });

  function handleToggle(checked: boolean) {
    setEnabled(checked);
    saveMutation.mutate({ frequency, enabled: checked, email: email || null });
  }

  return (
    <div className="border-t border-border mt-3 pt-3 space-y-3" data-testid={`panel-report-pref-${userId}`}>
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5" />
          Scheduled reports
        </Label>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          data-testid={`switch-report-enabled-${userId}`}
        />
      </div>

      {enabled && (
        <>
          <div>
            <Label className="text-xs text-muted-foreground">Frequency</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as "daily" | "weekly" | "fortnightly" | "monthly")}>
              <SelectTrigger className="mt-1" data-testid={`select-report-freq-${userId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="fortnightly">Every 2 weeks</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground flex items-center gap-1">
              <Mail className="w-3 h-3" />
              Email for reports
            </Label>
            <Input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1"
              data-testid={`input-report-email-${userId}`}
            />
          </div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate({ frequency, enabled, email: email || null })}
            disabled={saveMutation.isPending}
            className="w-full"
            data-testid={`button-save-report-pref-${userId}`}
          >
            {saveMutation.isPending ? "Saving..." : "Save Report Preferences"}
          </Button>
        </>
      )}
    </div>
  );
}

interface ContextData {
  currentState: string;
  contextLine: string;
  timeline?: Array<{ type: string; time: string; placeName: string | null; detail: string }>;
}

function ContextLine({ userId, fallback }: { userId: string; fallback: string }) {
  const { data } = useQuery<ContextData>({
    queryKey: ["/api/context", userId],
    refetchInterval: 30000,
  });

  const line = data?.contextLine || fallback;
  if (!line) return null;

  return (
    <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-context-${userId}`}>
      {line}
    </p>
  );
}

function ContextTimeline({ userId }: { userId: string }) {
  const { data } = useQuery<ContextData>({
    queryKey: ["/api/context", userId],
    refetchInterval: 30000,
  });

  const timeline = data?.timeline;
  if (!timeline || timeline.length === 0) return null;

  return (
    <div className="mb-3" data-testid={`context-timeline-${userId}`}>
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Recent Activity</p>
      <div className="space-y-1.5">
        {timeline.slice(-8).map((event, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              event.type === "trip_end" ? "bg-green-500" :
              event.type === "dwell_end" || event.type === "trip_start" ? "bg-blue-500" :
              event.type === "dwell_start" ? "bg-green-500" :
              "bg-amber-500"
            }`} />
            <span className="truncate">{event.detail}</span>
            <span className="ml-auto shrink-0 tabular-nums">
              {formatTimeForViewer(event.time)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NotificationToggle({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery<{ arrivalNotifications: boolean }>({
    queryKey: ["/api/notification-prefs", userId],
  });

  const mutation = useMutation({
    mutationFn: async (arrivalNotifications: boolean) => {
      await apiRequest("PUT", `/api/notification-prefs/${userId}`, { arrivalNotifications });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notification-prefs", userId] });
    },
  });

  if (isLoading) return null;

  return (
    <div className="flex items-center justify-between mb-3 py-2 border-t border-border" data-testid={`notif-prefs-${userId}`}>
      <div>
        <p className="text-xs font-medium">Arrival notifications</p>
        <p className="text-xs text-muted-foreground">We'll try to notify you when they arrive</p>
      </div>
      <Switch
        checked={data?.arrivalNotifications ?? true}
        onCheckedChange={(checked) => mutation.mutate(checked)}
        disabled={mutation.isPending}
        data-testid={`toggle-arrival-notif-${userId}`}
      />
    </div>
  );
}

interface WatcherWeeklyReport {
  summaryTone: "good" | "mixed" | "concern";
  summary: string;
  timeline: { text: string; time: string }[];
  weekStart: string;
  weekEnd: string;
  totalCheckins: number;
  userName: string;
}

const weeklyToneConfig = {
  good: {
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    border: "border-emerald-200 dark:border-emerald-800",
    accent: "text-emerald-700 dark:text-emerald-400",
    iconBg: "bg-emerald-100 dark:bg-emerald-900/50",
    icon: ShieldCheck,
    label: "All Clear",
    dot: "bg-emerald-500",
  },
  mixed: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border: "border-amber-200 dark:border-amber-800",
    accent: "text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-100 dark:bg-amber-900/50",
    icon: Shield,
    label: "Some Activity",
    dot: "bg-amber-500",
  },
  concern: {
    bg: "bg-red-50 dark:bg-red-950/30",
    border: "border-red-200 dark:border-red-800",
    accent: "text-red-700 dark:text-red-400",
    iconBg: "bg-red-100 dark:bg-red-900/50",
    icon: ShieldAlert,
    label: "Needs Attention",
    dot: "bg-red-500",
  },
};

function getWeeklyTimelineIcon(text: string) {
  if (text.includes("SOS") || text.includes("Crash")) return AlertTriangle;
  if (text.includes("Push")) return Shield;
  if (text.includes("SMS") || text.includes("text")) return Shield;
  if (text.includes("call") || text.includes("Call") || text.includes("voicemail")) return Shield;
  if (text.includes("contact") || text.includes("Safety Circle")) return ShieldAlert;
  if (text.includes("Missed") || text.includes("expired") || text.includes("Late")) return Clock;
  if (text.includes("Arrived") || text.includes("Left")) return MapPin;
  if (text.includes("Confirmed") || text.includes("Resolved")) return CheckCircle2;
  return Shield;
}

function getWeeklyTimelineColor(text: string) {
  if (text.includes("SOS") || text.includes("Crash")) return "text-red-500";
  if (text.includes("Push")) return "text-blue-500";
  if (text.includes("SMS") || text.includes("text")) return "text-green-500";
  if (text.includes("call") || text.includes("Call") || text.includes("voicemail")) return "text-purple-500";
  if (text.includes("contact") || text.includes("Safety Circle")) return "text-orange-500";
  if (text.includes("Missed") || text.includes("expired") || text.includes("Late") || text.includes("Awaiting")) return "text-amber-500";
  if (text.includes("Arrived") || text.includes("Left") || text.includes("trip")) return "text-blue-500";
  if (text.includes("Confirmed") || text.includes("Resolved")) return "text-emerald-500";
  return "text-gray-500";
}

function WeeklyReportPanel({ userId }: { userId: string }) {
  const { data: report, isLoading } = useQuery<WatcherWeeklyReport>({
    queryKey: ["/api/reports", userId, "weekly"],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${userId}/weekly`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="py-2 mt-2 flex justify-center">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!report) return null;

  const tone = weeklyToneConfig[report.summaryTone];
  const ToneIcon = tone.icon;
  const weekStart = new Date(report.weekStart);
  const weekEnd = new Date(report.weekEnd);
  const dateRange = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div className={`rounded-xl border ${tone.border} ${tone.bg} p-3 mt-2`} data-testid={`panel-weekly-report-${userId}`}>
      <div className="flex items-start gap-3 mb-2">
        <div className={`p-2 rounded-lg ${tone.iconBg} shrink-0`}>
          <ToneIcon className={`w-5 h-5 ${tone.accent}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-semibold uppercase tracking-wide ${tone.accent}`} data-testid={`text-weekly-tone-${userId}`}>
              {tone.label}
            </span>
            <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
            <span className="text-[11px] text-muted-foreground ml-auto">{dateRange}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid={`text-weekly-summary-${userId}`}>
            {report.summary}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
        <span>{report.totalCheckins} check-in{report.totalCheckins !== 1 ? "s" : ""} this week</span>
      </div>

      {report.timeline.length > 0 && (
        <div className="space-y-0 mt-2">
          {report.timeline.slice(0, 5).map((item, i) => {
            const Icon = getWeeklyTimelineIcon(item.text);
            const colorClass = getWeeklyTimelineColor(item.text);
            const isLast = i === Math.min(report.timeline.length, 5) - 1;
            return (
              <div key={i} className="flex gap-2" data-testid={`weekly-timeline-${userId}-${i}`}>
                <div className="flex flex-col items-center">
                  <div className="p-1 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                    <Icon className={`w-3 h-3 ${colorClass}`} />
                  </div>
                  {!isLast && <div className="w-px h-full min-h-[20px] bg-gray-200 dark:bg-gray-700 my-0.5" />}
                </div>
                <div className="pb-2 min-w-0">
                  <p className="text-xs font-medium text-foreground leading-snug">{item.text}</p>
                  <p className="text-[11px] text-muted-foreground">{item.time}</p>
                </div>
              </div>
            );
          })}
          {report.timeline.length > 5 && (
            <p className="text-[11px] text-muted-foreground text-center pt-1">
              +{report.timeline.length - 5} more event{report.timeline.length - 5 !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      )}

      {report.timeline.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          <span>A quiet week, no events to report</span>
        </div>
      )}
    </div>
  );
}
