import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus, Clock, Info } from "lucide-react";
import { BackButton } from "@/components/back-button";
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

export default function SafetyCircleManagePage() {
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
  const linkedCount = guardians.filter((g) => g.linked).length;
  const readyCount = data?.readyCount ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center gap-2">
          <BackButton to="/safety-circle" />
          <h1 className="text-base font-semibold tracking-tight">Manage Guardians</h1>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-primary font-semibold gap-1"
            onClick={() => setLocation("/settings")}
            data-testid="button-add-guardian"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-5 py-6 space-y-3 pb-20">
        <p className="text-xs text-center text-muted-foreground px-4 mb-2" data-testid="text-helper">
          Your guardians are the people we contact if you miss a check-in or need help.
        </p>
        {linkedCount > 0 && (
          <div className="flex justify-center mb-2" data-testid="badge-readiness-summary">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${readyCount === linkedCount ? "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400" : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${readyCount === linkedCount ? "bg-green-500" : "bg-amber-500"}`} />
              {readyCount} of {linkedCount} ready
            </span>
          </div>
        )}

        {isLoading ? (
          <Card className="rounded-2xl"><CardContent className="p-4 text-center text-sm text-muted-foreground">Loading...</CardContent></Card>
        ) : sorted.length === 0 ? (
          <Card className="rounded-2xl border-dashed">
            <CardContent className="p-5 text-center">
              <p className="text-sm text-muted-foreground mb-3">You haven't added any guardians yet.</p>
              <Button onClick={() => setLocation("/settings")} data-testid="button-add-first">
                <Plus className="h-4 w-4 mr-2" />
                Add your first guardian
              </Button>
            </CardContent>
          </Card>
        ) : (
          sorted.map((g) => (
            <Card
              key={g.id}
              className="rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => setLocation("/settings")}
              data-testid={`card-guardian-${g.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-sm font-semibold text-primary shrink-0">
                    {initials(g.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-foreground truncate" data-testid={`text-guardian-name-${g.id}`}>
                        {g.name}
                      </p>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleStyle[g.role] || roleStyle.primary}`} data-testid={`badge-role-${g.id}`}>
                        {g.role}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`w-2 h-2 rounded-full ${readinessDot[g.readiness]}`} />
                      <span className="text-xs text-muted-foreground" data-testid={`text-readiness-${g.id}`}>
                        {readinessLabel[g.readiness]}
                      </span>
                    </div>
                    {g.lastActiveAt ? (
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span data-testid={`text-last-active-${g.id}`}>
                          {g.lastActiveSource === "drill" ? "Confirmed drill" : "Last active"} {formatDistanceToNow(new Date(g.lastActiveAt), { addSuffix: true })}
                        </span>
                      </div>
                    ) : g.linked ? (
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground/70">
                        <Clock className="h-3 w-3" />
                        <span>Run a drill to confirm readiness</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground/70">
                        <Clock className="h-3 w-3" />
                        <span>Hasn't joined StillHere yet</span>
                      </div>
                    )}
                  </div>
                  <ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" />
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {sorted.length > 0 && (
          <Card className="rounded-2xl bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-900/40 mt-3" data-testid="card-info">
            <CardContent className="p-3.5 flex items-center gap-2.5">
              <Info className="h-4 w-4 text-green-600 dark:text-green-500 shrink-0" />
              <p className="text-xs text-foreground leading-relaxed">
                Guardians are notified in the order shown above.
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
