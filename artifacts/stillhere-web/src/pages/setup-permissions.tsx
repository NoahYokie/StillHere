import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { MapPin, Bell, Activity, Shield, ChevronRight, CheckCircle2, X } from "lucide-react";
import {
  requestLocationPermission,
  requestNotificationPermission,
  requestMotionPermissionWrapper,
} from "@/lib/permissions";
import { apiRequest } from "@/lib/queryClient";

type Step = "location" | "notifications" | "motion" | "done";

const steps: { key: Step; icon: typeof MapPin; title: string; description: string; detail: string; secondary: string; buttonLabel: string }[] = [
  {
    key: "location",
    icon: MapPin,
    title: "Location helps your Safety Circle find you when it matters",
    description: "StillHere uses location for safety features like SOS, Safe Walk, driving safety, check-ins, and live maps.",
    detail: "Your location is only shared with people you choose. You can pause or change sharing anytime.",
    secondary: "You stay in control.",
    buttonLabel: "Continue",
  },
  {
    key: "notifications",
    icon: Bell,
    title: "Notifications keep your safety loop active",
    description: "StillHere sends check-in reminders, safety alerts, all-clear updates, and urgent messages from your Safety Circle.",
    detail: "These alerts help the system reach you before escalating to your contacts.",
    secondary: "You can change notification settings anytime.",
    buttonLabel: "Continue",
  },
  {
    key: "motion",
    icon: Activity,
    title: "Motion helps detect serious events",
    description: "StillHere can use motion sensors to help detect possible falls or vehicle crashes and start an emergency flow if you do not respond.",
    detail: "",
    secondary: "Motion data is used for safety, not surveillance.",
    buttonLabel: "Continue",
  },
];

export default function SetupPermissionsPage() {
  const [, setLocation] = useLocation();
  const [currentStep, setCurrentStep] = useState(0);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [requesting, setRequesting] = useState(false);

  const step = currentStep < steps.length ? steps[currentStep] : null;

  const handleAllow = useCallback(async () => {
    if (!step) return;
    setRequesting(true);
    let granted = false;
    try {
      if (step.key === "location") {
        granted = await requestLocationPermission();
        if (granted) {
          await apiRequest("POST", "/api/settings", { locationMode: "both" }).catch(() => {});
        }
      } else if (step.key === "notifications") {
        granted = await requestNotificationPermission();
      } else if (step.key === "motion") {
        granted = await requestMotionPermissionWrapper();
      }
    } catch {
      granted = false;
    }
    setResults((prev) => ({ ...prev, [step.key]: granted }));
    setRequesting(false);
    setCurrentStep((prev) => prev + 1);
  }, [step]);

  const handleSkip = useCallback(() => {
    if (step) {
      setResults((prev) => ({ ...prev, [step.key]: false }));
    }
    setCurrentStep((prev) => prev + 1);
  }, [step]);

  const handleFinish = async () => {
    // After contact + permission setup, route to the Limitations of Service
    // screen if the user has not yet acknowledged it. The gate component
    // also enforces this, but redirecting here keeps onboarding linear.
    try {
      const me = await fetch("/api/auth/me", { credentials: "include" }).then((r) => r.json());
      if (me?.authenticated && !me?.acknowledgedLimitationsAt) {
        setLocation("/limitations");
        return;
      }
    } catch {
      // If the fetch fails the gate will catch it later.
    }
    setLocation("/");
  };

  if (!step) {
    const allGranted = Object.values(results).every(Boolean);
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <Shield className="h-8 w-8 text-green-600 dark:text-green-400" />
            </div>
            <CardTitle className="text-2xl" data-testid="text-permissions-complete">
              {allGranted ? "You're all set" : "Setup complete"}
            </CardTitle>
            <CardDescription className="text-base mt-2" data-testid="text-permissions-summary">
              {allGranted
                ? "StillHere has the access it needs to keep you safe."
                : "StillHere will still work, but some safety features may be limited. You can update permissions anytime in Settings."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {steps.map((s) => {
              const granted = results[s.key];
              return (
                <div key={s.key} className="flex items-center gap-3 py-2" data-testid={`status-${s.key}`}>
                  {granted ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
                  ) : (
                    <X className="h-5 w-5 text-amber-500 flex-shrink-0" />
                  )}
                  <span className="text-sm">{s.title}</span>
                  <span className={`text-xs ml-auto ${granted ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {granted ? "Enabled" : "Not enabled"}
                  </span>
                </div>
              );
            })}
            <Button
              onClick={handleFinish}
              className="w-full mt-4"
              size="lg"
              data-testid="button-finish-permissions"
            >
              Continue to StillHere
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const Icon = step.icon;
  const progress = ((currentStep + 1) / (steps.length + 1)) * 100;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-2 bg-muted rounded-full mx-auto mb-6 overflow-hidden" style={{ width: "80%" }}>
            <div
              className="h-2 bg-primary rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Icon className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-permission-title">
            {step.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <p className="text-base text-foreground leading-relaxed" data-testid="text-permission-description">
              {step.description}
            </p>
            {step.detail && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {step.detail}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Button
              onClick={handleAllow}
              className="w-full"
              size="lg"
              disabled={requesting}
              data-testid="button-allow-permission"
            >
              {requesting ? "Requesting..." : step.buttonLabel}
              <ChevronRight className="h-4 w-4 ml-2" />
            </Button>
            <p
              className="text-xs text-center text-muted-foreground"
              data-testid="text-permission-secondary"
            >
              {step.secondary}
            </p>
            <Button
              variant="ghost"
              onClick={handleSkip}
              className="w-full text-muted-foreground"
              size="sm"
              data-testid="button-skip-permission"
            >
              Not now
            </Button>
          </div>

          <div className="flex justify-center gap-2">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full ${i === currentStep ? "bg-primary" : i < currentStep ? "bg-primary/60" : "bg-muted"}`}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
