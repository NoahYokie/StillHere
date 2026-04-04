import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Car, AlertTriangle, Gauge, MapPin, Clock } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { DriveSession, SpeedAlert } from "@shared/schema";

export default function DriveHistoryPage() {
  const [, setLocation] = useLocation();

  const { data: sessions = [], isLoading } = useQuery<DriveSession[]>({
    queryKey: ["/api/drive/history"],
  });

  const { data: alerts = [] } = useQuery<SpeedAlert[]>({
    queryKey: ["/api/drive/alerts"],
  });

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return "In progress";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    if (hours > 0) return `${hours}h ${mins % 60}m`;
    return `${mins}m`;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/")} data-testid="button-back-drive">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-lg font-semibold" data-testid="text-drive-history-title">Drive History</h1>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading drive history...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-12">
            <Car className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground" data-testid="text-no-drives">No drive sessions yet</p>
            <p className="text-sm text-muted-foreground mt-1">Start a drive session from the home screen</p>
          </div>
        ) : (
          sessions.map((session) => {
            const sessionAlerts = alerts.filter(a => a.sessionId === session.id);
            return (
              <Card key={session.id} data-testid={`card-drive-${session.id}`}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Car className="w-5 h-5 text-blue-500" />
                      <span className="font-medium" data-testid={`text-drive-date-${session.id}`}>
                        {format(new Date(session.startedAt), "MMM d, yyyy")}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      {session.crashDetected && (
                        <Badge variant="destructive" data-testid={`badge-crash-${session.id}`}>
                          <AlertTriangle className="w-3 h-3 mr-1" />
                          Crash
                        </Badge>
                      )}
                      {!session.endedAt && (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
                        <Gauge className="w-3 h-3" />
                        Max Speed
                      </div>
                      <p className="font-semibold" data-testid={`text-max-speed-${session.id}`}>
                        {Math.round(session.maxSpeedKmh)} km/h
                      </p>
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
                        <MapPin className="w-3 h-3" />
                        Distance
                      </div>
                      <p className="font-semibold" data-testid={`text-distance-${session.id}`}>
                        {session.distanceKm.toFixed(1)} km
                      </p>
                    </div>
                    <div>
                      <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1">
                        <Clock className="w-3 h-3" />
                        Duration
                      </div>
                      <p className="font-semibold" data-testid={`text-duration-${session.id}`}>
                        {formatDuration(session.startedAt as unknown as string, session.endedAt as unknown as string)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-3 pt-3 border-t text-sm text-muted-foreground">
                    <span>
                      {format(new Date(session.startedAt), "h:mm a")}
                      {session.endedAt && ` - ${format(new Date(session.endedAt), "h:mm a")}`}
                    </span>
                    {sessionAlerts.length > 0 && (
                      <span className="text-orange-500" data-testid={`text-alerts-count-${session.id}`}>
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
    </div>
  );
}
