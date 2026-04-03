import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Heart, Bell, Users, Shield, ChevronDown, Check, Clock, MessageCircle, MapPin, HelpCircle, Activity, Watch, AlertTriangle, Phone, Wifi, WifiOff, Smartphone, Server } from "lucide-react";

type AnimStep = "checkin" | "tapping" | "confirmed" | "reminder" | "alert";

const STEP_DURATIONS: Record<AnimStep, number> = {
  checkin: 3000,
  tapping: 1200,
  confirmed: 3500,
  reminder: 4000,
  alert: 4500,
};

const STEP_ORDER: AnimStep[] = ["checkin", "tapping", "confirmed", "reminder", "alert"];

function AnimatedPhoneScreen({ step }: { step: AnimStep }) {
  if (step === "checkin" || step === "tapping") {
    const isTapping = step === "tapping";
    return (
      <div className="flex-1 flex flex-col">
        <div className="bg-primary text-white px-3.5 md:px-5 pt-5 md:pt-8 pb-2.5 md:pb-4">
          <div className="flex items-center gap-1.5 mb-0.5 md:mb-1">
            <Heart className="h-3 md:h-4 w-3 md:w-4" />
            <span className="text-[11px] md:text-sm font-semibold">StillHere</span>
          </div>
          <p className="text-[9px] md:text-xs text-white/70">Good morning, Sarah</p>
        </div>
        <div className="flex-1 px-3 md:px-5 py-2.5 md:py-4 flex flex-col gap-2.5 md:gap-4">
          <div className="bg-white rounded-lg md:rounded-xl px-2.5 md:px-4 py-1.5 md:py-3 shadow-sm border border-gray-100 text-center">
            <p className="text-[7px] md:text-[10px] text-gray-400 uppercase tracking-wider mb-0.5">Next checkin</p>
            <p className="text-[11px] md:text-sm font-semibold text-gray-800">Due now</p>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center">
            <div
              className={`w-16 h-16 md:w-24 md:h-24 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 ${
                isTapping
                  ? "bg-green-400 scale-90"
                  : "bg-green-500 scale-100"
              }`}
            >
              <Check className="h-8 w-8 md:h-12 md:w-12 text-white" />
            </div>
            <p className="font-bold text-gray-800 text-[13px] md:text-base mt-1.5 md:mt-3">I'm OK</p>
            <p className="text-[8px] md:text-[11px] text-gray-400 mt-0.5 md:mt-1">Tap once a day</p>
          </div>
          <div className="bg-red-500 rounded-lg md:rounded-xl py-1.5 md:py-2.5 text-center text-white text-[11px] md:text-sm font-semibold shadow-sm">
            I Need Help
          </div>
        </div>
      </div>
    );
  }

  if (step === "confirmed") {
    return (
      <div className="flex-1 flex flex-col">
        <div className="bg-green-500 text-white px-3.5 md:px-5 pt-5 md:pt-8 pb-2.5 md:pb-4 transition-colors duration-500">
          <div className="flex items-center gap-1.5 mb-0.5 md:mb-1">
            <Heart className="h-3 md:h-4 w-3 md:w-4" />
            <span className="text-[11px] md:text-sm font-semibold">StillHere</span>
          </div>
          <p className="text-[9px] md:text-xs text-white/80">You're all good!</p>
        </div>
        <div className="flex-1 px-3 md:px-5 py-2.5 md:py-4 flex flex-col gap-2.5 md:gap-4">
          <div className="bg-green-50 rounded-lg md:rounded-xl px-2.5 md:px-4 py-1.5 md:py-3 shadow-sm border border-green-200 text-center">
            <p className="text-[7px] md:text-[10px] text-green-600 uppercase tracking-wider mb-0.5">Status</p>
            <p className="text-[11px] md:text-sm font-semibold text-green-700">Checked in ✓</p>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="w-16 h-16 md:w-24 md:h-24 rounded-full bg-green-500 flex items-center justify-center shadow-lg animate-[scaleIn_0.4s_ease-out]">
              <Check className="h-8 w-8 md:h-12 md:w-12 text-white" />
            </div>
            <p className="font-bold text-green-700 text-[13px] md:text-base mt-1.5 md:mt-3">All good!</p>
            <p className="text-[8px] md:text-[11px] text-gray-400 mt-0.5 md:mt-1">Next checkin: 9 AM tomorrow</p>
          </div>
          <div className="bg-green-50 rounded-lg md:rounded-xl py-2 md:py-2.5 text-center border border-green-200">
            <p className="text-[10px] md:text-xs text-green-600 font-medium">Your contacts have been notified you're safe</p>
          </div>
        </div>
      </div>
    );
  }

  if (step === "reminder") {
    return (
      <div className="flex-1 flex flex-col bg-gray-100">
        <div className="bg-gray-800 text-white px-3.5 md:px-5 pt-5 md:pt-7 pb-2 md:pb-3">
          <p className="text-[9px] md:text-xs text-gray-400">9:15 AM</p>
        </div>
        <div className="flex-1 px-2.5 md:px-3 pt-3 md:pt-4 space-y-2">
          <div className="bg-white rounded-xl p-2.5 md:p-3 shadow-sm border border-gray-200 animate-[slideDown_0.5s_ease-out]">
            <div className="flex items-start gap-2">
              <div className="w-7 h-7 md:w-8 md:h-8 rounded-full bg-sky-500 flex items-center justify-center flex-shrink-0">
                <Heart className="h-3.5 w-3.5 md:h-4 md:w-4 text-white" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] md:text-[10px] font-semibold text-gray-800">StillHere</p>
                  <p className="text-[7px] md:text-[8px] text-gray-400">now</p>
                </div>
                <p className="text-[9px] md:text-[10px] text-gray-600 mt-0.5 leading-relaxed">
                  Hey Sarah! Time to check in. Tap the button to let your family know you're okay.
                </p>
                <div className="mt-1.5 md:mt-2 bg-green-500 rounded-md py-1 md:py-1.5 text-center">
                  <p className="text-[8px] md:text-[9px] text-white font-semibold">I'm OK ✓</p>
                </div>
              </div>
            </div>
          </div>
          <div className="text-center pt-1 md:pt-2">
            <div className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-2.5 md:px-3 py-1 md:py-1.5 rounded-full">
              <Bell className="h-2.5 w-2.5 md:h-3 md:w-3" />
              <p className="text-[8px] md:text-[9px] font-medium">Friendly reminder</p>
            </div>
          </div>
          <p className="text-[8px] md:text-[9px] text-gray-400 text-center px-3 md:px-4">
            You can check in right from this notification
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="bg-amber-500 text-white px-3.5 md:px-5 pt-5 md:pt-8 pb-2.5 md:pb-4">
        <div className="flex items-center gap-1.5 mb-0.5 md:mb-1">
          <AlertTriangle className="h-3 md:h-4 w-3 md:w-4" />
          <span className="text-[11px] md:text-sm font-semibold">Alert Active</span>
        </div>
        <p className="text-[9px] md:text-xs text-white/80">Notifying your contacts</p>
      </div>
      <div className="flex-1 px-2.5 md:px-4 py-2.5 md:py-3 space-y-2 md:space-y-2.5">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 md:p-3 animate-[slideDown_0.4s_ease-out]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 md:h-4 md:w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[9px] md:text-[10px] font-semibold text-amber-800">Missed checkin</p>
              <p className="text-[8px] md:text-[9px] text-amber-600 mt-0.5">
                Contacting John (1 of 2)...
              </p>
              <div className="mt-1 flex gap-1">
                <div className="w-3.5 h-3.5 md:w-4 md:h-4 rounded-full bg-green-500 flex items-center justify-center">
                  <Check className="h-2 w-2 md:h-2.5 md:w-2.5 text-white" />
                </div>
                <div className="w-3.5 h-3.5 md:w-4 md:h-4 rounded-full bg-gray-200 flex items-center justify-center">
                  <span className="text-[6px] md:text-[7px] text-gray-500">2</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg p-2.5 md:p-3 border border-gray-100">
          <p className="text-[8px] md:text-[9px] text-gray-500 text-center">
            Your contacts get a text with a link to check on you
          </p>
          <div className="mt-1.5 bg-gray-50 rounded-md p-1.5 md:p-2 border border-gray-100">
            <p className="text-[7px] md:text-[8px] text-gray-600">
              📱 "Hi John, Sarah hasn't checked in. Please check on her."
            </p>
          </div>
        </div>
        <div className="text-center">
          <p className="text-[7px] md:text-[8px] text-gray-400">Contacts are notified one by one</p>
        </div>
      </div>
    </div>
  );
}

function AnimatedWatchScreen({ step }: { step: AnimStep }) {
  const isConfirmed = step === "confirmed";
  const isAlert = step === "alert";
  const bpm = isAlert ? 0 : 72;

  return (
    <div className="w-[88px] h-[108px] md:w-[110px] md:h-[135px] bg-gray-900 rounded-[1.75rem] md:rounded-[2.25rem] border-[2.5px] border-gray-700 shadow-2xl shadow-black/40 p-1 flex flex-col relative">
      <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 w-3 h-5 md:w-3.5 md:h-6 bg-gray-700 rounded-sm" />
      <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-3 h-5 md:w-3.5 md:h-6 bg-gray-700 rounded-sm" />
      <div className="absolute top-1/2 -right-[3px] -translate-y-1/2 w-[4px] h-5 bg-gray-600 rounded-r-sm" />
      <div className="flex-1 bg-black rounded-[1.4rem] md:rounded-[1.75rem] overflow-hidden flex flex-col">
        <div className="px-2 pt-2 md:pt-2.5">
          <div className="flex items-center gap-1">
            <Heart className="h-2 w-2 md:h-2.5 md:w-2.5 text-cyan-400" />
            <span className="text-[6px] md:text-[7px] font-semibold text-cyan-400">StillHere</span>
          </div>
        </div>

        {isAlert ? (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-1">
            <div className="w-7 h-7 md:w-9 md:h-9 rounded-full bg-amber-500 flex items-center justify-center animate-pulse">
              <AlertTriangle className="h-4 w-4 md:h-5 md:w-5 text-white" />
            </div>
            <p className="text-[6px] md:text-[7px] font-bold text-amber-400">ALERT</p>
            <p className="text-[5px] md:text-[6px] text-gray-500">Notifying contacts</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-1.5 gap-1">
            <div className={`w-9 h-9 md:w-11 md:h-11 rounded-full flex items-center justify-center shadow-lg transition-all duration-300 ${
              isConfirmed ? "bg-green-400 scale-95" : "bg-green-500"
            }`}>
              <Check className="h-5 w-5 md:h-6 md:w-6 text-white" />
            </div>
            <p className="text-[7px] md:text-[8px] font-bold text-white">
              {isConfirmed ? "Done!" : "I'm OK"}
            </p>
          </div>
        )}

        <div className="px-2 pb-1.5 md:pb-2 space-y-1">
          {!isAlert && (
            <div className="flex items-center justify-center gap-1">
              <Heart className="h-2 w-2 text-red-500" />
              <span className="text-[7px] md:text-[8px] font-bold text-red-400">{bpm}</span>
              <span className="text-[5px] md:text-[6px] text-gray-400">BPM</span>
            </div>
          )}
          <div className={`rounded-md py-0.5 text-center ${isAlert ? "bg-amber-500" : "bg-red-500"}`}>
            <span className="text-[6px] md:text-[7px] text-white font-semibold">
              {isAlert ? "SOS Sent" : "SOS"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: AnimStep }) {
  const labels: Record<AnimStep, string> = {
    checkin: "Check in",
    tapping: "Tap",
    confirmed: "Confirmed",
    reminder: "Reminder",
    alert: "Contacts notified",
  };

  const visibleSteps: AnimStep[] = ["checkin", "confirmed", "reminder", "alert"];
  const currentVisible = (step === "tapping") ? "checkin" : step;

  return (
    <div className="flex items-center justify-center gap-1 mt-2" data-testid="animation-step-indicator">
      {visibleSteps.map((s) => (
        <div
          key={s}
          className={`h-1 rounded-full transition-all duration-500 ${
            s === currentVisible
              ? "w-5 md:w-6 bg-white"
              : "w-1.5 bg-white/30"
          }`}
        />
      ))}
      <span className="text-[8px] md:text-[9px] text-white/50 ml-1.5 font-medium min-w-[70px] md:min-w-[90px]">
        {labels[step === "tapping" ? "checkin" : step]}
      </span>
    </div>
  );
}

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [animStep, setAnimStep] = useState<AnimStep>("checkin");

  useEffect(() => {
    const currentIndex = STEP_ORDER.indexOf(animStep);
    const duration = STEP_DURATIONS[animStep];

    const timer = setTimeout(() => {
      const nextIndex = (currentIndex + 1) % STEP_ORDER.length;
      setAnimStep(STEP_ORDER[nextIndex]);
    }, duration);

    return () => clearTimeout(timer);
  }, [animStep]);

  return (
    <div className="min-h-screen bg-background">
      <header className="hidden md:block bg-primary text-primary-foreground px-6 py-4 sticky top-0 z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Heart className="h-6 w-6" />
            <span className="text-xl font-semibold" data-testid="text-landing-title">StillHere</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-primary-foreground"
              onClick={() => setLocation("/help")}
              data-testid="link-help"
            >
              <HelpCircle className="h-4 w-4 mr-1" />
              Help
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLocation("/login")}
              data-testid="button-sign-in"
            >
              Sign in
            </Button>
          </div>
        </div>
      </header>

      <section className="relative min-h-[100dvh] md:min-h-0 flex flex-col bg-gradient-to-b md:bg-gradient-to-br from-primary via-primary to-primary/80 text-white overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-16 left-8 md:top-20 md:left-20 w-32 md:w-64 h-32 md:h-64 rounded-full bg-white/20 blur-3xl" />
          <div className="absolute bottom-32 right-4 md:bottom-10 md:right-20 w-48 md:w-80 h-48 md:h-80 rounded-full bg-white/15 blur-3xl" />
        </div>

        <div className="relative flex-1 md:flex-none flex flex-col md:block px-6 pt-12 pb-6 md:py-24 max-w-5xl md:mx-auto md:w-full">
          <div className="flex items-center gap-2 md:hidden mb-6">
            <Heart className="h-6 w-6" />
            <span className="text-lg font-semibold tracking-tight" data-testid="text-landing-title-mobile">StillHere</span>
          </div>

          <div className="md:grid md:grid-cols-2 md:gap-12 md:items-center flex-1 flex flex-col md:flex-none">
            <div className="flex-1 flex flex-col justify-end md:justify-center md:block order-2 md:order-1 pt-2 md:pt-0">
              <h1 className="text-[1.75rem] md:text-4xl lg:text-5xl leading-[1.2] md:leading-tight font-bold tracking-tight mb-3 md:mb-6 text-center md:text-left" data-testid="text-hero-title">
                Your family will always know you're okay.
              </h1>
              <p className="text-[0.95rem] md:text-xl text-white/80 leading-relaxed mb-6 md:mb-8 text-center md:text-left tracking-normal">
                One tap a day. That's all it takes to give your loved ones peace of mind.
              </p>

              <div className="space-y-2.5 md:space-y-0 md:flex md:flex-wrap md:gap-3">
                <Button
                  size="lg"
                  className="w-full md:w-auto h-14 md:h-auto md:py-6 md:px-8 text-base md:text-lg font-semibold bg-white text-primary hover:bg-white/90 rounded-xl shadow-lg shadow-black/10"
                  onClick={() => setLocation("/login")}
                  data-testid="button-get-started"
                >
                  Get started, it's free
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full md:w-auto h-14 md:h-auto md:py-6 md:px-8 text-base md:text-lg font-semibold border-white/25 text-white bg-white/10 hover:bg-white/20 rounded-xl"
                  onClick={() => setLocation("/tour")}
                  data-testid="button-see-tour"
                >
                  See how it works
                </Button>
                <button
                  onClick={() => setLocation("/login")}
                  className="w-full md:hidden text-center text-white/60 text-sm py-1.5 tracking-normal"
                  data-testid="button-sign-in-mobile"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </div>

            <div className="flex flex-col items-center order-1 md:order-2 mb-2 md:mb-0">
              <div className="relative flex items-end gap-2.5 md:gap-4">
                <div className="w-[180px] h-[360px] md:w-[270px] md:h-[540px] bg-gray-900 rounded-[2rem] md:rounded-[3rem] border-[3px] border-gray-700 shadow-2xl shadow-black/40 p-1.5 md:p-2 flex flex-col" data-testid="phone-mockup-animated">
                  <div className="w-16 md:w-24 h-3.5 md:h-5 bg-gray-900 rounded-b-lg md:rounded-b-2xl mx-auto relative z-10 -mt-0.5" />
                  <div className="flex-1 bg-slate-50 dark:bg-slate-100 rounded-[1.5rem] md:rounded-[2.25rem] overflow-hidden flex flex-col">
                    <AnimatedPhoneScreen step={animStep} />
                  </div>
                </div>

                <div className="mb-6 md:mb-12">
                  <AnimatedWatchScreen step={animStep} />
                </div>
              </div>
              <StepIndicator step={animStep} />
            </div>
          </div>
        </div>

        <div className="md:hidden flex justify-center pb-4 motion-safe:animate-bounce">
          <ChevronDown className="h-5 w-5 text-white/40" />
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-background max-w-5xl md:mx-auto">
        <p className="text-center text-sm font-medium text-muted-foreground uppercase tracking-wider mb-8 md:mb-12">
          Complete safety for people who live alone
        </p>

        <div className="space-y-6 md:space-y-0 md:grid md:grid-cols-3 md:gap-8">
          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-accent/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Bell className="h-5 w-5 md:h-7 md:w-7 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">One tap checkin</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Tap the green button once a day. We'll remind you if you forget.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-primary/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Users className="h-5 w-5 md:h-7 md:w-7 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">Your people get notified</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Choose up to 2 emergency contacts. They get a text if you don't check in.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 p-4 rounded-xl bg-muted/50 md:flex-col md:items-center md:text-center md:bg-transparent md:p-6">
            <div className="w-10 h-10 md:w-14 md:h-14 rounded-full md:rounded-2xl bg-destructive/15 flex items-center justify-center flex-shrink-0 md:mb-4">
              <Shield className="h-5 w-5 md:h-7 md:w-7 text-destructive" />
            </div>
            <div>
              <h2 className="font-semibold mb-1 md:text-lg md:mb-2">You stay in control</h2>
              <p className="text-sm md:text-base text-muted-foreground leading-relaxed">
                Location sharing is off by default. Pause alerts anytime. No tracking, ever.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-gradient-to-b from-rose-50/50 to-cyan-50/50 dark:from-rose-950/10 dark:to-cyan-950/10">
        <div className="max-w-5xl md:mx-auto">
          <div className="text-center mb-10 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-100 dark:bg-red-900/30 rounded-full text-red-600 dark:text-red-400 text-xs font-medium mb-4">
              <Watch className="h-3.5 w-3.5" />
              <span>Smartwatch Companion</span>
            </div>
            <h2 className="text-xl md:text-3xl font-bold mb-3 md:mb-4">Safety that never sleeps</h2>
            <p className="text-sm md:text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Works with Apple Watch and Wear OS. Your smartwatch monitors you around the clock, even when your phone is in the other room.
            </p>
          </div>

          <div className="md:grid md:grid-cols-2 md:gap-12 md:items-center">
            <div className="flex justify-center mb-10 md:mb-0">
              <div className="relative">
                <div className="w-[140px] h-[175px] md:w-[180px] md:h-[220px] bg-gray-900 rounded-[2.5rem] md:rounded-[3.25rem] border-[3px] border-gray-700 shadow-2xl shadow-black/30 p-1.5 md:p-2 flex flex-col relative">
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-5 h-8 md:w-6 md:h-10 bg-gray-700 rounded-sm" />
                  <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-5 h-8 md:w-6 md:h-10 bg-gray-700 rounded-sm" />
                  <div className="absolute top-1/2 -right-[4px] -translate-y-1/2 w-[5px] h-8 bg-gray-600 rounded-r-sm" />
                  <div className="flex-1 bg-black rounded-[2rem] md:rounded-[2.5rem] overflow-hidden flex flex-col p-3 md:p-4">
                    <div className="flex items-center gap-1.5 mb-3 md:mb-4">
                      <Heart className="h-3 w-3 md:h-3.5 md:w-3.5 text-cyan-400" />
                      <span className="text-[8px] md:text-[10px] font-semibold text-cyan-400">StillHere</span>
                      <div className="ml-auto flex items-center gap-1">
                        <Activity className="h-2.5 w-2.5 text-green-400" />
                      </div>
                    </div>

                    <div className="flex-1 flex flex-col items-center justify-center gap-2 md:gap-3">
                      <div className="w-14 h-14 md:w-[4.5rem] md:h-[4.5rem] rounded-full bg-green-500 flex items-center justify-center shadow-lg">
                        <Check className="h-7 w-7 md:h-9 md:w-9 text-white" />
                      </div>
                      <p className="text-[10px] md:text-xs font-bold text-white">I'm OK</p>
                    </div>

                    <div className="space-y-1.5 md:space-y-2">
                      <div className="flex items-center justify-center gap-1.5 bg-gray-900 rounded-lg py-1.5 md:py-2">
                        <Heart className="h-3 w-3 md:h-3.5 md:w-3.5 text-red-500 animate-pulse" />
                        <span className="text-sm md:text-base font-bold text-red-400">72</span>
                        <span className="text-[8px] md:text-[9px] text-gray-400">BPM</span>
                      </div>
                      <div className="bg-red-500 rounded-lg py-1 md:py-1.5 text-center">
                        <span className="text-[9px] md:text-[10px] text-white font-semibold">I Need Help</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-5 md:space-y-6">
              <div className="flex items-start gap-4 p-4 rounded-xl bg-background border border-border">
                <div className="w-10 h-10 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center flex-shrink-0">
                  <Activity className="h-5 w-5 text-orange-500" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Fall Detection</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    If you fall and can't get up, your watch detects it automatically. After a 60 second countdown, it sends an SOS to your contacts.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 rounded-xl bg-background border border-border">
                <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                  <Heart className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Heart Rate Monitoring</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Your watch tracks your heart rate all day. If it goes too high or too low, you and your contacts are alerted right away.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4 p-4 rounded-xl bg-background border border-border">
                <div className="w-10 h-10 rounded-xl bg-cyan-100 dark:bg-cyan-900/30 flex items-center justify-center flex-shrink-0">
                  <Watch className="h-5 w-5 text-cyan-500" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">Wrist Checkin</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Check in directly from your smartwatch with one tap. No need to reach for your phone.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-10 md:mt-14 bg-background rounded-2xl p-5 md:p-6 border border-border max-w-2xl mx-auto">
            <div className="flex items-start gap-3 md:gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Smartphone className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 text-sm md:text-base">Don't have a smartwatch? You're still covered.</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Fall detection and heart rate monitoring require a smartwatch because it's physically on your body. Phone-only users are protected by the daily checkin system and SOS button. If you miss a checkin for any reason, your contacts are notified automatically.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-muted/30">
        <div className="max-w-5xl md:mx-auto">
          <h2 className="text-xl md:text-2xl font-bold mb-8 md:mb-12 text-center">How it works</h2>

          <div className="space-y-8 md:hidden">
            {[
              { num: "1", title: "Check in each day", desc: "Open the app and tap \"I'm OK\". Takes less than 2 seconds.", last: false, accent: false },
              { num: "2", title: "Miss a checkin?", desc: "We'll send you a reminder first. No panic, no rush.", last: false, accent: false },
              { num: "3", title: "Your contacts are notified", desc: "They receive a text message with a link to check on you. No app needed on their end.", last: false, accent: false },
              { num: "4", title: "Someone checks on you", desc: "Your family or friends can call, visit, or confirm they're on their way.", last: true, accent: true },
            ].map((step) => (
              <div key={step.num} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-9 h-9 rounded-full ${step.accent ? "bg-accent" : "bg-primary"} text-white flex items-center justify-center font-bold text-sm flex-shrink-0`}>
                    {step.num}
                  </div>
                  {!step.last && <div className="w-0.5 flex-1 bg-primary/20 mt-2" />}
                </div>
                <div className={step.last ? "" : "pb-2"}>
                  <h3 className="font-semibold mb-1">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:grid md:grid-cols-4 gap-8">
            {[
              { num: "1", title: "Check in each day", desc: "Open the app and tap \"I'm OK\". Takes 2 seconds.", accent: false },
              { num: "2", title: "Miss a checkin?", desc: "We send you a friendly reminder first. No panic.", accent: false },
              { num: "3", title: "Contacts notified", desc: "They get a text with a link to check on you.", accent: false },
              { num: "4", title: "Someone checks on you", desc: "They can call, visit, or confirm they're handling it.", accent: true },
            ].map((step) => (
              <div key={step.num} className="text-center">
                <div className={`w-12 h-12 rounded-full ${step.accent ? "bg-accent" : "bg-primary"} text-white flex items-center justify-center font-bold text-lg mx-auto mb-4`}>
                  {step.num}
                </div>
                <h3 className="font-semibold mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-background">
        <div className="max-w-5xl md:mx-auto">
          <div className="text-center mb-10 md:mb-14">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-100 dark:bg-emerald-900/30 rounded-full text-emerald-600 dark:text-emerald-400 text-xs font-medium mb-4">
              <WifiOff className="h-3.5 w-3.5" />
              <span>Always Protected</span>
            </div>
            <h2 className="text-xl md:text-3xl font-bold mb-3 md:mb-4">Works even when you're offline</h2>
            <p className="text-sm md:text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Your safety doesn't depend on your phone being online. Our server watches the clock for you.
            </p>
          </div>

          <div className="md:grid md:grid-cols-3 md:gap-6 space-y-4 md:space-y-0">
            <div className="p-5 rounded-xl bg-muted/50 border border-border text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                <Server className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-1.5 text-sm md:text-base">Server-side monitoring</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The server knows your checkin schedule. If 9 AM comes and it doesn't hear from you, it takes action.
              </p>
            </div>

            <div className="p-5 rounded-xl bg-muted/50 border border-border text-center">
              <div className="w-12 h-12 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-3">
                <WifiOff className="h-6 w-6 text-amber-500" />
              </div>
              <h3 className="font-semibold mb-1.5 text-sm md:text-base">Phone off? No problem.</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                If your phone dies, you lose signal, or you simply can't check in, that triggers the safety net automatically.
              </p>
            </div>

            <div className="p-5 rounded-xl bg-muted/50 border border-border text-center">
              <div className="w-12 h-12 rounded-2xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-3">
                <MessageCircle className="h-6 w-6 text-green-500" />
              </div>
              <h3 className="font-semibold mb-1.5 text-sm md:text-base">SMS alerts, not apps</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Your emergency contacts are notified by text message. They don't need the app, a smartphone, or even the internet.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-muted/30">
        <div className="max-w-5xl md:mx-auto md:grid md:grid-cols-2 md:gap-12 md:items-center">
          <div className="md:block">
            <h2 className="text-xl md:text-2xl font-bold mb-3 text-center md:text-left">What your contacts see</h2>
            <p className="text-sm text-muted-foreground text-center md:text-left mb-8 md:mb-6">They don't need the app. Just a text message.</p>

            <div className="hidden md:block space-y-3 mb-0">
              {[
                "Your name and current status",
                "When you last checked in",
                "Your location on a map (if enabled)",
                "Clear steps on what to do next",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-5 h-5 rounded-full bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Check className="h-3 w-3 text-accent" />
                  </div>
                  <span className="text-sm">{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-muted/50 rounded-2xl p-5 md:p-6 space-y-4 border border-border">
            <div className="flex items-center gap-3 pb-3 border-b border-border">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
                <MessageCircle className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">StillHere Alert</p>
                <p className="text-xs text-muted-foreground">Text message received</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4 flex-shrink-0" />
                <span>Last checkin: 9:15 AM yesterday</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="h-4 w-4 flex-shrink-0" />
                <span>Location shared (if enabled)</span>
              </div>
            </div>
            <div className="bg-background rounded-lg p-3 md:p-4">
              <p className="text-xs md:text-sm font-medium mb-2">What to do:</p>
              <div className="space-y-1 md:space-y-1.5 text-xs md:text-sm text-muted-foreground">
                <p>1. Try calling them</p>
                <p>2. Send a text message</p>
                <p>3. Visit or call emergency services</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-14 md:py-20 bg-muted/30">
        <div className="max-w-3xl md:mx-auto text-center">
          <div className="inline-flex items-center gap-1 md:gap-1.5 px-3 md:px-4 py-1.5 md:py-2 bg-primary/10 rounded-full text-primary text-xs md:text-sm font-medium mb-4 md:mb-6">
            <Shield className="h-3.5 md:h-4 w-3.5 md:w-4" />
            <span>Private & Secure</span>
          </div>
          <h2 className="text-xl md:text-2xl font-bold mb-3 md:mb-4">Built for trust</h2>
          <p className="text-sm md:text-base text-muted-foreground leading-relaxed mb-8 md:mb-10 max-w-xl mx-auto">
            We don't track you. We don't sell your data. Location sharing is always your choice.
          </p>

          <div className="bg-background rounded-2xl p-5 md:p-8 border border-border max-w-lg mx-auto">
            <p className="text-base md:text-lg leading-relaxed mb-3 font-medium">
              "I live alone and this gives me real peace of mind knowing someone will check on me."
            </p>
            <p className="text-sm text-muted-foreground">Solo dweller</p>
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-gradient-to-b md:bg-gradient-to-br from-primary to-primary/80 text-white text-center">
        <div className="max-w-3xl md:mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold mb-3 md:mb-4">Ready to get started?</h2>
          <p className="text-white/80 md:text-xl mb-8">
            Set up in under 2 minutes. Free forever.
          </p>
          <Button
            size="lg"
            className="w-full md:w-auto md:px-10 py-6 text-lg font-semibold bg-white text-primary hover:bg-white/90"
            onClick={() => setLocation("/login")}
            data-testid="button-get-started-bottom"
          >
            Create your account
          </Button>
        </div>
      </section>

      <footer className="px-6 py-6 md:py-8 bg-background border-t border-border">
        <div className="max-w-5xl md:mx-auto">
          <div className="flex items-center justify-between text-sm text-muted-foreground md:flex-row">
            <div className="flex items-center gap-1.5 md:gap-2">
              <Heart className="h-4 w-4 text-primary" />
              <span className="hidden md:inline">StillHere, a safety checkin app</span>
              <span className="md:hidden">StillHere</span>
            </div>
            <div className="flex gap-4 md:gap-6">
              <button onClick={() => setLocation("/help")} className="hover:text-foreground" data-testid="link-footer-help">
                Help
              </button>
              <button onClick={() => setLocation("/trust")} className="hover:text-foreground" data-testid="link-footer-trust">
                Trust & Safety
              </button>
            </div>
          </div>
          <div className="hidden md:block mt-4 px-4 py-3 bg-muted/50 rounded-md text-xs text-muted-foreground text-center">
            <Shield className="h-3.5 w-3.5 inline mr-1" />
            The only messages you'll receive from StillHere are checkin reminders and alerts you've set up yourself.
          </div>
        </div>
      </footer>
    </div>
  );
}
