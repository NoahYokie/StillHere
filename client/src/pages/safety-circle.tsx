import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Users, UserPlus, Shield } from "lucide-react";
import { GuardianViewPreview, SafetyDrillButton } from "@/components/protection-panel";
import type { UserStatus } from "@shared/schema";

const roleLabel: Record<string, string> = {
  primary: "Primary",
  backup: "Backup",
  support: "Support",
};

export default function SafetyCirclePage() {
  const [, setLocation] = useLocation();
  const { data: status } = useQuery<UserStatus>({ queryKey: ["/api/status"] });
  const contacts = status?.contacts || [];

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

      <main className="max-w-md mx-auto px-6 py-6 space-y-5">
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Your Guardians
              <span
                className="ml-auto text-xs font-medium text-muted-foreground"
                data-testid="text-contact-count"
              >
                {contacts.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                You haven't added a guardian yet. Add an emergency contact so we know who to reach if something happens.
              </p>
            ) : (
              <div className="space-y-2">
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between p-3 rounded-xl bg-muted/60"
                    data-testid={`contact-item-${c.id}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-foreground truncate" data-testid={`text-contact-name-${c.id}`}>
                        {c.name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{c.phone}</p>
                    </div>
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider shrink-0 ml-3">
                      {roleLabel[c.circleRole as string] || "Primary"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              className="w-full mt-1"
              onClick={() => setLocation("/settings")}
              data-testid="button-manage-guardians"
            >
              <UserPlus className="h-4 w-4 mr-2" />
              Manage guardians
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Test &amp; Preview
          </p>
          <GuardianViewPreview />
          <SafetyDrillButton />
        </div>

        <div className="pt-2">
          <Card className="rounded-2xl shadow-sm bg-muted/40 border-dashed">
            <CardContent className="py-4 flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              <div className="text-xs text-muted-foreground leading-relaxed">
                Your Safety Circle is the small group of people we contact if you don't check in or trigger an alert. Keep it small and trusted.
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
