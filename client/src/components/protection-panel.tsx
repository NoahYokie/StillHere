import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, Eye, EyeOff, MapPin, Radio, Pause, ChevronDown, ChevronUp, Users, Moon, Beaker } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ProtectionData {
  sharingMode: "precise" | "area" | "presence" | "paused";
  watchers: { id: string; name: string; circleRole: string; linkedUserId: string | null }[];
  sleepStart: string;
  sleepEnd: string;
  isLearning: boolean;
  learningDaysLeft: number;
  setupConfirmed: boolean;
}

const modeLabels: Record<string, { label: string; desc: string; icon: any }> = {
  precise: { label: "Precise location", desc: "Your exact location and safety status", icon: MapPin },
  area: { label: "Area only", desc: "Your general area and safety status", icon: Radio },
  presence: { label: "Presence only", desc: "Only your safety status, no location", icon: Eye },
  paused: { label: "Sharing paused", desc: "Location sharing is paused", icon: Pause },
};

export function ProtectionPanel() {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  const { data: protection, isLoading } = useQuery<ProtectionData>({
    queryKey: ["/api/my-protection"],
    refetchInterval: 30000,
  });

  const modeMutation = useMutation({
    mutationFn: async (mode: string) => {
      await apiRequest("POST", "/api/sharing-mode", { mode });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/my-protection"] });
      toast({ title: "Updated", description: "Your sharing preference has been saved." });
    },
  });

  if (isLoading || !protection) return null;

  const currentMode = modeLabels[protection.sharingMode] || modeLabels.precise;
  const ModeIcon = currentMode.icon;
  const watcherCount = protection.watchers.length;

  return (
    <Card className="border-primary/20" data-testid="card-your-protection">
      <CardContent className="pt-5 pb-4">
        <button
          className="w-full flex items-center justify-between"
          onClick={() => setExpanded(!expanded)}
          data-testid="button-expand-protection"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <div className="text-left">
              <p className="font-medium text-sm text-foreground" data-testid="text-protection-summary">
                {watcherCount > 0
                  ? `You're sharing your safety with ${watcherCount} ${watcherCount === 1 ? "person" : "people"}`
                  : "No one is watching over you yet"}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <ModeIcon className="h-3 w-3" />
                {currentMode.desc}
              </p>
            </div>
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {expanded && (
          <div className="mt-4 space-y-4">
            {protection.isLearning && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30" data-testid="banner-learning-mode">
                <Beaker className="h-4 w-4 text-blue-500 shrink-0" />
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  StillHere is getting to know your routine. {protection.learningDaysLeft} days left. Your Safety Circle won't be alerted unless something is genuinely serious.
                </p>
              </div>
            )}

            {watcherCount > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Your Safety Circle</p>
                <div className="space-y-2">
                  {protection.watchers.map((w) => (
                    <div key={w.id} className="flex items-center justify-between" data-testid={`watcher-${w.id}`}>
                      <div className="flex items-center gap-2">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">{w.name}</span>
                      </div>
                      <Badge variant="outline" className="text-[10px] capitalize">{w.circleRole}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">They can currently see</p>
              <div className="grid grid-cols-2 gap-2">
                {(["precise", "area", "presence", "paused"] as const).map((mode) => {
                  const m = modeLabels[mode];
                  const Icon = m.icon;
                  const isActive = protection.sharingMode === mode;
                  return (
                    <button
                      key={mode}
                      className={`flex items-center gap-2 p-2.5 rounded-lg text-left text-xs transition-colors ${
                        isActive
                          ? "bg-primary/10 border border-primary/30 text-primary font-medium"
                          : "bg-muted/50 hover:bg-muted text-muted-foreground"
                      }`}
                      onClick={() => modeMutation.mutate(mode)}
                      disabled={modeMutation.isPending}
                      data-testid={`button-mode-${mode}`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Moon className="h-3.5 w-3.5" />
              <span>Sleep protection: {protection.sleepStart} to {protection.sleepEnd}</span>
            </div>

            <p className="text-xs text-center text-muted-foreground italic" data-testid="text-you-decide">
              You decide what they can see.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function GuardianViewPreview() {
  const [showPreview, setShowPreview] = useState(false);
  const { data: preview, isLoading } = useQuery<{
    userName: string;
    safetyState: string;
    safetyStateReason: string;
    sharingMode: string;
    lastCheckinAt: string | null;
    hasOpenIncident: boolean;
    lastHeartbeatAt: string | null;
    lastHeartbeatLat: number | null;
    lastHeartbeatLng: number | null;
    batteryLevel: number | null;
    batteryCharging: boolean | null;
    networkType: string | null;
  }>({
    queryKey: ["/api/guardian-view-preview"],
    enabled: showPreview,
  });

  const stateColors: Record<string, string> = {
    active: "bg-green-500",
    quiet: "bg-amber-500",
    concern: "bg-red-500",
  };

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setShowPreview(!showPreview)}
        data-testid="button-guardian-view"
      >
        <Eye className="h-4 w-4 mr-2" />
        {showPreview ? "Hide guardian's view" : "See my guardian's view"}
      </Button>

      {showPreview && !isLoading && preview && (
        <Card className="mt-3 border-dashed border-primary/30" data-testid="card-guardian-preview">
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-3">This is what your guardians currently see:</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{preview.userName}</span>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${stateColors[preview.safetyState] || "bg-gray-400"}`} />
                  <span className="text-xs capitalize">{preview.safetyState}</span>
                </div>
              </div>

              {preview.sharingMode === "presence" || preview.sharingMode === "paused" ? (
                <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Location is hidden ({preview.sharingMode} mode)</span>
                </div>
              ) : preview.sharingMode === "area" ? (
                <div className="flex items-center gap-2 p-2 rounded bg-blue-50 dark:bg-blue-950/30">
                  <MapPin className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-xs text-blue-700 dark:text-blue-300">General area visible (approx. 1km radius  -  not your exact location)</span>
                </div>
              ) : preview.lastHeartbeatLat ? (
                <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                  <MapPin className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-xs text-muted-foreground">Exact location visible</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 p-2 rounded bg-muted/50">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">No location available</span>
                </div>
              )}

              {preview.batteryLevel !== null && (
                <div className="text-xs text-muted-foreground">
                  Battery: {Math.round(preview.batteryLevel * 100)}%{preview.batteryCharging ? " (charging)" : ""}
                </div>
              )}

              {preview.lastCheckinAt && (
                <div className="text-xs text-muted-foreground">
                  Last check-in: {new Date(preview.lastCheckinAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function SafetyDrillButton() {
  const { toast } = useToast();

  const drillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/safety-drill", {});
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Safety test started",
        description: "Your Safety Circle has been notified. They'll be asked to confirm they're ready. This test ends automatically in 60 seconds.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
    },
    onError: (err: any) => {
      toast({
        title: "Unable to start test",
        description: err.message || "Something went wrong. Please try again in a moment.",
        variant: "destructive",
      });
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full border-primary/30"
      onClick={() => drillMutation.mutate()}
      disabled={drillMutation.isPending}
      data-testid="button-safety-drill"
    >
      <Beaker className="h-4 w-4 mr-2" />
      {drillMutation.isPending ? "Starting drill..." : "Test my Safety Circle"}
    </Button>
  );
}

export function LearningModeCard({ daysLeft }: { daysLeft: number }) {
  if (daysLeft <= 0) return null;

  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20" data-testid="card-learning-mode">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center shrink-0">
            <Beaker className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <p className="font-medium text-sm text-foreground">StillHere is learning your routine</p>
            <p className="text-xs text-muted-foreground mt-1">
              For the next {daysLeft} days, we'll only alert your Safety Circle for genuinely serious situations like missed check-ins, SOS, or crashes. Think of it as training your guardian.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
