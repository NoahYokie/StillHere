import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Heart, Bell, Shield, ArrowRight } from "lucide-react";

const screens = [
  {
    title: "Welcome to StillHere",
    body: "StillHere helps your family know you're okay, without tracking you.",
    icon: Heart,
  },
  {
    title: "How it works",
    body: "You check in by tapping \"I'm OK\"\n\nIf you don't respond, we notify your emergency contacts\n\nThey can check on you first",
    icon: Bell,
  },
  {
    title: "You stay in control",
    body: "Location sharing is OFF by default\n\nYou choose who gets notified\n\nYou can pause alerts anytime",
    icon: Shield,
  },
  {
    title: "Let's get started",
    body: "Next, we'll set up checkins and contacts.",
    icon: ArrowRight,
    isLast: true,
  },
];

export default function OnboardingPage() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(0);

  const current = screens[step];
  const Icon = current.icon;
  const isLast = step === screens.length - 1;

  const handleNext = () => {
    if (isLast) {
      setLocation("/setup/name");
    } else {
      setStep(step + 1);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-primary rounded-full flex items-center justify-center mx-auto mb-4">
            <Icon className="h-8 w-8 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl" data-testid="text-onboarding-title">
            {current.title}
          </CardTitle>
          <CardDescription className="text-base whitespace-pre-line mt-4">
            {current.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center gap-2 mb-4">
            {screens.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === step ? "bg-primary" : "bg-muted"
                }`}
              />
            ))}
          </div>
          <Button
            onClick={handleNext}
            className="w-full"
            size="lg"
            data-testid="button-onboarding-next"
          >
            {isLast ? "Start setup" : "Continue"}
          </Button>
          {!isLast && (
            <Button
              variant="ghost"
              onClick={() => setLocation("/setup/name")}
              className="w-full text-muted-foreground"
              data-testid="button-onboarding-skip"
            >
              Skip
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
