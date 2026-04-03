import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MessageSquare, Video, CheckCircle2, AlertTriangle, Clock, Users, Shield, Heart, MapPin, Phone } from "lucide-react";
import type { WatchedUser } from "@shared/schema";
import { formatDistanceToNow, format } from "date-fns";

export default function WatchedPage() {
  const [, setLocation] = useLocation();

  const { data: watchedUsers, isLoading } = useQuery<WatchedUser[]>({
    queryKey: ["/api/watched-users"],
    refetchInterval: 15000,
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
      </div>
    </div>
  );

  function renderUserCard(user: WatchedUser) {
    return (
      <Card key={user.userId} data-testid={`card-watched-user-${user.userId}`} className={user.hasOpenIncident ? "border-red-200 dark:border-red-800" : ""}>
        <CardContent className="py-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                user.hasOpenIncident ? "bg-red-100 dark:bg-red-900/30" : "bg-primary/10"
              }`}>
                {getStatusIcon(user)}
              </div>
              <div>
                <h3 className="font-medium" data-testid={`text-user-name-${user.userId}`}>{user.userName}</h3>
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
              <Video className="w-4 h-4 mr-1.5" />
              Video Call
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
}
