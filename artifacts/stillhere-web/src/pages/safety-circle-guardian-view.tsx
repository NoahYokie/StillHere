import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eye, MapPin, BatteryFull, Clock, CheckCircle2, Lock, AlertTriangle } from "lucide-react";
import { MobilePageShell } from "@/components/mobile-page-shell";
import GoogleMap from "@/components/google-map";
import { formatTimeForViewer } from "@/lib/timezone";
import type { UserStatus } from "@shared/schema";

interface GuardianPreview {
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
}

const stateLabel: Record<string, { label: string; color: string }> = {
  active: { label: "All good", color: "text-green-600 dark:text-green-500" },
  quiet: { label: "Quiet", color: "text-amber-600 dark:text-amber-500" },
  concern: { label: "Concern", color: "text-red-600 dark:text-red-500" },
};

const privacyNote: Record<string, string> = {
  precise: "They can see your precise location while sharing is on.",
  area: "They can see your general area, not your exact location.",
  presence: "They can see your safety status, not your location.",
  paused: "They cannot see your location while sharing is paused. If you send an SOS, StillHere may attempt to include your location with that SOS.",
};

export default function SafetyCircleGuardianViewPage() {
  const [, setLocation] = useLocation();
  const { data: preview, isLoading } = useQuery<GuardianPreview>({
    queryKey: ["/api/guardian-view-preview"],
    refetchInterval: 30000,
  });
  const { data: status } = useQuery<UserStatus>({ queryKey: ["/api/status"] });

  const mode = preview?.sharingMode || "precise";
  const stateInfo = stateLabel[preview?.safetyState || "active"] || stateLabel.active;
  const hasCoords = preview?.lastHeartbeatLat != null && preview?.lastHeartbeatLng != null;
  const showMap = hasCoords;
  const concernOverride = preview?.safetyState === "concern" && hasCoords && (mode === "presence" || mode === "paused");

  return (
    <MobilePageShell title="Guardian's View" backTo="/safety-circle" contentClassName="max-w-md px-5 space-y-4">
        <section className="text-center pt-2 pb-2" data-testid="section-hero">
          <div className="w-16 h-16 mx-auto rounded-full bg-green-100 dark:bg-green-950/40 flex items-center justify-center mb-3">
            <Eye className="h-7 w-7 text-green-600 dark:text-green-500" />
          </div>
          <h2 className="text-lg font-semibold tracking-tight" data-testid="text-hero-title">This is what your guardian sees</h2>
        </section>

        {isLoading ? (
          <Card className="rounded-2xl"><CardContent className="p-6 text-center text-sm text-muted-foreground">Loading preview...</CardContent></Card>
        ) : !preview ? (
          <Card className="rounded-2xl"><CardContent className="p-6 text-center text-sm text-muted-foreground">Could not load preview.</CardContent></Card>
        ) : (
          <>
            {/* Map / status block */}
            <Card className="rounded-2xl overflow-hidden shadow-sm" data-testid="card-map-or-status">
              {showMap ? (
                <>
                  <GoogleMap
                    center={{ lat: preview.lastHeartbeatLat!, lng: preview.lastHeartbeatLng! }}
                    zoom={mode === "area" ? 12 : 15}
                    className="w-full h-44"
                    markerLabel={preview.userName}
                  />
                  <div className="p-3.5 flex items-center gap-2">
                    <MapPin className={`h-4 w-4 shrink-0 ${concernOverride ? "text-red-600 dark:text-red-500" : "text-green-600 dark:text-green-500"}`} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate" data-testid="text-location-mode">
                        {concernOverride
                          ? "Location unlocked during concern"
                          : mode === "area"
                            ? "General area visible"
                            : "Precise location visible"}
                      </p>
                      {preview.lastHeartbeatAt && (
                        <p className="text-xs text-muted-foreground">
                          Updated {formatTimeForViewer(preview.lastHeartbeatAt, status?.user?.timezone || undefined)}
                        </p>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <CardContent className="p-5 text-center">
                  <div className="w-12 h-12 rounded-full bg-muted/60 mx-auto flex items-center justify-center mb-2.5">
                    <Lock className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground" data-testid="text-location-hidden">
                    {mode === "paused" ? "Sharing is paused" : "Location is hidden"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Your guardian only sees your safety status.
                  </p>
                </CardContent>
              )}
            </Card>

            {/* Status card */}
            <Card className="rounded-2xl shadow-sm">
              <CardContent className="p-1">
                <Row label="Your status" value={stateInfo.label} valueClassName={`font-semibold ${stateInfo.color}`} icon={<CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />} testId="row-status" />
                <Divider />
                <Row
                  label="Last check-in"
                  value={preview.lastCheckinAt ? formatTimeForViewer(preview.lastCheckinAt, status?.user?.timezone || undefined) : "Never"}
                  icon={<Clock className="h-4 w-4 text-muted-foreground" />}
                  testId="row-last-checkin"
                />
                <Divider />
                <Row
                  label="Next check-in"
                  value={status?.nextCheckinDue ? formatTimeForViewer(status.nextCheckinDue, status?.user?.timezone || undefined) : "Not scheduled"}
                  icon={<Clock className="h-4 w-4 text-muted-foreground" />}
                  testId="row-next-checkin"
                />
                {preview.batteryLevel != null && (
                  <>
                    <Divider />
                    <Row
                      label="Battery"
                      value={`${Math.round(preview.batteryLevel * 100)}%${preview.batteryCharging ? " (charging)" : ""}`}
                      icon={<BatteryFull className="h-4 w-4 text-muted-foreground" />}
                      testId="row-battery"
                    />
                  </>
                )}
              </CardContent>
            </Card>

            {/* Privacy note */}
            <Card className={`rounded-2xl ${concernOverride ? "bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-900/40" : "bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-900/40"}`} data-testid="card-privacy-note">
              <CardContent className="p-3.5 flex items-center gap-2.5">
                <Lock className={`h-4 w-4 shrink-0 ${concernOverride ? "text-amber-600 dark:text-amber-500" : "text-green-600 dark:text-green-500"}`} />
                <p className="text-xs text-foreground leading-relaxed">
                  {concernOverride
                    ? "While there's a concern, your guardians can see your location to help. It will lock again once you're safe."
                    : (privacyNote[mode] || privacyNote.precise)}
                </p>
              </CardContent>
            </Card>

            {preview.hasOpenIncident && (
              <Card className="rounded-2xl bg-amber-50/60 dark:bg-amber-950/20 border-amber-200/50 dark:border-amber-900/40" data-testid="card-incident-warning">
                <CardContent className="p-3.5 flex items-center gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500 shrink-0" />
                  <p className="text-xs text-foreground leading-relaxed">
                    Your guardians can currently see an active alert.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
    </MobilePageShell>
  );
}

function Row({ label, value, icon, valueClassName, testId }: { label: string; value: string; icon: React.ReactNode; valueClassName?: string; testId?: string }) {
  return (
    <div className="flex items-center justify-between p-3" data-testid={testId}>
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <span className={`text-sm text-foreground ${valueClassName || ""}`}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border/50 mx-3" />;
}
