import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, ChevronRight, Eye, ShieldCheck, Bell, MessageSquare, PhoneCall,
  Check, Clock, UserPlus,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Readiness = "ready" | "idle" | "needs_attention" | "unknown";

interface Guardian {
  id: string;
  name: string;
  phone: string;
  role: string;
  linked: boolean;
  readiness: Readiness;
  lastActiveAt: string | null;
  lastActiveSource?: "heartbeat" | "drill" | null;
}

interface CircleReadiness {
  guardians: Guardian[];
  totalCount: number;
  readyCount: number;
}

const readinessLabel: Record<Readiness, string> = {
  ready: "Ready to respond",
  idle: "Idle",
  needs_attention: "Needs attention",
  unknown: "Not active yet",
};

const readinessDot: Record<Readiness, string> = {
  ready: "bg-green-500",
  idle: "bg-amber-500",
  needs_attention: "bg-red-500",
  unknown: "bg-muted-foreground/40",
};

const roleStyle: Record<string, string> = {
  primary: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400",
  backup: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
  support: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("") || "?";
}

export default function SafetyCirclePage() {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useQuery<CircleReadiness>({
    queryKey: ["/api/safety-circle/readiness"],
    refetchInterval: 30000,
  });

  const guardians = data?.guardians || [];
  const sorted = [...guardians].sort((a, b) => {
    const order: Record<string, number> = { primary: 0, backup: 1, support: 2 };
    return (order[a.role] ?? 9) - (order[b.role] ?? 9);
  });
  const primary = sorted[0];
  const totalCount = data?.totalCount ?? guardians.length;
  const linkedCount = guardians.filter((g) => g.linked).length;
  const readyCount = data?.readyCount ?? 0;
  const allReady = linkedCount > 0 && readyCount === linkedCount;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/")}
            data-testid="button-back"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-base font-semibold tracking-tight">Safety Circle</h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-5 py-6 space-y-5 pb-20">
        {/* Hero */}
        <section className="text-center pt-4 pb-2" data-testid="section-hero">
          <div className="relative w-32 h-32 mx-auto mb-5">
            <div className="absolute inset-0 rounded-full bg-green-100/60 dark:bg-green-950/40 animate-pulse" />
            <div className="absolute inset-3 rounded-full bg-green-50 dark:bg-green-950/60" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-20 h-20 rounded-full bg-green-500 shadow-lg shadow-green-500/30 flex items-center justify-center">
                {totalCount > 0 ? (
                  <ShieldCheck className="h-10 w-10 text-white" strokeWidth={2.4} />
                ) : (
                  <UserPlus className="h-10 w-10 text-white" strokeWidth={2.4} />
                )}
              </div>
            </div>
          </div>
          {totalCount > 0 ? (
            <>
              <h2 className={`text-2xl font-bold tracking-tight ${allReady ? "text-green-700 dark:text-green-500" : "text-foreground"}`} data-testid="text-hero-title">
                {allReady ? "Your Safety Circle is Ready" : "Your Safety Circle"}
              </h2>
              <p className="text-sm text-muted-foreground mt-1.5" data-testid="text-hero-subtitle">
                {linkedCount > 0
                  ? `${readyCount} of ${linkedCount} ready · ${totalCount} ${totalCount === 1 ? "Guardian" : "Guardians"}`
                  : `Sharing with ${totalCount} ${totalCount === 1 ? "Guardian" : "Guardians"}`}
              </p>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold tracking-tight" data-testid="text-hero-title">
                Set up your Safety Circle
              </h2>
              <p className="text-sm text-muted-foreground mt-1.5 px-4" data-testid="text-hero-subtitle">
                Add someone you trust so StillHere knows who to contact.
              </p>
            </>
          )}
        </section>

        {/* Primary guardian card */}
        {isLoading ? (
          <Card className="rounded-2xl">
            <CardContent className="p-5">
              <div className="flex items-center gap-4 animate-pulse">
                <div className="w-14 h-14 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                </div>
              </div>
            </CardContent>
          </Card>
        ) : primary ? (
          <Card
            className="rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer"
            onClick={() => setLocation("/safety-circle/manage")}
            data-testid={`card-primary-guardian-${primary.id}`}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3.5">
                <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-base font-semibold text-primary shrink-0">
                  {initials(primary.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-foreground truncate" data-testid="text-primary-name">
                      {primary.name}
                    </p>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleStyle[primary.role] || roleStyle.primary}`} data-testid="badge-primary-role">
                      {primary.role}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`w-2 h-2 rounded-full ${readinessDot[primary.readiness]}`} />
                    <span className="text-xs text-muted-foreground" data-testid="text-primary-readiness">
                      {readinessLabel[primary.readiness]}
                    </span>
                  </div>
                  {primary.lastActiveAt && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span data-testid="text-primary-last-active">
                        Last active {formatDistanceToNow(new Date(primary.lastActiveAt), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" />
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-2xl border-dashed" data-testid="card-empty-guardian">
            <CardContent className="p-5 text-center">
              <p className="font-medium text-foreground">No guardian added yet</p>
              <p className="text-xs text-muted-foreground mt-1 mb-3">
                Add someone you trust as your first responder.
              </p>
              <Button
                onClick={() => setLocation("/safety-circle/manage")}
                data-testid="button-add-first-guardian"
                className="w-full"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                Add Guardian
              </Button>
            </CardContent>
          </Card>
        )}

        {totalCount > 0 && (
          <Button
            variant="outline"
            className="w-full h-12 justify-between rounded-2xl bg-card hover:bg-accent/30"
            onClick={() => setLocation("/safety-circle/manage")}
            data-testid="button-manage-guardians"
          >
            <span className="font-medium">Manage Guardians</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}

        {/* How it works */}
        <section data-testid="section-how-it-works">
          <h3 className="text-base font-semibold mb-3 mt-2">How it works</h3>
          <div className="space-y-3.5">
            <FlowStep
              number={1}
              isLast={false}
              title={`${primary?.name || "Your Primary Guardian"} is notified instantly`}
              subtitle="We send an alert to your guardian."
            />
            <FlowStep
              number={2}
              isLast={false}
              title="SMS is sent if no response"
              subtitle="We send a text message as a backup."
            />
            <FlowStep
              number={3}
              isLast={true}
              title="Call is triggered if needed"
              subtitle="We call your guardian if there's still no response."
            />
          </div>
        </section>

        {/* Action cards */}
        <Card
          className="rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer mt-2"
          onClick={() => setLocation("/safety-circle/guardian-view")}
          data-testid="card-action-guardian-view"
        >
          <CardContent className="p-4 flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-green-100 dark:bg-green-950/40 flex items-center justify-center shrink-0">
              <Eye className="h-5 w-5 text-green-600 dark:text-green-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground">See my Guardian's view</p>
              <p className="text-xs text-muted-foreground mt-0.5">See exactly what your guardian sees</p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" />
          </CardContent>
        </Card>

        <Card
          className="rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer"
          onClick={() => setLocation("/safety-circle/drill")}
          data-testid="card-action-safety-drill"
        >
          <CardContent className="p-4 flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center shrink-0">
              <ShieldCheck className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground">Run Safety Drill</p>
              <p className="text-xs text-muted-foreground mt-0.5">Test your response team</p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" />
          </CardContent>
        </Card>

        {/* Reassurance */}
        <Card className="rounded-2xl bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-900/40 mt-3" data-testid="card-reassurance">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2.5">
              <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
              <p className="text-sm font-medium text-foreground">Your Safety Circle is contacted only if:</p>
            </div>
            <ul className="space-y-1.5 pl-1">
              <li className="flex items-center gap-2 text-xs text-foreground">
                <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500 shrink-0" />
                <span>You miss a check-in</span>
              </li>
              <li className="flex items-center gap-2 text-xs text-foreground">
                <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500 shrink-0" />
                <span>You trigger SOS</span>
              </li>
              <li className="flex items-center gap-2 text-xs text-foreground">
                <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-500 shrink-0" />
                <span>A safety timer or Safe Walk needs attention</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function FlowStep({ number, title, subtitle, isLast }: { number: number; title: string; subtitle: string; isLast: boolean }) {
  const icon = number === 1 ? <Bell className="h-3 w-3" /> : number === 2 ? <MessageSquare className="h-3 w-3" /> : <PhoneCall className="h-3 w-3" />;
  return (
    <div className="flex gap-3.5 relative" data-testid={`flow-step-${number}`}>
      <div className="flex flex-col items-center shrink-0">
        <div className="w-7 h-7 rounded-full bg-card border-2 border-border flex items-center justify-center text-[11px] font-bold text-foreground relative z-10">
          {number}
        </div>
        {!isLast && (
          <div className="w-px flex-1 bg-border mt-1 mb-1 min-h-[20px]" />
        )}
      </div>
      <div className="flex-1 pb-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <p className="text-sm font-semibold text-foreground leading-tight">{title}</p>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed flex items-center gap-1">
          <span className="text-muted-foreground/70">{icon}</span>
          {subtitle}
        </p>
      </div>
    </div>
  );
}
