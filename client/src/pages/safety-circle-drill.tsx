import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ShieldCheck, Bell, MessageCircle, CheckCircle2, X, Check, Loader2, Lock, Hourglass } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface DrillGuardian {
  contactId: string;
  name: string;
  role: string;
  responded: boolean;
  respondedAt: string | null;
  responseTimeMs: number | null;
}

interface DrillState {
  drillId: string;
  status: string;
  startedAt: string;
  resolvedAt: string | null;
  guardians: DrillGuardian[];
  totalGuardians: number;
  respondedCount: number;
}

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

function formatResponseTime(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `Responded in ${sec} sec`;
  const min = Math.round(sec / 60);
  return `Responded in ${min} min`;
}

export default function SafetyCircleDrillPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [drillId, setDrillId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (id) setDrillId(id);
  }, []);

  const { data: drill } = useQuery<DrillState>({
    queryKey: ["/api/safety-drill", drillId],
    enabled: !!drillId,
    refetchInterval: drillId ? 3000 : false,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/safety-drill", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      const newId = data?.drillId || data?.drill?.id;
      if (newId) {
        setDrillId(newId);
        const url = new URL(window.location.href);
        url.searchParams.set("id", newId);
        window.history.replaceState({}, "", url.toString());
      }
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      toast({ title: "Drill started", description: "Your Safety Circle has been notified." });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't start drill", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center gap-2">
          {drillId ? (
            <Button variant="ghost" size="icon" onClick={() => setLocation("/safety-circle")} data-testid="button-close-results" aria-label="Close">
              <X className="h-5 w-5" />
            </Button>
          ) : (
            <BackButton to="/safety-circle" />
          )}
          <h1 className="text-base font-semibold tracking-tight">
            {drillId ? "Drill Results" : "Run Safety Drill"}
          </h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-5 py-6 pb-20">
        {!drillId ? (
          <DrillIntro
            onStart={() => startMutation.mutate()}
            starting={startMutation.isPending}
          />
        ) : !drill ? (
          <Card className="rounded-2xl"><CardContent className="p-6 text-center text-sm text-muted-foreground">Loading drill...</CardContent></Card>
        ) : (
          <DrillResults
            drill={drill}
            onRunAnother={() => {
              setDrillId(null);
              const url = new URL(window.location.href);
              url.searchParams.delete("id");
              window.history.replaceState({}, "", url.toString());
            }}
            onDone={() => setLocation("/safety-circle")}
          />
        )}
      </main>
    </div>
  );
}

function DrillIntro({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  return (
    <div className="space-y-5">
      <section className="text-center pt-2 pb-2" data-testid="section-drill-intro">
        <div className="w-20 h-20 mx-auto rounded-full bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center mb-4">
          <ShieldCheck className="h-10 w-10 text-violet-600 dark:text-violet-400" />
        </div>
        <h2 className="text-xl font-bold tracking-tight" data-testid="text-drill-title">Let's test your Safety Circle</h2>
        <p className="text-sm text-muted-foreground mt-2 px-4">
          We'll send a test alert to your guardians. This is just a drill.
        </p>
      </section>

      <Card className="rounded-2xl shadow-sm">
        <CardContent className="p-4 space-y-4">
          <Step
            icon={<Bell className="h-4 w-4 text-violet-600 dark:text-violet-400" />}
            number="1. Alert sent"
            text="Your guardians will get a test notification."
            testId="drill-step-1"
          />
          <Step
            icon={<MessageCircle className="h-4 w-4 text-violet-600 dark:text-violet-400" />}
            number="2. They respond"
            text="They tap to confirm they're ready to help."
            testId="drill-step-2"
          />
          <Step
            icon={<CheckCircle2 className="h-4 w-4 text-violet-600 dark:text-violet-400" />}
            number="3. You're all set"
            text="We'll show you the results when everyone responds."
            testId="drill-step-3"
          />
        </CardContent>
      </Card>

      <Button
        size="lg"
        className="w-full h-12 rounded-2xl bg-violet-600 hover:bg-violet-700 text-white font-semibold"
        onClick={onStart}
        disabled={starting}
        data-testid="button-start-drill"
      >
        {starting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Starting...</> : "Start Drill"}
      </Button>

      <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        <span data-testid="text-safety-note">This drill won't contact emergency services.</span>
      </div>
    </div>
  );
}

function Step({ icon, number, text, testId }: { icon: React.ReactNode; number: string; text: string; testId?: string }) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      <div className="w-9 h-9 rounded-full bg-violet-50 dark:bg-violet-950/40 flex items-center justify-center shrink-0 mt-0.5">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">{number}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{text}</p>
      </div>
    </div>
  );
}

function DrillResults({ drill, onRunAnother, onDone }: { drill: DrillState; onRunAnother: () => void; onDone: () => void }) {
  const allResponded = drill.totalGuardians > 0 && drill.respondedCount >= drill.totalGuardians;
  const hasAny = drill.respondedCount > 0;

  return (
    <div className="space-y-5">
      <section className="text-center pt-2 pb-2" data-testid="section-drill-results">
        <div className="relative w-28 h-28 mx-auto mb-4">
          <div className={`absolute inset-0 rounded-full ${allResponded ? "bg-green-100/60 dark:bg-green-950/40 animate-pulse" : "bg-amber-100/60 dark:bg-amber-950/40"}`} />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className={`w-16 h-16 rounded-full ${allResponded ? "bg-green-500" : "bg-amber-500"} shadow-lg flex items-center justify-center`}>
              {allResponded ? (
                <Check className="h-9 w-9 text-white" strokeWidth={3} />
              ) : (
                <Hourglass className="h-8 w-8 text-white" strokeWidth={2.4} />
              )}
            </div>
          </div>
        </div>
        <h2 className={`text-xl font-bold tracking-tight ${allResponded ? "text-green-700 dark:text-green-500" : "text-amber-700 dark:text-amber-500"}`} data-testid="text-results-title">
          {allResponded ? "All set!" : hasAny ? "Waiting on others..." : "Waiting for responses..."}
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5">
          {allResponded
            ? "Your Safety Circle responded. You're protected."
            : `${drill.respondedCount} of ${drill.totalGuardians} responded so far`}
        </p>
      </section>

      <div className="space-y-2.5">
        {drill.guardians.length === 0 ? (
          <Card className="rounded-2xl border-dashed">
            <CardContent className="p-5 text-center text-sm text-muted-foreground" data-testid="text-no-linked-guardians">
              None of your guardians have the StillHere app linked yet, so we can't run a live drill.
            </CardContent>
          </Card>
        ) : (
          drill.guardians.map((g) => (
            <Card key={g.contactId} className="rounded-2xl shadow-sm" data-testid={`card-result-${g.contactId}`}>
              <CardContent className="p-3.5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-sm font-semibold text-primary shrink-0">
                    {initials(g.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-foreground truncate" data-testid={`text-guardian-name-${g.contactId}`}>{g.name}</p>
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${roleStyle[g.role] || roleStyle.primary}`}>
                        {g.role}
                      </span>
                    </div>
                    <p className={`text-xs mt-0.5 ${g.responded ? "text-green-600 dark:text-green-500" : "text-amber-600 dark:text-amber-500"}`} data-testid={`text-result-state-${g.contactId}`}>
                      {g.responded && g.responseTimeMs != null
                        ? formatResponseTime(g.responseTimeMs)
                        : g.responded
                        ? "Confirmed"
                        : "Waiting..."}
                    </p>
                  </div>
                  {g.responded ? (
                    <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                      <Check className="h-4 w-4 text-white" strokeWidth={3} />
                    </div>
                  ) : (
                    <div className="w-7 h-7 rounded-full border-2 border-amber-300 dark:border-amber-800 flex items-center justify-center shrink-0">
                      <Hourglass className="h-3.5 w-3.5 text-amber-500 animate-pulse" />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {allResponded && (
        <Card className="rounded-2xl bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-900/40" data-testid="card-completion-message">
          <CardContent className="p-4">
            <p className="text-sm text-foreground leading-relaxed text-center">
              Your Safety Circle is ready. If you ever need them, they'll know exactly what to do.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2.5 pt-2">
        <Button
          size="lg"
          className="w-full h-12 rounded-2xl font-semibold"
          onClick={onDone}
          data-testid="button-done"
        >
          Done
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="w-full h-11 text-primary font-medium"
          onClick={onRunAnother}
          data-testid="button-run-another"
        >
          Run another drill
        </Button>
      </div>
    </div>
  );
}
