import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, MessageSquare, Video, CheckCircle2, AlertTriangle, Clock, Users, Shield } from "lucide-react";
import type { WatchedUser } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

export default function WatchedPage() {
  const [, setLocation] = useLocation();

  const { data: watchedUsers, isLoading } = useQuery<WatchedUser[]>({
    queryKey: ["/api/watched-users"],
    refetchInterval: 30000,
  });

  function getStatusColor(user: WatchedUser) {
    if (user.hasOpenIncident) return "text-red-500";
    const now = new Date();
    const due = new Date(user.nextCheckinDue);
    if (now > due) return "text-amber-500";
    return "text-green-500";
  }

  function getStatusIcon(user: WatchedUser) {
    if (user.hasOpenIncident) return <AlertTriangle className="w-5 h-5 text-red-500" />;
    const now = new Date();
    const due = new Date(user.nextCheckinDue);
    if (now > due) return <Clock className="w-5 h-5 text-amber-500" />;
    return <CheckCircle2 className="w-5 h-5 text-green-500" />;
  }

  function getStatusText(user: WatchedUser) {
    if (user.hasOpenIncident) {
      return user.incidentReason === "sos" ? "SOS Alert Active" : "Missed Checkin Alert";
    }
    const now = new Date();
    const due = new Date(user.nextCheckinDue);
    if (now > due) return "Checkin overdue";
    return "OK";
  }

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
            <h1 className="text-xl font-semibold" data-testid="text-page-title">People I Watch</h1>
            <p className="text-sm text-muted-foreground">Monitor people who listed you as emergency contact</p>
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

        <div className="space-y-3">
          {watchedUsers?.map((user) => (
            <Card key={user.userId} data-testid={`card-watched-user-${user.userId}`}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Users className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-medium" data-testid={`text-user-name-${user.userId}`}>{user.userName}</h3>
                      <div className={`flex items-center gap-1.5 text-sm ${getStatusColor(user)}`}>
                        {getStatusIcon(user)}
                        <span data-testid={`text-user-status-${user.userId}`}>{getStatusText(user)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-muted-foreground mb-3">
                  {user.lastCheckinAt ? (
                    <span data-testid={`text-last-checkin-${user.userId}`}>
                      Last checkin: {formatDistanceToNow(new Date(user.lastCheckinAt), { addSuffix: true })}
                    </span>
                  ) : (
                    <span>No checkins yet</span>
                  )}
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
          ))}
        </div>
      </div>
    </div>
  );
}
