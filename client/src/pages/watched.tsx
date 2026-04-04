import { useState } from "react";
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
  ArrowLeft, MessageSquare, Phone, CheckCircle2, AlertTriangle, Clock,
  Shield, FileText, ChevronDown, ChevronUp, Heart, Mail, UserMinus, Undo2,
} from "lucide-react";
import type { WatchedUser, DailyStatus, ReportPreference, Contact } from "@shared/schema";
import { formatDistanceToNow, format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface RemovedContact extends Contact {
  ownerName: string;
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

  const { data: reportPrefs } = useQuery<ReportPreference[]>({
    queryKey: ["/api/reports/preferences"],
  });

  const { data: removedContacts } = useQuery<RemovedContact[]>({
    queryKey: ["/api/watched-users/removed"],
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

  function getStatusBadge(user: WatchedUser) {
    if (user.hasOpenIncident) {
      const label = user.incidentReason === "sos" ? "SOS Active" : "Missed Checkin";
      return <Badge variant="destructive" data-testid={`badge-status-${user.userId}`}>{label}</Badge>;
    }
    const now = new Date();
    const due = new Date(user.nextCheckinDue);
    if (now > due) {
      return <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" data-testid={`badge-status-${user.userId}`}>Overdue</Badge>;
    }
    return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" data-testid={`badge-status-${user.userId}`}>OK</Badge>;
  }

  function getStatusIcon(user: WatchedUser) {
    if (user.hasOpenIncident) return <AlertTriangle className="w-5 h-5 text-red-500" />;
    const now = new Date();
    const due = new Date(user.nextCheckinDue);
    if (now > due) return <Clock className="w-5 h-5 text-amber-500" />;
    return <CheckCircle2 className="w-5 h-5 text-green-500" />;
  }

  const activeAlerts = watchedUsers?.filter(u => u.hasOpenIncident) || [];
  const overdueUsers = watchedUsers?.filter(u => !u.hasOpenIncident && new Date() > new Date(u.nextCheckinDue)) || [];
  const okUsers = watchedUsers?.filter(u => !u.hasOpenIncident && new Date() <= new Date(u.nextCheckinDue)) || [];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-lg mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/")}
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-page-title">Watcher Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {watchedUsers ? `Monitoring ${watchedUsers.length} ${watchedUsers.length === 1 ? "person" : "people"}` : "Loading..."}
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isLoading && (!watchedUsers || watchedUsers.length === 0) && (
          <Card>
            <CardContent className="py-12 text-center">
              <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="font-medium text-lg mb-2" data-testid="text-empty-state">No one to watch yet</h3>
              <p className="text-muted-foreground text-sm">
                When someone adds your phone number as an emergency contact in StillHere, they'll appear here automatically.
              </p>
            </CardContent>
          </Card>
        )}

        {activeAlerts.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <span className="text-sm font-medium text-red-600 dark:text-red-400" data-testid="text-alerts-header">
                Active Alerts ({activeAlerts.length})
              </span>
            </div>
            <div className="space-y-3">
              {activeAlerts.map(user => renderUserCard(user))}
            </div>
          </div>
        )}

        {overdueUsers.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-medium text-amber-600 dark:text-amber-400" data-testid="text-overdue-header">
                Overdue ({overdueUsers.length})
              </span>
            </div>
            <div className="space-y-3">
              {overdueUsers.map(user => renderUserCard(user))}
            </div>
          </div>
        )}

        {okUsers.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="text-sm font-medium text-green-600 dark:text-green-400" data-testid="text-ok-header">
                All Clear ({okUsers.length})
              </span>
            </div>
            <div className="space-y-3">
              {okUsers.map(user => renderUserCard(user))}
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
                            Removed {formatDistanceToNow(deletedAt, { addSuffix: true })} - {daysLeft} {daysLeft === 1 ? "day" : "days"} to restore
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
              You will no longer receive their safety alerts, missed checkin notifications, or SOS messages. {confirmOptOut?.userName} will be notified that you have removed yourself. This can be reversed within 30 days.
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

    return (
      <Card key={user.userId} data-testid={`card-watched-user-${user.userId}`} className={user.hasOpenIncident ? "border-red-200 dark:border-red-800" : ""}>
        <CardContent className="py-4">
          <div className="flex items-start justify-between mb-3">
            <div
              className="flex items-center gap-3 cursor-pointer flex-1"
              onClick={() => setExpandedUser(isExpanded ? null : user.userId)}
              data-testid={`toggle-expand-${user.userId}`}
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                user.hasOpenIncident ? "bg-red-100 dark:bg-red-900/30" : "bg-primary/10"
              }`}>
                {getStatusIcon(user)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium" data-testid={`text-user-name-${user.userId}`}>{user.userName}</h3>
                  {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {getStatusBadge(user)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mb-3">
            <div className="flex items-center gap-1" data-testid={`text-last-checkin-${user.userId}`}>
              <Clock className="w-3 h-3" />
              {user.lastCheckinAt ? (
                <span>Last checkin: {formatDistanceToNow(new Date(user.lastCheckinAt), { addSuffix: true })}</span>
              ) : (
                <span>No checkins yet</span>
              )}
            </div>
            <div className="flex items-center gap-1" data-testid={`text-next-due-${user.userId}`}>
              <Clock className="w-3 h-3" />
              <span>Next due: {format(new Date(user.nextCheckinDue), "h:mm a")}</span>
            </div>
          </div>

          {isExpanded && <DailyStatusPanel userId={user.userId} />}

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
          </div>

          <div className="flex gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => setLocation(`/report/${user.userId}`)}
              data-testid={`button-report-${user.userId}`}
            >
              <FileText className="w-4 h-4 mr-1.5" />
              View Report
            </Button>
          </div>

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
              <span>{c.time} via {c.method}</span>
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
