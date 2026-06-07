import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertTriangle, CheckCircle2, Clock, Bell, MessageSquare, Phone,
  ShieldCheck, Loader2,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatTimeForViewer } from "@/lib/timezone";
import { useToast } from "@/hooks/use-toast";
import { getIncidentDisplayState, isResolvedDisplayState } from "@/lib/incident-display-state";

interface TimelineEntry {
  type: string;
  time: string;
  detail: string;
}

interface ConcernTimelineData {
  userId: string;
  userName: string;
  safetyState: string;
  safetyStateReason: string | null;
  safetyStateChangedAt: string | null;
  lastHeartbeatAt: string | null;
  incident: {
    id: string;
    status: string;
    reason: string;
    startedAt: string;
    resolvedAt: string | null;
  } | null;
  timeline: TimelineEntry[];
}

function getTimelineIcon(type: string) {
  switch (type) {
    case "state_change": return <AlertTriangle className="w-3.5 h-3.5 text-red-500" />;
    case "push": return <Bell className="w-3.5 h-3.5 text-blue-500" />;
    case "sms": return <MessageSquare className="w-3.5 h-3.5 text-green-500" />;
    case "call": return <Phone className="w-3.5 h-3.5 text-purple-500" />;
    case "incident": return <AlertTriangle className="w-3.5 h-3.5 text-red-600" />;
    default: return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

function getTimelineLabel(entry: TimelineEntry): string {
  switch (entry.type) {
    case "push": return "Notification sent";
    case "sms": return "SMS sent";
    case "call": return "Call attempted";
    case "state_change": return entry.detail;
    case "incident": return entry.detail;
    default: return entry.detail;
  }
}

export function ConcernTimelinePanel({ userId, isWatcher }: { userId: string; isWatcher: boolean }) {
  const { toast } = useToast();
  const [justResolved, setJustResolved] = useState(false);
  const [resolvedBy, setResolvedBy] = useState<string | null>(null);
  const [resolvedAt, setResolvedAt] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ConcernTimelineData>({
    queryKey: ["/api/concern/timeline", userId],
    queryFn: async () => {
      const res = await fetch(`/api/concern/timeline/${userId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const resolveSelfMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/concern/resolve");
      return res.json();
    },
    onSuccess: () => {
      setJustResolved(true);
      setResolvedBy("you");
      setResolvedAt(new Date().toISOString());
      queryClient.invalidateQueries({ queryKey: ["/api/concern/timeline", userId] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "You're marked as safe" });
    },
    onError: () => {
      toast({ title: "Something went wrong", variant: "destructive" });
    },
  });

  const resolveWatcherMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/concern/resolve-watcher/${userId}`);
      return res.json();
    },
    onSuccess: (result) => {
      setJustResolved(true);
      setResolvedBy("you");
      setResolvedAt(new Date().toISOString());
      queryClient.invalidateQueries({ queryKey: ["/api/concern/timeline", userId] });
      queryClient.invalidateQueries({ queryKey: ["/api/watched-users"] });
      toast({ title: `${data?.userName || "User"} marked as safe` });
    },
    onError: () => {
      toast({ title: "Something went wrong", variant: "destructive" });
    },
  });

  useEffect(() => {
    if (data && data.safetyState === "active" && !justResolved) {
      const reason = data.safetyStateReason || "";
      if (reason.includes("heartbeat") || reason.includes("Heartbeat")) {
        setJustResolved(true);
        setResolvedBy("auto");
        setResolvedAt(data.safetyStateChangedAt || new Date().toISOString());
      } else if (reason.includes("confirmed safe") || reason.includes("Marked safe")) {
        setJustResolved(true);
        setResolvedBy(reason.includes("Marked safe") ? "watcher" : "user");
        setResolvedAt(data.safetyStateChangedAt || new Date().toISOString());
      }
    }
  }, [data?.safetyState, data?.safetyStateReason]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) return null;

  const isConcern = data.safetyState === "concern";
  const displayState = getIncidentDisplayState({
    safetyState: data.safetyState,
    incident: data.incident,
    resolvedAt: resolvedAt || data.incident?.resolvedAt,
  });
  const isRecovered = justResolved || isResolvedDisplayState(displayState) || (data.safetyState === "active" && data.timeline.length > 0);

  if (isRecovered && !isConcern) {
    const resolvedLabel = displayState === "PastAlert" ? "Past alert resolved" : "All clear";
    const resolvedDetail = resolvedBy === "auto"
      ? "Connection restored. Guardians do not need to take action."
      : resolvedBy === "watcher"
        ? `Marked safe${resolvedAt ? ` at ${format(new Date(resolvedAt), "h:mm a")}` : ""}. Guardians do not need to take action.`
        : resolvedBy === "you"
          ? `Confirmed safe${resolvedAt ? ` at ${format(new Date(resolvedAt), "h:mm a")}` : ""}. Guardians do not need to take action.`
          : `Resolved${(resolvedAt || data.incident?.resolvedAt) ? ` at ${format(new Date(resolvedAt || data.incident!.resolvedAt!), "h:mm a")}` : ""}. Guardians do not need to take action.`;
    return (
      <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4 mb-3" data-testid="panel-concern-resolved">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300" data-testid="text-resolved-headline">
            {resolvedLabel}: {data.userName.split(" ")[0]} is safe now
          </span>
        </div>
        <p className="text-xs text-emerald-700 dark:text-emerald-300" data-testid="text-resolved-detail">
          {resolvedDetail}
        </p>
      </div>
    );
  }

  if (!isConcern) return null;

  return (
    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 mb-3" data-testid="panel-concern-active">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 text-red-500 animate-pulse" />
        <span className="text-sm font-medium text-red-700 dark:text-red-300" data-testid="text-concern-headline">
          {isWatcher
            ? `We're trying to reach ${data.userName.split(" ")[0]}`
            : "We are attempting to reach your contacts"}
        </span>
      </div>

      {data.safetyStateChangedAt && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-3" data-testid="text-concern-started">
          Started {formatDistanceToNow(new Date(data.safetyStateChangedAt), { addSuffix: true })}
          {" "}at {format(new Date(data.safetyStateChangedAt), "h:mm a")}
        </p>
      )}

      {data.timeline.length > 0 && (
        <div className="space-y-2 mb-4" data-testid="timeline-concern">
          {data.timeline.map((entry, i) => (
            <div key={i} className="flex items-start gap-2" data-testid={`timeline-entry-${i}`}>
              <div className="mt-0.5">{getTimelineIcon(entry.type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground">{getTimelineLabel(entry)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatTimeForViewer(entry.time)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isWatcher ? (
        <Button
          className="w-full bg-green-600 hover:bg-green-700 text-white"
          onClick={() => resolveSelfMutation.mutate()}
          disabled={resolveSelfMutation.isPending}
          data-testid="button-im-ok"
        >
          {resolveSelfMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4 mr-2" />
          )}
          I'm OK
        </Button>
      ) : (
        <Button
          className="w-full bg-green-600 hover:bg-green-700 text-white"
          onClick={() => resolveWatcherMutation.mutate()}
          disabled={resolveWatcherMutation.isPending}
          data-testid="button-mark-safe"
        >
          {resolveWatcherMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <ShieldCheck className="w-4 h-4 mr-2" />
          )}
          Mark as safe
        </Button>
      )}
    </div>
  );
}
